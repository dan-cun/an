from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel

from secmind.llm import QwenGateway, StreamObserver
from secmind.fusion import classify_task
from secmind.schemas import (
    AgentReport,
    AgentState,
    DecisionRecord,
    Finding,
    PlanStep,
    RiskLevel,
    RunStatus,
    Scenario,
    ToolStatus,
)


class PlanOutput(BaseModel):
    steps: list[PlanStep]
    rationale_summary: str


class BaseAgent(ABC):
    """Base class for bounded specialist nodes controlled by the orchestrator."""

    name: str
    model_role: str = "worker"
    prompt_version: str = "v1"
    max_react_rounds: int = 3

    def __init__(self, gateway: QwenGateway) -> None:
        self.gateway = gateway

    @abstractmethod
    async def run(self, state: AgentState) -> AgentState:
        raise NotImplementedError


class TaskInterpreterAgent(BaseAgent):
    name = "task_interpreter"

    async def run(self, state: AgentState) -> AgentState:
        routing = classify_task(state.task.objective, state.input_artifacts)
        scenario = routing.pop("scenario")
        state.routing = routing
        state.module_route = routing["primary_type"]
        state.scenario = scenario
        state.decisions.append(
            DecisionRecord(
                decision=f"scenario={scenario.value}",
                rationale_summary=f"已识别为{state.module_route}模块，置信度 {routing['confidence']}；依据：{'、'.join(routing['evidence']) or '无明确关键词，采用安全默认路由'}。",
                policy_ids=["ROUTE-SCENARIO-V1"],
                model_id="deterministic-router",
                prompt_version=self.prompt_version,
            )
        )
        return state


class PlannerAgent(BaseAgent):
    name = "planner"
    model_role = "planner"

    @staticmethod
    def _normalize_code_audit_plan(
        output: PlanOutput, state: AgentState, fallback: PlanOutput
    ) -> PlanOutput:
        """Project model output onto the executable MVP tool contract.

        Analysis, verification, and reporting are fixed graph nodes, not tool steps.  The
        model may describe them in its response, but only one registered Bandit step is
        admitted to the execution graph.
        """
        supported_tools = {"workspace_security_audit", "bandit_python_audit"}
        selected = next(
            (step for step in output.steps if set(step.tool_candidates) & supported_tools),
            None,
        )
        if selected is None:
            selected = fallback.steps[0]

        artifact_paths = {item.relative_path for item in state.input_artifacts}
        artifact_by_name = {
            item.relative_path.rsplit("/", 1)[-1]: item.relative_path
            for item in state.input_artifacts
        }
        requested_target = selected.inputs.get("target", selected.inputs.get("target_file", "."))
        requested_target = str(requested_target).replace("\\", "/").strip()
        common_parent = "."
        if len(artifact_paths) > 1:
            parents = {path.rsplit("/", 1)[0] if "/" in path else "." for path in artifact_paths}
            if len(parents) == 1:
                common_parent = parents.pop()

        # A model may select only the first file from a multi-file case.  A
        # benchmark task must be audited as one immutable input set, so keep
        # the target at the shared case directory when one exists.
        if len(artifact_paths) > 1:
            target = common_parent
        elif requested_target in artifact_paths:
            target = requested_target
        elif requested_target.rsplit("/", 1)[-1] in artifact_by_name:
            target = artifact_by_name[requested_target.rsplit("/", 1)[-1]]
        else:
            target = "."

        normalized_step = selected.model_copy(
            update={
                "dependencies": [],
                "tool_candidates": ["workspace_security_audit"],
                "inputs": {"target": target},
                "risk_hint": RiskLevel.R1,
            }
        )
        return PlanOutput(
            steps=[normalized_step],
            rationale_summary=output.rationale_summary,
        )

    async def run(
        self, state: AgentState, stream_observer: StreamObserver | None = None
    ) -> AgentState:
        if state.scenario == Scenario.REVERSE_TRIAGE:
            state.plan = [PlanStep(step_id="reverse-triage", objective="对二进制样本执行只读结构与字符串分析。", agent_role="reverse", tool_candidates=["reverse_module"], inputs={"target": "."}, success_criteria=["生成结构化逆向证据"], risk_hint=RiskLevel.R1)]
            state.decisions.append(DecisionRecord(decision="plan_created", rationale_summary="使用逆向模块进行 PE/ELF 只读分析。", policy_ids=["PLAN-REVERSE-V1"], model_id="deterministic-planner"))
            return state
        if state.scenario == Scenario.PENETRATION_TEST:
            target = next(
                (scope for scope in state.task.target_scope if scope.startswith(("http://", "https://"))),
                ".",
            )
            state.plan = [PlanStep(step_id="penetration-assessment", objective="在授权测试环境中提交渗透任务至 Cairn 黑板。", agent_role="penetration", tool_candidates=["penetration_module"], inputs={"target": target}, success_criteria=["获得黑板任务回执或明确不可用状态"], risk_hint=RiskLevel.R2)]
            state.decisions.append(DecisionRecord(decision="plan_created", rationale_summary="使用 Cairn 渗透模块适配器，受审批策略约束。", policy_ids=["PLAN-PENETRATION-V1"], model_id="deterministic-planner"))
            return state
        if state.scenario != Scenario.CODE_AUDIT:
            state.plan = []
            state.decisions.append(DecisionRecord(decision="no_supported_plan", rationale_summary="当前场景暂未配置可执行模块。", policy_ids=["SCOPE-MVP-V1"], model_id="deterministic-planner"))
            return state
        default = PlanOutput(
            steps=[
                PlanStep(
                    step_id="audit-python-bandit",
                    objective="对受控工作区中的源码和配置执行只读安全审计。",
                    agent_role="executor",
                    tool_candidates=["workspace_security_audit"],
                    inputs={"target": "."},
                    success_criteria=[
                        "审计工具返回有效的结构化结果",
                        "每个安全发现均包含可验证的证据引用",
                    ],
                    risk_hint=RiskLevel.R1,
                    max_attempts=2,
                )
            ],
            rationale_summary="采用静态只读分析，以确保执行过程安全且可复现。",
        )
        if not self.gateway.settings.demo_mode:
            prompt = (
                "Create a bounded code-audit plan. Only use workspace_security_audit, "
                "which reads supported source and configuration files and delegates Python to Bandit. "
                "All user-facing objectives, success criteria and rationale summaries must be in Simplified Chinese. "
                "Do not include hidden reasoning; provide only a short, auditable rationale summary.\n"
                f"Objective: {state.task.objective}\n"
                f"Inputs: {[item.relative_path for item in state.input_artifacts]}"
            )
            try:
                output, meta = await self.gateway.structured(
                    role=self.model_role,
                    system_prompt=(
                        "你是 SecMind 安全规划智能体。所有面向用户的文本必须使用简体中文，"
                        "只返回符合给定 Schema 的 JSON。"
                    ),
                    user_prompt=prompt,
                    output_model=PlanOutput,
                    prompt_version=self.prompt_version,
                    stage="planner",
                    stream_observer=stream_observer,
                )
                state.budget.model_calls_used += 1
                state.budget.prompt_tokens_used += meta.usage.get("prompt_tokens", 0)
                state.budget.completion_tokens_used += meta.usage.get("completion_tokens", 0)
                state.budget.cache_read_tokens_used += meta.usage.get("cache_read_tokens", 0)
                state.budget.model_usage_recorded = bool(meta.usage)
                default = self._normalize_code_audit_plan(output, state, default)
                model_id = meta.model_id
            except Exception as exc:  # deterministic degradation is intentional
                model_id = "deterministic-planner-fallback"
                state.last_error = f"规划模型调用失败，已安全降级：{type(exc).__name__}"
        else:
            model_id = "deterministic-planner"
        state.plan = default.steps
        state.decisions.append(
            DecisionRecord(
                decision="plan_created",
                rationale_summary=default.rationale_summary,
                policy_ids=["PLAN-BOUNDED-V1"],
                model_id=model_id,
                prompt_version=self.prompt_version,
            )
        )
        return state


