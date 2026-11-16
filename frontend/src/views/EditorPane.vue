<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import ProjectSearch from '../components/ProjectSearch.vue'
import FlowEdge from '../components/FlowEdge.vue'
import {connectionIssue,wireLabel} from '../lib/flowConnections'
import {mergeCard,layoutRecording,cardConnection} from '../lib/graphPresentation'
import {reorderTimeline,settleAbsoluteAxis} from '../lib/timelineEditing'
import DockWorkspace from '../components/DockWorkspace.vue'
import {useWorkspaceStore} from '../stores/workspace'
import {flattenGraph,createParallel,regionBranches,removeCanvasNodes,foldedGraph} from '../lib/flatFlow'
import VariableNumberInput from '../components/VariableNumberInput.vue'
import {autoBindConnection,outputName} from '../lib/variableBinding'
import {renameScopeVariable,variableReferenced} from '../lib/variableReferences'
import {serializeFlowGraph} from '../lib/serializeFlow'
/**
 * 单个脚本编辑器（一个标签页一个实例）。
 *
 * 0.1.2 起本组件只负责**一个文档**：节点、连线、撤销历史、脚本名等全部是
 * 实例内的局部状态（每个标签天然独立），文档数据实时镜像进 stores/docs.ts，
 * 供保存、标签标题、子脚本列表使用。
 *
 * 与哪个脚本无关的东西（WebSocket、运行状态、悬浮框、模板/窗口列表、录制状态）
 * 统一由 stores/engine.ts 持有 —— 引擎只允许一条页面连接，每个标签各连一次是错的。
 */
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { VueFlow, MarkerType, ConnectionLineType, type Connection } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTooltip,
  useDialog,
  useMessage,
} from 'naive-ui'
import StepNode from '../components/StepNode.vue'
import ScreenCapture from '../components/ScreenCapture.vue'
import ScriptPickerModal from '../components/ScriptPickerModal.vue'
import HintIcon from '../components/HintIcon.vue'
import InputTimelinePanel from '../components/InputTimelinePanel.vue'
import type { TimelineSource } from '../lib/inputTimeline'
import { editTimedNode, splitRecording, recordingFlow } from '../lib/timedSegment'
import { containerTimeline,compileProjectTimeline } from '../lib/inputTimeline'
import { simpleProjection, createSimpleImage, connectSimple, updateSimpleImage, SIMPLE_TYPES, SIMPLE_FIELDS } from '../lib/simpleFlow'
import { useUiStore } from '../stores/ui'
import { engine } from '../api/client'
import { useProjectStore } from '../stores/project'
import { useDocsStore } from '../stores/docs'
import { useEngineStore } from '../stores/engine'
import { useClipboardStore } from '../stores/clipboard'
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  GROUP_META,
  GROUP_TYPE,
  NODE_META,
  nodesOfCategory,
  VAR_TYPES,
  type FlowFile,
  type NodeCategory,
  type NodeType,
  type VarItem,
  type WindowInfo,
} from '../types'
import {
  CONDITION_OPS,
  UNARY_OPS,
  defaultsFor,
  fieldVisible,
  mergeWithDefaults,
  nodeOutputs,
  outputVisible,
  NODE_SCHEMA,
  type NodeField,
  type NodeOutput,
} from '../lib/nodeSchema'
import { migrateScript } from '../lib/migrateFlow'
import {
  COL_PITCH,
} from '../lib/macroSplit'
import {
  buildGraph,
  chainText,
  findAnyCycle,
  normalizeScripts,
  ROOT_NODE,
  wouldCreateCycle,
} from '../lib/scriptGraph'
import { extractFragment, materializeFragment } from '../lib/clipFragment'

const props = defineProps<{ docId: string; active: boolean }>()

const project = useProjectStore()
const docs = useDocsStore()
const eng = useEngineStore()
const clip = useClipboardStore()
const ui = useUiStore()
const dock=useWorkspaceStore()
const simpleMode = computed(() => ui.editorMode === 'simple')
const advancedParams = ref(false)
const edgeTypes=markRaw({wire:FlowEdge})

const message = useMessage()
const dialog = useDialog()

/** 本视图对应的标签 */
const tab = computed(() => docs.tabs.find((t) => t.id === props.docId))
/** 所属根文档的数据（子脚本文档下，元信息如循环轮数/绑定窗口仍取自根脚本） */
const root = computed(() => {
  const t = tab.value
  return t ? docs.getRoot(t.rootId) : undefined
})
const isSub = computed(() => tab.value?.kind === 'sub')
/** 本标签是不是在编辑某个「组合节点」的内部图（双击组合节点进来） */
const isGroup = computed(() => tab.value?.kind === 'group')
const timelineContext = computed(() => ({ scriptId: tab.value?.scriptId || '', groupPath: tab.value?.groupPath || [], path: flowName.value }))
provide('isTimelineGraph',ref(false))
const focusedForkId=ref('')
const focusedFork=computed(()=>{
  const selected=nodes.value.find(n=>n.id===selectedId.value)
  if(selected?.data.nodeType==='parallel')return selected
  if(selected?.data.nodeType==='join')return nodes.value.find(n=>n.id===selected.data.params.fork_id)
  const containing=nodes.value.filter(n=>n.data.nodeType==='parallel').map(n=>({node:n,branches:regionBranches(nodes.value,edges.value,n)})).filter(v=>v.branches.some((b:any)=>b.ids.has(selectedId.value))).sort((a,b)=>a.branches.reduce((s:number,v:any)=>s+v.ids.size,0)-b.branches.reduce((s:number,v:any)=>s+v.ids.size,0))
  return containing[0]?.node || nodes.value.find(n=>n.id===focusedForkId.value&&n.data.nodeType==='parallel') || nodes.value.find(n=>n.data.nodeType==='parallel')
})
const axisTracks=computed(()=>focusedFork.value?.data.params.branches || [])
const axisLanes=computed(()=>{
  const fork=focusedFork.value;if(!fork)return []
  const trackKey=(f:any,path:string[],id:string)=>f.data.params.timing==='absolute'?JSON.stringify([timelineContext.value.scriptId,path,''])+':'+id:JSON.stringify([timelineContext.value.scriptId,path,id])
  const parents=nodes.value.filter(n=>n!==fork&&['parallel','scope'].includes(n.data.nodeType)).map(n=>({node:n,branch:regionBranches(nodes.value,edges.value,n).find((b:any)=>b.ids.has(fork.id))})).filter(v=>v.branch).sort((a,b)=>b.branch.ids.size-a.branch.ids.size)
  const path=[...timelineContext.value.groupPath];let parentAxis='main'
  for(const parent of parents){path.push(parent.node.id);if(parent.node.data.nodeType==='parallel'){if(parent.branch.id!==(parent.node.data.params.primary_track || parent.node.data.params.branches[0]?.id))parentAxis=trackKey(parent.node,path,parent.branch.id);path.push(parent.branch.id)}}
  path.push(fork.id)
  return axisTracks.value.map((b:any)=>{
  const branch=regionBranches(nodes.value,edges.value,fork).find((v:any)=>v.id===b.id)
  const trackId=trackKey(fork,path,b.id)
  return {...b,nodeCount:branch?.nodes.length || 0,nodeIds:[...(branch?.ids || [])],trackId,laneId:b.id===(fork.data.params.primary_track || axisTracks.value[0]?.id)?parentAxis:trackId}
})})
const timelineChoices=ref<Record<string,string>>({})
function openTimeline(){dock.open('timeline')}
function nextNodeId(){let id=`n${++nodeSeq}`;while(nodes.value.some(n=>n.id===id))id=`n${++nodeSeq}`;return id}
function expandToNode(id:string){for(const n of nodes.value)if(n.id!==id&&n.data.foldMembers?.includes(id))delete n.data.foldMembers}
function selectTimelineAction(id: string) {
  expandToNode(id)
  selectedId.value = id
  selIds.value = [id]
  nodes.value.forEach(n => { n.selected = n.id === id })
  nextTick(()=>{const n=vf?.findNode?.(id);if(n)vf?.addSelectedNodes?.([n])})
}
function editTimelineAction(change: { nodeId: string; start: number; duration?: number; originalStart?: number; source?: TimelineSource; trackId?: string }) {
  if(project.running)return
  if(change.source&&(change.source.scriptId!==(tab.value?.scriptId || '')||change.source.groupPath.length)){message.info('请定位来源节点后编辑');return}
  const original=nodes.value.find(n=>n.id===change.nodeId);if(!original)return
  try {
    const draft=cloneData(nodes.value),node=draft.find(n=>n.id===change.nodeId),p=node.data.params
    const absolute=draft.find(f=>f.data.nodeType==='parallel'&&f.data.params.timing==='absolute'&&regionBranches(draft,edges.value,f).some((b:any)=>b.ids.has(node.id)))
    if(change.duration!==undefined){
      if(p.timeline){delete p.timeline.start_order;delete p.timeline.end_order}
      const type=node.data.nodeType
      if(['find_image','wait'].includes(type))p.timeout_ms=change.duration
      else if(type==='delay')p.ms=change.duration
      else if(type==='keyboard')p.hold_ms=change.duration
      else if(type==='mouse')node.data.params={...editTimedNode(node,Number(p.timeline?.start_ms || 0),change.duration),timeline:p.timeline}
      else throw new Error('该节点时长由运行结果决定，请在参数面板编辑')
    }
    let result={nodes:draft,edges:cloneData(edges.value)}
    if(change.trackId||change.start!==(change.originalStart ?? change.start)){
      const fork=focusedFork.value
      const starts=currentTiming.value.spans.filter(s=>s.source.nodeId===node.id).map(s=>s.start)
      const first=starts.length?Math.min(...starts):change.start
      const targetStart=change.start-(change.originalStart ?? first)+first
      result=reorderTimeline(draft,result.edges,node.id,targetStart,currentTiming.value.spans,change.trackId&&fork?{forkId:fork.id,branchId:change.trackId}:undefined)
    }
    if(absolute)settleAbsoluteAxis(result.nodes,result.edges,absolute,node.id)
    pushHistory();nodes.value=result.nodes;edges.value=result.edges;mirrorToStore();pushHistory()
  }catch(error:any){message.error(error.message)}
}
function addFlowAxis(){
 const fork=focusedFork.value;if(project.running||!fork)return
 const p=fork.data.params;if(p.branches.length>=16){message.warning('最多 16 条执行轴');return}
 pushHistory();let id='side'+p.branches.length;while(p.branches.some((b:any)=>b.id===id))id+='x'
 p.branches.push({id,name:'副轴 '+p.branches.length,start_ms:0,variables:[]});edges.value.push({id:fork.id+'-'+id,source:fork.id,target:p.join_id,sourceHandle:id});mirrorToStore();pushHistory()
}
function editSegmentSettings(change: { duration_ms?: number; repeat?: number; tracks?: {id:string;name:string;start_ms?:number}[]; primary_track?:string }) {
  if (project.running) return
  if (change.duration_ms != null && (!Number.isFinite(change.duration_ms) || change.duration_ms < 0 || change.duration_ms > 86400000)) return
  if (change.repeat != null && (!Number.isInteger(change.repeat) || change.repeat < 1 || change.repeat > 1000)) return
  pushHistory()
  const fork=focusedFork.value;if(!fork)return
  const p=fork.data.params
  if(change.tracks){
    const previous=p.branches || []
    if(change.tracks.some(t=>!Number.isFinite(t.start_ms ?? 0)||(t.start_ms ?? 0)<0||(t.start_ms ?? 0)>86400000))return
    if(p.timing==='absolute')for(const t of change.tracks){const delta=(t.start_ms || 0)-(previous.find((b:any)=>b.id===t.id)?.start_ms || 0);if(delta)for(const n of regionBranches(nodes.value,edges.value,fork).find((b:any)=>b.id===t.id)?.nodes || [])n.data.params.timeline.start_ms=Math.max(0,(n.data.params.timeline.start_ms || 0)+delta)}
    for(const t of change.tracks)if(!previous.some((b:any)=>b.id===t.id))edges.value.push({id:`${fork.id}-${t.id}`,source:fork.id,target:p.join_id,sourceHandle:t.id})
    p.branches=change.tracks.map(t=>({id:t.id,name:t.name,start_ms:t.start_ms ?? 0,variables:previous.find((b:any)=>b.id===t.id)?.variables || []}))
  }
  for(const k of ['duration_ms','repeat','primary_track'])if((change as any)[k]!==undefined)p[k]=(change as any)[k]
  mirrorToStore(); pushHistory()
}
async function locateTimelineNode(source: TimelineSource) {
  const current = tab.value
  const data = root.value
  if (!current || !data) return
  let container: any = source.scriptId ? data.scripts[source.scriptId] : data
  for (const id of source.groupPath) {
    const node = container?.nodes?.find((n: any) => String(n.id) === id)
    container = node?.data?.params || node?.params
  }
  if (!container?.nodes?.some((n: any) => String(n.id) === source.nodeId)) {
    message.warning('来源节点已经变更或删除，请刷新时间轴')
    return
  }
  const target = source.groupPath.length
    ? docs.openGroup(current.rootId, source.scriptId, source.groupPath, container.name || '组合节点')
    : source.scriptId ? docs.openSub(current.rootId, source.scriptId) : current.rootId
  docs.activate(target)
  docs.focusNode(target, source.nodeId)
  dock.open('flow');dock.open('params')
}
async function applyTimelineFocus() {
  const request = docs.nodeFocus
  if (!request || request.tabId !== props.docId) return
  await nextTick()
  if (!nodes.value.some(n => String(n.id) === request.nodeId)) return
  expandToNode(request.nodeId)
  selectedId.value = request.nodeId
  selIds.value = [request.nodeId]
  const displayId=simpleMode.value?projection.value.owner.get(request.nodeId) || request.nodeId:request.nodeId
  nodes.value.forEach(n=>n.selected=n.id===displayId)
  await nextTick()
  const graphNode=vf?.findNode?.(displayId)
  if(graphNode)vf?.addSelectedNodes?.([graphNode])
  ;(vf as any)?.fitView?.({ nodes: [displayId], padding: 0.6, duration: 200, maxZoom: 1.1 })
}
watch(() => docs.nodeFocus?.seq, applyTimelineFocus)

const nodeTypes: any = { step: markRaw(StepNode) }
/** 目前 palette 里展开的是哪一类（六大类通过上方切换） */
const paletteCat = ref<NodeCategory>('input')

const nodes = ref<any[]>([])
const edges = ref<any[]>([])
const projection = computed(() => simpleProjection(nodes.value,edges.value))
const displayGraph=computed(()=>foldedGraph(simpleMode.value?projection.value.nodes:nodes.value,simpleMode.value?projection.value.edges:edges.value))
const canvasNodes=computed({
 get:()=>displayGraph.value.nodes,
 set:(value:any[])=>{
   const keep=new Set(value.map(n=>n.id)),removed=new Set<string>()
   for(const n of displayGraph.value.nodes)if(!keep.has(n.id))(simpleMode.value?projection.value.recipes.get(n.id)?.ids || [n.id]:[n.id]).forEach(id=>removed.add(id))
   for(const id of [...removed])for(const child of nodes.value.find(n=>n.id===id)?.data.foldMembers || [])removed.add(child)
   if(removed.size){const r=removeCanvasNodes(nodes.value,edges.value,removed);nodes.value=r.nodes;edges.value=r.edges}
   for(const item of value){const n=nodes.value.find(n=>n.id===item.id);if(!n)continue;const old=simpleMode.value?n.data.simplePosition || n.position:n.position;if(item.position&&(old?.x!==item.position.x||old?.y!==item.position.y)){if(simpleMode.value)n.data.simplePosition={...item.position};else n.position={...item.position}}if(n.selected!==item.selected)n.selected=item.selected}
 }
})
const canvasEdges=computed({
 get:()=>displayGraph.value.edges.map(e=>({...e,type:'wire',markerEnd:{type:MarkerType.ArrowClosed,width:18,height:18},label:wireLabel(displayGraph.value.nodes,e),data:{canEdit:!project.running}})),
 set:(value:any[])=>{const keep=new Set(value.map(e=>e.id)),remove=new Set(displayGraph.value.edges.filter(e=>!keep.has(e.id)).flatMap(e=>e.originalIds || [e.id]));if(remove.size)edges.value=edges.value.filter(e=>!remove.has(e.id));for(const item of value)for(const id of item.originalIds || [item.id]){const e=edges.value.find(e=>e.id===id);if(e&&e.selected!==item.selected)e.selected=item.selected}}
})
const selectedId = ref<string | null>(null)
// 多选（Vue Flow 内建：空白处左键拖拽框选、Ctrl+点击逐个加选）选中的节点 id。
// 用 selection-change 事件单独记一份，而不是依赖 node.selected —— 合并按钮的
// 可用状态/数量要能跟着选择实时变。
const selIds = ref<string[]>([])
const selectedWinHwnd = ref<number>(0)

// ---------- 文档级元信息（局部持有 + 镜像进 docs store）----------
// 局部持有是为了让模板里的 v-model 正常工作（store 里的文档数据刻意不是响应式的，
// 上万节点的图不需要 Vue 去追），镜像则保证「保存 / 另一个标签读得到」。
const flowName = ref('未命名脚本')
const repeat = computed({get:()=>docs.repeatValues[tab.value?.rootId || ''] ?? root.value?.repeat ?? 1,set:(value:number)=>docs.setRepeat(tab.value?.rootId || '',value)})
const boundWindow = ref<{ hwnd: number; title: string } | null>(null)
const fileScreen = ref<{ width: number; height: number } | null>(null)
const fileWindowRect = ref<WindowInfo['rect'] | null>(null)
/**
 * 本层作用域声明的变量。
 *
 * 局部持有 + 镜像进容器（和 nodes/edges 同一套路）：容器对象是 markRaw 的普通数据，
 * 直接改它不会触发任何响应式刷新，右侧变量面板就永远是打开时那一份。
 */
const variables = ref<VarItem[]>([])
const variableScopeId=ref('')
const variableScopes=computed(()=>{
  const options:any[]=[{id:'',label:container()?.kind==='root'?'全局变量':'当前脚本局部变量',owner:null,ids:new Set(nodes.value.map(n=>n.id))}]
  for(const f of nodes.value.filter(n=>['parallel','scope'].includes(n.data.nodeType))){
    const branches=regionBranches(nodes.value,edges.value,f),p=f.data.params
    const ids=new Set<string>(branches.flatMap((b:any)=>[...b.ids]))
    options.push({id:f.id,label:`${p.name || (f.data.nodeType==='scope'?'作用域':'并行区域')} · ${f.id}`,owner:p,visibleIds:ids,ids:f.data.nodeType==='parallel'?new Set<string>():ids})
    if(f.data.nodeType==='parallel')for(const b of branches)options.push({id:f.id+'|'+b.id,label:`${p.name || f.id} / ${b.name}`,owner:p.branches.find((t:any)=>t.id===b.id),ids:b.ids})
  }
  return options
})
const managedScope=computed(()=>variableScopes.value.find(s=>s.id===variableScopeId.value)||variableScopes.value[0])
const managedVariables=computed<VarItem[]>({get:()=>managedScope.value.owner?.variables || (managedScope.value.owner?[]:variables.value),set:value=>{if(managedScope.value.owner)managedScope.value.owner.variables=value;else variables.value=value}})
function nodesInScope(scope:any,ownOnly=false){
  const ids=ownOnly?scope.ids:(scope.visibleIds || scope.ids)
  let result=nodes.value.filter(n=>ids.has(n.id))
  if(!ownOnly&&scope.visibleIds&&scope.owner?.branches){const fork=nodes.value.find(n=>n.id===scope.id);if(fork)result.unshift(fork)}
  if(ownOnly){const inner=new Set<string>();for(const n of result)if(['parallel','scope'].includes(n.data.nodeType))regionBranches(nodes.value,edges.value,n).forEach((b:any)=>b.ids.forEach((id:string)=>inner.add(id)));result=result.filter(n=>!inner.has(n.id))}
  return result
}
function scopeOfNode(id:string){return variableScopes.value.filter(s=>s.id&&s.ids.has(id)).sort((a,b)=>a.ids.size-b.ids.size)[0] || variableScopes.value[0]}
function declarationsOfNode(id:string):VarItem[]{const scope=scopeOfNode(id);if(!scope.owner)return variables.value;return scope.owner.variables ||= []}
watch(simpleMode,()=>{variableScopeId.value=''})


