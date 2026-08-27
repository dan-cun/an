from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from secmind.config import Settings, get_settings
from secmind.evaluation import EvaluationError, EvaluationService
from secmind.fusion import classify_task
from secmind.guardrail import Guardrail
from secmind.ledger import LedgerStore
from secmind.llm import ModelGatewayError, QwenGateway, close_gateway_safely
from secmind.orchestrator import SecMindOrchestrator
from secmind.question_bank import QuestionBankError, QuestionBankService
from secmind.schemas import (
    ApprovalResponse,
    EvaluationCreateRequest,
    ModelConfigUpdate,
    ModelConnectionTest,
    QuestionBankConfirmRequest,
    QuestionBankInspectRequest,
    RunStatus,
    TaskRequest,
)
from secmind.service import EventHub, RunService
from secmind.tools import ToolBroker, default_registry


def build_runtime(settings: Settings) -> tuple[RunService, EvaluationService, QwenGateway]:
    settings.prepare_directories()
    ledger = LedgerStore(settings.database_url)
    hub = EventHub()
    gateway = QwenGateway(settings)
    broker = ToolBroker(default_registry(), Guardrail())
    orchestrator = SecMindOrchestrator(settings, ledger, gateway, broker, hub.publish)
    service = RunService(orchestrator, ledger, hub)
    return service, EvaluationService(settings, service), gateway


def create_app(settings: Settings | None = None) -> FastAPI:
    actual_settings = settings or get_settings()
    service, evaluation_service, gateway = build_runtime(actual_settings)
    question_banks = QuestionBankService(actual_settings, gateway)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await service.recover_incomplete()
        await evaluation_service.recover_incomplete()
        await question_banks.recover_incomplete()
        yield
        await question_banks.shutdown()
        await evaluation_service.shutdown()
        await service.shutdown()
        await close_gateway_safely(gateway)

    app = FastAPI(
        title="SecMind Agent API",
        version="0.1.0",
        description="Auditable and recoverable network-security agent runtime.",
        lifespan=lifespan,
    )
    app.state.service = service
    app.state.evaluation_service = evaluation_service
    app.state.question_banks = question_banks
    app.state.settings = actual_settings

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
            "provider": "qwen",
            "base_url": actual_settings.qwen_base_url,
            "planner_model": actual_settings.planner_model,
            "worker_model": actual_settings.worker_model,
            "fallback_model": actual_settings.fallback_model,
            "embedding_model": actual_settings.embedding_model,
            "api_key_configured": bool(actual_settings.qwen_api_key),
            "demo_mode": actual_settings.demo_mode,
            "timeout_seconds": actual_settings.model_timeout_seconds,
        }

    @app.post("/api/v1/model-config/test")
    async def test_model_config(payload: ModelConnectionTest) -> dict[str, Any]:
        try:
            base_url = actual_settings.validate_model_base_url(payload.base_url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        api_key = payload.api_key or actual_settings.qwen_api_key
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

    @app.put("/api/v1/model-config")
    async def update_model_config(payload: ModelConfigUpdate) -> dict[str, Any]:
        try:
            actual_settings.qwen_base_url = actual_settings.validate_model_base_url(payload.base_url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if payload.clear_api_key:
            actual_settings.qwen_api_key = ""
        elif payload.api_key is not None:
            actual_settings.qwen_api_key = payload.api_key
        for field_name in ("planner_model", "worker_model", "fallback_model"):
            value = getattr(payload, field_name)
            if value is not None:
                normalized = value.strip()
                if not normalized:
                    raise HTTPException(422, f"{field_name} must not be empty")
                setattr(actual_settings, field_name, normalized)
        actual_settings.demo_mode = not bool(actual_settings.qwen_api_key)
        actual_settings.save_runtime_model_config()
        return {
            "schema_version": "1.0",
            "updated": True,
            "base_url": actual_settings.qwen_base_url,
            "planner_model": actual_settings.planner_model,
            "worker_model": actual_settings.worker_model,
            "fallback_model": actual_settings.fallback_model,
            "api_key_configured": bool(actual_settings.qwen_api_key),
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
            "model_call_count": sum(state.budget.model_calls_used for state in states),
            "prompt_tokens": sum(state.budget.prompt_tokens_used for state in states),
            "completion_tokens": sum(state.budget.completion_tokens_used for state in states),
            "total_tokens": sum(
                state.budget.prompt_tokens_used + state.budget.completion_tokens_used
                for state in states
            ),
            "cache_read_tokens": sum(state.budget.cache_read_tokens_used for state in states),
            "token_usage_available": any(state.budget.model_usage_recorded for state in states),
            "models": models,
            "note": (
                "Usage values are updated from Qwen stream completion events."
                if any(state.budget.model_usage_recorded for state in states)
                else "No provider usage has been recorded yet."
            ),
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
        if task.question_bank_id:
            try:
                question_banks.require_confirmed(task.question_bank_id, task.attachments)
            except KeyError as exc:
                raise HTTPException(404, "Question bank inspection not found") from exc
            except QuestionBankError as exc:
                raise HTTPException(409, str(exc)) from exc
        run_id = service.submit(task)
        return {"schema_version": "1.0", "run_id": run_id, "status": RunStatus.PENDING}

    @app.post("/api/v1/tasks/classify")
    async def classify_task_route(task: TaskRequest) -> dict[str, Any]:
        result = classify_task(task.objective, task.attachments, task.target_scope)
        result["scenario"] = result["scenario"].value
        return {"schema_version": "1.0", **result}

    @app.get("/api/v1/modules")
    async def list_modules() -> dict[str, Any]:
        return {"schema_version": "1.0", "modules": [
            {"id": "code_audit", "name": "代码审计", "adapter": "workspace_security_audit", "available": True},
            {"id": "reverse", "name": "逆向分析", "adapter": "reverse_module", "available": True, "base_url": actual_settings.reverse_base_url},
            {"id": "penetration", "name": "渗透测试", "adapter": "penetration_module", "available": True, "base_url": actual_settings.cairn_base_url},
        ]}

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
            for stored_event in service.ledger.events(run_id, after_sequence=after_sequence):
                await websocket.send_text(stored_event.model_dump_json())
            async with service.event_hub.subscribe(run_id) as queue:
                while True:
                    live_event = await queue.get()
                    await websocket.send_text(json.dumps(live_event, ensure_ascii=False))
        except WebSocketDisconnect:
            return

    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "secmind.api:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=False,
    )
