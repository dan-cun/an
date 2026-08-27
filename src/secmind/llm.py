from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, TypeVar
from uuid import uuid4

import httpx
from pydantic import BaseModel, ValidationError
from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from secmind.config import Settings

T = TypeVar("T", bound=BaseModel)


class ModelGatewayError(RuntimeError):
    pass


class RetryableModelError(ModelGatewayError):
    pass


@dataclass
class ModelCallMeta:
    model_id: str
    prompt_version: str
    response_sha256: str
    duration_ms: int
    used_fallback: bool
    usage: dict[str, int]


StreamObserver = Callable[[str, dict[str, Any]], Awaitable[None]]


class QwenGateway:
    """OpenAI-compatible Qwen gateway with retry, circuit breaking, and fallback."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._client = client or httpx.AsyncClient(timeout=settings.model_timeout_seconds)
        self._owns_client = client is None
        self._failures: dict[str, int] = {}
        self._open_until: dict[str, float] = {}

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def test_connection(self, base_url: str, api_key: str) -> dict[str, Any]:
        started = time.monotonic()
        try:
            response = await self._client.get(
                f"{base_url.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        except httpx.HTTPError as exc:
            raise ModelGatewayError(f"Unable to reach model service: {type(exc).__name__}") from exc
        if response.status_code in {401, 403}:
            raise ModelGatewayError("API key was rejected by the model service")
        if response.status_code >= 400:
            raise ModelGatewayError(f"Model service returned HTTP {response.status_code}")
        try:
            body = response.json()
            rows = body.get("data", []) if isinstance(body, dict) else []
            model_ids = sorted(
                str(item["id"])
                for item in rows
                if isinstance(item, dict) and item.get("id")
            )
            model_count = len(rows)
        except (ValueError, TypeError):
            model_count = 0
            model_ids = []
        return {
            "latency_ms": int((time.monotonic() - started) * 1000),
            "model_count": model_count,
            "model_ids": model_ids,
        }

    async def structured(
        self,
        *,
        role: str,
        system_prompt: str,
        user_prompt: str,
        output_model: type[T],
        prompt_version: str,
        stage: str | None = None,
        stream_observer: StreamObserver | None = None,
        timeout_seconds: float | None = None,
    ) -> tuple[T, ModelCallMeta]:
        if self.settings.demo_mode:
            raise ModelGatewayError("Model calls are disabled in deterministic demo mode")
        if not self.settings.qwen_api_key:
            raise ModelGatewayError("SECMIND_QWEN_API_KEY is not configured")
        primary = self.settings.planner_model if role == "planner" else self.settings.worker_model
        candidates = list(dict.fromkeys([primary, self.settings.fallback_model]))
        last_error: Exception | None = None
        for index, model_id in enumerate(candidates):
            if self._open_until.get(model_id, 0) > time.monotonic():
                continue
            try:
                trace_id = str(uuid4())
                raw, duration_ms, usage = await self._request_with_retry(
                    model_id,
                    system_prompt,
                    user_prompt,
                    output_model.model_json_schema(),
                    trace_id=trace_id,
                    stage=stage or role,
                    stream_observer=stream_observer,
                    timeout_seconds=timeout_seconds,
                )
                parsed = self._parse_model(raw, output_model)
                self._failures[model_id] = 0
                return parsed, ModelCallMeta(
                    model_id=model_id,
                    prompt_version=prompt_version,
                    response_sha256=hashlib.sha256(raw.encode()).hexdigest(),
                    duration_ms=duration_ms,
                    used_fallback=index > 0,
                    usage=usage,
                )
            except (ModelGatewayError, ValidationError, json.JSONDecodeError) as exc:
                if stream_observer is not None:
                    await stream_observer(
                        "llm.stream.failed",
                        {
                            "trace_id": trace_id,
                            "message_id": f"{trace_id}:assistant",
                            "stage": stage or role,
                            "provider": "qwen",
                            "model": model_id,
                            "message": f"Model attempt failed: {type(exc).__name__}",
                            "error_type": type(exc).__name__,
                        },
                    )
                last_error = exc
                failures = self._failures.get(model_id, 0) + 1
                self._failures[model_id] = failures
                if failures >= 3:
                    self._open_until[model_id] = time.monotonic() + 60
        raise ModelGatewayError(f"All configured models failed: {last_error}")

    async def embeddings(self, texts: list[str]) -> list[list[float]]:
        """Create embeddings for the Qdrant boundary without exposing provider details upstream."""
        if not texts or any(not text.strip() for text in texts):
            raise ValueError("Embedding input must contain non-empty text")
        if self.settings.demo_mode:
            raise ModelGatewayError("Embedding calls are disabled in deterministic demo mode")
        if not self.settings.qwen_api_key:
            raise ModelGatewayError("SECMIND_QWEN_API_KEY is not configured")
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential_jitter(initial=0.5, max=8),
            retry=retry_if_exception_type((RetryableModelError, httpx.TimeoutException)),
            reraise=True,
        ):
            with attempt:
                response = await self._client.post(
                    f"{self.settings.qwen_base_url.rstrip('/')}/embeddings",
                    headers={"Authorization": f"Bearer {self.settings.qwen_api_key}"},
                    json={"model": self.settings.embedding_model, "input": texts},
                )
                if response.status_code in {408, 409, 429} or response.status_code >= 500:
                    raise RetryableModelError(f"Retryable embedding response: {response.status_code}")
                if response.status_code >= 400:
                    raise ModelGatewayError(f"Embedding response: {response.status_code}")
                try:
                    rows = sorted(response.json()["data"], key=lambda item: item["index"])
                    vectors = [[float(value) for value in row["embedding"]] for row in rows]
                except (KeyError, TypeError, ValueError) as exc:
                    raise ModelGatewayError("Malformed embedding response") from exc
                if len(vectors) != len(texts):
                    raise ModelGatewayError("Embedding response count does not match input count")
                return vectors
        raise AssertionError("Retry loop exited unexpectedly")

    async def _request_with_retry(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        schema: dict[str, Any],
        *,
        trace_id: str,
        stage: str,
        stream_observer: StreamObserver | None,
        timeout_seconds: float | None,
    ) -> tuple[str, int, dict[str, int]]:
        started = time.monotonic()
        request_timeout = timeout_seconds or self.settings.model_timeout_seconds
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential_jitter(initial=0.5, max=8),
            retry=retry_if_exception_type((RetryableModelError, httpx.TimeoutException)),
            reraise=True,
        ):
            with attempt:
                schema_text = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
                request_payload = {
                        "model": model_id,
                        "messages": [
                            {
                                "role": "system",
                                "content": f"{system_prompt}\nRequired JSON Schema: {schema_text}",
                            },
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": 0,
                        "response_format": {"type": "json_object"},
                    }
                if stream_observer is None:
                    response = await self._client.post(
                        f"{self.settings.qwen_base_url.rstrip('/')}/chat/completions",
                        headers={"Authorization": f"Bearer {self.settings.qwen_api_key}"},
                        json=request_payload,
                        timeout=request_timeout,
                    )
                    if response.status_code in {408, 409, 429} or response.status_code >= 500:
                        raise RetryableModelError(f"Retryable model response: {response.status_code}")
                    if response.status_code >= 400:
                        raise ModelGatewayError(f"Model response: {response.status_code}")
                    body = response.json()
                    try:
                        content = body["choices"][0]["message"]["content"]
                    except (KeyError, IndexError, TypeError) as exc:
                        raise ModelGatewayError("Malformed model response") from exc
                    return (
                        str(content),
                        int((time.monotonic() - started) * 1000),
                        self._normalize_usage(body.get("usage")),
                    )

                await stream_observer(
                    "llm.stream.started",
                    {
                        "trace_id": trace_id,
                        "message_id": f"{trace_id}:assistant",
                        "stage": stage,
                        "provider": "qwen",
                        "model": model_id,
                    },
                )
                request_payload["stream"] = True
                request_payload["stream_options"] = {"include_usage": True}
                chunks: list[str] = []
                usage: dict[str, int] = {}
                finish_reason: str | None = None
                index = 0
                async with self._client.stream(
                    "POST",
                    f"{self.settings.qwen_base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {self.settings.qwen_api_key}"},
                    json=request_payload,
                    timeout=request_timeout,
                ) as response:
                    if response.status_code in {408, 409, 429} or response.status_code >= 500:
                        raise RetryableModelError(f"Retryable model response: {response.status_code}")
                    if response.status_code >= 400:
                        raise ModelGatewayError(f"Model response: {response.status_code}")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if not data or data == "[DONE]":
                            continue
                        body = json.loads(data)
                        normalized = self._normalize_usage(body.get("usage"))
                        if normalized:
                            usage = normalized
                        choices = body.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta", {}).get("content")
                        if not isinstance(delta, str) or not delta:
                            continue
                        chunks.append(delta)
                        index += 1
                        await stream_observer(
                            "llm.stream.delta",
                            {
                                "trace_id": trace_id,
                                "message_id": f"{trace_id}:assistant",
                                "index": index,
                                "delta": delta,
                                "content_length": sum(len(item) for item in chunks),
                                "stage": stage,
                                "provider": "qwen",
                                "model": model_id,
                            },
                        )
                content = "".join(chunks)
                await stream_observer(
                    "llm.stream.completed",
                    {
                        "trace_id": trace_id,
                        "message_id": f"{trace_id}:assistant",
                        "stage": stage,
                        "provider": "qwen",
                        "model": model_id,
                        "delta_count": index,
                        "content_length": len(content),
                        "finish_reason": finish_reason,
                        "usage": usage,
                        "content": content,
                    },
                )
                return content, int((time.monotonic() - started) * 1000), usage
        raise AssertionError("Retry loop exited unexpectedly")

    @staticmethod
    def _normalize_usage(value: Any) -> dict[str, int]:
        if not isinstance(value, dict):
            return {}
        prompt_details = value.get("prompt_tokens_details")
        cached = prompt_details.get("cached_tokens", 0) if isinstance(prompt_details, dict) else 0
        return {
            "prompt_tokens": int(value.get("prompt_tokens") or 0),
            "completion_tokens": int(value.get("completion_tokens") or 0),
            "total_tokens": int(value.get("total_tokens") or 0),
            "cache_read_tokens": int(value.get("cache_read_tokens") or cached or 0),
        }

    @staticmethod
    def _parse_model(raw: str, output_model: type[T]) -> T:
        text = raw.strip()
        if text.startswith("```"):
            text = text.removeprefix("```json").removeprefix("```")
            text = text.rsplit("```", 1)[0]
        return output_model.model_validate_json(text)


async def close_gateway_safely(gateway: QwenGateway) -> None:
    try:
        await gateway.close()
    except (httpx.HTTPError, asyncio.CancelledError):
        pass
