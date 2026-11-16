"""可靠性改动的断言测试（0.1.7）：图校验、结构提示、广播超时、按键持有、逻辑时钟。

跑法：
    python tools/test_reliability.py

这五项的共同点是「出错的时候不吵」：
- 重复节点 ID 只会静默少跑一个节点；
- 同出口多条线只会静默少走一条；
- 慢连接的广播会静默拖住整条流程；
- 没配对释放的键会静默一直按着；
- 暂停后回放会静默把事件一次性补发。

所以全部用"可观察结果"断言，而不是只看函数有没有被调用。
"""
import asyncio
import sys
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))


def _stub(name: str, **attrs) -> types.ModuleType:
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


# 无论本机是否安装 pynput 都使用假设备，测试绝不操作真实键鼠。
class _Ctl:
    position = (0, 0)

    def press(self, *a, **k):
        pass

    def release(self, *a, **k):
        pass

    def type(self, *a, **k):
        pass

    def scroll(self, *a, **k):
        pass


class _AnyAttr(type):
    """假枚举：让 inputctl 能读取 Key.enter 和 Button.left 等常量。"""

    def __getattr__(cls, name):
        return name


_kbd = types.ModuleType("pynput.keyboard")
_kbd.Controller = _Ctl
_kbd.Key = _AnyAttr("Key", (), {})
_mou = types.ModuleType("pynput.mouse")
_mou.Controller = _Ctl
_mou.Button = _AnyAttr("Button", (), {})
_pkg = types.ModuleType("pynput")
_pkg.keyboard = _kbd
_pkg.mouse = _mou
for _name, _mod in (("pynput", _pkg), ("pynput.keyboard", _kbd), ("pynput.mouse", _mou)):
    sys.modules[_name] = _mod

# 截图 / 悬浮框这些 Windows 专属模块同理：本文件不测它们，只求 import 能过
_stub(
    "overlay",
    update=lambda *a, **k: None,
    set_run_state=lambda *a, **k: None,
    set_paused=lambda *a, **k: None,
    set_repeat=lambda *a, **k: None,
    set_recording=lambda *a, **k: None,
)
_stub("vision", primary_monitor_size=lambda: (1920, 1080), grab_frame=lambda *a, **k: None)
_stub(
    "window",
    get_window_rect=lambda *a, **k: {"left": 0, "top": 0, "width": 100, "height": 100},
    capture_window=lambda *a, **k: None,
    capture_window_fast=lambda *a, **k: None,
    find_window_by_title=lambda *a, **k: None,
)

import executor  # noqa: E402
import inputctl  # noqa: E402
import ws_manager  # noqa: E402

FAILED: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
        return
    FAILED.append(name)
    print(f"  FAIL {name} {extra}")


def node(nid, ntype="delay", **params):
    return {"id": nid, "type": ntype, "params": params}


def edge(src, dst, handle=None):
    return {"id": f"{src}-{dst}-{handle or ''}", "source": src, "target": dst, "sourceHandle": handle}


# ---------------------------------------------------------------- 图校验
def test_graph_validation() -> None:
    print("[1] 严格图校验：重复 ID 不再被静默吞掉")
    dup = {"nodes": [node("a"), node("a")], "edges": []}
    try:
        executor.validate_flow(dup)
        check("重复节点 ID 被拒绝", False, "没有抛异常")
    except ValueError as e:
        check("重复节点 ID 被拒绝", "重复" in str(e), str(e))

    bad_id = {"nodes": [{"id": 1, "type": "delay", "params": {}}], "edges": []}
    try:
        executor.validate_flow(bad_id)
        check("非字符串节点 ID 被拒绝", False, "没有抛异常")
    except ValueError as e:
        check("非字符串节点 ID 被拒绝", "字符串" in str(e), str(e))

    dangling = {"nodes": [node("a")], "edges": [edge("a", "ghost")]}
    try:
        executor.validate_flow(dangling)
        check("连线指向不存在的节点被拒绝", False, "没有抛异常")
    except ValueError as e:
        check("连线指向不存在的节点被拒绝", "不存在" in str(e), str(e))

    ok = {"nodes": [node("a"), node("b")], "edges": [edge("a", "b")]}
    try:
        executor.validate_flow(ok)
        check("正常的图通过校验", True)
    except ValueError as e:
        check("正常的图通过校验", False, str(e))


def test_graph_warnings() -> None:
    print("[2] 结构提示：同出口多条线要说出来，而不是只走第一条")
    flow = {
        "nodes": [node("a", "judge"), node("b"), node("c")],
        "edges": [edge("a", "b", "yes"), edge("a", "c", "yes")],
        "scripts": {},
    }
    warns = executor.collect_graph_warnings(flow)
    check("同出口两条线产生一条提示", len(warns) == 1, str(warns))
    check("提示里写明只会走第一条", bool(warns) and "第一条" in warns[0], str(warns))

    clean = {"nodes": [node("a"), node("b")], "edges": [edge("a", "b")], "scripts": {}}
    check("单线不产生提示", executor.collect_graph_warnings(clean) == [])

    # 组合节点内部也要递归检查
    inner = {
        "nodes": [node("g", "group", nodes=[node("x"), node("y"), node("z")],
                      edges=[edge("x", "y", "out"), edge("x", "z", "out")])],
        "edges": [],
        "scripts": {},
    }
    check(
        "组合节点内部的多出口也会提示",
        any("组合节点" in w for w in executor.collect_graph_warnings(inner)),
        str(executor.collect_graph_warnings(inner)),
    )


