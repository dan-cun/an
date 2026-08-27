from __future__ import annotations

from pathlib import Path

import pytest

from secmind.schemas import ToolContext, ToolStatus
from secmind.tools import BanditTool, WorkspaceSecurityAuditTool


@pytest.mark.asyncio
async def test_bandit_tool_produces_evidence(tmp_path: Path) -> None:
    source = tmp_path / "bad.py"
    source.write_text("import subprocess\nsubprocess.Popen('echo unsafe', shell=True)\n", encoding="utf-8")
    result = await BanditTool().invoke(
        {"target": "."},
        ToolContext(
            run_id="run",
            step_id="step",
            workspace=str(tmp_path),
            allowed_paths=[str(tmp_path)],
        ),
    )
    assert result.status == ToolStatus.SUCCESS
    assert result.data["findings"]
    assert result.evidence
    assert result.data["findings"][0]["evidence_ids"]


@pytest.mark.asyncio
async def test_bandit_tool_rejects_scope_escape(tmp_path: Path) -> None:
    outside = tmp_path.parent
    result = await BanditTool().invoke(
        {"target": str(outside)},
        ToolContext(
            run_id="run",
            step_id="step",
            workspace=str(tmp_path),
            allowed_paths=[str(tmp_path)],
        ),
    )
    assert result.status == ToolStatus.DENIED


@pytest.mark.asyncio
async def test_workspace_audit_reads_java_and_reports_coverage(tmp_path: Path) -> None:
    source = tmp_path / "Main.java"
    source.write_text(
        '@RequestParam String input; runtimeServices.parse(new StringReader(input), "home");',
        encoding="utf-8",
    )
    result = await WorkspaceSecurityAuditTool().invoke(
        {"target": "."},
        ToolContext(run_id="run", step_id="step", workspace=str(tmp_path), allowed_paths=[str(tmp_path)]),
    )
    assert result.status == ToolStatus.SUCCESS
    assert result.data["coverage"]["scanned_files"] == ["Main.java"]
    assert result.data["findings"][0]["rule_id"] == "SECMIND-JAVA-SSTI"
    assert result.evidence


@pytest.mark.asyncio
async def test_workspace_audit_does_not_claim_success_without_coverage(tmp_path: Path) -> None:
    (tmp_path / "font.ttf").write_bytes(b"\x00\x01binary")
    result = await WorkspaceSecurityAuditTool().invoke(
        {"target": "."},
        ToolContext(run_id="run", step_id="step", workspace=str(tmp_path), allowed_paths=[str(tmp_path)]),
    )
    assert result.status == ToolStatus.ERROR
    assert result.error_code == "NO_AUDIT_COVERAGE"
    assert result.data["coverage"]["scanned_file_count"] == 0


@pytest.mark.asyncio
async def test_workspace_audit_reads_utf8_text_with_opaque_suffix(tmp_path: Path) -> None:
    (tmp_path / "artifact_01.og").write_text("\n", encoding="utf-8")
    (tmp_path / "artifact_02.og").write_text(
        "config interface 'lan'\n option proto 'dhcp'\n",
        encoding="utf-8",
    )
    result = await WorkspaceSecurityAuditTool().invoke(
        {"target": "."},
        ToolContext(run_id="run", step_id="step", workspace=str(tmp_path), allowed_paths=[str(tmp_path)]),
    )
    assert result.status == ToolStatus.SUCCESS
    assert result.data["coverage"]["scanned_file_count"] == 2
    assert result.data["coverage"]["skipped_file_count"] == 0
