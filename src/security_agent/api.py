from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from security_agent.config import Settings, get_settings
from security_agent.evaluation import EvaluationError, EvaluationService
from security_agent.experience import ExperienceStore
from security_agent.fusion import classify_task
from security_agent.guardrail import Guardrail
from security_agent.incident_response import IncidentManager
from security_agent.ledger import LedgerStore
from security_agent.llm import ModelGateway, ModelGatewayError, close_gateway_safely
from security_agent.mcp_catalog import MCPCatalog
from security_agent.orchestrator import SecurityOrchestrator
from security_agent.penetration_integration import (
    PenetrationProtocolError,
    PenetrationUnavailableError,
    normalize_penetration_graph,
    penetration_get,
    resolve_project_id,
)
from security_agent.prompt_catalog import PromptCatalog
from security_agent.question_bank import QuestionBankError, QuestionBankService
from security_agent.schemas import (
    AgentReport,
    ApprovalResponse,
    EvaluationCreateRequest,
    ExperienceCreateRequest,
    Finding,
    MCPServerUpsertRequest,
    MCPToolUpsertRequest,
    ModelConfigUpdate,
    ModelConnectionTest,
    ModelUsageQuotaUpdate,
    QuestionBankConfirmRequest,
    QuestionBankInspectRequest,
    RunStatus,
    TaskRequest,
)
from security_agent.service import EventHub, RunService
from security_agent.tools import ToolBroker, default_registry

REPORT_TIMEZONE = ZoneInfo("Asia/Shanghai")


