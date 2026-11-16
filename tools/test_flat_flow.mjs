import assert from 'node:assert/strict'
import {loadFrontend} from './load_frontend_module.mjs'
const {flattenGraph,createParallel,lowerFlatGraph,assignBranch,removeCanvasNodes,foldedGraph}=loadFrontend('flatFlow')
const {compileProjectTimeline}=loadFrontend('inputTimeline')
const {migrateScript}=loadFrontend('migrateFlow')
const {serializeFlowGraph}=loadFrontend('serializeFlow')
const {renameScopeVariable}=loadFrontend('variableReferences')
const {extractFragment,materializeFragment}=loadFrontend('clipFragment')
const plain=v=>JSON.parse(JSON.stringify(v))
const n=(id,type,params={})=>({id,type:'step',position:{x:100,y:80},data:{nodeType:type,label:type,params}})
const e=(source,target,sourceHandle=null)=>({id:source+'-'+(sourceHandle||'')+'-'+target,source,target,sourceHandle})
let count=0
const test=(label,fn)=>{fn();count++;console.log('ok  '+label)}
const base=()=>{const p=createParallel('p','j',{x:0,y:0});return {nodes:[...p.nodes,n('a','keyboard',{keys:'w',hold_ms:20}),n('b','keyboard',{keys:'a',hold_ms:80}),n('out','keyboard',{keys:'z',hold_ms:1})],edges:[e('p','a','main'),e('p','b','side1'),e('a','j'),e('b','j'),e('j','out')]}}
test('平面图预览并发，后续节点从副轴结束开始，来源为同一画布',()=>{
  const raw=base(),before=plain(raw),plan=compileProjectTimeline(raw),spans=plan.sections[0].spans
  assert.equal(spans.find(s=>s.key==='z').start,80)
  assert.equal(spans.find(s=>s.key==='a').end,80)
  assert.deepEqual(plain(spans.find(s=>s.key==='w').source.groupPath),[])
  assert.notEqual(spans.find(s=>s.key==='w').source.trackId,spans.find(s=>s.key==='a').source.trackId)
  assert.equal(spans.find(s=>s.key==='w').lane,spans.find(s=>s.key==='z').lane)
  assert.notEqual(spans.find(s=>s.key==='w').lane,spans.find(s=>s.key==='a').lane)
  assert.deepEqual(plain(raw),before)
})
test('同名局部变量在展开组和并发轴后继续保留',()=>{
  const raw={nodes:[n('g','group',{name:'局部',variables:[{name:'x',value:'1'}],nodes:[n('p','group',{execution:'parallel',nodes:[n('m','group',{variables:[{name:'x',value:'2'}],nodes:[n('k','keyboard',{keys:'w',hold_ms:20})],edges:[]}),n('s','group',{variables:[{name:'x',value:'3'}],nodes:[n('k','keyboard',{keys:'a',hold_ms:60})],edges:[]})],edges:[]})],edges:[]})],edges:[]}
  const flat=flattenGraph(raw.nodes,raw.edges),compiled=lowerFlatGraph(flat.nodes,flat.edges)
  assert.ok(flat.nodes.every(n=>n.data.nodeType!=='group'))
  assert.equal(compiled.nodes[0].params.variables[0].value,'1')
  const fork=flat.nodes.find(n=>n.data.nodeType==='parallel')
  assert.deepEqual(plain(fork.data.params.branches.map(b=>b.variables[0].value)),['2','3'])
})
test('录制组直接转成键鼠分叉连线，预览保持绝对重叠时间',()=>{
  const raw=[n('r','group',{execution:'timeline',duration_ms:100,repeat:2,nodes:[n('a','keyboard',{keys:'w',hold_ms:40,timeline:{start_ms:0}}),n('b','keyboard',{keys:'a',hold_ms:70,timeline:{start_ms:20}})],edges:[]})]
  const flat=flattenGraph(raw,[]),plan=compileProjectTimeline(flat)
  assert.ok(flat.edges.some(e=>e.source==='r'&&e.sourceHandle==='side1'))
  assert.equal(plan.sections[0].spans.find(s=>s.key==='a').start,20)
  assert.equal(plan.sections[0].duration,100)
  assert.equal(flat.nodes.find(n=>n.id==='r').data.params.repeat,2)
})
test('动作换轴同时接回旧连线并接入新分支，删除后仍可汇合',()=>{
  const raw=base(),fork=raw.nodes.find(n=>n.id==='p');raw.edges=assignBranch(raw.nodes,raw.edges,fork,'b','main')
  assert.ok(raw.edges.some(e=>e.source==='p'&&e.sourceHandle==='side1'&&e.target==='j'))
  assert.ok(raw.edges.some(e=>e.source==='a'&&e.target==='b'))
  const removed=removeCanvasNodes(raw.nodes,raw.edges,new Set(['b']))
  assert.ok(removed.edges.some(e=>e.source==='a'&&e.target==='j'))
  const plan=compileProjectTimeline(removed);assert.equal(plan.sections[0].spans.find(s=>s.key==='z').start,20)
})
test('删除分叉会删除配对区域，保留区域之前与之后的连接',()=>{
  const raw=base();raw.nodes.unshift(n('before','delay',{ms:5}));raw.edges.push(e('before','p'))
  const removed=removeCanvasNodes(raw.nodes,raw.edges,new Set(['p']))
  assert.deepEqual(plain(removed.nodes.map(n=>n.id)),['before','out'])
  assert.ok(removed.edges.some(e=>e.source==='before'&&e.target==='out'))
})
test('视觉折叠与窗口布局不会改动执行图，保存剔除临时测量',()=>{
  const raw=base(),head=raw.nodes.find(n=>n.id==='p');head.data.foldMembers=['a','b','j']
  const view=foldedGraph(raw.nodes,raw.edges)
  assert.equal(view.nodes.length,2);assert.ok(view.edges.some(e=>e.source==='p'&&e.target==='out'))
  const saved=serializeFlowGraph(raw.nodes,raw.edges)
  assert.equal(saved.nodes.length,5);assert.equal(saved.edges.length,5)
  assert.equal(saved.nodes.find(n=>n.id==='p').data.foldCount,undefined)
})
test('载入旧输入设置统一去除，反复打开平面图不膨胀',()=>{
  const old={version:2,input_mode:'simulated',nodes:[n('m','mouse',{input_mode:'simulated',x:1,y:2})],edges:[]}
  const first=migrateScript(old).data,again=migrateScript(first).data
  assert.equal(first.input_mode,undefined);assert.equal(first.nodes[0].data.params.input_mode,undefined)
  assert.deepEqual(plain(first),plain(again))
})
test('复制完整并发区域后，分叉汇合引用与重复出口连线均独立重映射',()=>{
  const raw=base(),frag=extractFragment(raw.nodes,raw.edges,['p','j','a','b']);let seq=0
  const pasted=materializeFragment(frag,{x:10,y:20},()=>`copy${++seq}`)
  const fork=pasted.nodes.find(n=>n.data.nodeType==='parallel'),join=pasted.nodes.find(n=>n.data.nodeType==='join')
  assert.equal(fork.data.params.join_id,join.id);assert.equal(join.data.params.fork_id,fork.id)
  assert.equal(new Set(pasted.edges.map(e=>e.id)).size,pasted.edges.length)
  assert.equal(lowerFlatGraph(pasted.nodes,pasted.edges).nodes.length,1)
})
test('全局变量改名跳过同名平面局部声明，但更新未遮蔽的分支读取',()=>{
  const raw=base(),fork=raw.nodes.find(n=>n.id==='p')
  fork.data.params.branches[0].variables=[{name:'v',type:'string',value:'w'}]
  raw.nodes.find(n=>n.id==='a').data.params.keys='{{v}}'
  raw.nodes.find(n=>n.id==='b').data.params.keys='{{v}}'
  renameScopeVariable(raw.nodes,'v','renamed',true,true,false,raw.edges)
  assert.equal(raw.nodes.find(n=>n.id==='a').data.params.keys,'{{v}}')
  assert.equal(raw.nodes.find(n=>n.id==='b').data.params.keys,'{{renamed}}')
})
test('并行区域公共变量改名覆盖继承读取，并保留轴内同名声明',()=>{
  const raw=base(),fork=raw.nodes.find(n=>n.id==='p')
  fork.data.params.variables=[{name:'renamed',type:'string',value:'w'}]
  fork.data.params.branches[0].variables=[{name:'v',type:'string',value:'a'}]
  raw.nodes.find(n=>n.id==='a').data.params.keys='{{v}}'
  raw.nodes.find(n=>n.id==='b').data.params.keys='{{v}}'
  renameScopeVariable(raw.nodes,'v','renamed',false,true,false,raw.edges)
  assert.equal(raw.nodes.find(n=>n.id==='a').data.params.keys,'{{v}}')
  assert.equal(raw.nodes.find(n=>n.id==='b').data.params.keys,'{{renamed}}')
})
test('变量复制的源名称按可见作用域改名，全局目标保持显式写入语义',()=>{
  const raw=base(),fork=raw.nodes.find(n=>n.id==='p')
  fork.data.params.branches[0].variables=[{name:'v',type:'string',value:'a'}]
  for(const id of ['a','b']){const n=raw.nodes.find(n=>n.id===id);n.data.nodeType='variable';n.data.params={action:'get',name:'v',target:'v',scope:'global'}}
  renameScopeVariable(raw.nodes,'v','renamed',true,true,false,raw.edges)
  assert.equal(raw.nodes.find(n=>n.id==='a').data.params.name,'v')
  assert.equal(raw.nodes.find(n=>n.id==='b').data.params.name,'renamed')
  for(const id of ['a','b'])assert.equal(raw.nodes.find(n=>n.id===id).data.params.target,'renamed')
})
console.log(`平面流程 ${count} 项回归全部通过`)
