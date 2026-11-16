/** 简易画布、旧版迁移、坐标自动绑定的纯语义回归，不接触真实输入。 */
import assert from 'node:assert/strict'
import {loadFrontend} from './load_frontend_module.mjs'
const {simpleProjection,createSimpleImage,connectSimple,updateSimpleImage}=loadFrontend('simpleFlow')
const {migrateFlow}=loadFrontend('migrateFlow')
const {extractFragment,materializeFragment}=loadFrontend('clipFragment')
const {autoBindConnection,outputName}=loadFrontend('variableBinding')
const {serializeFlowGraph}=loadFrontend('serializeFlow')
const plain=value=>JSON.parse(JSON.stringify(value))
const n=(id,type,params={})=>({id,type:'step',position:{x:40,y:40},data:{nodeType:type,params,once:false}})
let checks=0
const test=(name,fn)=>{fn();checks++;console.log('ok  '+name)}

test('保存递归剔除画布临时状态，保留完整节点参数与独立布局',()=>{
  const card=createSimpleImage('f',{x:1,y:2}), head=card.nodes[0]
  const group=n('g','group',{nodes:[{...head,selected:true,dimensions:{width:150},data:{...head.data,simpleView:{kind:'image'},simplePosition:{x:5,y:6}}}],edges:[]})
  const clean=serializeFlowGraph([{...group,selected:true,handleBounds:{}}],[])
  const saved=clean.nodes[0].data.params.nodes[0]
  assert.equal('selected' in clean.nodes[0],false);assert.equal('dimensions' in saved,false);assert.equal('simpleView' in saved.data,false)
  assert.deepEqual(plain(saved.data.simplePosition),{x:5,y:6});assert.equal(saved.data.params.save_point,head.data.params.save_point)
})
test('找图点击卡片只改变投影，完整流程和输出保持可逆',()=>{
  const card=createSimpleImage('n1',{x:1,y:2}),before=JSON.stringify(card)
  const p=simpleProjection(card.nodes,card.edges)
  assert.equal(p.nodes.length,1);assert.equal(p.recipes.get('n1').kind,'image');assert.equal(JSON.stringify(card),before)
  assert.ok(card.nodes[2].data.params.point_var.endsWith('_point'))
})
test('旧版找到点击和超时跳过均到原后继，保存后反复加载不膨胀',()=>{
  for(const click of [false,true]) for(const on_timeout of ['skip','exit']) {
    const old={nodes:[{id:'f',type:'step',data:{stepType:'find_image',params:{template:'t',click,on_timeout}}},n('next','delay',{ms:1})],edges:[{id:'out',source:'f',target:'next',sourceHandle:''}]}
    const first=migrateFlow(old.nodes,old.edges,true),before=JSON.stringify(first)
    const second=migrateFlow(first.nodes,first.edges,false)
    assert.equal(second.nodes.length,first.nodes.length);assert.equal(second.edges.length,first.edges.length);assert.equal(JSON.stringify(first),before)
    const p=simpleProjection(first.nodes,first.edges),r=p.recipes.get('f')
    assert.ok(r,JSON.stringify(first));assert.equal(!!r.clickId,click);assert.equal(!!r.stopId,on_timeout==='exit')
    if(on_timeout==='skip') assert.ok(first.edges.some(e=>e.source===r.judgeId&&e.sourceHandle==='no'&&e.target==='next'))
  }
})
test('简易连线同时连接成功/跳过通路，删除显示连线可找全原始边',()=>{
  const card=createSimpleImage('n1',{x:0,y:0});card.nodes.push(n('next','delay'))
  card.edges=connectSimple(card.nodes,card.edges,{source:'n1',target:'next'})
  const p=simpleProjection(card.nodes,card.edges)
  assert.equal(p.edges.length,1);assert.equal(p.edges[0].originalIds.length,2)
  assert.throws(()=>connectSimple(card.nodes,card.edges,{source:'n1',target:'next'}))
})
test('点击、超时与单次开关的往返修改保持后继连线和内部一致',()=>{
  let card=createSimpleImage('n1',{x:0,y:0});card.nodes.push(n('next','delay'))
  card.edges=connectSimple(card.nodes,card.edges,{source:'n1',target:'next'})
  for(const change of [{autoClick:false},{onTimeout:'exit'},{autoClick:true},{onTimeout:'skip'},{once:true},{once:false}]) {
    card=updateSimpleImage(card.nodes,card.edges,'n1',change)
    const p=simpleProjection(card.nodes,card.edges),r=p.recipes.get('n1')
    assert.ok(r,JSON.stringify(change));assert.ok(p.edges.some(e=>e.source==='n1'&&e.target==='next'))
  }
})
test('独立找图判断卡片保留是/否端口与两条分支',()=>{
  const card=createSimpleImage('f',{x:0,y:0},'image_judge');card.nodes.push(n('a','delay'),n('b','delay'))
  card.edges=connectSimple(card.nodes,card.edges,{source:'f',target:'a',sourceHandle:'yes'})
  card.edges=connectSimple(card.nodes,card.edges,{source:'f',target:'b',sourceHandle:'no'})
  const p=simpleProjection(card.nodes,card.edges)
  assert.deepEqual(plain(p.edges.map(e=>e.sourceHandle).sort()),['no','yes']);assert.equal(p.nodes.length,3)
})
test('外部进入内部节点、单次标记不一致、复杂条件均不折叠丢失行为',()=>{
  for(const variation of ['entry','once','condition']) {
    const card=createSimpleImage('f',{x:0,y:0})
    if(variation==='entry'){card.nodes.push(n('outside','delay'));card.edges.push({source:'outside',target:card.nodes[2].id})}
    if(variation==='once')card.nodes[2].data.once=true
    if(variation==='condition')card.nodes[1].data.params.condition2={left:'x',op:'>',right:5}
    assert.equal(simpleProjection(card.nodes,card.edges).recipes.size,0)
  }
})
test('复制复合卡片独立重命名内部输出及引用，原卡片不受影响',()=>{
  const card=createSimpleImage('n1',{x:0,y:0}),fragment=extractFragment(card.nodes,card.edges,card.nodes.map(n=>n.id))
  let id=20;const pasted=materializeFragment(fragment,{x:10,y:10},()=>`n${++id}`)
  const p=simpleProjection(pasted.nodes,pasted.edges),head=pasted.nodes[0],click=pasted.nodes[2]
  assert.equal(p.recipes.size,1);assert.notEqual(head.data.params.save_point,card.nodes[0].data.params.save_point)
  assert.equal(click.data.params.point_var,head.data.params.save_point)
})
test('坐标自动连接只填空输入，已有手动位置与多输入来源不覆盖',()=>{
  const nodes=[n('f','find_image'),n('m','mouse',{x:0,y:0}),n('m2','mouse',{x:50,y:60})],vars=[]
  assert.equal(autoBindConnection(nodes,[{source:'f',target:'m'}],vars,'f','m'),'image_f_point')
  assert.equal(nodes[1].data.params.point_var,'image_f_point');assert.equal(vars[0].type,'point')
  assert.equal(autoBindConnection(nodes,[],vars,'f','m2'),'')
  assert.equal(outputName(nodes[0],{param:'save_point'},['image_f_point']),'image_f_point_2')
})
console.log(`简易模式 ${checks} 项语义回归全部通过`)
