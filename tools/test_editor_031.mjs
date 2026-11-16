import assert from 'node:assert/strict'
import {loadFrontend} from './load_frontend_module.mjs'
const {reorderTimeline,settleAbsoluteAxis}=loadFrontend('timelineEditing')
const {mergeCard,layoutRecording,cardConnection}=loadFrontend('graphPresentation')
const {searchProject}=loadFrontend('projectSearch')
const {compileProjectTimeline,sourceKey}=loadFrontend('inputTimeline')
const {compareTimeline}=loadFrontend('timelineCompare')
const {createParallel,lowerFlatGraph,foldedGraph,regionBranches}=loadFrontend('flatFlow')
const plain=v=>JSON.parse(JSON.stringify(v)),n=(id,type,params={})=>({id,type:'step',position:{x:0,y:0},data:{nodeType:type,label:type,params,once:false}})
const e=(source,target,sourceHandle=null)=>({id:`${source}-${sourceHandle||'out'}-${target}`,source,target,sourceHandle})
const key=(id,ms=100)=>n(id,'keyboard',{keys:id,action:'press',hold_ms:ms})
let count=0;const test=(label,fn)=>{fn();count++;console.log('ok  '+label)}
const parallel=()=>{const pair=createParallel('p','j',{x:0,y:0});return {nodes:[...pair.nodes,key('a'),key('b',200),key('out',10)],edges:[e('p','a','main'),e('p','b','side1'),e('a','j'),e('b','j'),e('j','out')]}}
const spans=raw=>compileProjectTimeline(raw).sections[0].spans
test('同轴重排改变真实连线与执行顺序，不增加节点',()=>{
 const raw={nodes:[key('a'),key('b'),key('c')],edges:[e('a','b'),e('b','c')]}
 const moved=reorderTimeline(raw.nodes,raw.edges,'c',0,spans(raw))
 assert.deepEqual(plain(spans(moved).map(s=>s.key)),['c','a','b']);assert.equal(moved.nodes.length,3)
})
test('跨轴移动已有动作接回原轴，目标轴串行且汇合等待变更后的结束',()=>{
 const raw=parallel(),moved=reorderTimeline(raw.nodes,raw.edges,'b',100,spans(raw),{forkId:'p',branchId:'main'})
 assert.ok(moved.edges.some(e=>e.source==='p'&&e.sourceHandle==='side1'&&e.target==='j'))
 assert.ok(moved.edges.some(e=>e.source==='a'&&e.target==='b'))
 assert.equal(spans(moved).find(s=>s.key==='out').start,300)
 assert.equal(lowerFlatGraph(moved.nodes,moved.edges).nodes.length,2)
})
test('精确录制跨轴移动保留区域基准，同轴避免重叠；延长动作推动后续',()=>{
 const raw=parallel();raw.nodes.unshift(n('wait','delay',{ms:1000}));raw.edges.push(e('wait','p'));const f=raw.nodes.find(n=>n.id==='p');f.data.params.timing='absolute'
 for(const id of ['a','b'])raw.nodes.find(n=>n.id===id).data.params.timeline={start_ms:id==='a'?0:50,track_id:id==='a'?'main':'side1'}
 const moved=reorderTimeline(raw.nodes,raw.edges,'b',1050,spans(raw),{forkId:'p',branchId:'main'})
 assert.equal(moved.nodes.find(n=>n.id==='b').data.params.timeline.start_ms,100)
 moved.nodes.find(n=>n.id==='a').data.params.hold_ms=500;settleAbsoluteAxis(moved.nodes,moved.edges,f,'a')
 assert.equal(moved.nodes.find(n=>n.id==='b').data.params.timeline.start_ms,500)
 assert.equal(spans(moved).find(s=>s.key==='b').start,1500)
})
test('合并完整并行区域只生成显示卡片，时间、连线与局部变量不变',()=>{
 const raw=parallel(),before=plain(spans(raw)),edges=plain(raw.edges);raw.nodes.find(n=>n.id==='p').data.params.variables=[{name:'private',value:'3'}]
 const id=mergeCard(raw.nodes,raw.edges,['p']);assert.equal(id,'p');assert.equal(foldedGraph(raw.nodes,raw.edges).nodes.length,2)
 assert.deepEqual(plain(spans(raw)),before);assert.deepEqual(plain(raw.edges),edges)
 assert.equal(raw.nodes.find(n=>n.id==='p').data.params.variables[0].value,'3')
 assert.ok(raw.nodes.every(n=>n.data.nodeType!=='record'&&n.data.nodeType!=='group'))
  assert.equal(cardConnection(raw.nodes,raw.edges,{source:'p',target:'next'}).source,'j')
})
test('拆分布局主副轴分行、相同开始同列、汇合在全部动作之后',()=>{
 const raw=parallel(),f=raw.nodes.find(n=>n.id==='p');layoutRecording(raw.nodes,raw.edges,'p',{a:0,b:0})
 const a=raw.nodes.find(n=>n.id==='a'),b=raw.nodes.find(n=>n.id==='b'),j=raw.nodes.find(n=>n.id==='j')
 assert.equal(a.position.x,b.position.x);assert.notEqual(a.position.y,b.position.y);assert.ok(j.position.x>a.position.x)
 assert.equal(regionBranches(raw.nodes,raw.edges,f).length,2)
})
test('全局搜索包含未调用子脚本、变量引用、折叠内部节点，并支持类型筛选',()=>{
 const raw=parallel();raw.name='根';raw.nodes.find(n=>n.id==='b').data.params.keys='{{target_key}}';mergeCard(raw.nodes,raw.edges,['p'])
 raw.scripts={sub:{name:'未调用',nodes:[n('mouse','mouse',{point_var:'target_point'})],edges:[]}}
 assert.equal(searchProject(raw,'target_key')[0].source.nodeId,'b')
 assert.equal(searchProject(raw,'target_point')[0].source.scriptId,'sub')
 assert.equal(searchProject(raw,'','mouse').length,1)
})
const event=(kind,t,extra={})=>({seq:0,kind,time_ms:t,active_ms:t,node_id:'a',script_id:'',group_path:[],round:1,...extra})
const snapshot=events=>({run_id:'test',project_id:'',name:'test',running:false,elapsed_ms:Math.max(1000,...events.map(e=>e.time_ms)),active_elapsed_ms:Math.max(1000,...events.map(e=>e.active_ms ?? e.time_ms)),dropped:0,events:events.map((e,i)=>({...e,seq:i+1}))})
const feedback=(expected,events,tolerance=50)=>compareTimeline(expected,snapshot(events),tolerance).get(sourceKey({scriptId:'',groupPath:[],nodeId:'a'}))
test('时间容差可调整，按键不符与实际物理按键不符均标红',()=>{
 const expected=compileProjectTimeline({nodes:[key('a')],edges:[]}).sections
 const base=[event('node_start',20,{call_id:'1',device:'key',key:'a',expected_start_ms:0,expected_duration_ms:100,timing_kind:'fixed'}),event('node_end',120,{call_id:'1',status:'finished'})]
 assert.equal(feedback(expected,base).state,'good');assert.equal(feedback(expected,base,10).state,'bad')
 assert.equal(feedback(expected,[{...base[0],key:'x'},base[1]]).state,'bad')
 assert.equal(feedback(expected,[{...base[0],expected_key:'a'},event('down',21,{call_id:'1',device:'key',key:'x'}),base[1]]).state,'bad')
})
test('预算提前结束后按实际依赖继续为绿色，暂停使用有效时间',()=>{
 const expected=compileProjectTimeline({nodes:[n('find','find_image',{timeout_ms:5000}),key('a')],edges:[e('find','a')]}).sections
 const events=[event('node_start',1000,{node_id:'find',call_id:'f',device:'flow',expected_start_ms:1000,expected_duration_ms:5000,timing_kind:'budget'}),event('node_end',1200,{node_id:'find',call_id:'f',status:'finished'}),event('node_start',1200,{call_id:'1',device:'key',key:'a',expected_start_ms:1200,expected_duration_ms:100,timing_kind:'fixed'}),event('node_end',1300,{call_id:'1',status:'finished',time_ms:4300})]
 assert.equal(feedback(expected,events).state,'good')
})
test('应并发的动作被串行执行时标红；未走分支没有错误颜色',()=>{
 const raw=parallel(),expected=compileProjectTimeline(raw).sections
 const events=[event('node_start',0,{call_id:'1',device:'key',key:'a',expected_start_ms:0,expected_duration_ms:100,timing_kind:'fixed'}),event('node_end',100,{call_id:'1',status:'finished'}),event('node_start',200,{node_id:'b',call_id:'2',device:'key',key:'b',expected_start_ms:0,expected_duration_ms:200,timing_kind:'fixed'}),event('node_end',400,{node_id:'b',call_id:'2',status:'finished'})]
 assert.equal(feedback(expected,events).state,'bad')
 const none=compareTimeline(expected,snapshot([]));assert.equal(none.size,0)
})
test('鼠标点击次数与文本字符数不符标红，内容不参与记录',()=>{
 const expected=compileProjectTimeline({nodes:[n('a','mouse',{action:'click',x:1,y:2})],edges:[]}).sections
 assert.equal(feedback(expected,[event('node_start',0,{call_id:'c',device:'mouse',key:'left',expected_clicks:2,expected_start_ms:0,timing_kind:'fixed'}),event('down',1,{call_id:'c',device:'mouse',key:'left'}),event('node_end',10,{call_id:'c',status:'finished'})]).state,'bad')
 assert.equal(feedback(expected,[event('node_start',0,{call_id:'c',device:'text',expected_chars:5,expected_start_ms:0,timing_kind:'unknown'}),event('text',1,{call_id:'c',device:'text',chars:3}),event('node_end',10,{call_id:'c',status:'finished'})]).state,'bad')
})
test('跨节点持续按住保留按下/松开关系，不能只移动半个持有区间',()=>{
 const raw={nodes:[n('down','keyboard',{action:'down',keys:'w'}),n('wait','delay',{ms:100}),n('up','keyboard',{action:'up',keys:'w'})],edges:[e('down','wait'),e('wait','up')]}
 assert.throws(()=>reorderTimeline(raw.nodes,raw.edges,'down',100,spans(raw)),/多个节点/)
})
test('运行参数与静态编辑基准不一致不能自我验证为绿色',()=>{
 const expected=compileProjectTimeline({nodes:[key('a')],edges:[]}).sections
 const ev=[event('node_start',100,{call_id:'1',device:'key',key:'a',expected_key:'a',expected_delay_ms:100,expected_start_ms:100,expected_duration_ms:100,timing_kind:'fixed'}),event('node_end',200,{call_id:'1',status:'finished'})]
 assert.equal(feedback(expected,ev).state,'bad')
 const raw=parallel(),sections=compileProjectTimeline(raw).sections
 const serial=[event('node_start',0,{call_id:'1',device:'key',key:'a',expected_start_ms:0,expected_duration_ms:100,timing_kind:'fixed'}),event('node_end',100,{call_id:'1',status:'finished'}),event('node_start',100,{node_id:'b',call_id:'2',device:'key',key:'b',expected_start_ms:100,expected_duration_ms:200,timing_kind:'fixed'}),event('node_end',300,{node_id:'b',call_id:'2',status:'finished'})]
 assert.equal(feedback(sections,serial).state,'bad')
})
console.log(`0.3.1 编辑与比对 ${count} 项回归全部通过`)
