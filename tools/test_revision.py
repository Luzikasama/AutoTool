"""复查改动后的行为回归：全部使用假输入，不接触真实键鼠或窗口。"""
import asyncio
import ast
import json
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import test_reliability as fixtures

executor = fixtures.executor
inputctl = fixtures.inputctl
ws_manager = fixtures.ws_manager


class InputTests(unittest.TestCase):
    def setUp(self):
        inputctl.release_all()
        self.calls = []

    def tearDown(self):
        inputctl.release_all()

    def primitives(self, key):
        return lambda: self.calls.append(('down', key)), lambda: self.calls.append(('up', key))

    def test_owner_down_is_idempotent_and_scoped_cleanup_preserves_other_owner(self):
        sig = inputctl._key_signature('w', 'real', 123)
        prim = self.primitives('w')
        with inputctl.input_owner('run'):
            inputctl._hold(sig, prim)
            inputctl._hold(sig, prim)
        with inputctl.input_owner('debug'):
            inputctl._hold(sig, prim)
        inputctl.release_all(owner='run')
        self.assertEqual(self.calls, [('down', 'w')])
        inputctl.release_all(owner='debug')
        self.assertEqual(self.calls, [('down', 'w'), ('up', 'w')])
        self.assertEqual(inputctl.held_keys(), [])

    def test_real_device_is_shared_across_hwnds_and_fallback_mode(self):
        self.assertEqual(inputctl._key_signature('w', 'real', 1), inputctl._key_signature('w', 'real', 2))
        self.assertEqual(inputctl._key_signature('w', 'real', 1), inputctl._key_signature('w', 'simulated', None))
        self.assertEqual(inputctl._key_signature('w', 'simulated', 1), inputctl._key_signature('w', 'simulated', 2))

    def test_failed_release_is_retained_and_can_be_retried(self):
        sig = inputctl._key_signature('w', 'real', None)
        state = {'fail': True}

        def up():
            if state['fail']:
                raise OSError('injected up failure')
            self.calls.append(('up', 'w'))

        inputctl._hold(sig, (lambda: None, up))
        with self.assertRaises(OSError):
            inputctl._release(sig)
        self.assertEqual(len(inputctl.held_keys()), 1)
        with self.assertRaises(RuntimeError):
            inputctl.release_all()
        self.assertEqual(len(inputctl.held_keys()), 1)
        state['fail'] = False
        self.assertEqual(inputctl.release_all(), 1)

    def test_multi_key_partial_failure_rolls_back(self):
        def primitives(key, *_):
            if key == 'b':
                def fail():
                    raise OSError('injected down failure')
                return fail, lambda: None
            return self.primitives(key)

        with patch.object(inputctl, '_key_primitives', side_effect=primitives):
            with self.assertRaises(OSError):
                inputctl.key_down('ctrl+b')
        self.assertEqual(self.calls, [('down', 'ctrl'), ('up', 'ctrl')])
        self.assertEqual(inputctl.held_keys(), [])

    def test_real_drag_releases_at_endpoint_and_cleanup_does_not_teleport(self):
        mouse = fixtures._Ctl()
        with patch.object(inputctl, '_mouse', mouse):
            inputctl.mouse_down(10, 20)
            inputctl.move(100, 200)
            inputctl.mouse_up(100, 200)
            self.assertEqual(mouse.position, (100, 200))
            inputctl.mouse_down(10, 20)
            inputctl.move(300, 400)
            inputctl.release_all()
            self.assertEqual(mouse.position, (300, 400))

    def test_legacy_mode_uses_real_drag_and_retains_endpoint(self):
        mouse=fixtures._Ctl()
        with patch.object(inputctl,'_mouse',mouse):
            inputctl.mouse_down(100,200,mode='simulated',hwnd=1)
            inputctl.mouse_up(300,400,mode='simulated',hwnd=2)
            self.assertEqual(mouse.position,(300,400))
            self.assertFalse(inputctl.held_keys())

    def test_legacy_mode_and_real_mode_share_same_key_lease(self):
        with patch.object(inputctl,'_key_primitives',side_effect=lambda key,*_:self.primitives(key)):
            with inputctl.input_owner('a'):inputctl.key_down('a','simulated',1)
            with inputctl.input_owner('b'):inputctl.key_down('a','real',2)
            inputctl.release_all(owner='a');self.assertEqual(self.calls,[('down','a')])
            inputctl.release_all(owner='b');self.assertEqual(self.calls,[('down','a'),('up','a')])

    def test_combos_from_two_threads_do_not_interleave(self):
        barrier = threading.Barrier(3)

        def press(keys):
            barrier.wait()
            inputctl.press_key(keys)

        def primitives(key, *_):
            def down():
                self.calls.append(('down', key))
                time.sleep(0.002)  # 主动让出 GIL，未加事务锁时两组组合键会交错。
            return down, lambda: self.calls.append(('up', key))

        with patch.object(inputctl, '_key_primitives', side_effect=primitives):
            threads = [threading.Thread(target=press, args=(keys,)) for keys in ('ctrl+a', 'shift+b')]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
        a = [('down', 'ctrl'), ('down', 'a'), ('up', 'a'), ('up', 'ctrl')]
        b = [('down', 'shift'), ('down', 'b'), ('up', 'b'), ('up', 'shift')]
        self.assertIn(self.calls, [a + b, b + a])

    def test_background_transport_is_removed(self):
        self.assertFalse(hasattr(inputctl,'_post'))
        self.assertFalse(hasattr(inputctl,'probe'))

    def test_root_cleanup_retries_failed_temporary_actions(self):
        sig = inputctl._key_signature('w', 'real', None)
        state = {'fail': True}

        def up():
            if state['fail']:
                raise OSError('injected temporary action release failure')

        with inputctl.input_owner('run'), inputctl.input_owner('temporary'):
            inputctl._hold(sig, (lambda: None, up))
            with self.assertRaises(RuntimeError):
                inputctl.release_all(owner='temporary')
        state['fail'] = False
        self.assertEqual(inputctl.release_all(owner='run'), 1)
        self.assertEqual(inputctl.held_keys(), [])

    def test_closed_run_rejects_late_down_from_nested_action(self):
        session = inputctl.InputSession()
        with inputctl.input_owner(session), inputctl.input_owner('temporary'):
            sig = inputctl._key_signature('w', 'real', None)
            inputctl._hold(sig, self.primitives('w'))
            session.closed = True
            inputctl.release_all(owner=session)
            with self.assertRaises(RuntimeError):
                inputctl._hold(sig, self.primitives('w'))
        self.assertEqual(self.calls, [('down', 'w'), ('up', 'w')])


