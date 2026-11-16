import {NODE_META} from '../types'
import type {TimelineSource} from './inputTimeline'
export interface SearchHit {source:TimelineSource;type:string;detail:string}
export function searchProject(project:any,query:string,type=''):SearchHit[]{
  const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean),result:SearchHit[]=[]
  if(!tokens.length&&!type)return result
  const text=(p:any)=>Object.entries(p || {}).filter(([k])=>!['nodes','edges','events','image','variables'].includes(k)).map(([,v])=>typeof v==='object'?JSON.stringify(v):String(v)).join(' ').slice(0,8000)
  const walk=(raw:any,scriptId:string,groupPath:string[],path:string,depth=0)=>{
    if(depth>16||result.length>=400)return
    for(const n of raw?.nodes || []){
      const kind=n.data?.nodeType || n.type,p=n.data?.params || n.params || {},label=n.data?.foldLabel || n.data?.label || (NODE_META as any)[kind]?.label || kind
      const detail=text(p),haystack=`${n.id} ${kind} ${label} ${(NODE_META as any)[kind]?.label || ''} ${path} ${detail}`.toLowerCase()
      if((!type||type===kind)&&tokens.every(t=>haystack.includes(t)))result.push({source:{scriptId,groupPath,nodeId:n.id,label,path},type:kind,detail:detail.slice(0,100)})
      if(kind==='group')walk(p,scriptId,[...groupPath,n.id],`${path} / ${p.name || label}`,depth+1)
      if(result.length>=400)break
    }
  }
  walk(project,'',[],project?.name || '主脚本')
  for(const [id,s] of Object.entries(project?.scripts || {}))walk(s,id,[],`${project?.name || '工程'} / ${(s as any).name || id}`)
  return result
}
