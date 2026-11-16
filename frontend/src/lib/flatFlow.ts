/** 同一张平面图负责连接、并发与时间；容器编译结果仅用于预览/执行。 */
import {timedAction} from './timedSegment'
import {timedTracks} from './unifiedTiming'
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
export const kind=(n:any)=>n?.data?.nodeType || n?.type
export const params=(n:any)=>n?.data?.params || n?.params || {}
export const node=(id:string,type:string,p:any={},position={x:80,y:80})=>({id,type:'step',position,data:{nodeType:type,label:({parallel:'并行分支',join:'汇合',scope:'作用域'} as any)[type] || type,params:p,once:false}})
export function regionBranches(nodes:any[],edges:any[],fork:any) {
  const p=params(fork), jid=p.join_id
  const branches=kind(fork)==='scope'?[{id:'main',name:p.name || '作用域'}]:p.branches || []
  return branches.map((b:any)=>{
    const entry=edges.find(e=>e.source===fork.id && (e.sourceHandle || 'main')===b.id)?.target || jid
    const ids=new Set<string>(),pending=[entry]
    while(pending.length) {const id=pending.pop();if(!id || id===jid || ids.has(id))continue;ids.add(id);if(ids.size>12000)throw new Error('分支过大');pending.push(...edges.filter(e=>e.source===id).map(e=>e.target))}
    return {...b,entry,ids,nodes:nodes.filter(n=>ids.has(n.id)),edges:edges.filter(e=>ids.has(e.source)&&ids.has(e.target))}
  })
}
export function createParallel(id:string,joinId:string,position:{x:number;y:number}) {
  return {nodes:[node(id,'parallel',{join_id:joinId,branches:[{id:'main',name:'主轴',start_ms:0},{id:'side1',name:'副轴 1',start_ms:0}],primary_track:'main',repeat:1,duration_ms:0},position),node(joinId,'join',{fork_id:id},{x:position.x+540,y:position.y})],edges:[{id:`${id}-main`,source:id,target:joinId,sourceHandle:'main'},{id:`${id}-side1`,source:id,target:joinId,sourceHandle:'side1'}]}
}
/** 删除动作后接回唯一后继；删除分叉时同时删除整个配对区域。 */
export function removeCanvasNodes(nodes:any[],edges:any[],ids:Set<string>) {
  for(const n of nodes) if(ids.has(n.id)&&['parallel','scope','join'].includes(kind(n))) {
    const fork=kind(n)==='join'?nodes.find(f=>params(f).join_id===n.id):n
    if(fork){ids.add(fork.id);ids.add(params(fork).join_id);regionBranches(nodes,edges,fork).forEach((b:any)=>b.ids.forEach((id:string)=>ids.add(id)))}
  }
  const kept=edges.filter(e=>!ids.has(e.source)&&!ids.has(e.target))
  for(const entry of edges.filter(e=>!ids.has(e.source)&&ids.has(e.target))) {
    let id=entry.target;const seen=new Set<string>()
    while(ids.has(id)&&!seen.has(id)) {seen.add(id);const outgoing=edges.filter(e=>e.source===id);if(outgoing.length!==1){id='';break}id=outgoing[0].target}
    if(id&&!ids.has(id))kept.push({...entry,id:entry.id+'-splice',target:id})
  }
  // 删除整段并行区域时绕过分叉与汇合。
  for(const fork of nodes.filter(n=>ids.has(n.id)&&['parallel','scope'].includes(kind(n)))) {
    const incoming=edges.filter(e=>e.target===fork.id&&!ids.has(e.source)),outgoing=edges.filter(e=>e.source===params(fork).join_id&&!ids.has(e.target))
    if(outgoing.length===1)for(const e of incoming)kept.push({...e,id:e.id+'-region',target:outgoing[0].target})
  }
  return {nodes:nodes.filter(n=>!ids.has(n.id)),edges:kept}
}
export function assignBranch(nodes:any[],edges:any[],fork:any,id:string,branchId:string) {
  const p=params(fork),n=nodes.find(n=>n.id===id)
  if(!n || !(p.branches || []).some((b:any)=>b.id===branchId))throw new Error('执行轴不存在')
  if(['parallel','scope','join','judge','loop','terminate'].includes(kind(n)))throw new Error('请通过流程连线移动逻辑区域')
  const detached=removeCanvasNodes(nodes,edges,new Set([id])).edges
  const current=regionBranches(nodes,detached,fork).find((b:any)=>b.id===branchId)
  if(!current)throw new Error('执行轴不存在')
  const ordered=[...current.nodes,n].sort((a,b)=>Number(params(a).timeline?.start_ms || 0)-Number(params(b).timeline?.start_ms || 0))
  if(p.timing==='absolute') {
    const ids=new Set(ordered.map(v=>v.id))
    const kept=detached.filter(e=>!(e.source===fork.id&&(e.sourceHandle || 'main')===branchId)&&!ids.has(e.source))
    kept.push({id:`${fork.id}-${branchId}`,source:fork.id,target:ordered[0]?.id || p.join_id,sourceHandle:branchId})
    for(let i=0;i<ordered.length;i++)kept.push({id:`${ordered[i].id}-next`,source:ordered[i].id,target:ordered[i+1]?.id || p.join_id})
    return kept
  }
  const tail=detached.find(e=>e.target===p.join_id&&(current.ids.has(e.source)||(e.source===fork.id&&(e.sourceHandle || 'main')===branchId)))
  if(!tail)throw new Error('请先将执行轴连接到汇合点')
  return [...detached.filter(e=>e!==tail),{...tail,target:id},{id:`${id}-${p.join_id}`,source:id,target:p.join_id}]
}
/** 折叠仅改变画布投影，原节点、连线及作用域保持原样。 */
export function foldedGraph(nodes:any[],edges:any[]) {
  const owner=new Map<string,string>()
  for(const n of nodes)for(const id of n.data?.foldMembers || [])if(id!==n.id)owner.set(id,n.id)
  const visible=nodes.filter(n=>!owner.has(n.id)).map(n=>n.data?.foldMembers?.length?{...n,data:{...n.data,foldCount:n.data.foldMembers.length+1}}:n)
  const links=edges.flatMap(e=>{const source=owner.get(e.source)||e.source,target=owner.get(e.target)||e.target;if(source===target)return [];return [{...e,source,target,...(source!==e.source?{sourceHandle:null}:{}),_folded:source!==e.source||target!==e.target}]})
  return {nodes:visible,edges:links,owner}
}
function entryOf(ns:any[],es:any[]) {return ns.find(n=>!es.some(e=>e.target===n.id))?.id || ns.find(n=>kind(n)==='loop')?.id || ns[0]?.id}
function attach(ns:any[],es:any[],from:string,to:string,handle:string) {
  const entry=entryOf(ns,es)
  es.push({id:`${from}-${handle}-${entry || to}`,source:from,target:entry || to,sourceHandle:handle})
  for(const n of ns) if(!es.some(e=>e.source===n.id) && kind(n)!=='terminate') es.push({id:`${n.id}-${to}`,source:n.id,target:to,sourceHandle:null})
}
/** 载入时将内嵌组展开到原画布，作用域由一对边界节点保持。 */
export function flattenGraph(input:any[],links:any[]) {
  let nodes=copy(input || []),edges=copy(links || [])
  let seq=0
  while(nodes.some(n=>kind(n)==='group')) {
    if(++seq>6000) throw new Error('流程展开超出上限')
    const g=nodes.find(n=>kind(n)==='group'),p=params(g), pos=g.position || {x:80,y:80}
    let jid=g.id+'__join';while(nodes.some(n=>n.id===jid))jid+='x'
    const prefixed=(ns:any[],es:any[],prefix:string)=>{
      const ids=new Map(ns.map(n=>[n.id,prefix+n.id]))
      return {nodes:ns.map(n=>({...copy(n),id:ids.get(n.id),position:{x:pos.x+220+(n.position?.x || 0),y:pos.y+(n.position?.y || 0)},data:{...copy(n.data),params:{...copy(params(n)),...(params(n).join_id?{join_id:ids.get(params(n).join_id)}:{}),...(params(n).fork_id?{fork_id:ids.get(params(n).fork_id)}:{})}}})),edges:es.map(e=>({...e,id:prefix+e.id,source:ids.get(e.source),target:ids.get(e.target)}))}
    }
    let ns:any[]=[], es:any[]=[], branches:any[]=[]
    const absolute=p.execution==='timeline',parallel=p.execution==='parallel'
    if(parallel) {
      for(const [index,t] of (p.nodes || []).entries()) {
        const tp=params(t),bid=String(t.id || `side${index}`)
        branches.push({id:bid,name:tp.name || (index?'副轴 '+index:'主轴'),start_ms:tp.timeline?.start_ms || 0,variables:tp.execution==='timeline'?[]:tp.variables || []})
        const body=tp.execution==='timeline'?{nodes:[t],edges:[]}: {nodes:tp.nodes || [],edges:tp.edges || []}
        const branch=prefixed(body.nodes,body.edges,g.id+'__'+bid+'__')
        attach(branch.nodes,branch.edges,g.id,jid,bid);ns.push(...branch.nodes);es.push(...branch.edges)
      }
    } else if(absolute) {
      const raw=prefixed(p.nodes || [],[],g.id+'__'), ends:number[]=[]
      for(const n of [...raw.nodes].sort((a,b)=>Number(params(a).timeline?.start_ms || 0)-Number(params(b).timeline?.start_ms || 0))) {
        const a=timedAction(n);let index=ends.findIndex(end=>end<=a.start);if(index<0)index=ends.length
        const bid=params(n).timeline?.track_id || (index===0?'main':'side'+index)
        ends[index]=a.start+a.duration
        params(n).timeline={...params(n).timeline,track_id:bid}
        if(!branches.some(b=>b.id===bid))branches.push({id:bid,name:(p.tracks || []).find((t:any)=>t.id===bid)?.name || (branches.length?'副轴 '+branches.length:'主轴'),start_ms:0})
      }
      if(!branches.length)branches=[{id:'main',name:'主轴'}]
      for(const b of branches) {const bn=raw.nodes.filter(n=>params(n).timeline?.track_id===b.id).sort((a,b)=>Number(params(a).timeline.start_ms)-Number(params(b).timeline.start_ms));const be=bn.slice(1).map((n,i)=>({id:`${bn[i].id}-${n.id}`,source:bn[i].id,target:n.id}));attach(bn,be,g.id,jid,b.id);es.push(...be)}
      ns=raw.nodes
    } else {
      const body=prefixed(p.nodes || [],p.edges || [],g.id+'__');ns=body.nodes;es=body.edges;attach(ns,es,g.id,jid,'main')
    }
    if(parallel && !branches.length) branches=[{id:'main',name:'主轴'}]
    const gp:any={name:p.name || g.data?.label,join_id:jid,variables:p.variables || [],repeat:p.repeat || 1,duration_ms:p.duration_ms || 0,...(parallel||absolute?{branches,primary_track:p.primary_track || branches[0]?.id,...(absolute?{timing:'absolute'}:{})}:{})}
    const start={...g,data:{...g.data,nodeType:parallel||absolute?'parallel':'scope',label:parallel||absolute?'并行分支':'作用域',params:gp}}
    edges=edges.map(e=>e.source===g.id?{...e,source:jid}:e)
    nodes=nodes.filter(n=>n.id!==g.id);nodes.push(start,...ns,node(jid,'join',{fork_id:g.id},{x:Math.max(pos.x+540,...ns.map(n=>(n.position?.x || pos.x)+230)),y:pos.y}));edges.push(...es)
  }
  normalizeRecordingTiming(nodes,edges)
  for(const n of nodes)delete params(n).input_mode
  return {nodes,edges}
}

