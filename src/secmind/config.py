from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="SECMIND_", case_sensitive=False, extra="ignore")

    env: str = "development"
    demo_mode: bool = True
    database_url: str = "sqlite:///./data/secmind.db"
    input_root: Path = Path("data/inputs")
    run_root: Path = Path("data/runs")
    upload_root: Path = Path("data/uploads")
    evaluation_root: Path = Path("data/evaluations")
    question_bank_root: Path = Path("data/question-banks")

    # Test3.0 is deliberately opt-in.  The public dataset may be mounted for
    # the Agent, while the private root is consumed only by the isolated
    # scoring subprocess and is never returned by an API.
    benchmark_dataset_root: Path | None = None
    benchmark_private_root: Path | None = None
    benchmark_scorer_root: Path | None = None
    benchmark_python_executable: str = "python"
    benchmark_dataset_version: str = "3.0.0-2026.07"
    benchmark_candidate_id: str = "secmind-v0.8.3-frontend-optimized"
    benchmark_candidate_version: str = "0.8.3"
    benchmark_dashboard_url: str = "http://127.0.0.1:3001/"

    qwen_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    qwen_api_key: str = ""
    planner_model: str = "qwen-plus"
    worker_model: str = "qwen-turbo"
    fallback_model: str = "qwen-max"
    embedding_model: str = "text-embedding-v3"
    qdrant_url: str = "http://qdrant:6333"
    qdrant_collection: str = "secmind_knowledge"
    model_timeout_seconds: float = 45.0
    api_host: str = "127.0.0.1"
    # Keep the unified host separate from Cairn's default port (8000).
    api_port: int = Field(default=8001, ge=1, le=65535)
    reverse_base_url: str = "http://127.0.0.1:8002"
    cairn_base_url: str = "http://127.0.0.1:8000"
    module_timeout_seconds: float = Field(default=20.0, ge=1, le=300)

    max_steps: int = Field(default=12, ge=1, le=100)
    max_tool_calls: int = Field(default=12, ge=1, le=100)
    max_model_calls: int = Field(default=20, ge=1, le=200)
    max_runtime_seconds: int = Field(default=600, ge=10, le=7200)
    max_upload_bytes: int = Field(default=50 * 1024 * 1024, ge=1024)
    max_extracted_bytes: int = Field(default=200 * 1024 * 1024, ge=1024)
    max_files: int = Field(default=10_000, ge=1)
    max_zip_ratio: int = Field(default=100, ge=1)
    max_question_bank_bytes: int = Field(default=2 * 1024 * 1024 * 1024, ge=1024)
    max_question_bank_files: int = Field(default=50_000, ge=1)
    max_question_bank_questions: int = Field(default=500, ge=1)
    max_question_bank_archive_depth: int = Field(default=5, ge=0, le=8)
    question_bank_scan_batch_size: int = Field(default=80, ge=1, le=200)
    question_bank_classification_batch_size: int = Field(default=8, ge=1, le=50)
    question_bank_boundary_confidence: float = Field(default=0.65, ge=0, le=1)
    question_bank_type_confidence: float = Field(default=0.60, ge=0, le=1)
    question_bank_model_timeout_seconds: float = Field(default=120.0, ge=10, le=600)

    def prepare_directories(self) -> None:
        for path in (
            self.input_root,
            self.run_root,
            self.upload_root,
            self.evaluation_root,
            self.question_bank_root,
        ):
            path.mkdir(parents=True, exist_ok=True)
        if self.database_url.startswith("sqlite:///"):
            Path(self.database_url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)

    @property
    def runtime_model_config_path(self) -> Path:
        return self.run_root.parent / "model-runtime.json"

    @staticmethod
    def validate_model_base_url(value: str) -> str:
        normalized = value.strip().rstrip("/")
        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Base URL must be a valid HTTP or HTTPS URL")
        if parsed.username or parsed.password:
            raise ValueError("Base URL must not contain embedded credentials")
        return normalized

    def load_runtime_model_config(self) -> None:
        path = self.runtime_model_config_path
        if not path.exists():
            return
        data = json.loads(path.read_text(encoding="utf-8"))
        self.qwen_base_url = self.validate_model_base_url(str(data.get("base_url", self.qwen_base_url)))
        api_key = data.get("api_key")
        if isinstance(api_key, str):
            self.qwen_api_key = api_key
        for field_name in ("planner_model", "worker_model", "fallback_model"):
            value = data.get(field_name)
            if isinstance(value, str) and value.strip():
                setattr(self, field_name, value.strip())
        self.demo_mode = not bool(self.qwen_api_key)

    def save_runtime_model_config(self) -> None:
        path = self.runtime_model_config_path
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "base_url": self.qwen_base_url,
                    "api_key": self.qwen_api_key,
                    "planner_model": self.planner_model,
                    "worker_model": self.worker_model,
                    "fallback_model": self.fallback_model,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.prepare_directories()
    settings.load_runtime_model_config()
    return settings
