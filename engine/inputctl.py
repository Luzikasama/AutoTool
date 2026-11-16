"""真实键鼠与可选窗口点击；租约保证并发来源互不提前释放，停止时统一清理。"""
import ctypes
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from ctypes import wintypes
import inputtrace

from pynput.keyboard import Controller as KeyboardController
from pynput.keyboard import Key
from pynput.mouse import Button
from pynput.mouse import Controller as MouseController

_mouse = MouseController()
_keyboard = KeyboardController()

user32 = ctypes.windll.user32

user32.GetCursorPos.restype = wintypes.BOOL
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]

_KEY_MAP = {
    "enter": Key.enter, "esc": Key.esc, "space": Key.space, "tab": Key.tab,
    "shift": Key.shift, "ctrl": Key.ctrl, "alt": Key.alt, "win": Key.cmd,
    "up": Key.up, "down": Key.down, "left": Key.left, "right": Key.right,
    "backspace": Key.backspace, "delete": Key.delete,
    "home": Key.home, "end": Key.end,
    "page_up": Key.page_up, "page_down": Key.page_down,
    "f1": Key.f1, "f2": Key.f2, "f3": Key.f3, "f4": Key.f4, "f5": Key.f5, "f6": Key.f6,
    "f7": Key.f7, "f8": Key.f8, "f9": Key.f9, "f10": Key.f10, "f11": Key.f11, "f12": Key.f12,
}

_MOD_KEYS = ("ctrl", "alt", "shift", "win")

# ---------- 组合键解析 ----------
def _split_combo(key: str) -> tuple[list[str], list[str]]:
    """把 "ctrl+shift+a" 拆成 (修饰键列表, 主键列表)，保持出现顺序。"""
    parts = [p.strip().lower() for p in str(key).split("+") if p.strip()]
    mods = [p for p in parts if p in _MOD_KEYS]
    mains = [p for p in parts if p not in _MOD_KEYS]
    return mods, mains


# ---------- 合成输入的「持有登记」 ----------
# 为什么要记：脚本可以「按下不放 → 延时 → 松开」，也可以多个节点先后按住同一个键。
# 只靠 pynput 自己管状态有两个问题：
#   1) 同一键被两处按住时，先松手的那一处会把键真的弹起来（另一处以为还按着）；
#   2) 流程被停止 / 抛异常时，没人去松，键就在系统层面一直按着，得手动敲一下才解开。
# 同一执行来源重复 down 必须幂等；临时组合键使用独立所有者，不释放持续按住的键。
# asyncio.to_thread 会复制 ContextVar，因此同一流程的不同工作线程仍属于同一来源。
_DEFAULT_OWNER = object()
_input_owner = ContextVar("input_owner", default=_DEFAULT_OWNER)
_input_root = ContextVar("input_root", default=None)

_held_lock = threading.RLock()
_held: dict[tuple, dict] = {}


class InputSession:
    """运行结束后撤销准入；排队的旧工作线程不得重新按下已清理的键。"""
    def __init__(self, parent=None):
        self.parent = parent
        self._closed = False

    @property
    def closed(self):
        return self._closed or bool(getattr(self.parent, 'closed', False))

    @closed.setter
    def closed(self, value):
        self._closed = bool(value)


def _belongs_to(session, owner):
    while session is not None:
        if session is owner or session == owner:
            return True
        session = getattr(session, 'parent', None)
    return False


@contextmanager
def input_session():
    """并发轴有自己的准入和清理边界，同时属于外层运行。"""
    session = InputSession(_input_root.get())
    token = _input_root.set(session)
    with input_owner(session):
        try:
            yield session
        finally:
            session.closed = True
            _input_root.reset(token)


def _require_active():
    if getattr(_input_root.get(), 'closed', False) or getattr(_input_owner.get(), 'closed', False):
        raise RuntimeError("本次输入会话已经停止")


def current_owner():
    return _input_owner.get()


