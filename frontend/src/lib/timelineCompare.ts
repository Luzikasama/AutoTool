import {sourceKey,timelineKeys,traceRounds,type InputTraceEvent,type InputTraceSnapshot,type TimelineSection,type TimelineSpan} from './inputTimeline'
export interface RunFeedback {state:'running'|'good'|'bad'|'unknown';reasons:string[];start:number;end:number}
const keyOf=(e:InputTraceEvent)=>sourceKey({scriptId:e.script_id || '',groupPath:e.group_path || [],nodeId:e.node_id || ''})
const timeOf=(e:InputTraceEvent)=>e.active_ms ?? e.time_ms

/** 使用有效时间、每次调用独立比较。预算提前完成及未选择路径不判为偏差。 */
export function compareTimeline(expected:TimelineSection[],snapshot:InputTraceSnapshot,tolerance=50,requestedRound=0) {
  const availableRounds=traceRounds(snapshot)
  const result=new Map<string,RunFeedback>(),round=requestedRound || availableRounds[availableRounds.length-1] || 1
  const start=snapshot.events.find(e=>e.kind==='round_start'&&e.round===round)
  const finish=snapshot.events.find(e=>e.kind==='round_end'&&e.round===round)
  const from=start?timeOf(start):0,until=finish?timeOf(finish):snapshot.active_elapsed_ms ?? snapshot.elapsed_ms
  const events=snapshot.events.filter(e=>(!e.round||e.round===round)&&timeOf(e)>=from&&timeOf(e)<=until)
  const starts=events.filter(e=>e.kind==='node_start'&&e.call_id),ends=new Map(events.filter(e=>e.kind==='node_end').map(e=>[e.call_id,e]))
  const byCall=new Map<string,InputTraceEvent[]>(),failedCalls=new Set<string>(),failedKeys=new Set<string>()
  for(const e of events){if(e.call_id){const list=byCall.get(e.call_id)||[];list.push(e);byCall.set(e.call_id,list)}if(e.kind==='node_error'){if(e.call_id)failedCalls.add(e.call_id);else failedKeys.add(keyOf(e))}}
  const lookup=new Map<string,{span:TimelineSpan;section:string}>()
  const literalKeys=new Map<string,Set<string>>()
  for(const section of expected)for(const span of section.spans){const key=sourceKey(span.source);lookup.set(key,{span,section:section.id});if(span.device==='key'&&!span.key.includes('{{')){const keys=literalKeys.get(key)||new Set<string>();timelineKeys(span.key).forEach(k=>keys.add(k));literalKeys.set(key,keys)}}
  const samples:{first:InputTraceEvent;key:string;start:number;end:number;expected?:{span:TimelineSpan;section:string}}[]=[]
  const fail=(key:string,reason:string)=>{const r=result.get(key);if(r){r.state='bad';if(!r.reasons.includes(reason))r.reasons.push(reason)}}
  for(const first of starts){
    const key=keyOf(first),last=ends.get(first.call_id),actualStart=timeOf(first)-from,actualEnd=(last?timeOf(last):until)-from
    const previous=result.get(key),r:RunFeedback={state:last?'good':'running',reasons:[],start:actualStart,end:actualEnd}
    if(previous?.state==='bad'){r.state='bad';r.reasons=[...previous.reasons]}
    result.set(key,r)
    if(!last&&!snapshot.running)fail(key,'动作未完成')
    if(last&&last.status&&last.status!=='finished')fail(key,'动作被停止或取消')
    if(failedCalls.has(first.call_id!)||failedKeys.has(key))fail(key,'执行失败')
    const known=lookup.get(key),p=known?.span
    if(first.expected_delay_ms!=null&&p?.source.configuredDelayMs!=null&&Math.abs(first.expected_delay_ms-p.source.configuredDelayMs)>tolerance)fail(key,'延迟参数与编辑预期不同')
    if(first.configured_start_ms!=null&&p?.source.configuredStartMs!=null&&Math.abs(first.configured_start_ms-p.source.configuredStartMs)>tolerance)fail(key,'起点参数与编辑预期不同')
    if(first.expected_duration_ms!=null&&p?.source.configuredDurationMs!=null&&Math.abs(first.expected_duration_ms-p.source.configuredDurationMs)>tolerance)fail(key,'时长参数与编辑预期不同')
    const plannedKeys=literalKeys.get(key)
    if(first.expected_key&&first.device==='key'&&plannedKeys&&timelineKeys(first.expected_key).some(k=>!plannedKeys.has(k)))fail(key,'按键参数与编辑预期不同')
    const expectedStart=first.expected_start_ms
    if(expectedStart!=null&&Math.abs(timeOf(first)-expectedStart)>tolerance)fail(key,'开始时间超出容差')
    else if(expectedStart==null&&p&&!p.estimated&&Math.abs(actualStart-p.start)>tolerance)fail(key,'开始时间超出容差')
    const duration=first.expected_duration_ms
    if(last&&duration!=null&&(first.timing_kind==='budget'?duration>0&&actualEnd-actualStart>duration+tolerance:Math.abs(actualEnd-actualStart-duration)>tolerance))fail(key,first.timing_kind==='budget'?'超过超时预算':'持续时间超出容差')
    else if(last&&duration==null&&first.timing_kind==null&&p&&!p.estimated&&!p.open&&p.kind==='hold'&&Math.abs((actualEnd-actualStart)-(p.end-p.start))>tolerance)fail(key,'持续时间超出容差')
    if(first.device==='key'){
      const declared=first.expected_key || (p&&!p.key.includes('{{')?p.key:'')
      const allowed=new Set(timelineKeys(declared))
      if(allowed.size){
        if(!first.expected_key&&timelineKeys(first.key).some(k=>!allowed.has(k)))fail(key,'按键与预期不同')
        for(const ev of byCall.get(first.call_id!) || [])if(ev.device==='key'&&['down','up'].includes(ev.kind)&&timelineKeys(ev.key).some(k=>!allowed.has(k)))fail(key,'实际按键与预期不同')
      }
    }
    if(first.device==='mouse'){
      const button=first.expected_key || p?.key
      if(button)for(const ev of byCall.get(first.call_id!) || [])if(ev.device==='mouse'&&['down','up'].includes(ev.kind)&&ev.key!==button)fail(key,'鼠标按键与预期不同')
    }
    if(last&&first.expected_clicks!=null){const actual=(byCall.get(first.call_id!) || []).filter(e=>e.kind==='down'&&e.device==='mouse').length;if(actual!==first.expected_clicks)fail(key,'点击次数与预期不同')}
    if(last&&first.expected_chars!=null){const actual=(byCall.get(first.call_id!) || []).filter(e=>e.kind==='text').reduce((sum,e)=>sum+(e.chars || 0),0);if(actual!==first.expected_chars)fail(key,'输入字符数与预期不同')}
    if(last&&p?.source.configuredWheel){const wheel=(byCall.get(first.call_id!) || []).filter(e=>e.kind==='scroll');const dx=wheel.reduce((sum,e)=>sum+(e.dx || 0),0),dy=wheel.reduce((sum,e)=>sum+(e.dy || 0),0);if(dx!==p.source.configuredWheel.dx||dy!==p.source.configuredWheel.dy)fail(key,'滚轮方向或距离与预期不同')}
    samples.push({first,key,start:actualStart,end:actualEnd,expected:known})
  }
  // 有动态条件或重复调用时，使用运行期解析基准，不用静态示意猜测先后。
  const count=new Map<string,number>();samples.forEach(s=>count.set(s.key,(count.get(s.key)||0)+1))
  const comparable=samples.filter(s=>s.expected&&!s.expected.span.estimated&&!['down','up'].includes(s.first.action || '')&&count.get(s.key)===1&&ends.has(s.first.call_id))
  const check=(a:typeof samples[number],b:typeof samples[number])=>{
    const x=a.expected!,y=b.expected!
    if(x.section!==y.section)return
    if(x.span.lane===y.span.lane&&x.span.end<=y.span.start&&x.span.start<y.span.start&&a.end>b.start+tolerance){fail(a.key,'执行顺序与预期不同');fail(b.key,'执行顺序与预期不同')}
    if(x.span.lane!==y.span.lane&&Math.min(x.span.end,y.span.end)-Math.max(x.span.start,y.span.start)>tolerance&&Math.min(a.end,b.end)-Math.max(a.start,b.start)<=0){fail(a.key,'并发关系与预期不同');fail(b.key,'并发关系与预期不同')}
  }
  const previous=new Map<string,typeof samples[number]>(),active=new Map<string,typeof samples[number]>()
  for(const b of [...comparable].sort((a,b)=>a.expected!.span.start-b.expected!.span.start)){
    const y=b.expected!,lane=JSON.stringify([y.section,y.span.lane]),prior=previous.get(lane)
    if(prior)check(prior,b)
    previous.set(lane,b)
    for(const [key,a] of active){if(a.expected!.span.end<=y.span.start){active.delete(key);continue}if(key!==lane)check(a,b)}
    const old=active.get(lane);if(!old||old.expected!.span.end<y.span.end)active.set(lane,b)
  }
  for(const e of events.filter(e=>e.kind==='node_error')){const key=keyOf(e);if(!result.has(key))result.set(key,{state:'bad',reasons:['执行失败'],start:timeOf(e)-from,end:timeOf(e)-from})}
  if(snapshot.dropped)for(const r of result.values())if(r.state==='good'){r.state='unknown';r.reasons=['运行记录不完整']}
  return result
}
