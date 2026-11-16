/** 浏览器回归：使用构建后的前端和假引擎，不连接真实后端或注入真实键鼠。 */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile, mkdtemp, writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {dirname,join,resolve,extname,sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const dist=join(repo,'frontend','dist')
const out=join(repo,'.tmp')
const server=createServer(async (req,res)=>{
  const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname)
  const path=resolve(dist,'.'+(['/', '/editor'].includes(requested)?'/index.html':requested))
  if(!path.startsWith(dist+sep)){res.writeHead(403);res.end();return}
  try {const data=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon'}[extname(path)]||'application/octet-stream')+'; charset=utf-8');res.end(data)}catch{res.writeHead(404);res.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const profile=await mkdtemp(join(tmpdir(),'autotool-timeline-ui-'))
const chrome=spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true})
let ws
const timeout=setTimeout(()=>{chrome.kill();server.close();process.exitCode=1;console.error('时间轴界面回归超时')},90000)
try {
  let port
  for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{await new Promise(r=>setTimeout(r,100))}}
  assert.ok(port,'Chrome 调试端口已就绪')
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
  let seq=0
  const pending=new Map(),errors=[]
  ws.addEventListener('message',event=>{
    const m=JSON.parse(event.data)
    if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))errors.push(m.params.args.map(a=>a.value||a.description||'').join(' ').slice(0,1800));
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
    if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}
  })
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  const pause=ms=>new Promise(r=>setTimeout(r,ms))
  const waitFor=async expression=>{for(let n=0;n<60;n++){if(await evaluate(expression))return;await pause(100)}throw new Error('等待界面条件超时：'+expression+'; '+JSON.stringify(errors)+'; body='+await evaluate('document.body.innerText.slice(0,2500)'))}
  await call('Page.enable');await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__traceCalls=0;
    window.__runPayload=null;
    window.WebSocket=class {constructor(){window.__engineSocket=this;queueMicrotask(()=>this.onopen?.())}close(){this.onclose?.({code:1000})}};
    navigator.sendBeacon=()=>true;
    const nativeFetch=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const url=String(input);
      if(!url.startsWith('http://127.0.0.1:8765/'))return nativeFetch(input,init);
      const path=new URL(url).pathname;
      let data={ok:true};
      if(path==='/health')data={version:'timeline-test',desktop:true};
      if(path==='/run/state')data={running:false,paused:false,repeat_state:window.__repeatState};
      if(path==='/flow/load')window.__loadedFlow=JSON.parse(init.body).flow;
      if(path==='/config/input'){if(init?.method==='POST')window.__backgroundClick=JSON.parse(init.body).background_click;data={background_click:!!window.__backgroundClick};}
      if(path==='/run')window.__runPayload=JSON.parse(init.body).flow;
      if(path==='/windows/list')data={windows:[]};
      if(path==='/vision/templates')data={templates:[]};
      if(path==='/config/hotkeys')data={bindings:[],defaults:[]};
      if(path==='/overlay/state')data={enabled:false,available:false,visible:false};
      if(path==='/run/timeline'){
        window.__traceCalls++;
        data=window.__timelineSnapshot || {run_id:'',project_id:'',name:'',running:false,elapsed_ms:0,last_seq:0,dropped:0,events:[]};
      }
      return Promise.resolve(new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}}));
    };
  `})
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`})
  await waitFor("!!document.querySelector('.dock-workspace')")

  const pauseUI=()=>pause(220)
  const active="[...document.querySelectorAll('.editor')].find(e=>e.offsetWidth)"
  await evaluate("window.activeEditor=()=>"+active)
  const load=async fixture=>{await evaluate(`(()=>{const input=activeEditor().querySelector('input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(fixture))}],'mode-test.agflow',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);await pause(400)}
  const save=async()=>{await evaluate("window.__saved=null;window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async text=>{window.__saved=JSON.parse(text)},close:async()=>{}})});[...activeEditor().querySelectorAll('.topbar button')].find(b=>b.textContent.trim()==='另存为').click()");await waitFor('!!window.__saved');return evaluate('window.__saved')}
  const clickNode=async id=>{await evaluate(`(()=>{const el=activeEditor().querySelector('.vue-flow__node[data-id="${id}"]'),r=el.getBoundingClientRect();for(const type of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,button:0,buttons:type==='mousedown'?1:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))})()`);await pauseUI()}
  const n=(id,type,params={})=>({id,type:'step',position:{x:100,y:80},data:{nodeType:type,label:type,params,once:false}})

  const panel=async id=>{await evaluate(`document.querySelector('[data-open-panel="${id}"]').click()`);await pauseUI()}
  const button=async (scope,text)=>{await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.offsetWidth&&b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Button not found: '+${JSON.stringify(text)});b.click()})()`);await pauseUI()}
  const nodeButton=async text=>{await evaluate(`(()=>{const b=[...activeEditor().querySelectorAll('.palette-item')].find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw new Error('Palette item not found');b.click()})()`);await pauseUI()}
  const input=async (selector,value)=>{await evaluate(`(()=>{const e=activeEditor().querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await pauseUI()}
  const setMode=async mode=>{await evaluate('document.querySelector(".bb-gear").click()');await waitFor("!!document.querySelector('.st-close')");await evaluate(`[...document.querySelectorAll('.n-radio-button')].find(b=>b.textContent==='${mode}模式').click();document.querySelector('.st-close').click()`);await pauseUI()}
  const edge=(s,t,h=null)=>({id:s+'-'+(h||'out')+'-'+t,source:s,target:t,sourceHandle:h})
  assert.ok(await evaluate("document.querySelector('.app-status').textContent==='AutoTool[专家模式]'"))
  assert.equal(await evaluate("document.querySelectorAll('.workspace-modes,.vars-toggle,.timeline-toggle').length"),0)
  console.log('ok  精简入口与状态栏模式')
  const legacy={format:'agflow',version:2,name:'旧工程',repeat:1,variables:[{name:'global_count',type:'number',value:'3'}],nodes:[{id:'f',type:'step',position:{x:30,y:60},data:{stepType:'find_image',params:{template:'sample',timeout_ms:2500,click:true,on_timeout:'skip'}}},n('next','keyboard',{keys:'enter',hold_ms:30}),n('g','group',{name:'局部区域',nodes:[n('inside','calculate',{expr:'1+1',save_var:'local_value'})],edges:[],variables:[{name:'local_value',type:'number',value:'8'}]})],edges:[edge('f','next')],scripts:{}}
  await load(legacy);let saved=await save()
  assert.ok(saved.nodes.every(n=>n.data.nodeType!=='group'))
  assert.equal(saved.nodes.find(n=>n.id==='g').data.params.variables[0].value,'8')
  const baseline=saved
  await clickNode('f');await panel('timeline');await panel('variables')
  assert.ok(await evaluate("!!activeEditor().querySelector('[data-panel=variables]').offsetWidth && !!activeEditor().querySelector('[data-panel=params]').offsetWidth"))
  const budgetBefore=await evaluate("(()=>{const s=activeEditor().querySelector('.timeline-span[data-node-id=f]');return {width:s?.offsetWidth,max:activeEditor().querySelector('[aria-label=移动时间游标]').getAttribute('aria-valuemax')}})()")
  await evaluate("activeEditor().querySelector('[aria-label=隐藏超时预算]').click()");await pauseUI()
  const budgetAfter=await evaluate("(()=>{const s=activeEditor().querySelector('.timeline-span[data-node-id=f]');return {width:s?.offsetWidth,max:activeEditor().querySelector('[aria-label=移动时间游标]').getAttribute('aria-valuemax')}})()")
  assert.ok(budgetBefore.width>8);assert.equal(budgetAfter.width,8);assert.equal(budgetBefore.max,budgetAfter.max)
  assert.equal((await save()).nodes.find(n=>n.id==='f').data.params.timeout_ms,2500)
  console.log('ok  隐藏超时预算只改变条带，不压缩公共时间刻度')
  await setMode('简易')
  assert.ok(await evaluate("document.querySelector('.app-status').textContent==='AutoTool[简易模式]'"))
  assert.equal(await evaluate("document.body.textContent.includes('在专家模式中编辑')||document.body.textContent.includes('v0.1.2')"),false)
  saved=await save();assert.deepEqual(saved.nodes,baseline.nodes);assert.deepEqual(saved.edges,baseline.edges)
  await panel('palette');assert.ok(await evaluate("[...activeEditor().querySelectorAll('.palette-item')].some(e=>e.textContent.includes('变量'))"))
  await nodeButton('变量');assert.equal((await save()).nodes.length,baseline.nodes.length)
  await panel('params');await clickNode('f')
  assert.ok(await evaluate("activeEditor().querySelector('.params-pane').textContent.includes('找到后点击')"))
  await evaluate("[...activeEditor().querySelectorAll('.params-pane .field')].find(f=>f.textContent.includes('找到后点击')).querySelector('.n-switch').click()");await pauseUI()
  assert.equal((await save()).nodes.filter(n=>n.data.nodeType==='mouse').length,0)
  console.log('ok  简易模式共享图、合并找图点击、无切换提醒')
  await setMode('专家')
  const flat={format:'agflow',version:6,name:'平面并发',repeat:1,variables:[],scripts:{},nodes:[n('p','parallel',{join_id:'j',branches:[{id:'main',name:'主轴',variables:[]},{id:'side1',name:'副轴 1',variables:[]}],primary_track:'main',duration_ms:0,repeat:1}),n('a','keyboard',{keys:'w',action:'press',hold_ms:20}),n('b','keyboard',{keys:'a',action:'press',hold_ms:80}),n('j','join',{fork_id:'p'}),n('out','keyboard',{keys:'z',hold_ms:1})],edges:[edge('p','a','main'),edge('p','b','side1'),edge('a','j'),edge('b','j'),edge('j','out')]}
  flat.nodes.forEach((v,i)=>v.position={x:[30,280,280,530,760][i],y:[100,50,200,100,100][i]})
  await load(flat);await panel('flow');await panel('timeline')
  await waitFor("!!activeEditor().querySelector('.timeline-span[data-node-id=b]')")
  assert.equal(await evaluate("activeEditor().querySelectorAll('.timeline-lane').length"),2)
  assert.ok(await evaluate("activeEditor().querySelector('.timeline-span[data-node-id=a]').closest('.timeline-lane')===activeEditor().querySelector('.timeline-span[data-node-id=out]').closest('.timeline-lane')"))
  const sideView=await evaluate("[...activeEditor().querySelector('[aria-label=切换主轴视角]').options].find(o=>o.textContent==='副轴 1').value")
  await input('[aria-label=切换主轴视角]',sideView)
  assert.equal((await save()).nodes.find(n=>n.id==='p').data.params.primary_track,'side1')
  assert.equal(await evaluate("activeEditor().querySelectorAll('.timeline-lane').length"),2)
  assert.ok(await evaluate("activeEditor().querySelector('.timeline-span[data-node-id=b]').closest('.timeline-lane')===activeEditor().querySelector('.timeline-span[data-node-id=out]').closest('.timeline-lane')"))
  const mainView=await evaluate("[...activeEditor().querySelector('[aria-label=切换主轴视角]').options].find(o=>o.textContent==='主轴').value")
  await input('[aria-label=切换主轴视角]',mainView)
  assert.equal((await save()).nodes.find(n=>n.id==='p').data.params.primary_track,'main')
  console.log('ok  切换主轴后公共后续仍接在主轴，副轴保持独立')
  await evaluate("activeEditor().querySelector('.timeline-span[data-node-id=b]').click()");await pauseUI()
  await input('[aria-label=动作持续时间]',140)
  saved=await save();assert.equal(saved.nodes.find(n=>n.id==='b').data.params.hold_ms,140)
  assert.equal(await evaluate("activeEditor().querySelector('[aria-label=移动时间游标]').getAttribute('aria-valuemax')"),'141')
  assert.equal(await evaluate("[...activeEditor().querySelectorAll('.input-timeline button')].some(e=>['新增副轴','按键','鼠标按住','移动','滚轮','刷新工程','计划预览','实际运行','编辑','删除动作'].includes(e.textContent.trim()))"),false)
  assert.equal(await evaluate("activeEditor().querySelectorAll('.timeline-search,[aria-label=筛选输入轨道]').length"),0)
  const countBeforeMove=saved.nodes.length
  await input('[aria-label=动作所属轴]','main');saved=await save()
  assert.equal(saved.nodes.length,countBeforeMove)
  assert.ok(saved.edges.some(e=>e.source==='b'&&e.target==='a'));assert.ok(saved.edges.some(e=>e.source==='p'&&e.sourceHandle==='side1'&&e.target==='j'))
  await input('[aria-label=动作所属轴]','side1');saved=await save()
  assert.ok(saved.edges.some(e=>e.source==='p'&&e.sourceHandle==='side1'&&e.target==='b'))
  console.log('ok  时间轴仅编辑已有节点，跨轴移动同步连线且不新增节点')
  await input('[aria-label=预览倍速]',.1)
  await button('.timeline-controls','播放预览');await pause(40);await button('.timeline-controls','暂停预览')
  const slow=await evaluate("Number(activeEditor().querySelector('[aria-label=移动时间游标]').getAttribute('aria-valuenow'))")
  assert.ok(slow>=0&&slow<=141)
  await input('[aria-label=时间轴缩放]',400)
  assert.ok(await evaluate("(()=>{const a=activeEditor().querySelector('.timeline-ruler-plot').getBoundingClientRect(),b=activeEditor().querySelector('.timeline-scrubber').getBoundingClientRect();return Math.abs(a.width-b.width)<1&&Math.abs(a.left-b.left)<1})()"))
  await input('[aria-label=时间轴缩放]',100)
  console.log('ok  预览倍速可设置，进度条与时间绘图区缩放长度和横向位置一致')
  await panel('flow');await panel('palette')
  const edgeId=saved.edges.find(e=>e.source==='a'&&e.target==='j').id
  await evaluate(`(()=>{const e=[...activeEditor().querySelectorAll('.vue-flow__edge')].find(e=>e.dataset.id===${JSON.stringify(edgeId)});e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:300}))})()`)
  await waitFor("[...document.querySelectorAll('.ctx-item')].some(e=>e.textContent==='在线上插入节点')")
  await button('.ctx-menu','在线上插入节点')
  await evaluate("[...activeEditor().querySelectorAll('.cat-tab')].find(e=>e.textContent.includes('流程')).click()");await pauseUI();await nodeButton('延时')
  saved=await save();const delay=saved.nodes.find(n=>n.data.nodeType==='delay');assert.ok(delay);assert.ok(saved.edges.some(e=>e.source==='a'&&e.target===delay.id));assert.ok(saved.edges.some(e=>e.source===delay.id&&e.target==='j'))
  console.log('ok  在线上插入动作保留前后依赖')
  const recorded={format:'agflow',version:6,name:'录制拆分',nodes:[n('r','record',{speed:1,repeat:2,events:[{type:'keydown',key:'w',t:0},{type:'keydown',key:'a',t:50},{type:'mousedown',button:'left',x:1,y:2,t:80},{type:'keyup',key:'w',t:200},{type:'keyup',key:'a',t:250},{type:'mouseup',button:'left',x:1,y:2,t:300}]})],edges:[],variables:[],scripts:{}}
  const tabsBefore=await evaluate('activeEditor().querySelectorAll(".tab").length');await load(recorded);await button('.settings-bar','拆分节点')
  saved=await save();assert.ok(saved.nodes.some(n=>n.data.nodeType==='parallel'));assert.ok(saved.nodes.every(n=>n.data.nodeType!=='group'));assert.equal(saved.nodes.find(n=>n.data.nodeType==='parallel').data.params.repeat,2)
  assert.equal(await evaluate('activeEditor().querySelectorAll(".tab").length'),tabsBefore+1)
  console.log('ok  录制拆分直接生成同画布分叉、键鼠动作及汇合，无片段子标签')
  const actions=saved.nodes.filter(n=>['keyboard','mouse'].includes(n.data.nodeType))
  assert.equal(new Set(actions.map(n=>n.position.y)).size,3)
  const originalCount=saved.nodes.length
  await clickNode('r');await button('.settings-bar','合并卡片')
  saved=await save();assert.equal(saved.nodes.length,originalCount);assert.ok(saved.nodes.find(n=>n.id==='r').data.foldMembers.length>=4)
  assert.equal(await evaluate("activeEditor().querySelectorAll('.vue-flow__node').length"),1)
  assert.equal(await evaluate("activeEditor().querySelectorAll('.timeline-span').length"),3)
  const recordedSearchId=actions.find(n=>n.data.params.keys==='a').id
  await evaluate(`(()=>{const i=activeEditor().querySelector('[aria-label=全局搜索]');i.focus();i.value=${JSON.stringify(recordedSearchId)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await waitFor("!!activeEditor().querySelector('.search-results button')")
  await evaluate("activeEditor().querySelector('.search-results button').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))")
  await pauseUI()
  assert.ok(await evaluate(`activeEditor().querySelector('.vue-flow__node[data-id="${recordedSearchId}"]').classList.contains('selected')`))
  assert.ok(await evaluate(`activeEditor().querySelector('.timeline-span[data-node-id="${recordedSearchId}"]').classList.contains('selected')`))
  assert.ok(await evaluate("activeEditor().querySelectorAll('.vue-flow__node').length>1"))
  console.log('ok  拆分画布按执行轴分行，合并卡片保留内部时间轴，全局搜索可展开并同时选中')

  // Headless Chromium CDP events only: they never touch the physical mouse.
  await panel('params');const graphBeforeLayout=await save()
  const box=async selector=>evaluate(`(()=>{const r=activeEditor().querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`)
  const move=async (x,y,type='mouseMoved',button='none')=>{await call('Input.dispatchMouseEvent',{type,x,y,button,buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});await pause(80)}
  let r=await box('[data-panel-tab=params]');await move(r.x+r.w/2,r.y+r.h/2,'mousePressed','left');await move(600,220);await move(600,220,'mouseReleased','left');await pauseUI()
  assert.ok(await evaluate("!!activeEditor().querySelector('.dock-float [data-panel=params]')"))
  let corner=await box('.dock-float .dock-corner'),before=await box('.dock-float');await move(corner.x+5,corner.y+5,'mousePressed','left');await move(corner.x+105,corner.y+55);await move(corner.x+105,corner.y+55,'mouseReleased','left');await pauseUI();let after=await box('.dock-float');assert.ok(after.w>before.w+50)
  r=await box('.dock-float [data-panel-tab=params]');await move(r.x+35,r.y+15,'mousePressed','left');await move(r.x+50,r.y+25);await pauseUI();const zone=await box('[data-dock-zone=center]');await move(zone.x+zone.w/2,zone.y+zone.h/2);await move(zone.x+zone.w/2,zone.y+zone.h/2,'mouseReleased','left');await pauseUI()
  assert.ok(await evaluate("!!activeEditor().querySelector('.dock-center [data-panel=params]')"))
  assert.deepEqual((await save()).nodes,graphBeforeLayout.nodes)
  assert.deepEqual((await save()).edges,graphBeforeLayout.edges)
  console.log('ok  面板拖出、缩放、合并标签及独立布局持久化')
  const reloaded=new Promise(resolve=>{const listener=e=>{if(JSON.parse(e.data).method==='Page.loadEventFired'){ws.removeEventListener('message',listener);resolve()}};ws.addEventListener('message',listener)})
  await call('Page.reload');await reloaded;await waitFor("!!document.querySelector('.dock-workspace')")
  await evaluate("window.activeEditor=()=>"+active)
  assert.ok(await evaluate("!!activeEditor().querySelector('.dock-center [data-panel=params]')"))
  console.log('ok  重载后恢复面板停靠与活动标签')
  await evaluate("document.querySelector('.window-items button:last-child').click()");await pauseUI()
  assert.ok(await evaluate("!!activeEditor().querySelector('.dock-right [data-panel=params]')"))
  const scopeFixture=structuredClone(flat)
  scopeFixture.nodes.find(n=>n.id==='p').data.params.variables=[{name:'common_value',type:'string',value:'w'}]
  scopeFixture.nodes.find(n=>n.id==='p').data.params.branches[0].variables=[{name:'common_value',type:'string',value:'a'}]
  for(const id of ['a','b'])scopeFixture.nodes.find(n=>n.id===id).data.params.keys='{{common_value}}'
  await load(scopeFixture);await panel('variables')
  await evaluate("activeEditor().querySelector('.variable-scope .n-base-selection').click()")
  await waitFor("[...document.querySelectorAll('.n-base-select-option')].some(e=>e.textContent.includes('并行区域 · p'))")
  await evaluate("[...document.querySelectorAll('.n-base-select-option')].find(e=>e.textContent.includes('并行区域 · p')).click()")
  await pauseUI()
  await evaluate("(()=>{const e=activeEditor().querySelector('.vars-pane .custom .var-row input');if(e.value!=='common_value')throw new Error('作用域变量不匹配');e.value='shared_value';e.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await pauseUI();saved=await save()
  assert.equal(saved.nodes.find(n=>n.id==='p').data.params.variables[0].name,'shared_value')
  assert.equal(saved.nodes.find(n=>n.id==='a').data.params.keys,'{{common_value}}')
  assert.equal(saved.nodes.find(n=>n.id==='b').data.params.keys,'{{shared_value}}')
  assert.equal(saved.nodes.find(n=>n.id==='p').data.params.branches[0].variables[0].name,'common_value')
  console.log('ok  作用域管理器改名同步引用，保留并发轴同名局部变量')
  await panel('palette');await panel('flow');await panel('timeline')
  await pause(1400)
  const runtimeFixture=structuredClone(flat);runtimeFixture.name='运行比对'
  runtimeFixture.nodes.find(n=>n.id==='a').data.params.hold_ms=2000
  runtimeFixture.nodes.find(n=>n.id==='b').data.params.hold_ms=1200
  runtimeFixture.scripts={sub:{id:'sub',name:'未调用子脚本',variables:[],nodes:[n('search_sub','keyboard',{keys:'q',hold_ms:10})],edges:[]}}
  await load(runtimeFixture);await panel('timeline')
  await input('[aria-label=预览倍速]',.5);await button('.timeline-controls','播放预览');await pause(180);await button('.timeline-controls','暂停预览')
  const cursorValue=()=>evaluate("Number(activeEditor().querySelector('[aria-label=移动时间游标]').getAttribute('aria-valuenow'))")
  const slowAdvance=await cursorValue()
  await evaluate("activeEditor().querySelector('[aria-label=移动时间游标]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))")
  await input('[aria-label=预览倍速]',2);await button('.timeline-controls','播放预览');await pause(180);await button('.timeline-controls','暂停预览')
  const fastAdvance=await cursorValue();assert.ok(fastAdvance>slowAdvance*2.5)
  const event=(kind,time,node,call,extra={})=>({kind,time_ms:time,active_ms:time,node_id:node,call_id:call,script_id:'',group_path:[],round:1,...extra})
  const runtimeEvents=[event('round_start',0,'',''),event('node_start',0,'a','1',{device:'key',key:'w',expected_key:'w',expected_start_ms:0,expected_duration_ms:2000,timing_kind:'fixed',axis_id:'main'}),event('node_start',0,'b','2',{device:'key',key:'a',expected_key:'a',expected_start_ms:0,expected_duration_ms:1200,timing_kind:'fixed',axis_id:'side1'}),event('node_end',1400,'b','2',{status:'finished'}),event('node_end',2000,'a','1',{status:'finished'}),event('round_end',2001,'','')].map((e,i)=>({...e,seq:i+1}))
  await evaluate(`window.__timelineSnapshot=${JSON.stringify({run_id:'ui-031-run',project_id:'',name:'运行比对',running:false,elapsed_ms:2001,active_elapsed_ms:2001,last_seq:runtimeEvents.length,dropped:0,events:runtimeEvents})}`)
  await waitFor("!!activeEditor().querySelector('.timeline-span[data-node-id=a].run-good')&&!!activeEditor().querySelector('.timeline-span[data-node-id=b].run-bad')")
  await evaluate("document.querySelector('.bb-gear').click()");await waitFor("!!document.querySelector('[aria-label=运行时间容差]')")
  await evaluate("(()=>{const i=document.querySelector('[aria-label=运行时间容差]');i.value='300';i.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await evaluate("document.querySelector('.st-close').click()")
  await waitFor("!!activeEditor().querySelector('.timeline-span[data-node-id=b].run-good')")
  await evaluate("document.querySelector('.bb-gear').click()");await waitFor("!!document.querySelector('[aria-label=运行时间容差]')")
  await evaluate("(()=>{const i=document.querySelector('[aria-label=运行时间容差]');i.value='50';i.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await evaluate("document.querySelector('.st-close').click()")
  await evaluate("(()=>{const i=activeEditor().querySelector('[aria-label=全局搜索]');i.focus();i.value='search_sub';i.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await waitFor("!!activeEditor().querySelector('.search-results button')")
  await evaluate("activeEditor().querySelector('.search-results button').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))")
  await waitFor("!!activeEditor().querySelector('.vue-flow__node[data-id=search_sub].selected')&&!!activeEditor().querySelector('.timeline-span[data-node-id=search_sub].selected')")
  await evaluate("[...activeEditor().querySelectorAll('.tab')].find(t=>t.querySelector('.tab-name')?.textContent==='运行比对').click()")
  await pauseUI();await clickNode('b');await panel('timeline')
  console.log('ok  慢速快速播放比例、设置容差即时生效、红绿比对及跨子脚本搜索联动')
  {
  await evaluate("document.querySelector('.bb-gear').click()");await waitFor("!!document.querySelector('[aria-label=后台点击]')")
  await evaluate("document.querySelector('[aria-label=后台点击]').click()")
  await waitFor('window.__backgroundClick===true')
  await evaluate("document.querySelector('.st-close').click()")
  await waitFor('!!window.__loadedFlow?.client_doc_id')
  await evaluate("window.__repeatState={doc_id:window.__loadedFlow.client_doc_id,value:7,revision:1000};window.__engineSocket.onmessage({data:JSON.stringify({type:'repeat',...window.__repeatState})})")
  await waitFor("activeEditor().querySelector('.topbar .n-input-number input').value==='7'")
  assert.equal((await save()).repeat,7)
  await evaluate("(()=>{const i=activeEditor().querySelector('[aria-label=全局搜索]');i.value='search_sub';i.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await waitFor("!!activeEditor().querySelector('.search-results button')")
  await evaluate("activeEditor().querySelector('.search-results button').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))")
  await waitFor("!!activeEditor().querySelector('.vue-flow__node[data-id=search_sub]')")
  assert.equal(await evaluate("activeEditor().querySelector('.topbar .n-input-number input').value"),'7')
  await evaluate("[...activeEditor().querySelectorAll('.tab')].find(t=>t.querySelector('.tab-name')?.textContent==='运行比对').click()")
  await waitFor("activeEditor().querySelector('.topbar .n-input-number input').value==='7'")
  await evaluate("window.__repeatState={...window.__repeatState,value:9,revision:1001}")
  await waitFor("activeEditor().querySelector('.topbar .n-input-number input').value==='9'")
  assert.equal((await save()).repeat,9)
  await evaluate("window.__repeatState=undefined")
  const recorded={format:'agflow',version:6,name:'统一录制',repeat:1,nodes:[n('rec','record',{events:[{t:0,type:'keydown',key:'w'},{t:100,type:'mousedown',button:'left',x:30,y:40},{t:150,type:'mouseup',button:'left',x:30,y:40},{t:1000,type:'keyup',key:'w'}],speed:1,repeat:1})],edges:[],scripts:{},variables:[]}
  await load(recorded);await button('.settings-bar','拆分节点')
  saved=await save();assert.ok(saved.nodes.some(n=>n.data.nodeType==='parallel'&&n.data.params.timing==='unified'));assert.ok(saved.nodes.every(n=>!['record','group'].includes(n.data.nodeType)))
  assert.equal(await evaluate("activeEditor().querySelector('[aria-label=录制拆分方式]')===null"),true)
  await panel('flow');await pause(300)
  const clickWire=async()=>{await evaluate("(()=>{const path=activeEditor().querySelector('.vue-flow__edge-interaction');if(!path)throw new Error('Wire missing');const r=path.getBoundingClientRect();for(const type of ['mousedown','mouseup','click'])path.dispatchEvent(new MouseEvent(type,{bubbles:true,view:window,button:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))})()");await pauseUI()}
  await clickWire();await waitFor("!!activeEditor().querySelector('.wire-label button[aria-label=在线上插入节点]')")
  await evaluate("activeEditor().querySelector('.wire-label button[aria-label=在线上插入节点]').click()")
  await waitFor("!!activeEditor().querySelector('.insert-hint')");const beforeInsert=saved.nodes.length;await evaluate("[...activeEditor().querySelectorAll('.cat-tab')].find(e=>e.textContent.includes('流程')).click()");await pauseUI();await nodeButton('延时');saved=await save();assert.equal(saved.nodes.length,beforeInsert+1)
  await clickWire();await waitFor("!!activeEditor().querySelector('.wire-label button[aria-label=删除连接]')")
  const beforeDelete=saved.edges.length;await evaluate("activeEditor().querySelector('.wire-label button[aria-label=删除连接]').click()");saved=await save();assert.equal(saved.edges.length,beforeDelete-1)
  const budget={...flat,name:'预算跳过',repeat:1,nodes:flat.nodes.filter(v=>v.id!=='out').map(v=>v.id==='a'?n('a','find_image',{timeout_ms:120000}):v.id==='b'?n('b','keyboard',{keys:'w',hold_ms:1000}):v),edges:flat.edges.filter(e=>e.source!=='j')}
  await load(budget);await panel('timeline');await waitFor("!!activeEditor().querySelector('[aria-label=隐藏超时预算]')")
  await evaluate("(()=>{const c=activeEditor().querySelector('[aria-label=隐藏超时预算]');if(!c.checked)c.click();const speed=activeEditor().querySelector('[aria-label=预览倍速]');speed.value='16';speed.dispatchEvent(new Event('input',{bubbles:true}));[...activeEditor().querySelectorAll('.input-timeline button')].find(b=>b.textContent.trim()==='播放预览').click()})()")
  await waitFor("Number(activeEditor().querySelector('[aria-label=移动时间游标]').getAttribute('aria-valuenow'))>=120000")
  console.log('ok  后台点击设置、悬浮框轮数推送及补齐、统一拆分、线上插入删除、纯预算播放跳过')
  }
  assert.equal(errors.length,0,errors.join('\n'))
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'workspace-ui-032.png'),Buffer.from(screenshot.data,'base64'))
  console.log('工作区与平面流程界面回归全部通过')
} catch(error){
  if(ws?.readyState===1){const id=999991;const result=await new Promise(resolve=>{const listener=e=>{const m=JSON.parse(e.data);if(m.id===id){ws.removeEventListener('message',listener);resolve(m.result)}};ws.addEventListener('message',listener);ws.send(JSON.stringify({id,method:'Page.captureScreenshot',params:{format:'png'}}))});if(result?.data)await writeFile(join(out,'workspace-ui-failure.png'),Buffer.from(result.data,'base64'))}
  throw error
} finally {clearTimeout(timeout);if(ws?.readyState===1)ws.close();chrome.kill();server.close()}
