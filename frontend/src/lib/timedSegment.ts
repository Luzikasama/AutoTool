/** 同一组普通键鼠节点同时用于流程图、时间轴、保存及执行；时间只存于节点参数。 */
export const MAX_TIMED_NODES = 6000
export const MAX_TIME_MS = 86400000
export interface TimedNode { id: string; type: string; params: Record<string, any> }
export interface TimedAction {
  node: TimedNode; start: number; duration: number; device: 'key' | 'mouse' | 'motion' | 'wheel'; keys: string[]
}
export function timedNode(raw: any): TimedNode {
  return { id: String(raw.id), type: raw.data?.nodeType || raw.type, params: raw.data?.params || raw.params || {} }
}
function number(raw: any, fallback = 0): number {
  const value = raw == null ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIME_MS) throw new Error('时间必须是 0–86,400,000ms 内的数字')
  return value
}
export function timedAction(raw: any): TimedAction {
  const node = timedNode(raw), p = node.params
  const start = number(p.timeline?.start_ms)
  if (node.type === 'keyboard') {
    const keys = [...new Set(String(p.keys || p.key || '').split('+').map(k => k.trim().toLowerCase()).filter(Boolean))]
    return { node, start, duration: ['down', 'up'].includes(p.action) ? 0 : number(p.hold_ms, 30), device: 'key', keys }
  }
  if (node.type !== 'mouse') throw new Error('精确录制区域仅支持键盘和鼠标节点；判断、找图等逻辑请连接在区域之前或汇合之后')
  const action = p.action || 'click'
  const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : p.button || 'left'
  const count = action === 'double_click' ? 2 : action === 'click' ? Math.max(1, Math.min(10, Number(p.clicks) || 1)) : 1
  const duration = action === 'move' ? number(p.duration_ms) : ['wheel', 'down', 'up'].includes(action) ? 0 : number(p.hold_ms, 60) * count + Math.max(0, count - 1) * number(p.interval_ms, 40)
  return { node, start, duration, device: action === 'move' ? 'motion' : action === 'wheel' ? 'wheel' : 'mouse', keys: [action === 'move' ? '鼠标移动' : action === 'wheel' ? '滚轮' : button] }
}
export function segmentDuration(nodes: any[], minimum: unknown = 0): number {
  return Math.max(number(minimum), ...nodes.map(n => { const a = timedAction(n); return a.start + a.duration }))
}
export function editTimedNode(raw: any, start: number, duration?: number): Record<string, any> {
  const action = timedAction(raw), p = { ...action.node.params }
  delete p.input_mode
  p.timeline = { ...p.timeline, start_ms: number(start) }
  // 调整后按统一的边界规则排序，不沿用录制时仅用于相同时间戳的先后序号。
  delete p.timeline.start_order
  delete p.timeline.end_order
  if (duration != null) {
    const ms = number(duration)
    if (action.device === 'key' && !['down', 'up'].includes(p.action)) p.hold_ms = ms
    else if (action.device === 'motion') p.duration_ms = ms
    else if (action.device === 'mouse' && !['down', 'up'].includes(p.action)) {
      if (p.action === 'double_click' || (p.action === 'click' && Number(p.clicks) > 1)) throw new Error('连击包含多次按下抬起，请在流程参数中编辑，或拆成独立点击条带')
      p.action = 'hold'; p.clicks = 1; p.button = action.keys[0]; p.hold_ms = ms
    }
  }
  return p
}
export interface SplitRecording { nodes: TimedNode[]; duration: number; warnings: string[] }
/** 录制没有显式分支，将互相重叠的动作分配到最少的执行序列；不按键位固定分轨。 */
export function assignRecordingTracks(nodes: any[]): {id:string;name:string}[] {
  const ends:number[]=[],tracks:{id:string;name:string}[]=[]
  for(const raw of [...nodes].sort((a,b)=>timedAction(a).start-timedAction(b).start)) {
    const a=timedAction(raw)
    let index=ends.findIndex(end=>end<=a.start)
    if(index<0) {index=ends.length;ends.push(0);tracks.push({id:index?'side'+index:'main',name:index?'副轴 '+index:'主轴'})}
    ends[index]=a.start+a.duration
    a.node.params.timeline={...a.node.params.timeline,track_id:tracks[index].id}
  }
  return tracks.length?tracks:[{id:'main',name:'主轴'}]
}
/** 录制还可转换成真正的并发流程，每轴用连线表达先后、用前置延迟保留间隔。 */
export function recordingFlow(nodes: TimedNode[]) {
  const copy:TimedNode[]=JSON.parse(JSON.stringify(nodes)),tracks=assignRecordingTracks(copy)
  return tracks.map(track=>{
    const actions=copy.filter(n=>n.params.timeline.track_id===track.id).sort((a,b)=>timedAction(a).start-timedAction(b).start)
    const offset=actions[0]?timedAction(actions[0]).start:0
    let end=offset
    for(const n of actions) {
      const a=timedAction(n)
      n.params.timeline={delay_ms:Math.max(0,a.start-end),...(n.params.timeline.start_order!=null?{start_order:n.params.timeline.start_order}:{}),...(n.params.timeline.end_order!=null?{end_order:n.params.timeline.end_order}:{})}
      end=a.start+a.duration
    }
    return {id:track.id,type:'group',params:{name:track.name,execution:'flow',timeline:{start_ms:offset},nodes:actions,edges:actions.slice(1).map((n,i)=>({id:`e-${actions[i].id}-${n.id}`,source:actions[i].id,target:n.id})),variables:[]}}
  })
}
/** 录制无损拆分：每个键独立配对，保留跨键/跨设备重叠、拖拽终点、间隔及同刻事件顺序。 */
export function splitRecording(events: any[], speed = 1, _inputMode = 'real'): SplitRecording {
  if (!Number.isFinite(Number(speed)) || Number(speed) <= 0) throw new Error('拆分需要确定的正数播放速度')
  if (!Array.isArray(events) || events.length > MAX_TIMED_NODES * 2) throw new Error('录制事件过多，请先缩短录制')
  const ordered = events.map((event, index) => ({ ...event, t: number(event.t) / Number(speed), index })).sort((a, b) => a.t - b.t || a.index - b.index)
  const nodes: TimedNode[] = [], held = new Map<string, any>(), warnings = new Set<string>()
  const duration = ordered[ordered.length-1]?.t || 0
  const add = (type: string, params: Record<string, any>, event: any, end?: any) => {
    nodes.push({ id: `t${nodes.length + 1}`, type, params: { ...params, timeline: { start_ms: event.t, start_order: event.index, ...(end ? { end_order: end.index } : {}) } } })
    if (nodes.length > MAX_TIMED_NODES) throw new Error('拆分超过 6,000 个动作，请先缩短录制')
  }
  const pair = (down: any, up: any) => {
    const hold_ms = Math.max(0, up.t - down.t)
    if (down.type === 'keydown') add('keyboard', { action: 'press', keys: down.key, hold_ms }, down, up)
    else {
      const click=hold_ms<=250&&!down.moved&&(up.x ?? down.x)===down.x&&(up.y ?? down.y)===down.y
      add('mouse', { action: click?'click':'hold', button: down.button || 'left', x: down.x || 0, y: down.y || 0, end_x: up.x ?? down.x ?? 0, end_y: up.y ?? down.y ?? 0, hold_ms }, down, up)
    }
  }
  for (const event of ordered) {
    const isKey = event.type === 'keydown' || event.type === 'keyup'
    const key = isKey ? String(event.key || '').trim().toLowerCase() : String(event.button || 'left')
    const signature = `${isKey ? 'key' : 'mouse'}:${key}`
    if (event.type === 'keydown' || event.type === 'mousedown') {
      if (!key) throw new Error('录制包含空按键')
      if (!held.has(signature)) held.set(signature, { ...event, key })
    } else if (event.type === 'keyup' || event.type === 'mouseup') {
      const down = held.get(signature)
      if (down) { pair(down, event); held.delete(signature) }
      else {
        add(isKey ? 'keyboard' : 'mouse', isKey ? { action: 'up', keys: key } : { action: 'up', button: key, x: event.x || 0, y: event.y || 0 }, event)
        warnings.add('保留了未配对的松开事件，请检查录制起点')
      }
    } else if (event.type === 'mousemove') {
      for(const [signature,down] of held)if(signature.startsWith('mouse:')&&(down.x!==event.x||down.y!==event.y))down.moved=true
      add('mouse', { action: 'move', x: event.x || 0, y: event.y || 0, duration_ms: 0 }, event)
    }
    else if (event.type === 'scroll') add('mouse', { action: 'wheel', x: event.x || 0, y: event.y || 0, dx: event.dx || 0, dy: event.dy || 0 }, event)
    else throw new Error(`不支持的录制事件：${event.type || '空类型'}`)
  }
  for (const down of held.values()) {
    pair(down, { t: duration, index: events.length + 1 })
    warnings.add('录制结束时仍按住的键将在片段结束时松开')
  }
  nodes.sort((a, b) => a.params.timeline.start_ms - b.params.timeline.start_ms || a.params.timeline.start_order - b.params.timeline.start_order)
  return { nodes, duration, warnings: [...warnings] }
}
