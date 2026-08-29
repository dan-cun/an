from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict, cast
from uuid import uuid4

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from security_agent.agents import (
    AnalystAgent,
    PlannerAgent,
    ReporterAgent,
    TaskInterpreterAgent,
    VerifierAgent,
)
from security_agent.config import Settings
from security_agent.experience import ExperienceStore
from security_agent.guardrail import GuardrailAction
from security_agent.ingest import IngestError, InputIngestor
from security_agent.ledger import LedgerStore
from security_agent.llm import ModelGateway
from security_agent.schemas import (
    AgentState,
    ApprovalDecision,
    ApprovalRequest,
    ApprovalResponse,
    BudgetState,
    DecisionRecord,
    KnowledgeHit,
    RunStatus,
    TaskRequest,
    ToolContext,
    ToolStatus,
)
from security_agent.tools import ToolBroker


class GraphState(TypedDict, total=False):
    agent: dict[str, Any]
    route: str


Publisher = Callable[[dict[str, Any]], Awaitable[None] | None]


class SecurityOrchestrator:
    NODE_AGENTS = {
        "ingest": "interpreter",
        "classify": "interpreter",
        "retrieve_context": "interpreter",
        "plan": "planner",
        "validate_plan": "planner",
        "select_step": "planner",
        "guardrail": "planner",
        "approval": "planner",
        "record_denial": "planner",
        "execute": "analyst",
        "observe": "analyst",
        "analyze": "analyst",
        "verify": "verifier",
        "reflect": "verifier",
        "report": "reporter",
        "memory_commit": "reporter",
    }
    NODE_INSTRUCTIONS = {
        "ingest": "固化输入材料并建立可追溯清单",
        "classify": "识别任务场景与授权边界",
        "retrieve_context": "检索完成任务所需的受控知识上下文",
        "plan": "生成有界、可验证的执行计划",
        "validate_plan": "校验计划依赖、预算与工具可用性",
        "select_step": "选择下一项满足依赖的执行步骤",
        "guardrail": "评估工具风险、策略与审批要求",
        "approval": "等待并处理操作员审批指令",
        "record_denial": "记录拒绝原因并安全终止当前步骤",
        "execute": "按照授权参数调用受控安全工具",
        "observe": "将工具结果规范化为运行观测",
        "analyze": "从观测中提取 Finding 与 Evidence",
        "verify": "验证发现与证据引用是否完整闭合",
        "reflect": "依据失败观测制定一次有界重试",
        "report": "汇总已验证事实并生成安全报告",
        "memory_commit": "评估本次运行是否可进入长期记忆候选",
    }
    def __init__(
        self,
        settings: Settings,
        ledger: LedgerStore,
        gateway: ModelGateway,
        broker: ToolBroker,
        publisher: Publisher | None = None,
        experiences: ExperienceStore | None = None,
    ) -> None:
        self.settings = settings
        self.ledger = ledger
        self.gateway = gateway
        self.broker = broker
        self.publisher = publisher
        self.experiences = experiences
        self.ingestor = InputIngestor(settings)
        self.interpreter = TaskInterpreterAgent(gateway)
        self.planner = PlannerAgent(gateway)
        self.analyst = AnalystAgent(gateway)
        self.verifier = VerifierAgent(gateway)
        self.reporter = ReporterAgent(gateway)
        self.checkpointer = InMemorySaver()
        self.graph = self._build_graph().compile(checkpointer=self.checkpointer)

    def _build_graph(self) -> StateGraph:
        graph = StateGraph(GraphState)
        nodes = {
            "ingest": self._ingest,
            "classify": self._classify,
            "retrieve_context": self._retrieve_context,
            "plan": self._plan,
            "validate_plan": self._validate_plan,
            "select_step": self._select_step,
            "guardrail": self._guardrail,
            "approval": self._approval,
            "record_denial": self._record_denial,
            "execute": self._execute,
            "observe": self._observe,
            "analyze": self._analyze,
            "verify": self._verify,
            "reflect": self._reflect,
            "report": self._report,
            "memory_commit": self._memory_commit,
        }
        for name, node in nodes.items():
            graph.add_node(name, cast(Any, self._instrument(name, node)))

        graph.add_edge(START, "ingest")
        graph.add_edge("ingest", "classify")
        graph.add_edge("classify", "retrieve_context")
        graph.add_edge("retrieve_context", "plan")
        graph.add_edge("plan", "validate_plan")
        graph.add_conditional_edges(
            "validate_plan",
            lambda value: value.get("route", "select"),
            {"select": "select_step", "report": "report"},
        )
        graph.add_conditional_edges(
            "select_step",
            lambda value: value.get("route", "guardrail"),
            {"guardrail": "guardrail", "report": "report"},
        )
        graph.add_conditional_edges(
            "guardrail",
            lambda value: value.get("route", "execute"),
            {"execute": "execute", "approval": "approval", "deny": "record_denial"},
        )
        graph.add_conditional_edges(
            "approval",
            lambda value: value.get("route", "execute"),
            {"execute": "execute", "deny": "record_denial"},
        )
        graph.add_edge("record_denial", "report")
        graph.add_edge("execute", "observe")
        graph.add_edge("observe", "analyze")
        graph.add_edge("analyze", "verify")
        graph.add_conditional_edges(
            "verify",
            lambda value: value.get("route", "report"),
            {"next": "select_step", "reflect": "reflect", "report": "report"},
        )
        graph.add_edge("reflect", "select_step")
        graph.add_edge("report", "memory_commit")
        graph.add_edge("memory_commit", END)
        return graph

    def _instrument(self, name: str, node: Any) -> Any:
        async def instrumented(value: GraphState) -> GraphState:
            state = self._state(value)
            agent_id = self.NODE_AGENTS[name]
            instruction = self.NODE_INSTRUCTIONS[name]
            await self._event(
                state,
                "agent.started",
                {"agent_id": agent_id, "node": name, "instruction": instruction},
                actor=agent_id,
            )
            await self._event(
                state,
                "agent.instruction",
                {"agent_id": agent_id, "node": name, "content": instruction},
                actor="orchestrator",
            )
            decision_count = len(state.decisions)
            try:
                result = await node(value)
            except Exception as exc:
                await self._event(
                    state,
                    "agent.failed",
                    {"agent_id": agent_id, "node": name, "error_type": type(exc).__name__},
                    actor=agent_id,
                )
                raise
            next_state = self._state(result)
            if len(next_state.decisions) > decision_count:
                summary = next_state.decisions[-1].rationale_summary
            else:
                summary = self._public_summary(name, next_state)
            await self._event(
                next_state,
                "agent.thought",
                {"agent_id": agent_id, "node": name, "summary": summary},
                actor=agent_id,
            )
            await self._event(
                next_state,
                "agent.completed",
                {"agent_id": agent_id, "node": name, "status": next_state.status},
                actor=agent_id,
            )
            return result

        return instrumented

    @staticmethod
    def _public_summary(node: str, state: AgentState) -> str:
        summaries = {
            "ingest": f"已登记 {len(state.input_artifacts)} 个输入材料。",
            "validate_plan": "计划结构、依赖与预算校验已完成。",
            "select_step": f"当前执行步骤索引为 {state.current_step_index}。",
            "execute": f"受控工具调用累计 {state.budget.tool_calls_used} 次。",
            "observe": "工具输出已转换为可审计观测。",
            "analyze": f"已形成 {len(state.findings)} 个发现与 {len(state.evidence)} 条证据。",
            "verify": "发现与证据引用校验已完成。",
            "report": "报告已根据可验证事实生成。",
            "memory_commit": "记忆候选资格评估已完成。",
        }
        return summaries.get(node, "当前节点已完成可审计处理。")

    async def start(self, task: TaskRequest, run_id: str | None = None) -> AgentState:
        actual_run_id = run_id or str(uuid4())
        state = AgentState(
            run_id=actual_run_id,
            task=task,
            budget=BudgetState(
                max_steps=self.settings.max_steps,
                max_tool_calls=self.settings.max_tool_calls,
                max_model_calls=self.settings.max_model_calls,
                max_runtime_seconds=self.settings.max_runtime_seconds,
            ),
        )
        self.ledger.save_state(state)
        await self._event(state, "run.created", {"objective": task.objective})
        return await self._invoke({"agent": state.model_dump(mode="json")}, actual_run_id)

    async def resume(self, run_id: str, response: ApprovalResponse) -> AgentState:
        config = {"configurable": {"thread_id": run_id}}
        try:
            result = await self.graph.ainvoke(Command(resume=response.model_dump(mode="json")), cast(Any, config))
            return self._state(cast(GraphState, result))
        except Exception:
            state = self.ledger.load_state(run_id)
            if state is None or state.pending_approval is None:
                raise
            state.approvals.append(
                {
                    "request_id": state.pending_approval.request_id,
                    "step_id": state.pending_approval.step_id,
                    **response.model_dump(mode="json"),
                }
            )
            if response.decision == ApprovalDecision.DENY:
                state.status = RunStatus.DENIED
            elif response.decision == ApprovalDecision.EDIT and response.edited_parameters is not None:
                state.plan[state.current_step_index].inputs = response.edited_parameters
                state.status = RunStatus.RUNNING
            else:
                state.status = RunStatus.RUNNING
            state.pending_approval = None
            self.ledger.save_state(state)
            await self._event(state, "approval.recovered", response.model_dump(mode="json"))
            return await self._invoke({"agent": state.model_dump(mode="json")}, run_id)

    async def recover(self, run_id: str) -> AgentState:
        state = self.ledger.load_state(run_id)
        if state is None:
            raise KeyError(run_id)
        if state.status == RunStatus.WAITING_APPROVAL:
            return state
        return await self._invoke({"agent": state.model_dump(mode="json")}, run_id)

    async def _invoke(self, input_value: GraphState | Command, run_id: str) -> AgentState:
        result = await self.graph.ainvoke(
            input_value,
            {"configurable": {"thread_id": run_id}, "recursion_limit": self.settings.max_steps * 4},
        )
        state = self._state(cast(GraphState, result))
        self.ledger.save_state(state)
        return state

    @staticmethod
    def _state(value: GraphState) -> AgentState:
        return AgentState.model_validate(value["agent"])

    async def _checkpoint(
        self, state: AgentState, event_type: str, payload: dict[str, Any], route: str | None = None
    ) -> GraphState:
        self.ledger.save_state(state)
        await self._event(state, event_type, payload)
        result: GraphState = {"agent": state.model_dump(mode="json")}
        if route is not None:
            result["route"] = route
        return result

    async def _event(
        self,
        state: AgentState,
        event_type: str,
        payload: dict[str, Any],
        actor: str = "system",
    ) -> None:
        event = self.ledger.append(state.run_id, event_type, payload, actor=actor)
        if self.publisher is not None:
            result = self.publisher(event.model_dump(mode="json"))
            if inspect.isawaitable(result):
                await result

    async def _ingest(self, value: GraphState) -> GraphState:
        state = self._state(value)
        state.status = RunStatus.RUNNING
        if not state.workspace:
            try:
                workspace, artifacts = self.ingestor.ingest(state.run_id, state.task.attachments)
                state.workspace = str(workspace)
                state.input_artifacts = artifacts
            except IngestError as exc:
                state.status = RunStatus.FAILED
                state.last_error = str(exc)
        return await self._checkpoint(
            state,
            "input.ingested",
            {
                "artifact_count": len(state.input_artifacts),
                "artifact_hashes": [item.sha256 for item in state.input_artifacts],
                "error": state.last_error,
            },
        )

    async def _classify(self, value: GraphState) -> GraphState:
        state = self._state(value)
        async def observe_stream(event_type: str, payload: dict[str, Any]) -> None:
            await self._event(state, event_type, payload, actor="llm_provider")

        state = await self.interpreter.run(state, stream_observer=observe_stream)
        return await self._checkpoint(state, "scenario.classified", {"scenario": state.scenario, "module": state.module_route, "routing": state.routing})

    async def _retrieve_context(self, value: GraphState) -> GraphState:
        state = self._state(value)
        records = self.experiences.search(state.module_route, state.task.objective, top_k=5) if self.experiences else []
        state.knowledge_hits = [
            KnowledgeHit(
                memory_id=item["experience_id"],
                content=item["summary"],
                source=item["source_title"],
                version="experience-v1",
                confidence=item["confidence"],
                metadata={
                    "kind": item["experience_kind"],
                    "module_route": item["module_route"],
                    "source_run_id": item["source_run_id"],
                },
            )
            for item in records
        ]
        state.decisions.append(
            DecisionRecord(
                decision="knowledge_context_retrieved" if records else "knowledge_context_empty",
                rationale_summary=(
                    f"已检索 {len(records)} 条同模块已验证经验，供规划节点参考。"
                    if records
                    else "当前经验库中没有可引用的同模块已验证经验。"
                ),
                policy_ids=["RAG-CITATION-V1"],
                model_id="deterministic-retriever",
            )
        )
        return await self._checkpoint(
            state,
            "knowledge.retrieved",
            {"hit_count": len(records), "experience_ids": [item["experience_id"] for item in records]},
        )

    async def _plan(self, value: GraphState) -> GraphState:
        state = self._state(value)
        if not state.plan:
            async def observe_stream(event_type: str, payload: dict[str, Any]) -> None:
                await self._event(state, event_type, payload, actor="llm_provider")

            state = await self.planner.run(state, stream_observer=observe_stream)
        return await self._checkpoint(
            state, "plan.created", {"steps": [item.model_dump(mode="json") for item in state.plan]}
        )

    async def _validate_plan(self, value: GraphState) -> GraphState:
        state = self._state(value)
        if state.status == RunStatus.FAILED:
            return await self._checkpoint(state, "plan.skipped", {"reason": state.last_error}, "report")
        errors: list[str] = []
        identifiers = [step.step_id for step in state.plan]
        if len(identifiers) != len(set(identifiers)):
            errors.append("Plan step identifiers must be unique")
        if len(state.plan) > state.budget.max_steps:
            errors.append("Plan exceeds step budget")
        known_tools = {item.name for item in self.broker.registry.manifests()}
        for step in state.plan:
            if not set(step.dependencies).issubset(set(identifiers)):
                errors.append(f"Unknown dependency in {step.step_id}")
            if not set(step.tool_candidates).issubset(known_tools):
                errors.append(f"Unknown tool in {step.step_id}")
        if errors:
            state.status = RunStatus.FAILED
            state.last_error = "; ".join(errors)
        route = "select" if state.plan and not errors else "report"
        return await self._checkpoint(state, "plan.validated", {"errors": errors}, route)

    async def _select_step(self, value: GraphState) -> GraphState:
        state = self._state(value)
        if state.current_step_index >= len(state.plan):
            return await self._checkpoint(state, "step.selection_complete", {}, "report")
        if state.budget.steps_used >= state.budget.max_steps:
            state.status = RunStatus.PARTIAL
            state.last_error = "执行步骤预算已耗尽"
            return await self._checkpoint(state, "budget.exhausted", {"budget": "steps"}, "report")
        state.budget.steps_used += 1
        step = state.plan[state.current_step_index]
        return await self._checkpoint(
            state, "step.selected", {"step_id": step.step_id, "index": state.current_step_index}, "guardrail"
        )

    async def _guardrail(self, value: GraphState) -> GraphState:
        state = self._state(value)
        step = state.plan[state.current_step_index]
        if not step.tool_candidates:
            state.status = RunStatus.FAILED
            state.last_error = "所选执行步骤没有可用工具"
            return await self._checkpoint(state, "guardrail.denied", {"reason": state.last_error}, "deny")
        tool_name = step.tool_candidates[0]
        approved = next(
            (
                item
                for item in reversed(state.approvals)
                if item.get("step_id") == step.step_id
                and item.get("decision") in {ApprovalDecision.APPROVE.value, ApprovalDecision.EDIT.value}
            ),
            None,
        )
        decision = self.broker.assess(tool_name, step.inputs, state.task.autonomy_policy)
        state.decisions.append(
            DecisionRecord(
                decision=f"guardrail={decision.action.value}",
                rationale_summary=decision.reason,
                policy_ids=list(decision.policy_ids),
                model_id="deterministic-guardrail",
            )
        )
        if decision.action == GuardrailAction.DENY:
            state.status = RunStatus.DENIED
            route = "deny"
        elif decision.action == GuardrailAction.REQUIRE_APPROVAL and approved is None:
            state.status = RunStatus.WAITING_APPROVAL
            state.pending_approval = ApprovalRequest(
                run_id=state.run_id,
                step_id=step.step_id,
                tool_name=tool_name,
                parameters=step.inputs,
                target=str(step.inputs.get("target", state.workspace)),
                risk_level=decision.risk_level,
                reason=decision.reason,
                expected_impact="Execute one bounded tool call inside the controlled workspace.",
            )
            route = "approval"
        else:
            route = "execute"
        return await self._checkpoint(
            state,
            "guardrail.evaluated",
            {
                "step_id": step.step_id,
                "action": decision.action,
                "risk_level": decision.risk_level,
                "policy_ids": decision.policy_ids,
            },
            route,
        )

    async def _approval(self, value: GraphState) -> GraphState:
        state = self._state(value)
        if state.pending_approval is None:
            state.status = RunStatus.FAILED
            state.last_error = "进入审批节点时不存在待处理的审批请求"
            return await self._checkpoint(state, "approval.invalid", {}, "deny")
        self.ledger.save_state(state)
        await self._event(state, "approval.requested", state.pending_approval.model_dump(mode="json"))
        raw_response = interrupt(state.pending_approval.model_dump(mode="json"))
        response = ApprovalResponse.model_validate(raw_response)
        pending = state.pending_approval
        state.approvals.append(
            {
                "request_id": pending.request_id,
                "step_id": pending.step_id,
                **response.model_dump(mode="json"),
            }
        )
        state.pending_approval = None
        if response.decision == ApprovalDecision.DENY:
            state.status = RunStatus.DENIED
            route = "deny"
        else:
            if response.decision == ApprovalDecision.EDIT and response.edited_parameters is not None:
                state.plan[state.current_step_index].inputs = response.edited_parameters
            state.status = RunStatus.RUNNING
            route = "execute"
        return await self._checkpoint(state, "approval.resolved", response.model_dump(mode="json"), route)

    async def _record_denial(self, value: GraphState) -> GraphState:
        state = self._state(value)
        if state.status != RunStatus.FAILED:
            state.status = RunStatus.DENIED
        return await self._checkpoint(
            state, "step.denied", {"step_index": state.current_step_index, "error": state.last_error}
        )

    async def _execute(self, value: GraphState) -> GraphState:
        state = self._state(value)
        if state.budget.tool_calls_used >= state.budget.max_tool_calls:
            state.status = RunStatus.PARTIAL
            state.last_error = "工具调用预算已耗尽"
            return await self._checkpoint(state, "budget.exhausted", {"budget": "tools"})
        step = state.plan[state.current_step_index]
        tool_name = step.tool_candidates[0]
        state.budget.tool_calls_used += 1
        await self._event(
            state,
            "tool.started",
            {
                "tool": tool_name,
                "tool_version": self.broker.registry.get(tool_name).manifest.version,
                "args": step.inputs,
            },
        )
        result = await self.broker.invoke(
            tool_name,
            step.inputs,
            ToolContext(
                run_id=state.run_id,
                step_id=step.step_id,
                workspace=state.workspace,
                allowed_paths=[state.workspace],
                module_base_url=(self.settings.reverse_base_url if state.module_route == "reverse" else self.settings.penetration_base_url if state.module_route == "penetration" else None),
                task_objective=state.task.objective,
                target_scope=list(state.task.target_scope),
                input_artifacts=list(state.input_artifacts),
            ),
        )
        state.observations.append(result)
        return await self._checkpoint(
            state,
            "tool.completed",
            {
                "tool": tool_name,
                "status": result.status,
                "duration_ms": result.duration_ms,
                "evidence_ids": [item.evidence_id for item in result.evidence],
                "error_code": result.error_code,
                "coverage": result.data.get("coverage"),
                "module_route": state.module_route,
                "project_id": result.data.get("project_id"),
            },
        )

    async def _observe(self, value: GraphState) -> GraphState:
        state = self._state(value)
        latest = state.observations[-1]
        return await self._checkpoint(
            state, "observation.recorded", {"status": latest.status, "summary": latest.summary}
        )

    async def _analyze(self, value: GraphState) -> GraphState:
        state = self._state(value)
        async def observe_stream(event_type: str, payload: dict[str, Any]) -> None:
            await self._event(state, event_type, payload, actor="llm_provider")

        state = await self.analyst.run(state, stream_observer=observe_stream)
        return await self._checkpoint(
            state,
            "analysis.completed",
            {"finding_count": len(state.findings), "evidence_count": len(state.evidence)},
        )

    async def _verify(self, value: GraphState) -> GraphState:
        state = await self.verifier.run(self._state(value))
        step = state.plan[state.current_step_index]
        latest = state.observations[-1]
        if latest.status == ToolStatus.SUCCESS and state.last_error is None:
            state.current_step_index += 1
            route = "next" if state.current_step_index < len(state.plan) else "report"
        else:
            attempts = state.retry_counts.get(step.step_id, 0)
            if attempts + 1 < step.max_attempts and state.budget.steps_used < state.budget.max_steps:
                route = "reflect"
            else:
                state.status = RunStatus.PARTIAL
                route = "report"
        return await self._checkpoint(
            state,
            "verification.completed",
            {"step_id": step.step_id, "route": route, "error": state.last_error},
            route,
        )

    async def _reflect(self, value: GraphState) -> GraphState:
        state = self._state(value)
        step = state.plan[state.current_step_index]
        state.retry_counts[step.step_id] = state.retry_counts.get(step.step_id, 0) + 1
        state.last_error = None
        state.decisions.append(
            DecisionRecord(
                decision="retry_step",
                rationale_summary="受控工具调用失败，且仍有剩余重试次数。",
                policy_ids=["RETRY-IDEMPOTENT-V1"],
                model_id="deterministic-reflector",
            )
        )
        return await self._checkpoint(
            state, "reflection.completed", {"step_id": step.step_id, "retry": state.retry_counts[step.step_id]}
        )

    async def _report(self, value: GraphState) -> GraphState:
        state = self._state(value)
        async def observe_stream(event_type: str, payload: dict[str, Any]) -> None:
            await self._event(state, event_type, payload, actor="llm_provider")

        state = await self.reporter.run(state, stream_observer=observe_stream)
        payload = {
            "status": state.status,
            "finding_count": len(state.findings),
            "evidence_count": len(state.evidence),
        }
        return await self._checkpoint(state, "report.generated", payload)

    async def _memory_commit(self, value: GraphState) -> GraphState:
        state = self._state(value)
        record = None
        error = None
        if self.experiences is not None:
            try:
                record = self.experiences.capture_run(
                    state,
                    self.ledger.events(state.run_id, limit=1_000_000),
                    chain_valid=self.ledger.verify(state.run_id),
                )
            except Exception as exc:
                error = f"经验写入失败：{type(exc).__name__}"
        accepted = record is not None
        payload = {
            "accepted": accepted,
            "experience_id": record["experience_id"] if record else None,
            "experience_kind": record["experience_kind"] if record else None,
            "reason": (
                "已提取、脱敏并写入结构化经验库。"
                if accepted
                else error or "当前任务状态不满足经验提取条件。"
            ),
        }
        return await self._checkpoint(state, "memory.candidate", payload)
