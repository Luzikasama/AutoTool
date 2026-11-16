/** 工程级键鼠时间轴：计划是可选择分支的示意；实测只根据成功下发的输入事件配对。 */
import { timedAction, segmentDuration } from './timedSegment'
import {lowerFlatGraph} from './flatFlow'
export interface TimelineSource {
  scriptId: string
  groupPath: string[]
  nodeId: string
  label: string
  path: string
  trackId?: string
  axisId?: string
  trackLabel?: string
  primary?: boolean
  configuredDelayMs?: number
  configuredDurationMs?: number
  configuredStartMs?: number
  configuredWheel?: {dx:number;dy:number}
}
export type TimelineDevice = 'key' | 'mouse' | 'motion' | 'wheel' | 'text' | 'flow'
export interface TimelineSpan {
  id: string
  lane: string
  device: TimelineDevice
  key: string
  label: string
  start: number
  end: number
  source: TimelineSource
  endSource?: TimelineSource
  mode: string
  kind: 'hold' | 'point' | 'gap' | 'action'
  estimated?: boolean
  open?: boolean
  note?: string
}
export interface TimelineSection {
  id: string
  title: string
  spans: TimelineSpan[]
  duration: number
  warnings: string[]
}
export interface TimelineBranch { key: string; label: string }
export interface TimelinePlan {
  sections: TimelineSection[]
  branches: TimelineBranch[]
  nodeCount: number
  coveredCount: number
  warnings: string[]
}
export interface InputTraceEvent {
  seq: number
  time_ms: number
  active_ms?: number
  expected_start_ms?: number
  expected_delay_ms?: number
  configured_start_ms?: number
  expected_duration_ms?: number | null
  expected_clicks?: number | null
  expected_chars?: number | null
  expected_key?: string
  timing_kind?: 'fixed'|'budget'|'unknown'
  branch?: string
  kind: string
  device?: string
  key?: string
  mode?: string
  window?: number
  script_id?: string
  group_path?: string[]
  node_id?: string
  node_type?: string
  path?: string
  x?: number
  y?: number
  dx?: number
  dy?: number
  chars?: number
  duration_ms?: number
  cleanup?: boolean
  call_id?: string
  label?: string
  track_id?: string
  axis_id?: string
  track_label?: string
  primary?: boolean
  round?: number
  segment_iteration?: number
  status?: string
  action?: string
}
export interface InputTraceSnapshot {
  run_id: string
  project_id: string
  name: string
  running: boolean
  elapsed_ms: number
  active_elapsed_ms?: number
  last_seq: number
  dropped: number
  events: InputTraceEvent[]
}

const MAX_SPANS = 6000
const MAX_STEPS = 12000
const labels: Record<string, string> = {
  keyboard: '键盘按键', mouse: '鼠标操作', record: '录制回放', autoclick: '连点器',
  text_input: '文本输入', find_image: '图像识别', wait: '等待', delay: '延时',
  judge: '判断', loop: '循环', group: '组合节点', script_call: '调用脚本', terminate: '终止',
}
const legacy: Record<string, string> = { click: 'mouse', key: 'keyboard', macro: 'record', text: 'text_input' }
const aliases: Record<string, string> = { control: 'ctrl', escape: 'esc', return: 'enter', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', meta: 'win' }
export function timelineKeys(raw: unknown): string[] {
  return [...new Set(String(raw || '').split('+').map(k => {
    const key = k.trim().toLowerCase()
    return aliases[key] || key
  }).filter(Boolean))]
}
export function sourceKey(source: Pick<TimelineSource, 'scriptId' | 'groupPath' | 'nodeId'>): string {
  return JSON.stringify([source.scriptId, source.groupPath, source.nodeId])
}
export function formatTimelineTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
}