class ClockTests(unittest.IsolatedAsyncioTestCase):
    async def test_zero_delay_flow_yields_to_stop_even_without_clients(self):
        async def broadcast(_):
            pass

        ex = executor.Executor(broadcast)
        ex.task = asyncio.create_task(ex.run({'nodes': [fixtures.node('a', 'delay', ms=0)], 'edges': [], 'repeat': 10000}))
        await asyncio.sleep(0)
        self.assertFalse(ex.task.done(), '纯计算流程不能占满事件循环直到整图结束')
        ex.stop()
        await asyncio.wait_for(ex.task, 1)
        self.assertTrue(ex.stopped)

    async def test_pause_is_frozen_before_any_waiter_and_counted_once(self):
        ex = executor.Executor(None)
        ex.running = True
        # 替换 executor.time 引用，不修改 asyncio 使用的全局 time 模块。
        from types import SimpleNamespace
        now = [100.0]
        with patch.object(executor, 'time', SimpleNamespace(monotonic=lambda: now[0])):
            ex.pause()
            now[0] = 110.0
            self.assertEqual(ex._active_ms(99.0), 1000)
            tasks = [asyncio.create_task(ex.wait_if_paused()) for _ in range(2)]
            await asyncio.sleep(0)
            ex.resume()
            await asyncio.gather(*tasks)
            self.assertEqual(ex._paused_ms, 10000)
            self.assertEqual(ex._active_ms(99.0), 1000)

    async def test_overdue_replay_event_does_not_bypass_pause(self):
        calls = []
        ex = executor.Executor(None)
        ex.running = True
        ex.pause()
        with patch.object(inputctl, 'key_down', side_effect=lambda *args: calls.append(args)):
            task = asyncio.create_task(ex._replay_events([{'type': 'keydown', 't': 0, 'key': 'w'}], 1))
            await asyncio.sleep(0.02)
            self.assertEqual(calls, [])
            ex.resume()
            await asyncio.wait_for(task, 1)
        self.assertEqual(len(calls), 1)

    async def test_running_stays_true_until_cleanup_finishes(self):
        async def broadcast(_):
            pass

        entered, proceed = threading.Event(), threading.Event()

        def cleanup(**_):
            entered.set()
            if not proceed.wait(2):
                raise TimeoutError('test cleanup barrier')
            return 0

        ex = executor.Executor(broadcast)
        with patch.object(inputctl, 'release_all', side_effect=cleanup):
            ex.task = asyncio.create_task(ex.run({'nodes': [], 'edges': []}))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set())
                self.assertTrue(ex.running)
                self.assertTrue(ex.reconcile())
            finally:
                proceed.set()
                await asyncio.wait_for(ex.task, 2)
        self.assertFalse(ex.running)

    async def test_temporary_keyboard_press_keeps_continuous_hold(self):
        import nodes
        async def broadcast(_):
            pass
        ex = executor.Executor(broadcast)
        sig = inputctl._key_signature('w', 'real', None)
        calls = []
        prim = (lambda: calls.append('down'), lambda: calls.append('up'))
        with patch.object(inputctl, '_key_primitives', return_value=prim):
            inputctl.key_down('w')
            await nodes.keyboard(ex, {'keys': 'w', 'hold_ms': 0})
            self.assertEqual(calls, ['down'])
            inputctl.key_up('w')
        self.assertEqual(calls, ['down', 'up'])
        self.assertNotIn(sig, inputctl._held)


