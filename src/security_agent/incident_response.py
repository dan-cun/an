from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


def _now() -> str:
    return datetime.now(UTC).isoformat()


class IncidentManager:
    """Local, auditable incident-response workflow used by the operations UI.

    The manager deliberately models commands instead of running arbitrary shell
    input. Read-only monitoring is automatic; state-changing actions are queued
    for approval and only simulated after an operator approves them.
    """

    def __init__(self) -> None:
        self.running = False
        self.started_at: str | None = None
        self.last_scan_at: str | None = None
        self._sequence = 0
        self._logs: deque[dict[str, Any]] = deque(maxlen=500)
        self._actions: deque[dict[str, Any]] = deque(maxlen=200)
        self._approvals: dict[str, dict[str, Any]] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._monitor_task: asyncio.Task[Any] | None = None
        self._lock = asyncio.Lock()

    @staticmethod
    def command_catalog() -> list[dict[str, Any]]:
        return [
            {
                "id": "monitoring",
                "label": "实时监测命令",
                "description": "读取本地测试环境的资产、进程与威胁指标",
                "commands": [
                    {"value": "scan_assets", "label": "立即扫描本地资产", "risk_level": 0},
                    {"value": "inspect_processes", "label": "检查进程与服务", "risk_level": 0},
                    {"value": "collect_indicators", "label": "采集威胁指标", "risk_level": 0},
                    {"value": "refresh_baseline", "label": "刷新资产基线", "risk_level": 0},
                ],
            },
            {
                "id": "response",
                "label": "应急处置命令",
                "description": "对告警进行证据保全、遏制与恢复操作",
                "commands": [
                    {"value": "collect_evidence", "label": "收集事件证据", "risk_level": 0},
                    {"value": "isolate_sample", "label": "隔离可疑样本", "risk_level": 2},
                    {"value": "block_indicator", "label": "阻断威胁指标", "risk_level": 2},
                    {"value": "restore_snapshot", "label": "从良好副本恢复", "risk_level": 2},
                ],
            },
        ]

    def snapshot(self) -> dict[str, Any]:
        pending = [item for item in self._approvals.values() if item["status"] == "pending"]
        return {
            "schema_version": "1.0",
            "running": self.running,
            "started_at": self.started_at,
            "last_scan_at": self.last_scan_at,
            "pending_approvals": len(pending),
            "active_phase": "continuous_monitoring" if self.running else "idle",
            "safe_mode": True,
        }

    def logs(self, limit: int = 100) -> list[dict[str, Any]]:
        return list(self._logs)[-limit:][::-1]

    def actions(self, limit: int = 100) -> list[dict[str, Any]]:
        return list(self._actions)[-limit:][::-1]

    def approvals(self, limit: int = 100) -> list[dict[str, Any]]:
        values = list(self._approvals.values())[-limit:]
        return values[::-1]

    async def start(self) -> dict[str, Any]:
        if self.running:
            return self.snapshot()
        self.running = True
        self.started_at = _now()
        self.last_scan_at = None
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        await self._record("monitor.started", "监测模型已启动，进入连续监测", "info", "监测")
        return self.snapshot()

    async def stop(self) -> dict[str, Any]:
        self.running = False
        task = self._monitor_task
        self._monitor_task = None
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._record("monitor.stopped", "监测模型已停止", "info", "监测")
        return self.snapshot()

    async def shutdown(self) -> None:
        await self.stop()

    async def submit_command(self, command: str, target: str = "测试环境", reason: str = "") -> dict[str, Any]:
        normalized = command.strip()
        if not normalized:
            raise ValueError("command must not be empty")
        # Commands are labels for the safe action registry, never shell text.
        safe_commands = {
            item["value"]: (item["label"], item["risk_level"])
            for group in self.command_catalog()
            for item in group["commands"]
        }
        command_group = next(
            (group["id"] for group in self.command_catalog() if any(item["value"] == normalized for item in group["commands"])),
            "custom",
        )
        label, risk = safe_commands.get(normalized, (normalized[:80], 2))
        action = {
            "action_id": str(uuid4()),
            "command": normalized,
            "label": label,
            "target": target or "测试环境",
            "reason": reason,
            "risk_level": risk,
            "command_group": command_group,
            "status": "awaiting_approval" if risk >= 2 else "queued",
            "created_at": _now(),
        }
        self._actions.append(action)
        if risk >= 2:
            approval = {
                "approval_id": str(uuid4()),
                "action_id": action["action_id"],
                "command": label,
                "target": action["target"],
                "risk_level": risk,
                "reason": reason or "状态变更动作需要人工确认",
                "status": "pending",
                "created_at": _now(),
            }
            self._approvals[approval["approval_id"]] = approval
            await self._record("approval.requested", f"命令“{label}”等待审批", "warning", "审批", approval)
            return {"schema_version": "1.0", "action": action, "approval": approval}
        await self._record("action.queued", f"只读动作“{label}”已加入队列", "info", "应急处理", action)
        await self._execute(action)
        return {"schema_version": "1.0", "action": action, "approval": None}

    async def resolve_approval(self, approval_id: str, decision: str, note: str = "") -> dict[str, Any]:
        approval = self._approvals.get(approval_id)
        if approval is None:
            raise KeyError(approval_id)
        if approval["status"] != "pending":
            raise ValueError("approval is already resolved")
        if decision not in {"approve", "deny"}:
            raise ValueError("decision must be approve or deny")
        approval["status"] = "approved" if decision == "approve" else "denied"
        approval["resolved_at"] = _now()
        approval["note"] = note
        action = next((item for item in self._actions if item["action_id"] == approval["action_id"]), None)
        if action:
            action["status"] = "approved" if decision == "approve" else "denied"
        await self._record(
            "approval.resolved",
            f"审批已{('通过' if decision == 'approve' else '拒绝')}：{approval['command']}",
            "success" if decision == "approve" else "warning",
            "审批",
            approval,
        )
        if decision == "approve" and action:
            await self._execute(action)
        return {"schema_version": "1.0", "approval": approval, "action": action}

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def _monitor_loop(self) -> None:
        try:
            while self.running:
                await asyncio.sleep(5)
                if not self.running:
                    break
                self.last_scan_at = _now()
                await self._record(
                    "monitor.scan",
                    "完成本地资产、进程与指标巡检，未发现新增异常",
                    "info",
                    "监测",
                    {"scope": "local-test-environment"},
                )
        except asyncio.CancelledError:
            raise

    async def _execute(self, action: dict[str, Any]) -> None:
        action["status"] = "completed"
        action["completed_at"] = _now()
        await self._record("action.completed", f"已完成：{action['label']}（模拟执行）", "success", "应急处理", action)

    async def _record(
        self,
        event_type: str,
        message: str,
        level: str,
        phase: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self._sequence += 1
        event = {
            "sequence": self._sequence,
            "event_type": event_type,
            "message": message,
            "level": level,
            "phase": phase,
            "timestamp": _now(),
            "payload": payload or {},
        }
        self._logs.append(event)
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait({"type": "incident.event", "payload": event})