/**
 * 本标签编辑的「流程容器」——节点与连线的实际落点。
 *
 * 三种可能：
 *  · 根脚本标签    → 根文档本身（里面就是主流程）
 *  · 子脚本标签    → 根文档 scripts 里的某个子脚本
 *  · 组合节点标签  → 沿 groupPath 逐层下钻，最终落在某个组合节点的 params 上
 *
 * 之所以要一个统一的"容器"概念：0.1.4 起同一个编辑器要能编辑这三种东西，
 * 而它们的 nodes/edges/name/variables 形状是一样的，只是所在对象不同。
 */
function container(): { kind: 'root' | 'sub' | 'group'; obj: any } | null {
  const t = tab.value
  const r = root.value
  if (!t || !r) return null
  if (t.kind === 'root') return { kind: 'root', obj: r }
  if (t.kind === 'sub') {
    const s = r.scripts[t.scriptId]
    return s ? { kind: 'sub', obj: s } : null
  }
  // 组合节点：起点是"它所在的那份脚本"（根脚本或某个子脚本），然后沿路径下钻
  let arr: any[] = t.scriptId ? r.scripts[t.scriptId]?.nodes || [] : r.nodes
  let params: any = null
  for (const id of t.groupPath || []) {
    const n = arr.find((x: any) => x?.id === id)
    if (!n || n?.data?.nodeType !== GROUP_TYPE) return null
    params = n.data.params || {}
    arr = params.nodes || []
  }
  return params ? { kind: 'group', obj: params } : null
}

/** 本视图的流程是根脚本、子脚本还是组合节点内部（读初始状态用） */
function flowOfRoot(): { nodes: any[]; edges: any[]; name: string; variables: VarItem[] } {
  const c = container()
  const t = tab.value
  if (!c || !t) return { nodes: [], edges: [], name: '未命名脚本', variables: [] }
  return {
    nodes: c.obj.nodes || [],
    edges: c.obj.edges || [],
    name: c.obj.name || (t.kind === 'group' ? '组合节点' : '未命名脚本'),
    variables: Array.isArray(c.obj.variables) ? c.obj.variables : [],
  }
}

/** 把本视图的编辑结果写回文档存储（保存、标签标题、子脚本列表都读它） */
function mirrorToStore() {
  const c = container()
  const t = tab.value
  const r = root.value
  if (!c || !t || !r) return
  c.obj.nodes = nodes.value
  c.obj.edges = edges.value
  c.obj.name = flowName.value
  c.obj.variables = variables.value
  if (c.kind === 'root') {
    r.repeat = repeat.value
    r.boundWindow = boundWindow.value ? { ...boundWindow.value } : null
    r.screen = fileScreen.value
    r.windowRect = fileWindowRect.value
  }
  docs.patchTab(t.id, { name: flowName.value })
}


// 截图/拾取
const capVisible = ref(false)
const capMode = ref<'region' | 'point' | 'rect'>('region')

// 匹配结果
const matchVisible = ref(false)
const matchImage = ref('')
const pickingVisible = ref(false)
const mousePos = ref({ x: 0, y: 0 })
// 模板管理
const tplPreview = ref('')
const tplPreviewId = ref('')
const renameVisible = ref(false)
const renameText = ref('')
// 按键录制
const keyRecording = ref(false)

// 缩放/平移实例
let vf: any = null

const fileInput = ref<HTMLInputElement | null>(null)
let nodeSeq = 0

function currentScreen() {
  const dpr = window.devicePixelRatio || 1
  return {
    width: Math.round(window.screen.width * dpr),
    height: Math.round(window.screen.height * dpr),
  }
}

function currentWindowRect(): WindowInfo['rect'] | null {
  if (!boundWindow.value) return null
  const w = eng.windows.find((x) => x.hwnd === boundWindow.value!.hwnd)
  return w ? w.rect : null
}

function flowWindow() {
  if (!boundWindow.value) return null
  return {
    hwnd: boundWindow.value.hwnd,
    title: boundWindow.value.title,
    rect: fileWindowRect.value ?? currentWindowRect(),
  }
}

const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedId.value) || null)
const selectedSimple = computed(()=>simpleMode.value ? projection.value.recipes.get(selectedId.value || '') : undefined)
const selectedSimpleClick = computed(()=>nodes.value.find(n=>n.id===selectedSimple.value?.clickId))
const visibleVariables = computed(()=>{
  const map=new Map<string,VarItem>()
  const r=root.value,t=tab.value
  if(r) for(const v of r.variables || []) map.set(v.name,v)
  let current:any=t?.scriptId?r?.scripts[t.scriptId]:r
  if(t?.scriptId) for(const v of current?.variables || []) map.set(v.name,v)
  for(const id of t?.groupPath || []) {current=current?.nodes?.find((n:any)=>n.id===id)?.data?.params;for(const v of current?.variables || []) map.set(v.name,v)}
  for(const v of variables.value) map.set(v.name,v)
  if(selectedId.value)for(const scope of variableScopes.value.filter(s=>s.id&&(s.visibleIds || s.ids).has(selectedId.value)).sort((a,b)=>b.ids.size-a.ids.size))for(const v of scope.owner?.variables || [])map.set(v.name,v)
  return [...map.values()].map(v=>({label:`${v.name} · ${v.type}`,value:v.name,type:v.type}))
})
const paletteNodes = computed(()=>simpleMode.value ? SIMPLE_TYPES.map(t=>[t,{...NODE_META[t as NodeType],...(t==='parallel'?{label:'同时执行'}:{})}] as [NodeType,typeof NODE_META[NodeType]]) : nodesOfCategory(paletteCat.value).filter(([t])=>t!=='scope'))
function editSimple(change:any) {
  if(project.running || !selectedSimple.value) return
  try {pushHistory();const result=updateSimpleImage(nodes.value,edges.value,selectedId.value!,change);nodes.value=result.nodes;edges.value=result.edges;mirrorToStore();pushHistory()} catch(e:any){message.warning(e.message)}
}
function addSimpleJudge() {
  if(project.running) return
  pushHistory();const id=`n${++nodeSeq}`,card=createSimpleImage(id,pasteAnchor(),'image_judge','real')
  nodes.value.push(...card.nodes);edges.value.push(...card.edges);selectedId.value=id;mirrorToStore();pushHistory()
}
function openGlobalVariables() {
  if(!tab.value) return
  docs.activeId=tab.value.rootId
  dock.open('variables')
}
const overview = computed(()=>{
  const result:{scope:string;name:string;type:string;value:string}[]=[]
  const walk=(raw:any,path:string)=>{
    for(const v of raw.variables || []) result.push({scope:path,...v})
    for(const n of raw.nodes || []) if(['group','scope','parallel'].includes(n.data?.nodeType)) {walk(n.data.params,`${path} / ${n.data.params.name || n.id}`);for(const b of n.data.params.branches || [])walk({variables:b.variables},`${path} / ${n.id} / ${b.name}`)}
  }
  const r=root.value
  if(r) {walk({...r,...(!isSub.value&&!isGroup.value?{nodes:nodes.value,variables:variables.value}:{})},'全局');for(const s of Object.values(r.scripts)) walk(s,`子脚本 / ${s.name}`)}
  return result
})
const currentTiming = computed(()=>{
  const raw={...container()?.obj,name:flowName.value,nodes:nodes.value,edges:edges.value}
  const main=containerTimeline(raw,timelineContext.value,root.value?.scripts || {},timelineChoices.value)
  if(selectedId.value&&!main.spans.some(s=>s.source.nodeId===selectedId.value)){
    const plan=compileProjectTimeline({...raw,scripts:root.value?.scripts || {}},{context:timelineContext.value,branches:timelineChoices.value})
    return plan.sections.find(s=>s.spans.some(v=>v.source.nodeId===selectedId.value&&v.source.scriptId===timelineContext.value.scriptId)) || main
  }
  return main
})
const searchData=computed(()=>({...root.value,...(!isSub.value&&!isGroup.value?{name:flowName.value,nodes:nodes.value,edges:edges.value}:{}),scripts:{...root.value?.scripts,...(isSub.value?{[tab.value!.scriptId]:{...container()?.obj,name:flowName.value,nodes:nodes.value,edges:edges.value}}:{})}}))
function locateSearch(source:TimelineSource){locateTimelineNode(source);dock.open('timeline')}
watch(simpleMode,()=>{advancedParams.value=false;if(simpleMode.value && selectedId.value) selectedId.value=projection.value.owner.get(selectedId.value) || selectedId.value;nextTick(fitView)})
watch(selectedId,()=>{advancedParams.value=false})
watch(focusedFork,f=>{if(f)focusedForkId.value=f.id})

// 画布上所有「键鼠录制」节点（工具栏的拆分入口据此决定可用状态）
const macroNodes = computed(() => nodes.value.filter((n) => n.data.nodeType === 'record'))

// ---------- 子脚本（脚本库）----------
/** 当前脚本内的子脚本列表（响应式：改名/新增/删除都要立刻反映到下拉框） */
const scriptList = computed(() => {
  const t = tab.value
  return t ? docs.scriptIndex[t.rootId] || [] : []
})
/** 本视图所属的"脚本身份"：根脚本用 ROOT_NODE，子脚本用它的 id */
const selfScriptId = computed(() => (isSub.value ? tab.value!.scriptId : ROOT_NODE))

/** 子脚本名字（找不到就退回 id，配合"脚本不存在"提示） */
function scriptName(id: string): string {
  const t = tab.value
  if (!t) return id
  const r = docs.getRoot(t.rootId)
  return r?.scripts?.[id]?.name || id
}

/** 当前脚本的调用关系图（含根脚本） */
function callGraph() {
  return buildGraph({ nodes: nodes.value }, root.value?.scripts || {}, true)
}

const scriptPickerVisible = ref(false)
/** 正在挑选/新建子脚本的那个「调用脚本」节点 id（空串表示面板未指向任何节点） */
const scriptPickerTarget = ref('')
/** 「导入已有脚本」用的隐藏 file input */
const subFileInput = ref<HTMLInputElement | null>(null)

/** 子脚本重命名弹窗（与"重命名模板"分开两个弹窗，避免共用一份文本状态互相串） */
const scriptRenameVisible = ref(false)
const scriptRenameId = ref('')
const scriptRenameText = ref('')

/** 某个 script_id 对应的子脚本是否存在（不存在时节点要显示"脚本不存在"）。
 *  读的是响应式的 scriptList，所以 StepNode 里用到它的地方会跟着脚本库变化重绘。 */
function scriptExists(id: string): boolean {
  if (!id) return false
  return scriptList.value.some((s) => s.id === id)
}

// 下发给 StepNode：「调用脚本」节点据此显示"脚本不存在"
provide('scriptExists', scriptExists)

/** 在节点上设置要调用的子脚本（带**编辑时防环**：第一道防线）。 */
function assignScript(node: any, scriptId: string): boolean {
  const t = tab.value
  if (!t || !node) return false
  const graph = callGraph()
  // 准备加一条 self → scriptId：若从 scriptId 出发已经能走回自己，加了就成环
  const cycle = wouldCreateCycle(graph, selfScriptId.value, scriptId)
  if (cycle) {
    const names = new Map(scriptList.value.map((s) => [s.id, s.name] as const))
    names.set(ROOT_NODE, flowName.value)
    message.error(
      `无法调用「${scriptName(scriptId)}」，这会形成循环调用：\n${chainText(cycle, (id) => names.get(id) || id)}\n请修改脚本调用关系。`,
      { duration: 12000 },
    )
    return false
  }
  node.data.params.script_id = scriptId
  node.data.params.name = scriptName(scriptId)
  return true
}

/** 新建一个空白子脚本，并把它挂到指定节点上。 */
function createSubScript(node: any) {
  const t = tab.value
  const r = root.value
  if (!t || !r) return
  const id = docs.newScriptId(t.rootId)
  const name = `子脚本 ${Object.keys(r.scripts).length + 1}`
  docs.putScript(t.rootId, { id, name, nodes: [], edges: [] })
  if (!assignScript(node, id)) {
    // 环检测拒绝（理论上空白脚本不可能成环），把刚建的收回去，别留孤儿
    docs.removeScript(t.rootId, id)
    return
  }
  docs.markDirty(t.rootId)
  docs.openSub(t.rootId, id)
  message.success(`已新建子脚本「${name}」并打开编辑器`)
}

/** 从一个 .agflow 文件导入为子脚本（连同它的子脚本一起搬进来）。 */
function importSubScript(node: any) {
  const t = tab.value
  if (!t) return
  scriptPickerTarget.value = node?.id || ''
  subFileInput.value?.click()
}

function onImportSubFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const t = tab.value
  const r = root.value
  if (!file || !t || !r) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string) as FlowFile
      if (data.format !== 'agflow') throw new Error('不是有效的 AutoTool 脚本文件')
      const node = nodes.value.find((n) => n.id === scriptPickerTarget.value)
      if (!node) return
      const id = docs.newScriptId(t.rootId)
      const innerName = String(data.name ?? '').trim()
      const fileName = String(file.name || '').replace(/\.agflow$/i, '').trim()
      const name = innerName && innerName !== '未命名脚本' ? innerName : fileName || '导入的脚本'
      docs.putScript(t.rootId, {
        id,
        name,
        nodes: data.nodes || [],
        edges: data.edges || [],
      })
      // 它的子脚本也一并嵌入（保持调用关系），并**重新编号**避免与现有 id 撞车
      const imported = normalizeScripts(data.scripts)
      const idMap = new Map<string, string>()
      for (const s of Object.values(imported)) idMap.set(s.id, docs.newScriptId(t.rootId))
      const remap = (arr: any[]) =>
        (arr || []).map((n: any) =>
          n?.data?.nodeType === 'script_call' && idMap.has(n.data.params?.script_id)
            ? {
                ...n,
                data: {
                  ...n.data,
                  params: {
                    ...n.data.params,
                    script_id: idMap.get(n.data.params.script_id),
                    name: imported[n.data.params.script_id]?.name,
                  },
                },
              }
            : n,
        )
      for (const s of Object.values(imported)) {
        docs.putScript(t.rootId, {
          id: idMap.get(s.id) as string,
          name: s.name,
          nodes: remap(s.nodes),
          edges: s.edges || [],
        })
      }
      if (!assignScript(node, id)) {
        for (const nid of idMap.values()) docs.removeScript(t.rootId, nid)
        docs.removeScript(t.rootId, id)
        return
      }
      docs.markDirty(t.rootId)
      message.success(
        `已导入子脚本「${name}」${imported && Object.keys(imported).length ? `（含 ${Object.keys(imported).length} 个下级子脚本）` : ''}`,
      )
    } catch (err: any) {
      message.error('导入失败：' + err.message)
    }
  }
  reader.readAsText(file)
}

/** 把某个子脚本单独导出成 .agflow（它自己也是一份合法脚本）。 */
async function exportSubScript(scriptId: string) {
  const t = tab.value
  const r = root.value
  if (!t || !r) return
  const s = r.scripts[scriptId]
  if (!s) {
    message.warning('这个子脚本不存在')
    return
  }
  const payload = {
    name: s.name,
    repeat: repeat.value,
    window: flowWindow(),
    screen: fileScreen.value ?? currentScreen(),
    nodes: s.nodes || [],
    edges: s.edges || [],
    // 子脚本自己的「局部变量」导出成独立文件后，就成了那份文件的全局变量
    variables: Array.isArray(s.variables) ? cloneData(s.variables) : [],
    scripts: {},
  }
  const ok = await saveJsonToFile({
    format: 'agflow',
    version: 6,
    ...payload,
  } as FlowFile)
  if (ok) message.success(`已导出子脚本「${s.name}」`)
}

/** 清掉所有指向某个子脚本的调用（删除子脚本时用）。 */
function clearScriptRefs(scriptId: string) {
  for (const n of nodes.value) {
    if (n?.data?.nodeType === 'script_call' && n.data.params?.script_id === scriptId) {
      n.data.params.script_id = ''
      n.data.params.name = ''
    }
  }
}

function removeSubScript(scriptId: string) {
  const t = tab.value
  if (!t) return
  const used = nodes.value.filter(
    (n) => n?.data?.nodeType === 'script_call' && n.data.params?.script_id === scriptId,
  ).length
  if (used) {
    message.warning(`本脚本里还有 ${used} 处调用它，已一并清空这些调用`)
    clearScriptRefs(scriptId)
  }
  docs.removeScript(t.rootId, scriptId)
  docs.markDirty(t.rootId)
  message.success('子脚本已删除')
}

/** 打开某个子脚本的编辑器标签（已打开则聚焦）。 */
function openScriptTab(scriptId: string) {
  const t = tab.value
  if (!t || !scriptId) return
  docs.openSub(t.rootId, scriptId)
}

/**
 * 打开某个「组合节点」的编辑器标签（双击画布上的组合节点）。
 *
 * 路径是**逐层累加**的：在一张组合节点内部再双击里层的组合节点时，
 * 新标签的 groupPath = 当前标签的路径 + 这个节点 id。
 */
/**
 * 双击节点：
 *  · 「调用脚本」→ 打开它指向的子脚本
 *  · 「组合节点」→ 打开它内部的编辑界面
 *  · 其它      → 不做任何事（保持和以前一致）
 */
function onNodeDoubleClick(payload: any) {
  const n = payload?.node
  if (!n) return
  selectedId.value = n.id
  if(n.data?.foldMembers?.length || ['parallel','scope'].includes(n.data?.nodeType)){toggleRegion(nodes.value.find(v=>v.id===n.id));return}
  if(n.data?.nodeType===GROUP_TYPE){const f=flattenGraph(nodes.value,edges.value);nodes.value=f.nodes;edges.value=f.edges;return}
  if (n?.data?.nodeType !== 'script_call') return
  const sid = n.data?.params?.script_id
  if (sid && scriptExists(sid)) openScriptTab(sid)
  else openScriptPicker()
}

/** 打开调用脚本节点右侧的挑选面板。 */
function openScriptPicker() {
  if (!selectedNode.value || selectedNode.value.data.nodeType !== 'script_call') return
  scriptPickerTarget.value = selectedNode.value.id
  scriptPickerVisible.value = true
}

function onScriptPicked(scriptId: string) {
  const node = nodes.value.find((n) => n.id === scriptPickerTarget.value) || selectedNode.value
  if (!node) return
  if (!assignScript(node, scriptId)) return
  scriptPickerVisible.value = false
  docs.markDirty(tab.value?.rootId || '')
}

/** 子脚本改名：同步到「脚本库」、标签标题，以及所有引用它的调用节点的显示名。 */
function renameScript(scriptId: string, name: string) {
  const t = tab.value
  if (!t) return
  const r = docs.getRoot(t.rootId)
  const s = r?.scripts?.[scriptId]
  if (!s) return
  s.name = name
  docs.refreshScriptIndex(t.rootId)
  const subTab = docs.tabs.find((x) => x.kind === 'sub' && x.rootId === t.rootId && x.scriptId === scriptId)
  if (subTab) docs.patchTab(subTab.id, { name })
  for (const n of nodes.value) {
    if (n?.data?.nodeType === 'script_call' && n.data.params?.script_id === scriptId) {
      n.data.params.name = name
    }
  }
  docs.markDirty(t.rootId)
}

/** 打开子脚本重命名弹窗（输入框预填当前名，改完同步到所有调用点） */
function openScriptRename(scriptId: string) {
  if (!scriptId) return
  scriptRenameId.value = scriptId
  scriptRenameText.value = scriptName(scriptId)
  scriptRenameVisible.value = true
}

