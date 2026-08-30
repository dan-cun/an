from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from security_agent.schemas import RiskLevel, ToolManifest


class GuardrailAction(StrEnum):
    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"
    DENY = "deny"


@dataclass(frozen=True)
class GuardrailDecision:
    action: GuardrailAction
    risk_level: RiskLevel
    policy_ids: tuple[str, ...]
    reason: str


class Guardrail:

    BLOCKED_TERMS = {
        "credential_theft",
        "persistence",
        "destructive",
        "ransomware",
        "wipe_disk",
        "disable_security",
    }

    def evaluate(
        self,
        manifest: ToolManifest,
        parameters: dict[str, Any],
        autonomy_policy: str,
    ) -> GuardrailDecision:
        serialized = str(parameters).lower()
        if manifest.risk_level >= RiskLevel.R3 or any(term in serialized for term in self.BLOCKED_TERMS):
            return GuardrailDecision(
                GuardrailAction.DENY,
                RiskLevel.R3,
                ("POL-R3-DENY",),
                "Destructive, credential, persistence, or out-of-scope actions are prohibited.",
            )
        # ``automatic`` is an explicit operator choice for the controlled test
        # environment: allow bounded R2 adapters (including penetration_module)
        # to run without pausing at the approval node.  ``graded`` keeps the
        # existing R2 human-in-the-loop behavior, while ``approval_all`` always
        # pauses.  R3 and blocked terms were denied above and cannot be bypassed.
        if autonomy_policy == "approval_all" or (
            manifest.risk_level == RiskLevel.R2 and autonomy_policy != "automatic"
        ):
            return GuardrailDecision(
                GuardrailAction.REQUIRE_APPROVAL,
                max(manifest.risk_level, RiskLevel.R2),
                ("POL-R2-HITL",),
                "The operation requires explicit operator approval.",
            )
        return GuardrailDecision(
            GuardrailAction.ALLOW,
            manifest.risk_level,
            ("POL-R0-R1-AUTO",),
            "允许在受控工作区内执行只读操作。",
        )
