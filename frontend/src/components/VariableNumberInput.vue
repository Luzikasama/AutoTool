<script setup lang="ts">
import {computed,ref} from 'vue'
import {NInput,NInputNumber,NSelect,NButton} from 'naive-ui'
const props=defineProps<{value:any;min?:number;max?:number;step?:number;options?:{label:string;value:string}[]}>()
const emit=defineEmits<{'update:value':[value:any]}>()
const picking=ref(false)
const reference=computed(()=>typeof props.value==='string' && props.value.includes('{{'))
function pick(value:string) {emit('update:value',`{{${value}}}`);picking.value=false}
</script>
<template><div class="variable-number"><NSelect v-if="picking" :options="options || []" filterable tag placeholder="选择或输入变量名" @update:value="pick" /><NInput v-else-if="reference" :value="value" placeholder="{{变量名}}" @update:value="emit('update:value',$event)" /><NInputNumber v-else :value="value" :min="min" :max="max" :step="step" @update:value="emit('update:value',$event)" /><NButton size="tiny" quaternary :aria-label="reference ? '改用数值' : '引用变量'" @click="reference ? emit('update:value',0) : picking=!picking">{{ reference ? '数值' : '变量' }}</NButton></div></template>
<style scoped>.variable-number{display:flex;align-items:center;gap:4px}.variable-number>:first-child{flex:1;min-width:0}</style>
