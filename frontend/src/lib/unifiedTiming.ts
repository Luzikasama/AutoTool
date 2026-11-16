import {timedAction} from './timedSegment'

/** 从流程依赖计算共同时间表；只有静态、闭合、直连的键鼠路径可提前编排。 */
export function timedTracks(tracks:any[]):any[]|null{
  const result:any[]=[]
  try{
    for(const track of tracks){
      const body=track.params
      if(body.variables?.length)return null
      const nodes=body.nodes || [],edges=body.edges || [],byId=new Map<string,any>(nodes.map((n:any)=>[n.id,n])),out=new Map<string,any[]>(),incoming=new Set<string>()
      for(const e of edges){out.set(e.source,[...(out.get(e.source) || []),e]);incoming.add(e.target)}
      let current=nodes.find((n:any)=>!incoming.has(n.id))?.id,clock=Number(body.timeline?.start_ms || 0)
      if(!Number.isFinite(clock)||clock<0)return null
      const seen=new Set<string>()
      while(current){
        const n=byId.get(current),p=n?.params || {},action=p.action || (n?.type==='keyboard'?'press':'click')
        if(!n || seen.has(current)||n.once||!['keyboard','mouse'].includes(n.type)||['down','up'].includes(action)||p.point_var||JSON.stringify(p).includes('{{'))return null
        seen.add(current)
        const delay=Number(p.timeline?.delay_ms || 0)
        if(!Number.isFinite(delay)||delay<0)return null
        clock+=delay
        const duration=timedAction(n).duration
        result.push({...n,params:{...p,timeline:{...p.timeline,start_ms:clock,track_id:track.id}}})
        clock+=duration
        if(clock>86400000)return null
        const links=out.get(current) || []
        if(links.length>1||links[0]?.sourceHandle)return null
        current=links[0]?.target
      }
      if(seen.size!==nodes.length)return null
    }
    return result
  }catch{return null}
}
