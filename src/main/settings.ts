import { nativeTheme, safeStorage } from 'electron';
import { DC_AI_DEFAULTS, DC_AI_FEATURES, DC_AI_PROVIDERS, type DcAiFeature, type DoCatzSettings, type DoCatzSettingsPatch, type McatzpSettings, type DcAiProvider, type Theme } from '@shared/types';
import { store } from './store';
import { readShared, setSharedKey, sharedKey, watchShared, writeShared } from './shared';
import { validBrowser } from './browsers';

/**
 * The Settings page's values: appearance, the browser and Ask AI. Checked here (the window
 * is not trusted with the shape), applied at once. The theme, the browser (Open with) and the AI
 * connection (provider, models, addresses, API keys) are shared with the
 * other Catzoid apps (shared.ts: Catzoid/shared.json + the "Catzoid AI"
 * Keychain item), so a key entered in DevCatz works here and the other way
 * round; AI on / off stays DoCatz's own. Keys never leave the main
 * process. What DoCatz kept before (safeStorage) moves over once
 * (migrateToShared).
 */

const KEY = 'settings';
const AI_KEYS = 'aiKeys';
const THEMES: Theme[] = ['system', 'light', 'dark'];
const PROVIDERS = DC_AI_PROVIDERS.map((p) => p.id);
const FEATURES = DC_AI_FEATURES.map((f) => f.id);

type Stored = Omit<DoCatzSettings, 'ai'> & { ai: Omit<DoCatzSettings['ai'], 'keys'> };

const names = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 300))] : []);
const envNamesOf = (a: unknown) => names(a).filter((n) => /^[A-Za-z_][\w.]*$/.test(n));
function mcatzpOf(m: Partial<McatzpSettings> | undefined): McatzpSettings {
  const clients = (Array.isArray(m?.clients) ? m.clients.filter((c) => typeof c?.name === 'string' && typeof c?.approvedAt === 'string') : []).filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i);
  return { on: m?.on === true, all: m?.all === true, projects: names(m?.projects), logs: m?.logs !== false, resources: m?.resources !== false, envValues: m?.envValues !== false, envPublic: envNamesOf(m?.envPublic), envSecret: envNamesOf(m?.envSecret), changes: m?.changes !== false, clients };
}

/** DoCatz's own copy (config.json): the fallback, and the on / off switch. */
function local(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  const ai = { ...DC_AI_DEFAULTS, ...(s.ai ?? {}) };
  return {
    theme: THEMES.includes(s.theme as Theme) ? (s.theme as Theme) : 'system',
    browser: typeof s.browser === 'string' ? s.browser : '',
    mcatzp: mcatzpOf(s.mcatzp),
    ai: { enabled: ai.enabled === true, provider: PROVIDERS.includes(ai.provider) ? ai.provider : 'anthropic', models: ai.models ?? {}, baseUrls: ai.baseUrls ?? {}, off: Array.isArray(ai.off) ? ai.off.filter((f): f is DcAiFeature => FEATURES.includes(f)) : [] },
  };
}

/** The shared values win where they are set. */
function stored(): Stored {
  const s = local();
  const sh = readShared();
  const provider = sh.ai?.provider ?? s.ai.provider;
  return {
    theme: sh.theme && THEMES.includes(sh.theme) ? sh.theme : s.theme,
    browser: typeof sh.browser === 'string' ? sh.browser : s.browser,
    mcatzp: s.mcatzp,
    ai: { enabled: s.ai.enabled, provider: PROVIDERS.includes(provider) ? provider : 'anthropic', models: sh.ai?.models ?? s.ai.models, baseUrls: sh.ai?.baseUrls ?? s.ai.baseUrls, off: s.ai.off },
  };
}

function encryptedKeys(): Partial<Record<DcAiProvider, string>> {
  return store.extra<Partial<Record<DcAiProvider, string>>>(AI_KEYS) ?? {};
}

export function settings(): DoCatzSettings {
  const s = stored();
  const mine = encryptedKeys();
  const shared = new Set(readShared().ai?.keys ?? []);
  return { ...s, ai: { ...s.ai, keys: PROVIDERS.filter((p) => shared.has(p) || mine[p]) } };
}

/** Approved MCatzP clients: only the main process changes them (a pairing answered, Revoke). */
export function setMcatzpClients(clients: McatzpSettings['clients']): void {
  const s = stored();
  s.mcatzp.clients = clients;
  store.setExtra(KEY, s);
}

