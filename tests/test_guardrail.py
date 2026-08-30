from security_agent.guardrail import Guardrail, GuardrailAction
from security_agent.schemas import RiskLevel, Scenario, ToolManifest


def manifest(risk: RiskLevel) -> ToolManifest:
    return ToolManifest(
        name=f"risk_{risk}",
        version="1",
        description="test",
        scenarios=[Scenario.CODE_AUDIT],
        input_schema={},
        output_schema={},
        risk_level=risk,
    )


def test_graded_risk_policy() -> None:
    guardrail = Guardrail()
    assert guardrail.evaluate(manifest(RiskLevel.R1), {}, "graded").action == GuardrailAction.ALLOW
    assert guardrail.evaluate(manifest(RiskLevel.R2), {}, "graded").action == GuardrailAction.REQUIRE_APPROVAL
    assert guardrail.evaluate(manifest(RiskLevel.R3), {}, "graded").action == GuardrailAction.DENY


def test_automatic_policy_allows_bounded_r2_without_approval() -> None:
    decision = Guardrail().evaluate(manifest(RiskLevel.R2), {}, "automatic")
    assert decision.action == GuardrailAction.ALLOW


def test_approval_all_keeps_human_review_for_r2() -> None:
    decision = Guardrail().evaluate(manifest(RiskLevel.R2), {}, "approval_all")
    assert decision.action == GuardrailAction.REQUIRE_APPROVAL


def test_blocked_intent_cannot_be_lowered_by_manifest() -> None:
    decision = Guardrail().evaluate(manifest(RiskLevel.R0), {"action": "credential_theft"}, "automatic")
    assert decision.action == GuardrailAction.DENY
    assert decision.risk_level == RiskLevel.R3