function doScriptRename() {
  const name = scriptRenameText.value.trim()
  if (!scriptRenameId.value || !name) return
  renameScript(scriptRenameId.value, name)
  scriptRenameVisible.value = false
  message.success(`子脚本已改名：${name}`)
}

/** 删除子脚本前先确认：它会连同里面的所有节点一起消失，而且调用点会被清空。 */
function confirmRemoveSubScript(scriptId: string) {
  const id = String(scriptId || '')
  if (!id) return
  const used = nodes.value.filter(
    (n) => n?.data?.nodeType === 'script_call' && n.data.params?.script_id === id,
  ).length
  dialog.warning({
    title: '删除这个子脚本？',
    content:
      `「${scriptName(id)}」会从本脚本里删除，里面的所有节点一起丢失。` +
      (used ? `本脚本里还有 ${used} 处调用它，那些调用会被一并清空。` : '') +
      '删除子脚本不在撤销范围内（Ctrl+Z 只覆盖画布上的节点增删改），请先导出备份。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => removeSubScript(id),
  })
}

/** 本视图里所有「调用脚本」节点指向的、已不存在的子脚本 id（用于顶部提示条）。 */
const missingScripts = computed(() => {
  // 显式依赖 scriptList：脚本库是 markRaw 的普通对象，不引用一下就观察不到增删
  const known = new Set(scriptList.value.map((s) => s.id))
  const ids = new Set<string>()
  for (const n of nodes.value) {
    if (n?.data?.nodeType !== 'script_call') continue
    const id = String(n.data.params?.script_id || '')
    if (id && !known.has(id)) ids.add(id)
  }
  return [...ids]
})

const winOptions = computed(() => [
  { label: '不绑定（全局）', value: 0 },
  ...eng.windows.map((w) => ({ label: w.title.slice(0, 40), value: w.hwnd })),
])

/**
 * 取节点的展示信息（标题 / 图标 / 配色）。
 *
 * 0.1.3 起**颜色不再是每个节点一个**，而是"同类节点同色"——六类各一个色，
 * 一眼就能看出一段流程在干什么（输入=蓝 / 视觉=绿 / 流程=青 / 工具=橙 / 数据=紫 / 系统=灰）。
 */
function metaOf(type: string) {
  if (type === GROUP_TYPE) {
    return { label: GROUP_META.label, icon: GROUP_META.icon, color: GROUP_META.color }
  }
  const m = NODE_META[type as NodeType]
  if (!m) return { label: type, icon: 'circle-help', color: '#888' }
  return { label: m.label, icon: m.icon, color: CATEGORY_META[m.category].color }
}

// ---------- 变量（右侧独立的「变量」侧栏）----------
/**
 * 这一层变量叫什么、给谁看。
 *
 * 主脚本那份是**全局变量**（整个工作流可见）；子脚本 / 组合节点各有一份**局部变量**。
 */
const scopeInfo = computed(() => {
  if(managedScope.value.owner)return {title:managedScope.value.label,desc:'该区域及后代可读，写入保留当前作用域。'}
  const k = container()?.kind
  if (k === 'root') {
    return {
      title: '全局变量',
      desc: '整个工作流（含所有子脚本与组合节点）都能读到。要在子脚本里改它，请用「变量」节点并把作用域选成「全局」。',
    }
  }
  const owner = k === 'sub' ? `子脚本「${flowName.value}」` : `组合节点「${flowName.value}」`
  return {
    title: '局部变量',
    desc: `只在${owner}内部有效：读得到全局，写不外泄。要跨层共享就用全局变量。`,
  }
})

function varName(v: VarItem): string {
  return String(v?.name ?? '').trim()
}

/** 新增一条**自定义变量**（名称自动避重；流程变量不在这里加） */
function addVariable() {
  const used = new Set(managedVariables.value.map(varName))
  let n = managedVariables.value.length + 1
  while (used.has(`var${n}`)) n += 1
  managedVariables.value = [...managedVariables.value, { name: `var${n}`, type: 'auto', value: '' }]
}

/** 删掉一条变量声明（同时清掉节点里指向它的绑定，免得留下"节点还在写、变量表里却没有"的幽灵） */
function removeVar(item: VarItem) {
  const idx = managedVariables.value.indexOf(item)
  if (idx < 0) return
  const name = varName(item)
  if(variableReferenced(nodesInScope(managedScope.value),name)) {message.warning('变量仍被节点引用，请先取消引用后再删除');return}
  managedVariables.value = managedVariables.value.filter((_, i) => i !== idx)
  if (name) clearBindings(name)
}

// ---------- 流程变量（节点输出的落点）----------
/**
 * 变量分两类，界面上也分开管：
 *
 *  · **自定义变量** —— 用户点「＋ 新增」自己建的，名字随意，用来攒中间数据；
 *  · **流程变量**   —— 某个节点的输出写进来的。节点**只声明**"我能产出这些"
 *    （见 `nodeSchema` 的 `outputs`），**不会**在创建时自动建变量：
 *    绝大多数输出其实用不到，一建就带一堆变量只是往变量表里倒垃圾。
 *    要哪个，就在该节点的**参数面板**里选/建一个 —— 这时才真的建变量，
 *    并把变量名写回节点参数。
 *
 * 判定方式：某个变量名只要有节点输出绑着，就算流程变量（不额外存标记，
 * 老脚本读进来天然就是对的）。反过来，用户手建的变量永远不会被这里的绑定影响。
 */
interface FlowVarSource {
  nodeId: string
  nodeLabel: string
  outputLabel: string
}

/** 走一遍本层节点（含组合节点内部），收集「变量名 → 谁在写它」。 */
function collectFlowSources(): Map<string, FlowVarSource[]> {
  const out = new Map<string, FlowVarSource[]>()
  const walk = (arr: any[]) => {
    for (const nd of arr || []) {
      const label = metaOf(nd?.data?.nodeType).label
      for (const o of nodeOutputs(nd?.data?.nodeType)) {
        const v = String(nd?.data?.params?.[o.param] ?? '').trim()
        // 含 {{}} 的是"按轮次写不同变量"，静态判断不了，跳过
        if (!v || v.includes('{{')) continue
        const list = out.get(v) || []
        list.push({ nodeId: String(nd?.id ?? ''), nodeLabel: label, outputLabel: o.label })
        out.set(v, list)
      }
    }
  }
  walk(nodesInScope(managedScope.value,true))
  return out
}

const flowSources = computed(() => collectFlowSources())
const flowVarNames = computed(() => new Set(flowSources.value.keys()))

/** 自定义变量（没有任何节点输出绑着它） */
const customVars = computed(() => managedVariables.value.filter((v) => !flowVarNames.value.has(varName(v)) && (!simpleMode.value || !v.name.startsWith('_at_'))))

/** 流程变量 + 它的来源（一个变量可能被多个节点写） */
const flowVars = computed(() =>
  managedVariables.value
    .filter((v) => flowVarNames.value.has(varName(v)))
    .map((v) => ({ item: v, sources: flowSources.value.get(varName(v)) || [] })),
)

/**
 * 补齐声明：老脚本里可能有"节点写了变量、变量表里却没有"的情况
 * （0.1.4 及更早的输出是直接写死的）。补一条声明，界面分类才说得清，
 * 引擎也会按声明初始化初值。只在装载时调用，不会覆盖已有声明。
 */
function ensureBindingsDeclared() {
  const declared = new Set(variables.value.map(varName))
  const missing: VarItem[] = []
  for (const name of flowVarNames.value) {
    if (declared.has(name)) continue
    declared.add(name)
    missing.push({ name, type: 'auto', value: '' })
  }
  if (missing.length) variables.value = [...variables.value, ...missing]
}

/** 变量类型 → 英文片段（拼默认变量名用；变量名保持纯 ASCII，`{{}}` 里引用起来也顺手） */

/**
 * 流程变量的默认名：**节点 key + 节点编号 _ 变量类型 + 输出编号**，全英文。
 *
 * 例：画布上第 3 个节点是「图像识别」（key 为 `find_image`），它的第 2 个输出是数字
 * → `find_image3_Number2`。
 * 同层已有同名变量就加 `_2`、`_3` 后缀 —— 绝不覆盖用户已有的变量。
 */
function defaultFlowVarName(node: any, o: NodeOutput): string {
  return outputName(node,o,visibleVariables.value.map(v=>v.value))
}

const selectedOutputs = computed<NodeOutput[]>(() => {
  const n = selectedNode.value
  if (!n) return []
  return nodeOutputs(n.data.nodeType).filter((o) => outputVisible(o, n.data.params || {}))
})

/** 「输出变量」分区的 ⓘ 说明（面板里不铺这行字） */
const OUTPUTS_HELP =
  '节点能算出来的数据。下拉里的候选会优先列出上下游相邻节点已经建好的变量；点「新建」时若存在可复用的相邻变量会直接复用，没有才按「来源_节点ID_含义」新建（例：image_n3_point）。坐标可以用 {{image_n3_point.x}} / {{image_n3_point.y}} 读取分量。\n不选就不会产生变量，用不到的输出不占变量表。'

/** 某个输出属性当前绑定到哪个变量名（空串 = 还没选）。 */
function outputBound(o: NodeOutput): string {
  const n = selectedNode.value
  return n ? String(n.data.params?.[o.param] ?? '').trim() : ''
}

/** 与某节点直接相连的节点 id（上游 + 下游各一跳） */
function adjacentNodeIds(nodeId: string): Set<string> {
  const out = new Set<string>()
  for (const e of (edges.value as any[]) || []) {
    if (String(e.source) === nodeId) out.add(String(e.target))
    if (String(e.target) === nodeId) out.add(String(e.source))
  }
  return out
}

interface AdjacentVar {
  name: string
  from: string
  type: string
}

/**
 * 相邻节点写过的变量（去重，带来源说明）。
 *
 * 「相邻」只算一线之隔的上下游：隔一个节点的数据流经过中间节点，语义上不构成"同一个值"，
 * 拿来复用反而容易把两段逻辑搅在一起。
 */
const adjacentVars = computed<AdjacentVar[]>(() => {
  const n = selectedNode.value
  if (!n) return []
  const ids = adjacentNodeIds(String(n.id))
  const seen = new Map<string, AdjacentVar>()
  for (const nd of nodes.value) {
    if (!ids.has(String(nd.id))) continue
    const label = metaOf(nd.data.nodeType).label
    for (const o of nodeOutputs(nd.data.nodeType)) {
      const v = String(nd.data.params?.[o.param] ?? '').trim()
      // 含 {{}} 的是"按轮次写不同变量"，静态判断不了，跳过
      if (!v || v.includes('{{') || seen.has(v)) continue
      const decl = variables.value.find((x) => varName(x) === v)
      seen.set(v, { name: v, from: `${label} · ${o.label}`, type: String(decl?.type || 'auto') })
    }
  }
  return [...seen.values()]
})

/** 类型能不能接上：auto 是万能口，两边任一为 auto 就算兼容 */
function typeCompatible(varType: string, outType: string): boolean {
  const a = String(varType || 'auto')
  const b = String(outType || 'auto')
  return a === 'auto' || b === 'auto' || a === b
}

/** 当前输出可复用的相邻变量（按类型过滤） */
function adjacentVarsFor(o: NodeOutput): AdjacentVar[] {
  const t = String(o.type || 'auto')
  return adjacentVars.value.filter((a) => typeCompatible(a.type, t))
}

/**
 * 变量选择器的候选项（每个输出各自算，因为类型不同能复用的范围也不同）。
 *
 * 顺序就是"匹配优先级"：
 *   ① 相邻节点的变量（置顶并标出来源）→ ② 自定义变量 → ③ 其余流程变量。
 * 已在上面的组里出现过的，不在下面重复。
 */
function varPickOptionsFor(o: NodeOutput) {
  const adj = adjacentVarsFor(o)
  const adjNames = new Set(adj.map((a) => a.name))
  const groups: any[] = []
  if (adj.length) {
    groups.push({
      type: 'group',
      key: 'g-adj',
      label: '相邻节点',
      children: adj.map((a) => ({ label: `${a.name} · ${a.from}`, value: a.name })),
    })
  }
  const rest = visibleVariables.value.map(v=>({name:v.value,type:v.type,value:''})).filter(v=>!adjNames.has(v.name))
  const custom = rest.filter((v) => !flowVarNames.value.has(varName(v)))
  const flow = rest.filter((v) => flowVarNames.value.has(varName(v)))
  if (custom.length) {
    groups.push({
      type: 'group',
      key: 'g-custom',
      label: '自定义变量',
      children: custom.map((v) => ({ label: varName(v), value: varName(v) })),
    })
  }
  if (flow.length) {
    groups.push({
      type: 'group',
      key: 'g-flow',
      label: '流程变量',
      children: flow.map((v) => ({ label: varName(v), value: varName(v) })),
    })
  }
  return groups
}

/**
 * 把某个输出绑定到变量名（空串 = 取消绑定）。
 *
 * 目标变量不存在时顺手补一条声明；旧变量若因此再没有任何节点在写，就一起清掉，
 * 这样"在参数面板里取消输出"不会在变量表里留垃圾。
 */
function bindOutput(o: NodeOutput, name: string) {
  const n = selectedNode.value
  if (!n) return
  const declarations=declarationsOfNode(n.id)
  const clean = String(name || '').trim()
  const prev = outputBound(o)
  if (prev === clean) return
  n.data.params[o.param] = clean
  if (clean && !declarations.some((v) => varName(v) === clean)) {
    declarations.push({name:clean,type:o.type || 'auto',value:''})
  }
  if(prev&&!variableReferenced(nodes.value,prev)&&!nodes.value.some(nd=>nodeOutputs(nd.data.nodeType).some(out=>nd.data.params[out.param]===prev))){const index=declarations.findIndex(v=>v.name===prev);if(index>=0)declarations.splice(index,1)}
  markEdited()
}

/**
 * 在参数面板里"新建"一个输出变量。
 *
 * 先看相邻节点有没有能直接用的（同类型）：有就复用，不重复造一条 ——
 * 一个值在上下游之间流转是常态，每次都新建只会让变量表变成垃圾场。
 * 实在没有才按默认规则新建。
 */
function addOutputVar(o: NodeOutput) {
  const n = selectedNode.value
  if (!n || outputBound(o)) return
  const reuse = adjacentVarsFor(o)[0]
  if (reuse) {
    bindOutput(o, reuse.name)
    message.success(`已复用相邻变量「${reuse.name}」（${reuse.from}）`)
    return
  }
  const name = defaultFlowVarName(n, o)
  bindOutput(o, name)
  message.success(`已创建流程变量「${name}」`)
}

/** 下拉框选择（含清空） */
function pickOutputVar(o: NodeOutput, v: string | null) {
  bindOutput(o, v || '')
}

/** 变量改名时，把节点里指向旧名字的输出绑定一起改掉（否则绑定会悄悄断掉）。 */
function renameBindings(prev: string, next: string) {
  const from = String(prev || '').trim()
  const to = String(next || '').trim()
  if (!from || from === to) return
  const walk = (arr: any[]) => {
    for (const nd of arr || []) {
      for (const o of nodeOutputs(nd?.data?.nodeType)) {
        const cur = String(nd?.data?.params?.[o.param] ?? '').trim()
        if (cur === from) nd.data.params[o.param] = to
      }
      const inner = nd?.data?.params?.nodes
      if (Array.isArray(inner)) walk(inner)
    }
  }
  walk(nodesInScope(managedScope.value,true))
}

/** 把一个变量名从所有节点输出上摘掉（删除变量时用） */
function clearBindings(name: string) {
  renameBindings(name, '')
}

/** 变量名输入框：边打边同步绑定（防止改名把节点输出指到一个不存在的变量上）。 */
function onVarNameInput(item: VarItem, val: string) {
  const prev = varName(item)
  if(!val.trim() || managedVariables.value.some(v=>v!==item&&v.name===val.trim())) return
  item.name = val
  const global=!managedScope.value.owner&&container()?.kind==='root'
  renameScopeVariable(nodesInScope(managedScope.value),prev,val,global,true,false,edges.value)
  if(global) for(const script of Object.values(root.value?.scripts || {})) renameScopeVariable(script.nodes,prev,val,true,false,(script.variables || []).some(v=>v.name===prev),script.edges || [])
}

/** 变量名重复检查（重名会让后面的覆盖前面的，必须提醒） */
function duplicateVarNames(): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const v of managedVariables.value) {
    const n = varName(v)
    if (!n) continue
    if (seen.has(n)) dup.add(n)
    seen.add(n)
  }
  return [...dup]
}

// ---------- 属性面板（由参数模式表驱动）----------

/** 当前选中节点的参数模式 */
const currentSchema = computed(() => {
  const t = selectedNode.value?.data?.nodeType as NodeType | undefined
  return t ? NODE_SCHEMA[t] : undefined
})

/** 当前参数下应当显示的字段（按字段自己的 showIf 过滤——同一个节点按模式显示不同参数） */
const visibleFields = computed<NodeField[]>(() => {
  const n = selectedNode.value
  const schema = currentSchema.value
  if (!n || !schema) return []
  return schema.fields.filter((f) => fieldVisible(f, n.data.params || {}) && (!n.data.params.point_var || !['x','y'].includes(f.key)) && (!simpleMode.value || advancedParams.value || !SIMPLE_FIELDS[n.data.nodeType] || SIMPLE_FIELDS[n.data.nodeType].includes(f.key)))
})

/** 条件参数拆开读（左值 / 运算符 / 右值） */
function condPart(key: string, part: 'left' | 'op' | 'right'): any {
  const c = selectedNode.value?.data?.params?.[key]
  if (c && typeof c === 'object') return c[part] ?? ''
  return part === 'op' ? '==' : ''
}

/** 条件参数拆开写；缺字段时补成标准三件套，避免写出半个对象 */
function setCondPart(key: string, part: 'left' | 'op' | 'right', v: any) {
  const n = selectedNode.value
  if (!n) return
  const p = n.data.params
  const c = p[key] && typeof p[key] === 'object' ? { ...p[key] } : { left: '', op: '==', right: '' }
  c[part] = v
  p[key] = c
}

/** 区域参数的显示文本 */
function regionText(key: string): string {
  const r = selectedNode.value?.data?.params?.[key]
  if (!r || typeof r !== 'object') return '未选择区域'
  return `${r.left}, ${r.top}  ·  ${r.width}×${r.height}`
}

/** 正在为哪个参数框选区域（ScreenCapture 回调时写回它） */
const regionFieldKey = ref('')

function openRegionPick(key: string) {
  regionFieldKey.value = key
  capMode.value = 'rect'
  capVisible.value = true
}

function onRect(r: { left: number; top: number; width: number; height: number }) {
  capVisible.value = false
  const n = selectedNode.value
  if (n && regionFieldKey.value) n.data.params[regionFieldKey.value] = { ...r }
}

// ---------- 画布控制 ----------
function onPaneReady(instance: any) {
  vf = instance
  if(selectedId.value===docs.nodeFocus?.nodeId)applyTimelineFocus()
}
function zoomIn() {
  vf?.zoomIn()
}
function zoomOut() {
  vf?.zoomOut()
}
function fitView() {
  nextTick(()=>requestAnimationFrame(()=>vf?.fitView({padding:0.2,maxZoom:1.1})))
}
function pan(dx: number, dy: number) {
  if (!vf) return
  const vp = vf.getViewport()
  vf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom })
}

