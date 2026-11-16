"""平面分叉/汇合执行回归，复用假输入设备，绝不向系统注入输入。"""
import asyncio
import copy
import unittest
import test_reliability as fixtures
from flatgraph import compile_flow


def node(nid, kind, **params):
    return {'id': nid, 'type': kind, 'params': params}


def edge(source, target, port=None):
    return {'source': source, 'target': target, 'sourceHandle': port}


def fork(nid='p', jid='j', **settings):
    return node(nid, 'parallel', join_id=jid, branches=[{'id':'main','name':'主轴'}, {'id':'side','name':'副轴'}], **settings)


def fixture():
    return {'nodes': [fork(), node('a','keyboard',keys='w',hold_ms=20), node('b','keyboard',keys='a',hold_ms=70), node('j','join',fork_id='p'), node('end','keyboard',keys='z',hold_ms=1)],
            'edges': [edge('p','a','main'),edge('p','b','side'),edge('a','j'),edge('b','j'),edge('j','end')]}


class StructureTests(unittest.TestCase):
    def test_compile_is_a_projection_and_preserves_sources(self):
        raw=fixture(); before=copy.deepcopy(raw); compiled=compile_flow(raw)
        self.assertEqual(raw,before)
        self.assertEqual([n['id'] for n in compiled['nodes']],['p','end'])
        self.assertEqual(compiled['edges'],[edge('p','end')])
        body=compiled['nodes'][0]['params']['nodes'][0]['params']['nodes'][0]
        self.assertEqual(body['id'],'a'); self.assertEqual(body['params']['_canvas_path'],[])

    def test_cross_branch_entry_rejected(self):
        for extra in [edge('a','b'),edge('end','a'),edge('end','j'),edge('a','p')]:
            raw=fixture();raw['edges'].append(extra)
            with self.subTest(extra=extra),self.assertRaises(ValueError):compile_flow(raw)

    def test_pair_and_port_errors_rejected(self):
        for change in ['missing','orphan','wrong-port','many-exits','wrong-pair']:
            raw=fixture()
            if change=='missing':raw['nodes'][0]['params']['join_id']='no'
            if change=='orphan':raw['nodes'].append(node('orphan','join'))
            if change=='wrong-port':raw['edges'][0]['sourceHandle']='no'
            if change=='many-exits':raw['edges'].append(edge('j','p'))
            if change=='wrong-pair':raw['nodes'][3]['params']['fork_id']='no'
            with self.subTest(change=change),self.assertRaises(ValueError):compile_flow(raw)


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        fixtures.inputctl.release_all();self.logs=[]
        async def broadcast(event):self.logs.append(event)
        self.ex=fixtures.executor.Executor(broadcast)

    async def asyncTearDown(self):fixtures.inputctl.release_all()

    async def run_flow(self,raw):
        self.ex.task=asyncio.create_task(self.ex.run(raw));await self.ex.task
        self.assertFalse(fixtures.inputctl.held_keys())
        return self.ex.input_trace.snapshot()['events']

    async def test_concurrent_branches_join_the_later_side(self):
        events=await self.run_flow(fixture());downs=[e for e in events if e['kind']=='down'];ends=[e for e in events if e['kind']=='track_end']
        self.assertEqual([e['key'] for e in downs],['w','a','z'])
        self.assertLess(downs[1]['time_ms'],ends[0]['time_ms'])
        self.assertGreaterEqual(downs[-1]['time_ms'],ends[-1]['time_ms'])
        self.assertTrue(all(e['group_path']==[] for e in downs))
        self.assertEqual(downs[0]['axis_id'],'main')
        self.assertNotEqual(downs[1]['axis_id'],'main')

    async def test_scopes_keep_same_names_private(self):
        raw=fixture();raw['variables']=[{'name':'key','type':'string','value':'z'}]
        raw['nodes'][0]['params']['branches'][0]['variables']=[{'name':'key','type':'string','value':'w'}]
        raw['nodes'][0]['params']['branches'][1]['variables']=[{'name':'key','type':'string','value':'a'}]
        for n in raw['nodes'][1:3]:n['params']['keys']='{{key}}'
        events=await self.run_flow(raw)
        self.assertEqual([e['key'] for e in events if e['kind']=='down'],['w','a','z'])
        self.assertEqual(self.ex.vars.get('key'),'z')

    async def test_nested_parallel_joins_without_duplicate_outer_successor(self):
        raw=fixture();raw['nodes'] += [fork('nested','nj'),node('c','keyboard',keys='c',hold_ms=10),node('nj','join',fork_id='nested')]
        raw['edges']=[e for e in raw['edges'] if e['source']!='a']+[edge('a','nested'),edge('nested','c','main'),edge('nested','nj','side'),edge('c','nj'),edge('nj','j')]
        events=await self.run_flow(raw)
        self.assertEqual([e['key'] for e in events if e['kind']=='down'].count('z'),1)
        self.assertIn('c',[e.get('key') for e in events])

    async def test_condition_only_launches_one_path_and_join_completes(self):
        raw=fixture();raw['nodes'] += [node('q','judge',condition={'left':'yes','op':'==','right':'yes'}),node('unused','keyboard',keys='x',hold_ms=1)]
        raw['edges']=[e for e in raw['edges'] if e['source']!='p' or e['sourceHandle']!='main']+[edge('p','q','main'),edge('q','a','yes'),edge('q','unused','no'),edge('unused','j')]
        events=await self.run_flow(raw);keys=[e['key'] for e in events if e['kind']=='down']
        self.assertIn('w',keys);self.assertNotIn('x',keys);self.assertEqual(keys[-1],'z')

    async def test_nested_main_path_keeps_parent_side_axis(self):
        raw=fixture();raw['nodes'] += [fork('nested','nj'),node('c','keyboard',keys='c',hold_ms=10),node('nj','join',fork_id='nested')]
        raw['edges']=[e for e in raw['edges'] if e['source']!='b']+[edge('b','nested'),edge('nested','c','main'),edge('nested','nj','side'),edge('c','nj'),edge('nj','j')]
        events=await self.run_flow(raw);downs={e['key']:e for e in events if e['kind']=='down'}
        self.assertEqual(downs['a']['axis_id'],downs['c']['axis_id'])
        self.assertFalse(downs['c']['primary'])
        self.assertNotEqual(downs['a']['track_id'],downs['c']['track_id'])

    async def test_absolute_recording_keeps_overlapping_intervals(self):
        raw=fixture();raw['nodes'][0]['params'].update(timing='absolute',duration_ms=90,repeat=2)
        raw['nodes'][1]['params']['timeline']={'start_ms':0,'track_id':'main'}
        raw['nodes'][2]['params']['timeline']={'start_ms':5,'track_id':'side'}
        events=await self.run_flow(raw);downs=[e for e in events if e['kind']=='down']
        self.assertEqual([e['key'] for e in downs],['w','a','w','a','z'])
        self.assertGreaterEqual(downs[-1]['time_ms'],170)

    async def test_inline_scope_keeps_inherited_globals_and_shadows(self):
        raw={'variables':[{'name':'key','value':'z','type':'string'}], 'nodes':[node('s','scope',join_id='j',variables=[{'name':'key','value':'w','type':'string'}]),node('k','keyboard',keys='{{key}}',hold_ms=1),node('j','join',fork_id='s'),node('out','keyboard',keys='{{key}}',hold_ms=1)],'edges':[edge('s','k','main'),edge('k','j'),edge('j','out')]}
        events=await self.run_flow(raw)
        self.assertEqual([e['key'] for e in events if e['kind']=='down'],['w','z'])

    async def test_local_delete_does_not_modify_parent_global(self):
        raw=fixture();raw['variables']=[{'name':'g','type':'number','value':'8'}]
        raw['nodes'][1]=node('a','variable',action='delete',name='g',scope='local')
        await self.run_flow(raw);self.assertEqual(self.ex.vars.get('g'),8)


if __name__=='__main__':unittest.main(verbosity=2)