class GraphTests(unittest.TestCase):
    def test_malformed_graph_is_value_error_not_internal_exception(self):
        cases = [
            {'nodes': [fixtures.node('a')], 'edges': [{'source': [], 'target': 'a'}]},
            {'nodes': [fixtures.node('a')], 'edges': [{'source': 'a', 'target': 'a', 'sourceHandle': {}}]},
            {'nodes': [{'id': 'a', 'type': 'group', 'params': []}], 'edges': []},
            {'nodes': [fixtures.node('g', 'group', nodes={})], 'edges': []},
            {'nodes': [], 'edges': [], 'scripts': []},
            {'nodes': [], 'edges': [], 'scripts': {'s': {'nodes': {}, 'edges': []}}},
            {'nodes': [], 'edges': [], 'repeat': float('inf')},
        ]
        for flow in cases:
            with self.subTest(flow=flow), self.assertRaises(ValueError):
                executor.validate_flow(flow)


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.logs = []

        async def broadcast(message):
            self.logs.append(message)

        self.ex = executor.Executor(broadcast)
        self.ex.current_flow = {'nodes': [fixtures.node('a', 'keyboard', keys='w')], 'edges': []}

        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                super().__init__(detail)
                self.status_code, self.detail = status_code, detail

        async def sync_state():
            pass

        # 直接编译 main 中的真实控制函数，避免导入入口时启动真实钩子、日志和令牌读写。
        source = Path(executor.__file__).with_name('main.py').read_text(encoding='utf-8-sig')
        tree = ast.parse(source)
        names = {'_toggle_run', 'run', '_manual_input', '_await_stop'}
        functions = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name in names]
        for node in functions:
            node.decorator_list = []
        self.lock = asyncio.Lock()
        self.ns = {
            'asyncio': asyncio, 'executor': self.ex,
            'manager': SimpleNamespace(connections=set()),
            'enginelog': SimpleNamespace(warn=lambda *_: None),
            'RunRequest': SimpleNamespace, 'HTTPException': HTTPException,
            '_check_flow_or_400': executor.validate_flow, '_run_lock': self.lock,
            '_sync_repeat': lambda _: {}, '_spawn': asyncio.create_task,
            '_sync_run_state': sync_state,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<main control functions>', 'exec'), self.ns)

    async def test_cached_flow_fallback_uses_working_start_path(self):
        with patch.object(inputctl, 'key_down'), patch.object(inputctl, 'key_up'):
            await self.ns['_toggle_run']()
            self.assertIsNotNone(self.ex.task)
            await self.ex.task
        self.assertEqual(self.ex.run_generation, 1)
        self.assertFalse(self.ex.running)

    async def test_immediate_stop_before_task_start_is_not_lost(self):
        with patch.object(inputctl, 'key_down') as down:
            await self.ns['run'](SimpleNamespace(flow=self.ex.current_flow))
            self.ex.stop()
            await self.ex.task
        down.assert_not_called()
        self.assertTrue(self.ex.stopped)

    async def test_debug_input_cannot_interleave_with_running_flow(self):
        async def wait_forever():
            await asyncio.Event().wait()

        self.ex.running = True
        self.ex.task = asyncio.create_task(wait_forever())
        calls = []
        try:
            with self.assertRaises(self.ns['HTTPException']) as raised:
                await self.ns['_manual_input'](lambda: calls.append(1))
            self.assertEqual(raised.exception.status_code, 409)
            self.assertEqual(calls, [])
        finally:
            self.ex.task.cancel()
            await asyncio.gather(self.ex.task, return_exceptions=True)

    async def test_cancelling_debug_http_keeps_start_lock_until_worker_exits(self):
        entered, proceed = threading.Event(), threading.Event()

        def operation():
            entered.set()
            if not proceed.wait(2):
                raise TimeoutError('test worker barrier')

        request = asyncio.create_task(self.ns['_manual_input'](operation))
        try:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(entered.is_set())
            request.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.lock.locked())
        finally:
            proceed.set()
            await asyncio.gather(request, return_exceptions=True)
        self.assertFalse(self.lock.locked())


