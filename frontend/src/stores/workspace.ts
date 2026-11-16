import {defineStore} from 'pinia'
import {reactive,ref} from 'vue'
export const PANEL_TITLES:Record<string,string>={palette:'节点库',flow:'流程图',timeline:'时间轴',params:'参数',variables:'变量',logs:'日志'}
export type Area='left'|'center'|'right'|'bottom'|'float'
export interface PanelState {id:string;area:Area;open:boolean;x:number;y:number;width:number;height:number}
const defaults=():PanelState[]=>Object.keys(PANEL_TITLES).map((id,i)=>({id,area:({palette:'left',flow:'center',timeline:'bottom',params:'right',variables:'left',logs:'bottom'} as any)[id],open:['palette','flow','params'].includes(id),x:80+i*25,y:50+i*20,width:640,height:360}))
export const useWorkspaceStore=defineStore('workspace',()=>{
  let saved:any;try{saved=JSON.parse(localStorage.getItem('at.workspace.v2') || 'null')}catch{}
  const finite=(v:unknown,fallback:number,min:number,max:number)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):fallback
  const panels=reactive<PanelState[]>(defaults().map(p=>{const v=Array.isArray(saved?.panels)?saved.panels.find((v:any)=>v?.id===p.id):null;return {...p,...(v?{area:['left','center','right','bottom','float'].includes(v.area)?v.area:p.area,open:typeof v.open==='boolean'?v.open:p.open,x:finite(v.x,p.x,0,10000),y:finite(v.y,p.y,0,10000),width:finite(v.width,p.width,260,4096),height:finite(v.height,p.height,160,2160)}:{})}}))
  const sizes=reactive({left:finite(saved?.sizes?.left,230,170,700),right:finite(saved?.sizes?.right,300,230,800),bottom:finite(saved?.sizes?.bottom,360,160,900)})
  const active=reactive<Record<string,string>>({...saved?.active})
  const maximized=ref('')
  const hideBudgets=ref(!!saved?.hideBudgets)
  function persist(){try{localStorage.setItem('at.workspace.v2',JSON.stringify({panels,sizes,active,hideBudgets:hideBudgets.value}))}catch{}}
  function open(id:string){const p=panels.find(p=>p.id===id);if(!p)return;p.open=true;active[p.area]=id;persist()}
  function close(id:string){const p=panels.find(p=>p.id===id);if(p)p.open=false;if(maximized.value===id)maximized.value='';persist()}
  function reset(){panels.splice(0,panels.length,...defaults());Object.assign(sizes,{left:230,right:300,bottom:360});for(const k of Object.keys(active))delete active[k];maximized.value='';persist()}
  return {panels,sizes,active,maximized,hideBudgets,persist,open,close,reset}
})