# ---------------------------------------------------------------- 广播
class SlowSocket:
    def __init__(self) -> None:
        self.closed_by_engine = False

    async def send_text(self, _text: str) -> None:
        await asyncio.sleep(30)  # 永远发不完

    async def close(self, code=1000) -> None:
        self.closed_by_engine = True


class FastSocket:
    def __init__(self) -> None:
        self.got: list[str] = []

    async def send_text(self, text: str) -> None:
        self.got.append(text)


def test_broadcast_timeout() -> None:
    print("[3] 广播：慢连接有超时，且不影响其它连接")
    old_timeout = ws_manager.SEND_TIMEOUT_S
    ws_manager.SEND_TIMEOUT_S = 0.2
    try:
        mgr = ws_manager.ConnectionManager()
        slow, fast = SlowSocket(), FastSocket()
        mgr.connections.update({slow, fast})

        async def exercise():
            t0 = time.monotonic()
            await mgr.broadcast({"type": "log", "message": "x"})
            elapsed = time.monotonic() - t0
            check("发布消息不等待慢连接（< 0.1s）", elapsed < 0.1, f"{elapsed:.2f}s")
            deadline = time.monotonic() + 1
            while slow in mgr.connections and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            await asyncio.sleep(0)
            await mgr.aclose()

        asyncio.run(exercise())

        check("快连接照常收到消息", fast.got == ['{"type": "log", "message": "x"}'], str(fast.got))
        check("慢连接被踢掉", slow not in mgr.connections, str(len(mgr.connections)))
        check("失败计数被记下", mgr.send_failures == 1, str(mgr.send_failures))
    finally:
        ws_manager.SEND_TIMEOUT_S = old_timeout

    # 没有连接时不该报错（前后端断开后照常写日志文件）
    mgr2 = ws_manager.ConnectionManager()
    asyncio.run(mgr2.broadcast({"type": "log"}))
    check("没有连接时广播是无操作", True)


# ---------------------------------------------------------------- 按键持有
def probe():
    """一对假的按键原语：只记录调用，不碰真实键鼠。"""
    calls: list[str] = []
    return calls, (lambda: calls.append("down"), lambda: calls.append("up"))


def test_input_holds() -> None:
    print("[4] 按键持有：所有者隔离 + 收尾统一释放")
    inputctl.release_all()  # 清掉别的用例可能留下的登记
    calls, prim = probe()
    sig = ("key", "real", 0, "a")

    check("第一次持有发出 down", inputctl._hold(sig, prim, owner='a') and calls == ["down"], str(calls))
    check("同一所有者重复持有幂等", inputctl._hold(sig, prim, owner='a') is False and calls == ["down"], str(calls))
    inputctl._hold(sig, prim, owner='b')
    check("先释放的那一份不发 up", inputctl._release(sig, prim, owner='a') is False and calls == ["down"], str(calls))
    check("最后一个释放才发 up", inputctl._release(sig, prim, owner='b') is True and calls == ["down", "up"], str(calls))
    check("释放后登记清空", inputctl.held_keys() == [], str(inputctl.held_keys()))

    # 重复 up（老脚本里常见）仍要真的发一次，不能因为记账就悄悄不发
    calls2, prim2 = probe()
    inputctl._release(sig, prim2)
    check("没有登记的 up 仍然发出（兼容老脚本）", calls2 == ["up"], str(calls2))

    # 两个不同键一起按住 → release_all 全部松开
    inputctl.release_all()
    calls3, prim3 = probe()
    s1 = ("key", "real", 0, "w")
    s2 = ("key", "real", 0, "d")
    inputctl._hold(s1, prim3)
    inputctl._hold(s2, prim3)
    check("两个键都记着", len(inputctl.held_keys()) == 2, str(inputctl.held_keys()))
    n = inputctl.release_all()
    check("release_all 松开全部", n == 2 and calls3 == ["down", "down", "up", "up"], str(calls3))
    check("release_all 后没有残留", inputctl.held_keys() == [], str(inputctl.held_keys()))
    check("重复 release_all 是空操作", inputctl.release_all() == 0)


# ---------------------------------------------------------------- 逻辑时钟
def test_active_clock() -> None:
    print("[5] 逻辑时钟：暂停多久，有效进度就少算多久")
    ex = executor.Executor(lambda _m: None)
    base = time.monotonic()
    ex._paused_ms = 0.0
    time.sleep(0.05)
    normal = ex._active_ms(base, 0.0)
    check("没有暂停时≈实际耗时", 40 <= normal <= 400, f"{normal:.0f}ms")

    # 模拟"这段区间里暂停了 5000ms"
    ex._paused_ms = 5000.0
    after_pause = ex._active_ms(base, 0.0)
    check("扣除暂停后进度回退 5s", after_pause < normal - 4000, f"{after_pause:.0f}ms")

    # paused_base 只扣区间内的暂停
    ex._paused_ms = 9000.0
    scoped = ex._active_ms(base, 9000.0)
    check("paused_base 只扣本区间的暂停", scoped >= 40, f"{scoped:.0f}ms")

    ex._paused_ms = 0.0


def main() -> int:
    test_graph_validation()
    test_graph_warnings()
    test_broadcast_timeout()
    test_input_holds()
    test_active_clock()
    print()
    if FAILED:
        print(f"失败 {len(FAILED)} 项：" + "；".join(FAILED))
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