interface Node { id: string; type: string; label: string; params: Record<string, any>; once: boolean }
interface Graph { nodes: Node[]; edges: any[] }
interface Context { scriptId: string; groupPath: string[]; path: string; trackId?: string; axisId?: string; trackLabel?: string; primary?: boolean }
function graph(raw: any): Graph {
  if((raw?.nodes || []).some((n:any)=>['parallel','scope'].includes(n.data?.nodeType || n.type))) {
    try {raw=lowerFlatGraph(raw.nodes,raw.edges || [])} catch { /* 尚未连接完整的图仍允许继续编辑。 */ }
  }
  return {
    nodes: (Array.isArray(raw?.nodes) ? raw.nodes : []).map((n: any) => {
      const type = n.data?.nodeType || n.data?.stepType || n.type
      return { id: String(n.id), type: legacy[type] || type, label: n.data?.label || n.label || labels[type] || type, params: n.data?.params || n.params || {}, once: !!(n.data?.once ?? n.once) }
    }),
    edges: Array.isArray(raw?.edges) ? raw.edges : [],
  }
}
function source(node: Node, ctx: Context): TimelineSource {
  const p=node.params,known=(raw:any,fallback?:number)=>{const value=raw==null?fallback:Number(raw);return typeof value==='number'&&Number.isFinite(value)?value:undefined}
  let duration:number|undefined
  if(node.type==='keyboard'&&!['down','up'].includes(p.action))duration=known(p.hold_ms,30)
  if(node.type==='mouse'&&p.action==='hold')duration=known(p.hold_ms,60)
  if(node.type==='mouse'&&p.action==='move')duration=known(p.duration_ms,0)
  if(node.type==='mouse'&&['click','double_click','right_click','middle_click'].includes(p.action || 'click')){
    const hold=known(p.hold_ms,60),interval=known(p.interval_ms,40),rawCount=known(p.clicks,1),count=p.action==='double_click'?2:p.action==='click'||!p.action?rawCount==null?undefined:Math.max(1,Math.min(10,Math.trunc(rawCount))):1
    if(hold!=null&&interval!=null&&count!=null)duration=count*hold+(count-1)*interval
  }
  if(node.type==='delay')duration=known(p.ms,0)
  if(['find_image','wait'].includes(node.type))duration=known(p.timeout_ms)
  if(node.type==='autoclick'){const count=known(p.count,10),interval=known(p.interval_ms,100);if(count!=null&&interval!=null)duration=count*interval}
  const dx=known(p.dx,0),dy=known(p.dy,-3)
  return { ...ctx, groupPath: [...(node.params._canvas_path ?? ctx.groupPath)], nodeId: node.id, label: `${node.label} #${node.id}`,configuredDelayMs:known(p.timeline?.delay_ms,0),configuredDurationMs:duration,configuredStartMs:known(p.timeline?.start_ms),...(node.type==='mouse'&&p.action==='wheel'&&dx!=null&&dy!=null?{configuredWheel:{dx,dy}}:{}) }
}
function numberValue(raw: unknown, fallback: number): { value: number; dynamic: boolean } {
  const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN
  if (raw == null) return { value: fallback, dynamic: false }
  return Number.isFinite(value) ? { value: Math.max(0, value), dynamic: false } : { value: fallback, dynamic: true }
}

class Builder {
  cursor = 0
  uncertain = false
  spans: TimelineSpan[] = []
  warnings = new Set<string>()
  held = new Map<string, TimelineSpan>()
  constructor(readonly id: string, readonly title: string, readonly maxSpans = MAX_SPANS) {}

  lane(device: TimelineDevice, key: string, mode: string, window = 0) {
    if (device === 'flow') return 'flow:process'
    return `${device}:${key}:${mode}:${mode === 'simulated' ? window : 0}`
  }
  add(device: TimelineDevice, key: string, start: number, end: number, src: TimelineSource, mode: string, kind: TimelineSpan['kind'], note = '', window = 0): TimelineSpan | undefined {
    if (this.spans.length >= this.maxSpans) { this.warnings.add(`达到操作显示上限，已截断显示`); return }
    const span: TimelineSpan = { id: `${this.id}-${this.spans.length}`, lane: this.lane(device, key, mode, window), device, key, start, end: Math.max(start, end), source: src, label: key, mode, kind, note, estimated: this.uncertain }
    this.spans.push(span)
    return span
  }
  down(device: 'key' | 'mouse', key: string, src: TimelineSource, mode: string, window = 0) {
    const lane = this.lane(device, key, mode, window) + ':' + (src.trackId || '')
    if (this.held.has(lane)) return false
    const span = this.add(device, key, this.cursor, this.cursor, src, mode, 'hold', '', window)
    if (span) this.held.set(lane, span)
    return !!span
  }
  up(device: 'key' | 'mouse', key: string, src: TimelineSource, mode: string, window = 0, cleanup = false) {
    const lane = this.lane(device, key, mode, window) + ':' + (src.trackId || '')
    const span = this.held.get(lane)
    if (!span) {
      this.add(device, key, this.cursor, this.cursor, src, mode, 'point', '未记录到对应按下（可能来自独立片段或截断的记录）', window)
      return
    }
    span.end = this.cursor
    span.endSource = src
    span.estimated ||= this.uncertain
    if (cleanup) span.note = '运行收尾自动松开'
    this.held.delete(lane)
  }
  press(keys: string[], duration: number, src: TimelineSource, mode: string, window = 0) {
    const newlyHeld = keys.filter(key => this.down('key', key, src, mode, window))
    if (newlyHeld.length !== keys.length) this.warnings.add('部分点按与持续按住重叠，持有期间不会产生新的按下边沿')
    this.cursor += duration
    newlyHeld.reverse().forEach(key => this.up('key', key, src, mode, window))
  }
  unknown(src: TimelineSource, label: string) {
    this.uncertain = true
    this.add('flow', label, this.cursor, this.cursor + 1000, src, '', 'gap', '未知耗时，以 1 秒图形占位；后续时刻为示意')
    this.cursor += 1000
    this.warnings.add('灰色斜纹段为未知耗时的占位，计划时刻不是实测时间')
  }
  finish(duration = this.cursor): TimelineSection {
    for (const span of this.held.values()) {
      span.end = Math.max(span.start, duration)
      span.open = true
      span.estimated ||= this.uncertain
      span.note ||= '未记录到显式松开；计划结束时由运行收尾清理，实测时也可能仍按住或记录不完整'
    }
    return axisSection({ id: this.id, title: this.title, spans: this.spans, duration: Math.max(1, duration), warnings: [...this.warnings] })
  }
}

