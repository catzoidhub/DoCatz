import type { TaskProgress } from './types';

/** The whole job's percentage: finished steps plus the current one's share, by their weights; 100 once done. */
export function taskPercent(t: TaskProgress): number {
  if (t.done && !t.error) return 100;
  const w = t.weights?.length === t.steps.length ? t.weights : t.steps.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const step = Math.min(t.step, w.length);
  const before = w.slice(0, step).reduce((a, b) => a + b, 0);
  return Math.min(100, Math.round(((before + (step < w.length ? (t.fraction ?? 0) * w[step] : 0)) / total) * 100));
}
