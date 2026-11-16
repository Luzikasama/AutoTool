/**
 * 引擎连接与「全局（不属于某个脚本）」的状态。
 *
 * 为什么必须集中：引擎只允许**一个**编辑器页面连接（多开会互相覆盖流程同步，
 * 见 main.py 的 4409），所以 WebSocket 必须是全应用一条。0.1.2 起界面里可以同时
 * 开着多个脚本标签，如果每个标签各连一次，第二个标签会立刻被引擎拒掉。
 *
 * 这里还收拢了所有「跟哪个脚本无关」的状态：引擎版本、桌面/浏览器形态、
 * 悬浮框开关、模板与窗口列表、录制状态。真正跟脚本有关的（节点、历史、脚本名）
 * 留在各自的文档里。
 *
 * 页面事件（拾取坐标 / 录制完成 / 引擎请求启动）必须交给**当前活动标签**处理，
 * 因此走 `setHandlers` 注册：谁在前台谁接管，切标签时重新注册。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { engine, engineWsUrl } from '../api/client'
import { useProjectStore } from './project'
import {useDocsStore} from './docs'
import type { WindowInfo } from '../types'

export interface EngineHandlers {
  /** 引擎要求启动流程（全局快捷键 / 悬浮框按钮） */
  onRunRequest?: () => void
  /** 拾取到屏幕坐标 */
  onPicked?: (x: number, y: number) => void
  /** 悬浮框改了循环轮数 */
  onRepeat?: (value: number) => void
  /** 一段键鼠录制结束 */
  onRecorded?: (events: any[]) => void
  /** 请求当前文档的流程负载（引擎连上来时同步用） */
  payload?: () => any
}

