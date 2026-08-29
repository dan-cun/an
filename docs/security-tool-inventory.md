# 本机安全工具展示清单

本清单来自本机安全工具清单和 `config/mcp-servers.json`。后端只读取清单，
不读取 API Key，不建立 MCP 连接，也不把条目交给 Agent 思考链。

## 展示范围

只展示本地只读分析或纯数据转换工具，共 5 个 Server、32 个工具：

- Semgrep：代码规则、静态扫描和 AST
- CyberChef：离线编码、解码和数据转换
- WireMCP：已有 PCAP 的离线统计、会话和解析
- Web Security：本地 Gitleaks、ExifTool 元数据和版本信息
- Security Extended：Trivy、OSV、YARA、Volatility、Ghidra、GDB、Binwalk、capa、FLOSS、oletools、checksec、ROPgadget、pwntools 等离线分析

主动网络探测、HTTP 抓取、浏览器控制、实时抓包和凭据提取不会出现在前端展示列表中：
`local-http-fetch`、`local-chrome-devtools` 及其高风险工具均被排除。

前端入口：

- `http://127.0.0.1:5173/mcp`
- 后端 `GET /api/v1/mcp/catalog`

返回中的 `runtime_enabled=false`、`invocation_enabled=false`、
`tool_registration=not_registered` 是固定安全闸门。后续如需接入，必须另行完成权限、审批、范围限制和隔离测试。
