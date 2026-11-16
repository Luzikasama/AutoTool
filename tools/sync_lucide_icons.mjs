/** 将同一套 Lucide 图标生成应用、网页与 Tk 悬浮框资源。只在构建时运行。 */
import {readFile,writeFile,mkdir,mkdtemp,copyFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import vm from 'node:vm'
const root=resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))
const icons=['workflow','play','pause','square','circle-dot','x','panel-top','plus','minus']
const out=join(root,'assets/lucide');await mkdir(out,{recursive:true})
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;')
const glyphs={}
for(const name of icons){
  const source=await readFile(join(root,'frontend/node_modules/@lucide/vue/dist/esm/icons',name+'.mjs'),'utf8')
  const data=vm.runInNewContext('('+source.match(/const __iconData = ([\s\S]*?);\n/)[1]+')')
  const node=data.node.map(([tag,attrs])=>'<'+tag+' '+Object.entries(attrs).filter(([key])=>key!=='key').map(([k,v])=>`${k}="${escape(v)}"`).join(' ')+' />').join('')
  glyphs[name]=node
  await writeFile(join(out,name+'.svg'),`<!-- Lucide 1.73.0, ISC license; lucide.dev -->\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${node}</svg>`)
}
await copyFile(join(root,'frontend/node_modules/@lucide/vue/LICENSE'),join(out,'LICENSE'))
const app=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#152544"/><stop offset="1" stop-color="#070f20"/></linearGradient><linearGradient id="fg" x2="1" y2="1"><stop stop-color="#72f0dd"/><stop offset="1" stop-color="#6594ff"/></linearGradient></defs><rect width="512" height="512" rx="114" fill="url(#bg)"/><rect x="8" y="8" width="496" height="496" rx="108" fill="none" stroke="#344a70" stroke-width="2"/><g transform="translate(64 64) scale(16)" fill="none" stroke="url(#fg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyphs.workflow}</g></svg>`
await writeFile(join(root,'assets/AutoTool.svg'),app)
const profile=await mkdtemp(join(tmpdir(),'autotool-icons-'))
const chrome=spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--disable-background-networking','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'})
let ws
try {
  let port
  for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{await new Promise(r=>setTimeout(r,100))}}
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl)
  await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})})
  let id=0;const pending=new Map()
  ws.addEventListener('message',e=>{const r=JSON.parse(e.data);if(pending.has(r.id)){pending.get(r.id)(r);pending.delete(r.id)}})
  const render=async(svg,size)=>{
    const expression=`(async()=>{const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(${JSON.stringify(svg)});await img.decode();const c=document.createElement('canvas');c.width=c.height=${size};c.getContext('2d').drawImage(img,0,0,${size},${size});return c.toDataURL('image/png').split(',')[1]})()`
    const next=++id,promise=new Promise(res=>pending.set(next,res));ws.send(JSON.stringify({id:next,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));const r=await promise
    if(r.error||r.result.exceptionDetails)throw new Error('SVG rendering failed')
    return Buffer.from(r.result.result.value,'base64')
  }
  for(const name of icons)await writeFile(join(out,name+'.png'),await render(await readFile(join(out,name+'.svg'),'utf8'),24))
  await writeFile(join(root,'assets/AutoTool.png'),await render(app,512))
  console.log('Lucide SVG and PNG resources generated')
} finally {ws?.close();chrome.kill()}
