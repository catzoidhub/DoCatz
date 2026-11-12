import { ref } from 'vue';
import { api, attempt } from './store';

/**
 * Support Catzoid (Catzoid #94), the same in every Catzoid app: donating is never required, and joining the community
 * already helps. Both links open the Catzoid site (the shared site address), so the Discord invite and the donation
 * links change there (/admin/links) without an app update.
 */
export const SUPPORT_TEXT = 'DoCatz is free and open source, and it stays that way. You never have to donate: joining the community so DoCatz feels alive is already valuable support.';

const site = ref<string | null>(null);
/** The shared site address (dev.catzoid.tech → catzoid.com), read once. */
export async function supportSite(): Promise<string | null> {
  if (!site.value) site.value = (await attempt(() => api.aboutInfo()))?.site ?? null;
  return site.value;
}

export async function openCommunity(): Promise<void> {
  const s = await supportSite();
  if (s) void api.openUrl(`${s}/community#talk`);
}
export async function openDonate(): Promise<void> {
  const s = await supportSite();
  if (s) void api.openUrl(`${s}/community#support`);
}
