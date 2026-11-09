import Anthropic from '@anthropic-ai/sdk';
import { aiProvider, DC_ASK_ARGS, DC_ASK_KINDS, type DcAiPreview, type DcAiProvider, type DcAiTurn, type DcAskAction, type DcAskAnswer, type DcAskRequest, type DcContainer, type DcContainerDetail, type DcFileAnswer, type DcFileRequest, type DcLogAnswer, type DcLogRequest, type EngineState } from '@shared/types';
import { words } from '@shared/platform';
import { aiKey, needFeature, settings } from './settings';

/**
 * DoCatz's AI (DoCatz TODO #20; family rules Catzoid #58): Ask DoCatz turns plain words into DoCatz steps the user
 * runs one by one, Explain with AI reads the log lines the user picked, and the compose / Dockerfile helper writes or
 * fixes a file that is shown before anything is saved. Only names, images, states, ports and the picked lines go
 * out — never environment values, mounts, secrets or file contents beyond the file being edited (masked).
 */

const TIMEOUT_MS = 120_000;
const OK_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
/** Model ids that are not chat models (OpenAI, Gemini, Mistral, Groq … list them all together). */
const NOT_CHAT = /embed|whisper|tts|transcribe|dall-e|image|imagen|moderation|audio|realtime|rerank|ocr|speech|veo|aqa|guard/i;

// ---- Ask DoCatz (the ✦ button): DoCatz actions from a fixed list
const ASK_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: DC_ASK_KINDS },
    label: { type: 'string', description: 'Button text, imperative, short' },
    // Every argument any kind takes ('' when unused): structured output needs a closed object.
    args: { type: 'object', properties: Object.fromEntries(DC_ASK_ARGS.map((k) => [k, { type: 'string' }])), required: [...DC_ASK_ARGS], additionalProperties: false },
  },
  required: ['kind', 'label', 'args'],
  additionalProperties: false,
};
const ASK_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' }, actions: { type: 'array', items: ASK_ACTION_SCHEMA } },
  required: ['explanation', 'actions'],
  additionalProperties: false,
};
const ASK_HELP = [
  'Actions DoCatz can run (only these kinds; args are strings, "" when unused):',
  '- start-container / stop-container / restart-container: {container} — a container name from the list.',
  '- remove-container: {container} — DESTRUCTIVE: the container goes (its named volumes stay); DoCatz asks the user to type its name.',
  '- open-container: {container} — its page (info, ports, mounts). open-logs: {container}. open-terminal: {container} — a shell inside it.',
  '- open-url: {container} — opens its domain (https://<service>.<project>.docatz.<tld>) in the browser; only for containers that have one.',
  '- compose-up / compose-restart: {project} — a compose project from the list (up recreates changed services, detached).',
  '- compose-down: {project} — DESTRUCTIVE: stops and removes the project\'s containers and networks (volumes stay).',
  '- start-engine / stop-engine: {} — the Linux VM that runs Docker. Stopping it stops every container.',
  '- prune: {what: "containers" | "images" | "volumes" | "networks" | "build-cache"} — DESTRUCTIVE: DoCatz shows exactly what goes first (stopped containers / unused images / unused volumes …).',
  '- pull-image: {image} — e.g. postgres:17.',
  '- open-section: {section: "containers" | "images" | "volumes" | "networks" | "engine"}.',
  '- set-theme: {theme: "system" | "light" | "dark"} (shared with all Catzoid apps). open-settings: {tab: "general" | "domains" | "ai" | "updates" | "about"}.',
  'Safety: destructive steps only when the user clearly asks for that very thing, never as a side step; say in explanation exactly what goes.',
];

// ---- Explain with AI in Logs
const LOG_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What happened, one or two sentences' },
    cause: { type: 'string', description: 'Why, in plain words' },
    steps: { type: 'array', items: { type: 'string' }, description: 'What to do, step by step' },
    fix: { type: 'string', description: 'A compose snippet, Dockerfile line or command that fixes it; empty when there is none' },
  },
  required: ['summary', 'cause', 'steps', 'fix'],
  additionalProperties: false,
};

