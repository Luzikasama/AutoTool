<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue'
import AppIcon from './AppIcon.vue'
import {useWorkspaceStore,PANEL_TITLES,type Area,type PanelState} from '../stores/workspace'
const dock=useWorkspaceStore(),stage=ref<HTMLElement|null>(null),dragging=ref('')
let suppressClick=false
function activate(area:Area,id:string){if(suppressClick)return;dock.active[area]=id;dock.persist()}
const areas:Area[]=['left','center','right','bottom','float']
const openIn=(area:Area)=>dock.panels.filter(p=>p.area===area&&p.open)
const shown=(area:Area)=>openIn(area).find(p=>p.id===dock.active[area])?.id || openIn(area)[0]?.id
const style=computed(()=>({'--dock-left':openIn('left').length?dock.sizes.left+'px':'0px','--dock-right':openIn('right').length?dock.sizes.right+'px':'0px','--dock-bottom':openIn('bottom').length?dock.sizes.bottom+'px':'0px'}))
let cleanup:(()=>void)|undefined,observer:ResizeObserver|undefined
function clamp(p:PanelState){const r=stage.value?.getBoundingClientRect();if(!r||r.width<80||r.height<80)return;p.width=Math.max(260,Math.min(p.width,r.width));p.height=Math.max(160,Math.min(p.height,r.height));p.x=Math.max(0,Math.min(p.x,r.width-p.width));p.y=Math.max(0,Math.min(p.y,r.height-p.height))}
function begin(event:PointerEvent,p:PanelState,resize=false){
 if(event.button!==0)return
 event.preventDefault();cleanup?.()
 const rect=stage.value!.getBoundingClientRect(),bounds=(event.currentTarget as HTMLElement).closest('.dock-group')!.getBoundingClientRect()
 const sx=event.clientX,sy=event.clientY,origin={x:p.x,y:p.y,w:p.width,h:p.height}
 let started=resize
 const move=(e:PointerEvent)=>{if(!started){if(Math.hypot(e.clientX-sx,e.clientY-sy)<5)return;started=true;dock.maximized='';p.x=bounds.x-rect.x;p.y=bounds.y-rect.y;p.width=Math.min(bounds.width,800);p.height=Math.min(bounds.height,440);Object.assign(origin,{x:p.x,y:p.y});p.area='float';dragging.value=p.id;suppressClick=true}if(resize){p.width=origin.w+e.clientX-sx;p.height=origin.h+e.clientY-sy}else{p.x=origin.x+e.clientX-sx;p.y=origin.y+e.clientY-sy}clamp(p)}
 const stop=(e:PointerEvent)=>{if(started&&!resize){const el=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-dock-zone]');if(el){p.area=el.dataset.dockZone as Area;dock.active[p.area]=p.id}}cleanup?.();dock.persist();setTimeout(()=>{suppressClick=false},0)}
 cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);dragging.value='';cleanup=undefined}
 const cancel=()=>{cleanup?.();dock.persist();suppressClick=false}
 window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop,{once:true});window.addEventListener('pointercancel',cancel,{once:true});window.addEventListener('blur',cancel,{once:true})
}
function resizeArea(e:PointerEvent,area:Area){e.preventDefault();cleanup?.();const sx=e.clientX,sy=e.clientY,initial={...dock.sizes};const move=(ev:PointerEvent)=>{const r=stage.value!.getBoundingClientRect();if(area==='left')dock.sizes.left=Math.max(170,Math.min(r.width*.4,initial.left+ev.clientX-sx));if(area==='right')dock.sizes.right=Math.max(230,Math.min(r.width*.45,initial.right-ev.clientX+sx));if(area==='bottom')dock.sizes.bottom=Math.max(160,Math.min(r.height*.7,initial.bottom-ev.clientY+sy))};const stop=()=>{cleanup?.();dock.persist()};cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('blur',stop);cleanup=undefined};window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop,{once:true});window.addEventListener('blur',stop,{once:true})}
onMounted(()=>{observer=new ResizeObserver(()=>dock.panels.filter(p=>p.area==='float').forEach(clamp));observer.observe(stage.value!);dock.panels.filter(p=>p.area==='float').forEach(clamp)})
onBeforeUnmount(()=>{cleanup?.();observer?.disconnect()})
</script>
<template>
 <div ref="stage" class="dock-workspace" :style="style">
  <template v-for="area in areas" :key="area">
   <div v-if="area!=='float'" v-show="openIn(area).length" class="dock-group" :class="['dock-'+area,{'is-maximized':dock.maximized&&openIn(area).some(p=>p.id===dock.maximized)}]">
    <div class="dock-titlebar"><div class="dock-tabs"><button v-for="p in openIn(area)" :key="p.id" class="dock-tab" :class="{active:shown(area)===p.id}" :data-panel-tab="p.id" @pointerdown="begin($event,p)" @click="activate(area,p.id)">{{PANEL_TITLES[p.id]}}</button></div><button class="dock-action" aria-label="最大化面板" @click="dock.maximized=dock.maximized?'':shown(area)||''"><AppIcon name="maximize" :size="14"/></button><button class="dock-action" aria-label="关闭面板" @click="dock.close(shown(area)||'')"><AppIcon name="x" :size="14"/></button></div>
    <div v-for="p in dock.panels.filter(p=>p.area===area)" v-show="p.open&&(dock.maximized?dock.maximized===p.id:shown(area)===p.id)" :key="p.id" class="dock-body" :data-panel="p.id"><slot :name="p.id"/></div>
    <div v-if="['left','right','bottom'].includes(area)" class="dock-edge" :class="area" @pointerdown="resizeArea($event,area)"/>
   </div>
   <template v-else><div v-for="p in dock.panels.filter(p=>p.area==='float')" v-show="p.open" :key="p.id" class="dock-group dock-float" :class="{'is-maximized':dock.maximized===p.id}" :style="{left:p.x+'px',top:p.y+'px',width:p.width+'px',height:p.height+'px'}">
    <div class="dock-titlebar" @pointerdown.self="begin($event,p)"><button class="dock-tab active" :data-panel-tab="p.id" @pointerdown="begin($event,p)">{{PANEL_TITLES[p.id]}}</button><div class="dock-title-space" @pointerdown="begin($event,p)"/><button class="dock-action" aria-label="最大化面板" @click="dock.maximized=dock.maximized?'':p.id"><AppIcon name="maximize" :size="14"/></button><button class="dock-action" aria-label="关闭面板" @click="dock.close(p.id)"><AppIcon name="x" :size="14"/></button></div>
    <div class="dock-body" :data-panel="p.id"><slot :name="p.id"/></div><div class="dock-corner" aria-label="调整面板大小" @pointerdown="begin($event,p,true)"/>
   </div></template>
  </template>
  <div v-if="!dock.panels.some(p=>p.open)" class="dock-empty">从“窗口”菜单打开面板</div>
  <div v-if="dragging" class="dock-targets"><div v-for="zone in ['left','center','right','bottom']" :key="zone" :data-dock-zone="zone" :class="zone">{{({left:'停靠左侧',right:'停靠右侧',bottom:'停靠底部',center:'合并到中央标签组'} as any)[zone]}}</div></div>
 </div>