// ---------- 节点操作 ----------
const pendingEdge=ref<string|null>(null)
const edgeMenu=ref<{id:string;x:number;y:number}|null>(null)
function removeWire(id:string){if(project.running)return;const edge=displayGraph.value.edges.find(e=>e.id===id);const ids=new Set(edge?.originalIds || [id]);edges.value=edges.value.filter(e=>!ids.has(e.id));edgeMenu.value=null}
provide('wireActions',{insert:(id:string)=>{if(project.running)return;edgeMenu.value={id,x:0,y:0};beginWireInsert()},remove:removeWire})
function onEdgeContextMenu({event,edge}:any){event.preventDefault();event.stopPropagation();edgeMenu.value={id:edge.id,x:event.clientX,y:event.clientY};ctxMenu.value=null}
function beginWireInsert(){if(!edgeMenu.value)return;pendingEdge.value=edgeMenu.value.id;edgeMenu.value=null;dock.open('palette')}
function insertParallelOnWire(){if(!edgeMenu.value)return;pendingEdge.value=edgeMenu.value.id;edgeMenu.value=null;addStep('parallel',true)}
function attachInserted(head:string,tail:string){
 const edge=edges.value.find(e=>e.id===pendingEdge.value)
 if(edge){edges.value=edges.value.filter(e=>e!==edge);edges.value.push({...edge,target:head},{id:`${tail}-${edge.target}`,source:tail,target:edge.target})}
 pendingEdge.value=null
}
function addStep(type:NodeType,force=false){
 if(project.running)return
 dock.open('flow')
 if(type==='variable'&&!force){openVarsTab();return}
 if(type==='join'){const fork=focusedFork.value;if(fork){selectTimelineAction(fork.data.params.join_id);dock.open('flow');return};type='parallel'}
 const id=nextNodeId(),pos=pendingEdge.value?(()=>{const e=edges.value.find(e=>e.id===pendingEdge.value),n=nodes.value.find(n=>n.id===e?.source);return n?{x:n.position.x+230,y:n.position.y}:pasteAnchor()})():pasteAnchor()
 if(type==='parallel'){
   const pair=createParallel(id,id+'__join',pos);nodes.value.push(...pair.nodes);edges.value.push(...pair.edges);attachInserted(id,id+'__join');focusedForkId.value=id
 }else if(simpleMode.value&&type==='find_image'){
   const result=createSimpleImage(id,pos);nodes.value.push(...result.nodes);edges.value.push(...result.edges)
   if(pendingEdge.value){const e=edges.value.find(e=>e.id===pendingEdge.value);if(e){edges.value=edges.value.filter(v=>v!==e);edges.value.push({...e,target:id});edges.value=connectSimple(nodes.value,edges.value,{source:id,target:e.target,sourceHandle:null})}pendingEdge.value=null}
 }else{
   const meta=metaOf(type);nodes.value.push({id,type:'step',position:pos,data:{nodeType:type,label:meta.label,params:defaultsFor(type),once:false}});attachInserted(id,id)
 }
 selectedId.value=id;mirrorToStore()
}
function onCanvasMove(e: MouseEvent) {
  mousePos.value = { x: e.clientX, y: e.clientY }
}

/** 当前选中集合的 id（以 Vue Flow 实例为准，见 refreshSelection 的注释）。 */
function selectionIds(): string[] {
  const list: any = (vf as any)?.getSelectedNodes
  const ids=Array.isArray(list)&&list.length ? list.map((n:any)=>n.id) : selIds.value.length ? [...selIds.value] : selectedId.value ? [selectedId.value] : []
  const expanded=new Set<string>(ids.flatMap((id:string)=>simpleMode.value?projection.value.recipes.get(id)?.ids || [id]:[id]))
  for(const id of [...expanded]){const n=nodes.value.find(n=>n.id===id);if(!n)continue;for(const child of n.data.foldMembers || [])expanded.add(child);const f=n.data.nodeType==='join'?nodes.value.find(f=>f.data.params.join_id===id):n;if(['parallel','scope'].includes(f?.data.nodeType)){expanded.add(f.id);expanded.add(f.data.params.join_id);regionBranches(nodes.value,edges.value,f).forEach((b:any)=>b.ids.forEach((v:string)=>expanded.add(v)))}}
  return [...expanded]
}

/** 删除当前选中的单个节点（右侧属性面板的「删除」按钮）。 */
function removeSelected() {
  if (!selectedId.value) return
  const ids=new Set(simpleMode.value ? projection.value.recipes.get(selectedId.value)?.ids || [selectedId.value] : [selectedId.value]);const r=removeCanvasNodes(nodes.value,edges.value,ids);nodes.value=r.nodes;edges.value=r.edges
  selectedId.value = null
  selIds.value = []
}

/** 批量删除：一次删掉所有选中的流程（工具栏「删除」按钮 / Delete 键）。 */
function deleteSelected() {
  const ids = selectionIds()
  if (!ids.length) {
    message.warning('请先在画布上选中要删除的节点（左键拖拽框选，或 Ctrl+点击逐个加选）')
    return
  }
  const idSet = new Set(ids)
  nodes.value = nodes.value.filter((n) => !idSet.has(n.id))
  edges.value = edges.value.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
  selectedId.value = null
  selIds.value = []
  message.success(`已删除 ${ids.length} 个节点`)
}

// ---------- 复制 / 剪切 / 粘贴（可跨编辑器）----------
// 片段逻辑在 lib/clipFragment.ts（纯函数）；这里只负责「从画布取、往画布放」。
function copySelection(quiet = false): boolean {
  const ids = selectionIds()
  if (!ids.length) {
    if (!quiet) message.warning('请先选中要复制的节点')
    return false
  }
  const frag = extractFragment(nodes.value, edges.value, ids)
  if (!frag) return false
  clip.put(frag, flowName.value)
  if (!quiet) message.success(`已复制 ${ids.length} 个节点（可切到另一个编辑器粘贴）`)
  return true
}

function cutSelection() {
  if (!copySelection(true)) {
    message.warning('请先选中要剪切的节点')
    return
  }
  deleteSelected()
}

/** 粘贴位置：鼠标所在的画布坐标；拿不到就退回选中节点右下角一点。 */
function pasteAnchor(): { x: number; y: number } {
  if (vf && typeof vf.screenToFlowCoordinate === 'function') {
    try {
      const p = vf.screenToFlowCoordinate({ x: mousePos.value.x, y: mousePos.value.y })
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: Math.round(p.x), y: Math.round(p.y) }
    } catch {
      /* ignore */
    }
  }
  const base = selectedNode.value?.position
  return base ? { x: Math.round(base.x + 40), y: Math.round(base.y + 40) } : { x: 80, y: 80 }
}

function pasteClipboard() {
  const frag = clip.take()
  if (!frag) {
    message.warning('剪贴板里还没有内容：先在画布上选中节点并复制')
    return
  }
  const at = pasteAnchor()
  const { nodes: newNodes, edges: newEdges } = materializeFragment(frag, at, () => `n${++nodeSeq}`)
  nodes.value = [...nodes.value, ...newNodes]
  edges.value = [...edges.value, ...newEdges]
  selectedId.value = newNodes[0]?.id ?? null
  selIds.value = newNodes.map((n) => n.id)
  message.success(`已粘贴 ${newNodes.length} 个节点${clip.source && clip.source !== flowName.value ? `（来自「${clip.source}」）` : ''}`)
}

// ---------- 画布右键菜单 ----------
// 复制 / 剪切 / 粘贴不再占顶栏，改由「在画布上右键」唤出：
//  · 右键点在节点上 → 复制 / 剪切 / 粘贴（能一次搬走一批，含选中集合内部的连线）
//  · 右键点在空白处 → 只有粘贴，落点就是鼠标位置
// 键盘 Ctrl+C / Ctrl+X / Ctrl+V 依旧可用（见 onHistoryKey）。
//
// 定位用 position: fixed + 鼠标视口坐标，所以菜单放在哪个 DOM 位置都行。
const ctxMenu = ref<{ x: number; y: number; onNode: boolean } | null>(null)
const ctxEl = ref<HTMLElement | null>(null)

const ctxStyle = computed(() => {
  const m = ctxMenu.value
  if (!m) return {}
  // 贴边时往回缩，别让菜单跑出窗口
  const w = 160
  const h = m.onNode ? 128 : 40
  return {
    left: Math.max(6, Math.min(m.x, window.innerWidth - w - 6)) + 'px',
    top: Math.max(6, Math.min(m.y, window.innerHeight - h - 6)) + 'px',
  }
})

function openCtxMenu(x: number, y: number, onNode: boolean) {
  // 粘贴的落点取自 mousePos，右键时把它对齐到按下位置
  mousePos.value = { x, y }
  ctxMenu.value = { x, y, onNode }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

/** 右键落在节点上。不是"选中集合里的成员"就先把它变成唯一选中；
 *  已经在集合里则保留整批 —— 这样框选一批后右键可以直接整批复制。 */
function onNodeContextMenu({ event, node }: any) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  if (!selectionIds().includes(node.id)) {
    const add = (vf as any)?.addSelectedNodes
    if (typeof add === 'function') add.call(vf, [node])
    selectedId.value = node.id
    refreshSelection()
  } else {
    selectedId.value = node.id
  }
  openCtxMenu(event?.clientX ?? mousePos.value.x, event?.clientY ?? mousePos.value.y, true)
}

/** 右键落在空白画布上：只给「粘贴」。（节点的右键已在 node-context-menu 里拦下） */
function onCanvasContextMenu(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest('.vue-flow__node')) return
  openCtxMenu(e.clientX, e.clientY, false)
}

function ctxAction(fn: () => void) {
  closeCtxMenu()
  fn()
}

// 菜单开着时：点到别处 / 按 Esc 就关掉。
// 用捕获阶段的 pointerdown（而不是 click）是为了"点哪都关"，同时放行菜单内部的点击 ——
// 否则菜单会在 click 派发之前被移除，按钮就永远点不上了。
function onCtxDismiss(e: PointerEvent) {
  const t = e.target as Node | null
  if (t && ctxEl.value?.contains(t)) return
  closeCtxMenu()
}

function onCtxKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeCtxMenu()
}

watch(ctxMenu, (m) => {
  if (m) {
    window.addEventListener('pointerdown', onCtxDismiss, true)
    window.addEventListener('keydown', onCtxKey, true)
  } else {
    window.removeEventListener('pointerdown', onCtxDismiss, true)
    window.removeEventListener('keydown', onCtxKey, true)
  }
})

// 切换标签 / 关闭本编辑器时别把菜单留在屏幕上
watch(
  () => props.active,
  (on) => {
    if (!on) closeCtxMenu()
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onCtxDismiss, true)
  window.removeEventListener('keydown', onCtxKey, true)
})

function validWire(conn:Connection){
  try{const mapped=cardConnection(nodes.value,edges.value,conn),view=displayGraph.value.nodes.find(n=>n.id===mapped.source);return !connectionIssue(nodes.value.map(n=>n.id===mapped.source&&view?.data.simpleView?view:n),mapped)}catch{return false}
}
function onEdgeUpdate({edge,connection}:any){onConnect(connection,edge.originalIds || [edge.id])}
function onConnect(conn: Connection,replaceIds:string[]=[]) {
  if(project.running) return
  if (!conn.source || !conn.target) return
  try{conn=cardConnection(nodes.value,edges.value,conn)}catch(error:any){message.warning(error.message);return}
  const issue=simpleMode.value?null:connectionIssue(nodes.value,conn);if(issue){message.warning(issue);return}
  const existing=edges.value.filter(e=>!replaceIds.includes(e.id))
  if(simpleMode.value) {try{edges.value=connectSimple(nodes.value,existing,conn as any);autoBindConnection(nodes.value,edges.value,declarationsOfNode(conn.source),conn.source,conn.target)}catch(e:any){message.warning(e.message)}return}
  if(conn.source===conn.target&&nodes.value.find(n=>n.id===conn.source)?.data.nodeType!=='loop')return
  const port=(conn as any).sourceHandle || null
  if(existing.some(e=>e.source===conn.source&&(e.sourceHandle || null)===port&&e.target===conn.target))return
  const next=existing.filter(e=>!(e.source===conn.source&&(e.sourceHandle || null)===port))
  next.push({
    id: `e-${conn.source}-${(conn as any).sourceHandle || 'out'}-${conn.target}`,
    source: conn.source,
    target: conn.target,
    sourceHandle: (conn as any).sourceHandle || null,
  })
  edges.value=next
  const bound=autoBindConnection(nodes.value,edges.value,declarationsOfNode(conn.source),conn.source,conn.target)
  if(bound) message.info(`已传递坐标变量「${bound}」`)
}

function onNodeClick({ node }: any) {
  refreshSelection()
  // 简易投影会在 Vue Flow 同步选择状态时重建对象；点击对象仍是参数面板的来源。
  selectedId.value = node.id
  if (!selIds.value.includes(node.id)) selIds.value = [...selIds.value, node.id]
}

function onPaneClick() {
  selectedId.value = null
  selIds.value = []
}

// 点画布空白处 = 取消选中。
//
// 为什么不能只靠 Vue Flow 的 paneClick：本项目给 <VueFlow> 传了 selection-key-code="true"
// （左键按下即框选），这让内部的 isSelecting 恒为 true →
//   hasActiveSelection = elementsSelectable && (isSelecting || userSelectionActive)
// 恒为 true → 内部 onClick 直接 return，paneClick 永远不发出。
// 所以这里在原生 DOM 上补一次兜底：只要点击落在背景层（不是节点、不是浮层），就清空选中。
function onCanvasAreaClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t) return
  if (t.closest('.vue-flow__node, .ctx-menu, .flow-controls')) return
  if (!t.closest('.vue-flow__pane') && !t.closest('.vue-flow__transformationpane')) return
  if (!selectedId.value && !selIds.value.length) return
  selectedId.value = null
  selIds.value = []
}

// 刷新多选集合。
// 注意 @vue-flow/core 1.48.2 的 emits 列表里**没有** selectionChange，只有
// selectionStart / selectionDrag / selectionEnd / nodeClick / paneClick，所以这里不监听
// 「选择变化」，而是在这几个真实存在的事件里主动向 Vue Flow 要一次当前选中集合。
//
// 另一个坑：实例上的 getSelectedNodes 是**数组**（store 里的 computed 已被 reactive 解包，
// 类型定义写的是 `getSelectedNodes: GraphNode[]`），**不是函数**。旧代码写成
// `vf.getSelectedNodes()` 会抛 TypeError 并被下面的 catch 吞掉，于是每次都会退回
// 「遍历 nodes 找 selected」这条兜底 —— 而 v-model 的数组未必及时跟得上内部 store，
// 表现就是「明明框选上了，打包按钮却不亮」。
function refreshSelection() {
  const list: any = (vf as any)?.getSelectedNodes
  const ids: string[] = Array.isArray(list)
    ? list.map((n: any) => n.id)
    : nodes.value.filter((n: any) => n.selected).map((n) => n.id)
  selIds.value = ids
  // 让右侧属性面板跟着选择走：
  //  · 全清空 → 面板清空
  //  · 当前面板对象已不在选中集合里（例如刚框选了另一批）→ 换到集合里的第一个
  //  · 面板对象仍在集合里 → 保持不动，多选时面板不会来回跳
  if (ids.length === 0) {
    selectedId.value = null
  } else if (!selectedId.value || !ids.includes(selectedId.value)) {
    selectedId.value = ids[0]
  }
}

// ---------- 撤销 / 重做 ----------
// 实现方式是**快照式历史**，而不是在每个修改点手动入栈。
// 原因：画布上会改 nodes/edges 的地方远不止我们自己的那几个函数——Vue Flow
// 自己就会改（Delete 键删节点/连线、拖动坐标），属性面板里还有一堆直接
// v-model 到 params 的输入框。逐个包起来必然漏，漏掉的那部分就会表现为
// 「撤销时灵时不灵」。改成「深度监听 + 防抖 + 按内容去重」后，所有改动路径
// 都被同一套机制覆盖，也不需要去猜哪些操作算“一步”。
const HISTORY_MAX = 60
const HISTORY_DEBOUNCE_MS = 350

interface Snapshot {
  json: string
  nodes: any[]
  edges: any[]
  selectedId: string | null
  variables?: VarItem[]
}

const history = ref<Snapshot[]>([])
const hIndex = ref(-1)
const canUndo = computed(() => hIndex.value > 0)
const canRedo = computed(() => hIndex.value < history.value.length - 1)
// 应用快照期间不要记录历史（否则撤销本身会被记成一步，撤销就再也回不去）
let restoring = false
/**
 * 首次装载（新建 / 加载 / 就地替换）期间不要标"未保存"。
 *
 * 装载会把 nodes / flowName / variables 等 ref 重新赋值，随后各 watcher 会照常触发一次；
 * 若不区分，刚打开的脚本会立刻显示成"有改动"。装载完成后的下一个 tick 才置 true。
 */
let ready = false
let histTimer: ReturnType<typeof setTimeout> | null = null

function cloneData<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T
}

/** 只保留流程语义字段。
 *  Vue Flow 会往节点上挂 dimensions / selected / dragging / handleBounds 等
 *  运行时属性，若不剔除，随便点一下选中就会产生"看起来变了"的假快照，
 *  历史很快被这些噪音填满，真正要撤销的改动反而被挤出去。 */
function snapshotOf(): Snapshot {
  const ns = nodes.value.map((n: any) => ({
    id: n.id,
    type: n.type ?? 'step',
    position: { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) },
    data: cloneData(n.data),
  }))
  const es = edges.value.map((e: any) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
  }))
  const vars=cloneData(variables.value)
  return { json: JSON.stringify({ ns, es, vars }), nodes: ns, edges: es, variables:vars,selectedId: selectedId.value }
}

function pushHistory(force = false) {
  if (restoring) return
  const snap = snapshotOf()
  const top = history.value[hIndex.value]
  if (!force && top && top.json === snap.json) return
  // 真正的内容改动才标"未保存"（force=true 是新建 / 加载时的初始化，不算改动）
  if (!force) markEdited()
  // 撤销之后又做了新改动 → 丢弃原来的「未来」分支
  if (hIndex.value < history.value.length - 1) history.value = history.value.slice(0, hIndex.value + 1)
  history.value.push(snap)
  if (history.value.length > HISTORY_MAX) history.value.shift()
  hIndex.value = history.value.length - 1
}

/**
 * 标"有未保存的改动"。
 *
 * 本标签 + 所属根脚本标签都要标：子脚本 / 组合节点的内容随根脚本文件一起保存，
 * 所以它们的改动同样让根文件变脏（关标签时的确认弹窗据此触发）。
 */
function markEdited() {
  if (!ready) return
  const t = tab.value
  if (!t) return
  docs.patchTab(t.id, { dirty: true })
  if (t.kind !== 'root') docs.patchTab(t.rootId, { dirty: true })
}

/** 重置历史（新建 / 加载脚本时调用）：撤销不应该跨脚本跳回上一个流程。 */
function resetHistory() {
  history.value = []
  hIndex.value = -1
  pushHistory(true)
}

function applySnapshot(snap: Snapshot) {
  if (!snap) return
  restoring = true
  nodes.value = snap.nodes.map((n) => ({ ...n, position: { ...n.position }, data: cloneData(n.data) }))
  edges.value = snap.edges.map((e) => ({ ...e }))
  if(snap.variables) variables.value=cloneData(snap.variables)
  selectedId.value = snap.nodes.some((n) => n.id === snap.selectedId) ? snap.selectedId : null
  // id 计数器必须跟上：否则撤销后再新增节点会和历史里的节点撞 id
  nodeSeq = snap.nodes.reduce((m, n) => Math.max(m, Number(String(n.id).replace(/^n/, '')) || 0), 0)
  nextTick(() => {
    restoring = false
    mirrorToStore()
    refreshSelection()
    loadFlowToEngine()
  })
}

function undo() {
  if (!canUndo.value) {
    message.info('没有可撤销的改动了')
    return
  }
  hIndex.value -= 1
  applySnapshot(history.value[hIndex.value])
}

function redo() {
  if (!canRedo.value) {
    message.info('没有可重做的改动了')
    return
  }
  hIndex.value += 1
  applySnapshot(history.value[hIndex.value])
}

// 深度监听 + 防抖：拖动节点、连续输入参数会被合并成一步，而不是几十步
watch(
  [nodes, edges,variables],
  () => {
    if (restoring) return
    mirrorToStore()
    if (histTimer) clearTimeout(histTimer)
    histTimer = setTimeout(() => { pushHistory() }, HISTORY_DEBOUNCE_MS)
  },
  { deep: true },
)