@contextmanager
def input_owner(owner):
    token = _input_owner.set(owner)
    root_token = _input_root.set(owner) if _input_root.get() is None else None
    try:
        yield
    finally:
        if root_token is not None:
            _input_root.reset(root_token)
        _input_owner.reset(token)


def _backend(mode: str, hwnd: int | None):
    # 真实键鼠是全局设备，不能按绑定窗口分成互不相关的持有计数。
    return ("real", 0)


def _key_signature(key: str, mode: str, hwnd: int | None):
    return ("key", *_backend(mode, hwnd), key)


def _mouse_signature(button: str, mode: str, hwnd: int | None):
    if mode == 'background_click':
        return ('mouse', 'background_click', int(hwnd or 0), str(button))
    return ("mouse", *_backend(mode, hwnd), str(button))


def _key_primitives(key: str, mode: str, hwnd: int | None):
    """返回同一物理键的 down / up。旧 mode 参数只为读取旧工程保留。"""
    mk = _map_key(key)
    return (lambda: _keyboard.press(mk)), (lambda: _keyboard.release(mk))


def _mouse_primitives(button: str, mode: str, hwnd: int | None, x: int, y: int, double=False):
    if mode == 'background_click':
        from backgroundclick import prepare
        button_mask=lambda:sum({'left':1,'right':2,'middle':16}.get(sig[3],0) for sig in _held if sig[:3]==('mouse','background_click',int(hwnd or 0)))
        return prepare(hwnd, x, y, button, double, button_mask)
    btn = _btn(button)

    def _down():
        _mouse.position = (int(x), int(y))
        _mouse.press(btn)

    def _up(position=None):
        # 显式 mouse_up 在终点释放；异常清理只松开，不能把光标拉回 down 的起点。
        if position is not None:
            _mouse.position = (int(position[0]), int(position[1]))
        _mouse.release(btn)

    return _down, _up


def _hold(sig: tuple, primitives, owner=None) -> bool:
    """登记一次持有；只有第一个持有者真的发 down。返回是否发了 down。"""
    down, up = primitives
    if down is None:
        raise ValueError(f"不支持的输入: {sig[-1]}")
    owner = current_owner() if owner is None else owner
    with _held_lock:
        _require_active()
        ent = _held.get(sig)
        if ent:
            ent["owners"].add(owner)
            ent["roots"][owner] = _input_root.get() or owner
            return False
        _held[sig] = {"owners": {owner}, "roots": {owner: _input_root.get() or owner}, "up": up, "origin": inputtrace.location()}
        try:
            down()
            inputtrace.emit('down', device=sig[0], key=sig[3], mode=sig[1], window=sig[2])
        except BaseException:
            # 后端可能在已发送 down 后才报错；补偿失败时保留登记供收尾重试。
            try:
                up()
            except Exception:
                pass
            else:
                _held.pop(sig, None)
            raise
        return True


def _release(sig: tuple, primitives=None, strict: bool = False, *, owner=None, position=None) -> bool:
    """撤销当前所有者的持有；最后一个持有者才发 up，失败保留登记并抛出异常。

    `strict=False` 时，没有登记过的释放仍会真的发一次 up —— 保持老脚本
    「直接 up 一个键」的旧行为，不能因为加了记账就悄悄不发了。
    """
    owner = current_owner() if owner is None else owner
    with _held_lock:
        ent = _held.get(sig)
        if ent:
            if owner not in ent["owners"]:
                return False
            if len(ent["owners"]) > 1:
                ent["owners"].remove(owner)
                ent["roots"].pop(owner, None)
                return False
            if position is None:
                ent["up"]()
            else:
                ent["up"](position)
            # 只有成功释放后才删除；失败不能被伪装成已经松开。
            _held.pop(sig, None)
            inputtrace.emit('up', device=sig[0], key=sig[3], mode=sig[1], window=sig[2])
            return True
        if strict or primitives is None:
            return False
        # 原语可延迟构建，已登记的 up 不需要重新解析可能已变化的焦点窗口。
        _, up = primitives() if callable(primitives) else primitives
        if up is None:
            return False
        if position is None:
            up()
        else:
            up(position)
        inputtrace.emit('up', device=sig[0], key=sig[3], mode=sig[1], window=sig[2])
        return True


