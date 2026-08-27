from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

import pytest

from secmind.llm import ModelCallMeta, ModelGatewayError
from secmind.question_bank import QuestionBankError, QuestionBankService
from secmind.schemas import (
    AttachmentRef,
    DirectoryScanProposal,
    QuestionBankConfirmRequest,
    QuestionBankInspectRequest,
    QuestionClassificationBatch,
)


def _write_zip(path, entries: dict[str, str | bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in entries.items():
            archive.writestr(name, content)


def _zip_bytes(entries: dict[str, str | bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


@dataclass
class FakeGateway:
    directory_roles: dict[str, str] | None = None
    classifications: dict[str, str] | None = None
    error: Exception | None = None

    async def structured(self, **kwargs):
        if self.error:
            raise self.error
        body = __import__("json").loads(kwargs["user_prompt"])
        if kwargs["prompt_version"] == "question-bank-directory-scan-v3":
            rows = []
            for item in body["directories"]:
                role = (self.directory_roles or {}).get(item["path"], "uncertain")
                rows.append(
                    {
                        "path": item["path"],
                        "role": role,
                        "confidence": 0.9,
                        "name": item["path"].rsplit("/", 1)[-1],
                        "rationale_summary": "测试目录决策。",
                    }
                )
            proposal = DirectoryScanProposal.model_validate({"decisions": rows, "summary": "测试扫描。"})
        else:
            assert kwargs["prompt_version"] == "question-bank-classification-v1"
            rows = []
            for item in body["questions"]:
                primary_type = (self.classifications or {}).get(item["candidate_id"], "unknown")
                rows.append(
                    {
                        "candidate_id": item["candidate_id"],
                        "primary_type": primary_type,
                        "secondary_types": [],
                        "confidence": 0.9,
                        "evidence_paths": item["available_evidence_paths"][:1],
                        "rationale_summary": "测试分类依据。",
                        "needs_human_review": False,
                    }
                )
            proposal = QuestionClassificationBatch.model_validate(
                {"classifications": rows, "summary": "测试分类。"}
            )
        return proposal, ModelCallMeta(
            model_id="test-question-bank-model",
            prompt_version=kwargs["prompt_version"],
            response_sha256="a" * 64,
            duration_ms=12,
            used_fallback=False,
            usage={"prompt_tokens": 100, "completion_tokens": 40, "cache_read_tokens": 20},
        )


def _request(source) -> QuestionBankInspectRequest:
    return QuestionBankInspectRequest(
        name="question bank",
        attachments=[AttachmentRef(ref=source.name, name=source.name)],
    )


@pytest.mark.asyncio
async def test_manifest_is_authoritative_without_model(settings) -> None:
    settings.prepare_directories()
    source = settings.upload_root / "manifest-bank.zip"
    _write_zip(
        source,
        {
            "question-bank.json": (
                '{"questions":[{"root":"questions/web-1","type":"web"},'
                '{"root":"questions/crypto-1","type":"crypto"}]}'
            ),
            "questions/web-1/src/app.py": "print('ok')",
            "questions/crypto-1/solve.py": "print('ok')",
        },
    )
    result = await QuestionBankService(settings).inspect_now(_request(source))
    assert result["status"] == "awaiting_confirmation"
    assert result["boundary_source"] == "manifest"
    assert {item["root"] for item in result["questions"]} == {
        "manifest-bank/questions/web-1",
        "manifest-bank/questions/crypto-1",
    }
    assert result["statistics"]["max_directory_depth"] >= 2
    extracted = settings.question_bank_root / result["bank_id"] / "extracted"
    assert (extracted / "manifest-bank" / "questions" / "web-1" / "src" / "app.py").is_file()
    assert (settings.question_bank_root / result["bank_id"] / "directory-tree.json").is_file()


@pytest.mark.asyncio
async def test_nested_archives_are_really_extracted_and_traced(settings) -> None:
    settings.prepare_directories()
    source = settings.upload_root / "nested-bank.zip"
    _write_zip(
        source,
        {
            "question-bank.json": '{"questions":[{"root":"questions/q1","type":"misc"}]}',
            "questions/q1/material.zip": _zip_bytes({"payload/readme.txt": "safe material"}),
        },
    )
    result = await QuestionBankService(settings).inspect_now(_request(source))
    assert result["status"] == "awaiting_confirmation"
    assert result["statistics"]["nested_archive_count"] == 1
    extracted = settings.question_bank_root / result["bank_id"] / "extracted"
    nested_file = extracted / "nested-bank" / "questions" / "q1" / "material" / "payload" / "readme.txt"
    assert nested_file.read_text(encoding="utf-8") == "safe material"


@pytest.mark.asyncio
async def test_duplicate_extracted_paths_fail_closed(settings) -> None:
    settings.prepare_directories()
    source = settings.upload_root / "duplicate-bank.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("q/App.py", "a")
        archive.writestr("q/app.py", "b")
    result = await QuestionBankService(settings).inspect_now(_request(source))
    assert result["status"] == "failed"
    assert result["boundary_source"] == "inventory_failed"
    assert not (settings.question_bank_root / result["bank_id"] / "extracted").exists()


@pytest.mark.asyncio
async def test_model_proposes_real_roots_without_splitting_source_directories(settings) -> None:
    settings.prepare_directories()
    source = settings.upload_root / "mixed-bank.zip"
    _write_zip(
        source,
        {
            "collection/alpha/frontend/src/index.js": "export default 1",
            "collection/alpha/backend/src/app.py": "print('ok')",
            "collection/beta/challenge/capture.pcap": b"pcap",
        },
    )
    service = QuestionBankService(
        settings,
        FakeGateway(
            directory_roles={
                "mixed-bank": "wrapper",
                "mixed-bank/collection": "container",
                "mixed-bank/collection/alpha": "question_root",
                "mixed-bank/collection/beta": "question_root",
            },
            classifications={"candidate-0001": "web", "candidate-0002": "forensics"},
        ),
    )
    result = await service.inspect_now(_request(source))
    assert result["status"] == "awaiting_confirmation"
    assert result["boundary_source"] == "llm_layered"
    assert {item["root"] for item in result["questions"]} == {
        "mixed-bank/collection/alpha",
        "mixed-bank/collection/beta",
    }
    assert len(result["model_trace"]["boundary_calls"]) == 3
    assert result["model_trace"]["classification_calls"][0]["usage"]["cache_read_tokens"] == 20


@pytest.mark.asyncio
async def test_model_failure_requires_manual_mapping_and_user_can_confirm(settings) -> None:
    settings.prepare_directories()
    source = settings.upload_root / "manual-bank.zip"
    _write_zip(source, {"wrapper/odd/a.py": "print(1)", "wrapper/odd/assets/x.bin": b"x"})
    service = QuestionBankService(settings, FakeGateway(error=ModelGatewayError("offline")))
    result = await service.inspect_now(_request(source))
    assert result["status"] == "needs_manual_mapping"
    assert result["questions"] == []
    assert "manual-bank/wrapper/odd" in result["directory_options"]

    confirmed = service.confirm(
        result["bank_id"],
        QuestionBankConfirmRequest(
            questions=[
                {
                    "candidate_id": "manual-1",
                    "root": "manual-bank/wrapper/odd",
                    "name": "Odd",
                    "question_type": "misc",
                }
            ]
        ),
    )
    assert confirmed["status"] == "confirmed"
    service.require_confirmed(result["bank_id"], _request(source).attachments)


@pytest.mark.asyncio
async def test_invalid_or_overlapping_model_roots_do_not_fall_back_to_guessing(settings) -> None:
    settings.prepare_directories()
    source = settings.upload_root / "conflict-bank.zip"
    _write_zip(source, {"q/src/app.py": "print(1)", "q/assets/x.txt": "x"})
    service = QuestionBankService(settings)
    with pytest.raises(QuestionBankError, match="包含冲突"):
        service._validate_proposal_data(  # noqa: SLF001
            [
                {"root": "conflict-bank/q", "name": "Q", "question_type": "code_audit"},
                {"root": "conflict-bank/q/src", "name": "Wrong", "question_type": "code_audit"},
            ],
            [
                {"path": "conflict-bank/q/src/app.py", "size_bytes": 1},
                {"path": "conflict-bank/q/assets/x.txt", "size_bytes": 1},
            ],
        )


def test_single_branch_model_root_is_lifted_to_nearest_branch_boundary(settings) -> None:
    settings.prepare_directories()
    service = QuestionBankService(settings)
    files = [
        {"path": "bank/collection/alpha/frontend/app.js", "size_bytes": 1},
        {"path": "bank/collection/alpha/backend/app.py", "size_bytes": 1},
        {"path": "bank/collection/beta/challenge/capture.pcap", "size_bytes": 1},
    ]
    questions, _ = service._validate_proposal_data(  # noqa: SLF001 - structural validator test
        [
            {
                "root": "bank/collection/alpha",
                "name": "Alpha",
                "question_type": "web",
                "boundary_confidence": 0.9,
                "type_confidence": 0.8,
                "rationale_summary": "同一题目的前后端。",
            },
            {
                "root": "bank/collection/beta/challenge",
                "name": "Beta",
                "question_type": "forensics",
                "boundary_confidence": 0.8,
                "type_confidence": 0.8,
                "rationale_summary": "取证材料。",
            },
        ],
        files,
    )
    assert [item["root"] for item in questions] == [
        "bank/collection/alpha",
        "bank/collection/beta",
    ]


def test_confirmation_rejects_overlapping_user_roots(settings) -> None:
    settings.prepare_directories()
    service = QuestionBankService(settings)
    bank_id = "11111111-1111-1111-1111-111111111111"
    service._save(  # noqa: SLF001 - narrow persisted-state validation test
        {
            "bank_id": bank_id,
            "status": "needs_manual_mapping",
            "stage": "manual_mapping",
            "attachments": [],
            "questions": [],
            "file_inventory": [
                {"path": "bank/q/src/app.py", "size_bytes": 1},
                {"path": "bank/q/assets/a.txt", "size_bytes": 1},
            ],
            "statistics": {},
        }
    )
    with pytest.raises(QuestionBankError, match="包含冲突"):
        service.confirm(
            bank_id,
            QuestionBankConfirmRequest(
                questions=[
                    {"candidate_id": "a", "root": "bank/q", "question_type": "web"},
                    {"candidate_id": "b", "root": "bank/q/src", "question_type": "code_audit"},
                ]
            ),
        )