export function editableSegmentTimeline(nodes: any[], context: Context, minimum = 0, tracks: any[] = [], primaryTrack = 'main',flowAxes=false): TimelineSection {
  const b = new Builder('edit', context.path)
  for (const raw of nodes.slice(0, MAX_SPANS)) {
    try {
      const action = timedAction(raw), p = action.node.params
      const n = graph({ nodes: [raw] }).nodes[0]
      const track = String(p.timeline?.track_id || 'main')
      const trackId = flowAxes?sourceKey({...context,nodeId:track}):`${sourceKey({ ...context, nodeId: '' })}:${track}`
      const parentAxis = context.axisId || (context.primary === false ? context.trackId : 'main') || 'main'
      const axisId = track === primaryTrack ? parentAxis : trackId
      const src = source(n, { ...context, trackId, axisId, trackLabel: tracks.find(t => t.id === track)?.name || (track === 'main' ? '主轴' : '副轴'), primary: axisId === 'main' })
      for (const key of action.keys) {
        const multipleClicks = p.action === 'double_click' || (p.action === 'click' && Number(p.clicks) > 1)
        const kind = ['key', 'mouse'].includes(action.device) && !['down', 'up'].includes(p.action) && !multipleClicks ? 'hold' : action.duration ? 'action' : 'point'
        const span = b.add(action.device, key, action.start, action.start + action.duration, src, 'real', kind, multipleClicks ? '连击区间包含多次按下与抬起；次数在流程参数编辑' : '')
        if (span) span.id = `edit:${action.node.id}:${key}`
      }
    } catch (error: any) { b.warnings.add(`${raw.id}：${error.message}`) }
  }
  if (nodes.length > MAX_SPANS) b.warnings.add('超过 6,000 个动作，仅显示前 6,000 个')
  const moves = b.spans.filter(s => s.device === 'motion' && s.end > s.start).sort((a,b) => a.start-b.start)
  if (moves.some((s,i) => i > 0 && s.start < moves[i-1].end)) b.warnings.add('鼠标移动轨迹发生重叠，运行前必须调整')
  const holds = b.spans.filter(s => s.kind === 'hold').sort((a,b) => a.start-b.start)
  const endByLane = new Map<string, number>()
  for (const span of holds) {
    if (span.start < (endByLane.get(span.lane) || 0)) b.warnings.add('同一个键的条带重叠时会合并持有，不会在重叠区间产生新的点击')
    endByLane.set(span.lane, Math.max(span.end, endByLane.get(span.lane) || 0))
  }
  return b.finish(Math.max(1000, Number(minimum) || 0, ...b.spans.map(s => s.end)))
}

