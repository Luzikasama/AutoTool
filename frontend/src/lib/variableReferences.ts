/** 保留层级作用域：重命名本层写入及向下可见的读取，遇到同名局部声明即停止传播。 */
import {regionBranches,kind,params} from './flatFlow'
const outputs=(p:any)=>Object.keys(p || {}).filter(k=>k.startsWith('save_') || ['index_var','var'].includes(k))
export function renameScopeVariable(nodes:any[],from:string,to:string,global=false,own=true,shadowed=false,edges:any[]=[]) {
  const rewrite=(value:any):any=>{
    if(typeof value==='string') return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(whole,name)=>name===from?`{{${to}}}`:name===from+'.x'?`{{${to}.x}}`:name===from+'.y'?`{{${to}.y}}`:whole)
    if(Array.isArray(value))return value.map(rewrite)
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)]))
    return value
  }
  const routed=new Set<string>()
  const regions=(nodes || []).filter(n=>['parallel','scope'].includes(kind(n))).map(n=>({node:n,branches:regionBranches(nodes,edges,n)})).sort((a,b)=>b.branches.reduce((s:number,t:any)=>s+t.ids.size,0)-a.branches.reduce((s:number,t:any)=>s+t.ids.size,0))
  for(const region of regions){
    if(routed.has(region.node.id))continue
    const p=params(region.node),parentShadow=(p.variables || []).some((v:any)=>v.name===from)
    for(const branch of region.branches){
      const nested=new Set<string>();for(const n of branch.nodes)if(['parallel','scope'].includes(kind(n)))regionBranches(branch.nodes,branch.edges,n).forEach((b:any)=>b.ids.forEach((id:string)=>nested.add(id)))
      const local=parentShadow||(branch.variables || []).some((v:any)=>v.name===from)||branch.nodes.filter((n:any)=>!nested.has(n.id)).some((n:any)=>outputs(params(n)).some(k=>params(n)[k]===from))
      renameScopeVariable(branch.nodes,from,to,global,false,shadowed||local,branch.edges)
      branch.ids.forEach((id:string)=>routed.add(id))
    }
  }
  for(const n of nodes || []) {
    if(routed.has(n.id))continue
    const p=n.data?.params || n.params || {},type=n.data?.nodeType || n.type
    for(const key of Object.keys(p)) {
      if(['nodes','edges','variables','branches'].includes(key))continue
      const old=p[key]
      if(!shadowed) p[key]=rewrite(old)
      if(own && outputs(p).includes(key) && old===from) p[key]=to
      if(!shadowed && key==='point_var' && old===from) p[key]=to
      if(!shadowed && ['condition','condition2'].includes(key)) for(const side of ['left','right']) if(p[key]?.[side]===from)p[key][side]=to
    }
    if(type==='variable') {
      const isGlobal=p.scope==='global'
      const action=p.action || 'set'
      if(action==='get'&&!shadowed&&p.name===from)p.name=to
      const writeKey=action==='get'?'target':'name'
      if(((global && isGlobal) || (own && !isGlobal))&&p[writeKey]===from)p[writeKey]=to
    }
    if(type==='group') {
      const child=p.nodes || []
      const local=(p.variables || []).some((v:any)=>v.name===from) || child.some((v:any)=>{const params=v.data?.params || v.params || {};return outputs(params).some(k=>params[k]===from)})
      renameScopeVariable(child,from,to,global,false,shadowed || local,p.edges || [])
    }
  }
}
export function variableReferenced(nodes:any[],name:string):boolean {
  const walk=(value:any,key=''):boolean=>{
    if(['variables','edges','simple'].includes(key))return false
    if(typeof value==='string')return value.includes(`{{${name}}}`)||value.includes(`{{${name}.x}}`)||value.includes(`{{${name}.y}}`)||(['point_var','left','right'].includes(key)&&value===name)
    if(Array.isArray(value))return value.some(v=>walk(v))
    return value&&typeof value==='object'?Object.entries(value).some(([k,v])=>walk(v,k)):false
  }
  return nodes.some(n=>{const p=params(n);return (kind(n)==='variable'&&p.action==='get'&&p.name===name)||walk(p)})
}
