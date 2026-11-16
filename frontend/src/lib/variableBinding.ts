/** 按输出含义命名；节点 ID 稳定，移动节点不会改变变量身份。旧名称继续有效。 */
const prefixes:Record<string,string>={find_image:'image',color_check:'color',pixel_check:'pixel',region_analysis:'region',script_call:'script',text_input:'text',calculate:'calc',variable:'value'}
export function outputName(node:any, output:{param:string;type?:string}, used:Iterable<string>):string {
  const type=node.data?.nodeType || node.type || 'node'
  const part=output.param.replace(/^save_/, '').replace(/^index_var$/,'index').replace(/^var$/,'text')
  const base=`${prefixes[type] || type}_${String(node.id).replace(/[^\p{L}\p{N}_]/gu,'_')}_${part}`
  const taken=new Set(used);let name=base,i=2
  while(taken.has(name)) name=base+'_'+i++
  return name
}
export function autoBindConnection(nodes:any[], edges:any[], variables:any[], sourceId:string,targetId:string):string {
  const from=nodes.find(n=>n.id===sourceId),to=nodes.find(n=>n.id===targetId)
  const kind=from?.data?.nodeType || from?.type, type=to?.data?.nodeType || to?.type
  if(!['find_image','color_check'].includes(kind)||!['mouse','autoclick'].includes(type)) return ''
  const p=to.data?.params || to.params || {},out=from.data?.params || from.params || {}
  if(p.point_var || Number(p.x || 0)!==0 || Number(p.y || 0)!==0 || (typeof p.x==='string'&&p.x.includes('{{')) || (typeof p.y==='string'&&p.y.includes('{{'))) return ''
  if(new Set(edges.filter(e=>e.target===targetId).map(e=>e.source)).size>1) return ''
  const name=out.save_point || outputName(from,{param:'save_point',type:'point'},variables.map(v=>v.name))
  out.save_point=name;p.point_var=name
  if(!variables.some(v=>v.name===name)) variables.push({name,type:'point',value:''})
  return name
}
