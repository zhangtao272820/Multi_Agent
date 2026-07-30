"""In-memory async job store for POST /api/extract/async."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued|running|done|failed|canceled
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    result: dict[str, Any] | None = None
    error: str | None = None


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = asyncio.Lock()

    async def create(self) -> Job:
        jid = uuid.uuid4().hex
        job = Job(id=jid)
        async with self._lock:
            self._jobs[jid] = job
        return job

    async def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    async def update(self, job_id: str, **kwargs: Any) -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        for k, v in kwargs.items():
            setattr(job, k, v)
        job.updated_at = time.time()


_store: JobStore | None = None


def get_job_store() -> JobStore:
    global _store
    if _store is None:
        _store = JobStore()
    return _store