class AnalystAgent(BaseAgent):
    name = "analyst"
    model_role = "planner"

    async def run(self, state: AgentState) -> AgentState:
        if not state.observations:
            return state
        latest = state.observations[-1]
        if latest.status == ToolStatus.SUCCESS:
            state.evidence.extend(latest.evidence)
            for item in latest.data.get("findings", []):
                state.findings.append(Finding.model_validate(item))
            state.decisions.append(
                DecisionRecord(
                    decision="tool_result_normalized",
                    rationale_summary=latest.summary,
                    evidence_ids=[item.evidence_id for item in latest.evidence],
                    policy_ids=["EVIDENCE-REQUIRED-V1"],
                    model_id="deterministic-evidence-analyzer",
                )
            )
        return state


class VerifierAgent(BaseAgent):
    name = "verifier"
    model_role = "planner"

    async def run(self, state: AgentState) -> AgentState:
        orphaned = [finding.finding_id for finding in state.findings if not finding.evidence_ids]
        evidence_ids = {evidence.evidence_id for evidence in state.evidence}
        broken = [
            finding.finding_id
            for finding in state.findings
            if any(reference not in evidence_ids for reference in finding.evidence_ids)
        ]
        if orphaned or broken:
            state.last_error = "验证器拒绝了缺少证据或证据引用失效的安全发现"
            state.decisions.append(
                DecisionRecord(
                    decision="verification_failed",
                    rationale_summary=state.last_error,
                    policy_ids=["EVIDENCE-REQUIRED-V1"],
                    confidence=1,
                )
            )
        else:
            state.decisions.append(
                DecisionRecord(
                    decision="verification_passed",
                    rationale_summary="所有规范化安全发现均已关联到实际采集的工具证据。",
                    evidence_ids=sorted(evidence_ids),
                    policy_ids=["EVIDENCE-REQUIRED-V1"],
                    confidence=1,
                )
            )
        return state


class ReporterAgent(BaseAgent):
    name = "reporter"
    model_role = "planner"

    async def run(self, state: AgentState) -> AgentState:
        successful = any(item.status == ToolStatus.SUCCESS for item in state.observations)
        if state.status in {RunStatus.DENIED, RunStatus.FAILED}:
            final_status = state.status
        elif not successful:
            final_status = RunStatus.PARTIAL
        else:
            final_status = RunStatus.COMPLETED
        limitations: list[str] = []
        if state.scenario != Scenario.CODE_AUDIT:
            limitations.append("外部模块未返回成功结果；请检查对应服务地址和授权配置。")
        if not state.input_artifacts:
            limitations.append("未提供输入材料，工作区中可能没有可分析的代码。")
        if state.last_error:
            limitations.append(state.last_error)
        if successful:
            summary = (
                f"{state.module_route} 模块完成分析，共发现 {len(state.findings)} 个安全问题，"
                f"并由 {len(state.evidence)} 条证据记录支持。"
            )
        else:
            summary = "任务结束，但没有获得成功的安全工具观测结果。"
        state.status = final_status
        state.report = AgentReport(
            run_id=state.run_id,
            status=final_status,
            executive_summary=summary,
            findings=state.findings,
            decisions=state.decisions,
            evidence=state.evidence,
            limitations=limitations,
        )
        return state
