/**
 * Standard and Lite (TODO #106): what each is in a line and DoCatz's own measured numbers — shared by the first set-up
 * choice (EngineChoice) and Engine → Settings.
 */
export type EngineKind = 'standard' | 'lite';
export interface EngineCard {
  kind: EngineKind;
  name: string;
  about: string;
}

export function engineCards(wsl: boolean): EngineCard[] {
  return wsl
    ? [
        { kind: 'standard', name: 'Standard', about: 'The WSL 2 engine runs while DoCatz runs.' },
        { kind: 'lite', name: 'Lite', about: 'The same engine and disk, put to sleep when nothing runs so WSL gives its memory back to Windows.' },
      ]
    : [
        { kind: 'standard', name: 'Standard', about: 'A full Ubuntu VM managed by Lima — the most compatible.' },
        { kind: 'lite', name: 'Lite', about: 'DoCatz’s own small Linux VM — lighter and faster to wake. Some Docker features may not work yet.' },
      ];
}

/** [what, Standard, Lite]. Windows: a Ryzen 5 3600 PC, WSL 2 defaults (2026-11-18); macOS: an Apple M4, 4 CPUs / 4 GB. */
export function engineRows(wsl: boolean): [string, string, string][] {
  return wsl
    ? [
        ['Memory of WSL’s VM', 'about 1 GB while it runs', 'none while asleep'],
        ['Nothing running for 15 min', 'Keeps running', 'Sleeps'],
        ['First docker command after that', 'answers at once', 'wakes in about 5 s'],
        ['Containers, images, volumes', 'Same disk', 'Same disk'],
        ['Compatibility', 'Full', 'Full'],
      ]
    : [
        ['First download', 'about 950 MB', 'about 90 MB'],
        ['Memory when idle', 'about 2.8 GB', 'about 430 MB'],
        ['Start until Docker answers', 'about 27 s', 'about 1 s'],
        ['Nothing running for 15 min', 'Keeps running', 'Sleeps, wakes in about 1 s'],
        ['Compatibility', 'Full', 'Most images and compose projects'],
      ];
}
