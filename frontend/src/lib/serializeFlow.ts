/** 文件只保存流程与布局，剔除画布测量、选择状态及简易投影的临时字段。 */
export function serializeFlowGraph(nodes: any[] = [], edges: any[] = []): {nodes:any[];edges:any[]} {
  return {
    nodes: nodes.map(node => {
      const data = JSON.parse(JSON.stringify(node.data || {}))
      delete data.simpleView
      delete data.simpleAdvanced
      delete data.foldCount
      if(data.params)delete data.params.input_mode
      if (Array.isArray(data.params?.nodes)) {
        Object.assign(data.params, serializeFlowGraph(data.params.nodes, data.params.edges || []))
      }
      return {id:node.id,type:node.type || 'step',position:{x:node.position?.x ?? 0,y:node.position?.y ?? 0},data}
    }),
    edges: edges.map(edge => ({id:edge.id,source:edge.source,target:edge.target,sourceHandle:edge.sourceHandle || null})),
  }
}
