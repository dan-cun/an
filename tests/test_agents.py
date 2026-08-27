from __future__ import annotations

from types import SimpleNamespace

import pytest

from secmind.agents import PlannerAgent, PlanOutput
from secmind.llm import ModelCallMeta
from secmind.schemas import AgentState, InputArtifact, PlanStep, RiskLevel, Scenario, TaskRequest


class StubPlannerGateway:
    def __init__(self, output: PlanOutput) -> None:
        self.settings = SimpleNamespace(demo_mode=False)
        self.output = output

    async def structured(self, **_kwargs):
        return self.output, ModelCallMeta(
            model_id="test-planner",
            prompt_version="v1",
            response_sha256="response",
            duration_ms=1,
            used_fallback=False,
            usage={},
        )


def code_audit_state() -> AgentState:
    return AgentState(
        run_id="planner-test",
        task=TaskRequest(objective="audit the supplied Python file"),
        scenario=Scenario.CODE_AUDIT,
        input_artifacts=[
            InputArtifact(
                original_name="vulnerable_app.py",
                relative_path="vulnerable_app.py",
                sha256="0" * 64,
                size_bytes=1,
            )
        ],
    )


def multi_artifact_state() -> AgentState:
    state = code_audit_state()
    state.input_artifacts = [
        InputArtifact(
            original_name=f"artifact_{index:02d}.og",
            relative_path=f"T3S-CASE/artifact_{index:02d}.og",
            sha256=str(index) * 64,
            size_bytes=index,
        )
        for index in (1, 2)
    ]
    return state


def plan_step(
    step_id: str,
    tools: list[str],
    inputs: dict | None = None,
) -> PlanStep:
    return PlanStep(
        step_id=step_id,
        objective=step_id,
        agent_role="executor",
        tool_candidates=tools,
        inputs=inputs or {},
    )


@pytest.mark.asyncio
async def test_planner_removes_non_tool_post_processing_steps() -> None:
    output = PlanOutput(
        steps=[
            plan_step("scan", ["bandit_python_audit"], {"target": "."}),
            plan_step("analyze", []),
            plan_step("report", []),
        ],
        rationale_summary="scan, analyze, then report",
    )
    state = await PlannerAgent(StubPlannerGateway(output)).run(code_audit_state())  # type: ignore[arg-type]

    assert len(state.plan) == 1
    assert state.plan[0].step_id == "scan"
    assert state.plan[0].tool_candidates == ["workspace_security_audit"]


@pytest.mark.asyncio
async def test_planner_falls_back_when_model_returns_no_known_tool() -> None:
    output = PlanOutput(
        steps=[plan_step("invented", ["unknown_tool"])],
        rationale_summary="use an unavailable tool",
    )
    state = await PlannerAgent(StubPlannerGateway(output)).run(code_audit_state())  # type: ignore[arg-type]

    assert len(state.plan) == 1
    assert state.plan[0].step_id == "audit-python-bandit"
    assert state.plan[0].inputs == {"target": "."}
    assert state.plan[0].tool_candidates == ["workspace_security_audit"]


@pytest.mark.asyncio
async def test_planner_normalizes_target_file_to_bandit_target() -> None:
    output = PlanOutput(
        steps=[
            plan_step(
                "scan",
                ["bandit_python_audit"],
                {"target_file": "vulnerable_app.py", "output_format": "json"},
            )
        ],
        rationale_summary="scan the uploaded file",
    )
    state = await PlannerAgent(StubPlannerGateway(output)).run(code_audit_state())  # type: ignore[arg-type]

    assert state.plan[0].inputs == {"target": "vulnerable_app.py"}
    assert state.plan[0].risk_hint == RiskLevel.R1


@pytest.mark.asyncio
async def test_planner_keeps_multi_file_case_as_one_audit_target() -> None:
    output = PlanOutput(
        steps=[plan_step("scan", ["workspace_security_audit"], {"target": "T3S-CASE/artifact_01.og"})],
        rationale_summary="scan all registered case inputs",
    )
    state = await PlannerAgent(StubPlannerGateway(output)).run(multi_artifact_state())  # type: ignore[arg-type]

    assert state.plan[0].inputs == {"target": "T3S-CASE"}
