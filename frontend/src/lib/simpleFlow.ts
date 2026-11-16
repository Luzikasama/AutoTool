/** 简易画布是共享图的投影；虚拟卡片不参与保存与执行。 */
import { defaultsFor } from './nodeSchema'

export interface SimpleRecipe { headId: string; kind: 'image' | 'image_judge'; judgeId: string; clickId: string; stopId: string; ids: string[] }
const kindOf = (n: any) => n?.data?.nodeType || n?.type
const paramsOf = (n: any) => n?.data?.params || n?.params || {}
const metaOf = (n: any) => n?.data?.simple || n?.simple || {}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const SIMPLE_TYPES = ['mouse', 'keyboard', 'text_input', 'delay', 'find_image', 'record', 'autoclick', 'script_call', 'terminate','parallel','variable']
export const SIMPLE_FIELDS: Record<string, string[]> = {
  mouse: ['action','point_var','x','y','button','clicks','hold_ms','duration_ms','dx','dy'],
  keyboard: ['keys','action','hold_ms'], text_input: ['text'],
  delay: ['ms'], find_image: ['template','threshold','timeout_ms','scope'],
  record: ['speed','repeat'], autoclick: ['x','y','button','count','interval_ms'],
  terminate: ['level','message'], script_call: ['script_id','name'],
}

export function simpleRecipe(head: any, nodes: any[], edges: any[]): SimpleRecipe | null {
  if (kindOf(head) !== 'find_image') return null
  const hp = paramsOf(head), hint = metaOf(head)
  const outgoing = (id: string, port?: string) => edges.filter(e => e.source === id && (port === undefined || (e.sourceHandle || '') === port))
  const first = outgoing(head.id)
  if (first.length !== 1) return null
  const judge = nodes.find(n => n.id === first[0].target)
  const jp = paramsOf(judge)
  if (kindOf(judge) !== 'judge' || String(jp.condition?.left || '') !== hp.save_found || jp.condition?.op !== '==' || String(jp.condition?.right) !== 'yes' || String(jp.condition2?.left || '').trim()) return null
  const yes = outgoing(judge.id, 'yes'), no = outgoing(judge.id, 'no')
  if (yes.length > 1 || no.length > 1 || outgoing(judge.id).some(e => !['yes','no'].includes(e.sourceHandle))) return null
  let click = nodes.find(n => n.id === yes[0]?.target), stop = nodes.find(n => n.id === no[0]?.target)
  const cp = paramsOf(click), sp = paramsOf(stop)
  const isClick = kindOf(click) === 'mouse' && ['click','double_click','right_click','middle_click'].includes(cp.action || 'click') && ((hp.save_point && cp.point_var === hp.save_point) || (!cp.point_var && cp.x === `{{${hp.save_x}}}` && cp.y === `{{${hp.save_y}}}`))
  const isStop = kindOf(stop) === 'terminate' && (!sp.level || sp.level === 'workflow')
  const next = isClick ? outgoing(click.id) : yes
  const sameContinuation = (!no.length && !next.length) || (no.length === next.length && no.every((e,i) => e.target === next[i]?.target))
  let kind: SimpleRecipe['kind'] = hint.kind === 'image_judge' ? 'image_judge' : (isClick || hint.kind === 'image') && (isStop || sameContinuation) ? 'image' : 'image_judge'
  if (kind === 'image' && isClick && !!(click.data?.once ?? click.once) !== !!(head.data?.once ?? head.once)) return null
  if (kind === 'image' && next.length > 1) return null
  const ids = [head.id, judge.id]
  if (kind === 'image' && isClick) ids.push(click.id)
  if (kind === 'image' && isStop) ids.push(stop.id)
  const members = new Set(ids)
  if (edges.some(e => members.has(e.target) && e.target !== head.id && !members.has(e.source))) return null
  return { headId: head.id, kind, judgeId: judge.id, clickId: kind === 'image' && isClick ? click.id : '', stopId: kind === 'image' && isStop ? stop.id : '', ids }
}

