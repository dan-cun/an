from __future__ import annotations

from pathlib import Path
import json

import pytest

from security_agent.schemas import InputArtifact, ToolContext, ToolStatus
from security_agent.tools import BanditTool, PenetrationModuleTool, WorkspaceSecurityAuditTool


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
    assert result.data["findings"][0]["rule_id"] == "AUDIT-JAVA-SSTI"
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


@pytest.mark.asyncio
async def test_penetration_adapter_forwards_objective_scope_and_material(monkeypatch, tmp_path: Path) -> None:
    material = tmp_path / "question.txt"
    material.write_text("find the authorized flag on the test service", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeResponse:
        status = 201

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"project":{"id":"proj_test"}}'

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("security_agent.tools.urllib.request.urlopen", fake_urlopen)
    artifact = InputArtifact(
        original_name="question.txt",
        relative_path="question.txt",
        sha256="a" * 64,
        size_bytes=43,
        media_type="text/plain",
    )
    result = await PenetrationModuleTool().invoke(
        {"target": "http://target.test"},
        ToolContext(
            run_id="run",
            step_id="step",
            workspace=str(tmp_path),
            allowed_paths=[str(tmp_path)],
            module_base_url="http://cairn.test",
            task_objective="完成授权渗透题并提交 flag",
            target_scope=["http://target.test"],
            input_artifacts=[artifact],
        ),
    )
    assert result.status == ToolStatus.SUCCESS
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["goal"] == "完成授权渗透题并提交 flag"
    assert "http://target.test" in payload["origin"]
    assert "question.txt" in payload["hints"][0]["content"]
    assert "authorized flag" in payload["hints"][0]["content"]