def held_keys() -> list[tuple[str, int, str]]:
    """当前还按着的 (模式, 窗口, 键/鼠标键)，诊断与测试用。"""
    with _held_lock:
        return [(sig[1], sig[2], sig[3]) for sig in _held]


def release_all(owner=None) -> int:
    """松开本进程通过合成输入按下的**全部**键与鼠标键，返回松开数量。

    指定 owner 时只清理该来源及其临时动作。失败项保留并报告，之后可重试。
    运行结束 / 停止 / 异常收尾时调用。以前停在「按下不放 → 延时」中间被停止，
    那个键会一直保持按下状态（系统层面），得手动敲一下才解开 —— 这里兜住。
    """
    with _held_lock:
        items = list(reversed(tuple(_held.items())))
        n = 0
        failures = []
        for sig, ent in items:
            if owner is not None:
                matched = {o for o in ent["owners"] if o == owner or _belongs_to(ent["roots"].get(o), owner)}
                if not matched:
                    continue
                if matched != ent["owners"]:
                    ent["owners"].difference_update(matched)
                    for item in matched:
                        ent["roots"].pop(item, None)
                    continue
            try:
                ent["up"]()
                _held.pop(sig, None)
                inputtrace.emit('up', origin=ent.get('origin'), device=sig[0], key=sig[3], mode=sig[1], window=sig[2], cleanup=True)
                n += 1
            except Exception as e:
                failures.append((sig, e))
        if failures:
            raise RuntimeError(f"有 {len(failures)} 个输入释放失败（已松开 {n} 个），保留登记以便重试") from failures[0][1]
        return n


# ---------- 公共入口 ----------
def click_down(x, y, button='left', mode='real', hwnd=None, double=False):
    with _held_lock:
        if _mouse_signature(button, mode, hwnd) in _held:
            raise ValueError('鼠标键仍被按住，不能执行独立点击')
        mouse_down(x, y, button, mode, hwnd, double=double)


def click(x: int, y: int, button: str = "left", clicks: int = 1, mode: str = "real", hwnd: int | None = None) -> None:
    with _held_lock, input_owner(object()):
        if _mouse_signature(button, mode, hwnd) in _held:
            raise ValueError("鼠标键仍被按住，不能执行独立点击")
        try:
            if mode == 'background_click':
                for index in range(max(1, min(10, int(clicks)))):
                    mouse_down(x, y, button, mode, hwnd, double=index % 2 == 1)
                    mouse_up(x, y, button, mode, hwnd)
                    if index < clicks - 1:
                        time.sleep(0.05)
            else:
                _real_click(int(x), int(y), button, int(clicks))
        finally:
            release_all(owner=current_owner())


def move(x: int, y: int, mode: str = "real", hwnd: int | None = None) -> None:
    _require_active()
    _mouse.position = (int(x), int(y))
    inputtrace.emit('move', x=x, y=y, mode='real', window=hwnd or 0)


def cursor_pos() -> tuple[int, int] | None:
    """当前鼠标的屏幕坐标；取不到（极少见）时返回 None。

    调用方是「鼠标操作-平滑移动」：它用这个点当插值起点，取不到就退化成"直接跳到目标"。
    """
    try:
        pt = wintypes.POINT()
        if user32.GetCursorPos(ctypes.byref(pt)):
            return int(pt.x), int(pt.y)
    except Exception:
        pass
    return None