class BroadcastTests(unittest.IsolatedAsyncioTestCase):
    async def test_multiple_broadcasts_are_nonblocking_ordered_and_single_writer(self):
        class Socket:
            active = 0
            overlap = False

            def __init__(self):
                self.messages = []

            async def send_text(self, text):
                self.active += 1
                self.overlap |= self.active > 1
                await asyncio.sleep(0)
                self.messages.append(json.loads(text)['n'])
                self.active -= 1

        manager = ws_manager.ConnectionManager()
        socket = Socket()
        manager.connections.add(socket)
        try:
            await asyncio.gather(*(manager.broadcast({'n': n}) for n in range(20)))
            await asyncio.wait_for(manager._queues[socket].join(), 1)
            self.assertFalse(socket.overlap)
            self.assertEqual(socket.messages, list(range(20)))
        finally:
            await manager.aclose()
        self.assertFalse(manager._queues)
        self.assertFalse(manager._senders)

    async def test_queue_capacity_is_bounded_and_close_is_requested(self):
        manager = ws_manager.ConnectionManager()
        slow = fixtures.SlowSocket()
        manager.connections.add(slow)
        try:
            with patch.object(ws_manager, 'MAX_PENDING_MESSAGES', 2):
                for n in range(3):
                    await manager.broadcast({'n': n})
            self.assertNotIn(slow, manager.connections)
            self.assertEqual(manager.dropped_messages, 3)
            for _ in range(10):
                await asyncio.sleep(0)
                if slow.closed_by_engine:
                    break
            self.assertTrue(slow.closed_by_engine)
        finally:
            await manager.aclose()


if __name__ == '__main__':
    unittest.main(verbosity=2)
