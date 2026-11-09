import { createApp } from 'vue';
import DoCatzApp from './ui/DoCatzApp.vue';
import './assets/main.css';
import '@xterm/xterm/css/xterm.css';
import { currentOS } from '@shared/platform';

// `html.is-win`: CSS for Windows and Linux (room for the window buttons on the right, no traffic lights on the left).
if (currentOS !== 'mac') document.documentElement.classList.add('is-win');

// A file dropped outside a drop zone must not open in the window.
for (const type of ['dragover', 'drop'] as const)
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });

// The window opens at #route=<place> (a docatz:// link or the tray), else Containers.
const h = new URLSearchParams(location.hash.replace(/^#/, ''));
createApp(DoCatzApp, { route: h.get('route') ?? undefined }).mount('#app');
