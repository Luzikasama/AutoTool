<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue'
import {NButton} from 'naive-ui'
import AppIcon from './AppIcon.vue'
import {engine} from '../api/client'
import {useWorkspaceStore} from '../stores/workspace'
import {useUiStore} from '../stores/ui'
import {compileProjectTimeline,formatTimelineTime,sourceKey,timelineLanes,traceTimeline,traceRounds,type InputTraceSnapshot,type TimelineSource,type TimelineSpan,type TimelineSection} from '../lib/inputTimeline'
import {compareTimeline} from '../lib/timelineCompare'
import {advancePreview,budgetPreviewSkips} from '../lib/timelinePreview'
import {timedAction} from '../lib/timedSegment'
type Axis={id:string;name:string;laneId?:string;trackId?:string;nodeIds?:string[];nodeCount?:number}
const props=withDefaults(defineProps<{show:boolean;project:any;projectId:string;editSection:TimelineSection;tracks?:Axis[];selectedNodeId?:string|null;editNodes?:any[];context?:{scriptId:string;groupPath:string[];path:string};running?:boolean;parallel?:boolean;primaryTrack?:string;timed?:boolean;minimumDuration?:number;repeat?:number}>(),{tracks:()=>[],editNodes:()=>[]})
const emit=defineEmits<{locate:[source:TimelineSource];select:[nodeId:string];edit:[change:{nodeId:string;start:number;duration?:number;originalStart:number;source:TimelineSource;trackId?:string}];settings:[change:{primary_track:string}];viewBranches:[choices:Record<string,string>]}>()
const dock=useWorkspaceStore(),ui=useUiStore()
const cursor=ref(0),zoom=ref(100),snap=ref(10),speed=ref(1),playing=ref(false)
const speedId='preview-speed-'+Math.random().toString(36).slice(2)
const selected=ref<TimelineSpan|null>(null),scroll=ref<HTMLElement|null>(null),viewportWidth=ref(900)
const mainAxis=ref(''),branchChoices=ref<Record<string,string>>({}),branchesOpen=ref(false)
const trace=ref<InputTraceSnapshot|null>(null),traceError=ref(''),round=ref(0),followLive=ref(true)
const expected=ref<TimelineSection[]>([]),expectedSignature=ref('')
const drag=ref<{nodeId:string;start:number;duration:number;targetLane?:string}|null>(null)
let frame=0,timer:ReturnType<typeof setInterval>|null=null,observer:ResizeObserver|null=null,generation=0,busy=false,cancelGesture:(()=>void)|null=null
const section=computed(()=>props.editSection),spans=computed(()=>section.value.spans)
const duration=computed(()=>Math.max(1,section.value.duration))
const previewSkips=computed(()=>dock.hideBudgets?budgetPreviewSkips(spans.value,duration.value):[])
const plan=computed(()=>compileProjectTimeline(props.project,{branches:branchChoices.value}))
function signature(raw:any):string{return JSON.stringify({nodes:(raw?.nodes || []).map((n:any)=>({id:n.id,type:n.data?.nodeType || n.type,params:(()=>{const kind=n.data?.nodeType || n.type,p=n.data?.params || n.params || {};return ['parallel','scope'].includes(kind)?{...p,name:undefined,primary_track:undefined,branches:p.branches?.map((b:any)=>({id:b.id,start_ms:b.start_ms,variables:b.variables}))}:p})()})),edges:(raw?.edges || []).map((e:any)=>[e.source,e.target,e.sourceHandle || '']),variables:raw?.variables,scripts:Object.fromEntries(Object.entries(raw?.scripts || {}).map(([id,s])=>[id,signature(s)]))})}
const currentSignature=computed(()=>signature(props.project))
const traceMatches=computed(()=>!!trace.value?.run_id&&(!trace.value.project_id||trace.value.project_id===props.projectId))
const rounds=computed(()=>trace.value?traceRounds(trace.value):[])
const feedback=computed(()=>traceMatches.value&&expectedSignature.value===currentSignature.value&&trace.value?compareTimeline(expected.value,trace.value,ui.timelineTolerance,round.value):new Map())
const actual=computed(()=>traceMatches.value&&trace.value?traceTimeline(trace.value,round.value,true):null)
const lanes=computed(()=>{
 const result=timelineLanes(spans.value)
 if(props.parallel)for(const t of props.tracks){const id=t.laneId || t.id;if(!result.some(l=>l.id===id))result.push({id,label:t.name,device:'flow',mode:'',primary:t.id===props.primaryTrack})}
 const main=mainAxis.value&&result.some(l=>l.id===mainAxis.value)?mainAxis.value:result.find(l=>l.primary)?.id || result[0]?.id
 return result.map(l=>({...l,primary:l.id===main})).sort((a,b)=>Number(b.primary)-Number(a.primary))
})
const rows=computed(()=>lanes.value.map(lane=>{
 const ends:number[]=[]
 const items=spans.value.filter(s=>s.lane===lane.id).sort((a,b)=>a.start-b.start).map(s=>{let slot=ends.findIndex(end=>end<=s.start);if(slot<0)slot=ends.length;ends[slot]=Math.max(s.end,s.start+1);return {...s,slot}})
 return {...lane,spans:items,height:Math.max(42,ends.length*32+12)}
}))
const plotWidth=computed(()=>Math.min(60000,Math.max(320,viewportWidth.value-167)*zoom.value/100))
const pixels=computed(()=>plotWidth.value/duration.value)
const ticks=computed(()=>{const raw=duration.value/Math.max(2,plotWidth.value/90),base=10**Math.floor(Math.log10(Math.max(1,raw))),step=[1,2,5,10].map(n=>n*base).find(n=>n>=raw)||base*10;const out:number[]=[];for(let t=0;t<=duration.value&&out.length<800;t+=step)out.push(t);return out})
const warnings=computed(()=>[...new Set(section.value.warnings)].filter(w=>!w.includes('仅展示一轮')))
const held=computed(()=>[...new Set(spans.value.filter(s=>s.kind==='hold'&&s.start<=cursor.value&&s.end>cursor.value).map(s=>s.label))])
const status=(s:TimelineSpan)=>{const first=feedback.value.get(sourceKey(s.source)),last=s.endSource?feedback.value.get(sourceKey(s.endSource)):undefined;return last?.state==='bad'?last:first}
const budgetHidden=(s:TimelineSpan)=>dock.hideBudgets&&s.note?.includes('超时预算')
const trackFor=(s:TimelineSpan|null)=>s?props.tracks.find(t=>t.nodeIds?.includes(s.source.nodeId)) || props.tracks.find(t=>t.trackId===s.source.trackId):undefined
const editable=(s:TimelineSpan)=>!props.running&&s.source.scriptId===(props.context?.scriptId || '')&&props.editNodes.some(n=>n.id===s.source.nodeId)
function canMove(s:TimelineSpan){const n=props.editNodes.find(n=>n.id===s.source.nodeId);return editable(s)&&(!s.endSource||s.endSource.nodeId===s.source.nodeId)&&!['parallel','scope','join','judge','loop','terminate'].includes(n?.data?.nodeType || n?.type)}
function canResize(s:TimelineSpan){if(!canMove(s)||budgetHidden(s))return false;const n=props.editNodes.find(n=>n.id===s.source.nodeId);if(['delay','find_image','wait'].includes(n?.data?.nodeType || n?.type))return true;try{const a=timedAction(n),p=a.node.params;return !['down','up','wheel','double_click'].includes(p.action)&&!(p.action==='click'&&Number(p.clicks)>1)}catch{return false}}
function barStyle(s:TimelineSpan&{slot?:number}){const active=drag.value?.nodeId===s.source.nodeId?drag.value:null,start=active?.start ?? s.start,end=active?start+active.duration:s.end;const left=Math.min(Math.max(0,start*pixels.value),plotWidth.value-8);return {left:left+'px',width:Math.min(budgetHidden(s)?8:Math.max(8,(end-start)*pixels.value),plotWidth.value-left)+'px',top:7+(s.slot || 0)*32+'px'}}
function observed(s:TimelineSpan){if(!status(s))return null;const matches=actual.value?.spans.filter(a=>sourceKey(a.source)===sourceKey(s.source)) || [];return matches[matches.length-1]}
function observedStyle(s:TimelineSpan&{slot?:number}){const a=observed(s);return a?{left:Math.min(plotWidth.value-3,a.start*pixels.value)+'px',width:Math.max(3,Math.min(plotWidth.value-a.start*pixels.value,(a.end-a.start)*pixels.value))+'px',top:31+(s.slot || 0)*32+'px'}:{}}
function describe(s:TimelineSpan){const r=status(s);return `${s.source.label} · ${formatTimelineTime(s.start)} → ${formatTimelineTime(s.end)}${r?' · '+(r.state==='good'?'符合预期':r.state==='bad'?r.reasons.join('；'):r.state==='running'?'执行中':'未判定'):''}${s.note?' · '+s.note:''}`}
function stopPlayback(){playing.value=false;cancelAnimationFrame(frame)}
function keepVisible(){if(!scroll.value)return;const x=cursor.value*pixels.value;if(x>scroll.value.scrollLeft+scroll.value.clientWidth-200)scroll.value.scrollLeft=Math.max(0,x-scroll.value.clientWidth+220)}
function togglePlayback(){if(playing.value){stopPlayback();return}if(cursor.value>=duration.value)cursor.value=0;playing.value=true;followLive.value=false;let last=performance.now();const tick=(now:number)=>{cursor.value=advancePreview(cursor.value,(now-last)*Math.max(.1,Math.min(16,speed.value || 1)),duration.value,previewSkips.value);last=now;keepVisible();if(cursor.value>=duration.value){stopPlayback();return}frame=requestAnimationFrame(tick)};frame=requestAnimationFrame(tick)}
function selectSpan(s:TimelineSpan){selected.value=s;cursor.value=s.start;followLive.value=false;stopPlayback();if(props.editNodes.some(n=>n.id===s.source.nodeId)&&s.source.scriptId===(props.context?.scriptId || ''))emit('select',s.source.nodeId)}
function editValue(e:Event,field:'start'|'duration'){const s=selected.value,value=Number((e.target as HTMLInputElement).value);if(!s||!Number.isFinite(value)||value<0||value>86400000||props.running)return;emit('edit',{nodeId:s.source.nodeId,source:s.source,originalStart:s.start,start:field==='start'?value:s.start,...(field==='duration'?{duration:value}:{})})}
function assignAxis(e:Event){const s=selected.value;if(s&&!props.running)emit('edit',{nodeId:s.source.nodeId,source:s.source,originalStart:s.start,start:s.start,trackId:(e.target as HTMLSelectElement).value})}
function startGesture(e:PointerEvent,s:TimelineSpan,resize=false){
 if(e.button!==0||!canMove(s))return;e.preventDefault();e.stopPropagation();cancelGesture?.();selectSpan(s)
 const x=e.clientX,start=s.start,length=s.end-s.start,scale=pixels.value
 drag.value={nodeId:s.source.nodeId,start,duration:length,targetLane:s.lane}
 const move=(ev:PointerEvent)=>{if(!drag.value)return;const delta=Math.round((ev.clientX-x)/scale/snap.value)*snap.value;const lane=document.elementFromPoint(ev.clientX,ev.clientY)?.closest<HTMLElement>('.timeline-lane')?.dataset.laneId;drag.value={nodeId:s.source.nodeId,start:resize?start:Math.max(0,start+delta),duration:resize?Math.max(0,length+delta):length,targetLane:lane || s.lane}}
 const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',abort);window.removeEventListener('blur',abort);drag.value=null;cancelGesture=null}
 const finish=()=>{const result=drag.value;cleanup();if(!result||props.running)return;const axis=result.targetLane!==s.lane?props.tracks.find(t=>t.laneId===result.targetLane):undefined;if(result.start!==s.start||resize||axis)emit('edit',{nodeId:s.source.nodeId,source:s.source,originalStart:s.start,start:result.start,...(resize?{duration:result.duration}:{}),...(axis?{trackId:axis.id}:{})})}
 const abort=()=>cleanup();cancelGesture=abort;window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',abort,{once:true});window.addEventListener('blur',abort,{once:true})
}
function seek(e:MouseEvent){const r=(e.currentTarget as HTMLElement).getBoundingClientRect();cursor.value=Math.max(0,Math.min(duration.value,(e.clientX-r.left)/pixels.value));followLive.value=false;stopPlayback()}
function beginSeek(e:PointerEvent){if(e.button!==0)return;e.preventDefault();cancelGesture?.();seek(e);const el=e.currentTarget as HTMLElement;const move=(ev:PointerEvent)=>{const r=el.getBoundingClientRect();cursor.value=Math.max(0,Math.min(duration.value,(ev.clientX-r.left)/pixels.value))};const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',cleanup);window.removeEventListener('pointercancel',cleanup);window.removeEventListener('blur',cleanup);cancelGesture=null};cancelGesture=cleanup;window.addEventListener('pointermove',move);window.addEventListener('pointerup',cleanup,{once:true});window.addEventListener('pointercancel',cleanup,{once:true});window.addEventListener('blur',cleanup,{once:true})}
function seekKey(e:KeyboardEvent){if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();cursor.value=e.key==='Home'?0:e.key==='End'?duration.value:Math.max(0,Math.min(duration.value,cursor.value+(e.key==='ArrowRight'?snap.value:-snap.value)));followLive.value=false;stopPlayback();keepVisible()}
function chooseBranch(key:string,e:Event){branchChoices.value={...branchChoices.value,[key]:(e.target as HTMLSelectElement).value};emit('viewBranches',branchChoices.value)}
async function pollTrace(){
 if(busy||!props.show)return;busy=true;const gen=generation
 try{const incoming=await engine.timeline(trace.value?.run_id || '',trace.value?.last_seq || 0);if(gen!==generation||!props.show)return;if(!incoming.run_id){trace.value=null;return}
 const same=trace.value?.run_id===incoming.run_id
 if(!same){expected.value=compileProjectTimeline(props.project).sections;expectedSignature.value=currentSignature.value;round.value=0}
 const records=new Map((same?trace.value!.events:[]).map(e=>[e.seq,e]));incoming.events.forEach(e=>records.set(e.seq,e));trace.value={...incoming,events:[...records.values()].filter(e=>e.seq>incoming.dropped).sort((a,b)=>a.seq-b.seq).slice(-20000)};traceError.value=''
 if(traceMatches.value){const choices={...branchChoices.value};let changed=false;for(const e of incoming.events)if(e.kind==='node_end'&&['yes','no'].includes(e.branch || '')){const key=sourceKey({scriptId:e.script_id || '',groupPath:e.group_path || [],nodeId:e.node_id || ''});if(choices[key]!==e.branch){choices[key]=e.branch!;changed=true}}if(changed){branchChoices.value=choices;emit('viewBranches',choices)}
 if(props.running&&followLive.value&&actual.value){cursor.value=Math.min(duration.value,actual.value.duration);keepVisible()}}
 }catch(error:any){if(gen===generation)traceError.value='运行记录连接中断'}finally{busy=false}
}
function clear(){cancelGesture?.();generation++;if(timer)clearInterval(timer);timer=null;observer?.disconnect();observer=null;stopPlayback()}
watch(()=>props.show,async show=>{clear();if(!show)return;const gen=generation;await nextTick();if(!props.show||gen!==generation||!scroll.value)return;viewportWidth.value=scroll.value.clientWidth;observer=new ResizeObserver(e=>viewportWidth.value=e[0].contentRect.width);observer.observe(scroll.value);pollTrace();timer=setInterval(pollTrace,500)},{immediate:true})
watch(()=>props.projectId,()=>{trace.value=null;selected.value=null;cursor.value=0;expectedSignature.value='';branchChoices.value={}})
watch(()=>props.running,value=>{cancelGesture?.();stopPlayback();if(value){followLive.value=true;cursor.value=0;expected.value=compileProjectTimeline(props.project).sections;expectedSignature.value=currentSignature.value}pollTrace()})
watch(()=>props.selectedNodeId,id=>{selected.value=spans.value.find(s=>(s.source.nodeId===id||s.endSource?.nodeId===id)&&s.source.scriptId===(props.context?.scriptId || '')) || null;nextTick(()=>{const el=scroll.value?.querySelector<HTMLElement>(`.timeline-span[data-node-id="${CSS.escape(id || '')}"]`);el?.scrollIntoView({block:'nearest',inline:'nearest'})})})
watch(section,value=>{if(selected.value)selected.value=value.spans.find(s=>sourceKey(s.source)===sourceKey(selected.value!.source)) || null})
watch(lanes,value=>{if(mainAxis.value&&!value.some(l=>l.id===mainAxis.value))mainAxis.value=''})
onBeforeUnmount(clear)
</script>
<template><div class="input-timeline editing" aria-label="工程键鼠时间轴">
 <div class="timeline-controls">
  <NButton size="small" :disabled="running||!spans.length" @click="togglePlayback"><AppIcon :name="playing?'pause':'play'"/>{{playing?'暂停预览':'播放预览'}}</NButton>
  <label>倍速 <input class="speed-input" type="number" min="0.1" max="16" step="any" :list="speedId" v-model.number="speed" @change="speed=Math.max(.1,Math.min(16,Number(speed)||1))" aria-label="预览倍速">×</label><datalist :id="speedId"><option v-for="v in [.1,.25,.5,.75,1,1.25,1.5,2,4,8,16]" :key="v" :value="v"/></datalist>
  <label>吸附 <select v-model.number="snap" aria-label="时间轴吸附"><option v-for="v in [1,10,50,100]" :key="v" :value="v">{{v}}ms</option></select></label>
  <label v-if="lanes.length>1">主轴 <select v-model="mainAxis" aria-label="切换主轴视角" @change="emit('settings',{primary_track:tracks.find(t=>t.laneId===mainAxis)?.id || primaryTrack || 'main'})"><option value="">默认主轴</option><option v-for="l in lanes" :key="l.id" :value="l.id">{{l.label}}</option></select></label>
  <label><input v-model="dock.hideBudgets" type="checkbox" aria-label="隐藏超时预算" @change="dock.persist()">隐藏超时预算</label>
  <label>缩放 <input v-model.number="zoom" type="range" min="50" max="1000" step="25" aria-label="时间轴缩放">{{zoom}}%</label>
  <button v-if="plan.branches.length" :aria-expanded="branchesOpen" @click="branchesOpen=!branchesOpen">条件分支</button>
  <label v-if="rounds.length>1">轮次 <select v-model.number="round" aria-label="运行轮次"><option :value="0">当前轮次</option><option v-for="r in rounds" :key="r" :value="r">{{r}}</option></select></label>
  <span v-if="traceMatches" class="run-indicator" :class="{error:traceError}" :title="traceError || (running?'正在比对本次运行':'上次运行比对')"><AppIcon name="activity"/></span>
 </div>
 <div v-if="branchesOpen" class="timeline-branches"><label v-for="b in plan.branches" :key="b.key">{{b.label}}<select :value="branchChoices[b.key] || 'yes'" @change="chooseBranch(b.key,$event)"><option value="yes">是</option><option value="no">否</option></select></label></div>
 <details v-if="warnings.length" class="timeline-notes"><summary>{{warnings.length}} 条时间与变量提示</summary><div class="timeline-warnings"><div v-for="w in warnings" :key="w">{{w}}</div></div></details>
 <div ref="scroll" class="timeline-scroll" aria-label="键鼠轨道">
  <div v-if="!spans.length&&!lanes.length" class="timeline-empty">在流程图中添加或选择节点</div>
  <div v-else class="timeline-sheet" :style="{width:plotWidth+165+'px'}">
   <div class="timeline-ruler"><span class="timeline-lane-label">执行轴</span><div class="timeline-ruler-plot" :style="{width:plotWidth+'px'}" @click="seek"><span v-for="tick in ticks" :key="tick" class="timeline-tick" :style="{left:tick*pixels+'px'}">{{formatTimelineTime(tick)}}</span></div></div>
   <div v-for="(lane,index) in rows" :key="lane.id" class="timeline-lane" :data-lane-id="lane.id" :class="{'drop-axis':drag?.targetLane===lane.id}" :style="{height:lane.height+'px'}">
    <div class="timeline-lane-label"><strong>{{lane.primary?'主轴':'副轴 '+index}}</strong><span v-if="lane.label!=='主轴'&&!/^副轴\s*\d+$/.test(lane.label)">{{lane.label}}</span></div>
    <div class="timeline-lane-plot" :style="{width:plotWidth+'px'}" @click="seek">
     <span v-for="tick in ticks" :key="tick" class="timeline-gridline" :style="{left:tick*pixels+'px'}"/>
     <template v-for="span in lane.spans" :key="span.id"><button type="button" class="timeline-span" :data-node-id="span.source.nodeId" :class="[span.device,span.kind,'run-'+(status(span)?.state || 'idle'),{selected:selected?.source.nodeId===span.source.nodeId,'budget-marker':budgetHidden(span),approximate:span.estimated}]" :style="barStyle(span)" :title="describe(span)" :aria-label="describe(span)" @pointerdown="startGesture($event,span)" @click.stop="selectSpan(span)"><span v-if="!budgetHidden(span)&&(span.end-span.start)*pixels>45">{{span.label}}</span><span v-if="canResize(span)" class="timeline-resize" aria-label="拖动调整持续时间" @pointerdown.stop="startGesture($event,span,true)"/></button><span v-if="observed(span)" class="timeline-observed" :class="'run-'+status(span)?.state" :style="observedStyle(span)"/></template>
     <span class="timeline-cursor" :style="{left:cursor*pixels+'px'}"/>
    </div>
   </div>
   <div class="timeline-position"><span class="timeline-lane-label">{{formatTimelineTime(cursor)}} / {{formatTimelineTime(duration)}}</span><div class="timeline-scrubber" role="slider" tabindex="0" aria-label="移动时间游标" :aria-valuemin="0" :aria-valuemax="duration" :aria-valuenow="Math.round(cursor)" :style="{width:plotWidth+'px'}" @pointerdown="beginSeek" @keydown="seekKey"><div class="scrubber-track"/><span class="scrubber-thumb" :style="{left:cursor*pixels+'px'}"/></div></div>
  </div>
 </div>
 <div class="timeline-held" aria-live="polite"><AppIcon name="keyboard"/><span v-if="!held.length">无按住动作</span><span v-for="key in held" :key="key" class="timeline-key-chip">{{key}}</span></div>
 <div v-if="selected" class="timeline-details"><strong>{{selected.source.label}}</strong>
  <label v-if="canMove(selected)">开始 <input class="time-number" type="number" min="0" max="86400000" :value="selected.start" aria-label="动作开始时间" :disabled="running" @change="editValue($event,'start')">ms</label>
  <label v-if="canResize(selected)">持续 <input class="time-number" type="number" min="0" max="86400000" :value="selected.end-selected.start" aria-label="动作持续时间" :disabled="running" @change="editValue($event,'duration')">ms</label>
  <label v-if="parallel&&canMove(selected)">所属轴 <select :value="trackFor(selected)?.id || ''" aria-label="动作所属轴" :disabled="running" @change="assignAxis"><option value="" disabled>公共流程</option><option v-for="t in tracks" :key="t.id" :value="t.id">{{t.name}}</option></select></label>
  <span v-if="status(selected)" :class="'feedback-'+status(selected)?.state">{{status(selected)?.state==='bad'?status(selected)?.reasons.join('；'):status(selected)?.state==='good'?'符合预期':status(selected)?.state==='running'?'执行中':'未判定'}} · 实际 {{formatTimelineTime(status(selected)!.start)}} → {{formatTimelineTime(status(selected)!.end)}}</span>
  <NButton size="small" @click="emit('locate',selected.source)">定位节点</NButton><NButton v-if="selected.endSource&&selected.endSource.nodeId!==selected.source.nodeId" size="small" @click="emit('locate',selected.endSource)">定位松开节点</NButton>
 </div>
</div></template>
<style scoped>
.input-timeline { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 8px; color: var(--text); padding: 10px; box-sizing: border-box; overflow: auto; }
.time-number { width: 90px; padding: 4px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--bg-panel); font: inherit; }
.timeline-resize { position: absolute; right: 0; top: 0; bottom: 0; width: 7px; cursor: ew-resize; background: rgba(255,255,255,.35); }
.editing .timeline-span { cursor: grab; touch-action: none; }
.input-timeline button:disabled { opacity: .5; cursor: default; }
.timeline-toolbar, .timeline-controls, .timeline-position, .timeline-held { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; flex: none; }
.timeline-tabs { display: flex; gap: 4px; }
.input-timeline button:not(.timeline-span), .input-timeline select, .timeline-search { color: var(--text); background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; font: inherit; }
.input-timeline button { cursor: pointer; }
.input-timeline button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.timeline-tabs .active { color: var(--accent) !important; border-color: var(--accent) !important; background: var(--accent-soft) !important; }
.timeline-project { flex: 1; min-width: 80px; overflow-wrap: anywhere; }
.timeline-state { color: var(--accent); }
.timeline-controls { font-size: 12px; }
.timeline-controls label, .timeline-position label { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.timeline-controls select { max-width: 360px; min-width: 0; }
.timeline-controls input[type='range'] { width: 90px; }
.timeline-search { width: 170px; min-width: 0; }
.timeline-caption, .timeline-help { flex: none; color: var(--text-dim); font-size: 12px; }
.timeline-warnings, .timeline-branches { flex: none; max-height: 88px; overflow: auto; font-size: 12px; padding: 7px 10px; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; }
.timeline-warnings { color: var(--warn); }
.timeline-branches label { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px 4px 0; }
.timeline-scroll { flex: 1; min-height: 100px; overflow: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); }
.timeline-sheet { min-height: 100%; }
.timeline-ruler, .timeline-lane { display: flex; position: relative; }
.timeline-ruler { position: sticky; top: 0; z-index: 5; height: 34px; background: var(--bg-panel); border-bottom: 1px solid var(--border); }
.timeline-lane { height: 42px; border-bottom: 1px solid var(--border); }
.timeline-lane-label { position: sticky; left: 0; z-index: 3; width: 165px; flex: 0 0 165px; padding: 5px 12px; background: var(--bg-panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; justify-content: center; font-size: 12px; overflow: hidden; }
.timeline-lane-label small { color: var(--text-dim); font-size: 10px; }
.timeline-lane-plot, .timeline-ruler-plot { position: relative; flex: none; cursor: crosshair; }
.timeline-tick { position: absolute; top: 9px; font-size: 11px; color: var(--text-dim); white-space: nowrap; padding-left: 4px; }
.timeline-gridline { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border); pointer-events: none; }
.timeline-span { position: absolute; top: 10px; height: 22px; padding: 0 3px; border: 0; border-radius: 4px; background: var(--accent); color: var(--bg); font: inherit; font-size: 11px; text-align: left; overflow: hidden; white-space: nowrap; cursor: pointer; }
.timeline-span.mouse { background: var(--ok); }
.timeline-span.motion, .timeline-span.wheel { background: var(--warn); }
.timeline-span.text { background: var(--accent); }
.timeline-span.flow { background: var(--edge); color: var(--text); }
.timeline-span.gap { background: repeating-linear-gradient(135deg, var(--edge), var(--edge) 5px, var(--bg-panel) 5px, var(--bg-panel) 10px); }
.timeline-span.selected { outline: 2px solid var(--text); outline-offset: 2px; z-index: 2; }
.timeline-span.open { border-right: 2px dashed var(--text); }
.timeline-span.approximate { opacity: .8; }
.timeline-cursor { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--danger); z-index: 2; pointer-events: none; }
.timeline-empty { padding: 35px 15px; color: var(--text-dim); text-align: center; }
.timeline-position { font-size: 12px; font-variant-numeric: tabular-nums; }
.timeline-position > input { flex: 1; min-width: 120px; }
.timeline-held { min-height: 26px; font-size: 12px; }
.timeline-key-chip { padding: 2px 7px; border-radius: 4px; background: var(--accent-soft); color: var(--accent); }
.timeline-details { flex: none; font-size: 12px; border-top: 1px solid var(--border); padding-top: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 7px 12px; }
.timeline-details strong { font-weight: 500; }
@media(max-width:650px) { .timeline-controls select { max-width: 180px; } .timeline-controls { max-height: 130px; overflow: auto; } .timeline-project { display: none; } }
</style>

