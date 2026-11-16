"""0.3.2：后台点击、统一调度及轮数同步。全程使用假输入设备与假 Win32 API。"""
import asyncio
import ctypes
import unittest
from ctypes import wintypes
from unittest.mock import patch
import test_reliability as fixtures
from flatgraph import compile_flow
from repeatstate import RepeatState
import backgroundclick


class RepeatTests(unittest.TestCase):
    def test_engine_restart_has_a_new_epoch_and_rejects_previous_epoch_updates(self):
        old=RepeatState();first,_=old.sync({'client_doc_id':'a','repeat':2});old.set(7)
        restarted=RepeatState();payload={'client_doc_id':'a','repeat':7,'repeat_revision':first['revision'],'repeat_epoch':first['epoch']}
        restarted.sync(dict(payload));latest=restarted.set(9)
        state,accepted=restarted.sync(dict(payload))
        self.assertFalse(accepted);self.assertEqual(state['value'],9);self.assertNotEqual(latest['epoch'],first['epoch'])
    def test_overlay_revision_survives_old_payload_and_project_switch(self):
        state=RepeatState()
        original={'client_doc_id':'a','repeat':2,'repeat_revision':0}
        first,_=state.sync(original)
        update=state.set(7)
        old={'client_doc_id':'a','repeat':2,'repeat_revision':first['revision']}
        self.assertFalse(state.sync(old)[1]);self.assertEqual(old['repeat'],7)
        state.sync({'client_doc_id':'b','repeat':3,'repeat_revision':0})
        self.assertEqual(state.sync(dict(old))[0]['value'],7)
        self.assertEqual(state.sync({'client_doc_id':'a','repeat':9,'repeat_revision':update['revision']})[0]['value'],9)


class FakeWindows:
    def __init__(self):self.messages=[];self.valid=True;self.blocked=False;self.minimized=False
    def IsWindow(self,hwnd):return self.valid and hwnd in (1,2)
    def IsIconic(self,hwnd):return self.minimized
    def IsChild(self,parent,child):return parent==1 and child==2
    def ScreenToClient(self,hwnd,pointer):
        point=ctypes.cast(pointer,ctypes.POINTER(wintypes.POINT)).contents
        point.x-=100 if hwnd==1 else 110;point.y-=200 if hwnd==1 else 220
        return True
    def GetClientRect(self,hwnd,pointer):
        rect=ctypes.cast(pointer,ctypes.POINTER(wintypes.RECT)).contents;rect.right=rect.bottom=300;return True
    def ChildWindowFromPointEx(self,hwnd,point,flags):return 2
    def PostMessageW(self,*args):
        if self.blocked:return False
        self.messages.append(args);return True


class BackgroundTests(unittest.TestCase):
    def setUp(self):
        self.api=FakeWindows();self.stub=patch.object(backgroundclick,'_api',lambda:self.api);self.stub.start()
        fixtures.inputctl.release_all();fixtures.inputctl._mouse.position=(777,888)
    def tearDown(self):
        self.api.blocked=False;fixtures.inputctl.release_all();self.stub.stop()
    def test_click_targets_child_client_coordinates_without_moving_cursor(self):
        fixtures.inputctl.click(125,245,'left',2,'background_click',1)
        self.assertEqual([m[1] for m in self.api.messages],[0x201,0x202,0x203,0x202])
        self.assertTrue(all(m[0]==2 and m[3]==15+(25<<16) for m in self.api.messages))
        self.assertEqual(fixtures.inputctl._mouse.position,(777,888));self.assertFalse(fixtures.inputctl.held_keys())
    def test_invalid_or_minimized_target_never_falls_back_to_real_input(self):
        for hwnd,minimized in [(0,False),(1,True)]:
            self.api.minimized=minimized
            with self.assertRaises(ValueError):fixtures.inputctl.click(125,245,'left',1,'background_click',hwnd)
        self.assertEqual(self.api.messages,[]);self.assertEqual(fixtures.inputctl._mouse.position,(777,888))
    def test_permission_failure_is_reported_without_real_click(self):
        self.api.blocked=True
        with patch.object(ctypes,'get_last_error',return_value=5),self.assertRaises(PermissionError):
            fixtures.inputctl.click(125,245,'left',1,'background_click',1)
        self.assertEqual(fixtures.inputctl._mouse.position,(777,888));self.assertFalse(fixtures.inputctl.held_keys())
    def test_concurrent_background_buttons_keep_the_other_button_state(self):
        with fixtures.inputctl.input_session():
            fixtures.inputctl.mouse_down(125,245,'left','background_click',1)
            fixtures.inputctl.mouse_down(125,245,'right','background_click',1)
            fixtures.inputctl.mouse_up(125,245,'left','background_click',1)
            fixtures.inputctl.mouse_up(125,245,'right','background_click',1)
        self.assertEqual([m[2] for m in self.api.messages],[1,3,2,0])
    def test_stop_releases_background_button_and_closed_window_cleans_lease(self):
        with fixtures.inputctl.input_session() as session:
            fixtures.inputctl.mouse_down(125,245,'right','background_click',1)
            session.closed=True
            fixtures.inputctl.release_all(owner=session)
        self.assertEqual([m[1] for m in self.api.messages],[0x204,0x205])
        with fixtures.inputctl.input_session() as session:
            fixtures.inputctl.mouse_down(125,245,'middle','background_click',1)
            self.api.valid=False
            fixtures.inputctl.release_all(owner=session)
        self.assertFalse(fixtures.inputctl.held_keys())


