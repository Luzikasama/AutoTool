<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
/**
 * 编辑器外壳：浏览器式多标签 + 底部运行日志 + 底部控制条 + 设定 / 断连遮罩。
 *
 * 架构约定（0.1.2 起）：
 *  · **每个标签 = 一个 EditorPane 实例**，节点、历史、脚本名都是实例内的局部状态，
 *    所以打开多个脚本天然互不干扰（不需要把上万个节点塞进全局 store）；
 *  · 文档数据由各 pane 实时镜像进 `stores/docs.ts`，保存 / 标签标题 / 子脚本列表读它；
 *  · 引擎连接、运行状态、日志、悬浮框、模板列表是**全应用一份**，分别在
 *    `stores/engine.ts` 与 `stores/project.ts` —— 引擎只允许一条页面连接。
 *
 * 标签分三类：
 *  · root  —— 一个独立的脚本（顶层文件）
 *  · sub   —— 某个脚本内部的子脚本，用独立标签编辑，保存时随父脚本一起写回
 *  · group —— 画布上某个「组合节点」的内部图（双击该节点进入），0.1.4 新增
 *
 * 标签栏（`.tabstrip`）不在本组件里直接渲染位置，而是作为 `#tabs` 插槽交给各 pane，
 * 由 pane 放在自己的「新建 / 加载 / 保存」行下面 —— 标签属于那个编辑器，位置就该由它决定。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, useDialog, useMessage } from 'naive-ui'
import EditorPane from './EditorPane.vue'
import SettingsModal from '../components/SettingsModal.vue'
import { goodbyeBeacon } from '../api/client'
import { useDocsStore, type DocMeta } from '../stores/docs'
import { useEngineStore } from '../stores/engine'
import {useWorkspaceStore,PANEL_TITLES} from '../stores/workspace'
import {useUiStore} from '../stores/ui'

const docs = useDocsStore()
const eng = useEngineStore()
const dock=useWorkspaceStore(),ui=useUiStore()
const windowMenu=ref<HTMLDetailsElement|null>(null)
function openPanel(id:string){dock.open(id);if(windowMenu.value)windowMenu.value.open=false}
const dialog = useDialog()
const message = useMessage()

const settingsVisible = ref(false)

// ---------- 标签 ----------
const tabs = computed(() => docs.tabs)
const activeId = computed(() => docs.activeId)

/** 标签图标：根脚本=文档、子脚本=包裹、组合节点=拼图（组合节点的编辑标签） */
function tabIcon(t: DocMeta) {
  if (t.kind === 'sub') return 'package'
  if (t.kind === 'group') return 'workflow'
  return 'file'
}

function addTab() {
  docs.openRoot()
}

function closeTab(t: DocMeta) {
  if (docs.tabs.length <= 1) return
  if (t.kind === 'root') docs.closeSubTabsOf(t.rootId)
  docs.closeTab(t.id)
}

/** 关闭前确认（有未保存改动才问） */
function requestClose(t: DocMeta) {
  if (docs.tabs.length <= 1) return
  if (!t.dirty) {
    closeTab(t)
    return
  }
  dialog.warning({
    title: '关闭这个编辑器？',
    content: `「${t.name}」有未保存的改动，关闭后会丢失（子脚本随父脚本保存）。`,
    positiveText: '关闭',
    negativeText: '取消',
    onPositiveClick: () => closeTab(t),
  })
}

// ---------- 标签拖拽排序 ----------
// 不用 HTML5 draggable：WebView2 里它的触发条件很挑剔（拖动源上带 user-select:none、
// 或指针按下时落在子元素上，都可能压根不派发 dragstart），表现就是"看着能拖、松手顺序没变"。
// 改成自己用 pointer 事件算落点：必定生效，还能画出插入位置的竖线。
const dragFrom = ref(-1) // 正在被拖的标签下标
const dragAt = ref(-1) // 插入位置 0..n（插在第 n 个标签之前）
const dragging = ref(false) // 超过阈值才算拖拽，避免手抖误触
const suppressClick = ref(false) // 拖完那一下的 click 不该再当成"切换标签"
let dragStartX = 0
let dragStrip: HTMLElement | null = null

function onTabPointerDown(i: number, e: PointerEvent) {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.tab-close')) return
  dragStrip = (e.currentTarget as HTMLElement).closest('.tabstrip') as HTMLElement | null
  dragFrom.value = i
  dragAt.value = i
  dragStartX = e.clientX
  dragging.value = false
  window.addEventListener('pointermove', onTabPointerMove)
  window.addEventListener('pointerup', onTabPointerUp)
}

function onTabPointerMove(e: PointerEvent) {
  if (dragFrom.value < 0 || !dragStrip) return
  if (!dragging.value) {
    if (Math.abs(e.clientX - dragStartX) < 5) return
    dragging.value = true
  }
  // 落点：指针越过哪个标签的水平中线，就插到它前面
  const els = Array.from(dragStrip.querySelectorAll<HTMLElement>('.tab'))
  let at = els.length
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect()
    if (e.clientX < r.left + r.width / 2) {
      at = i
      break
    }
  }
  dragAt.value = at
}

