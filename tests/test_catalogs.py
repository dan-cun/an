from pathlib import Path

from security_agent.mcp_catalog import MCPCatalog
from security_agent.prompt_catalog import PromptCatalog


def test_prompt_catalog_is_read_only_and_complete() -> None:
    catalog = PromptCatalog()
    entries = catalog.list_metadata()
    assert len(entries) == 6
    assert {item["key"] for item in entries} >= {"primary_agent", "pentester", "reporter"}
    assert all(item["runtime_injected"] is False for item in entries)
    assert all(len(str(item["checksum"])) == 64 for item in entries)


def test_mcp_catalog_never_enables_or_connects() -> None:
    catalog = MCPCatalog(Path(__file__).parents[1] / "config" / "mcp-servers.json")
    payload = catalog.payload()
    assert payload["runtime_enabled"] is False
    assert payload["invocation_enabled"] is False
    assert payload["tool_registration"] == "not_registered"
    assert payload["candidate_count"] == 3
    assert payload["safe_tool_count"] == 32
    assert set(payload["excluded_servers"]) == {"local-http-fetch", "local-chrome-devtools"}
    assert all(item["enabled"] is False for item in payload["servers"])
    assert all(item["safe_server"] is True for item in payload["servers"])
    assert all(item["icon"] for item in payload["servers"])
    assert all(tool["display_name"] and tool["icon"] for server in payload["servers"] for tool in server["tools"])
    assert all(item["runtime_exposed"] is False for server in payload["servers"] for item in server["tools"])