// ---- compose files and Dockerfiles
const FILE_SCHEMA = {
  type: 'object',
  properties: { file: { type: 'string', description: 'The whole file, ready to save' }, explanation: { type: 'string' } },
  required: ['file', 'explanation'],
  additionalProperties: false,
};

/** Obvious secrets in log lines and files: passwords, tokens and keys after a name, URLs with a password, known token shapes. */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(\w*(?:pass(?:word)?|secret|token|api_?key|private_?key|credential)\w*)(["']?\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,)]+)/gi, '$1$2•••')
    .replace(/(\w+:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1•••@')
    .replace(/\b(sk|pk|rk|ghp|github_pat|glpat|xox[abprs]|AKIA)[-_A-Za-z0-9]{10,}/g, '•••')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '•••');
}

/** Which model a request goes to (default: the one chosen in Settings), and a way to stop it. */
interface Use {
  provider?: DcAiProvider;
  model?: string;
  signal?: AbortSignal;
  /** Stream the answer: called with the text so far as it arrives. */
  onText?: (soFar: string) => void;
}

/** What Ask DoCatz may see: containers, projects, the engine, where the user is. */
export interface AskContext {
  containers(): Promise<DcContainer[]>;
  container(id: string): Promise<DcContainerDetail>;
  engine(): Promise<EngineState>;
}

export class AskAi {
  /** Running requests, by token (Stop aborts them). */
  private running = new Map<string, AbortController>();

  constructor(private ctx: AskContext) {}

  cancel(token: string): void {
    this.running.get(token)?.abort();
  }

  private async guarded<T>(token: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    if (token) this.running.set(token, ctl);
    try {
      return await fn(ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('Stopped');
      throw e;
    } finally {
      this.running.delete(token);
    }
  }

  // ---------------------------------------------------------------- Ask DoCatz

  async ask(req: DcAskRequest, token = ''): Promise<DcAskAnswer> {
    needFeature('ask');
    if (!req.prompt.trim()) throw new Error('Say what DoCatz should do');
    return this.guarded(token, async (signal) => {
      const { system, turns } = await this.askParts(req);
      const a = await this.complete<DcAskAnswer>(system, turns, ASK_SCHEMA, { signal });
      return { explanation: String(a.explanation ?? '').trim(), actions: await this.cleanActions(a.actions) };
    });
  }

  async previewAsk(req: DcAskRequest): Promise<DcAiPreview> {
    const { provider, model } = this.choice();
    const { system, turns } = await this.askParts(req);
    return { provider: aiProvider(provider).name, model, system, messages: turns };
  }

  private async askParts(req: DcAskRequest): Promise<{ system: string; turns: DcAiTurn[] }> {
    const engine = await this.ctx.engine();
    const list = engine.status === 'running' ? await this.ctx.containers().catch(() => [] as DcContainer[]) : [];
    const line = (c: DcContainer) => `- ${c.name}: ${c.image}, ${c.state} (${c.status})${c.project ? `, compose ${c.project}/${c.service}` : ''}${c.ports.length ? `, ports ${c.ports.map((p) => (p.public ? `${p.public}→${p.private}` : `${p.private}`) + `/${p.type}`).join(' ')}` : ''}${c.url ? `, ${c.url}` : ''}`;
    const projects = [...new Set(list.map((c) => c.project).filter(Boolean))];
    const here = list.find((c) => c.id === req.where.container || c.name === req.where.container);
    const system = [
      `You are the command line of DoCatz, a Docker engine and container manager for ${words.os} (Catzoid family). The user says in plain words what they want; you answer with DoCatz actions that do it (the user clicks each), or just answer when it is a question.`,
      `DoCatz screens: Containers (grouped by compose project; each with Info, Logs, Terminal, Files, Stats), Images, Volumes, Networks, Engine (${engine.backend === 'system' ? 'the system’s Docker Engine, no VM' : 'the VM, its CPUs / memory / disk'}, docker context, CLIs), Settings.`,
      '- Use the container and project names below exactly; never invent them. When the request names something not listed, say so.',
      '- Order actions as they should run (start the engine before what needs it). One to four actions; none when nothing fits.',
      '- explanation: one or two sentences, in the language the user wrote in.',
      ...ASK_HELP,
      '',
      `Engine: ${engine.status}${engine.docker ? ` (Docker ${engine.docker.version}, ${engine.docker.cpus} CPUs)` : ''}.`,
      engine.status === 'running' ? `Containers (${list.length}):\n${list.map(line).join('\n') || '(none)'}` : 'The engine is not running, so no containers are listed: propose start-engine first when the request needs Docker.',
      projects.length ? `Compose projects: ${projects.join(', ')}` : '',
      `The user is on ${req.where.section}${here ? `, container ${here.name}` : ''}.`,
      `DoCatz: theme ${settings().theme === 'system' ? 'Auto' : settings().theme}.`,
    ]
      .filter(Boolean)
      .join('\n');
    return { system, turns: [...(req.history ?? []).slice(-8), { role: 'user', text: req.prompt.trim() }] };
  }

  private async cleanActions(raw: unknown): Promise<DcAskAction[]> {
    if (!Array.isArray(raw)) return [];
    const names = new Set((await this.ctx.containers().catch(() => [] as DcContainer[])).flatMap((c) => [c.name, c.project ?? '']));
    return raw
      .filter((a): a is DcAskAction => !!a && typeof a === 'object' && DC_ASK_KINDS.includes((a as DcAskAction).kind))
      .map((a) => ({
        kind: a.kind,
        label: String(a.label || a.kind).slice(0, 120),
        args: Object.fromEntries(Object.entries(a.args ?? {}).filter(([k, v]) => (DC_ASK_ARGS as readonly string[]).includes(k) && v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, String(v).slice(0, 500)])),
      }))
      // A container or project the model made up never reaches the window.
      .filter((a) => (!a.args.container || names.has(a.args.container)) && (!a.args.project || names.has(a.args.project)))
      .slice(0, 6);
  }

  // ---------------------------------------------------------------- Explain with AI in Logs

  async explainLog(req: DcLogRequest, token = ''): Promise<DcLogAnswer> {
    needFeature('logs');
    if (!req.lines.length) throw new Error('Pick the log lines to ask about');
    return this.guarded(token, async (signal) => {
      const { system, turns } = await this.logParts(req);
      const a = await this.complete<DcLogAnswer>(system, turns, LOG_SCHEMA, { signal });
      return { summary: String(a.summary ?? '').trim(), cause: String(a.cause ?? '').trim(), steps: Array.isArray(a.steps) ? a.steps.map(String).slice(0, 8) : [], fix: String(a.fix ?? '').trim() };
    });
  }

  async previewLog(req: DcLogRequest): Promise<DcAiPreview> {
    const { provider, model } = this.choice();
    const { system, turns } = await this.logParts(req);
    return { provider: aiProvider(provider).name, model, system, messages: turns };
  }

  private async logParts(req: DcLogRequest): Promise<{ system: string; turns: DcAiTurn[] }> {
    const c = await this.ctx.container(req.containerId);
    const system = [
      'You explain container problems for DoCatz, a Docker engine and container manager. The user picked log lines from one container and maybe asked a question.',
      'Answer with JSON {"summary", "cause", "steps", "fix"}: what happened, why in plain words, what to do step by step, and a fix (a compose snippet, a Dockerfile line or a command) when one fits — DoCatz shows it, never runs it.',
      'Write in the language the user wrote in (English when they asked nothing).',
      '',
      `Container ${c.name}: image ${c.image}, ${c.state} (${c.status}), exit code ${c.exitCode ?? '—'}, restarts ${c.restartCount}, restart policy ${c.restartPolicy}${c.project ? `, compose ${c.project}/${c.service}` : ''}, platform ${c.platform}.`,
      `Command: ${c.entrypoint} ${c.command}`.trim(),
    ].join('\n');
    const lines = maskSecrets(req.lines.slice(-400).join('\n')).slice(-40_000);
    return { system, turns: [{ role: 'user', text: `${req.prompt.trim() || 'Explain what went wrong.'}\n\nLog lines:\n${lines}` }] };
  }

  // ---------------------------------------------------------------- compose files and Dockerfiles

  async file(req: DcFileRequest, token = ''): Promise<DcFileAnswer> {
    needFeature('compose');
    if (!req.prompt.trim() && !req.error) throw new Error('Say what the file should do');
    return this.guarded(token, async (signal) => {
      const { system, turns } = this.fileParts(req);
      const a = await this.complete<DcFileAnswer>(system, turns, FILE_SCHEMA, { signal });
      return { file: String(a.file ?? ''), explanation: String(a.explanation ?? '').trim() };
    });
  }

  previewFile(req: DcFileRequest): DcAiPreview {
    const { provider, model } = this.choice();
    const { system, turns } = this.fileParts(req);
    return { provider: aiProvider(provider).name, model, system, messages: turns };
  }

  private fileParts(req: DcFileRequest): { system: string; turns: DcAiTurn[] } {
    const what = req.kind === 'compose' ? 'a Docker Compose file (compose.yaml, the Compose Specification; no top-level "version")' : 'a Dockerfile';
    const system = [
      `You write ${what} for DoCatz, a Docker engine on ${words.os}. Answer with JSON {"file", "explanation"}: the whole file, ready to save, and one to three sentences on what changed.`,
      '- Keep what the user has unless the request changes it; keep comments.',
      '- Never put real secrets in the file: use ${VARIABLE} references and say which ones the user must set.',
      req.kind === 'compose' ? '- Publish web ports as "127.0.0.1:<host>:<container>" unless asked otherwise; DoCatz gives each service https://<service>.<project>.docatz.localhost.' : '- Prefer small official base images, a non-root user and multi-stage builds where they fit.',
      '- explanation in the language the user wrote in.',
    ].join('\n');
    const parts = [req.prompt.trim() || 'Fix the file.'];
    if (req.error) parts.push(`It fails with:\n${maskSecrets(req.error).slice(0, 8000)}`);
    parts.push(req.current.trim() ? `The file now:\n${maskSecrets(req.current).slice(0, 60_000)}` : 'There is no file yet.');
    return { system, turns: [{ role: 'user', text: parts.join('\n\n') }] };
  }

  /** A tiny request to see that the key and model work. */
  async test(): Promise<string> {
    const { provider, model } = this.choice();
    const r = await this.complete<{ ok: boolean }>('Answer with the JSON object {"ok": true}.', [{ role: 'user', text: 'Are you there?' }], OK_SCHEMA);
    if (r.ok !== true) throw new Error('The model answered, but not in the expected form');
    return `${aiProvider(provider).name} · ${model}`;
  }

  /** Models the provider lists for this key, without the ones that cannot chat (embeddings, speech, images …). */
  async models(provider: DcAiProvider): Promise<string[]> {
    return (await this.listModels(provider)).filter((m) => !NOT_CHAT.test(m));
  }

  /**
   * Which of these models answer with this key: one tiny request each (four
   * at a time). null = works, else the provider's reason.
   */
  async probe(provider: DcAiProvider, models: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const list = [...new Set(models)].slice(0, 24);
    for (let i = 0; i < list.length; i += 4)
      await Promise.all(
        list.slice(i, i + 4).map(async (model) => {
          try {
            await this.complete<{ ok: boolean }>('Answer with the JSON object {"ok": true}.', [{ role: 'user', text: 'ok?' }], OK_SCHEMA, { provider, model });
            out[model] = null;
          } catch (e) {
            out[model] = (e as Error).message;
          }
        }),
      );
    return out;
  }

  private async listModels(provider: DcAiProvider): Promise<string[]> {
    const base = this.baseUrl(provider);
    const key = await aiKey(provider);
    if (provider === 'anthropic') {
      const ids: string[] = [];
      for await (const m of this.anthropic(key).models.list()) ids.push(m.id);
      return ids;
    }
    if (provider === 'ollama') {
      const r = (await this.http(`${base}/api/tags`, { method: 'GET' })) as { models?: { name: string }[] };
      return (r.models ?? []).map((m) => m.name);
    }
    if (provider === 'gemini') {
      const r = (await this.http(`${base}/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': this.need(provider, key) } })) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (r.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    }
    const r = (await this.http(`${base}/models`, { method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {} })) as { data?: { id: string }[] };
    return (r.data ?? []).map((m) => m.id).sort();
  }

  // ---------------------------------------------------------------- providers

  private choice(): { provider: DcAiProvider; model: string } {
    const ai = settings().ai;
    if (!ai.enabled) throw new Error('Ask AI is off: turn it on in Settings → AI');
    const info = aiProvider(ai.provider);
    const model = ai.models[ai.provider] || info.models[0] || '';
    if (!model) throw new Error(`Choose a model for ${info.name} in Settings → AI`);
    return { provider: ai.provider, model };
  }

  private baseUrl(provider: DcAiProvider): string {
    return (settings().ai.baseUrls[provider] || aiProvider(provider).baseUrl).replace(/\/+$/, '');
  }

  private need(provider: DcAiProvider, key: string): string {
    if (!key) throw new Error(`Add your ${aiProvider(provider).name} API key in Settings → AI`);
    return key;
  }

  private anthropic(key: string): Anthropic {
    return new Anthropic({ apiKey: this.need('anthropic', key), timeout: TIMEOUT_MS, maxRetries: 1 });
  }

  /** One request with a JSON answer of `schema`'s shape. */
  private async complete<T>(system: string, turns: DcAiTurn[], schema: Record<string, unknown>, use: Use = {}): Promise<T> {
    const chosen = use.provider && use.model ? null : this.choice();
    const provider = use.provider ?? chosen!.provider;
    const model = use.model ?? chosen!.model;
    const signal = use.signal;
    const key = await aiKey(provider);
    const base = this.baseUrl(provider);
    if (use.onText) {
      try {
        return parseJson<T>(await this.streamed(provider, key, base, model, system, turns, schema, signal, use.onText));
      } catch (e) {
        // Some servers do not stream (or not with a JSON answer): ask once more without streaming.
        if (signal?.aborted || /Stopped|API key|declined|cut off/.test((e as Error).message)) throw e;
        console.warn(`Ask AI: streaming failed, asking without it: ${(e as Error).message}`);
      }
    }
    let text: string;
    if (provider === 'anthropic') text = await this.viaAnthropic(key, model, system, turns, schema, signal);
    else if (provider === 'gemini') {
      const r = (await this.http(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.need(provider, key) },
        signal,
        body: { systemInstruction: { parts: [{ text: system }] }, contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })), generationConfig: { responseMimeType: 'application/json' } },
      })) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
      text = r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error(`Gemini gave no answer${r.candidates?.[0]?.finishReason ? ` (${r.candidates[0].finishReason})` : ''}`);
    } else if (provider === 'ollama') {
      const r = (await this.http(`${base}/api/chat`, { method: 'POST', signal, body: { model, stream: false, format: schema, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } })) as { message?: { content?: string } };
      text = r.message?.content ?? '';
    } else {
      // OpenAI and the servers that speak its chat completions API.
      if (provider !== 'openai-compatible') this.need(provider, key);
      const r = (await this.http(`${base}/chat/completions`, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal,
        body: { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] },
      })) as { choices?: { message?: { content?: string; refusal?: string } }[] };
      const m = r.choices?.[0]?.message;
      if (m?.refusal) throw new Error(`The model declined: ${m.refusal}`);
      text = m?.content ?? '';
    }
    return parseJson<T>(text);
  }

  /** One answer, streamed: the text so far goes to `onText` as it arrives; resolves with all of it. */
  private async streamed(provider: DcAiProvider, key: string, base: string, model: string, system: string, turns: DcAiTurn[], schema: Record<string, unknown>, signal: AbortSignal | undefined, onText: (soFar: string) => void): Promise<string> {
    if (provider === 'anthropic') return this.viaAnthropic(key, model, system, turns, schema, signal, onText);
    let text = '';
    const add = (t: string | undefined) => {
      if (!t) return;
      text += t;
      onText(text);
    };
    if (provider === 'gemini') {
      await this.httpStream(`${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { headers: { 'x-goog-api-key': this.need(provider, key) }, signal, body: { systemInstruction: { parts: [{ text: system }] }, contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })), generationConfig: { responseMimeType: 'application/json' } } }, (data) => {
        const r = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        add(r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join(''));
      });
    } else if (provider === 'ollama') {
      await this.httpStream(`${base}/api/chat`, { signal, body: { model, stream: true, format: schema, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } }, (line) => add((JSON.parse(line) as { message?: { content?: string } }).message?.content), 'ndjson');
    } else {
      if (provider !== 'openai-compatible') this.need(provider, key);
      await this.httpStream(`${base}/chat/completions`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal, body: { model, stream: true, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } }, (data) => {
        if (data === '[DONE]') return;
        const r = JSON.parse(data) as { choices?: { delta?: { content?: string; refusal?: string } }[] };
        if (r.choices?.[0]?.delta?.refusal) throw new Error(`The model declined: ${r.choices[0].delta.refusal}`);
        add(r.choices?.[0]?.delta?.content);
      });
    }
    if (!text.trim()) throw new Error('The stream ended without an answer');
    return text;
  }

  /** POSTs and reads the answer as it comes: server-sent events (`data:` lines) or newline-separated JSON. */
  private async httpStream(url: string, o: { headers?: Record<string, string>; body: unknown; signal?: AbortSignal }, onData: (data: string) => void, kind: 'sse' | 'ndjson' = 'sse'): Promise<void> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: JSON.stringify(o.body), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      throw new Error(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
    }
    if (!r.ok || !r.body) throw httpError(url, r.status, await r.text());
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (kind === 'ndjson') {
            if (line) onData(line);
          } else if (line.startsWith('data:')) onData(line.slice(5).trim());
        }
      }
      if (buf.trim()) kind === 'ndjson' ? onData(buf.trim()) : buf.trim().startsWith('data:') && onData(buf.trim().slice(5).trim());
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      throw e;
    }
  }

  private async viaAnthropic(key: string, model: string, system: string, turns: DcAiTurn[], schema: Record<string, unknown>, signal?: AbortSignal, onText?: (soFar: string) => void): Promise<string> {
    try {
      const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // The schema is the long, stable part: cached across the follow-ups of a thread.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: turns.map((t) => ({ role: t.role, content: t.text })),
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      };
      let r;
      if (onText) {
        const stream = this.anthropic(key).beta.messages.stream(params, { signal });
        stream.on('text', (_delta, soFar) => onText(soFar));
        r = await stream.finalMessage();
      } else r = await this.anthropic(key).beta.messages.create(params, { signal });
      if (r.stop_reason === 'refusal') throw new Error(`Claude declined this request${r.stop_details?.explanation ? `: ${r.stop_details.explanation}` : ''}`);
      if (r.stop_reason === 'max_tokens') throw new Error('The answer was cut off; ask for something smaller');
      return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped');
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept the API key (Settings → AI)');
      if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic does not know the model ${model}`);
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached; try again in a moment');
      if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach api.anthropic.com');
      if (e instanceof Anthropic.APIError) throw new Error(`Anthropic: ${e.message}`);
      throw e;
    }
  }

  private async http(url: string, o: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    let r: Response;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      r = await fetch(url, { method: o.method, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      if (timeout.aborted) throw new Error(`${new URL(url).host} did not answer within ${TIMEOUT_MS / 1000} s`);
      throw new Error(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (!r.ok) throw httpError(url, r.status, text);
    return JSON.parse(text);
  }
}

/** A provider's error answer in plain words. */
function httpError(url: string, status: number, text: string): Error {
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? msg;
  } catch {
    /* not JSON */
  }
  return new Error(`${new URL(url).host} answered ${status}${status === 401 || status === 403 ? ' (check the API key in Settings → AI)' : ''}: ${msg}`);
}

/** The JSON object in a model's answer (some wrap it in ``` fences or add a word before it). */
function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error('The model did not answer in the expected form; try again or pick another model');
  }
}
