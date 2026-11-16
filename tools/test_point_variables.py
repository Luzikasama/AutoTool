"""坐标变量及分量引用回归，所有输入和截图由桩承接。"""
import asyncio
import unittest
from unittest.mock import patch
import test_reliability as fixtures
from runvars import VarScope, coerce, resolve
from timeschedule import compile_segment

nodes = fixtures.executor.nodemod


class Points(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def broadcast(_): pass
        self.ex = fixtures.executor.Executor(broadcast)
        self.ex.prepare_run()

    def test_coordinate_initial_value_and_component_lookup(self):
        scope = VarScope()
        scope.seed([{'name': 'point', 'type': 'point', 'value': '100,200'}])
        self.assertEqual(resolve('{{point.x}}', scope), 100)
        self.assertEqual(resolve('{{point.y}}', scope), 200)
        child = scope.child([{'name':'point','type':'point','value':'20,30'}])
        self.assertEqual(child.get('point.x'), 20)
        scope.set('point.x', 555)  # 旧的完整变量名优先，不破坏兼容。
        self.assertEqual(child.get('point.x'), 555)
        self.assertIsNone(coerce('nan,30', 'point'))
        self.assertIsNone(scope.get('point.__class__'))

    async def test_screen_point_is_not_scaled_twice_and_failure_cannot_click(self):
        self.ex.vars.set('point', {'x':123,'y':456,'space':'screen'})
        self.ex.scale = lambda x,y:(x*2,y*2)
        calls=[]
        with patch.object(nodes.inputctl,'click_down',side_effect=lambda *a,**k:calls.append(a)):
            await nodes.mouse(self.ex,{'point_var':'point','action':'click'})
        self.assertEqual(calls[0][:2],(123,456))
        self.ex.vars.set('point', None)
        with patch.object(nodes.inputctl,'click_down',side_effect=AssertionError('Should not inject input')):
            with self.assertRaises(ValueError): await nodes.mouse(self.ex,{'point_var':'point','action':'click'})

    async def test_image_outputs_one_point_and_clears_stale_result(self):
        p={'template':'test','save_point':'point','save_found':'found','timeout_ms':0}
        self.ex.grab=lambda _: ('frame',10,20)
        with patch.object(nodes.vision,'load_template',return_value='template',create=True),patch.object(nodes.vision,'load_template_meta',return_value={},create=True),patch.object(nodes.vision,'match_template_auto',return_value=(True,30,40,.99,1),create=True):
            await nodes.find_image(self.ex,p)
        self.assertEqual(self.ex.vars.get('point'),{'x':40,'y':60,'space':'screen'})
        with patch.object(nodes.vision,'load_template',return_value='template',create=True),patch.object(nodes.vision,'load_template_meta',return_value={},create=True),patch.object(nodes.vision,'match_template_auto',return_value=(False,0,0,.1,1),create=True):
            await nodes.find_image(self.ex,p)
        self.assertIsNone(self.ex.vars.get('point'))
        self.assertEqual(self.ex.vars.get('found'),'no')

    def test_timeline_reads_coordinate_and_marks_screen_space(self):
        scope=VarScope();scope.set('point',{'x':15,'y':25,'space':'screen'})
        events,_,_=compile_segment({'nodes':[{'id':'m','type':'mouse','params':{'point_var':'point','action':'hold','hold_ms':20}}]},lambda v:resolve(v,scope))
        self.assertTrue(all(e['x']==15 and e['y']==25 and e['screen_point'] for e in events))


if __name__=='__main__': unittest.main(verbosity=2)