function onTabPointerUp() {
  window.removeEventListener('pointermove', onTabPointerMove)
  window.removeEventListener('pointerup', onTabPointerUp)
  if (dragging.value && dragFrom.value >= 0 && dragAt.value >= 0) {
    // dragAt 是"插到第几个之前"，源被移走之后它后面的下标都会前移一位
    let to = dragAt.value
    if (to > dragFrom.value) to -= 1
    docs.moveTab(dragFrom.value, to)
    suppressClick.value = true
    setTimeout(() => (suppressClick.value = false), 0)
  }
  dragFrom.value = -1
  dragAt.value = -1
  dragging.value = false
  dragStrip = null
}

function onTabClick(id: string) {
  if (suppressClick.value) return
  docs.activate(id)
}

// ---------- 悬浮框（全局开关，由引擎创建原生置顶小窗）----------
async function toggleOverlay() {
  try {
    const on = await eng.toggleOverlay()
    message.success(on ? '悬浮框已开启' : '悬浮框已关闭')
  } catch (e: any) {
    message.error('切换悬浮框失败：' + e.message)
  }
}

// ---------- 生命周期 ----------
/** 页面告别：只有浏览器形态才发。
 *
 *  桌面版里页面就是原生窗口的内容：刷新、WebView 崩溃、壳重建窗口都会触发 pagehide，
 *  而引擎侧的生命周期由壳负责 —— 再发「告别」只会让日志里凭空多出一堆"页面主动关闭"。
 */
function onPageHide() {
  if (eng.desktop) return
  goodbyeBeacon()
}

onMounted(() => {
  // 一个标签都没有时开第一个空白脚本（首次进入、或上次全部关掉后的兜底）
  if (!docs.tabs.length) docs.openRoot()
  eng.start()
  eng.refreshTemplates(true)
  eng.refreshWindows(true)
  eng.syncOverlay()
  window.addEventListener('pagehide', onPageHide)
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onPageHide)
  eng.stop()
})
</script>

<template>
  <div class="editor-shell">
    <!-- 每个标签一个编辑器实例：v-show 保状态（切回来不丢画布与撤销历史）。
         标签栏作为 #tabs 交给 pane，渲染在它的「新建 / 加载 / 保存」行下面。 -->
    <div class="panes">
      <EditorPane
        v-for="t in tabs"
        v-show="t.id === activeId"
        :key="t.id"
        :doc-id="t.id"
        :active="t.id === activeId"
      >
        <template #tabs>
          <div class="tabstrip">
            <div
              v-for="(t2, i) in tabs"
              :key="t2.id"
              class="tab"
              :class="{
                active: t2.id === activeId,
                sub: t2.kind === 'sub',
                dragging: dragging && dragFrom === i,
                'drop-before': dragging && dragAt === i,
                'drop-after': dragging && dragAt === tabs.length && i === tabs.length - 1,
              }"
              @pointerdown="onTabPointerDown(i, $event)"
              @click="onTabClick(t2.id)"
            >
              <span class="tab-icon"><AppIcon :name="tabIcon(t2)" /></span>
              <span class="tab-name">{{ t2.name }}</span>
              <span v-if="t2.dirty" class="tab-dot" />
              <button
                v-if="tabs.length > 1"
                class="tab-close"
                type="button"
                draggable="false"
                @click.stop="requestClose(t2)"
              >
                <AppIcon name="x" />
              </button>
            </div>
            <button class="tab-add" type="button" @click="addTab"><AppIcon name="plus" /></button>
          </div>
        </template>
      </EditorPane>
    </div>

    <div class="bottombar">
      <button class="bb-gear" type="button" aria-label="设置" @click="settingsVisible=true"><AppIcon name="settings" /></button>
      <span class="app-status">AutoTool[{{ui.editorMode==='simple'?'简易模式':'专家模式'}}]</span>
      <div class="spacer" />
      <details ref="windowMenu" class="window-menu"><summary>窗口</summary><div class="window-items"><button v-for="(title,id) in PANEL_TITLES" :key="id" :data-open-panel="id" @click="openPanel(String(id))">{{title}}<span v-if="dock.panels.some(p=>p.id===id&&p.open)">✓</span></button><hr><button @click="dock.reset();windowMenu!.open=false">重置工作区</button></div></details>
      <button class="bb-btn" type="button" aria-label="运行悬浮框" :class="{on:eng.overlayEnabled}" :disabled="!eng.overlayAvailable" @click="toggleOverlay"><AppIcon name="window" /></button>
    </div>

    <SettingsModal v-model:show="settingsVisible" />

    <!-- 只允许一个编辑器窗口：本页被引擎拒绝时给出明确说明，并后台重试（刷新页面能自动接管） -->
    <div v-if="eng.busy" class="busy-mask">
      <div class="busy-card">
        <div class="busy-title">已在另一个窗口打开</div>
        <p class="busy-text">
          AutoTool 只允许一个编辑器窗口与一个后端。请使用已经打开的那个窗口；
          如果那是旧标签页、你已经关掉它，本页会自动接管（正在重试…）。
        </p>
        <n-button size="small" type="primary" @click="eng.retryNow()">立即重试</n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-shell {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ---------- 编辑器区 ---------- */
.panes {
  position: relative;
  flex: 1;
  min-height: 0;
}
.panes > :deep(.editor) {
  position: absolute;
  inset: 0;
}

/* ---------- 标签条 ---------- */
.tabstrip {
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 6px 10px 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  overflow-x: auto;
  overflow-y: hidden;
  flex: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 6px 8px 6px 10px;
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  transition: 0.15s;
  margin-bottom: -1px;
  flex: none;
}
.tab:hover {
  color: var(--text);
  background: var(--hover);
}
/* 正在被拖动的标签 */
.tab.dragging {
  opacity: 0.45;
}
/* 插入位置指示：一根贴在标签左/右侧的竖线。
   用 box-shadow 画而不是 border，这样不会撑动其它标签的宽度 */
.tab.drop-before {
  box-shadow: -3px 0 0 0 var(--accent);
}
.tab.drop-after {
  box-shadow: 3px 0 0 0 var(--accent);
}
/* 当前标签：用底色"接上"下面的内容区，视觉上就是浏览器标签页的样子 */
.tab.active {
  background: var(--bg);
  color: var(--text);
  border-color: var(--accent);
}
.tab.sub .tab-icon {
  opacity: 0.9;
}
.tab-icon {
  flex: none;
  font-size: 12px;
}
.tab-name {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 未保存标记：小圆点，比在标题前加 * 更不抢眼 */
.tab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
  flex: none;
}
.tab-close {
  flex: none;
  width: 18px;
  height: 18px;
  line-height: 16px;
  text-align: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 4px;
  cursor: pointer;
  font-size: 15px;
  padding: 0;
}
.tab-close:hover {
  background: var(--danger);
  color: #fff;
}
.tab-add {
  flex: none;
  align-self: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}
.tab-add:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* ---------- 底部控制条 ---------- */
.bottombar {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-top: 1px solid var(--border);
  background: var(--bg-soft);
}
.bottombar .spacer {
  flex: 1;
}
/* 只有图标的按钮：含义由图标本身表达（0.1.4 起不再挂悬停说明） */
.bb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: 0.15s;
}
.bb-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--hover);
  border-color: var(--border);
}
.bb-btn.on {
  color: var(--accent);
  border-color: var(--accent);
}
.bb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.bb-icon {
  font-size: 16px;
  line-height: 1;
}
/* 设定齿轮：左下角，比右边两个开关更大 */
.bb-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 21px;
  line-height: 1;
  cursor: pointer;
  transition: 0.15s;
}
.bb-gear:hover {
  color: var(--accent);
  background: var(--hover);
  border-color: var(--border);
}

