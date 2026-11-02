import { execFileSync } from 'node:child_process';

/**
 * The computer's own processor, not the app's: the x64 build runs emulated on a Windows ARM PC (Snapdragon, a VM on
 * Apple silicon), where `process.arch` says x64 but WSL runs an arm64 kernel that cannot run an x86_64 Linux. Windows
 * keeps the native one in the registry; elsewhere `process.arch` is right.
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
  return cached;
}
