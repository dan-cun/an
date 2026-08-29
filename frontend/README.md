# 安全智能体平台 Frontend

该前端为当前轻量 安全智能体平台 API 提供可视化交互、实时协作监测与安全分析任务管理。

## 端口

- 前端开发端口：`5173`
- 后端 API 端口：默认 `8000`（如使用 `8001`，需设置 `VITE_DEV_BACKEND_TARGET`）
- Vite 将 `/api`、`/health` 和 WebSocket 代理至后端。

## 启动

```powershell
npm install
npm run dev
```

如果后端使用 8001 端口，请在同一个 PowerShell 窗口执行：

```powershell
$env:VITE_DEV_BACKEND_TARGET="http://127.0.0.1:8001"
npm run dev
```

访问 <http://127.0.0.1:5173>。

## 已适配能力

- 多文件依次上传。
- 创建安全分析任务。
- 运行记录和状态进度。
- WebSocket 实时事件。
- 人工审批与拒绝。
- 安全报告和 Finding 详情。
- Ledger 浏览、哈希链状态和 JSONL 导出。

未显示 MCP、Prompt、Skill、模型管理和 GraphQL 页面，因为当前轻量后端尚未提供对应接口。
