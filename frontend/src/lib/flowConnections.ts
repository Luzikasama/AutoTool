const kind=(n:any)=>n?.data?.nodeType || n?.type
const params=(n:any)=>n?.data?.params || n?.params || {}

/** 拖线阶段的轻量校验；无效连接不破坏旧线。 */
export function connectionIssue(nodes:any[],connection:any):string|null{
  const source=nodes.find(n=>n.id===connection.source),target=nodes.find(n=>n.id===connection.target)
  if(!source||!target)return '请选择有效节点'
  const port=connection.sourceHandle || ''
  if(source===target&&!(kind(source)==='loop'&&port==='body'))return '节点不能连接到自身'
  if(kind(source)==='terminate')return '终止节点没有后续路径'
  const ports=kind(source)==='parallel'?(params(source).branches || []).map((b:any)=>b.id):kind(source)==='judge'||source.data?.simpleView?.kind==='image_judge'?['yes','no']:kind(source)==='loop'?['body','next']:['']
  if(!ports.includes(port))return '请选择正确的分支出口'
  return null
}

export function wireLabel(nodes:any[],edge:any):string{
  const source=nodes.find(n=>n.id===edge.source),port=edge.sourceHandle
  if(kind(source)==='judge'||source?.data?.simpleView?.kind==='image_judge')return port==='yes'?'是':port==='no'?'否':''
  if(kind(source)==='loop')return port==='body'?'循环体':port==='next'?'结束后':''
  if(kind(source)==='parallel')return (params(source).branches || []).find((b:any)=>b.id===port)?.name || ''
  return ''
}
