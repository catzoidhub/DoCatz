/**
 * What keeps secrets out of what a client reads (TODO #94; DialCatz's mask.ts is the model). By name alone is not
 * enough: an app can log its database password under any name. So there are two nets: the values DoCatz itself knows are
 * secret (every container's secret-looking environment values, its projects' .env, the database passwords, whether
 * shared or not) are taken out wherever they appear, as they are, URL-encoded and in base64; and what looks like a secret
 * by its name or shape goes too. Mask first and cut after: a cut can split a secret in two.
 */
export const MASK = '•••';
export const SECRET_NAME = /passw(or)?d|passphrase|\bpwd\b|\bpass\b|secret|token|api[-_ ]?key|apikey|access[-_ ]?key|private[-_ ]?key|app_key|credential|authori[sz]ation|\bauth\b|cookie|session|\bjwt\b|\bsalt\b|\botp\b|\bcsrf\b|\bxsrf\b|\bdsn\b/i;

const encodings = (v: string): string[] => [v, encodeURIComponent(v), Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url')];

/** Too short to be told from ordinary text ("1", "yes"): it goes out by name only. */
const MIN_SECRET = 4;

export function addSecret(out: Set<string>, value: string | null | undefined): void {
  if (!value || value.length < MIN_SECRET || /^(true|false|null|none|root|admin|http|https|localhost|127\.0\.0\.1)$/i.test(value)) return;
  for (const e of encodings(value)) out.add(e);
}

/** The secret-looking values of an environment (a container's, a .env's), and the password inside any address (postgres://u:p@h). */
export function addEnvSecrets(out: Set<string>, env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME.test(k)) addSecret(out, v);
    const inUrl = /:\/\/[^/\s:@]*:([^@\s/]+)@/.exec(v);
    if (inUrl) addSecret(out, inUrl[1]);
  }
}

/** The longest first, so a value holding a shorter one goes out whole. */
export const secretList = (out: Set<string>): string[] => [...out].sort((a, b) => b.length - a.length);

const PATTERNS: [RegExp, (...g: string[]) => string][] = [
  // Before name=value: there, `Authorization: Bearer abc` would lose only the word Bearer and keep the token.
  [/\b(bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (word) => `${word} ${MASK}`],
  // name=value, "name": "value", name: value — a secret-looking name in any text, a form body or a query string.
  [/((?:[\w.-]*(?:passw(?:or)?d|passphrase|pwd|secret|token|(?<![A-Za-z])key|apikey|credential|authorization|cookie|session|jwt|otp|csrf|xsrf|dsn)[\w.-]*))(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,&;)}\]]+)/gi, (name, sep) => `${name}${sep}${MASK}`],
  // --requirepass meow, --password=x, -pSecret stays out of a command line
  [/(--?[\w-]*(?:pass(?:word)?|secret|token|api-?key)[\w-]*)([= ]+)("[^"]*"|'[^']*'|\S+)/gi, (flag, sep) => `${flag}${sep}${MASK}`],
  // postgres://user:password@host
  [/(\w+:\/\/[^:/\s@]*:)[^@\s/]+@/g, (start) => `${start}${MASK}@`],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g, () => MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => MASK],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[abprs]|dct|AKIA|ASIA)[-_A-Za-z0-9]{10,}/g, () => MASK],
];

/** Plain text: the known values, then what looks like a secret. */
export function maskText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(MASK);
  for (const [re, to] of PATTERNS) out = out.replace(re, (_m: string, ...g: string[]) => to(...g));
  return out;
}
