from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Mapped, Session, mapped_column

from security_agent.ledger import Base, LedgerStore, canonical_json, redact
from security_agent.schemas import AgentState, ExperienceCreateRequest, RunStatus, ToolStatus


class ExperienceRow(Base):
    __tablename__ = "experiences"
    __table_args__ = (UniqueConstraint("source_type", "source_run_id", name="uq_experience_run_source"),)

    experience_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(240))
    summary: Mapped[str] = mapped_column(Text)
    module_route: Mapped[str] = mapped_column(String(80), index=True)
    experience_kind: Mapped[str] = mapped_column(String(40), index=True)
    vulnerability_type: Mapped[str | None] = mapped_column(String(160), nullable=True)
    source_type: Mapped[str] = mapped_column(String(20), index=True)
    source_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    source_title: Mapped[str] = mapped_column(String(240))
    verified: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    tags_json: Mapped[str] = mapped_column(Text, default="[]")
    steps_json: Mapped[str] = mapped_column(Text, default="[]")
    tools_json: Mapped[str] = mapped_column(Text, default="[]")
    evidence_refs_json: Mapped[str] = mapped_column(Text, default="[]")
    finding_count: Mapped[int] = mapped_column(Integer, default=0)
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ExperienceStore:
    def __init__(self, engine_or_url: Engine | str) -> None:
        if isinstance(engine_or_url, str):
            connect_args = {"check_same_thread": False} if engine_or_url.startswith("sqlite") else {}
            self.engine = create_engine(engine_or_url, future=True, connect_args=connect_args)
        else:
            self.engine = engine_or_url
        Base.metadata.create_all(self.engine)

    def list(
        self,
        *,
        module_route: str | None = None,
        source_type: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        query = select(ExperienceRow)
        if module_route:
            query = query.where(ExperienceRow.module_route == module_route)
        if source_type:
            query = query.where(ExperienceRow.source_type == source_type)
        query = query.order_by(ExperienceRow.updated_at.desc()).limit(limit)
        with Session(self.engine) as session:
            return [self._to_dict(row) for row in session.scalars(query).all()]

    def get(self, experience_id: str) -> dict[str, Any] | None:
        with Session(self.engine) as session:
            row = session.get(ExperienceRow, experience_id)
            return None if row is None else self._to_dict(row)

    def create_manual(self, payload: ExperienceCreateRequest) -> dict[str, Any]:
        now = datetime.now(UTC)
        safe = redact(payload.model_dump(mode="json"))
        row = ExperienceRow(
            experience_id=str(uuid4()),
            title=str(safe["title"]).strip(),
            summary=str(safe["summary"]).strip(),
            module_route=str(safe["module_route"]).strip(),
            experience_kind=str(safe["experience_kind"]),
            vulnerability_type=(str(safe["vulnerability_type"]).strip() if safe.get("vulnerability_type") else None),
            source_type="manual",
            source_run_id=None,
            source_title="人工填入",
            verified=False,
            confidence=0.6,
            content_hash=self._hash(safe),
            tags_json=canonical_json(self._clean_tags(safe.get("tags", []))),
            steps_json="[]",
            tools_json="[]",
            evidence_refs_json="[]",
            finding_count=0,
            usage_count=0,
            created_at=now,
            updated_at=now,
        )
        with Session(self.engine) as session:
            session.add(row)
            session.commit()
            return self._to_dict(row)

    def delete(self, experience_id: str) -> bool:
        with Session(self.engine) as session:
            row = session.get(ExperienceRow, experience_id)
            if row is None:
                return False
            session.delete(row)
            session.commit()
            return True

    def capture_run(
        self,
        state: AgentState,
        events: list[Any],
        *,
        chain_valid: bool,
    ) -> dict[str, Any] | None:
        if state.status not in {RunStatus.COMPLETED, RunStatus.PARTIAL} or state.report is None:
            return None
        data = self._extract_run(state, events, chain_valid=chain_valid)
        now = datetime.now(UTC)
        with Session(self.engine) as session:
            row = session.scalar(
                select(ExperienceRow).where(
                    ExperienceRow.source_type == "run",
                    ExperienceRow.source_run_id == state.run_id,
                )
            )
            if row is None:
                row = ExperienceRow(
                    experience_id=str(uuid4()),
                    source_type="run",
                    source_run_id=state.run_id,
                    created_at=now,
                    usage_count=0,
                    **data,
                )
                session.add(row)
            else:
                for key, value in data.items():
                    setattr(row, key, value)
            row.updated_at = now
            session.commit()
            return self._to_dict(row)

    def backfill(self, ledger: LedgerStore) -> dict[str, int]:
        created_or_updated = 0
        skipped = 0
        for state in ledger.list_states(limit=10_000):
            record = self.capture_run(
                state,
                ledger.events(state.run_id, limit=1_000_000),
                chain_valid=ledger.verify(state.run_id),
            )
            if record is None:
                skipped += 1
            else:
                created_or_updated += 1
        return {"stored": created_or_updated, "skipped": skipped}

    def search(self, module_route: str, objective: str, *, top_k: int = 5) -> list[dict[str, Any]]:
        objective_terms = {item.lower() for item in objective.replace("，", " ").replace("。", " ").split() if item}
        with Session(self.engine) as session:
            rows = session.scalars(
                select(ExperienceRow)
                .where(ExperienceRow.module_route == module_route, ExperienceRow.verified.is_(True))
                .order_by(ExperienceRow.confidence.desc(), ExperienceRow.updated_at.desc())
                .limit(max(top_k * 4, top_k))
            ).all()
            ranked = sorted(
                rows,
                key=lambda row: (
                    -len(objective_terms & set(f"{row.title} {row.summary}".lower().split())),
                    -row.confidence,
                ),
            )
            selected = ranked[:top_k]
            for row in selected:
                row.usage_count += 1
            session.commit()
            return [self._to_dict(row) for row in selected]

    @staticmethod
    def _extract_run(state: AgentState, events: list[Any], *, chain_valid: bool) -> dict[str, Any]:
        tool_names = list(dict.fromkeys(
            str(event.payload.get("tool"))
            for event in events
            if event.event_type == "tool.started" and event.payload.get("tool")
        ))
        error_observations = [item for item in state.observations if item.status == ToolStatus.ERROR]
        finding_types = list(dict.fromkeys(item.rule_id for item in state.findings if item.rule_id))
        steps = [item.objective for item in state.plan]
        evidence_refs = [item.evidence_id for item in state.evidence]
        is_failure_lesson = state.status == RunStatus.PARTIAL or bool(error_observations)
        if is_failure_lesson:
            latest = error_observations[-1] if error_observations else None
            detail = (latest.summary or latest.error_message or latest.error_code) if latest else state.last_error
            detail = detail or "任务未获得成功的工具观测，需要检查输入覆盖率与模块可用性。"
            kind = "failure_lesson"
            title = f"{state.task.name or state.module_route} · 失败经验"
            summary = f"实际执行后未完整完成：{detail}"
            vulnerability_type = latest.error_code if latest and latest.error_code else "execution_coverage"
            confidence = 0.78 if chain_valid else 0.45
        else:
            kind = "success_pattern"
            finding_titles = "、".join(item.title for item in state.findings[:3])
            suffix = f"，主要发现：{finding_titles}" if finding_titles else "，完成了可复现的受控分析流程"
            title = f"{state.task.name or state.module_route} · 已验证经验"
            summary = (
                f"通过 {'、'.join(tool_names) or '受控工具'} 分析 {len(state.input_artifacts)} 个输入材料，"
                f"形成 {len(state.findings)} 个发现和 {len(state.evidence)} 条证据{suffix}。"
            )
            vulnerability_type = ",".join(finding_types[:5]) or "verified_process"
            confidence = max(0.8, min(0.99, float(state.routing.get("confidence", 0.9))))
        safe_data = redact({
            "title": title,
            "summary": summary,
            "module_route": state.module_route,
            "experience_kind": kind,
            "vulnerability_type": vulnerability_type,
            "source_title": state.task.name or state.task.objective[:120],
            "verified": chain_valid,
            "confidence": confidence,
            "tags": [state.module_route, kind, *finding_types[:5]],
            "steps": steps,
            "tools": tool_names,
            "evidence_refs": evidence_refs,
            "finding_count": len(state.findings),
        })
        return {
            "title": safe_data["title"],
            "summary": safe_data["summary"],
            "module_route": safe_data["module_route"],
            "experience_kind": safe_data["experience_kind"],
            "vulnerability_type": safe_data["vulnerability_type"],
            "source_title": safe_data["source_title"],
            "verified": bool(safe_data["verified"]),
            "confidence": float(safe_data["confidence"]),
            "content_hash": ExperienceStore._hash(safe_data),
            "tags_json": canonical_json(safe_data["tags"]),
            "steps_json": canonical_json(safe_data["steps"]),
            "tools_json": canonical_json(safe_data["tools"]),
            "evidence_refs_json": canonical_json(safe_data["evidence_refs"]),
            "finding_count": int(safe_data["finding_count"]),
        }

    @staticmethod
    def _hash(value: Any) -> str:
        return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()

    @staticmethod
    def _clean_tags(tags: list[Any]) -> list[str]:
        return list(dict.fromkeys(str(tag).strip()[:80] for tag in tags if str(tag).strip()))[:20]

    @staticmethod
    def _to_dict(row: ExperienceRow) -> dict[str, Any]:
        return {
            "experience_id": row.experience_id,
            "title": row.title,
            "summary": row.summary,
            "module_route": row.module_route,
            "experience_kind": row.experience_kind,
            "vulnerability_type": row.vulnerability_type,
            "source_type": row.source_type,
            "source_run_id": row.source_run_id,
            "source_title": row.source_title,
            "verified": row.verified,
            "confidence": row.confidence,
            "content_hash": row.content_hash,
            "tags": json.loads(row.tags_json),
            "steps": json.loads(row.steps_json),
            "tools": json.loads(row.tools_json),
            "evidence_refs": json.loads(row.evidence_refs_json),
            "finding_count": row.finding_count,
            "usage_count": row.usage_count,
            "created_at": row.created_at.replace(tzinfo=row.created_at.tzinfo or UTC).isoformat(),
            "updated_at": row.updated_at.replace(tzinfo=row.updated_at.tzinfo or UTC).isoformat(),
        }
