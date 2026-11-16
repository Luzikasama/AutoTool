import type {TimelineSpan} from './inputTimeline'

type Interval = {start:number;end:number}
const merge=(items:Interval[])=>{
  const result:Interval[]=[]
  for(const item of items.sort((a,b)=>a.start-b.start)){
    const last=result[result.length-1]
    if(last&&item.start<=last.end)last.end=Math.max(last.end,item.end)
    else result.push({...item})
  }
  return result
}

/** 仅移除预算独占的区间；其他轴的动作、普通延时和瞬时事件均保留。 */
export function budgetPreviewSkips(spans:TimelineSpan[],duration:number):Interval[]{
  const budget=(s:TimelineSpan)=>s.note?.includes('超时预算')
  const bounds=(s:TimelineSpan)=>({start:Math.max(0,s.start),end:Math.min(duration,Math.max(s.end,s.start+1))})
  const occupied=merge(spans.filter(s=>!budget(s)).map(bounds).filter(s=>s.end>s.start))
  const result:Interval[]=[]
  for(const hidden of merge(spans.filter(budget).map(bounds).filter(s=>s.end>s.start))){
    let cursor=hidden.start
    for(const action of occupied){
      if(action.end<=cursor)continue
      if(action.start>=hidden.end)break
      if(action.start>cursor)result.push({start:cursor,end:action.start})
      cursor=Math.max(cursor,action.end)
      if(cursor>=hidden.end)break
    }
    if(cursor<hidden.end)result.push({start:cursor,end:hidden.end})
  }
  return result
}

/** 时间刻度保持工程时间；播放只消耗可见区间的时间，预算空档直接跳过。 */
export function advancePreview(cursor:number,elapsed:number,duration:number,skips:Interval[]):number{
  let position=Math.max(0,Math.min(duration,cursor)),remaining=Math.max(0,elapsed)
  for(const skip of skips){
    if(skip.end<=position)continue
    const visible=Math.max(0,skip.start-position)
    if(remaining<visible)return Math.min(duration,position+remaining)
    remaining-=visible
    position=Math.max(position,skip.end)
  }
  return Math.min(duration,position+remaining)
}
