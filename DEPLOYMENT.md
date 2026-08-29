# 部署与首次启动指南

本文适用于本项目的测试环境部署。所有上传文件、任务和应急响应动作都应限制在已授权的本地测试环境。

## 1. 运行组件和端口

| 组件 | 本地开发 | Docker Compose | 说明 |
| --- | ---: | ---: | --- |
| API | `127.0.0.1:8001` | `127.0.0.1:8000` | REST、WebSocket、应急响应接口 |
| 前端 | `127.0.0.1:5173` | `127.0.0.1:5173` | Vite 或 Nginx |
| 逆向模块 | `127.0.0.1:8002` | 外部配置 | 可选，未启动时仍可使用其他模块 |
| 渗透模块 | `127.0.0.1:8011` | 外部配置 | 必须是授权的测试环境服务 |
| PostgreSQL | - | Compose 内部 | 生产/持久化运行记录 |
| Qdrant | - | Compose 内部 | 可选知识检索存储 |

应急响应模块已融合到 API 内部，不需要另行启动独立服务。API 启动时会自动进入安全的本地连续监测，动作执行默认为模拟模式。

## 2. Windows 首次启动（推荐）

准备：Windows PowerShell、Python 3.11–3.13、`uv`、Node.js 20+。

```powershell
Set-Location C:\kaifa\tool\my-competition-secmind-baseline-f606c48

# 第一次运行时同步 Python 依赖并创建 data 目录
uv sync --all-extras
Copy-Item .env.example .env

# 启动后端（默认使用 SQLite 和 DEMO 模式，不需要 API Key）
$env:SECURITY_AGENT_API_PORT = "8001"
$env:SECURITY_AGENT_DEMO_MODE = "true"
uv run security-agent-api
```

另开一个 PowerShell 窗口启动前端：

```powershell
Set-Location C:\kaifa\tool\my-competition-secmind-baseline-f606c48\frontend
npm ci
npm run dev
```

访问：

- 前端工作台：http://127.0.0.1:5173
- 应急响应：http://127.0.0.1:5173/incident-response
- API 文档：http://127.0.0.1:8001/docs
- 健康检查：http://127.0.0.1:8001/health

如果端口被占用，先使用 `netstat -ano | Select-String ':8001|:5173'` 查找 PID，停止旧的同项目进程，或修改端口并同步修改 `frontend/vite.config.js` 的 `VITE_DEV_BACKEND_TARGET`。

## 3. 环境变量

`.env.example` 是完整模板。变量前缀统一为 `SECURITY_AGENT_`，不要把真实密钥提交到 Git。

### 基础运行

- `SECURITY_AGENT_ENV`：`development` 或 `production`。
- `SECURITY_AGENT_API_PORT`：本地 API 端口，默认 `8001`。
- `SECURITY_AGENT_DEMO_MODE`：`true` 使用确定性演示降级，不调用模型；`false` 才使用模型网关。
- `SECURITY_AGENT_DATABASE_URL`：默认 `sqlite:///./data/security_agent.db`，Compose 使用 PostgreSQL 地址。
- `SECURITY_AGENT_INPUT_ROOT`、`UPLOAD_ROOT`、`RUN_ROOT`、`EVALUATION_ROOT`：数据目录。

### 模型网关（需要真实模型时）

- `SECURITY_AGENT_MODEL_BASE_URL`：绝对 HTTP/HTTPS Base URL，例如 `https://api.deepseek.com`（不要加 Markdown 方括号、查询参数或 `/chat/completions`）。
- `SECURITY_AGENT_MODEL_API_KEY`：模型服务密钥，只通过本机 `.env`、系统环境变量或 Secret 注入。
- `SECURITY_AGENT_PLANNER_MODEL`、`WORKER_MODEL`、`FALLBACK_MODEL`：服务端实际可用的模型 ID。
- `SECURITY_AGENT_EMBEDDING_MODEL`：知识检索使用的 embedding 模型。

关闭 DEMO 时，先确认 Base URL 和模型 ID 可用：

```powershell
$env:SECURITY_AGENT_DEMO_MODE = "false"
$env:SECURITY_AGENT_MODEL_BASE_URL = "https://api.deepseek.com"
$env:SECURITY_AGENT_MODEL_API_KEY = "在本机设置，不要提交到仓库"
$env:SECURITY_AGENT_PLANNER_MODEL = "实际可用的模型ID"
$env:SECURITY_AGENT_WORKER_MODEL = "实际可用的模型ID"
$env:SECURITY_AGENT_FALLBACK_MODEL = "实际可用的模型ID"
```

### 外部模块

- `SECURITY_AGENT_REVERSE_BASE_URL`：逆向服务地址，默认 `http://127.0.0.1:8002`。
- `SECURITY_AGENT_PENETRATION_BASE_URL`：渗透服务地址，默认 `http://127.0.0.1:8011`。
- `SECURITY_AGENT_MODULE_TIMEOUT_SECONDS`：外部模块请求超时。

外部模块必须先独立启动并确认 `/health/live` 或项目提供的健康接口可访问；不配置时，代码审计和应急响应仍可运行。

### 评测题库（可选）

只有执行基准评测时才需要配置：

- `SECURITY_AGENT_BENCHMARK_DATASET_ROOT`：公开题目目录。
- `SECURITY_AGENT_BENCHMARK_PRIVATE_ROOT`：私有 Gold 目录，不放进镜像。
- `SECURITY_AGENT_BENCHMARK_SCORER_ROOT`：隔离评分器目录。
- `SECURITY_AGENT_BENCHMARK_PYTHON_EXECUTABLE`：评分器虚拟环境 Python 路径。

## 4. Docker Compose 首次启动

准备 Docker Desktop（启用 Linux containers）：

```powershell
Set-Location C:\kaifa\tool\my-competition-secmind-baseline-f606c48
Copy-Item .env.example .env

# 可选：修改 .env 中的 POSTGRES_PASSWORD 和模型变量
docker compose build
docker compose up -d
docker compose ps
```

访问 `http://127.0.0.1:5173`。API 在 `http://127.0.0.1:8000/docs`，前端 Nginx 会把 `/api` 和 `/health` 代理到 API 容器。

查看日志：

```powershell
docker compose logs -f api
docker compose logs -f frontend
```

停止但保留数据：`docker compose down`。
如需删除 Compose 数据卷（会删除数据库、运行记录和 Qdrant 数据），先确认数据已备份，再执行 `docker compose down -v`。

## 5. 应急响应模块使用

进入“安全运营 → 应急响应”后：

1. 查看顶部监测状态，API 启动后默认是 `MONITORING`。
2. “监测日志”会显示每 5 秒一次的本地测试环境巡检事件。
3. “命令面板”中的只读动作会直接模拟完成。
4. 隔离、阻断、恢复等状态变更动作会进入“需要审批命令”。
5. 点击“批准”或“拒绝”完成闭环，所有动作保留在内存事件日志中。

当前实现不会调用任意 Shell，也不会对真实生产资产执行隔离、阻断或恢复。接入真实执行器前，必须增加独立沙箱、授权校验、审计持久化和人工审批策略。

## 6. 发布前检查

```powershell
Set-Location C:\kaifa\tool\my-competition-secmind-baseline-f606c48
uv run pytest -q
uv run ruff check src
Set-Location frontend
npm test -- --run
npm run build
```

提交前确认：`.env`、`data/`、`.venv/`、`frontend/node_modules/` 和任何密钥文件均未进入 Git。
