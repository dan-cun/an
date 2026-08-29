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
    expected_titles = {f"安全智能体平台 {state.run_id}"}
    matches = [
        item for item in projects
        if isinstance(item, dict) and item.get("title") in expected_titles and isinstance(item.get("id"), str)
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