<style scoped>.timeline-span.budget-marker{border:1px solid var(--accent);background:var(--bg-panel);border-radius:2px;opacity:.8}.timeline-controls{align-items:center}.timeline-toolbar{flex-wrap:wrap;gap:6px}.timeline-caption{font-size:11px;line-height:1.6}.timeline-controls label{white-space:nowrap}</style>

<style scoped>.timeline-notes{flex:none;font-size:12px;color:var(--warn)}.timeline-notes>summary{cursor:pointer}.axis-settings{display:flex;gap:8px;width:100%;align-items:center;padding:6px 0;border-top:1px solid var(--border)}.input-timeline{gap:6px}.timeline-controls{gap:6px}.timeline-search{width:130px}.timeline-caption{white-space:normal}.timeline-warnings{max-height:45px;padding:4px 8px}</style>
<style scoped>
.timeline-controls{gap:6px;align-items:center}.timeline-controls>label{white-space:nowrap}.timeline-controls input.speed-input{width:55px;border:1px solid var(--border);border-radius:4px;padding:4px;color:var(--text);background:var(--bg-panel)}.timeline-controls input[type=range]{width:75px}.timeline-controls select{max-width:150px}.timeline-lane-label{box-sizing:border-box}.timeline-position{position:sticky;bottom:0;z-index:6;height:30px;gap:0;flex-wrap:nowrap;background:var(--bg-panel);border-top:1px solid var(--border)}.timeline-position .timeline-lane-label{height:30px;font-size:11px;white-space:nowrap;align-items:center;padding:3px}.timeline-scrubber{flex:none;height:30px;position:relative;cursor:ew-resize;touch-action:none}.scrubber-track{position:absolute;left:0;right:0;top:14px;height:3px;background:var(--edge);border-radius:3px}.scrubber-thumb{position:absolute;top:9px;width:12px;height:12px;transform:translateX(-50%);border-radius:50%;background:var(--accent)}.timeline-sheet{min-height:0}.timeline-span.run-good{background:#15803d!important;color:white}.timeline-span.run-bad{background:#dc2626!important;color:white}.timeline-span.run-running{outline:2px solid var(--accent)}.timeline-observed{position:absolute;height:3px;pointer-events:none;background:var(--accent);opacity:.9}.timeline-observed.run-good{background:#16a34a}.timeline-observed.run-bad{background:#dc2626}.timeline-details input{width:75px}.timeline-details label{white-space:nowrap}.timeline-held{gap:5px;font-size:11px;min-height:22px}.feedback-good{color:#15803d}.feedback-bad,.run-indicator.error{color:#dc2626}.run-indicator{margin-left:auto;display:flex;color:#15803d}.drop-axis{box-shadow:inset 0 0 0 1px var(--accent)}.input-timeline{gap:6px;padding:8px}.timeline-controls{font-size:11px}.timeline-scroll{min-height:140px}.timeline-notes{font-size:11px}.timeline-details{font-size:11px}
</style>