def press_key(key: str, mode: str = "real", hwnd: int | None = None) -> None:
    """按下并抬起按键，支持 "ctrl+shift+a" 组合键。

    组合键当成**一次事务**：修饰键先按下、主键 down/up、修饰键最后逆序抬起。
    中途任何一步抛异常，已经按下的修饰键也会在 finally 里松开 ——
    否则一次失败就会把 Ctrl 卡在按下状态（后面所有点击都变成 Ctrl+点击）。
    """
    mods, mains = _split_combo(key)
    if not mains:
        mains = mods  # 纯修饰键（如单独 "ctrl"）按普通键处理
        mods = []
    gap = 0.0
    # 短组合键事务串行提交，不能在 Ctrl down 与 Ctrl up 之间插入另一线程的组合键。
    with _held_lock, input_owner(object()):
        try:
            for m in mods:
                prim = _key_primitives(m, mode, hwnd)
                sig = _key_signature(m, mode, hwnd)
                _hold(sig, prim)
            for k in mains:
                prim = _key_primitives(k, mode, hwnd)
                sig = _key_signature(k, mode, hwnd)
                _hold(sig, prim)
                try:
                    if gap:
                        time.sleep(gap)
                finally:
                    _release(sig, strict=True)
        finally:
            # 尝试每个修饰键，不让一个 up 失败阻止其他修饰键的释放。
            release_all(owner=current_owner())


def type_text(text: str, mode: str = "real", hwnd: int | None = None) -> None:
    _require_active()
    started = time.monotonic()
    for ch in str(text):
        _require_active()
        _keyboard.type(ch)
    inputtrace.emit('text', chars=len(str(text)), duration_ms=(time.monotonic()-started)*1000, mode='real', window=hwnd or 0)


def mouse_down(x: int, y: int, button: str = "left", mode: str = "real", hwnd: int | None = None, double=False) -> None:
    sig = _mouse_signature(button, mode, hwnd)
    _hold(sig, _mouse_primitives(button, mode, hwnd, x, y, double))


def mouse_up(x: int, y: int, button: str = "left", mode: str = "real", hwnd: int | None = None) -> None:
    sig = _mouse_signature(button, mode, hwnd)
    _release(sig, lambda: _mouse_primitives(button, mode, hwnd, x, y), position=(x, y))


def key_down(key: str, mode: str = "real", hwnd: int | None = None) -> None:
    opened = []
    with _held_lock:
        try:
            for part in dict.fromkeys(p.strip().lower() for p in str(key).split("+") if p.strip()):
                sig = _key_signature(part, mode, hwnd)
                already_owned = current_owner() in _held.get(sig, {}).get("owners", ())
                _hold(sig, _key_primitives(part, mode, hwnd))
                if not already_owned:
                    opened.append(sig)
        except BaseException:
            for sig in reversed(opened):
                try:
                    _release(sig, strict=True)
                except Exception:
                    pass  # 失败项保留登记，流程收尾仍会再次尝试。
            raise


def key_up(key: str, mode: str = "real", hwnd: int | None = None) -> None:
    parts = list(dict.fromkeys(p.strip().lower() for p in str(key).split("+") if p.strip()))
    errors = []
    with _held_lock:
        for part in reversed(parts):
            sig = _key_signature(part, mode, hwnd)
            try:
                _release(sig, lambda: _key_primitives(part, mode, hwnd))
            except Exception as e:
                errors.append(e)
        if errors:
            raise errors[0]


def scroll(dx: int, dy: int, mode: str = "real", hwnd: int | None = None,
           x: int | None = None, y: int | None = None) -> None:
    """向物理鼠标设备提交滚轮事件。"""
    _require_active()
    _mouse.scroll(int(dx), int(dy))
    inputtrace.emit('scroll', dx=dx, dy=dy, mode='real', window=hwnd or 0)


# ---------- 真实输入 ----------
def _real_click(x: int, y: int, button: str, clicks: int) -> None:
    _mouse.position = (x, y)
    time.sleep(0.05)
    for i in range(max(1, clicks)):
        mouse_down(x, y, button)
        mouse_up(x, y, button)
        if i < clicks - 1:
            time.sleep(0.05)


def _btn(button: str):
    if button == "right":
        return Button.right
    if button == "middle":
        return Button.middle
    return Button.left


def _map_key(key: str):
    k = str(key).lower()
    if k in _KEY_MAP:
        return _KEY_MAP[k]
    if len(k) == 1:
        return k
    return key
