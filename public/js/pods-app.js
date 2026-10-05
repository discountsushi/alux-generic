// The stand-alone pod control page (pods.html): just the Pods card, no stage or planner.
import { $, esc, hydrateIcons } from './ui.js';
import { api } from './api.js';
import { store } from './store.js';
import { initHelp } from './help.js';
import { initPods } from './pods.js';

async function start() {
  hydrateIcons();
  initHelp();
  try {
    store.pods = await api.get('/api/pods');
  } catch (err) {
    $('main').innerHTML = `<div class="card empty" style="margin-top:40px"><b>Can’t reach the server</b>${esc(err.message)}<br/>Start it with <span class="mono">npm start</span> in the app folder, then reload.</div>`;
    return;
  }
  initPods({ mount: $('#view-pods'), standalone: true });
}

start();