export function simpleProjection(nodes: any[], edges: any[]) {
  const recipes = new Map<string, SimpleRecipe>(), owner = new Map<string, string>()
  for (const n of nodes) {
    const recipe = simpleRecipe(n, nodes, edges)
    if (!recipe || recipe.ids.some(id => owner.has(id))) continue
    recipes.set(n.id, recipe); recipe.ids.forEach(id => owner.set(id, n.id))
  }
  const projected = nodes.filter(n => !owner.has(n.id) || owner.get(n.id) === n.id).map(n => {
    const recipe = recipes.get(n.id)
    return { ...n, position: n.data?.simplePosition || n.position, data: { ...n.data,
      simpleView: recipe ? { kind: recipe.kind, label: recipe.kind === 'image_judge' ? '找图判断' : recipe.clickId ? '找图并点击' : '找图', count: recipe.ids.length } : null,
      simpleAdvanced: !recipe && !SIMPLE_TYPES.includes(kindOf(n)) && kindOf(n) !== 'group',
    } }
  })
  const links: any[] = [], signatures = new Map<string, any>()
  for (const e of edges) {
    const source = owner.get(e.source) || e.source, target = owner.get(e.target) || e.target
    if (source === target && e.source !== e.target) continue
    const recipe = recipes.get(source)
    const sourceHandle = recipe ? recipe.kind === 'image' ? null : e.sourceHandle : e.sourceHandle
    const key = JSON.stringify([source,target,sourceHandle || ''])
    const prior = signatures.get(key)
    if (prior) { prior.originalIds.push(e.id); continue }
    const link = { ...e, source, target, sourceHandle, originalIds: [e.id] }
    signatures.set(key, link); links.push(link)
  }
  return { nodes: projected, edges: links, recipes, owner }
}

export function createSimpleImage(id: string, position: {x:number;y:number}, kind: 'image'|'image_judge' = 'image', _inputMode = 'real') {
  const prefix = `_at_${id.replace(/[^A-Za-z0-9_]/g, '_')}`
  const make = (nid: string, type: string, params: any, column: number) => ({ id:nid,type:'step',position:{x:position.x+column*212,y:position.y},data:{nodeType:type,label:type==='find_image'?'图像识别':type==='judge'?'判断':'鼠标操作',params:{...defaultsFor(type),...params},once:false} })
  const head = make(id,'find_image',{save_found:prefix+'_found',save_point:prefix+'_point'},0)
  const judge = make(id+'-condition','judge',{condition:{left:prefix+'_found',op:'==',right:'yes'}},1)
  ;(head.data as any).simple = {kind,judgeId:judge.id}
  const nodes: any[] = [head,judge]
  const edges: any[] = [{id:`e-${id}-${judge.id}`,source:id,target:judge.id}]
  if (kind === 'image') {
    const click = make(id+'-click','mouse',{action:'click',point_var:prefix+'_point'},2)
    nodes.push(click);edges.push({id:`e-${judge.id}-${click.id}`,source:judge.id,target:click.id,sourceHandle:'yes'})
  }
  return {nodes,edges}
}

export function connectSimple(nodes: any[], edges: any[], conn: {source:string;target:string;sourceHandle?:string|null}) {
  const projection = simpleProjection(nodes,edges)
  const source = projection.recipes.get(conn.source)
  const target = projection.owner.get(conn.target) || conn.target
  if(!source)edges=edges.filter(e=>!(e.source===conn.source&&(e.sourceHandle||'')===(conn.sourceHandle||'')))
  const add = (from: string, handle: string|null) => {
    const next = {id:`e-${from}-${handle||'out'}-${target}`,source:from,target,sourceHandle:handle}
    if (edges.some(e => e.source===from && (e.sourceHandle||'')===(handle||''))) throw new Error('这个出口已经连接，请先删除原连线')
    return next
  }
  if (!source) return [...edges,add(conn.source,conn.sourceHandle||null)]
  if (source.kind === 'image_judge') return [...edges,add(source.judgeId,conn.sourceHandle||'yes')]
  const result = [...edges,add(source.clickId||source.judgeId,source.clickId?null:'yes')]
  if (!source.stopId) result.push(add(source.judgeId,'no'))
  return result
}

