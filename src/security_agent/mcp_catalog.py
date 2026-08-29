"""Safe, non-executing MCP registry imported from anquan2.

This module only reads a local JSON file.  It never connects to a server,
registers tools with :class:`ToolBroker`, or exposes entries to the planner.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "config" / "mcp-servers.json"

_SAFE_CANDIDATES = {"local-semgrep", "local-cyberchef", "local-wiremcp"}
_RISK_BY_ID = {
    "local-semgrep": "R1",
    "local-cyberchef": "R1",
    "local-wiremcp": "R1",
    "local-http-fetch": "R2",
    "local-chrome-devtools": "R2",
    "local-web-security": "R2",
    "local-security-extended": "R3",
}
_DETAILS = {
    "local-semgrep": ("代码安全扫描", "代码路径和规则", "发现列表与证据", "代码审计且用户确认后"),
    "local-cyberchef": ("数据编码/解码与转换", "文本或字节、配方", "转换后的数据", "需要离线数据处理时"),
    "local-wiremcp": ("网络取证解析", "抓包或协议数据", "解析字段与摘要", "逆向或网络证据分析时"),
    "local-http-fetch": ("读取 HTTP 资源", "URL 与请求参数", "响应摘要", "渗透任务且用户确认后"),
    "local-chrome-devtools": ("浏览器调试", "页面或调试目标", "DOM/网络调试信息", "浏览器验证且用户确认后"),
    "local-web-security": ("Web 安全检测", "目标与检测参数", "检测结果", "授权靶场检测且用户确认后"),
    "local-security-extended": ("扩展安全分析", "任务和分析参数", "分析报告", "后续评估并审批后"),
}


class MCPCatalog:
    def __init__(self, path: Path | None = None) -> None:
        self.path = (path or DEFAULT_CONFIG).resolve()

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"schema_version": "1.0", "runtime_enabled": False, "servers": []}
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("MCP catalog must be a JSON object")
        return payload

    def servers(self) -> list[dict[str, Any]]:
        payload = self._load()
        result: list[dict[str, Any]] = []
        for raw in payload.get("servers", []):
            if not isinstance(raw, dict) or not raw.get("server_id"):
                continue
            server_id = str(raw["server_id"])
            parsed = urlparse(str(raw.get("url", "")))
            purpose, inputs, outputs, timing = _DETAILS.get(
                server_id, ("外部安全工具", "工具参数", "工具结果", "完成安全分析且获授权后")
            )
            result.append(
                {
                    "server_id": server_id,
                    "name": str(raw.get("name", server_id)),
                    "transport": str(raw.get("transport", "unknown")),
                    "url": f"{parsed.scheme}://{parsed.netloc}{parsed.path}" if parsed.scheme and parsed.netloc else "",
                    "enabled": False,
                    "status": "prepared" if server_id in _SAFE_CANDIDATES else "disabled",
                    "candidate": server_id in _SAFE_CANDIDATES,
                    "risk_level": _RISK_BY_ID.get(server_id, "R2"),
                    "category": (raw.get("metadata") or {}).get("category", "security"),
                    "purpose": purpose,
                    "input": inputs,
                    "return": outputs,
                    "invocation_timing": timing,
                }
            )
        return result

    def payload(self) -> dict[str, Any]:
        servers = self.servers()
        return {
            "schema_version": "1.0",
            "runtime_enabled": False,
            "invocation_enabled": False,
            "tool_registration": "not_registered",
            "server_count": len(servers),
            "candidate_count": sum(1 for item in servers if item["candidate"]),
            "servers": servers,
        }
