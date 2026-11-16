"""实际键鼠时间轴记录测试：使用假控制器，不安装钩子、不操作真实键鼠。"""
import asyncio
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import test_reliability as fixtures
import inputtrace

inputctl = fixtures.inputctl


class TraceTests(unittest.TestCase):
    def test_active_clock_excludes_pause_and_freezes_on_finish(self):
        paused=[0]
        with patch.object(inputtrace.time,'monotonic',return_value=10):
            trace=inputtrace.InputTrace(pause_clock=lambda:paused[0])
        with patch.object(inputtrace.time,'monotonic',return_value=12):
            paused[0]=1500
            trace.record('node_start',{}, {})
            trace.finish()
        with patch.object(inputtrace.time,'monotonic',return_value=20):
            result=trace.snapshot()
        self.assertEqual(result['events'][0]['time_ms'],2000)
        self.assertEqual(result['events'][0]['active_ms'],500)
        self.assertEqual(result['active_elapsed_ms'],500)

    def tearDown(self):
        inputctl.release_all()

    def test_physical_transitions_only_and_cleanup_retains_origin(self):
        trace = inputtrace.InputTrace('测试', 'doc1')
        with inputtrace.scope(recorder=trace, node_id='', script_id='', group_path=[]):
            with inputtrace.scope(node_id='k1', script_id='s1', group_path=['g1']):
                inputctl.key_down('w')
                inputctl.key_down('w')
            inputctl.release_all()
        trace.finish()
        snapshot = trace.snapshot()
        self.assertEqual([e['kind'] for e in snapshot['events']], ['down', 'up'])
        self.assertEqual(snapshot['events'][1]['node_id'], 'k1')
        self.assertEqual(snapshot['events'][1]['group_path'], ['g1'])
        self.assertTrue(snapshot['events'][1]['cleanup'])
        self.assertFalse(snapshot['running'])

    def test_failed_down_does_not_claim_success(self):
        trace = inputtrace.InputTrace()
        with inputtrace.scope(recorder=trace), patch.object(inputctl, '_key_primitives', return_value=(lambda: (_ for _ in ()).throw(OSError('test')), lambda: None)):
            with self.assertRaises(OSError):
                inputctl.key_down('w')
        self.assertEqual(trace.snapshot()['events'], [])

    def test_text_only_reports_character_count(self):
        trace = inputtrace.InputTrace()
        with inputtrace.scope(recorder=trace):
            inputctl.type_text('private text')
        event = trace.snapshot()['events'][0]
        self.assertEqual(event['kind'], 'text')
        self.assertEqual(event['chars'], 12)
        self.assertNotIn('private', str(event))

    def test_capacity_deltas_and_run_identity(self):
        with patch.object(inputtrace, 'MAX_EVENTS', 3):
            trace = inputtrace.InputTrace()
        for _ in range(5):
            trace.record('down', {}, {})
        snapshot = trace.snapshot()
        self.assertEqual(snapshot['dropped'], 2)
        self.assertEqual([e['seq'] for e in trace.snapshot(3, trace.run_id)['events']], [4, 5])
        self.assertEqual(len(trace.snapshot(100, 'different-run')['events']), 3)

    def test_sequence_is_thread_safe(self):
        trace = inputtrace.InputTrace()
        with ThreadPoolExecutor(4) as pool:
            list(pool.map(lambda _: trace.record('down', {}, {}), range(200)))
        self.assertEqual([e['seq'] for e in trace.snapshot()['events']], list(range(1, 201)))


class ExecutionTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_record_autoclick_and_text_have_comparison_events(self):
        async def broadcast(_):pass
        ex=fixtures.executor.Executor(broadcast)
        flow={'nodes':[
            {'id':'r','type':'record','params':{'events':[{'type':'keydown','key':'w','t':0},{'type':'keyup','key':'w','t':10}],'speed':1,'repeat':1}},
            {'id':'click','type':'autoclick','params':{'x':1,'y':2,'count':2,'interval_ms':5}},
            {'id':'text','type':'text_input','params':{'text':'private content','interval_ms':0}},
        ],'edges':[{'source':'r','target':'click'},{'source':'click','target':'text'}]}
        ex.task=asyncio.create_task(ex.run(flow));await ex.task
        events=ex.input_trace.snapshot()['events']
        starts=[e for e in events if e['kind']=='node_start']
        self.assertEqual([e['action'] for e in starts if e['node_id']=='r'],['down','up'])
        self.assertEqual(next(e for e in starts if e['node_id']=='click')['expected_clicks'],2)
        self.assertEqual(next(e for e in starts if e['node_id']=='text')['expected_chars'],15)
        self.assertNotIn('private content',str(events))

    async def test_resolved_baseline_and_failure_are_observable(self):
        async def broadcast(_):pass
        ex=fixtures.executor.Executor(broadcast)
        ex.task=asyncio.create_task(ex.run({'nodes':[{'id':'a','type':'keyboard','params':{'keys':'{{key}}','hold_ms':'{{length}}'}}], 'edges':[], 'variables':[{'name':'key','type':'string','value':'w'},{'name':'length','type':'number','value':'15'}]}))
        await ex.task
        start=next(e for e in ex.input_trace.snapshot()['events'] if e['kind']=='node_start')
        self.assertEqual(start['expected_key'],'w');self.assertEqual(start['expected_duration_ms'],15)
        self.assertIn('expected_start_ms',start)
        self.assertIn('active_ms',start)
        async def fail(_ex,_params):raise OSError('fake device failure')
        with patch.dict(fixtures.executor.nodemod.HANDLERS,{'keyboard':fail}):
            ex.task=asyncio.create_task(ex.run({'nodes':[{'id':'a','type':'keyboard','params':{'keys':'w','hold_ms':0}}],'edges':[]}))
            await ex.task
        self.assertTrue(any(e['kind']=='node_error' and e.get('node_id')=='a' for e in ex.input_trace.snapshot()['events']))
    async def test_subscript_group_and_final_release_are_locatable(self):
        async def broadcast(_):
            pass
        ex = fixtures.executor.Executor(broadcast)
        ex.task = asyncio.create_task(ex.run({
            'name': '工程', 'client_doc_id': 'doc1',
            'nodes': [{'id': 'c', 'type': 'script_call', 'params': {'script_id': 's'}}], 'edges': [],
            'scripts': {'s': {'name': '子脚本', 'nodes': [{'id': 'g', 'type': 'group', 'params': {'nodes': [{'id': 'k', 'type': 'keyboard', 'params': {'keys': 'w', 'action': 'down'}}], 'edges': []}}], 'edges': []}},
        }))
        await ex.task
        snapshot = ex.input_trace.snapshot()
        inputs = [e for e in snapshot['events'] if e['kind'] in ('down', 'up')]
        self.assertEqual(snapshot['project_id'], 'doc1')
        self.assertEqual(inputs[0]['script_id'], 's')
        self.assertEqual(inputs[0]['group_path'], ['g'])
        self.assertEqual(inputs[0]['node_id'], 'k')
        self.assertEqual(inputs[-1]['kind'], 'up')
        self.assertEqual([e['round'] for e in snapshot['events'] if e['kind'] == 'round_start'], [1])
        self.assertFalse(snapshot['running'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
