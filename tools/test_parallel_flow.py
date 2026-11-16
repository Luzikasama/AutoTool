"""主副轴流程回归；所有键鼠、截图均由假设备或桩模块承接。"""
import asyncio
import time
import unittest
from unittest.mock import patch
import test_reliability as fixtures
from parallelflow import parallel_plan

inputctl = fixtures.inputctl
executor = fixtures.executor


def node(nid, kind, **params):
    return {'id': nid, 'type': kind, 'params': params}


def track(nid, nodes, edges=None, **params):
    return node(nid, 'group', name=nid, nodes=nodes, edges=edges or [], **params)


def key(nid, key, ms):
    return node(nid, 'keyboard', keys=key, hold_ms=ms)


class ParallelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        inputctl.release_all()
        self.logs = []
        async def broadcast(event): self.logs.append(event)
        self.ex = executor.Executor(broadcast)

    async def asyncTearDown(self): inputctl.release_all()

    def start(self, tracks, **settings):
        flow = {'nodes': [node('p', 'group', execution='parallel', nodes=tracks, edges=[], **settings), key('after', 'z', 1)], 'edges': [{'source': 'p', 'target': 'after'}]}
        self.ex.task = asyncio.create_task(self.ex.run(flow))
        return self.ex.task

    def events(self, kind=None):
        events = self.ex.input_trace.snapshot()['events'] if self.ex.input_trace else []
        return [e for e in events if e['kind'] == kind] if kind else events

    async def until(self, predicate):
        for _ in range(200):
            if predicate(): return
            await asyncio.sleep(.005)
        self.fail('Waiting for parallel checkpoint timed out')

    async def test_main_finishes_first_and_outer_flow_joins_all(self):
        await self.start([track('main', [key('w', 'w', 25)]), track('side', [key('a', 'a', 80)])])
        ends = self.events('track_end')
        self.assertEqual([e['track_label'] for e in ends], ['main', 'side'])
        downs = self.events('down')
        self.assertLess(downs[1]['time_ms'], ends[0]['time_ms'])
        self.assertGreaterEqual(downs[-1]['time_ms'], ends[-1]['time_ms'])
        self.assertEqual(downs[-1]['key'], 'z')
        self.assertFalse(inputctl.held_keys())

    async def test_each_track_has_private_scope_and_context(self):
        tracks = [track('main', [key('k', '{{name}}', 20)], variables=[{'name':'name','type':'string','value':'w'}]),
                  track('side', [key('k', '{{name}}', 25)], variables=[{'name':'name','type':'string','value':'a'}])]
        await self.start(tracks)
        downs = [e for e in self.events('down') if e['key'] != 'z']
        self.assertEqual({(e['key'], e['track_label']) for e in downs}, {('w','main'),('a','side')})
        self.assertFalse(self.ex.vars.has('name'))
        self.assertTrue(all(e['group_path'][0] == 'p' for e in downs))

    async def test_same_key_is_retained_until_both_tracks_finish(self):
        await self.start([track('main', [key('k', 'w', 20)]), track('side', [key('k', 'w', 60)])])
        self.assertEqual([e['kind'] for e in self.events() if e.get('key') == 'w' and e['kind'] in ('down','up')], ['down','up'])
        spans = [e for e in self.events('node_start') if e.get('key') == 'w']
        self.assertEqual(len(spans), 2)

    async def test_stop_while_paused_releases_both_axes(self):
        task = self.start([track('main',[key('k','w',1000)]),track('side',[key('k','a',1000)])])
        await self.until(lambda: len(self.events('down')) >= 2)
        self.ex.pause()
        await asyncio.sleep(.06)
        self.assertEqual(len(self.events('up')), 0)
        self.ex.stop()
        await asyncio.wait_for(task, 1)
        self.assertFalse(inputctl.held_keys())
        self.assertNotIn('z',[e.get('key') for e in self.events('down')])

    async def test_pause_freezes_offsets_for_all_tracks(self):
        task = self.start([track('main',[key('k','w',160)]),track('side',[key('k','a',10)], timeline={'start_ms':100})])
        await self.until(lambda: bool(self.events('down')))
        self.ex.pause()
        await asyncio.sleep(.14)
        self.assertEqual([e['key'] for e in self.events('down')], ['w'])
        self.ex.resume()
        await task
        self.assertIn('a',[e['key'] for e in self.events('down')])

    async def test_image_recognition_does_not_block_other_axis(self):
        vision = executor.vision
        def match(*args):
            time.sleep(.07)
            return True, 10, 20, .99, 1
        with patch.object(vision,'load_template',return_value=object(),create=True), patch.object(vision,'load_template_meta',return_value={},create=True), patch.object(vision,'match_template_auto',side_effect=match,create=True):
            await self.start([track('main',[node('find','find_image',template='fake',timeout_ms=500)]),track('side',[key('k','w',20)])])
        found = next(e for e in self.events('node_end') if e['node_id'] == 'find')
        down = next(e for e in self.events('down') if e['key'] == 'w')
        self.assertLess(down['time_ms'], found['time_ms'])

    async def test_repeated_region_restarts_all_axes_and_cleans_inputs(self):
        await self.start([track('main',[key('k','w',2)]),track('side',[key('k','a',3)])],repeat=2)
        self.assertEqual(len(self.events('track_start')), 4)
        self.assertFalse(inputctl.held_keys())

    async def test_duplicate_global_writes_are_rejected_before_input(self):
        write = node('v','variable',name='shared',scope='global',value='1')
        await self.start([track('main',[write]),track('side',[write])])
        self.assertEqual(self.events('down'), [])
        self.assertTrue(any('同时写入全局变量' in e.get('message','') for e in self.logs))

    async def test_cancellation_closes_pending_worker_admission(self):
        with inputctl.input_owner(inputctl.InputSession()) as _:
            with inputctl.input_session() as session:
                inputctl.key_down('w')
            with inputctl.input_owner(session):
                with self.assertRaises(RuntimeError): inputctl.key_down('a')
            inputctl.release_all(owner=session)
        self.assertFalse(inputctl.held_keys())

    def test_invalid_tracks_and_offsets_rejected(self):
        for p in [{'nodes':[]},{'nodes':[key('k','w',1)]},{'nodes':[track('a',[],timeline={'start_ms':-1})]},{'nodes':[track('a',[])],'repeat':1.5}]:
            with self.subTest(p=p), self.assertRaises(ValueError): parallel_plan(p)


if __name__ == '__main__': unittest.main(verbosity=2)
