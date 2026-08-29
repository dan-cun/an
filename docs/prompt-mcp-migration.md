# Prompt / MCP 迁移说明

本阶段将 anquan2 的 Prompt 与 MCP 资产整理到 baseline（8001）后端，但不改变现有 Agent 图。

## Prompt

`src/security_agent/prompts/` 保存交互、主控、渗透、代码、报告和反思 6 个模板。
`GET /api/v1/prompts` 返回版本、来源、SHA-256 和阶段；`GET /api/v1/prompts/{key}` 才返回模板正文。
所有条目都标记 `runtime_injected=false`，因此不会替换当前 Agent 的 Prompt。

## MCP

`config/mcp-servers.json` 是只读登记表，`config/mcp-servers-disabled.json` 是空的禁用基线。
`GET /api/v1/mcp/catalog` 返回作用、输入、返回、调用时机、风险等级和候选状态。
当前 `runtime_enabled=false`、`invocation_enabled=false`，没有 MCP SDK 连接、ToolBroker 注册或模型工具暴露。
低风险候选为 Semgrep、CyberChef、WireMCP；HTTP、浏览器和扩展安全工具继续禁用。

## 重启 8001 后端

迁移代码需要重启已经运行的 baseline 进程才能生效。先在运行该进程的 PowerShell 窗口按 `Ctrl+C`，再执行：

```powershell
cd C:\kaifa\tool\my-competition-secmind-baseline-f606c48
$env:SECURITY_AGENT_API_PORT="8001"
uv run security-agent-api
```

5173 前端的 Vite 代理默认指向 8001；访问 `/models` 可看到两个只读登记卡片。
