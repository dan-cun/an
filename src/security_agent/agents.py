from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from security_agent.fusion import classify_task
from security_agent.llm import ModelCallMeta, ModelGateway, StreamObserver
from security_agent.mcp_generated import GeneratedMCPStore, GeneratedToolProposal
from security_agent.schemas import (
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


class RouteOutput(BaseModel):
    primary_type: Literal["code_audit", "reverse", "penetration", "unsupported"]
    secondary_types: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence: list[str] = Field(default_factory=list, max_length=20)
    needs_human_review: bool = False
    rationale_summary: str = Field(default="", max_length=2000)


class PlanOutput(BaseModel):
    steps: list[PlanStep]
    rationale_summary: str = Field(min_length=1, max_length=4000)


class AnalysisOutput(BaseModel):
    summary: str = Field(min_length=1, max_length=4000)
    findings: list[Finding] = Field(default_factory=list, max_length=100)


class ReportOutput(BaseModel):
    executive_summary: str = Field(min_length=1, max_length=6000)
    limitations: list[str] = Field(default_factory=list, max_length=20)
    next_steps: list[str] = Field(default_factory=list, max_length=20)


SUPPORTED_SCENARIOS = {
    "code_audit": Scenario.CODE_AUDIT,
    "reverse": Scenario.REVERSE_TRIAGE,
    "penetration": Scenario.PENETRATION_TEST,
    "unsupported": Scenario.UNKNOWN,
}

MODULE_SAFETY_GUIDANCE = {
    "code_audit": (
        "你正在执行代码审计。严禁危害系统与本机的安全；只读取当前任务工作区中的题目文件、依赖和配置，"
        "不得修改源码、删除文件、访问工作区外路径、读取凭据或主动连接网络。"
    ),
    "reverse": (
        "你正在执行逆向分析。严禁危害系统与本机的安全；只分析当前任务工作区中上传的样本和题面材料，"
        "优先使用静态方法，不得运行未知样本、修改系统状态、读取工作区外文件或连接非授权网络。"
    ),
    "penetration": (
        "你正在执行授权渗透测试。严禁危害系统与本机的安全；只能对任务明确给出的 target_scope 靶场进行验证，"
        "不得扩大目标范围、攻击本机或第三方、建立持久化、窃取凭据或破坏数据；每一步都必须服务于题目目标并保留证据。"
    ),
    "incident_response": (
        "你正在执行应急响应。严禁危害系统与本机的安全；只读取当前任务工作区和明确授权的取证材料，"
        "不得删除日志、终止进程、修改系统配置、访问无关主机或泄露敏感凭据。"
    ),
}


def _module_safety_guidance(state: AgentState) -> str:
    guidance = MODULE_SAFETY_GUIDANCE.get(
        state.module_route,
        "严禁危害系统与本机的安全；所有操作必须限定在当前题目材料和明确授权范围内。",
    )
    return (
        f"{guidance}\n当前工作区：{state.workspace or '待建立'}\n"
        f"当前授权靶场：{state.task.target_scope or ['未提供']}"
    )


def _material_context(state: AgentState, max_total: int = 60_000) -> str:
    """Build a bounded, auditable prompt context from the ingested task material."""
    lines = [
        f"任务目标：{state.task.objective}",
        f"授权范围：{state.task.target_scope or ['未提供']}",
        "输入材料：",
    ]
    remaining = max_total
    workspace = Path(state.workspace).resolve() if state.workspace else None
    for artifact in state.input_artifacts[:200]:
        line = f"- {artifact.relative_path} | {artifact.media_type} | {artifact.size_bytes} bytes | sha256={artifact.sha256}"
        lines.append(line)
        remaining -= len(line)
        if remaining <= 0:
            break
        if workspace is None:
            continue
        candidate = (workspace / artifact.relative_path).resolve()
        if (candidate != workspace and workspace not in candidate.parents) or not candidate.is_file():
            continue
        suffix = candidate.suffix.casefold()
        text_like = artifact.media_type.startswith("text/") or suffix in {
            ".c",
            ".cc",
            ".cpp",
            ".h",
            ".hpp",
            ".py",
            ".java",
            ".js",
            ".ts",
            ".go",
            ".rs",
            ".php",
            ".rb",
            ".sh",
            ".md",
            ".txt",
            ".json",
            ".yaml",
            ".yml",
            ".xml",
            ".html",
            ".url",
        }
        if not text_like:
            continue
        try:
            content = candidate.read_text(encoding="utf-8", errors="replace").replace("\x00", "")
        except OSError:
            continue
        excerpt = content[: min(12_000, max(0, remaining - 80))]
        if excerpt:
            lines.append(f"  内容摘录（{artifact.relative_path}）：\n{excerpt}")
            remaining -= len(excerpt)
        if remaining <= 0:
            break
    return "\n".join(lines)[:max_total]


def _record_model_call(state: AgentState, meta: ModelCallMeta) -> None:
    state.budget.model_calls_used += 1
    state.budget.prompt_tokens_used += meta.usage.get("prompt_tokens", 0)
    state.budget.completion_tokens_used += meta.usage.get("completion_tokens", 0)
    state.budget.cache_read_tokens_used += meta.usage.get("cache_read_tokens", 0)
    state.budget.model_usage_recorded = bool(meta.usage)


def _can_call_model(state: AgentState, gateway: ModelGateway) -> bool:
    return not gateway.settings.demo_mode and state.budget.model_calls_used < state.budget.max_model_calls


class BaseAgent(ABC):
    name: str
    model_role: str = "worker"
    prompt_version: str = "v1"
    max_react_rounds: int = 3

    def __init__(self, gateway: ModelGateway) -> None:
        self.gateway = gateway

    @abstractmethod
    async def run(self, state: AgentState) -> AgentState:
        raise NotImplementedError


class TaskInterpreterAgent(BaseAgent):
    name = "task_interpreter"
    prompt_version = "route-v2"

    async def run(self, state: AgentState, stream_observer: StreamObserver | None = None) -> AgentState:
        deterministic = classify_task(state.task.objective, state.input_artifacts, state.task.target_scope)
        fallback_scenario = deterministic.pop("scenario")
        routing = deterministic
        scenario = fallback_scenario
        model_id = "deterministic-router"
        rationale = ""

        if _can_call_model(state, self.gateway):
            try:
                output, meta = await self.gateway.structured(
                    role="worker",
                    system_prompt=(
                        "你是安全任务解释智能体。根据任务目标、授权范围和输入材料，判断题目属于 code_audit、reverse、"
                        "penetration 或 unsupported。严禁危害系统与本机的安全；只返回符合 Schema 的 JSON；"
                        "不要输出隐藏推理，只给出简短、可审计的中文依据。"
                    ),
                    user_prompt=(
                        "请完成题型识别，并为后续模块选择提供可执行依据。\n"
                        "候选模块：code_audit=代码审计，reverse=逆向分析，penetration=授权渗透，unsupported=暂不支持。\n"
                        f"规则分类器仅作为参考：{deterministic}\n{_material_context(state)}\n"
                        "分类只用于选择受控模块，不得据此扩大文件或网络范围。"
                    ),
                    output_model=RouteOutput,
                    prompt_version=self.prompt_version,
                    stage="classifier",
                    stream_observer=stream_observer,
                )
                _record_model_call(state, meta)
                if output.primary_type in SUPPORTED_SCENARIOS:
                    routing = output.model_dump(exclude={"rationale_summary"})
                    routing["source"] = "model"
                    scenario = SUPPORTED_SCENARIOS[output.primary_type]
                    rationale = output.rationale_summary.strip()
                    model_id = meta.model_id
            except Exception as exc:
                routing = {**deterministic, "source": "deterministic_fallback", "model_error": type(exc).__name__}

        state.routing = routing
        state.module_route = routing["primary_type"]
        state.scenario = scenario
        fallback_rationale = (
            f"已识别为{state.module_route}模块，置信度 {routing['confidence']}；依据："
            f"{'、'.join(routing.get('evidence', [])) or '无明确关键词，采用安全默认路由'}。"
        )
        state.decisions.append(
            DecisionRecord(
                decision=f"scenario={scenario.value}",
                rationale_summary=rationale or fallback_rationale,
                policy_ids=["ROUTE-SCENARIO-V2"],
                model_id=model_id,
                prompt_version=self.prompt_version,
                confidence=float(routing.get("confidence", 0.5)),
            )
        )
        return state


class PlannerAgent(BaseAgent):
    name = "planner"
    model_role = "planner"
    prompt_version = "plan-v2"

    @staticmethod
    def _normalize_code_audit_plan(output: PlanOutput, state: AgentState, fallback: PlanOutput) -> PlanOutput:
        supported_tools = {"workspace_security_audit", "bandit_python_audit"}
        selected = next((step for step in output.steps if set(step.tool_candidates) & supported_tools), None)
        if selected is None:
            selected = fallback.steps[0]
        artifact_paths = {item.relative_path for item in state.input_artifacts}
        artifact_by_name = {item.relative_path.rsplit("/", 1)[-1]: item.relative_path for item in state.input_artifacts}
        requested_target = (
            str(selected.inputs.get("target", selected.inputs.get("target_file", "."))).replace("\\", "/").strip()
        )
        common_parent = "."
        if len(artifact_paths) > 1:
            parents = {path.rsplit("/", 1)[0] if "/" in path else "." for path in artifact_paths}
            if len(parents) == 1:
                common_parent = parents.pop()
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
        return PlanOutput(steps=[normalized_step], rationale_summary=output.rationale_summary)

    @staticmethod
    def _normalize_module_plan(
        output: PlanOutput, scenario: Scenario, state: AgentState, fallback: PlanOutput
    ) -> PlanOutput:
        tool_name = "reverse_module" if scenario == Scenario.REVERSE_TRIAGE else "penetration_module"
        selected = next((step for step in output.steps if tool_name in step.tool_candidates), None) or fallback.steps[0]
        target = "."
        if scenario == Scenario.PENETRATION_TEST:
            target = next(
                (scope for scope in state.task.target_scope if scope.startswith(("http://", "https://"))), "."
            )
        selected = selected.model_copy(
            update={
                "dependencies": [],
                "tool_candidates": [tool_name],
                "inputs": {"target": target},
                "risk_hint": RiskLevel.R2 if scenario == Scenario.PENETRATION_TEST else RiskLevel.R1,
            }
        )
        return PlanOutput(steps=[selected], rationale_summary=output.rationale_summary)

    @staticmethod
    def _fallback_for(state: AgentState) -> PlanOutput:
        if state.scenario == Scenario.REVERSE_TRIAGE:
            return PlanOutput(
                steps=[
                    PlanStep(
                        step_id="reverse-triage",
                        objective="对二进制样本执行只读结构与字符串分析。",
                        agent_role="reverse",
                        tool_candidates=["reverse_module"],
                        inputs={"target": "."},
                        success_criteria=["生成结构化逆向证据"],
                        risk_hint=RiskLevel.R1,
                    )
                ],
                rationale_summary="围绕样本格式、字符串和结构特征执行受控逆向初筛。",
            )
        if state.scenario == Scenario.PENETRATION_TEST:
            target = next(
                (scope for scope in state.task.target_scope if scope.startswith(("http://", "https://"))), "."
            )
            return PlanOutput(
                steps=[
                    PlanStep(
                        step_id="penetration-assessment",
                        objective="在授权测试环境中提交渗透任务至渗透模块。",
                        agent_role="penetration",
                        tool_candidates=["penetration_module"],
                        inputs={"target": target},
                        success_criteria=["获得渗透工作流回执或明确不可用状态"],
                        risk_hint=RiskLevel.R2,
                    )
                ],
                rationale_summary="仅向授权目标提交受审批策略约束的渗透工作流。",
            )
        return PlanOutput(
            steps=[
                PlanStep(
                    step_id="audit-python-bandit",
                    objective="对受控工作区中的源码和配置执行只读安全审计。",
                    agent_role="executor",
                    tool_candidates=["workspace_security_audit"],
                    inputs={"target": "."},
                    success_criteria=["审计工具返回有效的结构化结果", "每个安全发现均包含可验证的证据引用"],
                    risk_hint=RiskLevel.R1,
                    max_attempts=2,
                )
            ],
            rationale_summary=(
                f"采用静态只读分析，并参考 {len(state.knowledge_hits)} 条已验证经验。"
                if state.knowledge_hits
                else "采用静态只读分析，以确保执行过程安全且可复现。"
            ),
        )

    async def run(self, state: AgentState, stream_observer: StreamObserver | None = None) -> AgentState:
        fallback = self._fallback_for(state)
        if state.scenario not in {Scenario.CODE_AUDIT, Scenario.REVERSE_TRIAGE, Scenario.PENETRATION_TEST}:
            state.plan = []
            state.decisions.append(
                DecisionRecord(
                    decision="no_supported_plan",
                    rationale_summary="当前场景暂未配置可执行模块。",
                    policy_ids=["SCOPE-MVP-V1"],
                    model_id="deterministic-planner",
                )
            )
            return state
        model_id = "deterministic-planner"
        plan = fallback
        if _can_call_model(state, self.gateway):
            tool = {
                Scenario.CODE_AUDIT: "workspace_security_audit",
                Scenario.REVERSE_TRIAGE: "reverse_module",
                Scenario.PENETRATION_TEST: "penetration_module",
            }[state.scenario]
            prompt = (
                "请为安全任务生成一个有界、可执行、可验证的单步计划。只允许使用指定适配器，所有面向用户的文本使用简体中文；"
                "不要输出隐藏推理，只输出短的审计性 rationale_summary。\n"
                f"{_module_safety_guidance(state)}\n"
                f"允许适配器：{tool}\n{_material_context(state)}\n"
                f"已验证经验：{[item.content for item in state.knowledge_hits]}"
            )
            try:
                output, meta = await self.gateway.structured(
                    role=self.model_role,
                    system_prompt=(
                        "你是安全智能体平台规划智能体，只返回符合 Schema 的 JSON。"
                        "严禁危害系统与本机的安全；充分发挥自主决策能力，但所有计划必须绑定当前题目材料和授权范围。"
                    ),
                    user_prompt=prompt,
                    output_model=PlanOutput,
                    prompt_version=self.prompt_version,
                    stage="planner",
                    stream_observer=stream_observer,
                )
                _record_model_call(state, meta)
                plan = (
                    self._normalize_code_audit_plan(output, state, fallback)
                    if state.scenario == Scenario.CODE_AUDIT
                    else self._normalize_module_plan(output, state.scenario, state, fallback)
                )
                model_id = meta.model_id
            except Exception:
                model_id = "deterministic-planner-fallback"
        state.plan = plan.steps
        state.decisions.append(
            DecisionRecord(
                decision="plan_created",
                rationale_summary=plan.rationale_summary,
                policy_ids=["PLAN-BOUNDED-V2"],
                model_id=model_id,
                prompt_version=self.prompt_version,
            )
        )
        return state


class AnalystAgent(BaseAgent):
    name = "analyst"
    model_role = "worker"
    prompt_version = "analysis-v2"

    def __init__(self, gateway: ModelGateway, generated_store: GeneratedMCPStore | None = None) -> None:
        super().__init__(gateway)
        self.generated_store = generated_store

    async def run(self, state: AgentState, stream_observer: StreamObserver | None = None) -> AgentState:
        if not state.observations:
            return state
        latest = state.observations[-1]
        if (
            latest.status != ToolStatus.SUCCESS
            and latest.error_code == "NO_AUDIT_COVERAGE"
            and self.generated_store is not None
            and _can_call_model(state, self.gateway)
        ):
            try:
                proposal, meta = await self.gateway.structured(
                    role=self.model_role,
                    system_prompt=(
                        "你是安全工具工程师。当受控扫描器无法识别输入格式时，提出一个声明式 MCP 适配器。"
                        "只能使用 text_regex、binary_strings、json_keys 三种 operation；禁止输出 Python、Shell 或网络请求代码。"
                        "严禁危害系统与本机的安全；在安全边界内充分自主选择最小可行适配方式，只返回符合 Schema 的 JSON。"
                    ),
                    user_prompt=(
                        f"{_module_safety_guidance(state)}\n当前任务：{_material_context(state)}\n"
                        f"扫描器错误：{latest.error_message or latest.summary}\n"
                        f"覆盖率：{latest.data.get('coverage', {})}\n"
                        "请选择能读取未覆盖文件的最小适配器，并给出可复用的正则（如不需要则为空）。"
                    ),
                    output_model=GeneratedToolProposal,
                    prompt_version="toolsmith-v1",
                    stage="toolsmith",
                    stream_observer=stream_observer,
                )
                _record_model_call(state, meta)
                path = self.generated_store.save(proposal, source_run_id=state.run_id)
                state.decisions.append(
                    DecisionRecord(
                        decision="generated_tool_persisted",
                        rationale_summary=f"模型为未覆盖输入生成受控适配器 {proposal.tool_id}，已写入 {path.name}，下一次重试将自动复用。",
                        policy_ids=["MCP-GENERATED-DECLARATIVE-V1"],
                        model_id=meta.model_id,
                        prompt_version="toolsmith-v1",
                    )
                )
            except Exception as exc:
                state.decisions.append(
                    DecisionRecord(
                        decision="generated_tool_rejected",
                        rationale_summary=f"模型适配器提议未通过 Schema 校验：{type(exc).__name__}。",
                        policy_ids=["MCP-GENERATED-DECLARATIVE-V1"],
                        model_id="toolsmith-fallback",
                    )
                )
        if latest.status != ToolStatus.SUCCESS:
            return state
        state.evidence.extend(latest.evidence)
        for item in latest.data.get("findings", []):
            state.findings.append(Finding.model_validate(item))
        model_id = "deterministic-evidence-analyzer"
        summary = latest.summary
        if _can_call_model(state, self.gateway):
            try:
                output, meta = await self.gateway.structured(
                    role=self.model_role,
                    system_prompt=(
                        "你是安全分析智能体。基于输入材料和受控工具观测提取可验证 Finding，只能引用给定 evidence_id；"
                        "严禁危害系统与本机的安全；充分自主判断问题成因，但只返回 Schema JSON，不输出隐藏推理。"
                    ),
                    user_prompt=(
                        f"当前模块：{state.module_route}\n{_module_safety_guidance(state)}\n{_material_context(state)}\n"
                        f"工具观测：{latest.model_dump(mode='json')}\n可用证据 ID：{[item.evidence_id for item in state.evidence]}"
                    ),
                    output_model=AnalysisOutput,
                    prompt_version=self.prompt_version,
                    stage="analysis",
                    stream_observer=stream_observer,
                )
                _record_model_call(state, meta)
                evidence_ids = {item.evidence_id for item in state.evidence}
                for finding in output.findings:
                    refs = [ref for ref in finding.evidence_ids if ref in evidence_ids]
                    if refs:
                        finding.evidence_ids = refs
                        state.findings.append(finding)
                summary = output.summary
                model_id = meta.model_id
            except Exception:
                model_id = "deterministic-evidence-analyzer-fallback"
        state.decisions.append(
            DecisionRecord(
                decision="tool_result_analyzed",
                rationale_summary=summary,
                evidence_ids=[item.evidence_id for item in state.evidence],
                policy_ids=["EVIDENCE-REQUIRED-V2"],
                model_id=model_id,
                prompt_version=self.prompt_version,
            )
        )
        return state


class VerifierAgent(BaseAgent):
    name = "verifier"
    model_role = "worker"

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
    model_role = "worker"
    prompt_version = "report-v2"

    async def run(self, state: AgentState, stream_observer: StreamObserver | None = None) -> AgentState:
        successful = any(item.status == ToolStatus.SUCCESS for item in state.observations)
        if state.status in {RunStatus.DENIED, RunStatus.FAILED}:
            final_status = state.status
        elif not successful:
            final_status = RunStatus.PARTIAL
        else:
            final_status = RunStatus.COMPLETED
        limitations: list[str] = []
        if state.scenario != Scenario.CODE_AUDIT and not successful:
            limitations.append("外部模块未返回成功结果；请检查对应服务地址和授权配置。")
        if not state.input_artifacts:
            limitations.append("未提供输入材料，工作区中可能没有可分析的题目内容。")
        if state.last_error:
            limitations.append(state.last_error)
        fallback_summary = (
            f"{state.module_route} 模块完成分析，共发现 {len(state.findings)} 个安全问题，并由 {len(state.evidence)} 条证据记录支持。"
            if successful
            else "任务结束，但没有获得成功的安全工具观测结果。"
        )
        summary = fallback_summary
        model_id = "deterministic-reporter"
        if _can_call_model(state, self.gateway):
            try:
                output, meta = await self.gateway.structured(
                    role=self.model_role,
                    system_prompt=(
                        "你是安全报告智能体。根据已验证输入、工具观测、Finding 和 Evidence 生成中文总结；"
                        "严禁危害系统与本机的安全；充分发挥自主归纳能力，不得声称未验证的成功，只返回 Schema JSON。"
                    ),
                    user_prompt=(
                        f"模块：{state.module_route}\n运行状态：{final_status.value}\n{_module_safety_guidance(state)}\n{_material_context(state)}\n"
                        f"观测：{[item.model_dump(mode='json') for item in state.observations]}\n"
                        f"发现：{[item.model_dump(mode='json') for item in state.findings]}\n"
                        f"证据：{[item.model_dump(mode='json') for item in state.evidence]}\n已有限制：{limitations}"
                    ),
                    output_model=ReportOutput,
                    prompt_version=self.prompt_version,
                    stage="report",
                    stream_observer=stream_observer,
                )
                _record_model_call(state, meta)
                summary = output.executive_summary
                limitations.extend(item for item in output.limitations if item not in limitations)
                model_id = meta.model_id
                state.decisions.append(
                    DecisionRecord(
                        decision="report_summary_generated",
                        rationale_summary=summary,
                        policy_ids=["REPORT-VERIFIED-V2"],
                        model_id=model_id,
                        prompt_version=self.prompt_version,
                    )
                )
            except Exception:
                model_id = "deterministic-reporter-fallback"
        if not any(item.decision == "report_summary_generated" for item in state.decisions):
            state.decisions.append(
                DecisionRecord(
                    decision="report_summary_generated",
                    rationale_summary=summary,
                    policy_ids=["REPORT-VERIFIED-V1"],
                    model_id=model_id,
                    prompt_version=self.prompt_version,
                )
            )
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