/** 未走到的分支、未调用子脚本、未连接节点作为独立片段列出，避免误画成并发执行。 */
export function compileProjectTimeline(project: any, options: { branches?: Record<string, string>; context?: Context } = {}): TimelinePlan {
  const limit = 1
  const scripts: Record<string, any> = project?.scripts || {}
  const containers: Array<{ graph: Graph; ctx: Context }> = []
  const branches: TimelineBranch[] = []
  const covered = new Set<string>()
  const all = new Set<string>()
  const warnings = new Set<string>()
  const rootCtx: Context = options.context || { scriptId: '', groupPath: [], path: project?.name || '主脚本' }
  const collect = (raw: any, ctx: Context, depth = 0) => {
    if (depth > 16 || all.size > MAX_STEPS) { warnings.add('工程结构超过预览上限，已停止继续展开'); return }
    const g = graph(raw)
    containers.push({ graph: g, ctx })
    for (const node of g.nodes) {
      const src = source(node, ctx), key = sourceKey(src)
      all.add(key)
      if (node.type === 'judge') branches.push({ key, label: `${ctx.path} / ${src.label}` })
      if (node.type === 'group') collect(node.params, { ...ctx, groupPath: [...ctx.groupPath, node.id], path: `${ctx.path} / ${node.params.name || node.label}` }, depth + 1)
    }
  }
  collect(project, rootCtx)
  for (const [id, sub] of Object.entries(scripts)) collect(sub, { scriptId: id, groupPath: [], path: `子脚本「${(sub as any)?.name || id}」` })
  let steps = 0
  const sections: TimelineSection[] = []
  type Signal = 'end' | 'break' | 'script' | 'workflow'
  function walk(g: Graph, ctx: Context, b: Builder, start?: string, stop?: string, once = new Set<string>(), stack: string[] = [], independent = false): Signal {
    const nodes = new Map(g.nodes.map(n => [n.id, n]))
    const outs = new Map<string, any[]>()
    for (const e of g.edges) outs.set(String(e.source), [...(outs.get(String(e.source)) || []), e])
    const target = (id: string, handle?: string): string | undefined => {
      const edges = outs.get(id) || []
      const e = handle == null ? edges[0] : edges.find(e => (e.sourceHandle || '') === handle) || edges.find(e => !e.sourceHandle)
      return e ? String(e.target) : undefined
    }
    const reaches = (from: string, to: string) => {
      const seen = new Set<string>(), pending = [from]
      while (pending.length) {
        const cur = pending.pop()!
        if (cur === to) return true
        if (seen.has(cur)) continue
        seen.add(cur)
        pending.push(...(outs.get(cur) || []).map(e => String(e.target)))
      }
      return false
    }
    const incoming = new Set(g.edges.filter(e => !(nodes.get(String(e.target))?.type === 'loop' && reaches(String(e.target), String(e.source)))).map(e => String(e.target)))
    let id: string | undefined = start || g.nodes.find(n => !incoming.has(n.id))?.id || g.nodes.find(n => n.type === 'loop')?.id || g.nodes[0]?.id
    while (id && id !== stop) {
      if (++steps > MAX_STEPS || b.spans.length >= b.maxSpans) { warnings.add(`展开达到 ${MAX_STEPS} 步或 ${MAX_SPANS} 个操作上限`); return 'end' }
      const node = nodes.get(id)
      if (!node) return 'end'
      const src = source(node, ctx), key = sourceKey(src)
      if (independent && covered.has(key)) return 'end'
      covered.add(key)
      const p = node.params
      const mode = 'real'
      const window = Number(project?.window?.hwnd) || 0
      if (node.once && once.has(id) && !['judge','loop','terminate'].includes(node.type)) { id = target(id); continue }
      once.add(id)
      const value = (raw: unknown, fallback: number) => {
        const n = numberValue(raw, fallback)
        if (n.dynamic) { b.uncertain = true; b.warnings.add(`${src.label} 使用运行变量，相关时刻/次数按占位值示意`) }
        return n.value
      }
      b.cursor += value(p.timeline?.delay_ms, 0)
      if (node.type === 'judge') {
        b.add('flow', '判断', b.cursor, b.cursor, src, '', 'point', `预览${options.branches?.[key] === 'no' ? '否' : '是'}分支`)
        id = target(id, options.branches?.[key] || 'yes')
        continue
      }
      if (node.type === 'loop') {
        const fixed = !p.mode || p.mode === 'times'
        const count = fixed ? Math.max(1, Math.floor(value(p.times, 10))) : limit
        if (!fixed || count > 1) b.warnings.add(`${src.label} 仅展示一轮${fixed ? `，运行 ${count} 轮` : '（条件/无限循环）'}`)
        for (let i = 0; i < Math.min(count, limit); i++) {
          const body = target(id, 'body')
          const result = body ? walk(g, { ...ctx, path: `${ctx.path} / 循环第 ${i + 1} 轮` }, b, body, id, new Set(), stack) : 'end'
          if (result === 'workflow' || result === 'script') return result
          if (result === 'break') break
        }
        id = target(id, 'next')
        continue
      }
      if (node.type === 'terminate') return p.level === 'loop' ? 'break' : p.level === 'script' ? 'script' : 'workflow'
      if (node.type === 'group') {
        if (ctx.groupPath.length >= 16) { b.warnings.add('组合节点超过嵌套上限'); return 'end' }
        const childContext = { ...ctx, groupPath: [...ctx.groupPath, node.id], path: `${ctx.path} / ${p.name || node.label}` }
        if (p.execution === 'parallel') {
          const base = b.cursor
          let end = base
          for (const track of graph(p).nodes.slice(0,16)) {
            covered.add(sourceKey(source(track, childContext)))
            const tp = track.params, trackId = sourceKey(source(track, childContext))
            const parentAxis = ctx.axisId || (ctx.primary === false ? ctx.trackId : 'main') || 'main'
            const axisId = track.id === (p.primary_track || graph(p).nodes[0]?.id) ? parentAxis : trackId
            const tc = { ...childContext, groupPath: [...childContext.groupPath, track.id], path: `${childContext.path} / ${tp.name || track.label}`, trackId, axisId, trackLabel: tp.name || track.label, primary: axisId === 'main' }
            const inner = new Builder(`${b.id}-${track.id}`, tc.path, Math.max(1,b.maxSpans-b.spans.length))
            inner.cursor = base + value(tp.timeline?.start_ms,0)
            inner.uncertain = b.uncertain
            // 用普通组合包装，使时间片段与流程轴共享一套预览语义。
            walk({nodes:[track],edges:[]}, {...tc,groupPath:childContext.groupPath,path:childContext.path}, inner, undefined, undefined, new Set(), stack)
            for (const span of inner.spans) b.spans.push(span)
            inner.warnings.forEach(w=>b.warnings.add(w))
            end = Math.max(end,inner.cursor)
            b.uncertain ||= inner.uncertain
          }
          b.cursor = Math.max(end,base+value(p.duration_ms,0))
          if (Number(p.repeat)>1) b.warnings.add(`并行区域仅展示一轮，运行 ${p.repeat} 轮`)
        } else if (p.execution === 'timeline') {
          const inner = editableSegmentTimeline(p.nodes || [], childContext, p.duration_ms, p.tracks, p.primary_track,!!p._unified_axes)
          graph(p).nodes.forEach(child => covered.add(sourceKey(source(child, childContext))))
          inner.warnings.forEach(w => b.warnings.add(w))
          const count = Math.max(1, Math.min(1000, Math.floor(value(p.repeat, 1))))
          let ms = inner.duration
          try { ms = segmentDuration(p.nodes || [], p.duration_ms) } catch { b.warnings.add('片段含有动态或无效的时间参数，时长仅为示意'); b.uncertain = true }
          for (let r = 0; r < Math.min(count, limit); r++) {
            const base = b.cursor
            for (const span of inner.spans) b.add(span.device, span.key, base + span.start, base + span.end, span.source, span.mode, span.kind, span.note)
            b.cursor += ms
          }
          if (count > 1) b.warnings.add(`录制区域仅展示一轮，运行 ${count} 轮`)
        } else {
          const result = walk(graph(p), childContext, b, undefined, undefined, new Set(), stack)
          if (result !== 'end') return result
        }
      } else if (node.type === 'script_call') {
        const sid = String(p.script_id || '')
        if (!scripts[sid] || stack.includes(sid) || stack.length >= 16) b.warnings.add(`${src.label} 子脚本缺失、递归或超过深度，无法展开`)
        else {
          const result = walk(graph(scripts[sid]), { ...ctx, scriptId: sid, groupPath: [], path: `${ctx.path} / ${scripts[sid].name || sid}` }, b, undefined, undefined, new Set(), [...stack, sid])
          if (result === 'workflow') return result
        }
      } else if (node.type === 'keyboard') {
        const keys = timelineKeys(p.keys || p.key)
        if (keys.some(k => k.includes('{{'))) b.warnings.add(`${src.label} 按键由运行变量决定`)
        if (p.action === 'down') keys.forEach(k => b.down('key', k, src, mode, window))
        else if (p.action === 'up') [...keys].reverse().forEach(k => b.up('key', k, src, mode, window))
        else b.press(keys, value(p.hold_ms, 30), src, mode, window)
      } else if (node.type === 'delay') {
        const ms = value(p.ms, 0)
        b.add('flow', '延时', b.cursor, b.cursor + ms, src, '', 'action')
        b.cursor += ms
      } else if (node.type === 'mouse' || node.type === 'autoclick') {
        const action = p.action || 'click'
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : String(p.button || 'left')
        const point = `坐标 (${p.x ?? 0}, ${p.y ?? 0})`
        if (node.type === 'mouse' && action === 'down') b.down('mouse', button, src, mode, window)
        else if (node.type === 'mouse' && action === 'up') b.up('mouse', button, src, mode, window)
        else if (node.type === 'mouse' && action === 'hold') {
          b.down('mouse', button, src, mode, window)
          b.cursor += value(p.hold_ms, 60)
          b.up('mouse', button, src, mode, window)
        }
        else if (node.type === 'mouse' && action === 'move') {
          const ms = value(p.duration_ms, 0)
          b.add('motion', '鼠标移动', b.cursor, b.cursor + ms, src, mode, 'action', point, window)
          b.cursor += ms
        } else if (node.type === 'mouse' && action === 'wheel') {
          b.add('wheel', '滚轮', b.cursor, b.cursor, src, mode, 'point', `水平 ${p.dx || 0}，垂直 ${p.dy ?? -3}`, window)
        } else if(node.type==='mouse'){
          const count=action==='double_click'?2:Math.max(1,Math.min(10,Math.floor(value(p.clicks,1))))
          for(let i=0;i<count;i++){
            b.down('mouse',button,src,mode,window)
            b.cursor+=value(p.hold_ms,60)
            b.up('mouse',button,src,mode,window)
            if(i<count-1)b.cursor+=value(p.interval_ms,40)
          }
        } else {
          const count = node.type === 'autoclick' ? Math.max(1, Math.min(100000, Math.floor(value(p.count, 10)))) : action === 'double_click' ? 2 : Math.max(1, Math.min(10, Math.floor(value(p.clicks, 1))))
          const interval = node.type === 'autoclick' ? value(p.interval_ms, 100) : 0
          if (count > b.maxSpans - b.spans.length) b.warnings.add(`${src.label} 点击过多，时间轴达到操作上限后截断`)
          for (let i = 0; i < count && b.spans.length < b.maxSpans; i++) {
            if (b.held.has(b.lane('mouse', button, mode, window)+':'+(src.trackId || ''))) { b.warnings.add(`${src.label} 与持续按住的鼠标键冲突，运行时会拒绝点击`); break }
            b.cursor += 50
            b.down('mouse', button, src, mode, window)
            b.up('mouse', button, src, mode, window)
            if (node.type !== 'autoclick' && i < count - 1) b.cursor += 50
            b.cursor += interval
          }
        }
      } else if (node.type === 'record') {
        const events = Array.isArray(p.events) ? p.events : []
        const speed = Math.max(0.01, value(p.speed, 1))
        const count = Math.max(1, Math.floor(value(p.repeat, 1)))
        if (count > 1) b.warnings.add(`${src.label} 回放仅展示一次，运行 ${count} 次`)
        for (let r = 0; r < Math.min(count, limit); r++) {
          const base = b.cursor
          for (const ev of events) {
            if (b.spans.length >= b.maxSpans) { b.warnings.add(`${src.label} 回放事件过多，已截断显示`); break }
            b.cursor = Math.max(b.cursor, base + value(ev.t, 0) / speed)
            if (ev.type === 'keydown') b.down('key', timelineKeys(ev.key)[0] || String(ev.key), src, mode, window)
            else if (ev.type === 'keyup') b.up('key', timelineKeys(ev.key)[0] || String(ev.key), src, mode, window)
            else if (ev.type === 'mousedown') b.down('mouse', ev.button || 'left', src, mode, window)
            else if (ev.type === 'mouseup') b.up('mouse', ev.button || 'left', src, mode, window)
            else if (ev.type === 'scroll') b.add('wheel', '滚轮', b.cursor, b.cursor, src, mode, 'point', `水平 ${ev.dx || 0}，垂直 ${ev.dy || 0}`, window)
            else if (ev.type === 'mousemove') b.add('motion', '鼠标移动', b.cursor, b.cursor, src, mode, 'point', `坐标 (${ev.x}, ${ev.y})`, window)
          }
        }
      } else if (node.type === 'text_input') {
        const text = String(p.text || '')
        if (p.method === 'clipboard') {
          b.press(['ctrl', 'v'], 0, src, mode, window)
          b.cursor += 150
        } else {
          if (text.includes('{{')) b.uncertain = true
          const duration = Array.from(text).length * value(p.interval_ms, 10)
          b.add('text', '文本输入', b.cursor, b.cursor + duration, src, mode, 'action', text.includes('{{') ? '内容长度由运行变量决定' : `${Array.from(text).length} 个字符，不展示正文`, window)
          b.cursor += duration
          if (text.includes('{{')) b.uncertain = true
        }
      } else if (['find_image','wait'].includes(node.type)) {
        const timeout = value(p.timeout_ms, node.type === 'find_image' ? 5000 : 0)
        if (node.type === 'wait' && timeout === 0) b.unknown(src, '等待（无超时）')
        else {
          b.add('flow', labels[node.type], b.cursor, b.cursor+timeout, src, '', 'gap', '超时预算；条件满足会提前结束，后续操作随即开始')
          b.cursor += timeout
          b.uncertain = true
          b.warnings.add('找图与等待条带显示超时预算；条件提前满足时，实际后续操作会提前开始')
        }
      } else if (!['variable', 'calculate', 'clipboard'].includes(node.type)) b.unknown(src, labels[node.type] || node.label)
      id = target(id)
    }
    return 'end'
  }
  const main = new Builder('main', '主流程 · 所选分支')
  const repeat = Math.max(1, Math.floor(numberValue(project?.repeat, 1).value))
  if (repeat > 1) main.warnings.add(`仅展示一轮，工程运行 ${repeat} 轮；重复次数仍由流程设置控制`)
  const once = new Set<string>()
  for (let i = 0; i < Math.min(repeat, limit); i++) {
    if (walk(graph(project), { ...rootCtx, path: `${rootCtx.path} / 第 ${i + 1} 轮` }, main, undefined, undefined, once) === 'workflow') break
  }
  sections.push(main.finish())
  let remaining = MAX_SPANS - main.spans.length
  catalog: for (const container of containers) {
    for (const node of container.graph.nodes) {
      if (remaining <= 0) { warnings.add(`工程时间轴最多显示 ${MAX_SPANS} 个操作，请选择片段查看`); break catalog }
      if (covered.has(sourceKey(source(node, container.ctx))) || steps >= MAX_STEPS) continue
      const extra = new Builder(`extra-${sections.length}`, `独立片段 · ${container.ctx.path} / ${node.label} #${node.id}`, remaining)
      walk(container.graph, container.ctx, extra, node.id, undefined, new Set(), [], true)
      if (extra.spans.length) { sections.push(extra.finish()); remaining -= extra.spans.length }
    }
  }
  if (sections.length > 1) warnings.add('独立片段包含未选分支、未调用子脚本或未连接节点，各片段从零开始，不表示同时执行')
  if ([...all].some(key => !covered.has(key))) warnings.add('部分节点因展开上限未纳入当前预览')
  return { sections, branches, nodeCount: all.size, coveredCount: covered.size, warnings: [...warnings] }
}