export function updateSimpleImage(nodes: any[], edges: any[], headId: string, change: {autoClick?:boolean;onTimeout?:string;inputMode?:string;once?:boolean;button?:string;clicks?:number}) {
  const recipe = simpleProjection(nodes,edges).recipes.get(headId)
  if (!recipe) throw new Error('流程结构已变化，请重新选择节点')
  const ns = copy(nodes), es = copy(edges), head = ns.find(n=>n.id===headId), p=paramsOf(head)
  const fresh = (suffix:string) => {let id=headId+suffix, i=2;while(ns.some(n=>n.id===id)) id=headId+suffix+'-'+i++;return id}
  if (change.once !== undefined) {
    for (const id of recipe.ids) {const n=ns.find(n=>n.id===id);if(n.data) n.data.once=change.once;else n.once=change.once}
  }
  if (recipe.kind !== 'image') return {nodes:ns,edges:es}
  if (change.inputMode !== undefined || change.button !== undefined || change.clicks !== undefined) {
    const click=ns.find(n=>n.id===recipe.clickId)
    if(click) {if(change.button!==undefined) paramsOf(click).button=change.button;if(change.clicks!==undefined) paramsOf(click).clicks=change.clicks}
  }
  if (change.autoClick !== undefined && change.autoClick !== !!recipe.clickId) {
    if (change.autoClick) {
      const clickId=fresh('-click'), click={id:clickId,type:'step',position:{x:(head.position?.x||0)+424,y:head.position?.y||0},data:{nodeType:'mouse',label:'鼠标操作',params:{...defaultsFor('mouse'),action:'click',...(p.save_point?{point_var:p.save_point}:{x:`{{${p.save_x}}}`,y:`{{${p.save_y}}}`})},once:!!head.data?.once}}
      ns.push(click)
      for(const e of es) if(e.source===recipe.judgeId&&e.sourceHandle==='yes') {e.source=clickId;e.sourceHandle=null}
      es.push({id:`e-${recipe.judgeId}-${clickId}`,source:recipe.judgeId,target:clickId,sourceHandle:'yes'})
    } else {
      for(const e of es) if(e.source===recipe.clickId){e.source=recipe.judgeId;e.sourceHandle='yes'}
      const index=es.findIndex(e=>e.target===recipe.clickId);if(index>=0) es.splice(index,1)
      ns.splice(ns.findIndex(n=>n.id===recipe.clickId),1)
    }
  }
  if (change.onTimeout !== undefined && (change.onTimeout==='exit') !== !!recipe.stopId) {
    if (change.onTimeout==='exit') {
      const id=fresh('-stop')
      ns.push({id,type:'step',position:{x:(head.position?.x||0)+424,y:(head.position?.y||0)+120},data:{nodeType:'terminate',label:'终止',params:{...defaultsFor('terminate'),level:'workflow',message:'找图超时，按设置停止'},once:false}})
      for(let i=es.length-1;i>=0;i--) if(es[i].source===recipe.judgeId&&es[i].sourceHandle==='no') es.splice(i,1)
      es.push({id:`e-${recipe.judgeId}-${id}`,source:recipe.judgeId,target:id,sourceHandle:'no'})
    } else {
      for(let i=es.length-1;i>=0;i--) if(es[i].target===recipe.stopId) es.splice(i,1)
      ns.splice(ns.findIndex(n=>n.id===recipe.stopId),1)
      const current=simpleRecipe(head,ns,es)
      const outgoing=es.filter(e=>e.source===(current?.clickId||recipe.clickId||recipe.judgeId)&&(e.sourceHandle||'')===(current?.clickId||recipe.clickId?'':'yes'))
      for(const e of outgoing) es.push({...e,id:`e-${recipe.judgeId}-skip-${e.target}`,source:recipe.judgeId,sourceHandle:'no'})
    }
  }
  return {nodes:ns,edges:es}
}
