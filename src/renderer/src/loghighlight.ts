import { ansiToHtml } from './ansi';

/**
 * One log line as HTML, coloured like a code editor: a line that brings its own ANSI colours keeps them; any other line
 * is tokenised — times, levels, HTTP methods and statuses, URLs and paths, quoted strings, key=value / "key": keys,
 * numbers, and the compose prefix (`@scope/app dev:`). Every piece is escaped; only the spans below are added.
 */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LEVELS: [RegExp, string][] = [
  [/^(error|err|fatal|panic|crit(ical)?|emerg(ency)?|alert|exception|failed|failure)$/i, 'lg-error'],
  [/^(warn(ing)?|deprecated)$/i, 'lg-warn'],
  [/^(info|notice|log|ready|success|started|listening|done|ok)$/i, 'lg-info'],
  [/^(debug|trace|verbose|statement|detail|hint)$/i, 'lg-debug'],
];
const levelClass = (w: string) => LEVELS.find(([re]) => re.test(w))?.[1] ?? null;

// One alternation; the first group that matches names the token.
const TOKENS = new RegExp(
  [
    /(?<time>\b\d{4}[-/]\d\d[-/]\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z| ?UTC|[+-]\d\d:?\d\d)?|\b\d\d:\d\d:\d\d(?:[.,]\d+)?(?: ?[AP]M)?)/.source,
    /(?<url>\b(?:https?|wss?|postgres(?:ql)?|mysql|redis|mongodb|amqp|smtp):\/\/[^\s"'<>)\]]+)/.source,
    /(?<ip>\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b)/.source,
    /(?<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.source,
    /(?<key>\b[A-Za-z_][\w.-]*(?==))/.source,
    /(?<method>\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b)/.source,
    /(?<path>(?<![\w.])\/[\w@.~%+-]+(?:\/[\w@.~%+:-]*)*(?:\?[^\s"']*)?)/.source,
    /(?<level>\b[A-Za-z]{3,9}\b)/.source,
    /(?<num>\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|KiB|MiB|GiB|%)?\b)/.source,
  ].join('|'),
  'g',
);

function tokens(text: string): string {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(TOKENS)) {
    const g = m.groups!;
    const t = m[0];
    let cls: string | null = null;
    if (g.time) cls = 'lg-time';
    else if (g.url) cls = 'lg-url';
    else if (g.ip) cls = 'lg-num';
    else if (g.str) cls = /^"[\w.-]+"$/.test(t) && text.slice(m.index! + t.length).trimStart().startsWith(':') ? 'lg-key' : 'lg-str';
    else if (g.key) cls = 'lg-key';
    else if (g.method) cls = 'lg-method';
    else if (g.path) cls = 'lg-path';
    else if (g.level) cls = levelClass(t);
    else if (g.num) {
      // an HTTP status right after `HTTP/1.1"` or `status=`: coloured by its class
      const n = Number(t);
      const status = Number.isInteger(n) && n >= 100 && n < 600 && /(HTTP\/[\d.]+"?\s+|status(?:code)?["']?\s*[=:]\s*|\s(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+)$/i.test(text.slice(0, m.index));
      cls = status ? (n >= 500 ? 'lg-error' : n >= 400 ? 'lg-warn' : n >= 300 ? 'lg-path' : 'lg-ok') : 'lg-num';
    }
    if (!cls) continue;
    out += escape(text.slice(at, m.index)) + `<span class="${cls}">${escape(t)}</span>`;
    at = m.index! + t.length;
  }
  return out + escape(text.slice(at));
}

export function highlightLog(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[[\d;]*m/.test(text)) return ansiToHtml(text);
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '');
  // `@scope/app dev: …` / `web-1  | …`: the prefix a runner adds, quiet
  const pre = /^(@[\w.-]+\/[\w.-]+ [\w:-]+: |[\w.-]+\s+\| )/.exec(clean);
  return pre ? `<span class="lg-prefix">${escape(pre[1])}</span>${tokens(clean.slice(pre[1].length))}` : tokens(clean);
}

/** A whole line that reads as a failure or a warning (for its gutter mark). */
export const lineTone = (text: string): 'error' | 'warn' | null =>
  /\b(error|fatal|panic|exception|failed|level=error|ERR!)\b/i.test(text) ? 'error' : /\b(warn(ing)?|level=warn(ing)?|deprecated)\b/i.test(text) ? 'warn' : null;
