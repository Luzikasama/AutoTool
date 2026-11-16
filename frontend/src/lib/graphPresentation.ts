/** 画布收纳与录制布局只改变显示数据，执行图保持平面结构。 */
import {kind,params,regionBranches} from './flatFlow'

export function mergeCard(nodes:any[],edges:any[],selection:string[]) {
  const ids=new Set(selection)
  for(const id of [...ids]) {
    const n=nodes.find(n=>n.id===id);if(!n)continue
    for(const member of n.data?.foldMembers || [])ids.add(member)
    const fork=kind(n)==='join'?nodes.find(f=>params(f).join_id===id):n
    if(fork&&['parallel','scope'].includes(kind(fork))){ids.add(fork.id);ids.add(params(fork).join_id);regionBranches(nodes,edges,fork).forEach((b:any)=>b.ids.forEach((id:string)=>ids.add(id)))}
  }
  const selected=nodes.filter(n=>ids.has(n.id))
  if(selected.length<2)throw new Error('请选择两个以上节点，或选择一个完整并行区域')
  const entries=new Set(edges.filter(e=>!ids.has(e.source)&&ids.has(e.target)).map(e=>e.target))
  const exits=edges.filter(e=>ids.has(e.source)&&!ids.has(e.target))
  if(entries.size>1||exits.length>1)throw new Error('请合并入口与后续连接完整的区域，保留外部逻辑分支')
  const head=selected.find(n=>entries.has(n.id)) || selected.find(n=>!edges.some(e=>e.target===n.id&&ids.has(e.source))) || selected.find(n=>kind(n)==='loop')
  if(!head)throw new Error('请选择包含明确入口的完整区域')
  const seen=new Set<string>(),pending=[head.id]
  while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);pending.push(...edges.filter(e=>e.source===id&&ids.has(e.target)).map(e=>e.target))}
  if(selected.some(n=>!seen.has(n.id)&&!(kind(n)==='join'&&ids.has(params(n).fork_id))))throw new Error('请先连接选中的节点，再合并为卡片')
  for(const n of selected)delete n.data.foldMembers
  head.data.foldMembers=selected.filter(n=>n!==head).map(n=>n.id)
  head.data.foldLabel ||= params(head).name || '合并卡片'
  return head.id
}

/** 卡片的外部出口对应内部尾节点，不向隐藏的分叉入口追加非法连线。 */
export function cardConnection(nodes:any[],edges:any[],connection:any){
  const head=nodes.find(n=>n.id===connection.source)
  if(!head?.data?.foldMembers?.length)return connection
  const ids=new Set([head.id,...head.data.foldMembers])
  if(ids.has(connection.target))throw new Error('不能把卡片连接回自身内部')
  const outgoing=edges.filter(e=>ids.has(e.source)&&!ids.has(e.target))
  if(outgoing.length===1)return {...connection,source:outgoing[0].source,sourceHandle:outgoing[0].sourceHandle || null}
  const tails=nodes.filter(n=>ids.has(n.id)&&kind(n)!=='terminate'&&(!edges.some(e=>e.source===n.id)||(kind(n)==='loop'&&!edges.some(e=>e.source===n.id&&e.sourceHandle==='next'))))
  if(tails.length!==1)throw new Error('请先展开卡片，明确需要连接的后续出口')
  return {...connection,source:tails[0].id,sourceHandle:kind(tails[0])==='loop'?'next':null}
}

/** 分叉位于最左，主副轴逐行排列，相同起点同列；列宽保证卡片不重叠。 */
export function layoutRecording(nodes:any[],edges:any[],forkId:string,starts:Record<string,number>) {
  const fork=nodes.find(n=>n.id===forkId);if(!fork)return
  const join=nodes.find(n=>n.id===params(fork).join_id),origin=fork.position || {x:80,y:80}
  const branches=regionBranches(nodes,edges,fork)
  const columns=[...new Set(branches.flatMap((b:any)=>b.nodes.map((n:any)=>starts[n.id] || 0)))].sort((a:any,b:any)=>a-b) as number[]
  const primary=params(fork).primary_track || branches[0]?.id
  branches.sort((a:any,b:any)=>Number(b.id===primary)-Number(a.id===primary))
  branches.forEach((b:any,row:number)=>{
    let last=-1
    for(const n of [...b.nodes].sort((a,b)=>(starts[a.id] || 0)-(starts[b.id] || 0))) {
      const column=Math.max(last+1,columns.indexOf(starts[n.id] || 0));last=column
      n.position={x:origin.x+290+column*270,y:origin.y+row*150}
      delete n.data.simplePosition
    }
  })
  if(join)join.position={x:Math.max(origin.x+580,...branches.flatMap((b:any)=>b.nodes.map((n:any)=>n.position.x+290))),y:origin.y}
  const members=new Set(branches.flatMap((b:any)=>[...b.ids]));members.add(forkId);if(join)members.add(join.id)
  if(join){const tail=edges.find(e=>e.source===join.id),next=nodes.find(n=>n.id===tail?.target);if(next&&!members.has(next.id)){const dx=Math.max(0,join.position.x+280-next.position.x);const pending=[next.id],seen=new Set<string>();while(pending.length){const id=pending.pop()!;if(members.has(id)||seen.has(id))continue;seen.add(id);const n=nodes.find(n=>n.id===id);if(n)n.position={...n.position,x:n.position.x+dx};pending.push(...edges.filter(e=>e.source===id).map(e=>e.target))}}}
}