def _shift_month(value: datetime, offset: int) -> datetime:
    index = value.year * 12 + value.month - 1 + offset
    return value.replace(year=index // 12, month=index % 12 + 1, day=1)


def _usage_numbers(value: Any) -> tuple[int, int, int, int]:
    """Normalize token fields emitted by OpenAI/DeepSeek-compatible APIs."""
    usage = value if isinstance(value, dict) else {}
    details = usage.get("prompt_tokens_details")
    cached = details.get("cached_tokens", 0) if isinstance(details, dict) else 0
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    cache_hit = int(usage.get("prompt_cache_hit_tokens") or usage.get("cache_read_tokens") or cached or 0)
    cache_miss = int(usage.get("prompt_cache_miss_tokens") or 0)
    prompt = max(prompt, cache_hit + cache_miss)
    total = int(usage.get("total_tokens") or 0) or prompt + completion
    return prompt, completion, total, cache_hit


def _event_local_time(event: Any) -> datetime:
    timestamp = event.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return timestamp.astimezone(REPORT_TIMEZONE)


def _usage_series(ledger: LedgerStore) -> dict[str, list[dict[str, Any]]]:
    """Build hourly/daily/monthly series from durable model stream events."""
    now = datetime.now(REPORT_TIMEZONE)
    current_hour = now.replace(minute=0, second=0, microsecond=0)
    current_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    current_month = current_day.replace(day=1)
    keys = {
        "hourly": [(current_hour - timedelta(hours=i)).strftime("%Y-%m-%dT%H:00:00+08:00") for i in range(23, -1, -1)],
        "daily": [(current_day - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(29, -1, -1)],
        "monthly": [_shift_month(current_month, i).strftime("%Y-%m") for i in range(-11, 1)],
    }
    buckets = {
        period: {key: {"bucket": key, "tokens": 0, "calls": 0} for key in values}
        for period, values in keys.items()
    }
    since = _shift_month(current_month, -11).astimezone(UTC)
    completed = ledger.events_by_type("llm.stream.completed", since=since)
    failed = ledger.events_by_type("llm.stream.failed", since=since)
    started = ledger.events_by_type("llm.stream.started", since=since)
    started_keys = {
        (event.run_id, event.payload.get("trace_id"))
        for event in started
        if isinstance(event.payload, dict) and event.payload.get("trace_id")
    }
    for event in started:
        local = _event_local_time(event)
        bucket_keys = {
            "hourly": local.strftime("%Y-%m-%dT%H:00:00+08:00"),
            "daily": local.strftime("%Y-%m-%d"),
            "monthly": local.strftime("%Y-%m"),
        }
        for period, key in bucket_keys.items():
            if key in buckets[period]:
                buckets[period][key]["calls"] += 1
    for event in [*completed, *failed]:
        local = _event_local_time(event)
        bucket_keys = {
            "hourly": local.strftime("%Y-%m-%dT%H:00:00+08:00"),
            "daily": local.strftime("%Y-%m-%d"),
            "monthly": local.strftime("%Y-%m"),
        }
        _, _, tokens, _ = _usage_numbers(event.payload.get("usage") if isinstance(event.payload, dict) else None)
        for period, key in bucket_keys.items():
            if key not in buckets[period]:
                continue
            buckets[period][key]["tokens"] += tokens
            trace_id = event.payload.get("trace_id") if isinstance(event.payload, dict) else None
            if (event.run_id, trace_id) not in started_keys:
                buckets[period][key]["calls"] += 1
    return {period: list(values.values()) for period, values in buckets.items()}


def _usage_totals(ledger: LedgerStore, states: list[Any]) -> dict[str, Any]:
    completed = ledger.events_by_type("llm.stream.completed")
    failed = ledger.events_by_type("llm.stream.failed")
    started = ledger.events_by_type("llm.stream.started")
    usage_events = [*completed, *failed]
    event_run_ids = {event.run_id for event in usage_events}
    totals: dict[str, Any] = {
        "model_call_count": max(len(started), len(usage_events)),
        "completed_call_count": len(completed),
        "incomplete_call_count": max(0, len(started) - len(usage_events)),
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "token_usage_available": False,
        "usage_estimated": False,
    }
    for event in usage_events:
        usage = event.payload.get("usage") if isinstance(event.payload, dict) else None
        prompt, completion, total, cache_hit = _usage_numbers(usage)
        totals["prompt_tokens"] += prompt
        totals["completion_tokens"] += completion
        totals["total_tokens"] += total
        totals["cache_read_tokens"] += cache_hit
        totals["token_usage_available"] = totals["token_usage_available"] or bool(usage)
    for state in states:
        if state.run_id in event_run_ids:
            continue
        if not any(event.run_id == state.run_id for event in started):
            totals["model_call_count"] += state.budget.model_calls_used
            totals["completed_call_count"] += state.budget.model_calls_used
        totals["prompt_tokens"] += state.budget.prompt_tokens_used
        totals["completion_tokens"] += state.budget.completion_tokens_used
        totals["total_tokens"] += state.budget.prompt_tokens_used + state.budget.completion_tokens_used
        totals["cache_read_tokens"] += state.budget.cache_read_tokens_used
        totals["token_usage_available"] = totals["token_usage_available"] or state.budget.model_usage_recorded
    return totals


def build_runtime(settings: Settings) -> tuple[RunService, EvaluationService, ModelGateway, ExperienceStore]:
    settings.prepare_directories()
    ledger = LedgerStore(settings.database_url)
    hub = EventHub()
    gateway = ModelGateway(settings)
    experiences = ExperienceStore(ledger.engine)
    experiences.backfill(ledger)
    broker = ToolBroker(default_registry(), Guardrail())
    orchestrator = SecurityOrchestrator(settings, ledger, gateway, broker, hub.publish, experiences)
    service = RunService(orchestrator, ledger, hub)
    return service, EvaluationService(settings, service), gateway, experiences


def create_app(settings: Settings | None = None) -> FastAPI:
    actual_settings = settings or get_settings()
    service, evaluation_service, gateway, experiences = build_runtime(actual_settings)
    question_banks = QuestionBankService(actual_settings, gateway)
    incident_manager = IncidentManager()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await service.recover_incomplete()
        await evaluation_service.recover_incomplete()
        await question_banks.recover_incomplete()
        await incident_manager.start()
        yield
        await incident_manager.shutdown()
        await question_banks.shutdown()
        await evaluation_service.shutdown()
        await service.shutdown()
        await close_gateway_safely(gateway)

    app = FastAPI(
        title="安全任务 API",
        version="0.1.0",
        description="Auditable and recoverable security-task runtime.",
        lifespan=lifespan,
    )
    app.state.service = service
    app.state.evaluation_service = evaluation_service
    app.state.question_banks = question_banks
    app.state.experiences = experiences
    app.state.settings = actual_settings
    app.state.incident_manager = incident_manager
    # Catalogs are intentionally read-only and are not passed to the
    # orchestrator or ToolBroker.  This keeps the current agent/tool graph
    # unchanged while exposing the migrated assets for inspection.
    app.state.prompt_catalog = PromptCatalog()
    app.state.mcp_catalog = MCPCatalog(generated_root=actual_settings.mcp_generated_root)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "schema_version": "1.0",
            "demo_mode": actual_settings.demo_mode,
        }

    @app.get("/api/v1/model-config")
    async def model_config() -> dict[str, Any]:
        return {
            "schema_version": "1.0",
            "provider": "compatible-api",
            "base_url": actual_settings.model_base_url,
            "planner_model": actual_settings.planner_model,
            "worker_model": actual_settings.worker_model,
            "fallback_model": actual_settings.fallback_model,
            "embedding_model": actual_settings.embedding_model,
            "api_key_configured": bool(actual_settings.model_api_key),
            "demo_mode": actual_settings.demo_mode,
            "timeout_seconds": actual_settings.model_timeout_seconds,
        }

    @app.post("/api/v1/model-config/test")
    async def test_model_config(payload: ModelConnectionTest) -> dict[str, Any]:
        try:
            base_url = actual_settings.validate_model_base_url(payload.base_url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        api_key = payload.api_key or actual_settings.model_api_key
        if not api_key:
            raise HTTPException(422, "API Key is required for connection testing")
        try:
            result = await gateway.test_connection(base_url, api_key)
        except ModelGatewayError as exc:
            raise HTTPException(400, str(exc)) from exc
        requested_models = {
            value.strip()
            for value in (payload.planner_model, payload.worker_model, payload.fallback_model)
            if value and value.strip()
        }
        visible_models = set(result.pop("model_ids", []))
        missing_models = sorted(requested_models - visible_models) if visible_models else []
        if missing_models:
            raise HTTPException(
                400,
                f"Configured model IDs are not available: {', '.join(missing_models)}",
            )
        return {"schema_version": "1.0", "ok": True, **result}

    @app.post("/api/v1/model-config/models")
    async def list_model_config_models(payload: ModelConnectionTest) -> dict[str, Any]:
        """Discover provider model IDs without exposing the API key to the browser."""
        try:
            base_url = actual_settings.validate_model_base_url(payload.base_url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        api_key = payload.api_key or actual_settings.model_api_key
        if not api_key:
            raise HTTPException(422, "API Key is required to fetch model list")
        try:
            result = await gateway.test_connection(base_url, api_key)
        except ModelGatewayError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {
            "schema_version": "1.0",
            "models": result.get("model_ids", []),
            "model_count": result.get("model_count", 0),
            "latency_ms": result.get("latency_ms", 0),
        }

    @app.put("/api/v1/model-config")
    async def update_model_config(payload: ModelConfigUpdate) -> dict[str, Any]:
        try:
            actual_settings.model_base_url = actual_settings.validate_model_base_url(payload.base_url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if payload.clear_api_key:
            actual_settings.model_api_key = ""
        elif payload.api_key is not None:
            actual_settings.model_api_key = payload.api_key
        for field_name in ("planner_model", "worker_model", "fallback_model"):
            value = getattr(payload, field_name)
            if value is not None:
                normalized = value.strip()
                if not normalized:
                    raise HTTPException(422, f"{field_name} must not be empty")
                setattr(actual_settings, field_name, normalized)
        actual_settings.demo_mode = not bool(actual_settings.model_api_key)
        actual_settings.save_runtime_model_config()
        return {
            "schema_version": "1.0",
            "updated": True,
            "base_url": actual_settings.model_base_url,
            "planner_model": actual_settings.planner_model,
            "worker_model": actual_settings.worker_model,
            "fallback_model": actual_settings.fallback_model,
            "api_key_configured": bool(actual_settings.model_api_key),
            "demo_mode": actual_settings.demo_mode,
        }

    @app.get("/api/v1/model-usage")
    async def model_usage() -> dict[str, Any]:
        states = service.ledger.list_states(limit=500)
        by_model: dict[str, dict[str, Any]] = {}
        for state in states:
            for decision in state.decisions:
                if not decision.model_id:
                    continue
                item = by_model.setdefault(
                    decision.model_id,
                    {
                        "model": decision.model_id,
                        "decision_count": 0,
                        "run_ids": set(),
                    },
                )
                item["decision_count"] += 1
                item["run_ids"].add(state.run_id)
        models = [
            {
                "model": item["model"],
                "decision_count": item["decision_count"],
                "run_count": len(item["run_ids"]),
            }
            for item in by_model.values()
        ]
        models.sort(key=lambda item: (-item["decision_count"], item["model"]))
        return {
            "schema_version": "1.0",
            "run_count": len(states),
            **_usage_totals(service.ledger, states),
            "usage_scope": "local_ledger",
            "provider_account_usage_synced": False,
            "quota": {
                "hourly": actual_settings.model_hourly_token_quota,
                "daily": actual_settings.model_daily_token_quota,
                "monthly": actual_settings.model_monthly_token_quota,
            },
            "series": _usage_series(service.ledger),
            "models": models,
            "note": (
                "Usage values are updated from model stream completion events."
                if any(state.budget.model_usage_recorded for state in states)
                else "No provider usage has been recorded yet."
            ),
        }

    @app.put("/api/v1/model-usage/quota")
    async def update_model_usage_quota(payload: ModelUsageQuotaUpdate) -> dict[str, Any]:
        actual_settings.model_hourly_token_quota = payload.hourly_tokens
        actual_settings.model_daily_token_quota = payload.daily_tokens
        actual_settings.model_monthly_token_quota = payload.monthly_tokens
        actual_settings.save_runtime_model_config()
        return {
            "schema_version": "1.0",
            "updated": True,
            "quota": {
                "hourly": actual_settings.model_hourly_token_quota,
                "daily": actual_settings.model_daily_token_quota,
                "monthly": actual_settings.model_monthly_token_quota,
            },
        }

    @app.websocket("/api/v1/model-usage/events")
    async def model_usage_events(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            async with service.event_hub.subscribe_all() as queue:
                while True:
                    event = await queue.get()
                    await websocket.send_json(
                        {
                            "type": "usage.changed",
                            "run_id": event.get("run_id"),
                            "sequence": event.get("sequence"),
                            "event_type": event.get("event_type"),
                        }
                    )
        except WebSocketDisconnect:
            return

    @app.post("/api/v1/uploads", status_code=201)
    async def upload(file: Annotated[UploadFile, File(...)]) -> dict[str, Any]:
        safe_name = Path(file.filename or "upload.bin").name
        if not safe_name or safe_name in {".", ".."}:
            raise HTTPException(400, "Invalid filename")
        reference = f"{uuid4()}-{safe_name}"
        destination = actual_settings.upload_root / reference
        total = 0
        try:
            with destination.open("wb") as stream:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > actual_settings.max_upload_bytes:
                        raise HTTPException(413, "Upload exceeds configured size limit")
                    stream.write(chunk)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return {"schema_version": "1.0", "ref": reference, "name": safe_name, "size_bytes": total}

    @app.post("/api/v1/tasks", status_code=202)
    async def create_task(task: TaskRequest) -> dict[str, Any]:
        dispatch_plan = None
        formatted_metadata = None
        if task.question_bank_id:
            try:
                question_banks.require_confirmed(task.question_bank_id, task.attachments)
                inspection = question_banks.get(task.question_bank_id)
                dispatch_plan = inspection.get("dispatch_plan") or []
                formatted_metadata = inspection.get("formatted_metadata")
            except KeyError as exc:
                raise HTTPException(404, "Question bank inspection not found") from exc
            except QuestionBankError as exc:
                raise HTTPException(409, str(exc)) from exc
        run_id = service.submit(task)
        response = {"schema_version": "1.0", "run_id": run_id, "status": RunStatus.PENDING}
        if dispatch_plan is not None:
            response["dispatch_plan"] = dispatch_plan
        if formatted_metadata is not None:
            response["formatted_metadata"] = formatted_metadata
        return response

    @app.post("/api/v1/tasks/classify")
    async def classify_task_route(task: TaskRequest) -> dict[str, Any]:
        result = classify_task(task.objective, task.attachments, task.target_scope)
        result["scenario"] = result["scenario"].value
        return {"schema_version": "1.0", **result}

    async def _module_health(base_url: str, path: str) -> tuple[bool, str | None]:
        """Probe an external module so the UI does not report a dead adapter as ready."""
        try:
            async with httpx.AsyncClient(timeout=1.5, follow_redirects=False) as client:
                response = await client.get(f"{base_url.rstrip('/')}{path}")
            if response.status_code < 400:
                return True, None
            return False, f"HTTP_{response.status_code}"
        except httpx.HTTPError as exc:
            return False, type(exc).__name__

    @app.get("/api/v1/modules")
    async def list_modules() -> dict[str, Any]:
        reverse_ok, reverse_error = await _module_health(actual_settings.reverse_base_url, "/health/live")
        # The penetration adapter exposes its project collection as the stable
        # readiness probe (the service intentionally has no /health/live route).
        penetration_ok, penetration_error = await _module_health(actual_settings.penetration_base_url, "/projects")
        return {"schema_version": "1.0", "modules": [
            {"id": "code_audit", "name": "代码审计", "adapter": "workspace_security_audit", "available": True},
            {
                "id": "reverse", "name": "逆向分析", "adapter": "reverse_module",
                "available": reverse_ok, "base_url": actual_settings.reverse_base_url,
                **({"error": reverse_error} if reverse_error else {}),
            },
            {
                "id": "penetration", "name": "渗透测试", "adapter": "penetration_module",
                "available": penetration_ok, "base_url": actual_settings.penetration_base_url,
                **({"error": penetration_error} if penetration_error else {}),
            },
            {"id": "incident_response", "name": "应急响应", "adapter": "local_incident_runtime", "available": True},
        ]}

    @app.get("/api/v1/incident/status")
    async def incident_status() -> dict[str, Any]:
        return incident_manager.snapshot()

    @app.get("/api/v1/incident/commands")
    async def incident_commands() -> dict[str, Any]:
        return {"schema_version": "1.0", "groups": incident_manager.command_catalog()}

    @app.post("/api/v1/incident/monitor/start")
    async def incident_monitor_start() -> dict[str, Any]:
        return await incident_manager.start()

    @app.post("/api/v1/incident/monitor/stop")
    async def incident_monitor_stop() -> dict[str, Any]:
        return await incident_manager.stop()

    @app.get("/api/v1/incident/logs")
    async def incident_logs(limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
        return {"schema_version": "1.0", "logs": incident_manager.logs(limit)}

    @app.get("/api/v1/incident/actions")
    async def incident_actions(limit: Annotated[int, Query(ge=1, le=200)] = 100) -> dict[str, Any]:
        return {"schema_version": "1.0", "actions": incident_manager.actions(limit)}

    @app.get("/api/v1/incident/approvals")
    async def incident_approvals(limit: Annotated[int, Query(ge=1, le=200)] = 100) -> dict[str, Any]:
        return {"schema_version": "1.0", "approvals": incident_manager.approvals(limit)}

    @app.post("/api/v1/incident/command")
    async def incident_command(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return await incident_manager.submit_command(
                str(payload.get("command", "")),
                str(payload.get("target", "测试环境")),
                str(payload.get("reason", "")),
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/v1/incident/approvals/{approval_id}")
    async def incident_resolve_approval(approval_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return await incident_manager.resolve_approval(
                approval_id,
                str(payload.get("decision", "")),
                str(payload.get("note", "")),
            )
        except KeyError as exc:
            raise HTTPException(404, "Approval request not found") from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.websocket("/api/v1/incident/events")
    async def incident_events(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_json({"type": "incident.snapshot", "payload": incident_manager.snapshot()})
        try:
            async with incident_manager.subscribe() as queue:
                for event in incident_manager.logs(100)[::-1]:
                    await websocket.send_json({"type": "incident.event", "payload": event})
                while True:
                    await websocket.send_json(await queue.get())
        except WebSocketDisconnect:
            return

    @app.get("/api/v1/experiences")
    async def list_experiences(
        module_route: Annotated[str | None, Query(max_length=80)] = None,
        source_type: Annotated[str | None, Query(pattern="^(run|manual)$")] = None,
        limit: Annotated[int, Query(ge=1, le=500)] = 200,
    ) -> dict[str, Any]:
        records = experiences.list(module_route=module_route, source_type=source_type, limit=limit)
        return {
            "schema_version": "1.0",
            "statistics": {
                "total": len(records),
                "verified": sum(1 for item in records if item["verified"]),
                "run_sourced": sum(1 for item in records if item["source_type"] == "run"),
                "manual": sum(1 for item in records if item["source_type"] == "manual"),
                "success_patterns": sum(1 for item in records if item["experience_kind"] == "success_pattern"),
                "failure_lessons": sum(1 for item in records if item["experience_kind"] == "failure_lesson"),
            },
            "experiences": records,
        }

    @app.get("/api/v1/prompts")
    async def list_prompts() -> dict[str, Any]:
        entries = app.state.prompt_catalog.list_metadata()
        return {
            "schema_version": "1.0",
            "runtime_injected": False,
            "count": len(entries),
            "prompts": entries,
        }

    @app.get("/api/v1/prompts/{prompt_key}")
    async def get_prompt(prompt_key: str) -> dict[str, Any]:
        entry = app.state.prompt_catalog.get(prompt_key, include_content=True)
        if entry is None:
            raise HTTPException(404, "Prompt not found")
        return {"schema_version": "1.0", **entry}

    @app.get("/api/v1/mcp/catalog")
    async def mcp_catalog() -> dict[str, Any]:
        return app.state.mcp_catalog.payload()

    @app.get("/api/v1/mcp/servers/{server_id}")
    async def get_mcp_server(server_id: str) -> dict[str, Any]:
        server = app.state.mcp_catalog.get_server(server_id)
        if server is None:
            raise HTTPException(404, "MCP server not found")
        return {"schema_version": "1.0", "server": server}

    @app.post("/api/v1/mcp/servers", status_code=201)
    async def create_mcp_server(payload: MCPServerUpsertRequest) -> dict[str, Any]:
        try:
            server = app.state.mcp_catalog.create_server(payload.model_dump(mode="json"))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"schema_version": "1.0", "server": server}

    @app.put("/api/v1/mcp/servers/{server_id}")
    async def update_mcp_server(server_id: str, payload: MCPServerUpsertRequest) -> dict[str, Any]:
        server = app.state.mcp_catalog.update_server(server_id, payload.model_dump(mode="json"))
        if server is None:
            raise HTTPException(404, "MCP server not found")
        return {"schema_version": "1.0", "server": server}

    @app.delete("/api/v1/mcp/servers/{server_id}", status_code=204)
    async def delete_mcp_server(server_id: str) -> Response:
        if not app.state.mcp_catalog.delete_server(server_id):
            raise HTTPException(404, "MCP server not found")
        return Response(status_code=204)

    @app.post("/api/v1/mcp/servers/{server_id}/tools", status_code=201)
    async def create_mcp_tool(server_id: str, payload: MCPToolUpsertRequest) -> dict[str, Any]:
        try:
            tool = app.state.mcp_catalog.create_tool(server_id, payload.model_dump(mode="json"))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if tool is None:
            raise HTTPException(404, "MCP server not found")
        return {"schema_version": "1.0", "tool": tool}

    @app.put("/api/v1/mcp/servers/{server_id}/tools/{tool_name}")
    async def update_mcp_tool(
        server_id: str,
        tool_name: str,
        payload: MCPToolUpsertRequest,
    ) -> dict[str, Any]:
        tool = app.state.mcp_catalog.update_tool(server_id, tool_name, payload.model_dump(mode="json"))
        if tool is None:
            raise HTTPException(404, "MCP server or tool not found")
        return {"schema_version": "1.0", "tool": tool}

    @app.delete("/api/v1/mcp/servers/{server_id}/tools/{tool_name}", status_code=204)
    async def delete_mcp_tool(server_id: str, tool_name: str) -> Response:
        if not app.state.mcp_catalog.delete_tool(server_id, tool_name):
            raise HTTPException(404, "MCP server or tool not found")
        return Response(status_code=204)

    @app.get("/api/v1/integration-status")
    async def integration_status() -> dict[str, Any]:
        mcp = app.state.mcp_catalog.payload()
        prompts = app.state.prompt_catalog.list_metadata()
        return {
            "schema_version": "1.0",
            "baseline_version": actual_settings.benchmark_candidate_version,
            "prompt_count": len(prompts),
            "mcp_server_count": mcp["server_count"],
            "mcp_candidate_count": mcp["candidate_count"],
            "mcp_runtime_enabled": False,
            "mcp_invocation_enabled": False,
            "native_tool_count": len(default_registry().manifests()),
            "module_routes": ["code_audit", "reverse", "penetration", "incident_response"],
        }

    @app.post("/api/v1/experiences", status_code=201)
    async def create_experience(payload: ExperienceCreateRequest) -> dict[str, Any]:
        return {"schema_version": "1.0", "experience": experiences.create_manual(payload)}

    @app.delete("/api/v1/experiences/{experience_id}", status_code=204)
    async def delete_experience(experience_id: str) -> Response:
        if not experiences.delete(experience_id):
            raise HTTPException(404, "Experience not found")
        return Response(status_code=204)

    @app.post("/api/v1/experiences/backfill")
    async def backfill_experiences() -> dict[str, Any]:
        result = experiences.backfill(service.ledger)
        return {"schema_version": "1.0", **result}

    @app.get("/api/v1/penetration/projects")
    async def list_penetration_projects() -> dict[str, Any]:
        try:
            projects = await penetration_get(
                actual_settings.penetration_base_url,
                "/projects",
                actual_settings.module_timeout_seconds,
            )
        except (PenetrationUnavailableError, PenetrationProtocolError) as exc:
            raise HTTPException(503, str(exc)) from exc
        if not isinstance(projects, list):
            raise HTTPException(502, "Penetration project list has an invalid shape")
        return {"schema_version": "1.0", "source": "penetration", "projects": projects}

    @app.get("/api/v1/runs/{run_id}/penetration-graph")
    async def get_penetration_graph(run_id: str) -> dict[str, Any]:
        try:
            state = service.state(run_id)
        except KeyError as exc:
            raise HTTPException(404, "Run not found") from exc
        if state.module_route != "penetration":
            raise HTTPException(409, "Run is not routed to the penetration module")
        try:
            project_id = await resolve_project_id(
                state,
                actual_settings.penetration_base_url,
                actual_settings.module_timeout_seconds,
            )
            if project_id is None:
                return {
                    "schema_version": "1.0",
                    "source": "penetration",
                    "available": True,
                    "linked": False,
                    "project_id": None,
                    "project": None,
                    "nodes": [],
                    "edges": [],
                    "counts": {},
                }
            detail = await penetration_get(
                actual_settings.penetration_base_url,
                f"/projects/{project_id}",
                actual_settings.module_timeout_seconds,
            )
            if not isinstance(detail, dict):
                raise PenetrationProtocolError("Penetration project detail must be an object")
            return normalize_penetration_graph(detail)
        except KeyError as exc:
            raise HTTPException(404, "Linked Penetration project was not found") from exc
        except PenetrationUnavailableError as exc:
            raise HTTPException(503, str(exc)) from exc
        except PenetrationProtocolError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/api/v1/question-banks/inspect", status_code=202)
    async def inspect_question_bank(payload: QuestionBankInspectRequest) -> dict[str, Any]:
        try:
            return question_banks.create_inspection(payload)
        except QuestionBankError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/v1/question-banks/{bank_id}/inspection")
    def get_question_bank_inspection(bank_id: str) -> dict[str, Any]:
        try:
            return question_banks.get(bank_id)
        except KeyError as exc:
            raise HTTPException(404, "Question bank inspection not found") from exc

    @app.post("/api/v1/question-banks/{bank_id}/confirm")
    def confirm_question_bank(bank_id: str, payload: QuestionBankConfirmRequest) -> dict[str, Any]:
        try:
            return question_banks.confirm(bank_id, payload)
        except KeyError as exc:
            raise HTTPException(404, "Question bank inspection not found") from exc
        except QuestionBankError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.websocket("/api/v1/question-banks/{bank_id}/events")
    async def question_bank_events(websocket: WebSocket, bank_id: str) -> None:
        try:
            current = question_banks.get(bank_id)
        except KeyError:
            await websocket.close(code=4404, reason="Question bank inspection not found")
            return
        await websocket.accept()
        await websocket.send_json({"type": "inspection.snapshot", "bank_id": bank_id, "payload": current})
        if current["status"] != "inspecting":
            return
        try:
            async with question_banks.subscribe(bank_id) as queue:
                latest = question_banks.get(bank_id)
                if latest["status"] != "inspecting":
                    await websocket.send_json(
                        {"type": "inspection.snapshot", "bank_id": bank_id, "payload": latest}
                    )
                    return
                while True:
                    event = await queue.get()
                    await websocket.send_json(event)
                    if event["type"] in {
                        "inspection.completed",
                        "inspection.manual_required",
                        "inspection.failed",
                    }:
                        return
        except WebSocketDisconnect:
            return

    @app.get("/api/v1/benchmark/tasks")
    async def list_benchmark_tasks() -> dict[str, Any]:
        try:
            tasks = evaluation_service.catalog.list_tasks()
        except EvaluationError as exc:
            raise HTTPException(503, str(exc)) from exc
        return {
            "schema_version": "1.0",
            "dataset_version": actual_settings.benchmark_dataset_version,
            "suite": "S-Suite",
            "tasks": [item.model_dump(mode="json") for item in tasks],
        }

    @app.post("/api/v1/evaluations", status_code=202)
    async def create_evaluation(payload: EvaluationCreateRequest) -> dict[str, Any]:
        try:
            job = await evaluation_service.create(payload)
        except EvaluationError as exc:
            raise HTTPException(422, str(exc)) from exc
        return job.model_dump(mode="json")

    @app.get("/api/v1/evaluations/by-run/{run_id}")
    async def get_evaluation_by_run(run_id: str) -> dict[str, Any]:
        job = evaluation_service.by_run(run_id)
        if job is None:
            raise HTTPException(404, "Evaluation not found")
        return job.model_dump(mode="json")

    @app.get("/api/v1/evaluations/{evaluation_id}")
    async def get_evaluation(evaluation_id: str) -> dict[str, Any]:
        try:
            return evaluation_service.get(evaluation_id).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(404, "Evaluation not found") from exc

    @app.get("/api/v1/evaluations/{evaluation_id}/score")
    async def get_evaluation_score(evaluation_id: str) -> dict[str, Any]:
        try:
            return evaluation_service.score(evaluation_id)
        except KeyError as exc:
            raise HTTPException(404, "Evaluation not found") from exc
        except FileNotFoundError as exc:
            raise HTTPException(409, "Score is not available yet") from exc

    @app.get("/api/v1/evaluations/{evaluation_id}/report", response_class=FileResponse)
    async def get_evaluation_report(evaluation_id: str) -> FileResponse:
        try:
            path = evaluation_service.report_path(evaluation_id)
        except KeyError as exc:
            raise HTTPException(404, "Evaluation not found") from exc
        except FileNotFoundError as exc:
            raise HTTPException(409, "Evaluation report is not available yet") from exc
        return FileResponse(path, media_type="text/markdown", filename=f"{evaluation_id}-score-report.md")

    @app.websocket("/api/v1/evaluations/{evaluation_id}/events")
    async def evaluation_events_socket(
        websocket: WebSocket,
        evaluation_id: str,
        after_sequence: int = 0,
    ) -> None:
        try:
            evaluation_service.get(evaluation_id)
        except KeyError:
            await websocket.close(code=4404, reason="Evaluation not found")
            return
        await websocket.accept()
        try:
            for event in evaluation_service.store.events(evaluation_id, after_sequence):
                await websocket.send_json(event)
            async with evaluation_service.subscribe(evaluation_id) as queue:
                while True:
                    await websocket.send_json(await queue.get())
        except WebSocketDisconnect:
            return

    @app.get("/api/v1/runs")
    async def list_runs(
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
    ) -> dict[str, Any]:
        return {
            "schema_version": "1.0",
            "runs": [summary.model_dump(mode="json") for summary in service.summaries(limit)],
        }

    @app.get("/api/v1/runs/{run_id}")
    async def get_run(run_id: str) -> dict[str, Any]:
        try:
            return service.summary(run_id).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(404, "Run not found") from exc

    @app.get("/api/v1/runs/{run_id}/report")
    async def get_report(run_id: str) -> dict[str, Any]:
        try:
            state = service.state(run_id)
        except KeyError as exc:
            raise HTTPException(404, "Run not found") from exc
        if state.report is None:
            raise HTTPException(409, "Report is not available yet")
        return state.report.model_dump(mode="json")

    @app.post("/api/v1/runs/{run_id}/report/refresh")
    async def refresh_report(run_id: str) -> dict[str, Any]:
        """Synchronize the latest confirmed Cairn result into the report."""
        try:
            state = service.state(run_id)
        except KeyError as exc:
            raise HTTPException(404, "Run not found") from exc
        if state.module_route != "penetration":
            raise HTTPException(409, "Run is not routed to the penetration module")
        if state.report is None:
            raise HTTPException(409, "Report is not available yet")
        try:
            project_id = await resolve_project_id(
                state, actual_settings.penetration_base_url, actual_settings.module_timeout_seconds,
            )
            if project_id is None:
                raise HTTPException(409, "Penetration project has not been created yet")
            detail = await penetration_get(
                actual_settings.penetration_base_url,
                f"/projects/{project_id}",
                actual_settings.module_timeout_seconds,
            )
            graph = normalize_penetration_graph(detail)
        except HTTPException:
            raise
        except (PenetrationUnavailableError, PenetrationProtocolError) as exc:
            raise HTTPException(503, str(exc)) from exc
        confirmed = [
            node for node in graph.get("nodes", [])
            if node.get("type") in {"vulnerability", "fact"} and node.get("status") == "confirmed"
        ]
        flag_pattern = re.compile(r"(?:flag|ctf)\{[^}\r\n]+\}", re.IGNORECASE)
        flag_node = next((node for node in confirmed if flag_pattern.search(str(node.get("description", "")))), None)
        if flag_node is None:
            raise HTTPException(409, "Penetration project has no confirmed flag result yet")
        description = str(flag_node.get("description", "")).strip()
        finding = Finding(
            finding_id=f"penetration:{project_id}:{flag_node.get('raw_id', 'result')}",
            rule_id="PENETRATION-CONFIRMED-RESULT",
            severity="HIGH",
            confidence="HIGH",
            path=str(state.task.target_scope[0] if state.task.target_scope else project_id),
            title="渗透模块已确认漏洞并获取 Flag",
            description=description,
            remediation="修复已确认的命令注入路径，并轮换或撤销暴露的挑战凭据。",
            raw={"source": "cairn", "project_id": project_id},
        )
        previous = state.report
        state.report = AgentReport.model_validate(previous.model_copy(update={
            "status": RunStatus.COMPLETED,
            "executive_summary": f"Cairn 渗透模块已完成目标验证并获取 Flag。{description}",
            "findings": [item for item in previous.findings if item.rule_id != finding.rule_id] + [finding],
            "limitations": [
                item for item in previous.limitations
                if "尚未获得目标 flag" not in item and "尚未发现漏洞" not in item and "仅完成项目初始化" not in item
            ] + [f"结果已从 Cairn 项目 {project_id} 刷新。"],
            "generated_at": datetime.now(UTC),
        }))
        state.status = RunStatus.COMPLETED
        state.external_execution = {
            **state.external_execution,
            "module": "penetration",
            "project_id": project_id,
            "status": "completed",
            "terminal": True,
            "exploration_complete": True,
            "objective_reached": True,
        }
        service.ledger.save_state(state)
        event = service.ledger.append(
            run_id,
            "report.refreshed",
            {"source": "cairn", "project_id": project_id, "flag_obtained": True},
            actor="api",
        )
        await service.event_hub.publish(event.model_dump(mode="json"))
        return state.report.model_dump(mode="json")

    @app.get("/api/v1/runs/{run_id}/ledger")
    async def get_ledger(
        run_id: str,
        after_sequence: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=5000)] = 1000,
    ) -> dict[str, Any]:
        if service.ledger.load_state(run_id) is None:
            raise HTTPException(404, "Run not found")
        events = service.ledger.events(run_id, after_sequence, limit)
        return {
            "schema_version": "1.0",
            "run_id": run_id,
            "events": [event.model_dump(mode="json") for event in events],
            "chain_valid": service.ledger.verify(run_id),
        }

    @app.get("/api/v1/runs/{run_id}/ledger/export", response_class=FileResponse)
    async def export_ledger(run_id: str) -> FileResponse:
        if service.ledger.load_state(run_id) is None:
            raise HTTPException(404, "Run not found")
        destination = actual_settings.run_root / run_id / "ledger.jsonl"
        service.ledger.export_jsonl(run_id, destination)
        return FileResponse(destination, filename=f"{run_id}-ledger.jsonl")

    @app.get("/api/v1/runs/{run_id}/thoughts/export", response_class=FileResponse)
    async def export_thoughts(run_id: str) -> FileResponse:
        state = service.ledger.load_state(run_id)
        if state is None:
            raise HTTPException(404, "Run not found")
        terminal = {
            RunStatus.COMPLETED,
            RunStatus.PARTIAL,
            RunStatus.FAILED,
            RunStatus.DENIED,
        }
        if state.status not in terminal:
            raise HTTPException(409, "Thought process is available after the run reaches a terminal state")
        destination = actual_settings.run_root / run_id / "thought-process.md"
        service.ledger.export_thought_markdown(run_id, destination)
        return FileResponse(
            destination,
            media_type="text/markdown; charset=utf-8",
            filename=f"{run_id}-thought-process.md",
        )

    @app.post("/api/v1/runs/{run_id}/approvals/{request_id}", status_code=202)
    async def resolve_approval(run_id: str, request_id: str, response: ApprovalResponse) -> dict[str, Any]:
        try:
            state = service.state(run_id)
        except KeyError as exc:
            raise HTTPException(404, "Run not found") from exc
        if state.pending_approval is None or state.pending_approval.request_id != request_id:
            raise HTTPException(409, "Approval request is not active")
        service.submit_approval(run_id, response)
        return {"schema_version": "1.0", "run_id": run_id, "accepted": True}

    @app.websocket("/api/v1/runs/{run_id}/events")
    async def events_socket(websocket: WebSocket, run_id: str, after_sequence: int = 0) -> None:
        if service.ledger.load_state(run_id) is None:
            await websocket.close(code=4404, reason="Run not found")
            return
        await websocket.accept()
        try:
            async with service.event_hub.subscribe(run_id) as queue:
                # Subscribe before reading the backlog.  Reading the backlog
                # first creates a race where events emitted during that read
                # are lost, which makes the UI appear frozen until its next
                # polling pass.
                last_sequence = after_sequence
                for stored_event in service.ledger.events(run_id, after_sequence=after_sequence):
                    await websocket.send_text(stored_event.model_dump_json())
                    last_sequence = max(last_sequence, stored_event.sequence)
                while True:
                    live_event = await queue.get()
                    # The event may already have been included in the
                    # backlog if it was committed just before the snapshot.
                    # Sequence filtering keeps reconnects and the initial
                    # snapshot idempotent.
                    sequence = int(live_event.get("sequence") or 0)
                    if sequence <= last_sequence:
                        continue
                    last_sequence = sequence
                    await websocket.send_text(json.dumps(live_event, ensure_ascii=False))
        except WebSocketDisconnect:
            return

    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "security_agent.api:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=False,
    )
