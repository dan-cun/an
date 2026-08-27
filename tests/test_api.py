from __future__ import annotations

import time
import zipfile

from fastapi.testclient import TestClient

from secmind.api import create_app


def test_health_and_task_flow(settings) -> None:
    settings.prepare_directories()
    app = create_app(settings)
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        model_config = client.get("/api/v1/model-config")
        assert model_config.status_code == 200
        assert model_config.json()["api_key_configured"] is False
        assert "qwen_api_key" not in model_config.json()
        updated = client.put(
            "/api/v1/model-config",
            json={
                "base_url": "https://example.test/v1",
                "api_key": "test-secret-key",
                "planner_model": "custom-planner",
                "worker_model": "custom-worker",
                "fallback_model": "custom-fallback",
            },
        )
        assert updated.status_code == 200
        assert updated.json()["api_key_configured"] is True
        assert "test-secret-key" not in updated.text
        refreshed = client.get("/api/v1/model-config")
        assert refreshed.json()["base_url"] == "https://example.test/v1"
        assert refreshed.json()["planner_model"] == "custom-planner"
        assert refreshed.json()["worker_model"] == "custom-worker"
        assert refreshed.json()["fallback_model"] == "custom-fallback"
        assert refreshed.json()["demo_mode"] is False
        assert "test-secret-key" not in refreshed.text
        invalid = client.put(
            "/api/v1/model-config",
            json={"base_url": "file:///tmp/model", "api_key": "test-secret-key"},
        )
        assert invalid.status_code == 422
        cleared = client.put(
            "/api/v1/model-config",
            json={"base_url": "https://example.test/v1", "clear_api_key": True},
        )
        assert cleared.status_code == 200
        assert cleared.json()["api_key_configured"] is False
        upload = client.post(
            "/api/v1/uploads",
            files={"file": ("bad.py", b"import subprocess\nsubprocess.Popen('x', shell=True)\n")},
        )
        assert upload.status_code == 201
        question_bank_source = settings.upload_root / "question-bank.zip"
        with zipfile.ZipFile(question_bank_source, "w") as archive:
            archive.writestr(
                "question-bank.json",
                '{"questions":[{"root":"bank/WEB/web-1","type":"web"},'
                '{"root":"bank/CRYPTO/crypto-1","type":"crypto"}]}',
            )
            archive.writestr("bank/WEB/web-1/package.json", "{}")
            archive.writestr("bank/WEB/web-1/index.html", "hello")
            archive.writestr("bank/CRYPTO/crypto-1/solve.py", "from Crypto.PublicKey import RSA")
        question_bank_upload = client.post(
            "/api/v1/uploads",
            files={"file": ("question-bank.zip", question_bank_source.read_bytes())},
        )
        assert question_bank_upload.status_code == 201
        bank_attachment = {
            "ref": question_bank_upload.json()["ref"],
            "name": "question-bank.zip",
        }
        inspection = client.post(
            "/api/v1/question-banks/inspect",
            json={"name": "API question bank", "attachments": [bank_attachment]},
        )
        assert inspection.status_code == 202
        bank = inspection.json()
        for _ in range(100):
            bank = client.get(f"/api/v1/question-banks/{bank['bank_id']}/inspection").json()
            if bank["status"] != "inspecting":
                break
            time.sleep(0.02)
        assert bank["status"] == "awaiting_confirmation"
        assert bank["statistics"]["detected_question_count"] == 2
        blocked = client.post(
            "/api/v1/tasks",
            json={
                "name": "Unconfirmed bank",
                "objective": "audit question bank",
                "attachments": [bank_attachment],
                "question_bank_id": bank["bank_id"],
            },
        )
        assert blocked.status_code == 409
        confirmed = client.post(
            f"/api/v1/question-banks/{bank['bank_id']}/confirm",
            json={
                "questions": [
                    {
                        "candidate_id": item["candidate_id"],
                        "root": item["root"],
                        "question_type": item["question_type"],
                    }
                    for item in bank["questions"]
                ]
            },
        )
        assert confirmed.status_code == 200
        accepted = client.post(
            "/api/v1/tasks",
            json={
                "name": "Confirmed bank",
                "objective": "audit question bank",
                "attachments": [bank_attachment],
                "question_bank_id": bank["bank_id"],
            },
        )
        assert accepted.status_code == 202
        task = client.post(
            "/api/v1/tasks",
            json={
                "name": "Uploaded source audit",
                "objective": "audit uploaded python code",
                "attachments": [{"ref": upload.json()["ref"]}],
            },
        )
        assert task.status_code == 202
        run_id = task.json()["run_id"]
        runs = client.get("/api/v1/runs")
        assert runs.status_code == 200
        assert any(item["run_id"] == run_id for item in runs.json()["runs"])
        status = None
        for _ in range(100):
            response = client.get(f"/api/v1/runs/{run_id}")
            status = response.json()["status"]
            if status in {"completed", "partial", "failed", "denied"}:
                break
            time.sleep(0.02)
        assert status == "completed"
        assert response.json()["name"] == "Uploaded source audit"
        assert response.json()["budget"]["tool_calls_used"] >= 1
        assert response.json()["budget"]["model_calls_used"] == 0
        report = client.get(f"/api/v1/runs/{run_id}/report")
        assert report.status_code == 200
        assert report.json()["findings"]
        ledger = client.get(f"/api/v1/runs/{run_id}/ledger")
        assert ledger.status_code == 200
        assert ledger.json()["chain_valid"] is True
        usage = client.get("/api/v1/model-usage")
        assert usage.status_code == 200
        assert usage.json()["run_count"] == 2
        assert usage.json()["token_usage_available"] is False
        assert usage.json()["total_tokens"] == 0
        event_types = [item["event_type"] for item in ledger.json()["events"]]
        assert "agent.started" in event_types
        assert "agent.instruction" in event_types
        assert "agent.thought" in event_types
        assert "agent.completed" in event_types
        thoughts = client.get(f"/api/v1/runs/{run_id}/thoughts/export")
        assert thoughts.status_code == 200
        assert "text/markdown" in thoughts.headers["content-type"]
        assert "Uploaded source audit" in thoughts.text
        assert "可审计思考过程" in thoughts.text
        assert "编排指令" in thoughts.text
        assert "隐藏推理" in thoughts.text