/** 旧绝对录制时间转换为路径间隔；保留节点、连线、作用域及同刻顺序。 */
export function normalizeRecordingTiming(nodes:any[],edges:any[]){
  for(const fork of nodes.filter(n=>kind(n)==='parallel'&&params(n).timing==='absolute')){
    // 旧时间表的连线曾只代表轴归属。同轴重叠或动态时间无法无损线性化，
    // 必须先完整检查，再决定是否转换，避免把原有并发悄悄改成串行。
    let safe=true
    for(const branch of regionBranches(nodes,edges,fork)){
      let current=branch.entry,end=Number(branch.start_ms || 0)
      const seen=new Set<string>()
      if(!Number.isFinite(end))safe=false
      while(current&&current!==params(fork).join_id&&!seen.has(current)){
        seen.add(current)
        const n=nodes.find(n=>n.id===current),links=edges.filter(e=>e.source===current)
        try{const a=timedAction(n);if(a.start<end)safe=false;end=a.start+a.duration}catch{safe=false}
        if(links.length!==1)safe=false
        current=links[0]?.target
      }
      if(current!==params(fork).join_id||seen.size!==branch.ids.size)safe=false
    }
    if(!safe)continue
    for(const branch of regionBranches(nodes,edges,fork)){
      let current=branch.entry,end=Number(branch.start_ms || 0)
      const seen=new Set<string>()
      while(current&&current!==params(fork).join_id&&!seen.has(current)){
        seen.add(current)
        const n=nodes.find(n=>n.id===current)
        if(!n)break
        if(['keyboard','mouse'].includes(kind(n))){
          const p=params(n),a=timedAction(n)
          p.timeline={delay_ms:Math.max(0,a.start-end),...(p.timeline?.start_order!=null?{start_order:p.timeline.start_order}:{}),...(p.timeline?.end_order!=null?{end_order:p.timeline.end_order}:{})}
          end=a.start+a.duration
        }
        current=edges.find(e=>e.source===current)?.target
      }
    }
    params(fork).timing='unified'
  }
}
/** 与 Python 编译器保持同一结构契约；临时图保留画布来源。 */
export function lowerFlatGraph(input:any[],links:any[],depth=0):{nodes:any[];edges:any[]} {
  if(depth>16)throw new Error('并发嵌套超过上限')
  const nodes=input.map(n=>({id:n.id,type:kind(n),label:n.data?.label || n.label,params:copy(params(n)),once:!!(n.data?.once ?? n.once)})),edges=copy(links)
  const controls=nodes.filter(n=>['parallel','scope'].includes(n.type))
  if(!controls.length)return {nodes,edges}
  const used=new Set<string>(), replacements=new Map<string,any>(),joins=new Map<string,string>()
  controls.sort((a,b)=>regionBranches(nodes,edges,b).reduce((s:number,t:any)=>s+t.ids.size,0)-regionBranches(nodes,edges,a).reduce((s:number,t:any)=>s+t.ids.size,0))
  for(const f of controls) {
    if(used.has(f.id))continue
    const p=f.params,bs=regionBranches(nodes,edges,f),members=new Set<string>()
    if(!nodes.some(n=>n.id===p.join_id&&n.type==='join'))throw new Error('请连接配对汇合节点')
    const tracks=bs.map((b:any)=>{
      if([...b.ids].some(id=>members.has(id)) || b.ids.has(f.id))throw new Error('并行路径应在汇合点连接')
      b.ids.forEach((id:string)=>members.add(id))
      const body=lowerFlatGraph([...b.nodes].sort((a,bn)=>Number(bn.id===b.entry)-Number(a.id===b.entry)),b.edges,depth+1)
      return {id:b.id,type:'group',params:{name:b.name || b.id,execution:'flow',variables:b.variables || [],_synthetic:true,...body,timeline:{start_ms:b.start_ms || 0}}}
    })
    let body:any= {execution:'parallel',nodes:tracks,edges:[]}
    if(p.timing==='unified'){
      tracks.forEach((t:any)=>Object.assign(t.params,{_unified_timing:true}))
      const timed=timedTracks(tracks)
      if(timed?.length)body={execution:'timeline',nodes:timed,edges:[],tracks:bs.map((b:any)=>({id:b.id,name:b.name})),_unified_axes:true}
    }
    if(f.type==='scope')body={execution:'flow',nodes:tracks[0]?.params.nodes || [],edges:tracks[0]?.params.edges || []}
    if(p.timing==='absolute'){const timed=nodes.filter(n=>members.has(n.id));for(const n of timed)n.params.timeline={...n.params.timeline,track_id:bs.find((b:any)=>b.ids.has(n.id))?.id};body={execution:'timeline',nodes:timed,edges:[],tracks:bs.map((b:any)=>({id:b.id,name:b.name}))}}
    replacements.set(f.id,{...f,type:'group',params:{...p,...body}});members.forEach(id=>used.add(id));used.add(p.join_id);joins.set(p.join_id,f.id)
  }
  const mark=(n:any):any=>({...n,params:{...n.params,...(!n.params._synthetic?{_canvas_path:[]}:{}),...(n.type==='group'?{nodes:(n.params.nodes || []).map(mark)}:{})}})
  return {nodes:nodes.filter(n=>!used.has(n.id)).map(n=>mark(replacements.get(n.id)||n)),edges:edges.flatMap(e=>joins.has(e.source)?[{...e,source:joins.get(e.source)}]:used.has(e.source)||used.has(e.target)||replacements.has(e.source)?[]:[e])}
}
