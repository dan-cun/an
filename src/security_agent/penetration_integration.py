from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

import httpx

from security_agent.schemas import AgentState

_VULNERABILITY_PATTERN = re.compile(
    r"(?:漏洞|高风险|未授权|越权|注入|命令执行|任意文件|文件上传|目录遍历|"
    r"反序列化|弱口令|口令爆破|信息泄露|跨站|XSS|CSRF|SSRF|RCE|SQLi|CVE-|CWE-)",
    re.IGNORECASE,
)


class PenetrationUnavailableError(RuntimeError):
    pass


class PenetrationProtocolError(RuntimeError):
    pass


def project_title_for_run(run_id: str) -> str:
    """Return the neutral project title used to link a run to its graph."""
    return f"sec-task-{run_id}"


def extract_project_id(state: AgentState) -> str | None:
    for observation in reversed(state.observations):
        data = observation.data
        adapter = data.get("adapter")
        if not isinstance(adapter, str) or not adapter.strip():
            continue
        direct = data.get("project_id")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()
        project = data.get("project")
        if isinstance(project, dict):
            project_id = project.get("id")
            if isinstance(project_id, str) and project_id.strip():
                return project_id.strip()
        raw = data.get("response")
        if not isinstance(raw, str):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        project_id = payload.get("project", {}).get("id") if isinstance(payload, dict) else None
        if isinstance(project_id, str) and project_id.strip():
            return project_id.strip()
    return None