export function traceRounds(snapshot: InputTraceSnapshot): number[] {
  return [...new Set(snapshot.events.filter(e=>e.kind==='round_start').map(e=>e.round || 1))]
}
export function traceTimeline(snapshot: InputTraceSnapshot, requestedRound?: number, activeTime=false): TimelineSection {
  if(activeTime)snapshot={...snapshot,elapsed_ms:snapshot.active_elapsed_ms ?? snapshot.elapsed_ms,events:snapshot.events.map(e=>({...e,time_ms:e.active_ms ?? e.time_ms}))}
  const b = new Builder('actual', `${snapshot.name || '工程'} · 实际运行`)
  const starts = snapshot.events.filter(e=>e.kind==='round_start')
  const round = requestedRound || starts[starts.length-1]?.round || 1
  const from = starts.find(e=>e.round===round)?.time_ms || 0
  const until = snapshot.events.find(e=>e.kind==='round_end' && e.round===round)?.time_ms ?? snapshot.elapsed_ms
  const selectedEvents = snapshot.events.filter(e=>e.time_ms>=from && e.time_ms<=until && (!e.round || e.round===round))
  const calls = new Set(selectedEvents.filter(e=>e.kind==='node_start' || e.kind==='node_end').map(e=>e.call_id))
  const pending = new Map<string, InputTraceEvent>()
  const eventSource = (event: InputTraceEvent): TimelineSource => ({ scriptId:event.script_id || '',groupPath:event.group_path || [],nodeId:event.node_id || '',label:`${event.label || labels[event.node_type || ''] || event.node_type || '输入'} #${event.node_id || '?'}`,path:event.path || '运行收尾',trackId:event.track_id,axisId:event.axis_id,trackLabel:event.track_label,primary:event.primary })
  const logical = (first: InputTraceEvent, last?: InputTraceEvent) => {
    const device = (['key','mouse','motion','wheel','text','flow'].includes(first.device || '') ? first.device : 'flow') as TimelineDevice
    const span = b.add(device,(device==='key'?first.expected_key:undefined) || first.key || first.label || labels[first.node_type || ''] || '流程',Math.max(0,first.time_ms-from),Math.max(0,(last?.time_ms ?? until)-from),eventSource(first),first.mode || '',device==='key'||device==='mouse'?'hold':'action',last?.status === 'cancelled' ? '已取消并清理输入' : '')
    if(span) {span.id=`call-${first.call_id}`;span.open=!last}
  }
  for (const event of selectedEvents) {
    if(event.kind==='node_start' && event.call_id) {
      if(['down','up'].includes(event.action || '') && ['key','mouse'].includes(event.device || '')) {
        b.cursor=event.time_ms-from
        const keys=event.device==='key'?timelineKeys(event.expected_key || event.key):[event.key || 'left']
        keys.forEach(key => event.action==='down' ? b.down(event.device as 'key'|'mouse',key,eventSource(event),event.mode||'real') : b.up(event.device as 'key'|'mouse',key,eventSource(event),event.mode||'real'))
      } else pending.set(event.call_id,event)
      continue
    }
    if(event.kind==='node_end' && event.call_id) {
      const first=pending.get(event.call_id)
      if(first) {logical(first,event);pending.delete(event.call_id)}
      else if(!selectedEvents.some(e=>e.kind==='node_start' && e.call_id===event.call_id)) b.warnings.add('部分动作起点已移出记录，无法完整还原')
      continue
    }
    if(event.call_id && calls.has(event.call_id) && !event.cleanup) continue
    const before = b.spans.length
    const src = eventSource(event)
    b.cursor = Math.max(b.cursor, (Number(event.time_ms) || 0)-from)
    const mode = event.mode || 'real', window = event.window || 0
    if (event.kind === 'down' || event.kind === 'up') {
      const device = event.device === 'mouse' ? 'mouse' : 'key'
      if (event.kind === 'down') b.down(device, event.key || '?', src, mode, window)
      else b.up(device, event.key || '?', src, mode, window, event.cleanup)
    } else if (event.kind === 'move') b.add('motion', '鼠标移动', b.cursor, b.cursor, src, mode, 'point', `坐标 (${event.x}, ${event.y})`, window)
    else if (event.kind === 'scroll') b.add('wheel', '滚轮', b.cursor, b.cursor, src, mode, 'point', `水平 ${event.dx || 0}，垂直 ${event.dy || 0}`, window)
    else if (event.kind === 'text') b.add('text', '文本输入', Math.max(0, b.cursor - (event.duration_ms || 0)), b.cursor, src, mode, 'action', `${event.chars || 0} 个字符，不记录正文`, window)
    if (b.spans.length > before) b.spans[b.spans.length - 1].id = `actual-${event.seq}`
  }
  pending.forEach(first=>logical(first))
  if (snapshot.dropped) b.warnings.add(`记录容量有限，最早的 ${snapshot.dropped} 个事件已移出；缺少按下的松开事件以标记显示`)
  if (snapshot.events.length && snapshot.events[0].seq > 1 && !snapshot.dropped) b.warnings.add('输入记录存在缺口，请刷新补取记录')
  const section=b.finish(Math.max(1,until-from))
  section.title += ` · 第 ${round} 轮`
  return section
}

