/** 前端连接竞态测试：真实 store 代码 + 假 WebSocket/HTTP，无需浏览器和引擎。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const source = readFileSync(new URL('../frontend/src/stores/engine.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function setup() {
  const timers = new Map()
  let timerId = 0
  const sockets = []
  const requests = []
  const project = { running: false, paused: false, addLog() {} }
  const roots={doc:{repeat:1},other:{repeat:2}}
  const docs={getRoot:id=>roots[id],setRepeat:(id,value)=>{if(roots[id])roots[id].repeat=value}}
  class Socket {
    constructor() { sockets.push(this) }
    close() { this.closed = true }
    open() { this.onopen?.() }
    message(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
    end(code = 1006) { this.onclose?.({ code }) }
  }
  const api = {
    engineWsUrl: () => 'ws://test',
    engine: {
      health: async () => ({ version: 'test', desktop: false }),
      inputSettings:async()=>({background_click:false}),
      loadFlow:async payload=>({repeat_state:{doc_id:payload.client_doc_id,value:payload.repeat,revision:10},repeat_accepted:true}),
      runState: () => {
        const request = deferred()
        requests.push(request)
        return request.promise
      },
    },
  }
  const imports = {
    pinia: { defineStore: (_id, factory) => factory },
    vue: { ref: (value) => ({ value }) },
    '../api/client': api,
    './project': { useProjectStore: () => project },
    './docs':{useDocsStore:()=>docs},
  }
  const exports = {}
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => {
      assert.ok(imports[name], `Unexpected import: ${name}`)
      return imports[name]
    },
    WebSocket: Socket,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout: (id) => timers.delete(id),
  }, { filename: fileURLToPath(new URL('../frontend/src/stores/engine.ts', import.meta.url)) })
  const store = exports.useEngineStore()
  return { store, sockets, requests, project, timers,roots }
}

const tick = async () => { await Promise.resolve(); await Promise.resolve() }

{
  const { store, sockets, timers, project } = setup()
  store.start()
  const old = sockets[0]
  old.open()
  project.running = true
  old.end()
  assert.equal(timers.size, 1)
  assert.equal(project.running, true, '断线不能冒充停止')
  store.retryNow()
  assert.equal(timers.size, 0)
  sockets[1].open()
  old.end()
  old.message({ type: 'state', state: 'idle' })
  assert.equal(store.connected.value, true)
  assert.equal(project.running, true)
  assert.equal(timers.size, 0, '旧连接不能安排新重连')
  store.stop()
  sockets[1].open()
  assert.equal(store.connected.value, false, 'stop 后晚到的 open 无效')
  store.start()
  assert.equal(sockets.length, 3, 'stop 后允许重新 start')
  store.stop()
}

{
  const { store, sockets, requests, project } = setup()
  store.start()
  sockets[0].open()
  sockets[0].message({ type: 'state', state: 'running', paused: true })
  requests[0].resolve({ running: false, paused: false })
  await tick()
  assert.equal(project.running, true, '旧 HTTP 快照不能覆盖新 WS 状态')
  assert.equal(project.paused, true)
  const first = store.syncRunState()
  const second = store.syncRunState()
  requests[2].resolve({ running: true, paused: false })
  await second
  requests[1].resolve({ running: false, paused: false })
  await first
  assert.equal(project.running, true, '较早轮询不能覆盖较新轮询')
  const pending = store.syncRunState()
  store.retryNow()
  sockets[1].open()
  requests[3].resolve({ running: false, paused: false })
  await pending
  assert.equal(project.running, true, '旧连接上的 HTTP 响应不能覆盖新连接')
  store.stop()
}

{
  const {store,sockets,requests,roots}=setup();store.start();sockets[0].open()
  sockets[0].message({type:'repeat',doc_id:'doc',value:7,revision:2})
  sockets[0].message({type:'repeat',doc_id:'doc',value:1,revision:1})
  assert.equal(roots.doc.repeat,7);assert.equal(roots.other.repeat,2)
  requests[0].resolve({running:false,paused:false,repeat_state:{doc_id:'doc',value:1,revision:1}});await tick();assert.equal(roots.doc.repeat,7)
  const state=store.syncRunState();requests[1].resolve({running:false,paused:false,repeat_state:{doc_id:'doc',value:9,revision:3}});await state;assert.equal(roots.doc.repeat,9)
  const pending=store.loadCurrentFlow({client_doc_id:'doc',repeat:9});roots.doc.repeat=12;await pending
  assert.equal(roots.doc.repeat,12,'新的本地编辑不能被旧 HTTP 回执覆盖');store.stop()
  store.acceptRepeat({doc_id:'doc',value:4,revision:1,epoch:'new-engine'})
  assert.equal(roots.doc.repeat,4,'引擎重启后新的版本世代可从 1 开始同步')
}
console.log('通过：连接竞态、轮数版本同步、工程隔离、重连补齐与本地编辑保护')
