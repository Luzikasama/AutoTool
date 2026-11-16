/** 0.3.2 跨语言时间契约与预算播放回归；不启动引擎或操作系统键鼠。 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {loadFrontend} from './load_frontend_module.mjs'
const {budgetPreviewSkips,advancePreview}=loadFrontend('timelinePreview')
const {splitRecording,recordingFlow}=loadFrontend('timedSegment')
const {flattenGraph,lowerFlatGraph,normalizeRecordingTiming,regionBranches}=loadFrontend('flatFlow')
const {compileProjectTimeline}=loadFrontend('inputTimeline')
const {reorderTimeline}=loadFrontend('timelineEditing')
const plain=v=>JSON.parse(JSON.stringify(v)),edge=(source,target,sourceHandle=null)=>({id:source+'-'+target,source,target,sourceHandle})
const node=(id,type,params={})=>({id,type:'step',position:{x:0,y:0},data:{nodeType:type,label:type,params}})
let count=0
const test=(label,fn)=>{fn();count++;console.log('ok  '+label)}
const span=(start,end,budget=false)=>({start,end,note:budget?'超时预算':''})
test('只跳过纯预算空档，重叠轴动作和普通延时完整保留',()=>{
  const skips=budgetPreviewSkips([span(0,5000,true),span(0,2000),span(3000,3500)],6000)
  assert.deepEqual(plain(skips),[{start:2000,end:3000},{start:3500,end:5000}])
  assert.equal(advancePreview(0,1000,6000,skips),1000)
  assert.equal(advancePreview(1900,200,6000,skips),3100)
  assert.equal(advancePreview(3400,200,6000,skips),5100)
  assert.equal(advancePreview(5900,1000,6000,skips),6000)
})
test('重叠预算合并，瞬时事件保留，未隐藏预算仍按原时间播放',()=>{
  const skips=budgetPreviewSkips([span(0,2000,true),span(1000,3000,true),span(1500,1500)],3000)
  assert.deepEqual(plain(skips),[{start:0,end:1500},{start:1501,end:3000}])
  assert.equal(advancePreview(0,500,3000,[]),500)
  assert.equal(advancePreview(0,10,3000,budgetPreviewSkips([span(0,3000,true)],3000)),3000)
})
const recording=[{t:0,type:'keydown',key:'w'},{t:15,type:'keydown',key:'a'},{t:20,type:'mousedown',x:100,y:100,button:'left'},{t:40,type:'mouseup',x:100,y:100,button:'left'},{t:50,type:'keyup',key:'a'},{t:100,type:'keyup',key:'w'},{t:110,type:'keydown',key:'x'},{t:150,type:'keyup',key:'x'}]
function unified(){
  const split=splitRecording(recording),axes=recordingFlow(split.nodes)
  const group=node('p','group',{execution:'parallel',nodes:axes.map(a=>node(a.id,'group',{...a.params,nodes:a.params.nodes.map(n=>node(n.id,n.type,n.params))})),edges:[],duration_ms:split.duration,primary_track:axes[0].id,repeat:1})
  const raw=flattenGraph([group],[]);raw.nodes.find(n=>n.id==='p').data.params.timing='unified';return raw
}
test('一个拆分入口保留重叠、微小间隔、按下与松开顺序，前后端计划一致',()=>{
  const raw=unified(),compiled=lowerFlatGraph(raw.nodes,raw.edges),p=compiled.nodes[0].params
  assert.equal(p.execution,'timeline');assert.ok(p.nodes.some(n=>n.type==='mouse'&&n.params.action==='click'))
  const original=splitRecording(recording).nodes
  for(const n of p.nodes){const source=original.find(a=>n.id.endsWith('__'+a.id));assert.equal(n.params.timeline.start_ms,source.params.timeline.start_ms)}
  const script="import json,sys;sys.path.insert(0,'engine');from flatgraph import compile_flow;from timeschedule import compile_segment;f=compile_flow(json.load(sys.stdin));e,d,r=compile_segment(f['nodes'][0]['params']);print(json.dumps({'events':[[v['node_id'],v['operation'],v['at']] for v in e],'duration':d}))"
  const result=spawnSync(process.env.AUTOTOOL_TEST_PYTHON || 'E:/AG-build/at-pyenv/Scripts/python.exe',['-c',script],{input:JSON.stringify({nodes:raw.nodes.map(n=>({id:n.id,type:n.data.nodeType,params:n.data.params})),edges:raw.edges}),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},windowsHide:true})
  assert.equal(result.status,0,result.stderr)
  const events=JSON.parse(result.stdout).events
  assert.deepEqual(events.filter(e=>e[1]==='key_down').map(e=>e[2]),[0,15,110])
  assert.equal(JSON.parse(result.stdout).duration,150)
})
test('在录制内部插入找图无需切换策略，副轴与变量作用域继续保留',()=>{
  const raw=unified(),fork=raw.nodes.find(n=>n.id==='p'),branch=regionBranches(raw.nodes,raw.edges,fork)[0],first=branch.nodes.find(n=>n.id===branch.entry)
  const incoming=raw.edges.find(e=>e.target===first.id);incoming.target='find';raw.edges.push(edge('find',first.id));raw.nodes.push(node('find','find_image',{timeout_ms:5000}))
  const compiled=lowerFlatGraph(raw.nodes,raw.edges).nodes[0].params
  assert.equal(compiled.execution,'parallel');assert.equal(compiled.nodes[0].params._unified_timing,true)
  const spans=compileProjectTimeline(raw).sections[0].spans
  assert.equal(spans.find(s=>s.key==='w').start,5000);assert.equal(spans.find(s=>s.key==='a').start,15)
  assert.ok(spans.some(s=>s.note?.includes('超时预算')))
  fork.data.params.branches[0].variables=[{name:'key',value:'z'}]
  assert.equal(lowerFlatGraph(raw.nodes,raw.edges).nodes[0].params.nodes[0].params.variables[0].name,'key')
})
test('旧精确录制转换为统一依赖后，保存和反复打开不改变时间关系',()=>{
  const raw=unified(),fork=raw.nodes.find(n=>n.id==='p'),absolute=lowerFlatGraph(raw.nodes,raw.edges).nodes[0].params.nodes
  fork.data.params.timing='absolute'
  for(const n of absolute)raw.nodes.find(v=>v.id===n.id).data.params.timeline=plain(n.params.timeline)
  const before=compileProjectTimeline(raw).sections[0].spans.map(s=>[s.source.nodeId,s.start,s.end])
  normalizeRecordingTiming(raw.nodes,raw.edges)
  const first=JSON.stringify(raw);normalizeRecordingTiming(raw.nodes,raw.edges);assert.equal(JSON.stringify(raw),first)
  assert.deepEqual(plain(compileProjectTimeline(raw).sections[0].spans.map(s=>[s.source.nodeId,s.start,s.end])),plain(before))
})
test('统一录制支持跨轴移动，实际执行连线和预览一并变化',()=>{
  const raw=unified(),fork=raw.nodes.find(n=>n.id==='p'),branches=regionBranches(raw.nodes,raw.edges,fork),source=branches[1].entry
  const moved=reorderTimeline(raw.nodes,raw.edges,source,100,compileProjectTimeline(raw).sections[0].spans,{forkId:'p',branchId:branches[0].id})
  assert.ok(regionBranches(moved.nodes,moved.edges,fork)[0].ids.has(source))
  assert.ok(compileProjectTimeline(moved).sections[0].spans.some(s=>s.source.nodeId===source&&s.start>=100))
})
test('短暂原地点击与拖拽、返回原点的拖动可以正确区分',()=>{
  assert.equal(splitRecording(recording).nodes.find(n=>n.type==='mouse').params.action,'click')
  const drag=splitRecording([{t:0,type:'mousedown',x:1,y:1},{t:5,type:'mousemove',x:2,y:2},{t:10,type:'mouseup',x:1,y:1}])
  assert.equal(drag.nodes.find(n=>n.params.button).params.action,'hold')
})
test('旧同轴重叠及变量时长保留原时间表，不被升级悄悄串行化',()=>{
  for(const dynamic of [false,true]){
    const raw={nodes:[node('p','parallel',{timing:'absolute',join_id:'j',branches:[{id:'main'}]}),node('w','keyboard',{keys:'w',hold_ms:dynamic?'{{duration}}':100,timeline:{start_ms:0}}),node('a','keyboard',{keys:'a',hold_ms:20,timeline:{start_ms:10}}),node('j','join',{fork_id:'p'})],edges:[edge('p','w','main'),edge('w','a'),edge('a','j')]}
    const before=JSON.stringify(raw);normalizeRecordingTiming(raw.nodes,raw.edges);assert.equal(JSON.stringify(raw),before)
    assert.equal(lowerFlatGraph(raw.nodes,raw.edges).nodes[0].params.execution,'timeline')
    if(!dynamic){const spans=compileProjectTimeline(raw).sections[0].spans;assert.equal(spans.find(s=>s.key==='a').start,10)}
  }
})
console.log(`0.3.2 时间与拆分 ${count} 项回归全部通过`)