async def penetration_get(base_url: str, path: str, timeout_seconds: float) -> Any:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise PenetrationUnavailableError(f"Penetration service is unavailable: {exc}") from exc
    if response.status_code == 404:
        raise KeyError(path)
    if response.status_code >= 400:
        raise PenetrationUnavailableError(f"Penetration service returned HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise PenetrationProtocolError("Penetration service returned an invalid JSON response") from exc


async def resolve_project_id(
    state: AgentState,
    base_url: str,
    timeout_seconds: float,
) -> str | None:
    persisted = extract_project_id(state)
    if persisted:
        return persisted
    projects = await penetration_get(base_url, "/projects", timeout_seconds)
    if not isinstance(projects, list):
        raise PenetrationProtocolError("Penetration project list must be an array")
    matches = [
        item for item in projects
        if (
            isinstance(item, dict)
            and isinstance(item.get("title"), str)
            and (
                item.get("title") == project_title_for_run(state.run_id)
                # Existing projects used a branded prefix. Matching the
                # immutable run-id suffix keeps old blackboards readable
                # without coupling new project titles to that label.
                or item["title"].endswith(state.run_id)
            )
            and isinstance(item.get("id"), str)
        )
    ]
    if not matches:
        return None
    matches.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return str(matches[0]["id"])


def _fact_type(fact_id: str, description: str) -> str:
    if fact_id == "origin":
        return "origin"
    if fact_id == "goal":
        return "goal"
    if _VULNERABILITY_PATTERN.search(description):
        return "vulnerability"
    return "fact"


def normalize_penetration_graph(detail: dict[str, Any]) -> dict[str, Any]:
    project = detail.get("project")
    facts = detail.get("facts", [])
    intents = detail.get("intents", [])
    hints = detail.get("hints", [])
    if not isinstance(project, dict) or not isinstance(facts, list) or not isinstance(intents, list):
        raise PenetrationProtocolError("Penetration project detail has an invalid shape")

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    fact_ids: set[str] = set()
    worker_ids: set[str] = set()

    # The blackboard stores the worker assignment on intents (and, while a project-level
    # reason lease is active, on the project metadata).  The UI models the
    # assignment as a first-class node so the visible chain is
    # Origin -> Intent -> Worker -> Fact/Goal instead of hiding execution in
    # an intent's metadata.
    project_reason = project.get("reason") if isinstance(project.get("reason"), dict) else None
    if project_reason and isinstance(project_reason.get("worker"), str) and project_reason["worker"].strip():
        worker_ids.add(project_reason["worker"].strip())

    for fact in facts:
        if not isinstance(fact, dict) or not isinstance(fact.get("id"), str):
            continue
        fact_id = fact["id"]
        description = str(fact.get("description", "")).strip() or fact_id
        node_type = _fact_type(fact_id, description)
        fact_ids.add(fact_id)
        nodes.append(
            {
                "id": f"fact:{fact_id}",
                "raw_id": fact_id,
                "type": node_type,
                "label": description,
                "description": description,
                "status": "confirmed",
                "ai_generated": fact_id not in {"origin", "goal"},
                "creator": "AI Worker" if fact_id not in {"origin", "goal"} else "operator",
            }
        )

    for intent in intents:
        if not isinstance(intent, dict) or not isinstance(intent.get("id"), str):
            continue
        intent_id = intent["id"]
        source_ids = [item for item in intent.get("from", []) if isinstance(item, str)]
        target_id = intent.get("to") if isinstance(intent.get("to"), str) else None
        worker = intent.get("worker") if isinstance(intent.get("worker"), str) else None
        if worker and worker.strip():
            worker = worker.strip()
            worker_ids.add(worker)
        concluded = bool(intent.get("concluded_at") or target_id)
        node_type = "hypothesis" if not concluded and not worker else "intent"
        status = "confirmed" if concluded else "exploring" if worker else "waiting"
        description = str(intent.get("description", "")).strip() or intent_id
        creator = str(intent.get("creator", "AI Worker"))
        nodes.append(
            {
                "id": f"intent:{intent_id}",
                "raw_id": intent_id,
                "type": node_type,
                "label": description,
                "description": description,
                "status": status,
                "ai_generated": True,
                "creator": creator,
                "worker": worker,
                "created_at": intent.get("created_at"),
                "concluded_at": intent.get("concluded_at"),
            }
        )
        for source_id in source_ids:
            if source_id not in fact_ids:
                continue
            edges.append(
                {
                    "id": f"edge:{source_id}:{intent_id}",
                    "source": f"fact:{source_id}",
                    "target": f"intent:{intent_id}",
                    "type": "hypothesis" if node_type == "hypothesis" else "intent-chain",
                    "label": "猜想" if node_type == "hypothesis" else "意图链",
                    "status": status,
                }
            )
        if worker:
            # Assignment is deliberately represented as a separate edge.  It
            # lets the frontend distinguish reasoning links from execution
            # ownership while retaining the original intent->fact link.
            edges.append(
                {
                    "id": f"edge:{intent_id}:worker:{worker}",
                    "source": f"intent:{intent_id}",
                    "target": f"worker:{worker}",
                    "type": "worker-assignment",
                    "label": "执行",
                    "status": "exploring" if not concluded else "confirmed",
                }
            )
        if target_id and target_id in fact_ids:
            edges.append(
                {
                    "id": f"edge:{intent_id}:{target_id}",
                    "source": f"intent:{intent_id}",
                    "target": f"fact:{target_id}",
                    "type": "produces",
                    "label": "产出" if target_id != "goal" else "证明",
                    "status": "confirmed",
                }
            )

            if worker:
                edges.append(
                    {
                        "id": f"edge:{intent_id}:worker-output:{worker}:{target_id}",
                        "source": f"worker:{worker}",
                        "target": f"fact:{target_id}",
                        "type": "worker-output",
                        "label": "产出",
                        "status": "confirmed",
                    }
                )

    for worker in sorted(worker_ids):
        active = bool(project_reason and project_reason.get("worker") == worker)
        active = active or any(
            isinstance(intent, dict)
            and isinstance(intent.get("worker"), str)
            and intent.get("worker", "").strip() == worker
            and not (intent.get("concluded_at") or intent.get("to"))
            for intent in intents
        )
        nodes.append(
            {
                "id": f"worker:{worker}",
                "raw_id": worker,
                "type": "worker",
                "label": worker,
                "description": f"sec Worker：{worker}",
                "status": "exploring" if active else "confirmed",
                "ai_generated": True,
                "creator": "sec-dispatcher",
            }
        )

    origin_exists = "origin" in fact_ids
    for hint in hints if isinstance(hints, list) else []:
        if not isinstance(hint, dict) or not isinstance(hint.get("id"), str):
            continue
        hint_id = hint["id"]
        content = str(hint.get("content", "")).strip() or hint_id
        nodes.append(
            {
                "id": f"hint:{hint_id}",
                "raw_id": hint_id,
                "type": "hint",
                "label": content,
                "description": content,
                "status": "confirmed",
                "ai_generated": False,
                "creator": str(hint.get("creator", "operator")),
                "created_at": hint.get("created_at"),
            }
        )
        if origin_exists:
            edges.append(
                {
                    "id": f"edge:origin:{hint_id}",
                    "source": "fact:origin",
                    "target": f"hint:{hint_id}",
                    "type": "hint",
                    "label": "提示",
                    "status": "confirmed",
                }
            )

    counts: dict[str, int] = {}
    for node in nodes:
        counts[node["type"]] = counts.get(node["type"], 0) + 1

    return {
        "schema_version": "1.0",
        "source": "penetration",
        "available": True,
        "linked": True,
        "project_id": project.get("id"),
        "project": project,
        "nodes": nodes,
        "edges": edges,
        "counts": counts,
        "fetched_at": datetime.now(UTC).isoformat(),
    }
