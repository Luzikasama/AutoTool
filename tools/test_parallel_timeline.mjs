import assert from 'node:assert/strict'
import {loadFrontend} from './load_frontend_module.mjs'
const {compileProjectTimeline,traceTimeline,timelineLanes,sourceKey}=loadFrontend('inputTimeline')
const {recordingFlow,splitRecording}=loadFrontend('timedSegment')
const {renameScopeVariable}=loadFrontend('variableReferences')
const n=(id,type,params={})=>({id,type,params})
const key=(id,keys,hold_ms)=>n(id,'keyboard',{keys,hold_ms})
const group=(id,nodes,extra={})=>n(id,'group',{nodes,edges:nodes.slice(1).map((node,i)=>({source:nodes[i].id,target:node.id})),...extra})
const plain=v=>JSON.parse(JSON.stringify(v))
let count=0;const test=(label,fn)=>{fn();count++;console.log('ok  '+label)}
test('主轴与副轴各自从偏移开始，后续流程等待较晚完成的副轴',()=>{
  const parallel=n('p','group',{execution:'parallel',primary_track:'m',nodes:[group('m',[key('k','w',20)],{name:'主要分支'}),group('s',[key('k','a',80)],{name:'辅助分支',timeline:{start_ms:10}})]})
  const plan=compileProjectTimeline({nodes:[parallel,key('after','z',5)],edges:[{source:'p',target:'after'}]})
  const spans=plan.sections[0].spans
  assert.equal(spans.find(s=>s.key==='w').end,20);assert.equal(spans.find(s=>s.key==='a').start,10);assert.equal(spans.find(s=>s.key==='z').start,90)
  assert.deepEqual(plain(spans.find(s=>s.key==='w').source.groupPath),['p','m'])
  assert.equal(plan.coveredCount,plan.nodeCount)
  assert.equal(timelineLanes(spans).filter(t=>t.label==='辅助分支').length,1)
  assert.equal(timelineLanes(spans).length,2)
  assert.equal(spans.find(s=>s.key==='w').lane,spans.find(s=>s.key==='z').lane)
})
test('找图超时用预算显示，后继为示意，各轴共用时间起点',()=>{
  const main=group('m',[n('f','find_image',{timeout_ms:1500}),key('k','enter',30)])
  const side=group('s',[key('k','w',4000)])
  const plan=compileProjectTimeline({nodes:[n('p','group',{execution:'parallel',nodes:[main,side]})],edges:[]})
  const spans=plan.sections[0].spans
  assert.equal(spans.find(s=>s.key==='enter').start,1500);assert.equal(spans.find(s=>s.key==='enter').estimated,true)
  assert.equal(spans.find(s=>s.key==='w').start,0);assert.equal(plan.sections[0].duration,4000)
  assert.ok(spans.find(s=>s.source.nodeId==='f').note.includes('超时预算'))
})
test('录制拆成有逻辑连线的各轴后，预览保持绝对时间和三方并发',()=>{
  const split=splitRecording([{type:'keydown',key:'w',t:0},{type:'keydown',key:'a',t:50},{type:'mousedown',button:'left',x:1,y:2,t:80},{type:'keyup',key:'w',t:200},{type:'keyup',key:'a',t:250},{type:'mouseup',button:'left',x:1,y:2,t:300}])
  const axes=recordingFlow(split.nodes),plan=compileProjectTimeline({nodes:[n('p','group',{execution:'parallel',nodes:axes})],edges:[]})
  assert.equal(axes.length,3)
  const spans=plan.sections[0].spans
  assert.ok(spans.some(s=>s.key==='a'&&s.start===50&&s.end===250));assert.equal(spans.filter(s=>s.start<=100&&s.end>100).length,3)
})
test('实测逻辑区间保留同键的两个并发持有，逐轮查看且不合并不同轴',()=>{
  const events=[{kind:'round_start',time_ms:0,round:1},{kind:'node_start',time_ms:10,call_id:'1',track_id:'m',track_label:'main',primary:true,node_id:'k',device:'key',key:'w'},{kind:'node_start',time_ms:20,call_id:'2',track_id:'s',track_label:'side',primary:false,node_id:'k',device:'key',key:'w'},{kind:'node_end',time_ms:40,call_id:'1'},{kind:'node_end',time_ms:90,call_id:'2'},{kind:'round_end',time_ms:100,round:1},{kind:'round_start',time_ms:100,round:2},{kind:'node_start',time_ms:110,call_id:'3',device:'key',key:'a'},{kind:'node_end',time_ms:130,call_id:'3'},{kind:'round_end',time_ms:140,round:2}].map((e,i)=>({...e,seq:i+1}))
  const first=traceTimeline({events,elapsed_ms:140,running:false,dropped:0},1)
  assert.equal(first.spans.length,2);assert.equal(first.duration,100)
  assert.equal(first.spans[0].end,40);assert.equal(first.spans[1].end,90)
  const latest=traceTimeline({events,elapsed_ms:140,running:false,dropped:0})
  assert.equal(latest.spans.length,1);assert.equal(latest.spans[0].key,'a');assert.equal(latest.spans[0].start,10)
})
test('变量重命名传播读取但保留同名局部变量和文字字面量',()=>{
  const nodes=[n('f','find_image',{save_point:'p'}),n('m','mouse',{point_var:'p'}),n('text','text_input',{text:'{{p.x}},{{p.y}} p'}),group('g',[n('inside','mouse',{point_var:'p'})],{variables:[{name:'p',type:'point',value:'1,2'}]})]
  renameScopeVariable(nodes,'p','target',true)
  assert.equal(nodes[0].params.save_point,'target');assert.equal(nodes[1].params.point_var,'target');assert.equal(nodes[2].params.text,'{{target.x}},{{target.y}} p')
  assert.equal(nodes[3].params.nodes[0].params.point_var,'p')
  assert.ok(sourceKey({scriptId:'',groupPath:['p','m'],nodeId:'k'}).includes('m'))
})
test('副轴中的嵌套主路径继承副轴，内层并发另列轴，汇合后回到原主轴',()=>{
  const nested=n('nested','group',{execution:'parallel',nodes:[group('main',[key('inside','i',20)]),group('side',[key('deep','d',30)])]})
  const side=group('side',[key('before','a',10),nested,key('after','s',10)])
  const p=n('outer','group',{execution:'parallel',nodes:[group('main',[key('top','w',20)]),side]})
  const plan=compileProjectTimeline({nodes:[p,key('joined','z',10)],edges:[{source:'outer',target:'joined'}]})
  const spans=plan.sections[0].spans,byKey=k=>spans.find(s=>s.key===k)
  assert.equal(byKey('a').lane,byKey('i').lane);assert.equal(byKey('a').lane,byKey('s').lane)
  assert.notEqual(byKey('d').lane,byKey('a').lane);assert.equal(byKey('w').lane,byKey('z').lane)
  assert.equal(timelineLanes(spans).length,3)
  const trace=traceTimeline({events:spans.flatMap((s,i)=>[{kind:'node_start',time_ms:s.start,call_id:String(i),device:s.device,key:s.key,track_id:s.source.trackId,axis_id:s.source.axisId,primary:s.source.primary},{kind:'node_end',time_ms:s.end,call_id:String(i)}]).map((e,i)=>({...e,seq:i+1})),elapsed_ms:plan.sections[0].duration,running:false,dropped:0})
  assert.equal(timelineLanes(trace.spans).length,3)
})
console.log(`主副轴与变量 ${count} 项行为回归全部通过`)
