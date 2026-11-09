import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLinux, isWin } from './platform';
import { runAsRootLinux } from './linuxadmin';
import { run } from './proc';

/**
 * What the shared domain settings install in the system (DoCatz TODO #61) — the very same pieces DevCatz installs, so
 * each app recognises the other's as its own and there is only ever one of each on a computer:
 * - names without a port: launchd jobs `com.mrcatz.herd.forward-https/-http` running /usr/bin/nc (macOS) or
 *   `netsh interface portproxy` rules (Windows) on [::1] (and 127.0.0.1 when free) :443 / :80 → a proxy's ports;
 * - the resolver for a default domain other than .localhost: /etc/resolver/<tld> marked "# Managed by DevCatz" →
 *   127.0.0.1:53531 (macOS), or NRPT rules commented "DevCatz" for .<tld> and .localhost → 127.53.0.1 (Windows, where
 *   programs other than browsers do not resolve x.localhost by themselves).
 * - Linux (#101, DevCatz's cleanurls.ts): systemd socket units `devcatz-forward-https/-http` handing each connection to
 *   systemd-socket-proxyd, and a systemd-resolved drop-in /etc/systemd/resolved.conf.d/devcatz-<tld>.conf (route-only
 *   `~<tld>`) → 127.0.0.1:53531.
 * Every change asks for the administrator password (macOS, Linux through pkexec) or UAC approval (Windows) once.
 */

const LABEL = 'com.mrcatz.herd.forward';
export const daemonFile = (scheme: 'https' | 'http') => `/Library/LaunchDaemons/${LABEL}-${scheme}.plist`;
const RESOLVER_MARK = '# Managed by DevCatz';
const RESOLVER_MARKS = [RESOLVER_MARK, '# Managed by MrCatz Herd'];
const NRPT_MARK = 'DevCatz';
const resolverFile = (tld: string) => (isLinux ? `/etc/systemd/resolved.conf.d/devcatz-${tld}.conf` : `/etc/resolver/${tld}`);

export type AdminResult = { ok: boolean; message: string };

/** macOS: a shell script as root, after the system's password prompt (`-128` in the message = cancelled). */
export async function runAsAdmin(script: string, prompt: string): Promise<AdminResult> {
  // Linux: polkit's own dialog (pkexec), which shows its own text, not `prompt`.
  if (isLinux) {
    const r = await runAsRootLinux(script);
    return { ok: r.ok, message: r.cancelled ? '-128 Cancelled' : r.message };
  }
  const file = join(tmpdir(), `docatz-admin-${process.pid}-${Date.now()}.sh`);
  writeFileSync(file, script, { mode: 0o700 });
  const r = await run('/usr/bin/osascript', ['-e', `do shell script "/bin/sh '${file}'" with prompt "${prompt.replace(/"/g, '\\"')}" with administrator privileges`], { timeout: 300_000 });
  try {
    writeFileSync(file, '');
  } catch {
    /* gone */
  }
  return { ok: r.code === 0, message: (r.stderr || r.stdout).trim() };
}

/** Windows: PowerShell as administrator (the UAC prompt); the script goes in base64 so no quoting reaches the shell. */
export async function runAsAdminWin(script: string, timeout = 300_000): Promise<AdminResult> {
  const inner = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64');
  const outer = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${inner}'; exit $p.ExitCode } catch { Write-Error $_.Exception.Message; exit 1223 }`;
  const { code, stdout, stderr } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { timeout });
  const message = (stderr || stdout).trim();
  return { ok: code === 0, message: code === 1223 || /cancel/i.test(message) ? '-128 Cancelled' : message || `exit ${code}` };
}

export const cancelled = (r: AdminResult) => /-128|cancel|1223/i.test(r.message);

