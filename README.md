# SecMind

## Test3.0 单题评测闭环

工作台支持两种运行方式：普通上传只生成安全分析报告；Test3.0 基准模式从服务端已注册的
S-Suite 题目中选择输入，并在 Agent 完成后异步调用独立评分器。浏览器只收到单题得分、
评分分量和脱敏 Markdown 报告，不会收到私有 Gold、私有目录或评分器日志。单题结果明确标记为
临时结果，不能当作 Full60 正式综合分。

本地接入可在 `.env` 中设置：

```dotenv
SECMIND_EVALUATION_ROOT=./data/evaluations
SECMIND_BENCHMARK_DATASET_ROOT=C:/path/to/01_候选可见题目/S-Suite_安全赛道/公开题目
SECMIND_BENCHMARK_PRIVATE_ROOT=C:/path/to/private-gold
SECMIND_BENCHMARK_SCORER_ROOT=C:/path/to/isolated-scorer
SECMIND_BENCHMARK_PYTHON_EXECUTABLE=C:/path/to/scorer-venv/Scripts/python.exe
```

生产部署应把公开题库与私有评分端分开挂载；当前 Docker Compose 只透传配置，不会把宿主机
评分器工作树自动打包进 API 镜像。

`SECMIND_BENCHMARK_DATASET_ROOT` 必须直接指向 S-Suite 的“公开题目”目录；不要指向同时包含
私有答案或 O-Suite 的发布包总目录。后端发现多个 S-Suite manifest 或目录配置错误时会安全拒绝注册。

SecMind 是面向“具备自主决策能力的通用网络安全智能体”赛题的 A 组 Agent 核心。当前版本完成第一条可运行基线：安全接收代码输入，使用监督式 LangGraph 规划并调用 Bandit，生成带证据引用的报告，同时将决策写入可验证的哈希链账本。

## 已实现能力

- LangGraph 监督式状态图：输入、分类、规划、校验、Guardrail、执行、分析、验证、报告和记忆门禁。
- R0-R3 分级自治与 `interrupt()` 人工审批恢复。
- 千问 OpenAI 兼容网关：结构化输出、超时重试、熔断、主备路由和确定性降级。
- 工具注册协议与 Bandit 适配器；工具参数被限制在任务工作区内。
- ZIP 路径穿越、软链接、数量、大小和压缩比检查。
- SQLite/PostgreSQL 运行快照、append-only 哈希账本、JSONL 导出和 WebSocket 事件。
- FastAPI 上传、任务、状态、报告、审批、账本和 WebSocket API。
- Docker Compose：API、PostgreSQL、Qdrant；API 使用非 root、只读文件系统和移除 Linux capabilities。

## 本地运行

```powershell
uv sync --all-extras
Copy-Item .env.example .env
uv run secmind-api
```

默认 `SECMIND_DEMO_MODE=true`，不需要模型密钥。访问 `http://127.0.0.1:8000/docs` 查看接口。

将待审计文件上传：

```powershell
curl.exe -F "file=@sample.py" http://127.0.0.1:8000/api/v1/uploads
```

把返回的 `ref` 放入任务：

```json
{
  "objective": "审计上传的 Python 代码并生成安全报告",
  "attachments": [{"ref": "上传接口返回的 ref"}],
  "target_scope": ["uploaded-source"],
  "constraints": ["只允许静态只读分析"],
  "expected_outputs": ["security_report"],
  "autonomy_policy": "graded"
}
```

提交到 `POST /api/v1/tasks`，再使用返回的 `run_id` 查询 `/api/v1/runs/{run_id}`、报告和账本。

## Docker Compose

## 前端

业务前端使用 `5173` 端口，后端 API 使用 `8000` 端口：

```powershell
Set-Location frontend
npm install
npm run dev
```

访问 `http://127.0.0.1:5173`。Vite 会把 REST 和 WebSocket 请求代理到 `127.0.0.1:8000`。

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

生产环境必须覆盖 `POSTGRES_PASSWORD`，并通过 Secret 管理 `SECMIND_QWEN_API_KEY`。具体模型 ID 和网关 Base URL 均为部署配置，不写死在业务代码中。

## 安全边界

当前唯一启用的执行工具是只读、幂等的 Bandit。它由 Tool Broker 调用，LLM 无法直接执行命令。Compose 把整个 API 置于受限容器中；未来接入 R2/R3 工具时，仍需为单次工具执行增加独立的临时容器运行器，不能仅依赖 API 容器隔离。

系统不记录隐藏思维链。审计依据由结构化决策摘要、策略编号、模型/Prompt 版本、工具版本、证据和内容哈希组成。

## 文档

- [架构与状态图](docs/architecture.md)
- [B/C 组接口契约](docs/contracts.md)
- [后续 Agent 工作包](docs/work-packages.md)

