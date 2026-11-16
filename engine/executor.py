"""流程执行器：图执行（六大类节点、判断分支、循环、终止、子脚本嵌套）。

分辨率自适应：
- 流程可携带 screen={width,height}（保存时的主显示器物理分辨率）与
  window.rect（保存时绑定窗口的位置尺寸）。
- 运行时若当前分辨率/窗口尺寸与参考值不同，点击与宏坐标按比例换算，
  使脚本可跨分辨率/跨 DPI 复用；模板匹配的分辨率自适应见 vision.match_template_auto。

控制流（《节点设计规范 V1》第 2 节）：
- 判断 / 循环 有两个出口，用连线上的 sourceHandle 区分：
    判断：`yes` / `no`      循环：`body`（循环体）/ `next`（循环结束后继续）
- 循环体末尾连回循环节点自身，表示"这一轮结束、进入下一轮"。
- 终止分三级：`loop`（break 出最内层循环）/ `script`（当前脚本返回）/ `workflow`（整次运行停止）。
  用异常实现（BreakLoop / EndScript）——嵌套循环时"break 最近一层"的语义天然正确。

子脚本（嵌套调用）：
- 流程可携带 scripts={id: {id, name, nodes, edges, variables}}（子脚本库），
  「调用脚本」节点按 params.script_id 就地展开执行。
- 防递归三道防线（见 scriptgraph.py）：编辑器拦截 / 运行前整图环检测 /
  运行时调用栈 + MAX_SCRIPT_DEPTH。

组合节点（0.1.4 起，「合并节点」的产物）：
- 一个 `group` 节点把内部 nodes/edges 直接存在它自己的 params 里（不是外部脚本库），
  执行时在**子作用域**里就地走一遍。它对上层的控制流是**透明**的：
  内部触发的「终止-结束当前脚本 / 结束当前循环」会穿透到外层，
  所以"把一段流程合并起来"不会改变这段流程原本的语义。

变量作用域（0.1.4 起改为层级）：
- 主脚本那一份是「全局变量」，子脚本 / 组合节点各自持有「局部变量」；
- 读逐级往上找、写只落本层，见 runvars.VarScope。
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import uuid
import subprocess
import time
import traceback
from typing import Any, Callable

import inputctl
import appconfig
import inputtrace
from parallelflow import parallel_plan, finite_ms, MAX_ACTIVE_TRACKS, validate_parallel_regions
from timeschedule import compile_segment
from flatgraph import compile_flow
import nodes as nodemod
import overlay
import vision
import window
from runvars import VarScope, eval_conditions, interpolate, resolve
from scriptgraph import MAX_SCRIPT_DEPTH, name_map, normalize_scripts, validate_scripts

# 悬浮框里显示的节点中文名（25 个核心节点）
_STEP_LABEL = {
    # ① 输入
    'mouse': '鼠标操作',
    'keyboard': '键盘按键',
    'text_input': '文本输入',
    'clipboard': '剪贴板',
    # ② 视觉
    'find_image': '图像识别',
    'ocr': '文字识别',
    'color_check': '颜色检测',
    'pixel_check': '像素检测',
    'region_analysis': '区域分析',
    # ③ 流程
    'judge': '判断',
    'loop': '循环',
    'delay': '延时',
    'wait': '等待',
    'terminate': '终止',
    # ④ 工具
    'record': '键鼠录制',
    'autoclick': '连点器',
    'script_call': '调用脚本',
    'external_tool': '外部工具',
    # ⑤ 数据
    'variable': '变量',
    'calculate': '运算',
    'text_process': '文本处理',
    # ⑥ 系统
    'window': '窗口',
    'process': '进程',
    'file': '文件',
    'command': '命令',
    # 容器节点（不属于六大类）：由「合并节点」产生，双击可进入编辑
    'group': '组合节点',
}

# 0.1.2 及更早的步骤类型 → 0.1.3 节点类型。
# 前端加载时已经升级过一次；这里再兜一层，是为了「手改 JSON / 别人给的旧文件 /
# 从旧版 Release 里直接加载到引擎」这些绕过前端的入口。
_LEGACY_TYPES = {
    'click': 'mouse',
    'key': 'keyboard',
    'text': 'text_input',
    'macro': 'record',
}


class BreakLoop(Exception):
    """终止「当前循环这一轮」——由最内层循环捕获。"""


class EndScript(Exception):
    """结束「当前脚本」——由 _run_graph 捕获（子脚本即返回调用方）。"""


def normalize_type(t: Any) -> str:
    """把（可能的）老步骤类型归一成新节点类型。"""
    s = str(t or '')
    return _LEGACY_TYPES.get(s, s)


# 组合节点（容器节点）的类型名。它**不属于六大类的 25 个核心节点**：
# 「合并节点」把画布上选中的一串相邻节点装进它内部，双击可进入编辑。
GROUP_NODE = 'group'

# 组合节点允许的最大嵌套层数。
#
# 组合节点的内部图是**嵌在节点参数里**的，天然不可能成环（不像子脚本可以互相调用），
# 所以这里只需防"手工改 JSON 手滑嵌套几千层"这种极端输入。
MAX_GROUP_DEPTH = 16


def _validate_graph(nodes, edges, where: str, depth: int = 0) -> None:
    """校验一张图（根流程 / 子脚本 / 组合节点内部）的节点与连线，非法时抛 ValueError。

    组合节点把内部图放在自己的 params 里，所以这里要**递归**下去 ——
    否则一个"内部连线指向不存在节点"的组合节点会一直藏到运行时才炸。
    """
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError(f"{where}的 nodes/edges 必须是数组")
    ids = set()
    for n in nodes:
        if not isinstance(n, dict) or not n.get("id"):
            raise ValueError(f"{where}里存在缺少 id 的节点")
        nid = n["id"]
        if not isinstance(nid, str):
            raise ValueError(f"{where}里节点 id 必须是字符串: {nid!r}")
        # 重复 id 会让 node_map 静默丢掉一个节点：画布上看得见、跑起来当它不存在，
        # 编辑中途出错（复制粘贴、手改文件）很容易撞上，必须在这里拦下。
        if nid in ids:
            raise ValueError(f"{where}里节点 id 重复: {nid!r}")
        ids.add(nid)
        if n.get("params") is not None and not isinstance(n["params"], dict):
            raise ValueError(f"{where}里节点 {nid!r} 的 params 必须是对象")
    for e in edges:
        if (not isinstance(e, dict)
                or not isinstance(e.get("source"), str)
                or not isinstance(e.get("target"), str)
                or e["source"] not in ids or e["target"] not in ids):
            raise ValueError(f"{where}里存在指向不存在节点的连线: {e!r}")
        if e.get("sourceHandle") is not None and not isinstance(e["sourceHandle"], str):
            raise ValueError(f"{where}里连线 sourceHandle 必须是字符串")
    if depth >= MAX_GROUP_DEPTH:
        raise ValueError(f"{where}的组合节点嵌套层数超过上限（{MAX_GROUP_DEPTH} 层）")
    for n in nodes:
        if normalize_type(n.get("type")) != GROUP_NODE:
            continue
        params = n.get("params") or {}
        execution = params.get('execution')
        if execution not in (None, '', 'flow', 'timeline', 'parallel'):
            raise ValueError(f'未知容器执行方式: {execution}')
        inner_nodes, inner_edges = params.get("nodes", []), params.get("edges", [])
        label = str(params.get("name") or "组合节点")
        _validate_graph(inner_nodes, inner_edges, f"{where} → 组合节点「{label}」", depth + 1)
        if params.get('execution') == 'timeline':
            if inner_edges or len(inner_nodes) > 6000:
                raise ValueError('精确录制区域只使用时间关系，不能包含流程连线，最多 6,000 个动作')
            if any(normalize_type(child.get('type')) not in ('keyboard', 'mouse') for child in inner_nodes):
                raise ValueError('精确录制区域仅支持键鼠节点，逻辑节点请连接在区域之前或汇合之后')
            # 动态坐标/按键/时间在进入片段时统一解析，全部验证后才发送第一个输入。
            if '{{' not in str(params):
                compile_segment(params)
        elif execution == 'parallel' and '{{' not in str(params):
            parallel_plan(params)


def validate_flow(flow: dict) -> None:
    """校验流程结构，非法时抛 ValueError（避免执行器带着脏数据运行）。"""
    if not isinstance(flow, dict):
        raise ValueError("流程必须是 JSON 对象")
    nodes = flow.get("nodes", [])
    edges = flow.get("edges", [])
    try:
        repeat = int(flow.get("repeat", 1))
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"循环轮数无效: {flow.get('repeat')!r}")
    if not 1 <= repeat <= 100000:
        raise ValueError(f"循环轮数超出范围(1~100000): {repeat}")
    _validate_graph(nodes, edges, "主脚本")

    scripts = flow.get("scripts", {})
    if scripts is None:
        scripts = {}
    if not isinstance(scripts, dict):
        raise ValueError("脚本 scripts 必须是对象")
    for key, sub in scripts.items():
        if not isinstance(sub, dict):
            raise ValueError(f"子脚本 {key!r} 必须是对象")
        sub_nodes = sub.get("nodes", [])
        sub_edges = sub.get("edges", [])
        # 允许空脚本（刚新建、还没来得及编辑），但不允许结构损坏
        _validate_graph(sub_nodes, sub_edges, f"子脚本「{sub.get('name') or key}」")


def collect_graph_warnings(flow: dict) -> list[str]:
    """结构合法、但很可能不是用户本意的图 —— 运行前提示一次，不阻止执行。

    目前只有一条：**同一个出口连了多条线**。执行器只会走第一条（见 `_pick_target`），
    其余连线在运行时被静默忽略：用户以为做了分支，实际只有一条生效。
    真分支要用「判断」节点。
    """
    out: list[str] = []

    def walk(nodes, edges, where: str, depth: int = 0) -> None:
        if depth > MAX_GROUP_DEPTH:
            return
        counts: dict[tuple[str, str], int] = {}
        for e in edges or []:
            if not isinstance(e, dict):
                continue
            key = (str(e.get("source")), str(e.get("sourceHandle") or ""))
            counts[key] = counts.get(key, 0) + 1
        for (src, handle), n in counts.items():
            if n > 1:
                out.append(
                    f"{where}里节点「{src}」的出口「{handle or '默认'}」连了 {n} 条线，"
                    f"执行时只会走第一条；需要分支请用「判断」节点"
                )
        for nd in nodes or []:
            if not isinstance(nd, dict) or normalize_type(nd.get("type")) != GROUP_NODE:
                continue
            params = nd.get("params") or {}
            inner_nodes = params.get("nodes") or []
            inner_edges = params.get("edges") or []
            if not inner_nodes and not inner_edges:
                continue
            walk(
                inner_nodes,
                inner_edges,
                f"{where} → 组合节点「{params.get('name') or '组合节点'}」",
                depth + 1,
            )

    walk(flow.get("nodes") or [], flow.get("edges") or [], "主脚本")
    for key, sub in (flow.get("scripts") or {}).items():
        if isinstance(sub, dict):
            walk(sub.get("nodes") or [], sub.get("edges") or [], f"子脚本「{sub.get('name') or key}」")
    return out


class Executor:
    @property
    def stopped(self):
        parent = getattr(self, '_parent_executor', None)
        return parent.stopped if parent is not None else self._stopped

    @stopped.setter
    def stopped(self, value):
        parent = getattr(self, '_parent_executor', None)
        if parent is not None:
            parent.stopped = bool(value)
        else:
            self._stopped = bool(value)

    @property
    def paused(self):
        parent = getattr(self, '_parent_executor', None)
        return parent.paused if parent is not None else self._paused

    @paused.setter
    def paused(self, value):
        parent = getattr(self, '_parent_executor', None)
        if parent is not None:
            parent.paused = value
        else:
            self._paused = bool(value)

    def __init__(self, broadcast: Callable[[dict], Any]) -> None:
        self.broadcast = broadcast
        self.stopped = False
        self.running = False
        self.run_generation = 0
        # 暂停：与停止不同，暂停只是让流程停在检查点上，resume() 后从原地继续
        self.paused = False
        self.current_flow: dict | None = None
        self.task: "asyncio.Task | None" = None
        # 本次运行的子脚本库（id → 子脚本），由 run() 从流程里取出
        self.scripts: dict[str, dict] = {}
        # 运行时调用栈（第三道防递归防线）：元素 {"id","name"}；根脚本不占位
        self.call_stack: list[dict] = []
        # 悬浮框当前显示的「第几轮 / 共几轮」（子脚本内部沿用外层进度）
        self._ov_loop = 0
        self._ov_total = 0
        # 暂停累计时长（毫秒）。宏回放/按住时长都按「有效时间」算进度，
        # 暂停多久就扣多久 —— 否则恢复那一刻会把暂停期间该发的事件一次性补发出去。
        self._paused_ms = 0.0
        self._pause_started: float | None = None
        self._failed_input_owner = None
        self.input_cleanup_error = ''
        self._input_session = None
        self.input_trace: inputtrace.InputTrace | None = None

        # ---- 一次运行的执行上下文（run() 里设置，节点实现直接读）----
        self.vars = VarScope()
        # 持续动作与键盘使用真实输入；点击后端由本次运行的全局设置决定。
        self.input_mode = 'real'
        self._default_input_mode = 'real'
        self.background_click = False
        # 组合节点嵌套深度（见 MAX_GROUP_DEPTH）
        self._group_depth = 0
        self.window_hwnd: int | None = None
        self.scale: Callable[[Any, Any], tuple[int, int]] | None = None
        # 当前节点往悬浮框/日志里报的"一句话结果"（节点实现可写）
        self.last_message = ''
        self._active_tracks = set()
        self._pointer_gate = None

    # ------------------------------------------------------------------ 状态

    def stop(self) -> None:
        if getattr(self, '_parent_executor', None) is not None:
            self._parent_executor.stop()
            return
        self.stopped = True
        if self._input_session is not None:
            self._input_session.closed = True
        # 停止时一并清掉暂停：否则「暂停中停止」会让暂停等待循环一直挂着
        self.resume()
        if self.task is None or self.task.done():
            self.running = False

    def pause(self) -> None:
        if getattr(self, '_parent_executor', None) is not None:
            self._parent_executor.pause()
            return
        if self.running and not self.paused:
            self._pause_started = time.monotonic()
            self.paused = True

    def resume(self) -> None:
        if getattr(self, '_parent_executor', None) is not None:
            self._parent_executor.resume()
            return
        if self._pause_started is not None:
            self._paused_ms += (time.monotonic() - self._pause_started) * 1000.0
            self._pause_started = None
        self.paused = False

    def _pause_total_ms(self) -> float:
        parent = getattr(self, '_parent_executor', None)
        if parent is not None:
            return parent._pause_total_ms()
        ongoing = (time.monotonic() - self._pause_started) * 1000.0 if self._pause_started is not None else 0.0
        return self._paused_ms + ongoing

    async def wait_if_paused(self) -> None:
        """暂停等待点。

        只放在「节点边界」与「延时的小睡之间」两处：
        - 这两处都不是"做到一半"的状态，恢复后从原地继续即可，不会重复已完成的动作
        - 刻意不放进找图/等待的轮询里：那里的超时按 time.time() 算，
          在里面停住会把暂停时长也算进超时，恢复后立刻误判超时

        暂停时间在 pause/resume 边界计量；多个等待者不会重复累计同一次暂停。
        """
        while self.paused and not self.stopped:
            await asyncio.sleep(0.05)

    async def sleep(self, seconds: float) -> None:
        """按单调有效时间等待，每 50ms 检查一次停止与暂停。"""
        duration = max(0.0, float(seconds))
        base, paused_base = time.monotonic(), self._pause_total_ms()
        while True:
            if self.stopped:
                return
            await self.wait_if_paused()
            if self.stopped:
                return
            left = duration - self._active_ms(base, paused_base) / 1000.0
            if left <= 0:
                return
            await asyncio.sleep(min(0.05, left))

    def _active_ms(self, since: float, paused_base: float = 0.0) -> float:
        """从 `since` 到现在的**有效耗时**（毫秒，扣掉暂停）。

        `paused_base` 是起始时刻 `_paused_ms` 的读数：只扣"这段区间内"的暂停，
        不把之前别处的暂停算进来。
        """
        return (time.monotonic() - since) * 1000.0 - (self._pause_total_ms() - paused_base)

    def reconcile(self) -> bool:
        """把 running 与实际任务状态对齐，返回修正后的 running。"""
        if self.running and (self.task is None or self.task.done()):
            self.running = False
        if not self.running:
            self.resume()
        return self.running

    async def log(self, level: str, msg: str, step: str | None = None) -> None:
        if level == 'error':
            inputtrace.emit('node_error', **({'node_id':str(step)} if step else {}))
        await self.broadcast(
            {"type": "log", "level": level, "message": msg, "step": step, "ts": time.time()}
        )
        # 广播现在只入队；纯变量/零延时流程也必须给停止请求和发送任务执行机会。
        await asyncio.sleep(0)

    async def _state(self, state: str) -> None:
        try:
            overlay.set_run_state(state == "running")
        except Exception:
            pass
        await self.broadcast(
            {"type": "state", "state": state, "paused": bool(self.paused), "ts": time.time()}
        )

    @staticmethod
    def _ov(loop: int, total: int, step: str) -> None:
        """更新悬浮框。悬浮框只是显示层，任何异常都不能影响流程执行。"""
        try:
            overlay.update(loop, total, step)
        except Exception:
            pass

    def _ov_text(self, step: str) -> None:
        """只改悬浮框的步骤文字，轮数沿用当前外层循环进度。"""
        self._ov(self._ov_loop, self._ov_total, step)

    def _step_text(self, node: dict) -> str:
        ntype = normalize_type(node.get("type"))
        label = _STEP_LABEL.get(ntype, ntype)
        extra = ''
        if self.last_message:
            extra = self.last_message
        elif ntype == 'delay':
            p = node.get("params") or {}
            extra = f"{p.get('ms', 0)} ms"
        return f"{label} {extra}".strip()

    # ------------------------------------------------------------ 截图 / 坐标

    def grab(self, scope_mode: str = 'auto'):
        """按范围截图，返回 (BGR 帧, 屏幕偏移 x, 屏幕偏移 y)。

        偏移量是"帧内坐标 → 屏幕坐标"要加的值：
          · 整屏截图 → (0, 0)
          · 窗口截图 → 窗口左上角在屏幕上的位置
        旧代码在找图里手工加过一次 offset，在判断里忘了加 —— 统一从这里出，
        就不会再出现"找图和判断坐标不一致"这类只有换窗口才暴露的问题。
        """
        use_window = scope_mode == 'window' or (scope_mode == 'auto' and self.window_hwnd)
        if use_window and self.window_hwnd:
            rect = window.get_window_rect(self.window_hwnd)
            # mss 区域截图：快，但要求窗口可见
            return window.capture_window_fast(self.window_hwnd), rect['left'], rect['top']
        return vision.grab_frame(), 0, 0

    def grab_region(self, region: dict):
        """按"屏幕坐标的矩形"截图（OCR / 颜色检测的自定义区域走这里）。"""
        frame = vision.grab_frame(
            {
                'left': int(region.get('left', 0)),
                'top': int(region.get('top', 0)),
                'width': max(1, int(region.get('width', 1))),
                'height': max(1, int(region.get('height', 1))),
            }
        )
        return frame, int(region.get('left', 0)), int(region.get('top', 0))

    # ------------------------------------------------------------- 命令行

    async def run_shell(self, cmd: str, cwd: str | None, timeout_ms: int, shell: str) -> tuple[int, str]:
        """执行一条命令，返回 (退出码, 输出文本)。

        刻意用 subprocess.run + 线程而不是 asyncio 子进程：
        Windows 上 asyncio 子进程要求 ProactorEventLoop，而不同的 ASGI 运行配置
        （以及某些事件循环策略）会让它直接抛 NotImplementedError —— 挂机中途
        「命令」节点炸掉比"慢一点"糟糕得多。
        """
        if shell == 'powershell':
            argv = ['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd]
        elif shell == 'bash':
            argv = ['bash', '-lc', cmd]
        else:
            argv = ['cmd', '/c', cmd]

        def _run() -> tuple[int, str]:
            try:
                proc = subprocess.run(  # noqa: S603 - 用户显式配置的命令
                    argv,
                    cwd=cwd or None,
                    capture_output=True,
                    timeout=max(0.1, timeout_ms / 1000.0),
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                code = int(proc.returncode)
                out = nodemod.decode_output(proc.stdout or b'') + nodemod.decode_output(proc.stderr or b'')
                return code, out
            except subprocess.TimeoutExpired as e:
                out = nodemod.decode_output(e.stdout or b'') + nodemod.decode_output(e.stderr or b'')
                return -1, out + f'\n[超时] 命令超过 {timeout_ms} ms 未结束，已放弃等待'

        try:
            return await asyncio.to_thread(_run)
        except FileNotFoundError as e:
            return -1, f'[失败] 找不到可执行文件：{e}'
        except Exception as e:
            return -1, f'[失败] {e}'

    # ------------------------------------------------------------ 录制回放

    async def _replay_events(self, events: list, speed: float) -> None:
        """回放一段录制的键鼠事件（速度 = 时间轴的压缩倍率）。

        进度按**有效时间**算（扣掉暂停），否则暂停 10 秒后恢复，
        这 10 秒会被当成"已经过了这么久"，剩下的事件在同一瞬间全部补发出去。
        """
        base = time.monotonic()
        paused_base = self._pause_total_ms()
        origin = self.input_trace.active_ms() if self.input_trace else 0
        for ev in events:
            await self.wait_if_paused()
            if self.stopped:
                return
            target = float(ev.get('t', 0)) / speed
            wait = target - self._active_ms(base, paused_base)
            if wait > 0:
                await self.sleep(wait / 1000.0)
            await self.wait_if_paused()
            if self.stopped:
                return
            etype = ev.get('type')
            device='key' if etype in ('keydown','keyup') else 'mouse' if etype in ('mousedown','mouseup') else 'motion' if etype=='mousemove' else 'wheel'
            action='down' if etype in ('keydown','mousedown') else 'up' if etype in ('keyup','mouseup') else str(etype)
            key=str(ev.get('key') or '') if device=='key' else str(ev.get('button') or 'left')
            with inputtrace.scope(call_id=uuid.uuid4().hex,expected_start_ms=origin+target):
                inputtrace.emit('node_start',device=device,key=key,expected_key=key,action=action,timing_kind='fixed')
                status='finished'
                try:
                    if etype in ('mousemove', 'mousedown', 'mouseup', 'scroll'):
                        x, y = ev.get('x', 0), ev.get('y', 0)
                        if self.scale:
                            x, y = self.scale(x, y)
                        if etype == 'mousemove':
                            await asyncio.to_thread(inputctl.move, x, y, self.input_mode, self.window_hwnd)
                        elif etype == 'mousedown':
                            await asyncio.to_thread(
                                inputctl.mouse_down, x, y, ev.get('button', 'left'), self.input_mode, self.window_hwnd
                            )
                        elif etype == 'mouseup':
                            await asyncio.to_thread(
                                inputctl.mouse_up, x, y, ev.get('button', 'left'), self.input_mode, self.window_hwnd
                            )
                        else:
                            await asyncio.to_thread(
                                inputctl.scroll, ev.get('dx', 0), ev.get('dy', 0), self.input_mode, self.window_hwnd, x, y
                            )
                    elif etype == 'keydown':
                        await asyncio.to_thread(inputctl.key_down, str(ev.get('key', '')), self.input_mode, self.window_hwnd)
                    elif etype == 'keyup':
                        await asyncio.to_thread(inputctl.key_up, str(ev.get('key', '')), self.input_mode, self.window_hwnd)
                except Exception as e:
                    status='failed'
                    inputtrace.emit('node_error')
                    await self.log('warn', f'回放事件失败({etype}): {e}')
                finally:
                    inputtrace.emit('node_end',status='stopped' if self.stopped else status)

    # ---------------------------------------------------------------- 主入口

    def _make_scaler(self, flow: dict, hwnd):
        """构造坐标换算函数。返回 (scale_fn, 说明) 或 (None, None)。"""
        win = flow.get("window")
        ref_rect = win.get("rect") if isinstance(win, dict) else None
        if hwnd and isinstance(ref_rect, dict) and ref_rect.get("width") and ref_rect.get("height"):
            rw, rh = float(ref_rect["width"]), float(ref_rect["height"])
            rl, rt = float(ref_rect.get("left", 0)), float(ref_rect.get("top", 0))

            def scale_by_window(x, y):
                try:
                    rect = window.get_window_rect(hwnd)
                except Exception:
                    return int(x), int(y)
                if rect["width"] <= 0 or rect["height"] <= 0:
                    return int(x), int(y)
                nx = rect["left"] + (float(x) - rl) * rect["width"] / rw
                ny = rect["top"] + (float(y) - rt) * rect["height"] / rh
                return int(round(nx)), int(round(ny))

            return scale_by_window, f"窗口参考 {int(rw)}x{int(rh)}"

        ref_screen = flow.get("screen")
        if isinstance(ref_screen, dict) and ref_screen.get("width") and ref_screen.get("height"):
            rw, rh = float(ref_screen["width"]), float(ref_screen["height"])
            try:
                cur_w, cur_h = vision.primary_monitor_size()
            except Exception:
                return None, None
            if rw <= 0 or rh <= 0:
                return None, None
            if abs(cur_w / rw - 1) < 0.01 and abs(cur_h / rh - 1) < 0.01:
                return None, None  # 分辨率一致，无需换算

            def scale_by_screen(x, y):
                return int(round(float(x) * cur_w / rw)), int(round(float(y) * cur_h / rh))

            return scale_by_screen, f"屏幕参考 {int(rw)}x{int(rh)} → 当前 {cur_w}x{cur_h}"

        return None, None

    def prepare_run(self) -> None:
        self.stopped = False
        self.resume()
        self._paused_ms = 0.0
        self._pause_started = None
        self._input_session = None
        self.running = True
        self.run_generation += 1
        self._active_tracks = set()
        self._pointer_gate = asyncio.Lock()

    async def run(self, flow: dict, *, prepared: bool = False) -> None:
        if not prepared:
            self.prepare_run()
        # 每次运行独立持有输入；收尾不会松开调试接口或其他来源持有的键。
        session = inputctl.InputSession()
        self._input_session = session
        meta = flow if isinstance(flow, dict) else {}
        recorder = inputtrace.InputTrace(str(meta.get('name') or ''), str(meta.get('client_doc_id') or ''), self._pause_total_ms)
        self.input_trace = recorder
        with inputctl.input_owner(session), inputtrace.scope(
            recorder=recorder, script_id=str(meta.get('source_script_id') or ''),
            group_path=list(meta.get('source_group_path') or []), node_id='', node_type='', path=str(meta.get('name') or '主脚本'),
        ):
            try:
                await self._run_flow(flow)
            finally:
                recorder.finish()

    async def _run_flow(self, flow: dict) -> None:
        self.current_flow = flow
        # 关键：置位 running 之后的全部逻辑都必须落在 try/finally 内。
        self.running = True
        self.call_stack = []
        try:
            if self.stopped:
                return
            if self._failed_input_owner is not None:
                await asyncio.to_thread(inputctl.release_all, owner=self._failed_input_owner)
                self._failed_input_owner = None
                self.input_cleanup_error = ''
            self.scripts = normalize_scripts(flow.get("scripts") if isinstance(flow, dict) else None)
            self._ov_loop, self._ov_total = 0, 0
            self.vars = VarScope()
            self.vars.seed(flow.get("variables") if isinstance(flow, dict) else None)
            self._group_depth = 0
            self.last_message = ''
            await self._state("running")
            self._ov(0, 0, "准备中…")

            try:
                validate_flow(flow)
                flow = compile_flow(flow)
                validate_flow(flow)
                self.scripts = normalize_scripts(flow.get('scripts'))
                validate_parallel_regions(flow.get('nodes'), self.scripts)
                for script in self.scripts.values():
                    validate_parallel_regions(script.get('nodes'), self.scripts)
                repeat = max(1, int(flow.get("repeat", 1)))
            except ValueError as e:
                await self.log("error", f"流程数据无效，已拒绝执行: {e}")
                return

            problems = validate_scripts(flow)
            if problems:
                for msg in problems:
                    for line in str(msg).split("\n"):
                        await self.log("error", line)
                await self.log("error", "脚本调用关系有问题，本次拒绝执行（原因见上面的日志）")
                return

            # 结构上没问题、但很可能不是用户本意的地方：提示一次再跑，不拦
            try:
                for warn in collect_graph_warnings(flow):
                    await self.log("warn", warn)
            except Exception as e:  # 提示逻辑本身不该影响执行
                await self.log("warn", f"结构提示检查失败（不影响执行）: {e}")

            nodes = flow.get("nodes", [])
            edges = flow.get("edges", [])
            # 统一使用真实键鼠。
            self._default_input_mode = 'real'
            self.input_mode = self._default_input_mode
            self.background_click = bool(appconfig.get('background_click', False))
            win = flow.get("window")
            self.window_hwnd = win.get("hwnd") if isinstance(win, dict) else None

            await self.log(
                "info",
                f"开始执行「{flow.get('name', '未命名')}」：{len(nodes)} 个节点 × {repeat} 轮，"
                '真实键鼠'
                + ('；点击投递至绑定窗口（不移动光标，响应取决于目标软件）' if self.background_click else '')
                + (f"，内嵌 {len(self.scripts)} 个子脚本" if self.scripts else ""),
            )
            try:
                self.scale, scale_desc = self._make_scaler(flow, self.window_hwnd)
            except Exception as e:
                self.scale, scale_desc = None, None
                await self.log("warn", f"分辨率适配计算失败，将按原坐标执行: {e}")
            if self.scale:
                await self.log("info", f"分辨率/窗口尺寸适配已启用（{scale_desc}），坐标将按比例换算")

            await self._run_graph(nodes, edges, repeat)
            if self.stopped:
                return
            await self.log("info", "流程执行完成")
            self._ov(repeat, repeat, "流程执行完成")
        except Exception as e:
            await self.log("error", f"执行异常: {e}")
            self._ov(0, 0, f"执行异常：{e}")
            traceback.print_exc()
        finally:
            if self._input_session is not None:
                self._input_session.closed = True
            self.call_stack = []
            # 收尾必做：关闭本次会话准入，再松开本次运行及临时动作持有的键。
            # 脚本停在「按下不放 → 延时」中间被停止或抛异常时，不主动松开的话，
            # 那个键会在系统层面一直保持按下，用户得手动敲一下才能解开。
            # 放在 state(idle) 之前：让前端看到的"已结束"是真的干净了。
            try:
                released = await asyncio.to_thread(inputctl.release_all, owner=inputctl.current_owner())
                if released:
                    await self.log("warn", f"收尾：已自动松开 {released} 个未配对释放的按键")
            except Exception as e:
                self._failed_input_owner = inputctl.current_owner()
                self.input_cleanup_error = str(e)
                try:
                    await self.log("error", f"输入清理失败，下一次运行前必须重试清理: {e}")
                except Exception:
                    pass
            self.running = False
            self.resume()
            try:
                await self._state("idle")
            except Exception:
                pass

    async def _run_graph(
        self, nodes: list, edges: list, repeat: int, scope: str = "", as_script: bool = True, timed: bool = False
    ) -> None:
        """走完一张流程图（根脚本 / 某一层子脚本 / 某个组合节点内部），共 repeat 轮。

        子脚本一律 repeat=1：循环由最外层决定，这样"调用脚本"与"把这些节点直接
        合并进主流程"（合并节点）的运行语义才一致。

        as_script=False（组合节点内部）时**不吞** EndScript / BreakLoop ——
        组合节点只是把一段流程装起来，里面写的"结束当前脚本 / 结束当前循环"
        应该照旧作用到真正的脚本 / 循环上。
        """
        prefix = f"{scope}：" if scope else ""
        node_map = {n["id"]: n for n in nodes}
        adj: dict[str, list[tuple[str, str]]] = {}
        for e in edges:
            adj.setdefault(e["source"], []).append((e.get("sourceHandle") or "", e["target"]))
        starts = self._entry_nodes(nodes, edges)
        if not starts:
            await self.log("error", f"{prefix}流程缺少起始节点，这一段不会执行")
            return
        if len(starts) > 1:
            await self.log("warn", f"{prefix}存在 {len(starts)} 个起始节点，仅从 {starts[0]} 开始执行")
        unreachable = [nid for nid in node_map if nid not in self._reachable(adj, starts[0])]
        if unreachable:
            await self.log("warn", f"{prefix}{len(unreachable)} 个节点从起始节点不可达，不会执行: {unreachable}")
        start_id = starts[0]
        executed_once: set[str] = set()

        try:
            for r in range(repeat):
                if self.stopped:
                    await self.log("warn", f"{prefix}已手动停止")
                    if not scope:
                        self._ov(r + 1, repeat, "已手动停止")
                    return
                if not scope:
                    self._ov_loop, self._ov_total = r + 1, repeat
                    await self.log("info", f"--- 第 {r + 1}/{repeat} 轮 ---")
                    self._ov(r + 1, repeat, "本轮开始")
                else:
                    await self.log("debug", f"{prefix}开始（第 {r + 1}/{repeat} 遍）")
                with inputtrace.scope(**({'round': r + 1} if not scope else {})):
                    if not scope:
                        inputtrace.emit('round_start', round=r + 1)
                    try:
                        await self._walk(start_id, node_map, adj, prefix, executed_once, timed=timed)
                    finally:
                        if not scope:
                            inputtrace.emit('round_end', round=r + 1)
        except EndScript:
            if not as_script:
                raise
            await self.log("info", f"{prefix}脚本被「终止」节点结束")
        except BreakLoop:
            if not as_script:
                raise
            # 顶层（不在任何循环里）用了「结束当前循环」：没有循环可结束，当作这一段结束
            await self.log("warn", f"{prefix}「终止」节点设置了结束循环，但这里不在任何循环里，已忽略")
        if self.stopped:
            return

    async def _walk(
        self,
        start_id: str,
        node_map: dict,
        adj: dict,
        prefix: str,
        executed_once: set[str],
        stop_id: str | None = None,
        timed: bool = False,
    ) -> str:
        """从 start_id 顺着连线走，直到终端 / stop_id / 停止。

        返回 'end'（走到尽头）/ 'backedge'（走到 stop_id，即循环体回到循环节点）/ 'overflow'。
        """
        current: str | None = start_id
        ready_ms = inputtrace.location().get('expected_entry_ms')
        if ready_ms is None:
            ready_ms = self.input_trace.active_ms() if self.input_trace else 0
        visited = 0
        max_steps = max(1000, len(node_map) * 100)
        while current and not self.stopped:
            if stop_id and current == stop_id:
                return 'backedge'
            await self.wait_if_paused()
            if self.stopped:
                break
            visited += 1
            if visited > max_steps:
                await self.log(
                    "error", f"{prefix}单轮执行超过 {max_steps} 步（疑似无终止条件的环），已停止"
                )
                self.stopped = True
                return 'overflow'
            node = node_map.get(current)
            if not node:
                break
            ntype = normalize_type(node.get("type"))
            params = node.get("params") or {}
            once = bool(node.get("once"))

            # 单次执行：后续轮次跳过，但仍沿连线继续（判断/终止节点没有"执行"的意义）
            if once and current in executed_once and ntype not in ('judge', 'loop', 'terminate'):
                outs = adj.get(current, [])
                current = outs[0][1] if outs else None
                continue

            self.last_message = ''
            scheduled_end = None
            try:
                delay_ms = finite_ms((params.get('timeline') or {}).get('delay_ms'), lambda value: resolve(value, self.vars))
                expected_start = ready_ms + delay_ms
                wait_ms = max(0, expected_start-self.input_trace.active_ms()) if timed and self.input_trace else delay_ms
                if wait_ms:
                    await self.sleep(wait_ms / 1000)
                if self.stopped:
                    break
                await self.log("debug", f"{prefix}节点: {ntype}", current)
                self._ov_text(f"{prefix}{_STEP_LABEL.get(ntype, ntype)}")
                with inputtrace.scope(node_id=str(current), node_type=ntype, path=prefix or '主脚本', expected_start_ms=expected_start, expected_delay_ms=delay_ms, expected_entry_ms=None, **({'group_path':params['_canvas_path']} if '_canvas_path' in params else {})):
                    timed_input = ntype == 'keyboard' and params.get('action') not in ('down','up') or ntype == 'mouse' and self.background_click and params.get('action','click') in ('click','double_click','right_click','middle_click')
                    if timed and self.input_trace and timed_input:
                        action = {**node, 'params': {**params, 'timeline': {**(params.get('timeline') or {}), 'start_ms': 0}}}
                        duration = await self._exec_timeline({'nodes': [action], '_inline': True, '_origin_ms': expected_start}, prefix)
                        scheduled_end = expected_start + duration if duration is not None else None
                        branch = None
                    else:
                        branch = await self._exec_observed(node, ntype, params, node_map, adj, prefix)
            except (BreakLoop, EndScript):
                raise  # 控制信号，交给循环 / 脚本作用域处理
            except Exception as e:
                # 广播层或节点框架出问题也不能静默消失，更不能把整轮挂掉：
                # 记到当前节点名下，然后沿默认出口继续（挂机场景更稳）
                await self.log("error", f"{prefix}节点执行失败({ntype}): {e}", current)
                inputtrace.emit('node_error', node_id=str(current), **({'group_path':params['_canvas_path']} if '_canvas_path' in params else {}))
                if getattr(self, '_in_parallel', False):
                    raise
                branch = None
            executed_once.add(current)
            ready_ms = scheduled_end if scheduled_end is not None else self.input_trace.active_ms() if self.input_trace else 0

            if branch is None:
                outs = adj.get(current, [])
                current = outs[0][1] if outs else None
            else:
                current = self._pick_target(adj.get(current, []), branch)
        return 'end'

    @staticmethod
    def _pick_target(outs: list[tuple[str, str]], handle: str) -> str | None:
        """按出口名挑下一个节点。

        找不到该出口的连线时**退回默认出口**（sourceHandle 为空的那条）：
        画布上"判断节点只连了一条线"很常见（用户还在搭），这种时候不应该直接断流。
        """
        for h, t in outs:
            if h == handle:
                return t
        for h, t in outs:
            if not h:
                return t
        return None

    async def _exec_node(
        self, node: dict, ntype: str, params: dict, node_map: dict, adj: dict, prefix: str
    ) -> str | None:
        """执行一个节点。返回出口名（分支节点）或 None（普通节点 / 已处理）。"""
        # 节点共享真实输入后端，保留内部调用签名以兼容旧执行接口。
        self.input_mode = 'real'

        if ntype == 'terminate':
            await self._do_terminate(params, prefix)
            return None

        if ntype == 'judge':
            try:
                ok = eval_conditions(params, self.vars)
            except Exception as e:
                await self.log("error", f"{prefix}判断条件求值失败（{e}），按「否」分支继续")
                ok = False
            self.last_message = '是' if ok else '否'
            await self.log("info", f"{prefix}判断 → {'是' if ok else '否'}")
            return 'yes' if ok else 'no'

        if ntype == 'loop':
            await self._exec_loop(node, ntype, params, node_map, adj, prefix)
            return 'next'

        if ntype == 'script_call':
            await self._call_script(params, prefix)
            return None

        if ntype == GROUP_NODE:
            where = inputtrace.location()
            with inputtrace.scope(group_path=[*where.get('group_path', []), str(node['id'])]):
                await self._exec_group(params, prefix)
            return None

        handler = nodemod.HANDLERS.get(ntype)
        if handler is None:
            await self.log("warn", f"{prefix}未知节点类型: {ntype}")
            return None
        try:
            pointer = ntype == 'autoclick' or (ntype == 'mouse' and params.get('action', 'click') in ('move', 'click', 'double_click', 'right_click', 'middle_click'))
            if pointer and self._pointer_gate is not None:
                async with self._pointer_gate:
                    if not self.stopped:
                        await handler(self, params)
            else:
                await handler(self, params)
        except Exception as e:
            # 单步失败只记录，不中断整个流程（挂机场景更稳）
            await self.log("error", f"{prefix}节点执行失败({ntype}): {e}", node.get("id"))
            inputtrace.emit('node_error', error=str(e)[:200])
            if getattr(self, '_in_parallel', False):
                raise
        return None

    @staticmethod
    def _trace_description(ntype, p):
        device = 'key' if ntype == 'keyboard' else 'text' if ntype == 'text_input' else ('motion' if p.get('action') == 'move' else 'wheel' if p.get('action') == 'wheel' else 'mouse') if ntype in ('mouse','autoclick') else 'flow'
        key = str(p.get('keys') or p.get('key') or '') if ntype == 'keyboard' else ('right' if p.get('action') == 'right_click' else 'middle' if p.get('action') == 'middle_click' else str(p.get('button') or 'left')) if ntype in ('mouse','autoclick') else _STEP_LABEL.get(ntype, ntype)
        return dict(device=device, key=key, label=_STEP_LABEL.get(ntype, ntype), action=str(p.get('action') or ''), mode='real')

    async def _exec_observed(self, node, ntype, params, node_map, adj, prefix):
        observed = ntype not in ('group', 'record')
        with inputtrace.scope(call_id=uuid.uuid4().hex):
            status = 'finished'
            if observed:
                inputtrace.emit('node_start', **self._trace_description(ntype, params), **self._trace_expectation(ntype, params))
            try:
                branch = await self._exec_node(node, ntype, params, node_map, adj, prefix)
                return branch
            except BaseException as error:
                status = 'finished' if isinstance(error, (BreakLoop, EndScript)) else 'cancelled'
                raise
            finally:
                if observed:
                    inputtrace.emit('node_end', status='stopped' if self.stopped else status, branch=locals().get('branch'))

    def _trace_expectation(self, ntype, p):
        """从本次执行参数解析比较基准，未知耗时不伪装成固定时长。"""
        from runvars import interpolate, resolve
        def ms(key, default=0):
            return finite_ms(p.get(key, default), lambda value: resolve(value, self.vars))
        try:
            if ntype == 'keyboard':
                return dict(expected_key=interpolate(str(p.get('keys') or p.get('key') or ''), self.vars), expected_duration_ms=ms('hold_ms', 30) if p.get('action') not in ('down','up') else None, timing_kind='fixed')
            if ntype == 'mouse':
                duration = ms('hold_ms',60) if p.get('action')=='hold' else ms('duration_ms') if p.get('action')=='move' else None
                button = 'right' if p.get('action')=='right_click' else 'middle' if p.get('action')=='middle_click' else interpolate(str(p.get('button') or 'left'),self.vars)
                clicks = 2 if p.get('action')=='double_click' else max(1,min(10,int(ms('clicks',1)))) if p.get('action','click')=='click' else 1 if p.get('action') in ('right_click','middle_click') else None
                if clicks is not None:
                    duration=clicks*ms('hold_ms',60)+(clicks-1)*ms('interval_ms',40)
                return dict(expected_key=button, expected_clicks=clicks, expected_duration_ms=duration, timing_kind='fixed')
            if ntype == 'autoclick':
                count=max(1,min(100000,int(ms('count',10))))
                return dict(expected_key=str(p.get('button') or 'left'), expected_clicks=count, expected_duration_ms=count*ms('interval_ms',100),timing_kind='fixed')
            if ntype == 'text_input':
                length=len(interpolate(str(p.get('text') or ''),self.vars))
                clipboard=p.get('method')=='clipboard'
                return dict(expected_key='ctrl+v' if clipboard else '',expected_chars=None if clipboard else length,expected_duration_ms=150 if clipboard else length*ms('interval_ms',10) if ms('interval_ms',10)>0 else None,timing_kind='fixed')
            if ntype == 'delay':
                return dict(expected_duration_ms=ms('ms'), timing_kind='fixed')
            if ntype in ('find_image','wait'):
                return dict(expected_duration_ms=ms('timeout_ms'), timing_kind='budget')
        except Exception:
            pass
        return dict(timing_kind='unknown')

    async def _exec_group(self, params: dict, prefix: str) -> None:
        """执行「组合节点」：把内部那张图在**子作用域**里就地走一遍。

        - 组合节点是**透明**的：内部触发的「结束当前脚本 / 结束当前循环」会穿透到外层
          （`as_script=False`），所以合并 / 拆开不会改变这段流程的语义。
        - 内部只能跑一遍（repeat=1）：循环由最外层决定，和子脚本一致。
        - 局部变量：params.variables 声明的值会在进入时初始化到子作用域。
        """
        if params.get('execution') == 'parallel':
            with self._child_scope(params.get('variables')):
                await self._exec_parallel(params, prefix)
            return
        if params.get('execution') == 'timeline':
            with self._child_scope(params.get('variables')):
                await self._exec_timeline(params, prefix)
            return
        nodes = params.get('nodes') or []
        edges = params.get('edges') or []
        name = str(params.get('name') or '组合节点')
        if not nodes:
            await self.log('warn', f'{prefix}组合节点「{name}」里没有节点，已跳过')
            return
        if self._group_depth >= MAX_GROUP_DEPTH:
            await self.log(
                'error',
                f'{prefix}组合节点「{name}」嵌套层数超过上限（{MAX_GROUP_DEPTH} 层），已跳过',
            )
            return

        await self.log('info', f'{prefix}进入组合节点「{name}」（{len(nodes)} 个节点）')
        self._group_depth += 1
        try:
            with self._child_scope(params.get('variables')):
                await self._run_graph(
                    nodes, edges, 1, scope=f'组合节点「{name}」', as_script=False, timed=bool(params.get('_unified_timing'))
                )
        finally:
            self._group_depth -= 1
        if self.stopped:
            return
        await self.log('info', f'{prefix}组合节点「{name}」执行完成')

    async def _exec_parallel(self, params: dict, prefix: str) -> None:
        """每轴独立上下文，共享停止/暂停；出口等待全部轴，异常取消并清理兄弟任务。"""
        from runvars import resolve
        tracks, starts, repeat, minimum = parallel_plan(params, self.scripts, lambda value: resolve(value, self.vars))
        tasks = []
        primary = str(params.get('primary_track') or tracks[0]['id'])
        parallel_origin = 0

        async def run_track(track, offset):
            if len(self._active_tracks) >= MAX_ACTIVE_TRACKS:
                raise ValueError('同时活动的并发轴超过 64 条')
            marker = object()
            self._active_tracks.add(marker)
            child = copy.copy(self)
            child._parent_executor = self
            child.call_stack = list(self.call_stack)
            child._group_depth = self._group_depth + 1
            child._in_parallel = True
            p = track.get('params') or {}
            label = str(p.get('name') or track['id'])
            where = inputtrace.location()
            path = [*where.get('group_path', []), track['id']]
            track_id = '/'.join([where.get('script_id', ''), *path])
            parent_axis = where.get('axis_id') or ('main' if where.get('primary', True) else where.get('track_id')) or 'main'
            axis_id = parent_axis if track['id'] == primary else track_id
            try:
                with inputctl.input_session() as session, inputtrace.scope(
                    track_id=track_id, axis_id=axis_id, track_label=label, primary=axis_id == 'main',
                    group_path=path, node_id='', path=f'{prefix}{label}',
                    expected_entry_ms=parallel_origin+offset,
                ):
                    try:
                        await child.sleep(offset / 1000)
                        if child.stopped:
                            return
                        inputtrace.emit('track_start', label=label)
                        await child._exec_group(p, f'{prefix}{label}：')
                    finally:
                        session.closed = True
                        await asyncio.to_thread(inputctl.release_all, owner=session)
                        inputtrace.emit('track_end', label=label)
            finally:
                self._active_tracks.discard(marker)

        for iteration in range(repeat):
            if self.stopped:
                return
            base, paused_base = time.monotonic(), self._pause_total_ms()
            parallel_origin = self.input_trace.active_ms() if self.input_trace else 0
            with inputtrace.scope(segment_iteration=iteration + 1):
                tasks = [asyncio.create_task(run_track(track, start)) for track, start in zip(tracks, starts)]
                try:
                    await asyncio.gather(*tasks)
                    remaining = minimum - self._active_ms(base, paused_base)
                    if remaining > 0:
                        await self.sleep(remaining / 1000)
                except BaseException as error:
                    if not isinstance(error, (BreakLoop, EndScript, asyncio.CancelledError)):
                        self.stop()
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    raise

    async def _exec_timeline(self, params: dict, prefix: str) -> None:
        """单一逻辑时钟调度交错的 down/up；每个条带持有独立所有者。"""
        from runvars import resolve
        events, duration, repeat = compile_segment(params, lambda value: resolve(value, self.vars), self._default_input_mode or 'real')
        inline = bool(params.get('_inline'))
        if not inline:
            await self.log('info', f'{prefix}键鼠时间表「{params.get("name") or "未命名"}」：{len(events)} 个事件 × {repeat}')
        raw_nodes = {node['id']: node.get('data') or node for node in params.get('nodes') or []}
        last_events = {event['node_id']: index for index, event in enumerate(events)}
        first_events, compiled_keys = {}, {}
        for event in events:
            nid = event['node_id']
            first_events.setdefault(nid, event)
            if event['operation'].startswith('key_'):
                keys = compiled_keys.setdefault(nid, [])
                if event['key'] not in keys:
                    keys.append(event['key'])
        track_names = {str(track['id']): str(track.get('name') or track['id']) for track in params.get('tracks') or [] if isinstance(track, dict) and track.get('id')}
        invocation = uuid.uuid4().hex
        for iteration in range(repeat):
            if self.stopped:
                return
            owners = {event['owner']: object() for event in events}
            motion_starts = {}
            opened = {}
            base, paused_base = time.monotonic(), self._pause_total_ms()
            timeline_origin = params['_origin_ms'] if inline else self.input_trace.active_ms() if self.input_trace else 0
            elapsed = (lambda: self.input_trace.active_ms()-timeline_origin) if inline else (lambda: self._active_ms(base, paused_base))
            try:
                for index, event in enumerate(events):
                    wait = event['at'] - elapsed()
                    if wait > 0:
                        await self.sleep(wait / 1000)
                    await self.wait_if_paused()
                    if self.stopped:
                        break
                    operation, mode = event['operation'], event['mode']
                    nid = event['node_id']
                    x, y = event.get('x', 0), event.get('y', 0)
                    if self.scale and 'x' in event and not event.get('screen_point'):
                        x, y = self.scale(x, y)
                    raw = raw_nodes[nid]
                    p = raw.get('params') or {}
                    if self.background_click and operation.startswith('mouse_') and p.get('action', 'click') in ('click','double_click','right_click','middle_click'):
                        mode = 'background_click'
                    track = str((p.get('timeline') or {}).get('track_id') or 'main')
                    location = inputtrace.location()
                    track_id = '/'.join([location.get('script_id', ''), *location.get('group_path', []), track])
                    parent_axis = location.get('axis_id') or ('main' if location.get('primary', True) else location.get('track_id')) or 'main'
                    axis_id = parent_axis if track == str(params.get('primary_track') or 'main') else track_id
                    axis = dict(track_id=track_id, axis_id=axis_id, track_label=track_names.get(track, '主轴' if track == 'main' else track), primary=axis_id == 'main')
                    if inline:
                        axis = {key: location[key] for key in ('track_id','axis_id','track_label','primary') if key in location}
                    first = first_events[nid]
                    updates = dict(node_id=nid, node_type='keyboard' if operation.startswith('key_') else 'mouse', call_id=f'{invocation}:{iteration}:{nid}', segment_iteration=iteration + 1, expected_start_ms=timeline_origin+first['at'], configured_start_ms=first['at'],expected_delay_ms=location.get('expected_delay_ms') if inline else None, **axis, **({'group_path':p['_canvas_path']} if '_canvas_path' in p else {}))
                    with inputctl.input_owner(owners[event['owner']]), inputtrace.scope(**updates):
                        if nid not in opened:
                            opened[nid] = updates
                            # 基准来自已编译的计划，避免并发写入变量后再次解析出不同值。
                            # 时序条带共享同键持有，物理边沿可以合法合并。
                            expectation = dict(timing_kind='fixed',expected_key='+'.join(compiled_keys[nid]) if nid in compiled_keys else first.get('button',''),expected_duration_ms=None if p.get('action') in ('down','up') else events[last_events[nid]]['at']-first['at'])
                            inputtrace.emit('node_start', **self._trace_description(updates['node_type'], p), **expectation)
                        if operation.startswith('key_'):
                            await asyncio.to_thread(getattr(inputctl, operation), event['key'], mode, self.window_hwnd)
                        elif operation.startswith('mouse_'):
                            extra = {'double': True} if mode == 'background_click' and operation == 'mouse_down' and event.get('double') else {}
                            await asyncio.to_thread(getattr(inputctl, operation), x, y, event['button'], mode, self.window_hwnd, **extra)
                        elif operation == 'scroll':
                            await asyncio.to_thread(inputctl.scroll, event['dx'], event['dy'], mode, self.window_hwnd, x, y)
                        elif operation == 'move_begin':
                            motion_starts[nid] = await asyncio.to_thread(inputctl.cursor_pos) or (x, y)
                        elif operation == 'move':
                            sx, sy = motion_starts.get(nid, (x, y))
                            ratio = event['progress']
                            await asyncio.to_thread(inputctl.move, round(sx + (x-sx)*ratio), round(sy + (y-sy)*ratio), mode, self.window_hwnd)
                        if last_events[nid] == index:
                            inputtrace.emit('node_end', status='finished')
                            opened.pop(nid, None)
                if not self.stopped:
                    remaining = duration - elapsed()
                    if remaining > 0:
                        await self.sleep(remaining / 1000)
            finally:
                errors = []
                for owner in reversed(list(owners.values())):
                    try:
                        await asyncio.to_thread(inputctl.release_all, owner=owner)
                    except Exception as error:
                        errors.append(error)
                for updates in opened.values():
                    with inputtrace.scope(**updates):
                        inputtrace.emit('node_end', status='stopped' if self.stopped else 'cancelled')
                if errors:
                    raise RuntimeError('精确录制区域输入清理失败，运行收尾将重试') from errors[0]
        return duration

    @contextlib.contextmanager
    def _child_scope(self, declared):
        """临时把 self.vars 换成子作用域（读向上找、写只落本层）。"""
        prev = self.vars
        self.vars = prev.child(declared)
        try:
            yield self.vars
        finally:
            self.vars = prev

    async def _do_terminate(self, params: dict, prefix: str) -> None:
        """终止节点：按 level 决定终止范围。"""
        level = str(params.get('level') or 'workflow')
        msg = interpolate(params.get('message') or '', self.vars).strip()
        tail = f"（{msg}）" if msg else ""
        if level == 'loop':
            await self.log("info", f"{prefix}终止：结束当前循环{tail}")
            self._ov_text("结束当前循环")
            raise BreakLoop
        if level == 'script':
            await self.log("info", f"{prefix}终止：结束当前脚本{tail}")
            self._ov_text("结束当前脚本")
            raise EndScript
        await self.log("info", f"{prefix}终止：停止整个工作流{tail}")
        self._ov_text("已终止工作流")
        self.stopped = True

    async def _exec_loop(self, node: dict, ntype: str, params: dict, node_map: dict, adj: dict, prefix: str) -> None:
        """循环节点。

        循环体从 `body` 出口出去，末尾连回循环节点自身（或 dead-end）表示"这一轮结束"。
        循环结束后由调用方从 `next` 出口继续。

        安全阀：条件循环 / 无限循环都必须有 max_iterations（界面默认 1000），
        否则一个"条件永远为真"的循环会把程序挂死，而用户完全无从下手。
        """
        mode = str(params.get('mode') or 'times')
        outs = adj.get(node.get('id'), [])
        body_start = self._pick_target(outs, 'body')
        index_var = interpolate(params.get('index_var') or '', self.vars).strip()
        interval_ms = max(0, int(self._safe_float(params.get('interval_ms'), 0)))
        loop_id = node.get('id')

        if mode == 'times':
            total = max(1, min(1000000, int(self._safe_float(params.get('times'), 10))))
            plan = f'固定 {total} 次'
        elif mode == 'condition':
            total = max(1, min(10000000, int(self._safe_float(params.get('max_iterations'), 1000))))
            plan = f'条件循环（上限 {total} 轮）'
        else:
            total = max(1, min(10000000, int(self._safe_float(params.get('max_iterations'), 1000))))
            plan = f'无限循环（上限 {total} 轮）'

        if not body_start:
            await self.log('warn', f'{prefix}循环节点没有连「循环体」出口，{plan} 只会空转等待')
        await self.log('info', f'{prefix}循环开始：{plan}')

        done = 0
        for i in range(total):
            if self.stopped:
                return
            if mode == 'condition':
                try:
                    if not eval_conditions(params, self.vars):
                        await self.log('info', f'{prefix}循环：条件不再满足，提前结束（已跑 {done} 轮）')
                        break
                except Exception as e:
                    await self.log('error', f'{prefix}循环条件求值失败（{e}），提前结束')
                    break
            if index_var:
                self.vars.set(index_var, i + 1)
            self._ov_text(f'{prefix}循环 {i + 1}/{total}')
            if body_start:
                try:
                    await self._walk(
                        body_start, node_map, adj, f'{prefix}循环体·第{i + 1}轮', set(), stop_id=loop_id
                    )
                except BreakLoop:
                    await self.log('info', f'{prefix}循环：被「终止」节点中断（已跑 {i + 1} 轮）')
                    done = i + 1
                    break
            done = i + 1
            if interval_ms > 0:
                await self.sleep(interval_ms / 1000.0)
        else:
            if mode != 'times':
                await self.log('warn', f'{prefix}循环：达到最大轮数 {total} 仍未满足退出条件，已强制结束')
        await self.log('info', f'{prefix}循环结束：共 {done} 轮')

    @staticmethod
    def _safe_float(raw, default: float) -> float:
        try:
            v = float(str(raw).strip()) if not isinstance(raw, (int, float)) else float(raw)
        except (TypeError, ValueError):
            return float(default)
        return v if v == v else float(default)  # NaN 兜底

    async def _call_script(self, params: dict, prefix: str) -> None:
        """执行「调用脚本」：把子脚本那一层图就地走一遍。"""
        sid = interpolate(params.get('script_id') or '', self.vars).strip()
        if not sid:
            await self.log("error", f"{prefix}调用脚本：这一步还没有选择要调用的子脚本，已跳过")
            return

        sub = self.scripts.get(sid)
        if sub is None:
            have = "、".join(f"「{n}」" for n in name_map(self.scripts).values()) or "（本文件里没有任何子脚本）"
            await self.log(
                "error",
                f"{prefix}调用脚本：找不到要调用的脚本「{params.get('name') or sid}」。"
                f"这份脚本里现有的子脚本是：{have}。"
                "请在编辑器里重新选择，或把缺失的子脚本导入回来。",
            )
            return

        chain_names = [f"「{e['name']}」" for e in self.call_stack] + [f"「{sub['name']}」"]
        chain = " → ".join(chain_names)
        for e in self.call_stack:
            if e["id"] == sid:
                await self.log(
                    "error",
                    f"{prefix}调用脚本：检测到循环调用，已停止这一支。\n调用链：{chain}\n"
                    "（脚本之间不允许互相调用成环，请打断其中一条调用）",
                )
                return
        if len(self.call_stack) >= MAX_SCRIPT_DEPTH:
            await self.log(
                "error",
                f"{prefix}调用脚本：嵌套层数超过上限（{MAX_SCRIPT_DEPTH} 层），已停止这一支。\n调用链：{chain}",
            )
            return

        nodes = sub.get("nodes") or []
        if not nodes:
            await self.log("warn", f"{prefix}调用脚本：子脚本「{sub['name']}」是空的，已跳过")
            return

        await self.log("info", f"{prefix}进入子脚本「{sub['name']}」（第 {len(self.call_stack) + 1} 层）")
        self.call_stack.append({"id": sid, "name": sub["name"]})
        try:
            # 子脚本有自己的「局部变量」：进入时初始化到子作用域，
            # 里面新建/改动的变量**不会**回流到调用方（要共享就显式写全局）。
            with self._child_scope(sub.get("variables")), inputtrace.scope(script_id=sid, group_path=[]):
                await self._run_graph(nodes, sub.get("edges") or [], 1, scope=f"子脚本「{sub['name']}」")
        finally:
            # 异常安全出栈：漏掉一次 pop，之后所有调用都会被误判成"嵌套过深"
            self.call_stack.pop()
        if self.stopped:
            return
        await self.log("info", f"{prefix}子脚本「{sub['name']}」执行完成")

    @staticmethod
    def _reachable(adj: dict, start: str) -> set[str]:
        seen: set[str] = set()
        stack = [start]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(t for _, t in adj.get(cur, []))
        return seen

    @staticmethod
    def _entry_nodes(nodes: list, edges: list) -> list[str]:
        """找流程入口节点。

        朴素做法是「没有入边的节点」，但循环体末尾会连回循环节点自身，
        于是循环节点也有了入边 —— 一个「以循环开头」的流程反而找不到入口。
        这里先识别出成环的节点对（互相可达），把**环内部的边**排除后再算入度，
        循环节点就能重新作为入口被选出来。
        """
        ids = [n["id"] for n in nodes]
        idset = set(ids)
        g: dict[str, list[str]] = {i: [] for i in ids}
        for e in edges:
            s, t = e.get("source"), e.get("target")
            if s in idset and t in idset:
                g[s].append(t)

        def reach_from(start: str) -> set[str]:
            seen: set[str] = set()
            stack = [start]
            while stack:
                cur = stack.pop()
                if cur in seen:
                    continue
                seen.add(cur)
                stack.extend(g.get(cur, ()))
            return seen

        reach = {i: reach_from(i) for i in ids}
        indeg = {i: 0 for i in ids}
        for e in edges:
            s, t = e.get("source"), e.get("target")
            if s not in idset or t not in idset:
                continue
            if t in reach[s] and s in reach[t]:
                continue  # 环内部的边（含循环体回边），不算入度
            indeg[t] += 1
        entries = [i for i in ids if indeg[i] == 0]
        if entries:
            return entries
        # 整张图就是一个环、没有外部入口：优先挑循环节点当入口
        for n in nodes:
            if normalize_type(n.get("type")) == "loop":
                return [n["id"]]
        return ids[:1]
