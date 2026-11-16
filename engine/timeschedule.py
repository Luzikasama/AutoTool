"""精确录制区域的有界事件编译器。只产生计划，不操作键鼠，不依赖 Windows。"""
import math

MAX_NODES = 6000
MAX_EVENTS = 120000
MAX_TIME_MS = 86400000


def compile_segment(params, resolve=lambda value: value, default_mode='real'):
    nodes = params.get('nodes', [])
    if not isinstance(nodes, list) or len(nodes) > MAX_NODES:
        raise ValueError('精确录制区域最多支持 6,000 个键鼠节点')
    if params.get('edges'):
        raise ValueError('精确录制区域由时间轴排序，不允许流程连线；逻辑请连接在区域之前或汇合之后')
    events, ids = [], set()
    duration = 0.0

    def numeric(value, default=0, *, signed=False):
        try:
            result = float(resolve(default if value is None else value))
        except (TypeError, ValueError, OverflowError):
            raise ValueError('时序参数必须能解析为数字')
        if not math.isfinite(result) or abs(result) > MAX_TIME_MS or (not signed and result < 0):
            raise ValueError('时序参数超出有效范围')
        return result

    for index, raw in enumerate(nodes):
        if not isinstance(raw, dict) or not isinstance(raw.get('data') or {}, dict):
            raise ValueError('精确录制区域节点必须为对象')
        data = raw.get('data') or {}
        nid = raw.get('id')
        kind = data.get('nodeType') or raw.get('type')
        p = data.get('params') if data else raw.get('params')
        p = p or {}
        if not isinstance(nid, str) or not nid or nid in ids or not isinstance(p, dict):
            raise ValueError('精确录制区域存在无效或重复节点')
        ids.add(nid)
        if kind not in ('keyboard', 'mouse'):
            raise ValueError('精确录制区域仅支持键盘和鼠标；找图、判断等逻辑请连接在区域之前或汇合之后')
        timing = p.get('timeline') or {}
        if not isinstance(timing, dict):
            raise ValueError('节点 timeline 必须为对象')
        start = numeric(timing.get('start_ms'))
        start_order = numeric(timing.get('start_order'), index + 1)
        mode = 'real'
        action = str(p.get('action') or ('press' if kind == 'keyboard' else 'click'))

        def add(at, operation, *, end=False, **values):
            nonlocal duration
            if at > MAX_TIME_MS:
                raise ValueError('精确录制区域总时长超过 24 小时')
            order = numeric(timing['end_order']) if end and 'end_order' in timing else (-1 if end and at > start else start_order + (0.5 if end else 0))
            events.append(dict(at=at, order=order, node_id=nid, mode=mode, operation=operation, screen_point=point_screen, owner='track:' + nid if action not in ('down', 'up') else '__explicit__', **values))
            duration = max(duration, at)
            if len(events) > MAX_EVENTS:
                raise ValueError('时序事件超过 120,000 条，请缩短片段')

        point_screen = False
        if kind == 'keyboard':
            keys = list(dict.fromkeys(k.strip().lower() for k in str(resolve(p.get('keys') or p.get('key') or '')).split('+') if k.strip()))
            if not keys or action not in ('press', 'down', 'up'):
                raise ValueError('键盘动作或按键为空/无效')
            if action == 'up':
                for key in reversed(keys):
                    add(start, 'key_up', key=key)
            else:
                for key in keys:
                    add(start, 'key_down', key=key)
                if action == 'press':
                    end = start + numeric(p.get('hold_ms'), 30)
                    for key in reversed(keys):
                        add(end, 'key_up', end=True, key=key)
        else:
            x, y = round(numeric(p.get('x'), signed=True)), round(numeric(p.get('y'), signed=True))
            name = str(p.get('point_var') or '').strip()
            if name:
                point = resolve(name if '{{' in name else '{{' + name + '}}')
                if not isinstance(point, dict) or not all(isinstance(point.get(k), (int, float)) and math.isfinite(point[k]) for k in ('x', 'y')):
                    raise ValueError('时序动作的坐标变量不可用')
                x, y = round(point['x']), round(point['y'])
                point_screen = point.get('space') == 'screen'
            button = 'right' if action == 'right_click' else 'middle' if action == 'middle_click' else str(p.get('button') or 'left')
            if button not in ('left', 'right', 'middle'):
                raise ValueError('不支持的鼠标键')
            if action in ('down', 'up'):
                add(start, 'mouse_' + action, x=x, y=y, button=button)
            elif action == 'wheel':
                add(start, 'scroll', x=x, y=y, dx=round(numeric(p.get('dx'), signed=True)), dy=round(numeric(p.get('dy'), signed=True)))
            elif action == 'move':
                ms = numeric(p.get('duration_ms'))
                add(start, 'move_begin', x=x, y=y)
                steps = max(1, min(60, int(ms // 16))) if ms else 1
                for step in range(1, steps + 1):
                    add(start + ms * step / steps, 'move', x=x, y=y, progress=step / steps)
            elif action in ('hold', 'click', 'double_click', 'right_click', 'middle_click'):
                hold = numeric(p.get('hold_ms'), 60)
                count = 2 if action == 'double_click' else max(1, min(10, int(numeric(p.get('clicks'), 1)))) if action == 'click' else 1
                interval = numeric(p.get('interval_ms'), 40)
                end_x = round(numeric(p.get('end_x') if p.get('end_x') not in (None, '') else x, signed=True))
                end_y = round(numeric(p.get('end_y') if p.get('end_y') not in (None, '') else y, signed=True))
                for click in range(count):
                    at = start + click * (hold + interval)
                    add(at, 'mouse_down', x=x, y=y, button=button, double=click % 2 == 1)
                    add(at + hold, 'mouse_up', end=True, x=end_x, y=end_y, button=button)
            else:
                raise ValueError(f'不支持的鼠标动作：{action}')
    duration = max(duration, numeric(params.get('duration_ms')))
    repeat = numeric(params.get('repeat'), 1)
    if int(repeat) != repeat or not 1 <= repeat <= 1000:
        raise ValueError('精确录制区域重复次数必须为 1–1,000 的整数')
    events.sort(key=lambda event: (event['at'], event['order']))
    # 同一物理鼠标不能同时执行两段不同的移动轨迹。
    moves = []
    for raw in nodes:
        p = (raw.get('data') or {}).get('params') or raw.get('params') or {}
        if p.get('action') == 'move' and numeric(p.get('duration_ms')) > 0:
            a = numeric((p.get('timeline') or {}).get('start_ms'))
            moves.append((a, a + numeric(p.get('duration_ms'))))
    moves.sort()
    if any(b[0] < a[1] for a, b in zip(moves, moves[1:])):
        raise ValueError('同一鼠标的平滑移动轨迹不能重叠；请调整时间轴')
    return events, duration, int(repeat)