/** Only known fields, of the right type; model ids and URLs are trimmed and bounded. */
export function setSettings(patch: DoCatzSettingsPatch): DoCatzSettings {
  const s = stored();
  if (patch.theme !== undefined) {
    if (!THEMES.includes(patch.theme)) throw new Error(`Unknown theme ${patch.theme}`);
    s.theme = patch.theme;
  }
  if (patch.browser !== undefined) {
    const b = String(patch.browser);
    if (!validBrowser(b)) throw new Error('That browser is not installed here');
    s.browser = b;
  }
  const ai = patch.ai;
  if (ai) {
    if (ai.enabled !== undefined) s.ai.enabled = ai.enabled === true;
    if (ai.off !== undefined) s.ai.off = Array.isArray(ai.off) ? [...new Set(ai.off)].filter((f) => FEATURES.includes(f)) : [];
    if (ai.provider !== undefined) {
      if (!PROVIDERS.includes(ai.provider)) throw new Error(`Unknown AI provider ${ai.provider}`);
      s.ai.provider = ai.provider;
    }
    for (const [p, m] of Object.entries(ai.models ?? {})) {
      if (!PROVIDERS.includes(p as DcAiProvider)) continue;
      const id = String(m ?? '').trim().slice(0, 200);
      if (id) s.ai.models[p as DcAiProvider] = id;
      else delete s.ai.models[p as DcAiProvider];
    }
    for (const [p, u] of Object.entries(ai.baseUrls ?? {})) {
      if (!PROVIDERS.includes(p as DcAiProvider)) continue;
      const url = String(u ?? '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('The address must start with http:// or https://');
      if (url) s.ai.baseUrls[p as DcAiProvider] = url.slice(0, 500);
      else delete s.ai.baseUrls[p as DcAiProvider];
    }
  }
  const m = patch.mcatzp;
  if (m) {
    if (m.on !== undefined) s.mcatzp.on = m.on === true;
    if (m.all !== undefined) s.mcatzp.all = m.all === true;
    if (m.logs !== undefined) s.mcatzp.logs = m.logs === true;
    if (m.resources !== undefined) s.mcatzp.resources = m.resources === true;
    if (m.changes !== undefined) s.mcatzp.changes = m.changes === true;
    if (m.envValues !== undefined) s.mcatzp.envValues = m.envValues === true;
    if (m.envPublic !== undefined) s.mcatzp.envPublic = envNamesOf(m.envPublic);
    if (m.envSecret !== undefined) s.mcatzp.envSecret = envNamesOf(m.envSecret);
    if (m.projects !== undefined) s.mcatzp.projects = names(m.projects);
  }
  store.setExtra(KEY, s);
  // The theme, the browser and the connection are shared with the Catzoid apps; Ask AI on / off is not.
  const conn = ai && (ai.provider !== undefined || ai.models !== undefined || ai.baseUrls !== undefined);
  if (patch.theme !== undefined || patch.browser !== undefined || conn)
    writeShared({ ...(patch.theme !== undefined ? { theme: s.theme } : {}), ...(patch.browser !== undefined ? { browser: s.browser } : {}), ...(conn ? { ai: { provider: s.ai.provider, models: s.ai.models, baseUrls: s.ai.baseUrls } } : {}) });
  nativeTheme.themeSource = s.theme;
  return settings();
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item; DoCatz's own old copy goes. */
export async function setAiKey(provider: DcAiProvider, key: string): Promise<DoCatzSettings> {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown AI provider ${provider}`);
  await setSharedKey(provider, key);
  const all = { ...encryptedKeys() };
  if (all[provider]) {
    delete all[provider];
    store.setExtra(AI_KEYS, all);
  }
  return settings();
}

/** The key of a provider ('' = none): the shared one, else DoCatz's own from before. Main process only. */
export async function aiKey(provider: DcAiProvider): Promise<string> {
  const shared = await sharedKey(provider);
  if (shared) return shared;
  const v = encryptedKeys()[provider];
  return v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
}

/**
 * Once, at start: the theme and AI connection DoCatz kept on its own move to
 * the shared file and Keychain item, unless another app shared its choice
 * already (that one wins).
 */
export async function migrateToShared(): Promise<void> {
  const own = store.extra<Partial<Stored>>(KEY);
  const mine = local();
  if (!readShared().theme) writeShared({ theme: mine.theme });
  if (!readShared().ai?.provider && own?.ai) writeShared({ ai: { provider: mine.ai.provider, models: mine.ai.models, baseUrls: mine.ai.baseUrls } });
  const keys = encryptedKeys();
  const shared = new Set(readShared().ai?.keys ?? []);
  let moved = false;
  for (const p of PROVIDERS) {
    const v = keys[p];
    if (!v) continue;
    try {
      if (!shared.has(p) && safeStorage.isEncryptionAvailable()) await setSharedKey(p, safeStorage.decryptString(Buffer.from(v, 'base64')));
      delete keys[p];
      moved = true;
    } catch (e) {
      console.warn(`AI key ${p} not moved to the shared Keychain item:`, (e as Error).message);
    }
  }
  if (moved) store.setExtra(AI_KEYS, keys);
}

/** Throws unless Ask AI and this feature are on (Settings → AI). */
export function needFeature(feature: DcAiFeature): void {
  const ai = settings().ai;
  const label = DC_AI_FEATURES.find((f) => f.id === feature)?.label ?? feature;
  if (!ai.enabled) throw new Error('Ask AI is off: turn it on in Settings → AI');
  if (ai.off.includes(feature)) throw new Error(`${label} is switched off in Settings → AI`);
}

/** Applies the saved appearance before the window opens, and follows the other apps' changes. */
export function applySettings(onChange: (s: DoCatzSettings) => void): void {
  nativeTheme.themeSource = stored().theme;
  watchShared(() => {
    nativeTheme.themeSource = stored().theme;
    onChange(settings());
  });
}
