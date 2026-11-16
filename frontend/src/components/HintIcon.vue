<script setup lang="ts">
import AppIcon from './AppIcon.vue'
/**
 * 「圆圈 i」悬停说明。
 *
 * 0.1.6 起界面上不再铺说明文字（`<p class="terminate-hint">` 那类灰字），
 * 一律收进这个图标里：默认只有一个小圆圈，鼠标移上去才出气泡。
 * 这样右侧面板的纵向空间全部留给真正要填的控件。
 *
 * 约定：
 *  · **没有说明文字就不渲染任何东西** —— 调用方不用写 `v-if`；
 *  · 点击不冒泡（图标可能落在 label / 可点击行里，别顺手触发父级行为）；
 *  · 气泡文字保留换行（平台相关的两段说明常常是换行分隔的）。
 */
import { NTooltip } from 'naive-ui'

withDefaults(
  defineProps<{
    /** 说明文字；空串 / 不传则整个图标不出现 */
    text?: string | null
    /** 气泡方向，默认向右上（右侧面板贴着窗口右边，向左会被裁掉） */
    placement?: 'top' | 'top-start' | 'top-end' | 'right' | 'left' | 'bottom'
  }>(),
  { text: '', placement: 'top' },
)
</script>

<template>
  <n-tooltip v-if="text" :placement="placement" :delay="150" :style="{ maxWidth: '300px' }">
    <template #trigger>
      <!-- i 用 CSS 画，不放在 textContent 里：label 的纯文本保持干净（
           读屏与界面回归都按 label 文字比对，混进一个 "i" 会到处对不上） -->
      <span class="hint-i" aria-hidden="true" @click.stop @mousedown.stop><AppIcon name="info" :size="13" /></span>
    </template>
    <span class="hint-body">{{ text }}</span>
  </n-tooltip>
</template>

<style scoped>
.hint-i {
  display: inline-grid;
  place-items: center;
  width: 13px;
  height: 13px;
  margin-left: 4px;
  border: 0;
  border-radius: 50%;
  color: var(--text-dim);
  cursor: help;
  vertical-align: middle;
  opacity: 0.75;
  transition: 0.15s;
  flex: none;
}

.hint-i:hover {
  color: var(--accent);
  border-color: var(--accent);
  opacity: 1;
}
.hint-body {
  display: block;
  white-space: pre-line;
  line-height: 1.55;
  font-size: 12px;
}
</style>
