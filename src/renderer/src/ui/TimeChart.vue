<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * A small time chart without a dependency: one line per series (area under it when there is one), a value scale on
 * the left, time on the bottom, a legend, and a crosshair with every series' value under the pointer.
 */
export interface Series {
  name: string;
  color: string;
  points: { t: number; v: number }[];
}
const props = withDefaults(defineProps<{ series: Series[]; format: (v: number) => string; height?: number; minMax?: number }>(), { height: 180, minMax: 1 });

const W = 600;
const PAD = { l: 52, r: 10, t: 10, b: 22 };
const H = computed(() => props.height);
const all = computed(() => props.series.flatMap((s) => s.points));
const t0 = computed(() => Math.min(...all.value.map((p) => p.t), Date.now() - 60_000));
const t1 = computed(() => Math.max(...all.value.map((p) => p.t), t0.value + 1));
/** A round top for the scale (1, 2, 5 × 10^n). */
const max = computed(() => {
  const m = Math.max(props.minMax, ...all.value.map((p) => p.v));
  const e = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 2.5, 5, 10].map((k) => k * e).find((x) => x >= m) ?? m;
});
const x = (t: number) => PAD.l + ((t - t0.value) / (t1.value - t0.value)) * (W - PAD.l - PAD.r);
const y = (v: number) => PAD.t + (1 - v / max.value) * (H.value - PAD.t - PAD.b);
const path = (pts: { t: number; v: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
const area = (pts: { t: number; v: number }[]) => (pts.length > 1 ? `${path(pts)} L${x(pts[pts.length - 1].t).toFixed(1)},${y(0)} L${x(pts[0].t).toFixed(1)},${y(0)} Z` : '');
const ticks = computed(() => [0, 0.5, 1].map((k) => ({ v: max.value * k, y: y(max.value * k) })));
const timeTicks = computed(() => {
  const span = t1.value - t0.value;
  return [0, 0.5, 1].map((k) => {
    const t = t0.value + span * k;
    const ago = Math.round((Date.now() - t) / 1000);
    return { x: x(t), label: ago < 5 ? 'now' : ago < 120 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago` };
  });
});

// ---- crosshair
const hover = ref<number | null>(null);
const svg = ref<SVGSVGElement | null>(null);
function move(e: MouseEvent) {
  const r = svg.value!.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * W;
  if (px < PAD.l || px > W - PAD.r) return void (hover.value = null);
  hover.value = t0.value + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1.value - t0.value);
}
const at = computed(() => {
  if (hover.value === null) return null;
  const rows = props.series
    .map((s) => {
      const p = s.points.reduce<{ t: number; v: number } | null>((best, q) => (!best || Math.abs(q.t - hover.value!) < Math.abs(best.t - hover.value!) ? q : best), null);
      return p ? { name: s.name, color: s.color, v: p.v, t: p.t } : null;
    })
    .filter((r): r is { name: string; color: string; v: number; t: number } => r !== null);
  if (!rows.length) return null;
  return { x: x(rows[0].t), rows, time: new Date(rows[0].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
});
</script>

<template>
  <div>
   <div class="relative">
    <svg ref="svg" :viewBox="`0 0 ${W} ${H}`" class="w-full select-none" :style="{ height: `${H}px` }" preserveAspectRatio="none" @mousemove="move" @mouseleave="hover = null">
      <g class="text-base-content">
        <line v-for="tk in ticks" :key="tk.v" :x1="PAD.l" :x2="W - PAD.r" :y1="tk.y" :y2="tk.y" stroke="currentColor" stroke-opacity="0.08" />
      </g>
      <template v-for="s in series" :key="s.name">
        <path v-if="series.length === 1" :d="area(s.points)" :fill="s.color" fill-opacity="0.14" />
        <path :d="path(s.points)" fill="none" :stroke="s.color" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </template>
      <line v-if="at" :x1="at.x" :x2="at.x" :y1="PAD.t" :y2="H - PAD.b" stroke="currentColor" class="text-base-content" stroke-opacity="0.35" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
    </svg>
    <!-- scale and time as HTML, so they stay crisp whatever the width -->
    <span v-for="tk in ticks" :key="`l${tk.v}`" class="pointer-events-none absolute left-0 -translate-y-1/2 font-mono text-[10px] opacity-50" :style="{ top: `${(tk.y / H) * 100}%` }">{{ format(tk.v) }}</span>
    <div class="pointer-events-none absolute right-2.5 bottom-0 left-[52px] flex justify-between font-mono text-[10px] opacity-45">
      <span v-for="tt in timeTicks" :key="tt.label">{{ tt.label }}</span>
    </div>
    <div v-if="at" class="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-base-300 bg-base-100/95 px-2.5 py-1.5 text-xs shadow-lg" :style="{ left: `min(calc(${(at.x / W) * 100}% + 10px), calc(100% - 10rem))` }">
      <div class="mb-0.5 font-mono text-[10px] opacity-50">{{ at.time }}</div>
      <div v-for="r in at.rows" :key="r.name" class="flex items-center gap-1.5"><span class="size-2 rounded-full" :style="{ background: r.color }" /><span class="flex-1 truncate">{{ r.name }}</span><span class="font-mono">{{ format(r.v) }}</span></div>
    </div>
   </div>
    <div v-if="series.length > 1" class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-[52px] text-[11px]">
      <span v-for="s in series" :key="s.name" class="flex items-center gap-1.5 opacity-75"><span class="size-2 rounded-full" :style="{ background: s.color }" />{{ s.name }}</span>
    </div>
  </div>
</template>
