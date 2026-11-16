"""本次运行的键鼠时间轴。仅记录合成输入，不安装全局监听器，不保存输入文本。"""
from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar

MAX_EVENTS = 20000
_context = ContextVar('input_trace_context', default=None)


class InputTrace:
    def __init__(self, name: str = '', project_id: str = '', pause_clock=None) -> None:
        self.run_id = uuid.uuid4().hex
        self.name = name
        self.project_id = project_id
        self._started = time.monotonic()
        self._pause_clock = pause_clock or (lambda: 0)
        self._pause_base = self._pause_clock()
        self._elapsed = None
        self._seq = 0
        self._events = deque(maxlen=MAX_EVENTS)
        self._lock = threading.Lock()

    def record(self, kind: str, location: dict, data: dict) -> None:
        with self._lock:
            if self._elapsed is not None:
                return
            self._seq += 1
            self._events.append({
                **location, **data, 'kind': kind, 'seq': self._seq,
                'time_ms': round((time.monotonic() - self._started) * 1000, 3),
                'active_ms': round(self.active_ms(), 3),
            })

    def finish(self) -> None:
        with self._lock:
            if self._elapsed is None:
                self._elapsed = (time.monotonic() - self._started) * 1000
                self._active_elapsed = self.active_ms()

    def active_ms(self):
        return max(0, (time.monotonic()-self._started)*1000-(self._pause_clock()-self._pause_base))

    def snapshot(self, after_seq: int = 0, run_id: str = '') -> dict:
        with self._lock:
            after = max(0, after_seq) if run_id == self.run_id else 0
            return {
                'run_id': self.run_id, 'project_id': self.project_id, 'name': self.name,
                'running': self._elapsed is None,
                'elapsed_ms': round(self._elapsed if self._elapsed is not None else (time.monotonic() - self._started) * 1000, 3),
                'active_elapsed_ms': round(self._active_elapsed if self._elapsed is not None else self.active_ms(), 3),
                'last_seq': self._seq, 'dropped': max(0, self._seq - len(self._events)),
                'events': [dict(e) for e in self._events if e['seq'] > after],
            }


def location() -> dict:
    return {k: v for k, v in (_context.get() or {}).items() if k != 'recorder'}


@contextmanager
def scope(**updates):
    token = _context.set({**(_context.get() or {}), **updates})
    try:
        yield
    finally:
        _context.reset(token)


def emit(kind: str, *, origin: dict | None = None, **data) -> None:
    ctx = _context.get() or {}
    recorder = ctx.get('recorder')
    if recorder is None:
        return
    try:
        where = location()
        if not where.get('node_id') and origin:
            where = origin
        recorder.record(kind, where, data)
    except Exception:
        pass  # 观测不能改变输入成功/失败与执行顺序。
