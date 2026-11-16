"""时序调度回归：所有执行均由假控制器承接，绝不操作真实键鼠。"""
import asyncio
import unittest
from unittest.mock import patch
import test_reliability as fixtures
from timeschedule import compile_segment
import inputtrace

inputctl = fixtures.inputctl


def key(nid, name, start, hold, **extra):
    return {'id': nid, 'type': 'keyboard', 'params': {'keys': name, 'action': 'press', 'hold_ms': hold, 'timeline': {'start_ms': start}, **extra}}


def mouse(nid, start, hold, **extra):
    return {'id': nid, 'type': 'mouse', 'params': {'action': 'hold', 'button': 'left', 'x': 10, 'y': 20, 'hold_ms': hold, 'timeline': {'start_ms': start}, **extra}}


class CompileTests(unittest.TestCase):
    def test_overlap_and_equal_time_release_precedes_new_press(self):
        events, duration, repeat = compile_segment({'nodes': [key('a','w',0,100), key('b','w',100,100), mouse('m',50,100)]})
        self.assertEqual([(e['operation'],e['node_id']) for e in events if e['at']==100], [('key_up','a'),('key_down','b')])
        self.assertEqual((duration,repeat), (200,1))

    def test_zero_hold_still_has_down_before_up(self):
        events, _, _ = compile_segment({'nodes':[key('k','ctrl+a',0,0)]})
        self.assertEqual([e['operation'] for e in events],['key_down','key_down','key_up','key_up'])
        self.assertEqual([e['key'] for e in events],['ctrl','a','a','ctrl'])

    def test_recorded_equal_time_order_is_retained(self):
        a,b=key('a','w',0,10),key('b','a',10,10)
        a['params']['timeline'].update(start_order=0,end_order=3)
        b['params']['timeline'].update(start_order=2,end_order=4)
        events, _, _=compile_segment({'nodes':[a,b]})
        self.assertEqual([e['node_id'] for e in events if e['at']==10],['b','a'])

    def test_trailing_duration_repeat_endpoint_and_modes(self):
        events,duration,repeat=compile_segment({'nodes':[mouse('m',20,30,end_x=70,end_y=80,input_mode='simulated')], 'duration_ms':120,'repeat':3})
        self.assertEqual((duration,repeat),(120,3))
        self.assertEqual((events[-1]['x'],events[-1]['y'],events[-1]['mode']),(70,80,'real'))

    def test_invalid_graph_and_timing_are_rejected(self):
        bad=[{'nodes':[key('k','w',-1,1)]},{'nodes':[key('k','',0,1)]},{'nodes':[key('k','w',0,float('nan'))]},
             {'nodes':[key('k','w',0,1)],'edges':[{'source':'k','target':'k'}]}, {'nodes':[{'id':'j','type':'judge'}]},
             {'nodes':[key('k','w',0,1)],'repeat':1.5}, {'nodes':[key('k','w',0,1),key('k','a',0,1)]}]
        for params in bad:
            with self.subTest(params=params),self.assertRaises(ValueError): compile_segment(params)

    def test_smooth_pointer_trajectories_cannot_overlap(self):
        def motion(nid,at): return {'id':nid,'type':'mouse','params':{'action':'move','duration_ms':100,'timeline':{'start_ms':at}}}
        with self.assertRaises(ValueError): compile_segment({'nodes':[motion('a',0),motion('b',50)]})
        events,_,_=compile_segment({'nodes':[motion('a',0),motion('b',100)]})
        self.assertLessEqual(len(events),122)


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        inputctl.release_all()
        async def broadcast(_): pass
        self.ex=fixtures.executor.Executor(broadcast)

    async def asyncTearDown(self): inputctl.release_all()

    def start(self, nodes, **settings):
        self.ex.task=asyncio.create_task(self.ex.run({'nodes':[{'id':'g','type':'group','params':{'execution':'timeline','nodes':nodes,'edges':[],**settings}}],'edges':[]}))
        return self.ex.task

    async def until(self, predicate):
        for _ in range(100):
            if predicate(): return
            await asyncio.sleep(.005)
        self.fail('Waiting for scheduler checkpoint timed out')

    def events(self): return [e for e in self.ex.input_trace.snapshot()['events'] if e['kind'] in ('down', 'up')] if self.ex.input_trace else []

    async def test_keyboard_and_mouse_hold_overlap_and_all_release(self):
        await self.start([key('w','w',0,60),key('a','a',10,80),mouse('m',20,50)])
        held=set(); triple=False
        for event in self.events():
            item=(event.get('device'),event.get('key'))
            if event['kind']=='down': held.add(item)
            elif event['kind']=='up': held.discard(item)
            triple |= {('key','w'),('key','a'),('mouse','left')} <= held
            self.assertEqual(event['group_path'],['g'])
        self.assertTrue(triple);self.assertFalse(held);self.assertFalse(inputctl.held_keys())

    async def test_same_key_owners_do_not_release_each_other(self):
        await self.start([key('first','w',0,40),key('second','w',10,70)])
        self.assertEqual([(e['kind'],e['node_id']) for e in self.events()],[('down','first'),('up','second')])

    async def test_pause_freezes_future_events_and_retains_held_key(self):
        task=self.start([key('w','w',0,150),key('a','a',100,50)])
        await self.until(lambda: len(self.events())>=1)
        self.ex.pause()
        await asyncio.sleep(.12)
        self.assertEqual([e['key'] for e in self.events()],['w'])
        self.assertTrue(inputctl.held_keys())
        self.ex.resume();await task
        self.assertFalse(inputctl.held_keys())

    async def test_stop_releases_all_tracks_and_discards_future_events(self):
        task=self.start([key('w','w',0,1000),mouse('m',0,1000),key('later','a',500,20)])
        await self.until(lambda: len(self.events())>=2)
        self.ex.stop();await asyncio.wait_for(task,1)
        self.assertFalse(inputctl.held_keys())
        self.assertNotIn('a',[e.get('key') for e in self.events()])
        self.assertEqual(sum(e['kind']=='up' for e in self.events()),2)

    async def test_repeat_restarts_clock_and_releases_each_cycle(self):
        await self.start([key('w','w',0,5)],duration_ms=10,repeat=3)
        self.assertEqual([e['kind'] for e in self.events()],['down','up']*3)

    async def test_segment_does_not_release_outer_continuous_hold(self):
        with inputctl.input_owner('outer'):
            inputctl.key_down('w')
            await self.start([key('w','w',0,5)])
            self.assertTrue(inputctl.held_keys())
            inputctl.key_up('w')
        self.assertFalse(inputctl.held_keys())

    async def test_invalid_later_clip_fails_before_any_input(self):
        await self.start([key('good','w',0,5),key('bad','a',0,-1)])
        self.assertEqual(self.events(),[])

    async def test_failure_cleans_up_previously_open_tracks(self):
        original=inputctl._key_primitives
        def primitives(key,*args):
            if key=='a': return lambda: (_ for _ in ()).throw(OSError('injected')),lambda:None
            return original(key,*args)
        with patch.object(inputctl,'_key_primitives',side_effect=primitives):
            await self.start([key('w','w',0,30),key('a','a',5,10)])
        self.assertFalse(inputctl.held_keys())
        self.assertEqual([(e['kind'],e['key']) for e in self.events()],[('down','w'),('up','w')])


class RealOnlyTests(unittest.TestCase):
    def tearDown(self):inputctl.release_all()

    def test_legacy_settings_use_physical_device_and_both_wheels(self):
        calls=[];mouse=fixtures._Ctl();mouse.scroll=lambda dx,dy:calls.append((dx,dy))
        with patch.object(inputctl,'_mouse',mouse):
            inputctl.mouse_down(1,2,'left','simulated',123)
            inputctl.move(2,3,'simulated',123)
            inputctl.mouse_up(2,3,'left','simulated',123)
            inputctl.scroll(1,-2,'simulated',123,2,3)
            self.assertEqual(mouse.position,(2,3));self.assertEqual(calls,[(1,-2)])
            self.assertFalse(inputctl.held_keys())

if __name__=='__main__': unittest.main(verbosity=2)
