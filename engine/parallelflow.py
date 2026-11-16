"""并发流程的结构与共享写入校验；不操作输入设备。"""
import math

MAX_TRACKS = 16
MAX_ACTIVE_TRACKS = 64
MAX_MS = 86400000


def finite_ms(raw, resolve=lambda value: value):
    try:
        value = float(resolve(0 if raw is None else raw))
    except (ValueError, TypeError, OverflowError):
        raise ValueError('轨道时间必须是可解析的数字')
    if not math.isfinite(value) or not 0 <= value <= MAX_MS:
        raise ValueError('轨道时间应在 0 到 24 小时之间')
    return value


def global_writes(nodes, scripts, visited=None, depth=0):
    if depth > 24:
        raise ValueError('并发流程的调用嵌套过深')
    names = set()
    for node in nodes or []:
        data = node.get('data') or {}
        kind = data.get('nodeType') or node.get('type')
        p = data.get('params') or node.get('params') or {}
        if kind == 'variable' and p.get('scope') == 'global':
            name = str((p.get('target') if p.get('action') == 'get' else p.get('name')) or '').strip()
            if '{{' in name:
                raise ValueError('并发轴的全局写入名称必须固定，不能使用动态变量名')
            if name:
                names.add(name)
        if kind == 'group':
            names.update(global_writes(p.get('nodes'), scripts, visited, depth + 1))
        if kind == 'script_call':
            sid = str(p.get('script_id') or '')
            if '{{' in sid:
                raise ValueError('并发轴不能动态选择子脚本；请使用固定脚本调用')
            seen = set(visited or ())
            if sid in seen:
                continue
            seen.add(sid)
            names.update(global_writes((scripts.get(sid) or {}).get('nodes'), scripts, seen, depth + 1))
    return names


def parallel_plan(params, scripts=None, resolve=lambda value: value):
    tracks = params.get('nodes') or []
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= MAX_TRACKS:
        raise ValueError(f'并行区域需要 1 到 {MAX_TRACKS} 条轴')
    if params.get('edges'):
        raise ValueError('并行编译结果包含无效的跨轴连线，请检查分叉与汇合')
    starts, writers = [], {}
    for track in tracks:
        data = track.get('data') or {}
        p = data.get('params') or track.get('params') or {}
        if (data.get('nodeType') or track.get('type')) != 'group':
            raise ValueError('并行区域的每条轴必须为流程容器')
        starts.append(finite_ms((p.get('timeline') or {}).get('start_ms'), resolve))
        for name in global_writes(p.get('nodes'), scripts or {}):
            if name in writers:
                raise ValueError(f'并发轴「{writers[name]}」与「{p.get("name") or track["id"]}」同时写入全局变量「{name}」，请改用局部结果或在汇合后赋值')
            writers[name] = p.get('name') or track['id']
    repeat = finite_ms(params.get('repeat', 1), resolve)
    if repeat != int(repeat) or not 1 <= repeat <= 1000:
        raise ValueError('并行区域重复次数应为 1 到 1000 的整数')
    return tracks, starts, int(repeat), finite_ms(params.get('duration_ms'), resolve)


def validate_parallel_regions(nodes, scripts):
    """启动前校验所有静态全局写入，包括被调用子脚本；不依赖运行时的时间参数。"""
    for node in nodes or []:
        p = node.get('params') or {}
        if node.get('type') != 'group':
            continue
        if p.get('execution') == 'parallel':
            parallel_plan({**p, 'repeat': 1, 'duration_ms': 0}, scripts, lambda value: 0 if isinstance(value, str) and '{{' in value else value)
        validate_parallel_regions(p.get('nodes'), scripts)
