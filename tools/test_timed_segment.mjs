/** 录制→普通节点→时间轴→执行计划的跨语言契约；不接触输入设备。 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {loadFrontend} from './load_frontend_module.mjs'
const {splitRecording,timedAction,editTimedNode,segmentDuration}=loadFrontend('timedSegment')
const {compileProjectTimeline,editableSegmentTimeline}=loadFrontend('inputTimeline')
const plain=value=>JSON.parse(JSON.stringify(value))
let count=0
function check(name,run){run();count++;console.log('ok  '+name)}
const recording=[
  {t:0,type:'keydown',key:'w'}, {t:80,type:'keydown',key:'a'},
  {t:100,type:'mousedown',button:'left',x:10,y:20},
  {t:150,type:'mousemove',x:50,y:60}, {t:180,type:'scroll',dx:1,dy:-2,x:50,y:60},
  {t:300,type:'keyup',key:'w'}, {t:400,type:'mouseup',button:'left',x:70,y:80}, {t:450,type:'keyup',key:'a'},
]
const split=splitRecording(recording,1)
check('独立配对键鼠，保留开始、结束与三者重叠',()=>{
  assert.equal(split.nodes.length,5)
  const actions=split.nodes.map(timedAction)
  assert.deepEqual(plain(actions.filter(a=>a.device==='key').map(a=>[a.keys[0],a.start,a.duration])),[['w',0,300],['a',80,370]])
  const mouse=split.nodes.find(n=>n.params.action==='hold')
  assert.equal(mouse.params.hold_ms,300);assert.equal(mouse.params.end_x,70);assert.equal(mouse.params.end_y,80)
})
check('所有微小间隔和速度倍率均保留，不插入粗粒度延时',()=>{
  const result=splitRecording([{t:0,type:'keydown',key:'x'},{t:7,type:'keyup',key:'x'},{t:12,type:'keydown',key:'y'},{t:19,type:'keyup',key:'y'}],2)
  assert.deepEqual(plain(result.nodes.map(n=>[n.params.timeline.start_ms,n.params.hold_ms])),[[0,3.5],[6,3.5]])
})
check('相同时间戳保留原 down/up 顺序，重复 keydown 不增加持有',()=>{
  const result=splitRecording([{t:0,type:'keydown',key:'a'},{t:0,type:'keydown',key:'a'},{t:1,type:'keyup',key:'a'},{t:1,type:'keydown',key:'a'},{t:2,type:'keyup',key:'a'}])
  assert.equal(result.nodes.length,2);assert.equal(result.nodes[0].params.timeline.end_order,2);assert.equal(result.nodes[1].params.timeline.start_order,3)
})
check('未松开的键保留到片段末尾，并给出说明；孤立松开不删除',()=>{
  const result=splitRecording([{t:0,type:'keyup',key:'b'},{t:10,type:'keydown',key:'a'},{t:50,type:'scroll',dy:1}])
  assert.equal(result.nodes.find(n=>n.params.keys==='a').params.hold_ms,40)
  assert.equal(result.nodes.find(n=>n.params.keys==='b').params.action,'up');assert.equal(result.warnings.length,2)
})
check('编辑保留同一动作与其他参数，不再生成输入方式字段',()=>{
  const node=split.nodes[0], original=JSON.stringify(node)
  const p=editTimedNode(node,120,500)
  assert.equal(p.timeline.start_ms,120);assert.equal(p.hold_ms,500);assert.equal(p.input_mode,undefined)
  assert.equal(JSON.stringify(node),original);assert.equal(p.timeline.start_order,undefined)
})
check('鼠标时长调整保留按钮、拖拽终点，移动时长使用同一个字段',()=>{
  const raw={id:'m',type:'mouse',params:{action:'right_click',x:2,y:3}}
  const p=editTimedNode(raw,25,90);assert.equal(p.button,'right');assert.equal(p.action,'hold');assert.equal(p.hold_ms,90)
  const motion={id:'v',type:'mouse',params:{action:'move',duration_ms:100,timeline:{start_ms:5}}}
  assert.equal(editTimedNode(motion,10,250).duration_ms,250)
})
check('不合法时间、逻辑节点与未知录制事件明确拒绝',()=>{
  assert.throws(()=>splitRecording(recording,0));assert.throws(()=>splitRecording([{t:-1,type:'keydown',key:'a'}]))
  assert.throws(()=>splitRecording([{t:0,type:'unknown'}]));assert.throws(()=>timedAction({id:'j',type:'judge'}))
  assert.throws(()=>editTimedNode(split.nodes[0],NaN));assert.throws(()=>editTimedNode(split.nodes[0],-1))
})
check('编辑视图及工程预览反映真实并发，并且来源可定位',()=>{
  const section=editableSegmentTimeline(split.nodes,{scriptId:'s',groupPath:['g'],path:'录制片段'})
  assert.equal(section.spans.filter(s=>s.kind==='hold'&&s.start<=120&&s.end>120).length,3)
  const project={nodes:[{id:'g',type:'group',params:{execution:'timeline',...split,nodes:split.nodes,edges:[],duration_ms:450,repeat:2}}],edges:[]}
  const plan=compileProjectTimeline(project)
  assert.equal(plan.sections[0].duration,450)
  assert.equal(plan.coveredCount,plan.nodeCount)
  assert.deepEqual(plain(plan.sections[0].spans[0].source.groupPath),['g'])
})
check('最短片段与尾部等待保留，总时长随动作延长',()=>{
  assert.equal(segmentDuration(split.nodes,600),600)
  const p=editTimedNode(split.nodes[0],500,1000)
  assert.equal(segmentDuration([{...split.nodes[0],params:p}],600),1500)
})
check('拆分节点交给 Python 编译后还原原始键鼠事件时间和顺序',()=>{
  const program="import json,sys;sys.path.insert(0,'engine');from timeschedule import compile_segment;p=json.load(sys.stdin);events,duration,repeat=compile_segment(p);print(json.dumps({'events':events,'duration':duration,'repeat':repeat}))"
  const result=spawnSync(process.env.PYTHON || 'python',['-c',program],{cwd:new URL('..',import.meta.url),input:JSON.stringify({nodes:split.nodes,edges:[],duration_ms:450,repeat:2}),encoding:'utf8',windowsHide:true})
  assert.equal(result.status,0,result.stderr)
  const compiled=JSON.parse(result.stdout)
  const rebuilt=compiled.events.filter(e=>e.operation!=='move_begin').map(e=>[e.at,({key_down:'keydown',key_up:'keyup',mouse_down:'mousedown',mouse_up:'mouseup',move:'mousemove',scroll:'scroll'})[e.operation],e.key||e.button||null,e.x??null,e.y??null])
  const expected=recording.map(e=>[e.t,e.type,e.key||e.button||null,e.x??null,e.y??null])
  assert.deepEqual(rebuilt,expected);assert.equal(compiled.duration,450);assert.equal(compiled.repeat,2)
})
console.log(`时序片段 ${count} 项测试全部通过`)