export function containerTimeline(raw: any, context: Context, scripts: any = {}, branches:Record<string,string> = {}): TimelineSection {
  if(raw.execution==='timeline') return editableSegmentTimeline(raw.nodes||[],context,raw.duration_ms,raw.tracks,raw.primary_track)
  if(raw.execution==='parallel') {
    const id=context.groupPath[context.groupPath.length-1] || '_parallel'
    const plan=compileProjectTimeline({name:context.path,nodes:[{id,type:'group',params:raw}],edges:[],scripts},{context:{...context,groupPath:context.groupPath.slice(0,-1)}})
    return {...plan.sections[0],warnings:[...plan.warnings,...plan.sections[0].warnings]}
  }
  const plan=compileProjectTimeline({...raw,scripts},{context,branches})
  return {...plan.sections[0],warnings:[...plan.warnings,...plan.sections[0].warnings]}
}

/** 主副轴按执行序列分组；组合按键在同一动作条带中显示。物理设备身份仍用于输入配对。 */
function axisSection(section: TimelineSection): TimelineSection {
  const merged: TimelineSpan[] = [], combos = new Map<string,TimelineSpan>()
  for(const span of section.spans) {
    span.lane=span.source.axisId || (span.source.primary === true ? 'main' : span.source.trackId) || 'main'
    if(span.device==='key' && span.kind==='hold') {
      const key=JSON.stringify([sourceKey(span.source),span.lane,span.start,span.end,span.mode,span.open])
      const prior=combos.get(key)
      if(prior) {prior.key += '+'+span.key;prior.label=prior.key.toUpperCase();continue}
      combos.set(key,span)
    }
    span.label = span.device==='key' ? span.key.toUpperCase() : span.device==='mouse' ? ({left:'鼠标左键',right:'鼠标右键',middle:'鼠标中键'}[span.key] || span.key) : span.key
    merged.push(span)
  }
  return {...section,spans:merged}
}
export function timelineLanes(spans: TimelineSpan[]) {
  const lanes = new Map<string, { id:string;label:string;device:TimelineDevice;mode:string;primary:boolean }>()
  for(const span of spans) if(!lanes.has(span.lane)) lanes.set(span.lane,{id:span.lane,label:span.source.trackLabel || '所选分支',device:span.device,mode:'',primary:span.source.primary ?? span.lane==='main'})
  return [...lanes.values()].sort((a,b)=>Number(b.primary)-Number(a.primary))
}