// 元信息（脚本名 / 轮数 / 变量 / 绑定窗口）也要实时镜像，否则保存时读到旧值。
// variables 是数组，改动（改名/改值/增删）要 deep 才观察得到。
watch(
  [flowName, repeat, boundWindow, fileScreen, fileWindowRect, variables],
  () => {
    if (restoring) return
    mirrorToStore()
    markEdited()
  },
  { deep: true },
)

// 键盘：Ctrl+Z 撤销、Ctrl+Y（或 Ctrl+Shift+Z）重做、Ctrl+C/X/V 复制剪切粘贴、Delete 删除选中。
// 输入框内不拦截：那里让浏览器做原生的文本编辑更符合直觉。
//
// ⚠️ 所有标签的编辑器实例都挂在同一个 window 上，必须只让**当前活动标签**响应，
// 否则在 A 脚本里按 Ctrl+V 会同时粘进 B 脚本。
function onHistoryKey(e: KeyboardEvent) {
  if (!props.active) return
  const t = e.target as HTMLElement | null
  const tag = (t?.tagName || '').toLowerCase()
  const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || !!t?.isContentEditable
  if (inField) return
  const k = e.key.toLowerCase()
  if(t?.closest('.input-timeline')&&(['delete','backspace'].includes(k)||((e.ctrlKey||e.metaKey)&&['v','x'].includes(k))))return

  if (e.ctrlKey || e.metaKey) {
    if (e.altKey) return
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault()
      redo()
    } else if (k === 'c') {
      e.preventDefault()
      copySelection()
    } else if (k === 'x') {
      e.preventDefault()
      cutSelection()
    } else if (k === 'v') {
      e.preventDefault()
      pasteClipboard()
    } else if (k === 's') {
      // Ctrl+S 保存（直接写回原文件，不弹路径）；Ctrl+Shift+S 另存为（弹路径）
      e.preventDefault()
      if (e.shiftKey) saveFlowAs()
      else saveFlow()
    }
    return
  }

  if (k === 'delete' || k === 'backspace') {
    e.preventDefault()
    deleteSelected()
  }
}

/**
 * 节点上"放识别模板"的参数键名（没有则为空串）。
 *
 * 0.1.3 里有好几个节点都带模板：图像识别(template)、等待-等图片(template)、
 * 区域分析-对比参考图(reference)。模板的拾取 / 重命名 / 删除都要**同时**照顾到它们，
 * 所以按「参数模式」推导键名，而不是硬编码 `nodeType === 'find_image'`
 * （0.1.2 就是这么写的，拆出「判断」节点后就漏掉了）。
 */
function templateKeyOf(n: any): string {
  const t = n?.data?.nodeType as NodeType | undefined
  const schema = t ? NODE_SCHEMA[t] : undefined
  if (!schema) return ''
  for (const f of schema.fields) {
    if (f.key !== 'template' && f.key !== 'reference') continue
    if (fieldVisible(f, n.data.params || {})) return f.key
  }
  return ''
}

/** 节点是否带坐标参数（能被「拾取坐标」写入） */
function hasXY(n: any): boolean {
  const t = n?.data?.nodeType as NodeType | undefined
  const schema = t ? NODE_SCHEMA[t] : undefined
  if (!schema) return false
  const keys = schema.fields.map((f) => f.key)
  return keys.includes('x') && keys.includes('y')
}

/** 读出节点当前引用的模板 id（无则空串） */
function nodeTemplateId(n: any): string {
  const k = templateKeyOf(n)
  return k ? String(n.data.params[k] || '') : ''
}

// ---------- 模板 / 坐标拾取 ----------
// 模板列表是全局的（一台机器一份），维护在 engine store 里，多个标签共用一份缓存
function refreshTemplates() {
  return eng.refreshTemplates().then(() => {
    /* 错误已由 store 记入日志 */
  })
}


function openCapture(mode: 'region' | 'point' | 'rect') {
  capMode.value = mode
  capVisible.value = true
}

async function onCaptured(tplId: string) {
  capVisible.value = false
  await eng.refreshTemplates(true)
  const node = selectedNode.value
  const key = templateKeyOf(node)
  if (node && key) {
    node.data.params[key] = tplId
    previewTemplate(tplId)
  }
}

function onPicked(x: number, y: number) {
  if (!pickingVisible.value) return
  pickingVisible.value = false
  const node = selectedNode.value
  if (node && hasXY(node)) {
    node.data.params.x = x
    node.data.params.y = y
    message.success(`已拾取坐标 (${x}, ${y})`)
  }
}

function startPicking() {
  pickingVisible.value = true
  engine.startPick().catch(() => {})
}

function cancelPicking() {
  pickingVisible.value = false
  engine.cancelPick().catch(() => {})
}

async function testMatch() {
  const node = selectedNode.value
  const key = templateKeyOf(node)
  if (!node || !key) return
  if (!node.data.params[key]) {
    message.warning('请先选择模板')
    return
  }
  try {
    const win = boundWindow.value?.hwnd ?? null
    const r = await engine.match(node.data.params[key], node.data.params.threshold, win)
    if (r.found) {
      message.success(`找到目标：(${r.x}, ${r.y})，相似度 ${(r.score * 100).toFixed(1)}%`)
      if (r.annotated) {
        matchImage.value = r.annotated
        matchVisible.value = true
      }
    } else {
      message.warning(`未找到（最高相似度 ${(r.score * 100).toFixed(1)}%）`)
    }
  } catch (e: any) {
    message.error('测试识别失败：' + e.message)
  }
}

// ---------- 模板管理 ----------
async function previewTemplate(id: string) {
  if (!id) {
    tplPreview.value = ''
    tplPreviewId.value = ''
    return
  }
  try {
    const r = await engine.templateImage(id)
    tplPreview.value = r.image
    tplPreviewId.value = id
  } catch (e: any) {
    tplPreview.value = ''
    tplPreviewId.value = ''
  }
}

function openRename() {
  const id = nodeTemplateId(selectedNode.value) || tplPreviewId.value
  if (!id) return
  renameText.value = id
  renameVisible.value = true
}

async function doRename() {
  const id = nodeTemplateId(selectedNode.value) || tplPreviewId.value
  if (!id || !renameText.value.trim()) return
  const newId = renameText.value.trim()
  try {
    const r = await engine.renameTemplate(id, newId)
    message.success('已重命名：' + r.id)
    renameVisible.value = false
    // 更新所有引用旧模板名的节点
    for (const n of nodes.value) {
      const k = templateKeyOf(n)
      if (k && n.data?.params?.[k] === id) {
        n.data.params[k] = r.id
      }
    }
    await refreshTemplates()
    previewTemplate(r.id)
    loadFlowToEngine()
  } catch (e: any) {
    message.error('重命名失败：' + e.message)
  }
}

async function doDeleteTemplate() {
  const id = nodeTemplateId(selectedNode.value) || tplPreviewId.value
  if (!id) return
  try {
    await engine.deleteTemplate(id)
    message.success('已删除模板：' + id)
    tplPreview.value = ''
    tplPreviewId.value = ''
    // 清空所有引用该模板的节点
    for (const n of nodes.value) {
      const k = templateKeyOf(n)
      if (k && n.data?.params?.[k] === id) {
        n.data.params[k] = ''
      }
    }
    await refreshTemplates()
    loadFlowToEngine()
  } catch (e: any) {
    message.error('删除失败：' + e.message)
  }
}

// ---------- 按键录制 ----------
/** 正在为哪个参数键录入按键（属性面板里每个 keys 字段各有自己的录入按钮） */
const keyTarget = ref('')

function startKeyRecord(fieldKey = 'keys') {
  keyTarget.value = fieldKey
  keyRecording.value = true
  window.addEventListener('keydown', onKeyRecordKey)
}

function onKeyRecordKey(e: KeyboardEvent) {
  e.preventDefault()
  e.stopPropagation()
  const k = e.key.toLowerCase()
  if (k === 'control' || k === 'alt' || k === 'shift' || k === 'meta') return
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(k === ' ' ? 'space' : k)
  const keyName = parts.join('+')
  const n = selectedNode.value
  if (n && keyTarget.value) {
    n.data.params[keyTarget.value] = keyName
    message.success('已录入按键：' + keyName)
  }
  finishKeyRecord()
}

function finishKeyRecord() {
  keyRecording.value = false
  keyTarget.value = ''
  window.removeEventListener('keydown', onKeyRecordKey)
}

// 选中节点变化时自动预览模板
watch(selectedNode, (n) => {
  const id = n ? nodeTemplateId(n) : ''
  if (id) previewTemplate(id)
  else {
    tplPreview.value = ''
    tplPreviewId.value = ''
  }
})

// ---------- 窗口绑定 ----------
function refreshWindows() {
  return eng.refreshWindows()
}

function onWindowChange(hwnd: number) {
  selectedWinHwnd.value = hwnd
  if (!hwnd) {
    boundWindow.value = null
  } else {
    const w = eng.windows.find((x) => x.hwnd === hwnd)
    boundWindow.value = w ? { hwnd: w.hwnd, title: w.title } : null
  }
}

// ---------- 保存 / 加载 ----------
/**
 * 组装成 .agflow 的 JSON（含内嵌的子脚本库）。
 *
 * ⚠️ 保存的永远是**整份根脚本**，与当前停在哪个标签无关：0.1.4 起一个根文档下可以有
 * 子脚本标签、组合节点标签，若按"当前标签的 nodes"来写，在子脚本 / 组合节点里点保存
 * 就会把内部图当成主流程写进文件（数据直接被改坏）。所以这里先把当前视图镜像回容器，
 * 再统一取根文档的 nodes/edges/variables。
 */
function buildFile(): FlowFile {
  mirrorToStore()
  const screenRef = fileScreen.value ?? currentScreen()
  const windowRef = fileWindowRect.value ?? currentWindowRect()
  const r = root.value
  const subScripts = r ? normalizeScripts(r.scripts) : {}
  for (const script of Object.values(subScripts)) Object.assign(script, serializeFlowGraph(script.nodes, script.edges))
  return {
    format: 'agflow',
    version: 6,
    name: r?.name || flowName.value,
    repeat: r?.repeat ?? repeat.value,
    window: r?.boundWindow ? { ...r.boundWindow, rect: windowRef } : null,
    screen: screenRef,
    ...serializeFlowGraph(r?.nodes || [], r?.edges || []),
    // 主脚本的「全局变量」声明
    variables: cloneData(r?.variables || []),
    // 子脚本一并写进同一个文件：脚本拖到别的机器上也能完整跑起来
    scripts: subScripts,
  }
}

const SCRIPT_FILE_TYPES = [
  { description: 'AutoTool 脚本', accept: { 'application/json': ['.agflow'] } },
]

/** 当前环境有没有文件系统访问 API（桌面壳的 WebView2 / Chrome 系浏览器都有）。 */
function hasFilePicker(): boolean {
  return typeof (window as any).showSaveFilePicker === 'function'
}

function handleLabel(handle: any): string {
  return String(handle?.name || '脚本文件')
}

/** 弹系统「保存」对话框挑位置。用户取消 / 环境不支持 → null。 */
async function pickSaveHandle(suggestedName: string): Promise<any | null> {
  const w = window as any
  if (!hasFilePicker()) return null
  try {
    return await w.showSaveFilePicker({
      suggestedName: `${suggestedName}.agflow`,
      types: SCRIPT_FILE_TYPES,
    })
  } catch (e: any) {
    if (e && e.name === 'AbortError') return null // 用户取消
    message.error('打开保存对话框失败：' + (e?.message || e))
    return null
  }
}

/** 写进一个已有句柄。句柄失效（文件被删 / 权限被撤）时返回 false。 */
async function writeHandle(handle: any, json: string): Promise<boolean> {
  try {
    const writable = await handle.createWritable()
    await writable.write(json)
    await writable.close()
    return true
  } catch {
    return false
  }
}

