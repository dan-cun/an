from __future__ import annotations

from security_agent.penetration_integration import normalize_penetration_graph


def test_normalize_penetration_graph_preserves_ai_fact_intent_semantics() -> None:
    graph = normalize_penetration_graph(
        {
            "project": {
                "id": "proj_001",
                "title": "authorized lab",
                "status": "active",
                "bootstrap_enabled": True,
                "created_at": "2026-08-28T00:00:00Z",
                "reason": None,
            },
            "facts": [
                {"id": "origin", "description": "测试授权靶场 https://lab.test"},
                {"id": "goal", "description": "确认高风险漏洞"},
                {"id": "f001", "description": "发现 /login 存在 SQL 注入漏洞"},
                {"id": "f002", "description": "服务端使用 Spring Boot"},
            ],
            "intents": [
                {
                    "id": "i001",
                    "from": ["origin"],
                    "to": "f001",
                    "description": "验证登录参数是否可注入",
                    "creator": "ai-worker-1",
                    "worker": None,
                    "created_at": "2026-08-28T00:00:01Z",
                    "concluded_at": "2026-08-28T00:00:05Z",
                },
                {
                    "id": "i002",
                    "from": ["f001"],
                    "to": None,
                    "description": "猜测可进一步绕过认证",
                    "creator": "ai-worker-1",
                    "worker": None,
                    "created_at": "2026-08-28T00:00:06Z",
                    "concluded_at": None,
                },
                {
                    "id": "i003",
                    "from": ["f002"],
                    "to": None,
                    "description": "检查框架管理端点",
                    "creator": "ai-worker-2",
                    "worker": "ai-worker-2",
                    "created_at": "2026-08-28T00:00:07Z",
                    "concluded_at": None,
                },
            ],
            "hints": [
                {
                    "id": "h001",
                    "content": "测试范围只包含 lab.test",
                    "creator": "operator",
                    "created_at": "2026-08-28T00:00:00Z",
                }
            ],
        }
    )

    nodes = {node["id"]: node for node in graph["nodes"]}
    assert nodes["fact:origin"]["type"] == "origin"
    assert nodes["fact:goal"]["type"] == "goal"
    assert nodes["fact:f001"]["type"] == "vulnerability"
    assert nodes["fact:f001"]["ai_generated"] is True
    assert nodes["fact:f002"]["type"] == "fact"
    assert nodes["intent:i001"]["type"] == "intent"
    assert nodes["intent:i001"]["status"] == "confirmed"
    assert nodes["intent:i002"]["type"] == "hypothesis"
    assert nodes["intent:i002"]["status"] == "waiting"
    assert nodes["intent:i003"]["type"] == "intent"
    assert nodes["intent:i003"]["status"] == "exploring"
    assert nodes["hint:h001"]["ai_generated"] is False

    edges = {(edge["source"], edge["target"], edge["type"]) for edge in graph["edges"]}
    assert ("fact:origin", "intent:i001", "intent-chain") in edges
    assert ("intent:i001", "fact:f001", "produces") in edges
    assert ("fact:f001", "intent:i002", "hypothesis") in edges
    assert graph["counts"]["vulnerability"] == 1