/* ---------- 底部运行日志（在布局里占位，不是浮在画布上的小窗）----------
   高度由 inline style 给（默认 240px），上边沿可往上拖加高 */
.logpanel {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border);
  background: var(--bg-soft);
}
.logpanel-resize {
  height: 5px;
  cursor: ns-resize;
  flex: none;
}
.logpanel-resize:hover {
  background: var(--accent-soft);
}
.logpanel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.logpanel-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}
.lf-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  border-radius: 5px;
  padding: 2px 6px;
}
.lf-btn:hover {
  color: var(--text);
  background: var(--hover);
}
.logpanel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 12px;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}
.log-line {
  display: flex;
  gap: 8px;
  padding: 1px 0;
}
.log-ts {
  color: var(--text-dim);
  flex: none;
}
.log-level {
  flex: none;
  width: 44px;
  text-transform: uppercase;
  font-size: 11px;
}
.log-line.info .log-level {
  color: var(--accent);
}
.log-line.warn .log-level {
  color: var(--warn);
}
.log-line.error .log-level {
  color: var(--danger);
}
.log-line.debug .log-level {
  color: var(--text-dim);
}
.log-msg {
  white-space: pre-wrap;
  word-break: break-all;
}

/* ---------- 被引擎拒绝（已有另一个窗口在跑）----------
   这里不是错误，而是"同时只能有一个编辑器"，所以要给明确的操作指引而不是报错 */
.busy-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 50;
}
.busy-card {
  width: min(420px, 90vw);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  box-shadow: var(--shadow);
}
.busy-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.busy-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
  margin: 0 0 14px;
}
</style>

<style scoped>
.app-status{font-size:12px;color:var(--text-dim)}.window-menu{position:relative;font-size:12px;color:var(--text)}.window-menu summary{cursor:pointer;list-style:none;padding:6px 12px;border-radius:5px}.window-menu[open] summary,.window-menu summary:hover{background:var(--hover)}.window-items{position:absolute;bottom:36px;right:0;width:175px;background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 30px #0005;padding:5px;z-index:120}.window-items button{display:flex;justify-content:space-between;width:100%;border:0;background:transparent;color:var(--text);padding:8px 12px;cursor:pointer;text-align:left;border-radius:4px}.window-items button:hover{background:var(--hover)}.window-items hr{border:0;border-top:1px solid var(--border);margin:4px}
</style>
