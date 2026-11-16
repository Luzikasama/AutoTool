"""WebSocket 连接管理：向前端广播日志与运行状态。"""
import asyncio
import json
from typing import Any, Callable

# 单条消息的发送超时。慢接收端不能拖住执行器 —— 广播是"顺带通知"，
# 不是流程的一部分：某个页面卡住时宁可断开它，也不能让节点停在 await 上。
SEND_TIMEOUT_S = 2.0
MAX_PENDING_MESSAGES = 256


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set = set()
        # 广播钩子：引擎用它把「推给前端的日志」同时写进运行日志文件。
        # 必须在「没有连接就直接返回」之前调用——页面被关掉之后，正是最需要留痕的时候。
        self.on_broadcast: Callable[[dict], None] | None = None
        # 观测用计数：超时/失败丢了几条，出问题时能一眼看出是不是连接被拖死了
        self.send_failures = 0
        self.dropped_messages = 0
        self._queues: dict[Any, asyncio.Queue] = {}
        self._senders: dict[Any, asyncio.Task] = {}
        self._tasks: set[asyncio.Task] = set()

    def _track(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def connect(self, ws) -> None:
        await ws.accept()
        self.connections.add(ws)
        self._ensure_sender(ws)

    def disconnect(self, ws, *, close: bool = False) -> None:
        self.connections.discard(ws)
        self._queues.pop(ws, None)
        task = self._senders.pop(ws, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()
        if close:
            self._track(self._close_socket(ws))

    async def _close_socket(self, ws) -> None:
        try:
            await asyncio.wait_for(ws.close(code=1013), timeout=SEND_TIMEOUT_S)
        except Exception:
            pass

    def _ensure_sender(self, ws) -> asyncio.Queue:
        queue = self._queues.get(ws)
        if queue is None:
            queue = asyncio.Queue(maxsize=MAX_PENDING_MESSAGES)
            self._queues[ws] = queue
            self._senders[ws] = self._track(self._send(ws, queue))
        return queue

    async def _send(self, ws, queue: asyncio.Queue) -> None:
        # 一条连接只有一个写入者，多次并发广播不会交错调用 send_text。
        try:
            while True:
                text = await queue.get()
                try:
                    await asyncio.wait_for(ws.send_text(text), timeout=SEND_TIMEOUT_S)
                finally:
                    queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.send_failures += 1
            self.disconnect(ws, close=True)

    async def aclose(self) -> None:
        for ws in tuple(self.connections):
            self.disconnect(ws)
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def broadcast(self, message: dict[str, Any]) -> None:
        cb = self.on_broadcast
        if cb is not None:
            try:
                cb(message)
            except Exception:
                pass
        if not self.connections:
            return
        text = json.dumps(message, ensure_ascii=False)

        # 发布者只入队，不能等待慢客户端的发送超时。
        # 队列满时断开该客户端，使其重连获取权威状态；禁止无界堆积日志。
        for ws in tuple(self.connections):
            queue = self._ensure_sender(ws)
            try:
                queue.put_nowait(text)
            except asyncio.QueueFull:
                self.send_failures += 1
                self.dropped_messages += queue.qsize() + 1
                self.disconnect(ws, close=True)


manager = ConnectionManager()