export const useEngineStore = defineStore('engine', () => {
  const project = useProjectStore()
  const docs=useDocsStore()
  const repeatRevisions=ref<Record<string,number>>({})
  const repeatEpoch=ref('')
  function acceptRepeat(state:any,preserveLocal=false){
    if(state?.epoch&&state.epoch!==repeatEpoch.value){repeatEpoch.value=state.epoch;repeatRevisions.value={}}
    if(!state?.doc_id || !Number.isFinite(state.revision) || state.revision<=(repeatRevisions.value[state.doc_id] || 0))return
    repeatRevisions.value={...repeatRevisions.value,[state.doc_id]:state.revision}
    if(!preserveLocal)docs.setRepeat(state.doc_id,state.value)
  }
  let flowQueue:Promise<any>=Promise.resolve()
  function loadCurrentFlow(payload:any){
    let generation=wsGen
    flowQueue=flowQueue.catch(()=>{}).then(()=>{generation=wsGen;return engine.loadFlow(payload)}).then(result=>{
      if(generation!==wsGen)return result
      acceptRepeat(result?.repeat_state,result?.repeat_accepted!==false&&docs.getRoot(payload.client_doc_id)?.repeat!==payload.repeat)
      return result
    })
    return flowQueue
  }

  const version = ref('')
  const desktop = ref(false)
  const connected = ref(false)
  /** 被引擎拒绝（已有另一个编辑器窗口在运行） */
  const busy = ref(false)

  const templates = ref<{ label: string; value: string }[]>([])
  const windows = ref<WindowInfo[]>([])

  const overlayEnabled = ref(false)
  const overlayAvailable = ref(true)
  const backgroundClick = ref(false)

  const macroRecording = ref(false)

  let ws: WebSocket | null = null
  let wsRetry: ReturnType<typeof setTimeout> | null = null
  let wsFailCount = 0
  // 连接代数：只有"最新那次 connect"建出来的 socket，它的回调才算数
  let wsGen = 0
  let stateRevision = 0
  let stateRequest = 0
  let destroyed = false
  let handlers: EngineHandlers = {}
  let started = false

  function setHandlers(h: EngineHandlers) {
    handlers = h
  }

  function retryWs(delay: number) {
    if (destroyed) return
    if (wsRetry) clearTimeout(wsRetry)
    wsRetry = setTimeout(() => {
      wsRetry = null
      connect()
    }, delay)
  }

  function retryNow() {
    if (wsRetry) {
      clearTimeout(wsRetry)
      wsRetry = null
    }
    connect()
  }

  function connect() {
    if (destroyed) return
    if (wsRetry) clearTimeout(wsRetry)
    wsRetry = null
    connected.value = false
    // 连接代数：老连接的回调（onopen / onclose）晚到时必须作废。
    // 否则手动重试 + 定时重试撞在一起时，旧连接关掉会：把好不容易连上的新连接标成断开、
    // 再挂一个重连定时器，越连越多（而且每次 onclose 都清 running，界面闪一下"未运行"）。
    const gen = ++wsGen
    // 先收掉上一条（可能是 CONNECTING 状态的），否则同一页面会开出两条连接
    try {
      ws?.close()
    } catch {
      /* 已经关掉了 */
    }
    const sock = new WebSocket(engineWsUrl())
    ws = sock
    sock.onopen = () => {
      if (gen !== wsGen) return
      busy.value = false
      connected.value = true
      wsFailCount = 0
      syncRunState()
      syncInputSettings()
    }
    sock.onmessage = (ev) => {
      if (gen !== wsGen) return
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'log') project.addLog(msg)
        else if (msg.type === 'state') {
          stateRevision += 1
          project.running = msg.state === 'running'
          if (typeof msg.paused === 'boolean') project.paused = msg.paused
        } else if (msg.type === 'overlay') overlayEnabled.value = !!msg.enabled
        else if (msg.type === 'repeat') {
          if('doc_id' in msg)acceptRepeat(msg)
          else handlers.onRepeat?.(Number(msg.value) || 1)
        }
        else if (msg.type === 'picked') handlers.onPicked?.(msg.x, msg.y)
        else if (msg.type === 'run_request') handlers.onRunRequest?.()
        else if (msg.type === 'recording') macroRecording.value = !!msg.recording
        else if (msg.type === 'recorded') handlers.onRecorded?.(msg.events || [])
        else if (msg.type === 'busy') busy.value = true
      } catch {
        /* 非 JSON 广播，忽略 */
      }
    }
    sock.onclose = (ev) => {
      if (gen !== wsGen) return
      connected.value = false
      // 断线**不等于**已停止：这里刻意不清 `project.running`。
      // 引擎可能还在跑（页面被系统挂起、网络抖动），清掉会让界面显示"未运行"，
      // 用户以为停了就去点运行，结果被引擎以 409 挡掉。
      // 界面据此显示「连接中断 / 状态未知」，重连后由 syncRunState() 拿权威状态纠正。
      if (destroyed) return
      // 4409：引擎只允许一个 WebUI，而这个页面不是那一个。
      // 不停重试是为了「刷新页面」——刷新时旧连接会先断开，通常第一次重试就能连上；
      // 真正多开的那个页面则会一直看到提示，不会去干扰正在工作的那个窗口。
      if (ev.code === 4409) {
        busy.value = true
        retryWs(1500)
        return
      }
      // 自动重连：断线期间日志/状态会丢，重连后立即同步真实状态
      wsFailCount += 1
      retryWs(Math.min(8000, 800 * 2 ** (wsFailCount - 1)))
    }
  }

  function start() {
    if (started) return
    started = true
    destroyed = false
    connect()
    const gen = wsGen
    engine
      .health()
      .then((h) => {
        if (destroyed || gen !== wsGen) return
        version.value = String(h?.version || '')
        desktop.value = !!h?.desktop
      })
      .catch(() => {
        /* 引擎不可达时留空 */
      })
  }

  function stop() {
    destroyed = true
    started = false
    wsGen += 1
    stateRequest += 1
    connected.value = false
    busy.value = false
    if (wsRetry) clearTimeout(wsRetry)
    wsRetry = null
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
    ws = null
  }

  async function syncRunState() {
    if (destroyed || !connected.value) return
    const gen = wsGen
    const revision = stateRevision
    const request = ++stateRequest
    try {
      const r = await engine.runState()
      // 旧连接的响应、较早的轮询、以及已被 WS 推送取代的快照都不能回写状态。
      if (destroyed || !connected.value || gen !== wsGen || request !== stateRequest || revision !== stateRevision) return
      project.running = !!r.running
      project.paused = !!r.paused
      acceptRepeat(r.repeat_state)
    } catch {
      /* 引擎不可达时下个周期再试 */
    }
  }

  async function refreshTemplates(quiet = false) {
    try {
      const r = await engine.listTemplates()
      templates.value = r.templates.map((t) => ({ label: t.id, value: t.id }))
    } catch (e: any) {
      if (!quiet) project.addLog({ level: 'error', message: '获取模板失败：' + e.message, ts: Date.now() / 1000 })
    }
  }

  async function refreshWindows(quiet = false) {
    try {
      const r = await engine.listWindows()
      windows.value = r.windows
    } catch (e: any) {
      if (!quiet) project.addLog({ level: 'error', message: '获取窗口列表失败：' + e.message, ts: Date.now() / 1000 })
    }
  }

  async function syncOverlay() {
    try {
      const s = await engine.overlayState()
      overlayEnabled.value = !!s.enabled
      overlayAvailable.value = s.available !== false
    } catch {
      /* 引擎不可达时下个周期再试 */
    }
  }

  async function syncInputSettings(){
    try{backgroundClick.value=!!(await engine.inputSettings()).background_click}catch{}
  }
  async function setBackgroundClick(value:boolean){
    backgroundClick.value=!!(await engine.setInputSettings(value)).background_click
  }

  async function toggleOverlay(): Promise<boolean> {
    const s = await engine.setOverlay(!overlayEnabled.value)
    overlayEnabled.value = !!s.enabled
    overlayAvailable.value = s.available !== false
    return overlayEnabled.value
  }

  async function startRecording() {
    macroRecording.value = true
    try {
      await engine.recordStart()
    } catch (e: any) {
      macroRecording.value = false
      throw e
    }
  }

  async function stopRecording() {
    await engine.recordStop()
  }

  return {
    version,
    desktop,
    connected,
    repeatRevisions,
    repeatEpoch,
    acceptRepeat,
    loadCurrentFlow,
    busy,
    templates,
    windows,
    overlayEnabled,
    overlayAvailable,
    backgroundClick,
    syncInputSettings,
    setBackgroundClick,
    macroRecording,
    setHandlers,
    start,
    stop,
    retryNow,
    syncRunState,
    refreshTemplates,
    refreshWindows,
    syncOverlay,
    toggleOverlay,
    startRecording,
    stopRecording,
  }
})
