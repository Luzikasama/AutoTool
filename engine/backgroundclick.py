"""投递窗口点击消息；不移动系统光标、不激活窗口，也不退回真实输入。"""
import ctypes
from ctypes import wintypes
from functools import lru_cache


@lru_cache(maxsize=1)
def _api():
    api = ctypes.WinDLL('user32', use_last_error=True)
    signatures = {
        'IsWindow': ([wintypes.HWND], wintypes.BOOL),
        'IsIconic': ([wintypes.HWND], wintypes.BOOL),
        'IsChild': ([wintypes.HWND, wintypes.HWND], wintypes.BOOL),
        'ScreenToClient': ([wintypes.HWND, ctypes.POINTER(wintypes.POINT)], wintypes.BOOL),
        'GetClientRect': ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
        'ChildWindowFromPointEx': ([wintypes.HWND, wintypes.POINT, wintypes.UINT], wintypes.HWND),
        'PostMessageW': ([wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(api, name)
        function.argtypes, function.restype = args, result
    return api


def _point(api, hwnd, x, y):
    point = wintypes.POINT(int(x), int(y))
    if not api.ScreenToClient(hwnd, ctypes.byref(point)):
        raise RuntimeError('后台点击坐标转换失败，目标窗口可能已关闭')
    return point


def prepare(hwnd, x, y, button='left', double=False, buttons=None):
    """down/up 固定到同一个子窗口；终点仍按屏幕坐标换算。"""
    api = _api()
    root = int(hwnd or 0)
    if not root or not api.IsWindow(root):
        raise ValueError('后台点击需要先绑定有效的目标窗口')
    if api.IsIconic(root):
        raise ValueError('后台点击目标已最小化，请先还原窗口（可以保持在后台）')
    target = root
    point = _point(api, target, x, y)
    rect = wintypes.RECT()
    if not api.GetClientRect(target, ctypes.byref(rect)) or not (0 <= point.x < rect.right and 0 <= point.y < rect.bottom):
        raise ValueError('后台点击坐标不在绑定窗口的客户区内')
    for _ in range(32):
        child = api.ChildWindowFromPointEx(target, point, 7)
        if not child or child == target or not api.IsChild(root, child):
            break
        target = child
        point = _point(api, target, x, y)
    messages = {'left': (0x0201, 0x0202, 0x0203, 1), 'right': (0x0204, 0x0205, 0x0206, 2), 'middle': (0x0207, 0x0208, 0x0209, 16)}
    if button not in messages:
        raise ValueError(f'后台点击不支持鼠标键：{button}')
    down_message, up_message, double_message, mask = messages[button]

    def post(message, keys, position=None):
        if not api.IsWindow(target) or (target != root and not api.IsChild(root, target)):
            if message == up_message:
                return
            raise RuntimeError('后台点击目标窗口已失效')
        local = _point(api, target, *(position or (x, y)))
        if not (-32768 <= local.x <= 32767 and -32768 <= local.y <= 32767):
            raise ValueError('后台点击坐标超出窗口消息支持的范围')
        packed = (local.x & 0xffff) | ((local.y & 0xffff) << 16)
        if not api.PostMessageW(target, message, keys, packed):
            error = ctypes.get_last_error()
            if error == 5:
                raise PermissionError('后台点击被权限限制阻止，请确保 AutoTool 与目标程序权限一致')
            raise OSError(error, '后台点击消息投递失败')

    pressed = False
    def down():
        nonlocal pressed
        post(double_message if double else down_message, buttons() if buttons else mask)
        pressed = True
    def up(position=None):
        nonlocal pressed
        if pressed:
            post(up_message, (buttons() & ~mask) if buttons else 0, position)
            pressed = False
    return down, up
