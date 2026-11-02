<script setup lang="ts">
import { computed } from 'vue';
import type { DcContainer } from '@shared/types';
import { frameworkTag } from '../frameworks';
import { serviceLook } from './logos';

/**
 * What a container runs, as one mark: the framework it is built from (the same marks as DevCatz's site list), else the
 * logo of its image (PostgreSQL, nginx …), else the container icon. `dim`: greyed for a stopped container.
 */
const props = withDefaults(defineProps<{ container: Pick<DcContainer, 'image' | 'framework'>; size?: 'sm' | 'md' | 'lg'; dim?: boolean }>(), { size: 'md', dim: false });
const fw = computed(() => (props.container.framework ? frameworkTag(props.container.framework.framework, props.container.framework.library) : null));
const look = computed(() => serviceLook(props.container.image));
const title = computed(() => fw.value?.label ?? look.value.label);
const box = computed(() => ({ sm: 'size-7 rounded-lg', md: 'size-8 rounded-lg', lg: 'size-9 rounded-xl' })[props.size]);
const inner = computed(() => ({ sm: 'size-[18px]', md: 'size-5', lg: 'size-6' })[props.size]);
</script>

<template>
  <span class="grid shrink-0 place-items-center overflow-hidden border border-base-300/70 bg-base-100" :class="[box, { 'opacity-50 grayscale': dim }]" :title="title">
    <template v-if="fw">
      <img v-if="fw.icon.img" :src="fw.icon.img" alt="" class="rounded object-contain" :class="inner" draggable="false" />
      <svg v-else viewBox="0 0 24 24" :class="inner" :style="{ color: fw.icon.color }" fill="currentColor"><path :d="fw.icon.d" /></svg>
    </template>
    <img v-else-if="look.logo" :src="look.logo" alt="" class="rounded object-contain" :class="inner" draggable="false" />
    <svg v-else viewBox="0 0 20 20" class="text-primary" :class="inner" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5v-7ZM6 7a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 6 7Zm2.75.75a.75.75 0 0 1 1.5 0v4.5a.75.75 0 0 1-1.5 0v-4.5ZM14 7a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 14 7Z" /></svg>
  </span>
</template>
