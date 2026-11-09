import { execFileSync } from 'node:child_process';

/**
 * The computer's own processor, not the app's: the x64 build runs emulated on a Windows ARM PC (Snapdragon, a VM on
 * Apple silicon), where `process.arch` says x64 but WSL runs an arm64 kernel that cannot run an x86_64 Linux. Windows
 * keeps the native one in the registry. A Mac says it through sysctl.proc_translated: the Intel build under Rosetta on
 * Apple silicon, where Lima refuses to run translated ("please reinstall lima with native arch", found 2026-11-10) — so
 * the VM side (Lima, the VM, Rosetta for amd64 images) goes native arm64 while the app and its CLIs stay x64.
 */
let cached: 'arm64' | 'x64' | null = null;
export function machineArch(): 'arm64' | 'x64' {
  if (cached) return cached;
  cached = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32' && cached === 'x64') {
    try {
      const out = execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'PROCESSOR_ARCHITECTURE'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (/\bARM64\b/i.test(out)) cached = 'arm64';
    } catch {
      /* keep process.arch */
    }
  }
  if (process.platform === 'darwin' && cached === 'x64') {
    try {
      if (execFileSync('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 5000 }).trim() === '1') cached = 'arm64';
    } catch {
      /* a real Intel Mac has no such key */
    }
  }
  return cached;
}