/** 兜底：浏览器下载（没有文件系统 API 时；下载目录不弹路径，行为上等同"静默保存"）。 */
function downloadJson(baseName: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${baseName}.agflow`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 把一份脚本 JSON 存成文件 —— **总是弹路径**（导出子脚本用；语义就是"另存为"）。
 * 主流程的保存 / 另存为走下面的 `saveFlow` / `saveFlowAs`。
 */
async function saveJsonToFile(data: FlowFile): Promise<boolean> {
  const json = JSON.stringify(data, null, 2)
  const baseName = data.name || '脚本'
  if (!hasFilePicker()) {
    downloadJson(baseName, json)
    return true
  }
  const handle = await pickSaveHandle(baseName)
  if (!handle) return false
  if (!(await writeHandle(handle, json))) {
    message.error('写文件失败，请换个位置再试')
    return false
  }
  return true
}

/** 保存收尾：记下这次的屏幕 / 窗口参照，并把这批标签标成"已保存"。 */
function finishSave(data: FlowFile, note: string) {
  fileScreen.value = data.screen ?? null
  fileWindowRect.value = data.window?.rect ?? null
  // 存的是整份根脚本（含子脚本 / 组合节点），所以这些标签都算"已保存"
  const t = tab.value
  if (t) {
    docs.patchTab(t.id, { dirty: false })
    if (t.kind !== 'root') docs.patchTab(t.rootId, { dirty: false })
  }
  message.success(note)
}

/**
 * 保存 / 另存为。
 *
 * 0.1.5 起**「保存」不再弹路径选择**：脚本一旦有了对应的磁盘文件（第一次保存时选过、
 * 或者就是从"加载"打开的），之后每次保存都直接写回那个文件。只有三种情况才会弹：
 *  · 第一次保存（还没有对应文件）；
 *  · 点的是「另存为」；
 *  · 原文件已经被删 / 权限被撤销，写不进去了。
 */
async function doSave(asNew: boolean): Promise<void> {
  const data = buildFile()
  const json = JSON.stringify(data, null, 2)
  const baseName = data.name || '脚本'
  const rootId = tab.value?.rootId || ''

  // 没有文件系统 API：只能下载（不弹路径，等于静默保存到下载目录）
  if (!hasFilePicker()) {
    downloadJson(baseName, json)
    finishSave(data, '已下载到浏览器的下载目录')
    return
  }

  const existing = asNew ? null : docs.getFileHandle(rootId)
  if (existing && (await writeHandle(existing, json))) {
    finishSave(data, `已保存到「${handleLabel(existing)}」`)
    return
  }

  // 没有句柄 / 句柄失效 → 让用户选一次位置
  const picked = await pickSaveHandle(baseName)
  if (!picked) return // 用户取消：什么都不动（标签保持"未保存"）
  docs.setFileHandle(rootId, picked)
  if (!(await writeHandle(picked, json))) {
    docs.setFileHandle(rootId, null)
    message.error('保存失败，请换一个位置再试')
    return
  }
  finishSave(data, `已保存到「${handleLabel(picked)}」`)
}

async function saveFlow() {
  await doSave(false)
}

async function saveFlowAs() {
  await doSave(true)
}

/**
 * 打开脚本。
 *
 * 0.1.5 起优先走系统「打开」对话框（`showOpenFilePicker`）而不是隐藏的 file input：
 * 这样能顺便拿到**文件句柄**，之后点「保存」就直接写回这个文件、不用再选路径。
 * 环境不支持时（或打开失败）退回 file input。
 */
async function triggerLoad() {
  const w = window as any
  if (typeof w.showOpenFilePicker !== 'function') {
    fileInput.value?.click()
    return
  }
  try {
    const [handle] = await w.showOpenFilePicker({ multiple: false, types: SCRIPT_FILE_TYPES })
    const file = await handle.getFile()
    loadFileObject(file, handle)
  } catch (e: any) {
    if (e && e.name === 'AbortError') return // 用户取消
    fileInput.value?.click() // 其它原因（权限等）→ 退回传统方式
  }
}

/**
 * 打开脚本文件。
 *
 * 「类浏览器」语义：**当前标签是空白脚本时直接取代它**，而不是再开一个新页 ——
 * 否则每加载一次就多留一个空白页。空白脚本上已有改动痕迹时，先问要不要保存。
 * 当前标签里本来就有流程（不是空白脚本）时才新开一个标签。
 */
function onLoadFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // file input 拿不到文件句柄，所以 handle 传 null（下次保存会弹一次路径）
  if (file) loadFileObject(file, null)
  input.value = ''
}

/** 读一个 File 并打开（handle 非空时会被记成"这份脚本对应的磁盘文件"）。 */
function loadFileObject(file: File, handle: any) {
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string) as FlowFile
      if (data.format !== 'agflow') throw new Error('不是有效的 AutoTool 脚本文件')
      // 脚本名：优先用文件内记录的名字；若为空或是占位名「未命名脚本」，则退回用文件名。
      // （没改名就保存的文件，内部记的就是占位名，此时用文件名才对应你给脚本起的名字）
      const innerName = String(data.name ?? '').trim()
      const fileName = String(file.name || '').replace(/\.agflow$/i, '').trim()
      const name =
        innerName && innerName !== '未命名脚本' ? innerName : fileName || innerName || '未命名脚本'
      openLoaded(data, name, !!data.window, handle)
    } catch (err: any) {
      message.error('加载失败：' + err.message)
    }
  }
  reader.readAsText(file)
}

/** 当前标签能不能被"取代"：必须是根脚本标签，且画布上还没有任何节点 */
function canReplaceCurrent() {
  const t = tab.value
  return !!t && t.kind === 'root' && nodes.value.length === 0 && edges.value.length === 0
}

/** 取代前询问：空白脚本上有改动痕迹，要不要先保存 */
function askSaveBeforeReplace(name: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    dialog.warning({
      title: '当前空白脚本有改动',
      content: `「${name}」画布上还没有节点，但有未保存的改动痕迹。加载新脚本前要先保存它吗？`,
      positiveText: '保存',
      negativeText: '不保存',
      onPositiveClick: () => resolve('save'),
      onNegativeClick: () => resolve('discard'),
      onClose: () => resolve('cancel'),
    })
  })
}

/**
 * 加载进来的脚本：落到当前空白标签（取代）或新开一个标签。
 *
 * `handle`：从系统「打开」对话框打开时带过来的文件句柄 —— 记下来之后，
 * 「保存」就能直接写回同一个文件，不再弹路径。
 */
async function openLoaded(data: FlowFile, name: string, hadWindow: boolean, handle: any = null) {
  // 0.1.2 及更早的脚本在这里升级到 0.1.3 的节点体系：
  // 字段改名（stepType→nodeType）、类型改名（click→mouse…）、以及按规范拆开的
  // 「找图判断」。升级是幂等的，所以再打开一次也不会变样。
  const migrated = migrateScript(data)
  data = migrated.data as FlowFile

  const init = {
    name,
    repeat: data.repeat || 1,
    // 默认全局：不恢复脚本里保存的窗口绑定。
    // 旧文件里的 hwnd 早就失效，直接恢复会让下拉框显示成一个「空进程」并要求手动重选。
    boundWindow: null,
    screen: data.screen ?? null,
    windowRect: null,
    nodes: data.nodes || [],
    edges: data.edges || [],
    // 0.1.4：主脚本的全局变量声明（老文件没有这个字段，按空处理）
    variables: Array.isArray(data.variables) ? data.variables : [],
    scripts: normalizeScripts(data.scripts),
  }
  const t = tab.value
  let id = ''
  if (canReplaceCurrent() && t) {
    if (t.dirty) {
      const act = await askSaveBeforeReplace(t.name)
      if (act === 'cancel') return
      if (act === 'save') {
        await saveFlow()
        // 保存对话框被取消时（仍处于 dirty）不继续，免得把改动直接丢掉
        if (docs.tabs.find((x) => x.id === t.id)?.dirty) return
      }
    }
    if (docs.replaceRoot(t.id, init, name)) id = t.id
  }
  if (!id) id = docs.openRoot(init, name)
  docs.activate(id)
  // 记住"这份脚本对应磁盘上的哪个文件"：从系统「打开」对话框进来时能拿到句柄，
  // 之后「保存」直接写回它、不再弹路径；用 file input 打开的则忘掉旧句柄。
  docs.setFileHandle(id, handle)
  // 载入时就存在的循环依赖：先提示，运行时引擎还会再拦一次
  const bad = findAnyCycle(
    buildGraph({ nodes: data.nodes || [] }, normalizeScripts(data.scripts), true),
  )
  if (bad) {
    const names = new Map(
      Object.values(normalizeScripts(data.scripts)).map((s) => [s.id, s.name] as const),
    )
    message.error(`这个脚本里存在循环调用，无法运行：${chainText(bad, (id2) => names.get(id2) || id2)}`, {
      duration: 9000,
    })
  } else {
    message.success(hadWindow ? '脚本已加载（默认全局绑定，未恢复原窗口）' : '脚本已加载')
  }
}

// 全局快捷键的改键界面已挪到「⚙ 设定 → 快捷键」（见 components/SettingsModal.vue）：
// 它属于"设定"而不是"高频操作"，放在顶栏会挤掉真正的常用按钮。
// 「关于」0.1.2 起也移入设定面板（顶栏只留高频操作）。

// ---------- 运行 ----------
/** Vue Flow 节点 → 引擎节点。
 *
 *  引擎只认扁平的 {id, type, params, once}；Vue Flow 往节点上挂的
 *  dimensions / selected / handleBounds 等运行时属性既没用又会让负载明显变大。
 *  根脚本与子脚本共用这一份转换，避免两处各写一遍后悄悄写歪。
 */
function toGraphNodes(ns: any[]) {
  return ns.map((n) => {
    const type = n.data?.nodeType || n.type
    const params = { ...(n.data?.params || n.params || {}) }
    if (type === GROUP_TYPE) { params.nodes = toGraphNodes(params.nodes || []); params.edges = toGraphEdges(params.edges || []) }
    return { id: n.id, type, params, once: !!(n.data?.once ?? n.once) }
  })
}

function toGraphEdges(es: any[]) {
  return es.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || null,
  }))
}

function flowGraph() {
  return { nodes: toGraphNodes(nodes.value), edges: toGraphEdges(edges.value) }
}

/** 子脚本库 → 引擎负载用的扁平形式。
 *
 *  文件里存的是 Vue Flow 形式（带坐标，才能还原画布布局），
 *  但**下发引擎时必须是扁平形式**，否则执行器读 node["type"] / node["params"] 全是空，
 *  子脚本会静默地什么都不做。
 */
function graphScripts(): Record<string, any> {
  const r = root.value
  if (!r) return {}
  const out: Record<string, any> = {}
  for (const [id, s] of Object.entries(normalizeScripts(r.scripts))) {
    out[id] = {
      id,
      name: s.name,
      nodes: toGraphNodes(s.nodes || []),
      edges: toGraphEdges(s.edges || []),
      // 子脚本自己的「局部变量」：引擎执行到 script_call 时用它初始化子作用域
      variables: Array.isArray(s.variables) ? cloneData(s.variables) : [],
    }
  }
  return out
}

/**
 * 交给引擎的完整负载。
 *
 * 子脚本随负载一起下发（`scripts`），由引擎在执行 script_call 节点时就地展开 ——
 * 因此"调用脚本""组合节点"在运行上与"内联展开"基本等价，区别只是子脚本体面可复用、
 * 可单独编辑导出，而组合节点双击就能进去改。
 */
function runPayload() {
  const graph=flowGraph()
  return {
    client_doc_id: tab.value?.rootId || '',
    repeat_revision: eng.repeatRevisions[tab.value?.rootId || ''] || 0,
    repeat_epoch: eng.repeatEpoch,
    source_script_id: tab.value?.scriptId || '',
    source_group_path:tab.value?.groupPath || [],
    name: flowName.value,
    repeat: repeat.value,
    window: flowWindow(),
    screen: fileScreen.value ?? currentScreen(),
    ...graph,
    // 本层的变量声明（根脚本 = 全局；单独跑子脚本时 = 该子脚本的局部）
    variables: cloneData(variables.value),
    scripts: graphScripts(),
  }
}

/** 运行前的静态防环检查（第二道防线；第一道在添加调用关系时）。 */
function checkCycles(): boolean {
  const graph = buildGraph({ nodes: nodes.value }, root.value?.scripts || {}, true)
  const cycle = findAnyCycle(graph)
  if (!cycle) return true
  const t = tab.value
  const reg = t ? docs.getRoot(t.rootId)?.scripts || {} : {}
  const names = new Map(Object.values(normalizeScripts(reg)).map((s) => [s.id, s.name] as const))
  message.error(
    `检测到脚本循环调用，已拒绝运行：\n${chainText(cycle, (id) => names.get(id) || id)}\n请先修改脚本调用关系。`,
    { duration: 12000 },
  )
  return false
}

async function run() {
  if (nodes.value.length === 0) {
    message.warning('请先添加节点')
    return
  }
  if (!checkCycles()) return
  project.clearLogs()
  try {
    await engine.run(runPayload())
    project.running = true
    if (isSub.value) {
      project.addLog({
        level: 'info',
        message: `单独运行子脚本「${flowName.value}」（使用所属脚本「${root.value?.name || ''}」的循环与窗口设置）`,
        ts: Date.now() / 1000,
      })
    }
  } catch (e: any) {
    message.error('启动失败：' + e.message)
  }
}

async function stop() {
  try {
    const r = await engine.stop()
    // 以引擎返回的真实状态为准：若流程早已结束（假运行），立即解除按钮卡死
    project.running = !!r.running
    project.paused = !!r.paused
  } catch (e: any) {
    message.error('停止失败：' + e.message)
  }
}

// 暂停 / 继续：暂停只是让流程停在下一个检查点，继续后从原地接着跑（不是重新开始）
async function togglePause() {
  try {
    const r = project.paused ? await engine.resume() : await engine.pause()
    project.running = !!r.running
    project.paused = !!r.paused
    if (project.paused) message.info('已暂停（在当前节点结束后生效）')
  } catch (e: any) {
    message.error('切换暂停失败：' + e.message)
  }
}

// 引擎侧的「启动」请求。
// 新版引擎把启停方向的决定权收回自己手里（它才知道 executor 的真实状态）：
// 要停止就直接在引擎侧停掉，要启动才发这条请求——因为只有页面知道画布上最新的流程。
// 所以这里不再自行判断方向，避免两边 running 有偏差时点「停止」反而又启动一次。
function requestRun() {
  if (project.running) return
  run()
}

// ---------- 新建脚本 ----------
// 「新建」= 开一个新的空白标签；但当前标签**本来就是干净的空白脚本**时不再重复开一个，
// 否则连点几次就会攒出一排一模一样的空白页。
function newFlow() {
  if (canReplaceCurrent() && !tab.value?.dirty) return
  docs.openRoot()
}

// ---------- 键鼠录制 ----------
function startRecording() {
  eng.startRecording().catch((e: any) => message.error('启动录制失败：' + e.message))
}

function stopRecording() {
  eng.stopRecording().catch((e: any) => message.error('停止录制失败：' + e.message))
}

function onRecorded(events: any[]) {
  eng.macroRecording = false
  if (!events || events.length === 0) {
    message.warning('录制内容为空')
    return
  }
  const id = `n${++nodeSeq}`
  let pos = { x: 60, y: 80 }
  if (vf && typeof vf.screenToFlowCoordinate === 'function') {
    try {
      const p = vf.screenToFlowCoordinate({ x: mousePos.value.x, y: mousePos.value.y })
      if (p) pos = { x: Math.round(p.x), y: Math.round(p.y) }
    } catch {
      /* ignore */
    }
  }
  nodes.value.push({
    id,
    type: 'step',
    position: pos,
    data: { nodeType: 'record', label: '键鼠录制', params: mergeWithDefaults('record', { events, speed: 1.0 }), once: false },
  } as any)
  selectedId.value = id
  message.success(
    `已录制 ${events.length} 个事件，并生成一个录制节点（可点顶栏「拆分节点」继续编辑）`,
    { duration: 6000 },
  )
  loadFlowToEngine()
}

// ---------- 拆分/打包的布局 ----------
/** 画布可见区域换算成 flow 坐标（用于决定"填多少才叫填满编辑区"）。 */
// 把一段键鼠录制拆成可编辑的流程节点。
// 具体合并规则见 src/lib/macroSplit.ts（纯函数，便于单独验证）。
// nodeArg 省略时作用于当前选中的录制节点（属性面板按钮的用法）。
function splitMacro(nodeArg?: any) {
  const node = nodeArg || selectedNode.value
  if (!node || node.data.nodeType !== 'record' || project.running) return
  try {
    const p = node.data.params || {}
    const split = splitRecording(p.events || [], p.speed ?? 1, p.input_mode || 'real')
    if (!split.nodes.length) { message.warning('没有可转换的事件'); return }
    const count = Number(p.repeat ?? 1)
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('拆分需要确定的 1–1,000 次重复次数')
    const axes=recordingFlow(split.nodes)
    pushHistory()
    node.data = {
      nodeType: GROUP_TYPE, label: '录制流程', once: !!node.data.once,
      params: { name: '录制流程', execution: 'parallel',primary_track:axes[0]?.id||'main',duration_ms: split.duration, repeat: count, variables: [], edges: [],
        nodes:axes.map((axis,index)=>({id:axis.id,type:'step',position:{x:80+index*260,y:80},data:{nodeType:GROUP_TYPE,label:axis.params.name,once:false,params:{...axis.params,nodes:axis.params.nodes.map((action,i)=>({id:action.id,type:'step',position:{x:80+i*COL_PITCH,y:80},data:{nodeType:action.type,label:metaOf(action.type).label,params:mergeWithDefaults(action.type as NodeType,action.params),once:false}}))}}})),
      },
    }
    selectedId.value = node.id
    if (split.warnings.length) message.warning(split.warnings.join('；'), { duration: 8000 })
    message.success(`已拆分为 ${split.nodes.length} 个键鼠动作，保留时间、长按、并发与循环`)
    const flat=flattenGraph(nodes.value,edges.value);const fork=flat.nodes.find(n=>n.id===node.id);if(fork)fork.data.params.timing='unified';const starts:Record<string,number>={};if(fork)for(const b of regionBranches(flat.nodes,flat.edges,fork))for(const n of b.nodes){const action=split.nodes.find(a=>n.id.endsWith('__'+a.id));if(action)starts[n.id]=Number(action.params.timeline.start_ms || 0)};layoutRecording(flat.nodes,flat.edges,node.id,starts);nodes.value=flat.nodes;edges.value=flat.edges;mirrorToStore();pushHistory();openTimeline();nextTick(fitView)
  } catch (error: any) { message.error(error.message || '录制拆分失败') }
}

// 工具栏上的「✂ 拆分节点」入口。
// 之所以要有它：拆分按钮原先只在「选中录制节点」时出现在右侧属性面板里，
// 不在工具栏、也不在左侧节点面板，用户根本找不到。现在流程里只要有录制节点，
// 顶栏就有一个常驻可见的入口。
function splitMacroFromToolbar() {
  const sel = selectedNode.value
  if (sel && sel.data.nodeType === 'record') return splitMacro(sel)
  const list = macroNodes.value
  if (!list.length) {
    message.warning('流程里还没有「键鼠录制」节点：先点「⏺ 开始录制」录一段操作')
    return
  }
  if (list.length > 1) {
    message.warning(`流程里有 ${list.length} 个录制节点，请先在画布上选中要拆分的那个`)
    return
  }
  return splitMacro(list[0])
}

// ---------- 合并节点（把一段流程收成一个「组合节点」）----------

// 当前选中的节点。以 selection-change 记下的 id 为准，并用节点自身的 selected
// 标记兜底（不同 Vue Flow 版本对选择状态的同步方式略有差异）。
const selNodes = computed(() => {
  const byId = nodes.value.filter((n) => selIds.value.includes(n.id))
  const flagged = nodes.value.filter((n: any) => n.selected)
  return flagged.length > byId.length ? flagged : byId
})

/** 把选中的节点按连线顺序排成一条链；不是「一条连续、干净的链」时返回 null。
 *  判定规则见 src/lib/macroSplit.ts 的 orderChain / isCleanSegment（纯函数，可单独断言）。 */
function mergeSelected(){
  if(project.running)return
  try{pushHistory();const id=mergeCard(nodes.value,edges.value,selectionIds());selectedId.value=id;selIds.value=[id];nodes.value.forEach(n=>n.selected=n.id===id);mirrorToStore();pushHistory()}catch(error:any){message.info(error.message)}
}
function toggleRegion(node:any){
  if(node.data.foldMembers?.length){delete node.data.foldMembers;return}
  if(['parallel','scope'].includes(node.data.nodeType)){const ids=regionBranches(nodes.value,edges.value,node).flatMap((b:any)=>[...b.ids]);node.data.foldMembers=[...ids,node.data.params.join_id]}
}
/**
 * 取消组合：把「组合节点」拆回它内部的那串节点（合并节点的逆操作）。
 *
 * 内部节点 id 一律**重新编号**再放回画布：组合节点的内部图可能在别的标签里被编辑过、
 * 加过新节点，直接沿用原 id 有和画布上现有节点撞车的风险。连线按 id 映射同步重写。
 */
function openVarsTab(){dock.open('variables')}
watch(selectedId,id=>{if(id)dock.open('params')})

let loadTimer: ReturnType<typeof setTimeout> | null = null

let lastSyncedJson = ''

/**
 * 把当前脚本同步到引擎（供全局快捷键 / 悬浮框按钮启动）。
 *
 * 只有**活动标签**才同步：引擎侧只缓存一份"当前流程"，后台标签也往里写就会互相覆盖，
 * 于是按快捷键启动的可能是另一个脚本。
 */
function loadFlowToEngine(force = false) {
  if (!props.active) return
  const payload = runPayload()
  // 指纹未变化则跳过，避免每秒全量同步空打引擎
  const json = JSON.stringify(payload)
  if (!force && json === lastSyncedJson) return
  lastSyncedJson = json
  eng.loadCurrentFlow(payload).catch(() => {
    lastSyncedJson = '' // 失败后下次重试
  })
}

/** 强制重新同步（切回本标签时用：期间流程可能被别的标签改过） */
function resyncFlow() {
  lastSyncedJson = ''
  loadFlowToEngine(true)
}

// 流程变化时同步到引擎，供快捷键 alt+f1 启停（直接用 refs 监听 + 短防抖）
watch(
  [nodes, edges, flowName, repeat, boundWindow, variables],
  () => {
    if (loadTimer) clearTimeout(loadTimer)
    loadTimer = setTimeout(loadFlowToEngine, 150)
  },
  { deep: true },
)

let syncTimer: ReturnType<typeof setInterval> | null = null
let stateTimer: ReturnType<typeof setInterval> | null = null

/** 把引擎广播来的页面事件接到本编辑器上。 */
function bindEngineHandlers() {
  eng.setHandlers({
    onRunRequest: requestRun,
    onPicked,
    onRecorded,
    onRepeat: (v) => {
      repeat.value = v
    },
    payload: runPayload,
  })
}

/** 从文档存储里读出初始状态（本编辑器实例第一次挂载时用）。 */
function initFromStore() {
  const t = tab.value
  const r = root.value
  if (!t || !r) return
  const flow = flowOfRoot()
  nodes.value = flow.nodes
  edges.value = flow.edges
  flowName.value = flow.name
  variables.value = flow.variables
  repeat.value = r.repeat
  boundWindow.value = r.boundWindow ? { ...r.boundWindow } : null
  // 默认全局绑定：脚本里存下来的 hwnd 早就失效（旧文件尤其明显），不自动恢复
  selectedWinHwnd.value = 0
  fileScreen.value = r.screen
  fileWindowRect.value = r.windowRect
  // 取现有节点 ID 的最大数字后缀，避免新增节点撞 ID
  nodeSeq = Math.max(
    0,
    ...nodes.value.map((n) => parseInt(String(n.id).replace(/\D/g, ''), 10) || 0),
  )
  ensureBindingsDeclared()
  mirrorToStore()
  resetHistory()

  // 装载触发的那些 watcher 跑完之前，不把这一轮赋值当成"用户改动"
  ready = false
  nextTick(() => {
    ready = true
  })
}

/** 活动标签变化：接管引擎事件、把流程同步给引擎。 */
watch(
  () => props.active,
  (on) => {
    if (on) {
      bindEngineHandlers()
      resyncFlow()
    }
  },
)

/**
 * 文档内容被从外部**就地替换**（「加载」取代了当前空白脚本）。
 *
 * 文档数据放在 store 里且刻意 markRaw（不参与响应式），就地改写它没有任何通知，
 * 所以 store 每次替换都会把一个计数 +1，这里据此重新读一遍。
 */
watch(
  () => docs.rev[props.docId],
  (n) => {
    if (!n) return
    selectedId.value = null
    selIds.value = []
    initFromStore()
    if (props.active) resyncFlow()
  },
)

onMounted(() => {
  initFromStore()
  applyTimelineFocus()
  if (props.active) {
    bindEngineHandlers()
    loadFlowToEngine(true)
  }
  // 定时兜底同步流程到引擎（内部已按指纹去重），确保全局快捷键随时可用
  syncTimer = setInterval(() => loadFlowToEngine(), 1000)
  // 定时同步真实运行状态：任何状态广播丢失都能在一秒内自愈，按钮不再卡死
  stateTimer = setInterval(() => eng.syncRunState(), 1000)
  window.addEventListener('keydown', onHistoryKey)
})
onBeforeUnmount(() => {
  if (syncTimer) clearInterval(syncTimer)
  if (stateTimer) clearInterval(stateTimer)
  if (histTimer) clearTimeout(histTimer)
  window.removeEventListener('keydown', onHistoryKey)
})
</script>

<template>
  <div class="editor">
    <header class="topbar">
      <!-- 左侧：文件操作 + 脚本名。不再放 Logo/品牌名——桌面窗口的标题栏已经写了 AutoTool，
           顶栏那块位置留给真正高频的操作。 -->
      <n-button size="small" @click="newFlow"><AppIcon name="plus" /> 新建</n-button>
      <n-button size="small" @click="triggerLoad"><AppIcon name="folder-open" /> 加载</n-button>
      <n-button size="small" @click="saveFlow"><AppIcon name="save" /> 保存</n-button>
      <n-button size="small" @click="saveFlowAs"><AppIcon name="file" /> 另存为</n-button>
      <input ref="fileInput" type="file" accept=".agflow,application/json" style="display: none" @change="onLoadFile" />
      <input
        ref="subFileInput"
        type="file"
        accept=".agflow,application/json"
        style="display: none"
        @change="onImportSubFile"
      />
      <span class="topbar-divider" />
      <n-input
        v-model:value="flowName"
        class="name-input"
        :placeholder="isSub ? '子脚本名称' : isGroup ? '组合节点名称' : '脚本名称'"
      />
      <span v-if="isSub" class="sub-badge">子脚本 · 属于「{{ root?.name }}」</span>
      <span v-else-if="isGroup" class="sub-badge">组合节点 · 属于「{{ root?.name }}」</span>
      <ProjectSearch :project="searchData" :active="active" @locate="locateSearch" />
      <div class="spacer" />
      <!-- 右侧：循环轮数紧挨着运行按钮。设定齿轮与悬浮框开关在底部控制条上（views/Editor.vue）。 -->
      <span class="tb-label">循环轮数</span>
      <n-input-number
        v-model:value="repeat"
        :min="1"
        :max="99999"
        size="small"
        style="width: 122px"
      />
      <n-button v-if="!project.running" type="primary" @click="run"><AppIcon name="play" /> 运行</n-button>
      <template v-else>
        <n-button :type="project.paused ? 'warning' : 'default'" @click="togglePause">
          <AppIcon :name="project.paused ? 'play' : 'pause'" /> {{ project.paused ? '继续' : '暂停' }}
        </n-button>
        <n-button type="error" @click="stop"><AppIcon name="square" /> 停止</n-button>
      </template>
      <!-- 断线时不再谎报"已停止"：保留最后一次已知的运行状态，这里明说状态未知 -->
      <span v-if="project.running && !eng.connected" class="conn-lost"><AppIcon name="warning" /> 连接中断，状态未知</span>
    </header>

    <!-- 脚本浏览（标签）栏：由外壳以 #tabs 传进来，位置就在这里 —— 文件操作行的正下方 -->
    <slot name="tabs" />

    <!-- 脚本库有问题的提示：缺失的子脚本 / 循环依赖都属于"早点说清楚"的事 -->
    <n-alert v-if="missingScripts.length" type="warning" class="pane-alert" :show-icon="true">
      有 {{ missingScripts.length }} 个「调用脚本」节点指向的子脚本不存在：{{ missingScripts.join('、') }}。
      请重新选择子脚本，或把它从流程里删掉。
    </n-alert>

    <div class="settings-bar">
      <div class="setting">
        <span class="setting-label">绑定窗口</span>
        <n-select
          v-model:value="selectedWinHwnd"
          :options="winOptions"
          size="small"
          style="width: 260px"
          placeholder="选择目标窗口"
          @update:value="onWindowChange"
        />
        <n-button size="small" quaternary aria-label="刷新窗口列表" @click="refreshWindows"><AppIcon name="refresh" /></n-button>
      </div>
      <div class="setting">
        <n-button size="small" type="error" :disabled="!selNodes.length" @click="deleteSelected">
          <AppIcon name="trash" /> 删除{{ selNodes.length > 1 ? ` (${selNodes.length})` : '' }}
        </n-button>
        <n-button size="small" :disabled="!canUndo" @click="undo"><AppIcon name="undo" /> 撤销</n-button>
        <n-button size="small" :disabled="!canRedo" @click="redo"><AppIcon name="redo" /> 重做</n-button>
      </div>
      <div class="setting">
        <n-button
          size="small"
          :type="eng.macroRecording ? 'error' : 'default'"
          @click="eng.macroRecording ? stopRecording() : startRecording()"
        >
          <AppIcon :name="eng.macroRecording ? 'square' : 'record'" /> {{ eng.macroRecording ? '停止录制' : '录制操作' }}
        </n-button>
      </div>
      <!-- 拆分（录制 → 节点）与合并（选中 → 组合节点）是两种"整段流程的整理"操作，
           放在同一个不换行容器里，保证它们始终同一行。 -->
      <div class="setting nowrap-group">
        <n-button
          size="small"
          :disabled="!macroNodes.length"
          @click="splitMacroFromToolbar"
        >
          <AppIcon name="scissors" /> 拆分节点{{ macroNodes.length > 1 ? ` (${macroNodes.length})` : '' }}
        </n-button>
        <n-button size="small" :disabled="!selNodes.length" @click="mergeSelected">
          <AppIcon name="package" /> 合并卡片{{ selNodes.length >= 2 ? ` (${selNodes.length})` : '' }}
        </n-button>
      </div>
    </div>

    <DockWorkspace>
      <template #palette><aside class="palette">

        <button v-if="simpleMode" class="new-timeline-segment" type="button" :disabled="project.running" @click="addSimpleJudge">找图判断（是 / 否）</button>
        <!-- 六大类：上方切换类目，下方列出该类目的节点。
             类目按钮在选中时用该类颜色描边，和画布上节点的配色一一对应。 -->
        <div v-if="!simpleMode" class="cat-tabs">
          <button
            v-for="c in CATEGORY_ORDER"
            :key="c"
            type="button"
            class="cat-tab"
            :class="{ active: paletteCat === c }"
            :style="paletteCat === c ? { borderColor: CATEGORY_META[c].color, color: CATEGORY_META[c].color } : undefined"
            @click="paletteCat = c"
          >
            <span class="cat-tab-icon"><AppIcon :name="CATEGORY_META[c].icon" /></span>
            <span class="cat-tab-label">{{ CATEGORY_META[c].label }}</span>
          </button>
        </div>
        <!-- 节点本身的说明走悬停，左侧栏不再放灰字说明 -->
        <n-tooltip
          v-for="[t, meta] in paletteNodes"
          :key="t"
          :disabled="!meta.hint"
          placement="right"
          :delay="350"
          :style="{ maxWidth: '240px' }"
        >
          <template #trigger>
            <div class="palette-item" @click="addStep(t)">
              <span class="palette-icon" :style="{ background: CATEGORY_META[meta.category].color }"><AppIcon :name="meta.icon" /></span>
              <span>{{ meta.label }}</span>
            </div>
          </template>
          <span class="palette-tip">{{ meta.hint }}</span>
        </n-tooltip>

<div v-if="pendingEdge" class="insert-hint">选择要插入连线的节点<button @click="pendingEdge=null">取消</button></div></aside></template>
      <template #flow><section

        class="canvas"
        @mousemove="onCanvasMove"
        @contextmenu.prevent="onCanvasContextMenu"
        @click="onCanvasAreaClick"
      >
        <VueFlow
          :key="simpleMode ? 'simple' : 'expert'"
          v-model:nodes="canvasNodes"
          v-model:edges="canvasEdges"
          :node-types="nodeTypes"
          :edge-types="edgeTypes"
          :edges-updatable="!project.running"
          :edge-updater-radius="16"
          :is-valid-connection="validWire"
          :connection-line-options="{type:ConnectionLineType.SmoothStep,style:{strokeWidth:2}}"
          :connection-radius="24"
          :min-zoom="0.2"
          :max-zoom="2"
          :fit-view-on-init="false"
          :delete-key-code="null"
          :pan-on-drag="[2]"
          :selection-key-code="true"
          multi-selection-key-code="Control"
          @connect="onConnect"
          @edge-update="onEdgeUpdate"
          @node-click="onNodeClick"
          @node-double-click="onNodeDoubleClick"
          @node-context-menu="onNodeContextMenu"
          @edge-context-menu="onEdgeContextMenu"
          @selection-start="refreshSelection"
          @selection-drag="refreshSelection"
          @selection-end="refreshSelection"
          @pane-click="onPaneClick"
          @pane-ready="onPaneReady"
        >
          <Background :gap="18" />
        </VueFlow>
        <div v-if="nodes.length === 0" class="canvas-empty">
          <div class="empty-emoji"><AppIcon name="workflow" /></div>
          <div>从左侧点击节点开始搭建脚本流程</div>
        </div>

        <div class="flow-controls">
          <button class="ctl" @click="zoomIn"><AppIcon name="zoom-in" /></button>
          <button class="ctl" @click="zoomOut"><AppIcon name="zoom-out" /></button>
          <button class="ctl" @click="fitView"><AppIcon name="maximize" /></button>
          <button class="ctl" @click="pan(120, 0)"><AppIcon name="left" /></button>
          <button class="ctl" @click="pan(-120, 0)"><AppIcon name="right" /></button>
          <button class="ctl" @click="pan(0, 120)"><AppIcon name="up" /></button>
          <button class="ctl" @click="pan(0, -120)"><AppIcon name="down" /></button>
        </div>
      </section></template>
      <template #timeline><section class="timeline-dock" aria-label="时间轴编辑区">
        <InputTimelinePanel
          :show="active && dock.panels.some(p=>p.id==='timeline'&&p.open)"
          :project="searchData"
          :project-id="tab?.rootId || ''"
          :timed="focusedFork?.data.params.timing==='absolute'"
          :parallel="!!focusedFork && (selectedId===focusedFork.id || currentTiming.spans.some(s=>axisLanes.some((b:any)=>b.nodeIds.includes(s.source.nodeId))))"
          :edit-section="currentTiming"
          :tracks="axisLanes"
          :primary-track="focusedFork?.data.params.primary_track || 'main'"
          :edit-nodes="nodes"
          :context="timelineContext"
          :selected-node-id="selectedId"
          :running="project.running"
          :minimum-duration="focusedFork?.data.params.duration_ms || 0"
          :repeat="focusedFork?.data.params.repeat || 1"
          @locate="locateTimelineNode"
          @select="selectTimelineAction"
          @edit="editTimelineAction"
          @settings="editSegmentSettings"
          @view-branches="timelineChoices=$event"
        />
      </section></template>
      <template #params><aside class="inspector insp-shell"><div v-if="selectedNode" class="insp-body params-pane"><div v-if="selectedNode.data.foldMembers?.length" class="field"><label>卡片名称</label><n-input v-model:value="selectedNode.data.foldLabel" size="small" placeholder="合并卡片" /><n-button size="small" @click="toggleRegion(selectedNode)">展开卡片</n-button></div>
          <div class="inspector-head">
            <span class="inspector-title">
              <span class="insp-icon"><AppIcon :name="metaOf(selectedNode.data.nodeType).icon" /></span>
              {{ metaOf(selectedNode.data.nodeType).label }}
              <HintIcon :text="currentSchema?.help" placement="left" />
            </span>
            <n-button size="tiny" quaternary type="error" @click="removeSelected">删除</n-button>
          </div>

          <template v-if="selectedSimple?.kind === 'image'">
            <div class="field field-inline"><label>找到后点击</label><n-switch :value="!!selectedSimple.clickId" @update:value="editSimple({autoClick:$event})" /></div>
            <div v-if="selectedSimpleClick" class="field"><label>点击方式</label><n-select :value="selectedSimpleClick.data.params.button || 'left'" :options="[{label:'左键',value:'left'},{label:'右键',value:'right'},{label:'中键',value:'middle'}]" @update:value="editSimple({button:$event})" /></div>
            <div class="field"><label>找图超时</label><n-select :value="selectedSimple.stopId ? 'exit' : 'skip'" :options="[{label:'跳过，继续后续流程',value:'skip'},{label:'停止整个工作流',value:'exit'}]" @update:value="editSimple({onTimeout:$event})" /></div>
          </template>
          <div v-if="simpleMode && SIMPLE_FIELDS[selectedNode.data.nodeType]" class="field"><button type="button" @click="advancedParams = !advancedParams">{{ advancedParams ? '收起更多参数' : '更多参数' }}</button></div>
          <template v-if="['parallel','scope','join'].includes(selectedNode.data.nodeType)">
 <div v-if="selectedNode.data.nodeType!=='join'" class="field"><label>名称</label><n-input v-model:value="selectedNode.data.params.name" placeholder="执行区域" /></div>
 <div v-if="selectedNode.data.nodeType==='parallel'" class="field"><n-button size="small" @click="openTimeline">编辑执行轴与时间</n-button><n-button size="small" @click="addFlowAxis">新增副轴</n-button></div>
 <div v-if="selectedNode.data.nodeType!=='join'" class="field"><n-button size="small" @click="toggleRegion(selectedNode)">{{selectedNode.data.foldMembers?.length?'展开区域':'折叠区域'}}</n-button></div>
 <div class="meta-line">{{selectedNode.data.nodeType==='join'?'等待配对区域的所有路径完成。':'动作在当前画布直接编辑。双击边界节点折叠或展开。'}}</div>
</template>
<!-- ============ 普通节点 ============ -->
          <template v-else>
            <div
              v-if="!['judge', 'terminate'].includes(selectedNode.data.nodeType)"
              class="field field-inline"
            >
              <label>
                单次执行
                <HintIcon text="只在第一轮循环里执行，之后每轮跳过。" placement="left" />
              </label>
              <n-switch :value="selectedNode.data.once" @update:value="selectedSimple ? editSimple({once:$event}) : selectedNode.data.once=$event" />
            </div>

            <!-- 参数控件由 lib/nodeSchema.ts 的模式表驱动（字段类型 → 控件）。
                 字段说明一律走「ⓘ」悬停，面板里不再铺灰字。 -->
            <div v-if="focusedFork?.data.params.timing==='absolute'" class="field">
              <label>时间轴开始（ms）</label>
              <n-input-number :value="Number(selectedNode.data.params.timeline?.start_ms) || 0" :min="0" :max="86400000" :disabled="project.running" @update:value="editTimelineAction({ nodeId: selectedNode.id, start: $event || 0 })" />
            </div>
            <template v-for="f in visibleFields" :key="f.key">
              <!-- 文本 -->
              <div v-if="f.key === 'point_var'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <n-select :value="selectedNode.data.params.point_var || null" :options="visibleVariables.filter(v=>v.type==='point')" filterable tag clearable placeholder="选择坐标变量，留空使用 X / Y" @update:value="selectedNode.data.params.point_var=$event || ''" />
              </div>
              <div v-else-if="f.type === 'text'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <n-input v-model:value="selectedNode.data.params[f.key]" :placeholder="f.placeholder" />
              </div>

              <!-- 多行文本 -->
              <div v-else-if="f.type === 'textarea'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <n-input
                  v-model:value="selectedNode.data.params[f.key]"
                  type="textarea"
                  :rows="3"
                  :placeholder="f.placeholder"
                />
              </div>

              <!-- 命令行 -->
              <div v-else-if="f.type === 'command'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <n-input
                  v-model:value="selectedNode.data.params[f.key]"
                  type="textarea"
                  :rows="3"
                  class="mono"
                  placeholder="要执行的命令，支持 {{变量名}}"
                />
              </div>

              <!-- 数字 -->
              <div v-else-if="f.type === 'number'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <VariableNumberInput
                  v-model:value="selectedNode.data.params[f.key]"
                  :min="f.min"
                  :max="f.max"
                  :step="f.step ?? 1"
                  :options="visibleVariables.filter(v=>['auto','number'].includes(v.type))"
                />
              </div>

              <!-- 开关 -->
              <div v-else-if="f.type === 'switch'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <n-switch v-model:value="selectedNode.data.params[f.key]" />
              </div>

              <!-- 下拉 -->
              <div v-else-if="f.type === 'select'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <n-select v-model:value="selectedNode.data.params[f.key]" :options="f.options || []" />
              </div>

              <!-- 颜色 -->
              <div v-else-if="f.type === 'color'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <div class="row">
                  <input v-model="selectedNode.data.params[f.key]" type="color" class="color-input" />
                  <n-input v-model:value="selectedNode.data.params[f.key]" style="flex: 1" />
                </div>
              </div>

              <!-- 按键（点「录制」后按下组合键录入） -->
              <div v-else-if="f.type === 'keys'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <div class="row">
                  <n-input :value="selectedNode.data.params[f.key]" placeholder="未设置" readonly style="flex: 1" />
                  <n-button
                    size="small"
                    :type="keyRecording ? 'error' : 'primary'"
                    @click="keyRecording ? finishKeyRecord() : startKeyRecord(f.key)"
                  >
                    {{ keyRecording ? '按下按键…' : '录制' }}
                  </n-button>
                </div>
              </div>

              <!-- 条件：左值 / 运算符 / 右值 -->
              <div v-else-if="f.type === 'condition'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <div class="cond-row">
                  <n-input
                    :value="condPart(f.key, 'left')"
                    placeholder="左值（变量名）"
                    @update:value="(v: string) => setCondPart(f.key, 'left', v)"
                  />
                  <n-select
                    :value="condPart(f.key, 'op')"
                    :options="CONDITION_OPS"
                    class="cond-op"
                    @update:value="(v: string) => setCondPart(f.key, 'op', v)"
                  />
                  <n-input
                    v-if="!UNARY_OPS.includes(condPart(f.key, 'op'))"
                    :value="condPart(f.key, 'right')"
                    placeholder="右值"
                    @update:value="(v: string) => setCondPart(f.key, 'right', v)"
                  />
                </div>
              </div>

              <!-- 识别模板 -->
              <div v-else-if="f.type === 'template'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <div class="row">
                  <n-select
                    v-model:value="selectedNode.data.params[f.key]"
                    :options="eng.templates"
                    placeholder="选择模板"
                    filterable
                    style="flex: 1"
                    @update:value="previewTemplate"
                  />
                  <n-button size="small" @click="openCapture('region')">截取</n-button>
                </div>
              </div>

              <!-- 矩形区域 -->
              <div v-else-if="f.type === 'region'" class="field">
                <label>{{ f.label }} <HintIcon :text="f.hint" placement="left" /></label>
                <div class="row">
                  <span class="region-text">{{ regionText(f.key) }}</span>
                  <n-button size="small" @click="openRegionPick(f.key)">框选</n-button>
                  <n-button size="small" quaternary @click="selectedNode.data.params[f.key] = null">清除</n-button>
                </div>
              </div>
            </template>

            <!-- 带坐标参数的节点：拾取屏幕坐标 -->
            <div v-if="hasXY(selectedNode)" class="field">
              <n-button size="small" block @click="startPicking"><AppIcon name="find" /> 拾取屏幕坐标</n-button>
            </div>

            <!-- 带识别模板的节点：预览 / 重命名 / 删除 / 测试识别 -->
            <template v-if="nodeTemplateId(selectedNode)">
              <div v-if="tplPreview" class="field">
                <label>模板预览</label>
                <img :src="tplPreview" class="tpl-preview" alt="模板预览" />
                <div class="row" style="margin-top: 6px">
                  <n-button size="tiny" @click="openRename">重命名</n-button>
                  <n-button size="tiny" type="error" @click="doDeleteTemplate">删除</n-button>
                </div>
              </div>
              <div class="field">
                <n-button size="small" block @click="testMatch">测试识别</n-button>
              </div>
            </template>

            <!-- ============ 键鼠录制 ============ -->
            <template v-else-if="selectedNode.data.nodeType === 'record'">
              <div class="field">
                <label>
                  录制内容
                  <HintIcon text="录下来的是鼠标点击 / 滚轮 / 键盘按下抬起，不含鼠标轨迹。" placement="left" />
                </label>
                <div class="meta-line">共 {{ (selectedNode.data.params.events || []).length }} 个事件</div>
              </div>
              <div class="field">
                <n-button size="small" block type="warning" :disabled="project.running" @click="splitMacro()"><AppIcon name="scissors" /> 拆分为流程与时间轴</n-button>
              </div>
              <div class="field">
                <n-button
                  size="small"
                  block
                  :type="eng.macroRecording ? 'error' : 'primary'"
                  @click="eng.macroRecording ? stopRecording() : startRecording()"
                >
                  <AppIcon :name="eng.macroRecording ? 'square' : 'record'" /> {{ eng.macroRecording ? '停止录制' : '录制操作' }}
                </n-button>
              </div>
            </template>

            <!-- ============ 调用脚本（子脚本）============ -->
            <template v-else-if="selectedNode.data.nodeType === 'script_call'">
              <div class="field">
                <label>
                  要调用的子脚本
                  <HintIcon
                    text="子脚本存在本脚本文件内部（随脚本一起保存），运行时就地展开执行。子脚本之间不允许循环调用。"
                    placement="left"
                  />
                </label>
                <div class="row">
                  <n-input
                    :value="selectedNode.data.params.script_id ? scriptName(selectedNode.data.params.script_id) : ''"
                    placeholder="尚未选择子脚本"
                    readonly
                    style="flex: 1"
                  />
                  <n-button size="small" type="primary" @click="openScriptPicker">选择…</n-button>
                </div>
                <p
                  v-if="selectedNode.data.params.script_id && !scriptExists(selectedNode.data.params.script_id)"
                  class="missing-hint"
                >
                  <AppIcon name="warning" /> 这个子脚本已不存在，运行时会明确报错，请重新选择。
                </p>
              </div>
              <div
                v-if="selectedNode.data.params.script_id && scriptExists(selectedNode.data.params.script_id)"
                class="field"
              >
                <label>子脚本</label>
                <div class="row">
                  <n-button size="small" @click="openScriptTab(selectedNode.data.params.script_id)">
                    <AppIcon name="file" /> 打开
                  </n-button>
                  <n-button size="small" @click="exportSubScript(selectedNode.data.params.script_id)">
                    <AppIcon name="download" /> 导出
                  </n-button>
                </div>
                <div class="row" style="margin-top: 6px">
                  <n-button size="small" quaternary @click="openScriptRename(selectedNode.data.params.script_id)">
                    改名
                  </n-button>
                  <n-button
                    size="small"
                    ghost
                    type="error"
                    @click="confirmRemoveSubScript(selectedNode.data.params.script_id)"
                  >
                    删除子脚本
                  </n-button>
                </div>
              </div>
            </template>

            <!-- ============ 输出变量 ============
                 节点只"声明"能产出什么。这里选一个已有变量，或点「新建」按默认规则建一条；
                 不选就不产生变量，用不到的输出不占变量表。 -->
            <template v-if="!simpleMode && selectedOutputs.length">
              <div class="vars-group-title">
                输出变量
                <HintIcon :text="OUTPUTS_HELP" placement="left" />
              </div>
              <div v-for="o in selectedOutputs" :key="o.param" class="field out-field">
                <label>{{ o.label }} <HintIcon :text="o.hint" placement="left" /></label>
                <div class="row">
                  <n-select
                    :value="outputBound(o) || null"
                    :options="varPickOptionsFor(o)"
                    size="small"
                    placeholder="未使用"
                    clearable
                    filterable
                    style="flex: 1"
                    @update:value="(v: string | null) => pickOutputVar(o, v)"
                  />
                  <n-button
                    v-if="outputBound(o)"
                    size="small"
                    quaternary
                    type="error"
                    @click="pickOutputVar(o, '')"
                  >
                    取消
                  </n-button>
                  <n-button v-else size="small" @click="addOutputVar(o)">新建</n-button>
                </div>
              </div>
            </template>
          </template>
          </div>

        <div v-if="!selectedNode" class="params-empty">选择节点以编辑参数</div></aside></template>
      <template #variables><div class="insp-body vars-pane"><n-select v-if="!simpleMode" v-model:value="variableScopeId" class="variable-scope" :options="variableScopes.map(s=>({label:s.label,value:s.id}))" aria-label="变量作用域" size="small" />
          <n-button v-if="!simpleMode" size="small" block @click="addStep('variable',true)">插入变量操作</n-button><template v-if="!simpleMode || (!isSub && !isGroup)">
          <div class="scope-line">
            <span class="scope-tag">{{ scopeInfo.title }}</span>
            <span class="scope-count">{{ managedVariables.length }} 个</span>
            <HintIcon :text="scopeInfo.desc" placement="left" />
          </div>

          <n-alert
            v-if="duplicateVarNames().length"
            type="warning"
            :show-icon="true"
            class="var-dup-alert"
          >
            变量名重复：{{ duplicateVarNames().join('、') }}
          </n-alert>

          <!-- ① 自定义变量：用户自己建的，名字不受约束 -->
          <div class="vars-group-title">
            {{ simpleMode ? '全局变量' : '自定义变量' }}
            <HintIcon text="建议使用 用途_含义 命名，如 battle_count；坐标初值填写 100,200。" placement="left" />
            <span class="group-count">{{ customVars.length }}</span>
          </div>

          <div class="var-group custom">
            <div v-for="(v, i) in customVars" :key="'c' + i" class="var-row">
              <div class="var-row-top">
                <n-input
                  :value="v.name"
                  size="small"
                  placeholder="变量名"
                  @update:value="(val: string) => onVarNameInput(v, val)"
                />
                <n-button size="tiny" quaternary type="error" @click="removeVar(v)"><AppIcon name="x" /></n-button>
              </div>
              <div class="var-row-bottom">
                <n-select v-model:value="v.type" :options="VAR_TYPES" size="small" style="width: 104px" />
                <n-input v-model:value="v.value" size="small" placeholder="初始值" />
              </div>
            </div>
          </div>
          <div v-if="!customVars.length" class="vars-empty">暂无</div>

          <div class="field" style="margin-top: 8px">
            <n-button class="add-custom-var" size="small" block dashed @click="addVariable"><AppIcon name="plus" /> 新增</n-button>
          </div>

          <!-- ② 流程变量：节点输出自动建，删掉 = 同时取消节点绑定 -->
          <div v-if="!simpleMode" class="vars-group-title">
            流程变量
            <HintIcon
              text="在节点的参数面板里添加输出时自动创建。默认名为来源_节点ID_含义，例如 image_n3_point。坐标同时包含 X / Y，原有名称继续有效。删掉会同时取消节点上的绑定。"
              placement="left"
            />
            <span class="group-count">{{ flowVars.length }}</span>
          </div>

          <div v-if="!simpleMode" class="var-group flow">
            <div v-for="(row, i) in flowVars" :key="'f' + i" class="var-row flow-var">
              <div class="var-row-top">
                <n-input
                  :value="row.item.name"
                  size="small"
                  @update:value="(val: string) => onVarNameInput(row.item, val)"
                />
                <n-button size="tiny" quaternary type="error" @click="removeVar(row.item)"><AppIcon name="x" /></n-button>
              </div>
              <div class="var-row-bottom">
                <n-select v-model:value="row.item.type" :options="VAR_TYPES" size="small" style="width: 104px" />
                <span class="var-src-inline">
                  {{ row.sources[0]?.nodeLabel }} · {{ row.sources[0]?.outputLabel }}
                  <template v-if="row.sources.length > 1">+{{ row.sources.length - 1 }}</template>
                </span>
              </div>
            </div>
          </div>
          <div v-if="!simpleMode && !flowVars.length" class="vars-empty">暂无</div>
          </template>
          <template v-else>
            <div class="scope-line">全局变量</div>
            <div v-for="v in root?.variables.filter(v => !v.name.startsWith('_at_'))" :key="v.name" class="var-row"><strong>{{ v.name }}</strong><div>{{ v.type }} · {{ v.value || '空值' }}</div></div>
            <n-button size="small" block @click="openGlobalVariables">管理全局变量</n-button>
          </template>
          <template v-if="!simpleMode">
            <div class="vars-group-title">工程变量总览</div>
            <div v-for="(v,i) in overview" :key="i" class="var-row"><strong>{{ v.name }}</strong><div class="meta-line">{{ v.scope }} · {{ v.type }}</div></div>
          </template>
          </div>
        </template>
      <template #logs><div class="workspace-logs"><div class="log-tools"><button @click="project.clearLogs()">清空</button><span>{{project.logs.length}} 条记录</span></div><div class="log-body"><div v-for="(l,i) in project.logs" :key="i" class="log-line" :class="l.level"><span>{{new Date(l.ts*1000).toLocaleTimeString()}}</span><strong>{{l.level}}</strong><span>{{l.message}}</span></div></div></div></template>
    </DockWorkspace>
<div v-if="ctxMenu" ref="ctxEl" class="ctx-menu" :style="ctxStyle" @contextmenu.prevent>
        <template v-if="ctxMenu.onNode">
          <button class="ctx-item" type="button" @click="ctxAction(() => copySelection())">
            <span class="ctx-icon"><AppIcon name="copy" /></span>复制<span class="ctx-key">Ctrl+C</span>
          </button>
          <button class="ctx-item" type="button" @click="ctxAction(cutSelection)">
            <span class="ctx-icon"><AppIcon name="scissors" /></span>剪切<span class="ctx-key">Ctrl+X</span>
          </button>
        </template>
        <button
          class="ctx-item"
          type="button"
          :disabled="!clip.hasContent"
          @click="ctxAction(pasteClipboard)"
        >
          <span class="ctx-icon"><AppIcon name="paste" /></span>粘贴<span class="ctx-key">Ctrl+V</span>
        </button>
      </div>
    <div v-if="edgeMenu" class="ctx-menu" :style="{left:edgeMenu.x+'px',top:edgeMenu.y+'px'}" @mouseleave="edgeMenu=null"><button class="ctx-item" :disabled="project.running" @click="beginWireInsert">在线上插入节点</button><button class="ctx-item" :disabled="project.running" @click="insertParallelOnWire">新增并行分支</button><button class="ctx-item" :disabled="project.running" @click="removeWire(edgeMenu.id)">删除连接</button></div>

    <ScreenCapture
      :show="capVisible"
      :mode="capMode"
      :initial-window="boundWindow?.hwnd ?? null"
      @captured="onCaptured"
      @picked="onPicked"
      @rect="onRect"
      @cancel="capVisible = false"
    />

    <n-modal v-model:show="pickingVisible" preset="card" title="拾取屏幕坐标" style="width: 480px" :mask-closable="false">
      <div class="pick-body">
        <p>已进入坐标拾取模式，请按以下步骤操作：</p>
        <ol>
          <li>切换到目标窗口（游戏画面）</li>
          <li>按下快捷键 <b>F8</b> 进入选取</li>
          <li><b>单击鼠标左键</b>，该点的真实屏幕坐标会自动填入</li>
        </ol>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end">
          <n-button @click="cancelPicking">取消</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="renameVisible" preset="card" title="重命名模板" style="width: 420px">
      <div class="rename-body">
        <n-input v-model:value="renameText" placeholder="输入新模板名" @keyup.enter="doRename" />
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="renameVisible = false">取消</n-button>
          <n-button type="primary" @click="doRename">确定</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 子脚本改名：改完同步到所有调用它的节点与标签标题 -->
    <n-modal
      v-model:show="scriptRenameVisible"
      preset="card"
      title="重命名子脚本"
      style="width: 420px"
    >
      <div class="rename-body">
        <n-input
          v-model:value="scriptRenameText"
          placeholder="输入新的子脚本名"
          @keyup.enter="doScriptRename"
        />
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <n-button @click="scriptRenameVisible = false">取消</n-button>
          <n-button type="primary" @click="doScriptRename">确定</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="matchVisible" preset="card" title="识别结果" style="width: min(760px, 92vw)">
      <img :src="matchImage" alt="match result" style="max-width: 100%; border-radius: 8px" />
    </n-modal>

    <!-- 子脚本挑选：选已有的 / 新建空白的 / 从文件导入 -->
    <ScriptPickerModal
      v-model:show="scriptPickerVisible"
      :scripts="scriptList"
      :current="selectedNode?.data?.params?.script_id || ''"
      @pick="onScriptPicked"
      @create="createSubScript(nodes.find((n) => n.id === scriptPickerTarget))"
      @import="importSubScript(nodes.find((n) => n.id === scriptPickerTarget))"
      @open="openScriptTab"
    />
  </div>
</template>

<style scoped>
.palette.show-vars { width: 300px; min-width: 260px; }
.palette .sidebar-tabs { display: flex; grid-template-columns: none; }
.palette .sidebar-tabs button { font-size: 12px; white-space: nowrap; padding: 7px 4px; }
.palette .vars-pane { padding: 10px; overflow: auto; }
.sidebar-tabs { display: flex; gap: 8px; padding: 8px; }
.sidebar-tabs button { flex: 1; cursor: pointer; padding: 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-panel); color: var(--text); }
.sidebar-tabs .active, .mode-badge { color: var(--accent); }
.mode-badge { font-size: 11px; margin-right: auto; }

.editor {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  flex: none;
}
/* 左侧文件操作与脚本名之间的细分隔线 */
.topbar-divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  flex: none;
}
.name-input {
  max-width: 200px;
}
/* 顶栏右组的字段名（循环轮数） */
.tb-label {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
/* 「子脚本」标记：让人一眼知道当前编辑的不是顶层脚本 */
.sub-badge {
  font-size: 12px;
  color: var(--badge-text);
  border: 1px solid var(--badge-border);
  border-radius: 10px;
  padding: 1px 8px;
  white-space: nowrap;
  flex: none;
}
.pane-alert {
  margin: 0;
  border-radius: 0;
  flex: none;
}
/* 调用脚本节点指向的子脚本已不存在 */
.missing-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--warn);
}

.settings-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex-wrap: wrap;
  flex: none;
}
.setting {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 组内必须同一行（拆分节点 / 合并节点是两种"整段流程的整理"操作，拆开看会很别扭） */
.nowrap-group {
  flex-wrap: nowrap;
  white-space: nowrap;
}
.setting-label {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}

.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.workspace { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.workspace.split-v { flex-direction: column; }
.workspace > .canvas, .workspace > .timeline-dock { flex: 1; min-width: 0; min-height: 0; }
.workspace.split-v > .canvas { flex-basis: 45%; }
.workspace.split-v > .timeline-dock { flex-basis: 55%; border-top: 1px solid var(--border); }
.workspace.split-h > .timeline-dock { border-left: 1px solid var(--border); }
.timeline-dock { background: var(--bg); overflow: hidden; }
.workspace-modes { display: flex; gap: 3px; margin-left: auto; }
.workspace-modes button, .new-timeline-segment { color: var(--text); background: var(--bg-panel); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; font: inherit; font-size: 12px; cursor: pointer; }
.workspace-modes .active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.new-timeline-segment { text-align: left; }
@media(max-width: 1000px) { .workspace.split-h { flex-direction: column; } .workspace.split-h > .timeline-dock { border-top: 1px solid var(--border); } }
.palette {
  width: 164px;
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--bg-soft);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 节点多于可用高度时在**自己内部**滚动，不能溢出去压到画布/日志上 */
  min-height: 0;
  overflow-y: auto;
}
.palette-title {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 600;
  margin-bottom: 2px;
}
/* ---------- 六大类切换 ----------
   3 × 2 网格。选中态用该类自己的颜色描边 + 淡色底：
   和画布上的节点配色一一对应，扫一眼就知道"当前在挑哪一类的节点"。 */
.cat-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.cat-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.1;
  cursor: pointer;
  transition: 0.15s;
  font-family: inherit;
}
.cat-tab:hover {
  background: var(--bg-panel);
}
.cat-tab.active {
  background: var(--bg-panel);
  font-weight: 600;
}
.cat-tab-icon {
  font-size: 14px;
}
.cat-tab-label {
  white-space: nowrap;
}
.palette-tip {
  display: block;
  font-size: 12px;
  line-height: 1.55;
}
.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: 0.15s;
  font-size: 13px;
}
.palette-item:hover {
  background: var(--bg-panel);
  border-color: var(--border);
}
.palette-icon {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  font-size: 12px;
  flex: none;
}

.canvas {
  flex: 1;
  position: relative;
  min-width: 0;
}
.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-dim);
  pointer-events: none;
}
.empty-emoji {
  font-size: 42px;
}

.flow-controls {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  gap: 6px;
  padding: 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
}
.ctl {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text);
  cursor: pointer;
  transition: 0.15s;
}
.ctl:hover {
  background: var(--ctl-hover);
  border-color: var(--border);
}
.ctl svg {
  width: 16px;
  height: 16px;
}

/* ---------- 画布右键菜单 ----------
   position 用 fixed：坐标直接是鼠标的视口坐标，不受画布滚动 / 缩放影响 */
.ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ctx-item:hover:not(:disabled) {
  background: var(--hover);
}
.ctx-item:disabled {
  color: var(--text-dim);
  opacity: 0.5;
  cursor: default;
}
.ctx-icon {
  width: 14px;
  text-align: center;
  flex: none;
}
.ctx-key {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
}

.resize-handle {
  flex: none;
}
.inspector-handle {
  width: 5px;
  cursor: col-resize;
  background: transparent;
}
.inspector-handle:hover {
  background: var(--accent);
}

/* 侧栏外壳：顶部标签条固定，下面内容区自己滚动。
   宽度由脚本里的 inspWidth 下发（参数与变量共用同一条）。 */
.inspector {
  flex: none;
  border-left: 1px solid var(--border);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.insp-tabbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 0;
  border-bottom: 1px solid var(--border);
}
.insp-tab {
  position: relative;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  padding: 6px 10px 8px;
  cursor: pointer;
  border-radius: 6px 6px 0 0;
  white-space: nowrap;
}
.insp-tab:hover {
  color: var(--text);
  background: var(--bg-card);
}
.insp-tab.on {
  color: var(--text);
  font-weight: 600;
}
.insp-tab.on::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.insp-tab.dim {
  opacity: 0.45;
  cursor: default;
}
.insp-tab.dim:hover {
  background: transparent;
  color: var(--text-dim);
}
.insp-tab-grow {
  flex: 1;
}
.insp-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.insp-close:hover {
  color: var(--text);
  background: var(--bg-card);
}
.insp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 16px;
}
/* 断线但流程可能还在跑：不清运行状态，只明确标出"不知道" */
.conn-lost {
  font-size: 12px;
  color: var(--warning, #e6a23c);
  white-space: nowrap;
  margin-left: 6px;
}
.insp-icon {
  margin-right: 2px;
}
/* 变量侧栏顶部：这一层是全局还是局部 */
.scope-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.scope-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 2px 8px;
}
.scope-count {
  font-size: 12px;
  color: var(--text-dim);
}
/* 变量：一条声明一行小卡片（名字 / 类型 / 初始值） */
.var-row {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 8px;
  margin-bottom: 8px;
}
.var-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.var-row-bottom {
  display: flex;
  gap: 6px;
  align-items: center;
}
.vars-empty {
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
  padding: 10px 0;
}
.var-dup-alert {
  margin-bottom: 10px;
}
/* 变量侧栏里的分区小标题（自定义变量 / 流程变量） */
.vars-group-title {
  display: flex;
  align-items: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
  margin: 14px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.group-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg-panel);
  border-radius: 8px;
  padding: 0 6px;
}
/* 流程变量来自哪个节点的哪个输出 */
.var-src-inline {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 一行放「标签 + 开关」这类短控件 */
.field-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.field-inline label {
  margin-bottom: 0;
}
.meta-line {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}
.inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.inspector-title {
  font-weight: 700;
  font-size: 15px;
}
.inspector-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-dim);
  text-align: center;
}
.field {
  margin-bottom: 14px;
}
.field label {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.row {
  display: flex;
  gap: 8px;
}
.tpl-preview {
  max-width: 100%;
  max-height: 120px;
  border: 1px solid var(--border);
  border-radius: 6px;
  display: block;
  background: var(--preview-bg);
}
/* 条件编辑：左值弹性、运算符定宽、右值弹性 */
.cond-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.cond-row > :first-child {
  flex: 1;
  min-width: 0;
}
.cond-row > :last-child {
  flex: 1;
  min-width: 0;
}
.cond-op {
  width: 96px;
  flex: none !important;
}
/* 原生取色器：去掉两侧默认留白，跟输入框等高 */
.color-input {
  width: 34px;
  height: 34px;
  padding: 2px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  flex: none;
}
.region-text {
  flex: 1;
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono :deep(textarea),
.mono :deep(input) {
  font-family: Consolas, 'Cascadia Mono', 'Courier New', monospace;
}

/* 运行日志面板已移到外壳（views/Editor.vue）的右下角浮层，相关样式随之搬走 */

/* 快捷键改键界面已挪到「⚙ 设定」（SettingsModal.vue），相关样式随之搬走 */

/* 被「只允许一个编辑器窗口」拒绝时的遮罩：此时页面本来也没连上引擎，先挡住误操作 */
.busy-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
}
.busy-card {
  width: min(420px, 88vw);
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  box-shadow: var(--shadow);
}
.busy-title {
  font-weight: 700;
  margin-bottom: 8px;
}
.busy-text {
  margin: 0 0 14px;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.7;
}
</style>

<style scoped>
.palette{width:100%;height:100%;box-sizing:border-box;border:0;overflow:auto}.palette-title:empty{display:none}.canvas,.timeline-dock{height:100%;width:100%;min-width:0;min-height:0;position:relative;box-sizing:border-box}.inspector.insp-shell{width:100%;height:100%;border:0;box-sizing:border-box}.params-pane,.vars-pane{height:100%;box-sizing:border-box;overflow:auto;padding:12px}.params-empty{padding:24px;color:var(--text-dim);text-align:center}.insert-hint{padding:8px;color:var(--accent)}.workspace-logs{height:100%;display:flex;flex-direction:column}.log-tools{display:flex;gap:12px;padding:5px 12px;border-bottom:1px solid var(--border);font-size:12px}.log-tools button{background:none;border:0;color:var(--accent);cursor:pointer}.log-body{flex:1;overflow:auto;padding:8px 12px;font:12px Consolas,monospace}.log-line{display:flex;gap:10px;padding:2px 0}.log-line>span:first-child{color:var(--text-dim);white-space:nowrap}.log-line.error strong{color:var(--danger)}.log-line.warn strong{color:var(--warn)}
</style>