def node(nid,kind,**params):return {'id':nid,'type':kind,'params':params}
def edge(source,target,port=None):return {'source':source,'target':target,'sourceHandle':port}
def flow(logic=False):
    ns=[node('p','parallel',timing='unified',join_id='j',branches=[{'id':'main'},{'id':'side'}],primary_track='main'),node('w','keyboard',keys='w',hold_ms=25,timeline={'delay_ms':0}),node('a','keyboard',keys='a',hold_ms=10,timeline={'delay_ms':5}),node('j','join',fork_id='p')]
    es=[edge('p','w','main'),edge('p','a','side'),edge('w','j'),edge('a','j')]
    if logic:
        ns.append(node('find','find_image',timeout_ms=5000));es=[e for e in es if e['source']!='p' or e['sourceHandle']!='side']+[edge('p','find','side'),edge('find','a')]
    return {'nodes':ns,'edges':es}


class UnifiedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def broadcast(event):pass
        self.ex=fixtures.executor.Executor(broadcast)
        fixtures.inputctl.release_all()
    async def asyncTearDown(self):fixtures.inputctl.release_all()
    async def run_flow(self,raw):
        with patch.object(fixtures.executor.appconfig,'get',return_value=False):
            self.ex.task=asyncio.create_task(self.ex.run(raw));await self.ex.task
        return self.ex.input_trace.snapshot()['events']
    async def test_pure_recording_has_one_clock_and_retains_overlap(self):
        raw=flow();compiled=compile_flow(raw)
        self.assertEqual(compiled['nodes'][0]['params']['execution'],'timeline')
        self.assertEqual([n['params']['timeline']['start_ms'] for n in compiled['nodes'][0]['params']['nodes']],[0,5])
        ev=await self.run_flow(raw);starts={e['node_id']:e for e in ev if e['kind']=='node_start'}
        self.assertEqual(starts['a']['expected_start_ms']-starts['w']['expected_start_ms'],5)
        self.assertEqual(next(e['axis_id'] for e in ev if e['kind']=='down' and e['node_id']=='w'),'main')
    async def test_logic_resets_only_its_axis_clock_and_joins_the_later_axis(self):
        raw=flow(True)
        async def find(ex,p):await ex.sleep(.060);return None
        with patch.dict(fixtures.executor.nodemod.HANDLERS,{'find_image':find}):
            ev=await self.run_flow(raw)
        end=next(e for e in ev if e['kind']=='node_end' and e['node_id']=='find')
        click=next(e for e in ev if e['kind']=='node_start' and e['node_id']=='a')
        w_end=next(e for e in ev if e['kind']=='node_end' and e['node_id']=='w')
        self.assertAlmostEqual(click['expected_start_ms']-end['active_ms'],5,delta=3)
        self.assertLess(w_end['active_ms'],end['active_ms'])
        self.assertFalse(fixtures.inputctl.held_keys())
    async def test_exact_schedule_click_obeys_background_setting(self):
        raw=flow();raw['nodes'][2]=node('a','mouse',action='double_click',x=125,y=245,hold_ms=1,interval_ms=1,timeline={'delay_ms':5});raw['window']={'hwnd':1}
        api=FakeWindows();fixtures.inputctl._mouse.position=(777,888)
        with patch.object(backgroundclick,'_api',lambda:api),patch.object(fixtures.executor.appconfig,'get',return_value=True):
            self.ex.task=asyncio.create_task(self.ex.run(raw));await self.ex.task
        self.assertEqual([m[1] for m in api.messages],[0x201,0x202,0x203,0x202])
        self.assertEqual(fixtures.inputctl._mouse.position,(777,888))


if __name__=='__main__':unittest.main(verbosity=2)
