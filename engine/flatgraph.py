"""平面分叉/汇合图编译。编译结果只供执行器使用，不回写工程。"""
import copy
from unifiedtiming import timed_tracks


def lower_graph(nodes, edges, depth=0):
    if depth > 16:
        raise ValueError('并发/作用域嵌套不能超过 16 层')
    nodes, edges = copy.deepcopy(nodes or []), copy.deepcopy(edges or [])
    by_id = {n['id']: n for n in nodes}
    if len(by_id) != len(nodes):
        raise ValueError('节点 ID 重复')
    out = {}
    for e in edges:
        if e.get('source') not in by_id or e.get('target') not in by_id:
            raise ValueError('连线指向不存在的节点')
        out.setdefault(e['source'], []).append(e)
    regions = [n for n in nodes if n.get('type') in ('parallel', 'scope')]
    if not regions:
        if any(n.get('type') == 'join' for n in nodes):
            raise ValueError('汇合节点缺少配对分叉')
        return nodes, edges
    used, replacement, join_owner = set(), {}, {}
    # 外层区域先收集，递归编译内部区域。
    def reachable(start, stop):
        seen, pending = set(), [start]
        while pending:
            key = pending.pop()
            if key == stop or key in seen:
                continue
            if key not in by_id:
                raise ValueError('分支包含不存在的节点')
            seen.add(key)
            pending.extend(e['target'] for e in out.get(key, []))
        return seen
    regions.sort(key=lambda n: -len(reachable(n['id'], (n.get('params') or {}).get('join_id'))))
    for fork in regions:
        fid = fork['id']
        if fid in used:
            continue
        p = fork.get('params') or {}
        jid = p.get('join_id')
        if not jid or by_id.get(jid, {}).get('type') != 'join' or jid == fid:
            raise ValueError('并行分支/作用域需要连接对应的汇合节点')
        if jid in join_owner:
            raise ValueError('一个汇合节点只能属于一个分叉')
        if len(out.get(jid, [])) > 1:
            raise ValueError('汇合节点只能有一条后续路径')
        if (by_id[jid].get('params') or {}).get('fork_id', fid) != fid:
            raise ValueError('分叉与汇合配对不一致')
        join_owner[jid] = fid
        if fork['type'] == 'scope':
            branches = [{'id': 'main', 'name': p.get('name') or '作用域'}]
        else:
            branches = p.get('branches') or [{'id': 'main', 'name': '主轴'}, {'id': 'side1', 'name': '副轴 1'}]
        if not isinstance(branches, list) or not 1 <= len(branches) <= 16 or any(not isinstance(b,dict) or not isinstance(b.get('id'),str) or not b['id'].strip() for b in branches) or len({b['id'] for b in branches}) != len(branches):
            raise ValueError('并行分支需要 1–16 条不同的执行轴')
        members, tracks, entries, track_of = set(), [], [], {}
        for b in branches:
            links = [e for e in out.get(fid, []) if (e.get('sourceHandle') or 'main') == b['id']]
            if len(links) > 1:
                raise ValueError('每个分支出口只能连接一条路径')
            entry = links[0]['target'] if links else jid
            ids = reachable(entry, jid)
            if fid in ids or jid in ids or members & ids:
                raise ValueError('并发路径应在配对汇合点连接，不能交叉进入其他分支或返回分叉')
            members.update(ids)
            track_of.update({key:b['id'] for key in ids})
            entries.append(entry)
            sub = [n for n in nodes if n['id'] in ids]
            # 保持唯一入口位于最前；空分支也是合法的执行路径。
            sub.sort(key=lambda n: n['id'] != entry)
            se = [e for e in edges if e['source'] in ids and e['target'] in ids]
            sn, se = lower_graph(sub, se, depth + 1)
            tracks.append({'id': b['id'], 'type': 'group', 'params': {
                'name': b.get('name') or b['id'], 'nodes': sn, 'edges': se,
                'variables': b.get('variables') or [], 'execution': 'flow',
                'timeline': {'start_ms': b.get('start_ms', 0)},
            }})
        known_ports = {b['id'] for b in branches}
        if any((e.get('sourceHandle') or 'main') not in known_ports for e in out.get(fid, [])):
            raise ValueError('连线使用了不存在的并行出口')
        if any(e['target'] in members and e['source'] not in members | {fid} for e in edges):
            raise ValueError('不能从外部进入并行路径内部，请连接分叉或汇合后的节点')
        if any(e['target'] == jid and e['source'] not in members | {fid} for e in edges):
            raise ValueError('汇合点不能接收其他并发区域的路径')
        params = {k: v for k, v in p.items() if k not in ('branches', 'join_id', 'timing')}
        params['name'] = p.get('name') or ('并行执行' if fork['type'] == 'parallel' else '作用域')
        if fork['type'] == 'scope':
            params.update(execution='flow', nodes=tracks[0]['params']['nodes'], edges=tracks[0]['params']['edges'])
        elif p.get('timing') == 'absolute':
            if any(by_id[key].get('type') not in ('keyboard', 'mouse') for key in members):
                raise ValueError('精确录制区域只接受键鼠动作；请将逻辑节点接到区域之前或汇合之后')
            timed_nodes=[n for n in nodes if n['id'] in members]
            for n in timed_nodes:
                n.setdefault('params',{}).setdefault('timeline',{})['track_id']=track_of[n['id']]
            params.update(execution='timeline', nodes=timed_nodes, edges=[],
                          tracks=[{'id': b['id'], 'name': b.get('name') or b['id']} for b in branches])
        else:
            params.update(execution='parallel', nodes=tracks, edges=[])
            if p.get('timing') == 'unified':
                for track in tracks:
                    track['params']['_unified_timing'] = True
                timed = timed_tracks(tracks)
                if timed:
                    params.update(execution='timeline', nodes=timed, tracks=[{'id': b['id'], 'name': b.get('name') or b['id']} for b in branches], _unified_axes=True)
        replacement[fid] = {**fork, 'type': 'group', 'params': params}
        used.update(members | {jid})
    if any(n.get('type') == 'join' and n['id'] not in used for n in nodes):
        raise ValueError('汇合节点缺少配对分叉')
    result = [replacement.get(n['id'], n) for n in nodes if n['id'] not in used]
    result_edges = []
    for e in edges:
        if e['source'] in join_owner:
            if e['target'] in used:
                raise ValueError('汇合出口不能返回自己的并发区域')
            result_edges.append({**e, 'source':join_owner[e['source']]})
            continue
        if e['source'] in used or e['target'] in used:
            continue
        if e['source'] in replacement:
            continue
        result_edges.append(e)
    return result, result_edges


def compile_flow(flow):
    result = copy.deepcopy(flow)
    def compile_container(raw):
        ns, es = raw.get('nodes') or [], raw.get('edges') or []
        flat = any(n.get('type') in ('parallel','scope') for n in ns)
        if flat:
            for n in ns:
                n.setdefault('params', {})['_canvas_path'] = []
        raw['nodes'], raw['edges'] = lower_graph(ns, es)
        for n in raw['nodes']:
            if n.get('type') == 'group':
                compile_container(n['params'])
    compile_container(result)
    for script in (result.get('scripts') or {}).values():
        compile_container(script)
    return result
