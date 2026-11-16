<script setup lang="ts">
import {computed,inject} from 'vue'
import {BaseEdge,EdgeLabelRenderer,getSmoothStepPath,Position,type EdgeProps} from '@vue-flow/core'
import AppIcon from './AppIcon.vue'
defineOptions({inheritAttrs:false})
const props=defineProps<EdgeProps<{canEdit?:boolean}>>()
const actions=inject<{insert:(id:string)=>void;remove:(id:string)=>void}>('wireActions')
const route=computed(()=>getSmoothStepPath({...props,sourcePosition:props.sourcePosition || Position.Right,targetPosition:props.targetPosition || Position.Left,borderRadius:12,offset:28}))
const position=computed(()=>({transform:`translate(-50%, -50%) translate(${route.value[1]}px,${route.value[2]}px)`}))
</script>
<template>
  <BaseEdge :id="id" :path="route[0]" :marker-end="markerEnd" :marker-start="markerStart" :style="style" :interaction-width="26" />
  <EdgeLabelRenderer>
    <div v-if="label || (selected && data?.canEdit)" class="wire-label nodrag nopan" :class="{'wire-selected':selected}" :style="position">
      <span v-if="label">{{label}}</span>
      <template v-if="selected && data?.canEdit">
        <button aria-label="在线上插入节点" @pointerdown.stop @click.stop="actions?.insert(id)"><AppIcon name="plus" :size="14" /></button>
        <button aria-label="删除连接" @pointerdown.stop @click.stop="actions?.remove(id)"><AppIcon name="trash" :size="14" /></button>
      </template>
    </div>
  </EdgeLabelRenderer>
</template>
<style scoped>
.wire-label{position:absolute;display:flex;gap:4px;align-items:center;max-width:170px;border:1px solid var(--border);border-radius:7px;background:var(--bg-panel);color:var(--text-dim);font-size:11px;box-shadow:0 2px 6px #00000012;padding:2px 5px;pointer-events:none}.wire-label>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wire-selected{border-color:var(--accent);color:var(--accent);z-index:5}.wire-label button{display:grid;place-items:center;pointer-events:all;border:0;border-radius:4px;padding:4px;background:transparent;color:inherit;cursor:pointer}.wire-label button:hover{background:var(--accent-soft)}
</style>
