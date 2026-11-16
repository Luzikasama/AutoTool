"""与前端相同的流程时间表投影；动态逻辑继续按路径执行。"""
import copy
import json
import math
from timeschedule import compile_segment


def timed_tracks(tracks):
    result = []
    try:
        for track in tracks:
            body = track['params']
            if body.get('variables'):
                return None
            nodes, edges = body.get('nodes') or [], body.get('edges') or []
            by_id = {n['id']: n for n in nodes}
            incoming, outgoing = set(), {}
            for edge in edges:
                incoming.add(edge['target'])
                outgoing.setdefault(edge['source'], []).append(edge)
            current = next((n['id'] for n in nodes if n['id'] not in incoming), None)
            clock = float((body.get('timeline') or {}).get('start_ms') or 0)
            if not math.isfinite(clock) or clock < 0:
                return None
            seen = set()
            while current:
                node = by_id.get(current)
                if not node or current in seen:
                    return None
                seen.add(current)
                params = copy.deepcopy(node.get('params') or {})
                action = params.get('action') or ('press' if node['type'] == 'keyboard' else 'click')
                if node.get('once') or node['type'] not in ('keyboard', 'mouse') or action in ('down', 'up') or params.get('point_var') or '{{' in json.dumps(params, ensure_ascii=False):
                    return None
                timing = params.get('timeline') or {}
                delay = float(timing.get('delay_ms') or 0)
                if not math.isfinite(delay) or delay < 0:
                    return None
                clock += delay
                probe = copy.deepcopy(node)
                probe['params'] = {**params, 'timeline': {'start_ms': 0}}
                _, duration, _ = compile_segment({'nodes': [probe]})
                params['timeline'] = {**timing, 'start_ms': clock, 'track_id': track['id']}
                result.append({**node, 'params': params})
                clock += duration
                if clock > 86400000:
                    return None
                links = outgoing.get(current) or []
                if len(links) > 1 or (links and links[0].get('sourceHandle')):
                    return None
                current = links[0]['target'] if links else None
            if len(seen) != len(nodes):
                return None
        return result
    except (ValueError, TypeError, OverflowError, KeyError):
        return None
