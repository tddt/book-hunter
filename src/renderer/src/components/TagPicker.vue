<script setup lang="ts">
import { ref } from 'vue'
import type { Tag } from '@shared/types'

const props = defineProps<{ modelValue: string[]; tags: Tag[] }>()
const emit = defineEmits<{
  'update:modelValue': [value: string[]]
  create: [name: string]
  remove: [id: string]
}>()

const open = ref(false)
const newName = ref('')

function toggle(id: string): void {
  const next = props.modelValue.includes(id)
    ? props.modelValue.filter((x) => x !== id)
    : [...props.modelValue, id]
  emit('update:modelValue', next)
}

function createTag(): void {
  const name = newName.value.trim()
  if (!name) return
  emit('create', name)
  newName.value = ''
}
</script>

<template>
  <div class="tagpicker">
    <div class="chips">
      <span
        v-for="id in modelValue"
        :key="id"
        class="chip"
        :style="{ borderColor: tags.find((t) => t.id === id)?.color || '#ccc' }"
      >
        {{ tags.find((t) => t.id === id)?.name || '未知标签' }}
        <button title="移除标签" @click="emit('update:modelValue', modelValue.filter((x) => x !== id))">×</button>
      </span>
      <button class="add" @click="open = !open">＋ 标签</button>
    </div>

    <div v-if="open" class="popover panel">
      <div class="pop-title">
        <span>选择标签</span>
        <button @click="open = false">收起</button>
      </div>
      <div class="opts">
        <button
          v-for="tag in tags"
          :key="tag.id"
          :class="{ on: modelValue.includes(tag.id) }"
          @click="toggle(tag.id)"
        >
          <i class="tag-dot" :style="{ background: tag.color }" />
          <span class="ellipsis">{{ tag.name }}</span>
          <span v-if="modelValue.includes(tag.id)">✓</span>
        </button>
      </div>
      <div class="new">
        <input
          v-model="newName"
          class="input"
          placeholder="输入新标签名"
          @keyup.enter="createTag"
        />
        <button class="btn btn-soft" @click="createTag">新建</button>
      </div>
      <div v-if="tags.length" class="manage">
        <span class="muted">删除标签：</span>
        <button v-for="tag in tags" :key="tag.id" :title="`删除 ${tag.name}`" @click="emit('remove', tag.id)">
          {{ tag.name }} ×
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tagpicker { position: relative; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px 0 9px;
  border: 1px solid var(--c-border);
  border-radius: 12px;
  font-size: var(--fs-sm);
  background: var(--c-surface-2);
}
.chip button { color: var(--c-text-3); font-size: 14px; line-height: 1; }
.chip button:hover { color: var(--c-danger); }
.add {
  height: 24px;
  padding: 0 9px;
  border: 1px dashed var(--c-border-strong);
  border-radius: 12px;
  font-size: var(--fs-sm);
  color: var(--c-text-3);
}
.add:hover { color: var(--c-primary); border-color: var(--c-primary); }
.popover {
  position: absolute;
  left: 0;
  top: 30px;
  width: 280px;
  padding: 12px;
  box-shadow: var(--sh-2);
  z-index: 30;
}
.pop-title {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
  margin-bottom: 8px;
}
.pop-title button { color: var(--c-primary); font-size: var(--fs-sm); }
.opts { display: flex; flex-wrap: wrap; gap: 5px; max-height: 148px; overflow: auto; }
.opts button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 8px;
  border: 1px solid var(--c-border);
  border-radius: 5px;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
  max-width: 100%;
}
.opts button.on { background: var(--c-primary-weak); border-color: var(--c-primary); color: var(--c-primary); }
.new { display: flex; gap: 6px; margin-top: 10px; }
.new .input { flex: 1; height: 30px; }
.manage {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--c-border);
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  font-size: var(--fs-xs);
}
.manage button { color: var(--c-text-3); }
.manage button:hover { color: var(--c-danger); }
</style>
