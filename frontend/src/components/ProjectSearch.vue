<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref} from 'vue'
import AppIcon from './AppIcon.vue'
import {NODE_META} from '../types'
import {searchProject,type SearchHit} from '../lib/projectSearch'
const props=defineProps<{project:any;active:boolean}>()
const emit=defineEmits<{locate:[source:SearchHit['source']]}>()
const query=ref(''),type=ref(''),open=ref(false),index=ref(0),input=ref<HTMLInputElement|null>(null)
const hits=computed(()=>searchProject(props.project,query.value,type.value))
function choose(i:number){const hit=hits.value[i];if(hit){emit('locate',hit.source);open.value=false;input.value?.blur()}}
function key(e:KeyboardEvent){if(e.key==='Escape'){open.value=false;input.value?.blur()}if(e.key==='Enter'){e.preventDefault();choose(Math.min(index.value,hits.value.length-1))}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();index.value=(index.value+(e.key==='ArrowDown'?1:-1)+hits.value.length)%Math.max(1,hits.value.length)}}
function shortcut(e:KeyboardEvent){if(props.active&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();open.value=true;nextTick(()=>{input.value?.focus();input.value?.select()})}}
onMounted(()=>window.addEventListener('keydown',shortcut));onBeforeUnmount(()=>window.removeEventListener('keydown',shortcut))
</script>
<template><div class="project-search" @keydown="key" @focusout="e=>{if(!($el as HTMLElement).contains(e.relatedTarget as Node))open=false}">
 <AppIcon name="search"/><input ref="input" v-model="query" aria-label="全局搜索" placeholder="搜索工程…  Ctrl+F" @focus="open=true" @input="index=0;open=true">
 <div v-if="open" class="search-results"><select v-model="type" aria-label="全局搜索类型" @change="index=0"><option value="">全部节点类型</option><option v-for="(meta,key) in NODE_META" :key="key" :value="key">{{meta.label}}</option></select>
 <div v-if="!hits.length" class="search-empty">{{query.trim()||type?'没有匹配节点':'按名称、类型、按键或变量搜索'}}</div>
 <button v-for="(hit,i) in hits" :key="JSON.stringify(hit.source)" :class="{active:i===index}" @mousedown.prevent="choose(i)"><strong>{{hit.source.label}} <small>#{{hit.source.nodeId}}</small></strong><span>{{hit.source.path}}</span><small>{{hit.detail}}</small></button>
 </div>
</div></template>
<style scoped>
.project-search{position:relative;display:flex;align-items:center;gap:5px;max-width:310px;min-width:120px;flex:1;color:var(--text-dim);border:1px solid var(--border);border-radius:6px;padding:3px 8px;background:var(--bg-panel)}.project-search>input{width:100%;min-width:0;border:0;outline:none;background:transparent;color:var(--text);font:inherit;font-size:12px;padding:3px}.search-results{position:absolute;top:100%;right:0;margin-top:5px;width:380px;max-width:80vw;max-height:430px;overflow:auto;border:1px solid var(--border);border-radius:7px;padding:6px;background:var(--bg-panel);box-shadow:0 8px 28px #0003;z-index:150}.search-results>select{width:100%;padding:5px;color:var(--text);background:var(--bg-panel);border:1px solid var(--border);border-radius:4px}.search-results>button{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;background:none;color:var(--text);border:0;border-radius:4px;padding:8px;cursor:pointer}.search-results>button.active,.search-results>button:hover{background:var(--accent-soft)}.search-results small,.search-results span{font-size:11px;color:var(--text-dim);overflow:hidden;max-width:100%;white-space:nowrap;text-overflow:ellipsis}.search-empty{padding:18px;color:var(--text-dim);font-size:12px}
</style>
