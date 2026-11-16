/** 工程时间轴纯逻辑测试。无需引擎/浏览器，不操作真实键鼠。 */
import assert from 'node:assert/strict'
import {loadFrontend} from './load_frontend_module.mjs'
const {compileProjectTimeline:compile,traceTimeline,sourceKey} = loadFrontend('inputTimeline')
const node = (id,type,params={})=>({id,type,params})
const edge = (source,target,sourceHandle='')=>({source,target,sourceHandle})
const chain = (...nodes)=>({nodes,edges:nodes.slice(1).map((n,i)=>edge(nodes[i].id,n.id))})
const keyboard=(id,keys,action='press',hold_ms=30)=>node(id,'keyboard',{keys,action,hold_ms})
const delay=(id,ms)=>node(id,'delay',{ms})
const spans = (model, key, section=0)=>model.sections[section].spans.filter(s=>s.device==='key' && s.key===key)
let count=0
function check(label,run) {run();count++;console.log('ok  '+label)}

check('多个持续按键按真实重叠区间显示，来源与松开节点可定位',()=>{
  const model=compile(chain(keyboard('w','w','down'),delay('d1',100),keyboard('a','a','down'),delay('d2',100),keyboard('wu','w','up'),keyboard('au','a','up')))
  assert.equal(spans(model,'w')[0].start,0);assert.equal(spans(model,'w')[0].end,200)
  assert.equal(spans(model,'a')[0].start,100);assert.equal(spans(model,'a')[0].end,200)
  assert.equal(spans(model,'w')[0].source.nodeId,'w');assert.equal(spans(model,'w')[0].endSource.nodeId,'wu')
})
check('组合键作为一个动作条带显示，保持时长一致',()=>{
  const model=compile(chain(keyboard('combo','ctrl+shift+a','press',80)))
  assert.equal(spans(model,'ctrl+shift+a')[0].start,0);assert.equal(spans(model,'ctrl+shift+a')[0].end,80)
})
check('鼠标按下、平滑拖动和松开保持完整持续区间',()=>{
  const model=compile(chain(node('m1','mouse',{action:'down'}),node('move','mouse',{action:'move',duration_ms:200}),delay('d',100),node('m2','mouse',{action:'up'})))
  const hold=model.sections[0].spans.find(s=>s.device==='mouse')
  assert.equal(hold.start,0);assert.equal(hold.end,300);assert.equal(hold.endSource.nodeId,'m2')
})
check('录制事件保留独立 down/up 时间和变速',()=>{
  const model=compile(chain(node('r','record',{speed:2,events:[{t:0,type:'keydown',key:'w'},{t:50,type:'keydown',key:'a'},{t:100,type:'mousedown',button:'left'},{t:200,type:'keyup',key:'w'},{t:300,type:'keyup',key:'a'},{t:500,type:'mouseup',button:'left'}]})))
  assert.equal(spans(model,'w')[0].end,100);assert.equal(spans(model,'a')[0].start,25);assert.equal(spans(model,'a')[0].end,150)
  assert.equal(model.sections[0].spans.find(s=>s.device==='mouse').end,250)
})
check('调用子脚本与组合节点在主流程中展开，跨节点持有不丢失',()=>{
  const model=compile({...chain(keyboard('w','w','down'),node('call','script_call',{script_id:'s'}),node('g','group',{...chain(keyboard('gk','c','press',40))}),keyboard('u','w','up')),scripts:{s:{name:'回城',...chain(delay('d',200),keyboard('sk','a','press',50))}}})
  assert.equal(spans(model,'w')[0].end,290);assert.equal(spans(model,'a')[0].source.scriptId,'s')
  assert.equal(spans(model,'c')[0].source.groupPath[0],'g')
})
check('分支可切换，未选分支作为独立片段而不是并发操作',()=>{
  const project={nodes:[node('j','judge'),keyboard('a','a'),keyboard('b','b'),delay('join',10)],edges:[edge('j','a','yes'),edge('j','b','no'),edge('a','join'),edge('b','join')]}
  const model=compile(project)
  assert.equal(spans(model,'a').length,1);assert.equal(spans(model,'b').length,0)
  assert.ok(model.sections.slice(1).some(s=>s.spans.some(v=>v.key==='b')))
  const flipped=compile(project,{branches:{[sourceKey({scriptId:'',groupPath:[],nodeId:'j'})]:'no'}})
  assert.equal(spans(flipped,'b').length,1);assert.equal(spans(flipped,'a').length,0)
  assert.equal(model.coveredCount,4)
})
check('未连接节点和未调用脚本中的键鼠操作都能找到',()=>{
  const model=compile({nodes:[keyboard('a','a'),keyboard('b','b')],edges:[],scripts:{unused:{name:'未调用',...chain(keyboard('c','c'))}}})
  const all=model.sections.flatMap(s=>s.spans)
  assert.ok(['a','b','c'].every(key=>all.some(s=>s.key===key)));assert.equal(model.coveredCount,3)
})
check('固定循环只显示一轮，结束出口紧接本轮动作',()=>{
  const project={nodes:[node('l','loop',{times:3,interval_ms:10}),keyboard('a','a','press',20),keyboard('b','b','press',30)],edges:[edge('l','a','body'),edge('a','l'),edge('l','b','next')]}
  const model=compile(project)
  assert.equal(spans(model,'a').length,1);assert.equal(spans(model,'a')[0].start,0)
  assert.equal(spans(model,'b')[0].start,20);assert.equal(model.sections[0].duration,50)
})
check('空循环体不会重新进入自身造成递归',()=>{
  const model=compile({nodes:[node('l','loop',{times:3}),keyboard('b','b')],edges:[edge('l','b','next')]})
  assert.equal(spans(model,'b').length,1)
})
check('未知识别耗时明确标记，后续时刻只作示意',()=>{
  const model=compile(chain(node('find','find_image'),keyboard('k','w')))
  assert.ok(model.sections[0].warnings.length);assert.equal(spans(model,'w')[0].estimated,true)
  assert.equal(model.sections[0].spans[0].kind,'gap')
})
check('长循环和大量连点有界展开并报告截断',()=>{
  const repeated=compile({...chain(keyboard('a','a')),repeat:100000},{loopPreview:2})
  assert.equal(spans(repeated,'a').length,1);assert.ok(repeated.sections[0].warnings.some(w=>w.includes('100000')))
  const clicks=compile(chain(node('click','autoclick',{count:100000,interval_ms:0})))
  assert.ok(clicks.sections[0].spans.length<=6000);assert.ok(clicks.sections[0].warnings.some(w=>w.includes('截断')))
})
check('支持 Vue Flow 文件形状，预览不会修改工程数据',()=>{
  const project={nodes:[{id:'n',type:'step',data:{nodeType:'keyboard',params:{keys:'w',hold_ms:40}}}],edges:[]}
  const before=JSON.stringify(project),model=compile(project)
  assert.equal(spans(model,'w')[0].end,40);assert.equal(JSON.stringify(project),before)
})
check('多个独立连点片段共用工程预算，不能分别膨胀到上限',()=>{
  const model=compile({nodes:[node('a','autoclick',{count:100000}),node('b','autoclick',{count:100000})],edges:[],scripts:{s:{...chain(node('c','autoclick',{count:100000}))}}})
  assert.ok(model.sections.reduce((sum,s)=>sum+s.spans.length,0)<=6000)
  assert.ok(model.warnings.some(w=>w.includes('6000')))
})
check('实测按顺序配对，包含运行收尾松开以及当前未松开的键',()=>{
  const events=[{seq:1,time_ms:0,kind:'down',device:'key',key:'w',node_id:'w'},{seq:2,time_ms:100,kind:'down',device:'key',key:'a',node_id:'a'},{seq:3,time_ms:250,kind:'up',device:'key',key:'w',node_id:'u',cleanup:true}]
  const section=traceTimeline({events,elapsed_ms:400,running:true,dropped:0,name:'测试'})
  const w=section.spans.find(s=>s.key==='w'),a=section.spans.find(s=>s.key==='a')
  assert.equal(w.end,250);assert.ok(w.note.includes('收尾'));assert.equal(a.end,400);assert.equal(a.open,true)
})
check('缺失按下不伪造长按；截断记录给予提示',()=>{
  const section=traceTimeline({events:[{seq:20,time_ms:250,kind:'up',device:'mouse',key:'left'}],elapsed_ms:300,running:false,dropped:19})
  assert.equal(section.spans[0].kind,'point');assert.ok(section.warnings.some(w=>w.includes('19')))
})
console.log(`时间轴 ${count} 项行为测试全部通过`)
