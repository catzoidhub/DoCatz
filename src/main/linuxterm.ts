import { spawn } from 'node:child_process';
import { run } from './proc';

/**
 * Linux (#101): a terminal window that runs a command and stays open — the desktop's own terminal first (Ptyxis on
 * Ubuntu 25+, GNOME Terminal, Console, Konsole …), as DevCatz's openLinuxTerminal picks one. The script goes to bash as
 * one argument, so nothing in it is read by another shell.
 */
export async function runInLinuxTerminal(script: string): Promise<boolean> {
  const bash = ['bash', '-c', `${script}; exec bash`];
  const tries: [string, string[]][] = [
    ['ptyxis', ['--new-window', '--', ...bash]],
    ['gnome-terminal', ['--', ...bash]],
    ['kgx', ['--', ...bash]],
    ['konsole', ['-e', ...bash]],
    ['xfce4-terminal', ['-x', ...bash]],
    ['alacritty', ['-e', ...bash]],
    ['kitty', bash],
    ['wezterm', ['start', '--', ...bash]],
    ['x-terminal-emulator', ['-e', ...bash]],
  ];
  for (const [cmd, args] of tries) {
    if ((await run('/bin/sh', ['-c', `command -v ${cmd}`], { timeout: 3000 })).code !== 0) continue;
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
    if (ok) return true;
  }
  return false;
}
