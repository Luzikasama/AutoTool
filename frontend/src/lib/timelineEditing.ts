import {kind,params,regionBranches,removeCanvasNodes} from './flatFlow'
import {timedAction} from './timedSegment'
import type {TimelineSpan} from './inputTimeline'

const controls=new Set(['parallel','scope','join','judge','loop','terminate'])
const edge=(source:string,target:string,sourceHandle:string|null=null)=>({id:`${source}-${sourceHandle || 'next'}-${target}`,source,target,sourceHandle})

/** 只重排已有动作；控制节点与跨条件边界继续由流程图管理。 */
export function reorderTimeline(nodes:any[],edges:any[],id:string,start:number,spans:TimelineSpan[],target?:{forkId:string;branchId:string}) {
  const moved=nodes.find(n=>n.id===id)
  if(!moved||controls.has(kind(moved)))throw new Error('条件、循环和分叉请在流程图中调整')
  if(spans.some(s=>s.source.nodeId===id&&s.endSource&&s.endSource.nodeId!==id))throw new Error('该次持续按住由多个节点共同组成，请在流程图中调整按下与松开边界')
  const incoming=edges.filter(e=>e.target===id),outgoing=edges.filter(e=>e.source===id)
  if(incoming.length>1||outgoing.length>1)throw new Error('该节点连接了多个逻辑路径，请在流程图中调整')
  const regions=nodes.filter(n=>['parallel','scope'].includes(kind(n))).flatMap(f=>regionBranches(nodes,edges,f).map((b:any)=>({fork:f,branch:b}))).filter(v=>v.branch.ids.has(id)).sort((a,b)=>a.branch.ids.size-b.branch.ids.size)
  const original=regions[0]
  const fork=target?nodes.find(n=>n.id===target.forkId):original?.fork
  const branchId=target?.branchId || original?.branch.id
  if(target&&original&&original.fork.id!==target.forkId)throw new Error('跨并行区域的逻辑连接请在流程图中调整')
  const detached=removeCanvasNodes(nodes,edges,new Set([id])).edges
  let branch:any,chain:any[]=[]
  if(fork){
    branch=regionBranches(nodes,detached,fork).find((b:any)=>b.id===branchId)
    if(!branch)throw new Error('执行轴不存在')
    const pending=new Set(branch.ids);let current=branch.entry
    while(current&&current!==params(fork).join_id){const n=nodes.find(n=>n.id===current);if(!n||controls.has(kind(n)))throw new Error('请在流程图中调整包含条件或嵌套区域的顺序');chain.push(n);pending.delete(current);const outs=detached.filter(e=>e.source===current);if(outs.length>1)throw new Error('请在流程图中调整逻辑分支');current=outs[0]?.target;if(chain.length>nodes.length)throw new Error('循环路径请在流程图中调整')}
    if(pending.size)throw new Error('请先在流程图中连接完整的执行轴')
  }else{
    // 只取当前位置两侧连续的单链，保留条件/循环/区域边界。
    let current=incoming[0]?.source;const before:any[]=[],seen=new Set([id])
    while(current&&!seen.has(current)){const n=nodes.find(n=>n.id===current);if(!n||controls.has(kind(n))||edges.filter(e=>e.source===current).length!==1)break;seen.add(current);before.unshift(n);current=edges.find(e=>e.target===current)?.source}
    current=outgoing[0]?.target;const after:any[]=[]
    while(current&&!seen.has(current)){const n=nodes.find(n=>n.id===current);if(!n||controls.has(kind(n))||edges.filter(e=>e.target===current).length!==1)break;seen.add(current);after.push(n);current=edges.find(e=>e.source===current)?.target}
    chain=[...before,...after]
  }
  const spanOf=(n:any)=>spans.find(s=>s.source.nodeId===n.id)
  const at=chain.findIndex(n=>(spanOf(n)?.start ?? Number(params(n).timeline?.start_ms || 0))>=start)
  const index=at<0?chain.length:at
  const previous=chain[index-1],next=chain[index]
  let link:any
  if(next)link=detached.find(e=>e.target===next.id&&(!previous||e.source===previous.id))
  else if(previous)link=detached.find(e=>e.source===previous.id)
  else if(fork)link=detached.find(e=>e.source===fork.id&&(e.sourceHandle || 'main')===branchId)
  else link=detached.find(e=>e.source===incoming[0]?.source&&e.target===outgoing[0]?.target)
  const nextEdges=detached.filter(e=>e!==link)
  if(link){nextEdges.push({...link,target:id});if(link.target)nextEdges.push(edge(id,link.target))}
  else {if(previous)nextEdges.push(edge(previous.id,id));if(next)nextEdges.push(edge(id,next.id))}
  const ordered=[...chain.slice(0,index),moved,...chain.slice(index)]
  if(fork&&params(fork).timing==='absolute'){
    const origin=(spanOf(moved)?.start || 0)-timedAction(moved).start
    let end=0
    for(const n of ordered){const p=params(n),desired=n.id===id?Math.max(0,start-origin):Number(p.timeline?.start_ms || 0);const actual=Math.max(end,desired);p.timeline={...p.timeline,start_ms:actual,track_id:branchId};delete p.timeline.start_order;delete p.timeline.end_order;end=actual+timedAction(n).duration}
  }else{
    const originNode=chain[0] || moved
    const baseline=previous?spanOf(previous)?.end || 0:Math.max(0,(spanOf(originNode)?.start || 0)-Number(params(originNode).timeline?.delay_ms || 0))
    const p=params(moved);p.timeline={...p.timeline,delay_ms:Math.max(0,start-baseline)};delete p.timeline.start_ms;delete p.timeline.track_id;delete p.timeline.start_order;delete p.timeline.end_order
  }
  // 根入口没有连线，数组顺序决定独立入口的优先级。
  if(!fork&&ordered.length){const ids=new Set(ordered.map(n=>n.id));const first=Math.min(...nodes.map((n,i)=>ids.has(n.id)?i:Infinity));const rest=nodes.filter(n=>!ids.has(n.id));rest.splice(first,0,...ordered);return {nodes:rest,edges:nextEdges}}
  return {nodes,edges:nextEdges}
}

export function settleAbsoluteAxis(nodes:any[],edges:any[],fork:any,id:string){
  const b=regionBranches(nodes,edges,fork).find((b:any)=>b.ids.has(id));if(!b)return
  let end=0,current=b.entry;const seen=new Set<string>()
  while(current&&current!==params(fork).join_id&&!seen.has(current)){seen.add(current);const n=nodes.find(n=>n.id===current);if(!n)break;const p=params(n),a=timedAction(n);if(a.start<end){p.timeline={...p.timeline,start_ms:end};delete p.timeline.start_order;delete p.timeline.end_order}end=Math.max(a.start,end)+a.duration;current=edges.find(e=>e.source===current)?.target}
}