/** Who has a UDP port (DNS): Windows — netstat, plus the service inside svchost; macOS — lsof. */
export async function udpPortOwner(port: number): Promise<{ name: string; pid: string; service?: string } | null> {
  if (isWin) {
    const { stdout } = await run('netstat', ['-ano', '-p', 'UDP']);
    const pid = stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .find((c) => c[0] === 'UDP' && c[1]?.endsWith(`:${port}`))?.[3];
    if (!pid) return null;
    const t = await run('tasklist', ['/SVC', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = t.stdout.match(/^"([^"]+)","\d+","([^"]*)"/);
    const service = m?.[2] && m[2] !== 'N/A' ? m[2] : undefined;
    return { name: m?.[1] ?? 'process', pid, service };
  }
  if (isLinux) {
    // ss shows the process only for this user's own; root's (systemd-resolved, dnsmasq) shows as a nameless owner.
    const { stdout } = await run('ss', ['-H', '-ulpn', `sport = :${port}`], { timeout: 10_000 });
    if (!stdout.trim()) return null;
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(stdout);
    return { name: m?.[1] ?? 'a system service', pid: m?.[2] ?? '' };
  }
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', `-iUDP:${port}`, '-Fpc']);
  const pid = stdout.match(/^p(\d+)/m)?.[1];
  return pid ? { name: stdout.match(/^c(.+)$/m)?.[1] ?? 'process', pid } : null;
}

/** True when something listens on host:port. */
export function isListening(host: string, port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------- names without a port

type WinRule = { family: 'v4tov4' | 'v6tov6'; listen: string; port: number; target: number };

async function winRules(): Promise<WinRule[]> {
  const out = (await run('netsh', ['interface', 'portproxy', 'show', 'all'], { timeout: 10_000 })).stdout;
  const rules: WinRule[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(127\.0\.0\.1|::1)\s+(\d+)\s+(127\.0\.0\.1|::1)\s+(\d+)$/);
    if (m && ['443', '80'].includes(m[2])) rules.push({ family: m[1] === '::1' ? 'v6tov6' : 'v4tov4', listen: m[1], port: Number(m[2]), target: Number(m[4]) });
  }
  return rules;
}

// Linux: the same units as DevCatz (cleanurls.ts), so either app sees the other's as its own.
const unitFile = (scheme: 'https' | 'http', kind: 'socket' | 'service') => `/etc/systemd/system/devcatz-forward-${scheme}.${kind}`;
const PROXYD = ['/usr/lib/systemd/systemd-socket-proxyd', '/lib/systemd/systemd-socket-proxyd'];

function linuxUnits(scheme: 'https' | 'http', listen: number, target: number, ipv4: boolean): string {
  const socket = `[Unit]
Description=DevCatz: ${scheme} on port ${listen} to its local proxy
${RESOLVER_MARK}

[Socket]
ListenStream=[::1]:${listen}
${ipv4 ? `ListenStream=127.0.0.1:${listen}
` : ''}
[Install]
WantedBy=sockets.target
`;
  const service = `[Unit]
Description=DevCatz: relay ${scheme} to 127.0.0.1:${target}
Requires=devcatz-forward-${scheme}.socket
After=devcatz-forward-${scheme}.socket
${RESOLVER_MARK}

[Service]
ExecStart=$PROXYD 127.0.0.1:${target}
DynamicUser=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
`;
  return `cat > ${unitFile(scheme, 'socket')} <<'MRCATZ_EOF'
${socket}MRCATZ_EOF
cat > ${unitFile(scheme, 'service')} <<MRCATZ_EOF
${service}MRCATZ_EOF
chmod 644 ${unitFile(scheme, 'socket')} ${unitFile(scheme, 'service')}
`;
}

const removeLinuxUnits = `systemctl disable --now devcatz-forward-https.socket devcatz-forward-http.socket >/dev/null 2>&1 || true
systemctl stop devcatz-forward-https.service devcatz-forward-http.service >/dev/null 2>&1 || true
rm -f ${(['https', 'http'] as const).flatMap((s) => [unitFile(s, 'socket'), unitFile(s, 'service')]).join(' ')}
systemctl daemon-reload
`;

/** The port :443 is forwarded to now (null: no forwarding). */
export async function forwardTarget(): Promise<number | null> {
  if (isWin) return (await winRules()).find((r) => r.port === 443)?.target ?? null;
  if (isLinux) {
    try {
      const m = /^ExecStart=\S+ 127\.0\.0\.1:(\d+)/m.exec(readFileSync(unitFile('https', 'service'), 'utf8'));
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }
  try {
    const m = /<string>\/usr\/bin\/nc<\/string>\s*<string>::1<\/string>\s*<string>(\d+)<\/string>/.exec(readFileSync(daemonFile('https'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function plist(scheme: 'https' | 'http', listen: number, target: number, ipv4: boolean): string {
  const v4 = ipv4
    ? `
    <key>ListenersV4</key>
    <dict>
      <key>SockNodeName</key><string>127.0.0.1</string>
      <key>SockServiceName</key><string>${listen}</string>
      <key>SockFamily</key><string>IPv4</string>
    </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}-${scheme}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/nc</string><string>::1</string><string>${target}</string></array>
  <key>UserName</key><string>nobody</string>
  <key>inetdCompatibility</key><dict><key>Wait</key><false/></dict>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockNodeName</key><string>::1</string>
      <key>SockServiceName</key><string>${listen}</string>
      <key>SockFamily</key><string>IPv6</string>
    </dict>${v4}
  </dict>
</dict>
</plist>
`;
}

const removeDaemons = (['https', 'http'] as const).map((s) => `/bin/launchctl bootout system/${LABEL}-${s} 2>/dev/null || true\nrm -f ${daemonFile(s)}\n`).join('');

/** :443 / :80 → httpsPort / httpPort (replacing whatever forwarding is there — there is only one per computer). */
export async function installForward(httpsPort: number, httpPort: number, prompt: string): Promise<AdminResult> {
  const ipv4 = { https: !(await isListening('127.0.0.1', 443)), http: !(await isListening('127.0.0.1', 80)) };
  if (isWin) {
    const lines = ['Set-Service iphlpsvc -StartupType Automatic', 'Start-Service iphlpsvc'];
    for (const r of await winRules()) lines.push(`netsh interface portproxy delete ${r.family} listenaddress=${r.listen} listenport=${r.port} | Out-Null`);
    for (const [listen, target, scheme] of [
      [443, httpsPort, 'https'],
      [80, httpPort, 'http'],
    ] as const) {
      lines.push(`netsh interface portproxy add v6tov6 listenaddress=::1 listenport=${listen} connectaddress=::1 connectport=${target} | Out-Null`);
      if (ipv4[scheme]) lines.push(`netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=${listen} connectaddress=127.0.0.1 connectport=${target} | Out-Null`);
    }
    return runAsAdminWin(lines.join('\n'));
  }
  if (isLinux) {
    const script = `PROXYD=""; for p in ${PROXYD.join(' ')}; do [ -x "$p" ] && PROXYD="$p" && break; done
[ -n "$PROXYD" ] || { echo "systemd-socket-proxyd was not found"; exit 1; }
${removeLinuxUnits}${linuxUnits('https', 443, httpsPort, ipv4.https)}${linuxUnits('http', 80, httpPort, ipv4.http)}systemctl daemon-reload
systemctl enable --now devcatz-forward-https.socket
# Port 80 is best effort: another server (Apache, nginx) may have it.
systemctl enable --now devcatz-forward-http.socket 2>/dev/null || { systemctl disable devcatz-forward-http.socket 2>/dev/null; rm -f ${unitFile('http', 'socket')} ${unitFile('http', 'service')}; systemctl daemon-reload; echo "http forward skipped"; }
`;
    return runAsAdmin(script, prompt);
  }
  const write = (scheme: 'https' | 'http', listen: number, target: number) => `cat > ${daemonFile(scheme)} <<'MRCATZ_EOF'
${plist(scheme, listen, target, ipv4[scheme])}MRCATZ_EOF
chown root:wheel ${daemonFile(scheme)}
chmod 644 ${daemonFile(scheme)}
`;
  const script = `set -e
${removeDaemons}${write('https', 443, httpsPort)}/bin/launchctl bootstrap system ${daemonFile('https')}
${write('http', 80, httpPort)}/bin/launchctl bootstrap system ${daemonFile('http')} 2>/dev/null || { /bin/launchctl bootout system/${LABEL}-http 2>/dev/null; rm -f ${daemonFile('http')}; echo "http forward skipped"; }
`;
  return runAsAdmin(script, prompt);
}

export async function uninstallForward(prompt: string): Promise<AdminResult> {
  if (isWin) {
    const rules = await winRules();
    if (!rules.length) return { ok: true, message: '' };
    return runAsAdminWin(rules.map((r) => `netsh interface portproxy delete ${r.family} listenaddress=${r.listen} listenport=${r.port} | Out-Null`).join('\n'));
  }
  if (isLinux) return existsSync(unitFile('https', 'socket')) || existsSync(unitFile('http', 'socket')) ? runAsAdmin(removeLinuxUnits, prompt) : { ok: true, message: '' };
  if (!existsSync(daemonFile('https')) && !existsSync(daemonFile('http'))) return { ok: true, message: '' };
  return runAsAdmin(removeDaemons, prompt);
}

// ---------------------------------------------------------------- resolver

type NrptRule = { namespace: string; ours: boolean; current: boolean };
async function nrpt(dnsHost: string): Promise<NrptRule[]> {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-DnsClientNrptRule | ForEach-Object { ($_.Namespace -join ',') + '|' + $_.Comment + '|' + ($_.NameServers -join ',') }"], { timeout: 20_000 });
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.includes('|'))
    .flatMap((l) => {
      const [ns, comment, servers = ''] = l.trim().split('|');
      const ours = comment.trim() === NRPT_MARK;
      return ns.split(',').map((n) => ({ namespace: n.trim().toLowerCase(), ours, current: ours && servers.split(',').map((x) => x.trim()).includes(dnsHost) }));
    });
}

/** The namespaces a resolver must cover: the TLD (not .localhost on macOS and Linux, which resolve it), and .localhost on Windows. */
export const resolverZones = (tld: string): string[] => (isWin ? [...new Set([tld, 'localhost'])] : tld === 'localhost' ? [] : [tld]);

/** `ours` = the shared one (DevCatz's or DoCatz's), `foreign` = another tool's, `none`. Every zone must be covered. */
export async function resolverStatus(tld: string, dnsHost: string): Promise<'ours' | 'foreign' | 'none'> {
  const zones = resolverZones(tld);
  if (!zones.length) return 'ours';
  if (isWin) {
    const rules = await nrpt(dnsHost);
    if (zones.every((z) => rules.some((r) => r.namespace === `.${z}` && r.current))) return 'ours';
    return zones.some((z) => rules.some((r) => r.namespace === `.${z}` && !r.ours)) ? 'foreign' : 'none';
  }
  try {
    return RESOLVER_MARKS.some((m) => readFileSync(resolverFile(tld), 'utf8').includes(m)) ? 'ours' : 'foreign';
  } catch {
    return 'none';
  }
}

export async function installResolver(tld: string, dnsHost: string, dnsPort: number, prompt: string): Promise<AdminResult> {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(tld)) throw new Error(`Invalid domain ending ${tld}`);
  if ((await resolverStatus(tld, dnsHost)) === 'foreign') return { ok: false, message: isWin ? `Another tool already has a DNS rule for .${tld}; remove it in that tool first.` : `${resolverFile(tld)} belongs to another tool. Remove that tool's resolver first.` };
  if (isWin) {
    const rules = await nrpt(dnsHost);
    const want = resolverZones(tld).map((z) => `.${z}`).filter((ns) => !rules.some((r) => r.namespace === ns && r.current));
    if (!want.length) return { ok: true, message: '' };
    const lines = [
      ...want.map((ns) => `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${NRPT_MARK}' -and $_.Namespace -contains '${ns}' } | Remove-DnsClientNrptRule -Force`),
      ...want.map((ns) => `Add-DnsClientNrptRule -Namespace '${ns}' -NameServers '${dnsHost}' -Comment '${NRPT_MARK}' | Out-Null`),
      'Clear-DnsClientCache',
    ];
    return runAsAdminWin(lines.join('\n'));
  }
  if (isLinux) {
    // A route-only domain (~tld): only *.<tld> goes to the shared DNS, everything else stays with the network's.
    return runAsAdmin(
      `mkdir -p /etc/systemd/resolved.conf.d
cat > ${resolverFile(tld)} <<'MRCATZ_EOF'
${RESOLVER_MARK}
[Resolve]
DNS=127.0.0.1:${dnsPort}
Domains=~${tld}
MRCATZ_EOF
chmod 644 ${resolverFile(tld)}
systemctl restart systemd-resolved
`,
      prompt,
    );
  }
  return runAsAdmin(
    `set -e
mkdir -p /etc/resolver
cat > ${resolverFile(tld)} <<'MRCATZ_EOF'
${RESOLVER_MARK}
nameserver 127.0.0.1
port ${dnsPort}
MRCATZ_EOF
chmod 644 ${resolverFile(tld)}
/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true
`,
    prompt,
  );
}

export async function uninstallResolver(tld: string, dnsHost: string, prompt: string): Promise<AdminResult> {
  if (isWin) {
    if (!(await nrpt(dnsHost)).some((r) => r.ours)) return { ok: true, message: '' };
    return runAsAdminWin(`Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${NRPT_MARK}' } | Remove-DnsClientNrptRule -Force\nClear-DnsClientCache`);
  }
  if ((await resolverStatus(tld, dnsHost)) !== 'ours' || tld === 'localhost') return { ok: true, message: '' };
  if (isLinux) return runAsAdmin(`rm -f ${resolverFile(tld)}\nsystemctl restart systemd-resolved\n`, prompt);
  return runAsAdmin(`rm -f ${resolverFile(tld)}\n/usr/bin/killall -HUP mDNSResponder 2>/dev/null || true\n`, prompt);
}