</template>
<style scoped>
.dock-workspace{position:relative;flex:1;min-height:0;min-width:0;display:grid;grid-template-columns:var(--dock-left) minmax(240px,1fr) var(--dock-right);grid-template-rows:minmax(120px,1fr) var(--dock-bottom);gap:4px;background:var(--border);padding:4px;overflow:hidden}
.dock-group{display:flex;flex-direction:column;min-height:0;min-width:0;position:relative;background:var(--bg-panel);border-radius:6px;overflow:hidden}.dock-left{grid-column:1;grid-row:1/3}.dock-center{grid-column:2;grid-row:1}.dock-right{grid-column:3;grid-row:1/3}.dock-bottom{grid-column:2;grid-row:2}.dock-float{position:absolute;z-index:30;border:1px solid var(--accent);box-shadow:0 12px 35px #0004}.dock-titlebar{display:flex;align-items:center;flex:none;height:32px;background:var(--bg-soft);border-bottom:1px solid var(--border);user-select:none}.dock-tabs{display:flex;flex:1;overflow:auto}.dock-tab{border:0;background:transparent;color:var(--text-dim);padding:7px 12px;font:inherit;font-size:12px;white-space:nowrap;cursor:grab;touch-action:none}.dock-tab.active{color:var(--accent);background:var(--bg-panel);box-shadow:inset 0 -2px var(--accent)}.dock-action{display:grid;place-items:center;background:none;border:0;color:var(--text-dim);cursor:pointer;padding:6px}.dock-action:hover{color:var(--accent);background:var(--hover)}.dock-body{flex:1;min-height:0;min-width:0;position:relative;overflow:hidden}.dock-title-space{flex:1;height:100%;cursor:grab}.dock-corner{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 55%,var(--accent) 56%,transparent 65%)}.dock-edge{position:absolute;z-index:15}.dock-edge.left{right:0;top:32px;bottom:0;width:5px;cursor:ew-resize}.dock-edge.right{left:0;top:32px;bottom:0;width:5px;cursor:ew-resize}.dock-edge.bottom{top:0;left:0;right:0;height:5px;cursor:ns-resize}.dock-group.is-maximized{position:absolute!important;inset:4px!important;width:auto!important;height:auto!important;z-index:50}.dock-targets{position:absolute;inset:0;z-index:80;pointer-events:none;display:grid;grid-template-columns:100px 140px 100px;grid-template-rows:65px 65px;gap:12px;padding:0;place-content:center}.dock-targets>div{pointer-events:auto;background:color-mix(in srgb,var(--accent) 16%,transparent);border:2px dashed var(--accent);border-radius:9px;display:grid;place-items:center;color:var(--text)}.dock-targets>div:hover{background:color-mix(in srgb,var(--accent) 35%,transparent)}.dock-targets .left{grid-row:1/3}.dock-targets .right{grid-column:3;grid-row:1/3}.dock-targets .bottom{grid-column:2;grid-row:2}.dock-targets .center{grid-column:2;grid-row:1}.dock-empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--text-dim)}
</style>
