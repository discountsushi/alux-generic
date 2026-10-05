// Pods card on the Light tab: the real Adaptalux pods, live over Bluetooth from the server. A
// slider per arm, all on/off, saved looks, rave, and each arm can follow a light on the stage
// (its Power slider then drives the real arm). The server pushes every change over /api/pods/events,
// so a phone and the desktop stay in step.
import { $, $$, esc, icon, toast, confirmModal, hydrateIcons, setRangeFill, storage, helpBtn } from './ui.js';
import { api } from './api.js';
import { store, on } from './store.js';

const LINKS_KEY = 'pa.pods.links'; // arm name -> stage placement key
const SETUP_KEY = 'pa.pods.setup'; // set-up block open?
const MODELS = { pod_mini: 'Pod Mini 2.0', pod3: 'Control Pod 3.0' };

let snap = null; // the server's last snapshot
let card;
let links = storage.get(LINKS_KEY) || {};
let stageInfo = null; // { lights, names } from the stage, when it changes
let scanResults = null;
let scanning = false;
let busy = false; // connect / disconnect in flight
let events = null;
const dragging = new Set(); // arms whose slider the user is holding
const pending = new Map(); // arm -> { inflight, next }
const lastSent = new Map(); // arm -> pct last sent for a stage link
let lastToast = 0;

let mountEl = null;
let standalone = false;
const view = () => mountEl || $('#view-light');
const armsOf = () => snap?.arms || [];
const podsOf = () => snap?.pods || [];
const podByName = (name) => podsOf().find((p) => p.name === name);

// mount: where the card goes (default: the top of the Light tab). standalone: the pods.html
// page, which has no stage and no tabs, so the event stream opens right away.
export function initPods({ mount = null, standalone: alone = false } = {}) {
  mountEl = mount;
  standalone = alone;
  snap = store.pods || null;
  card = document.createElement('div');
  card.className = 'card pods-card';
  card.id = 'podsCard';
  view().prepend(card);
  render(true);
  card.addEventListener('click', onClick);
  card.addEventListener('input', onInput);
  card.addEventListener('change', onChange);
  card.addEventListener('pointerup', onRelease);
  card.addEventListener('pointercancel', onRelease);
  if (standalone) {
    listen();
    return;
  }
  on('stage', onStage);
  on('view', (v) => {
    if (v === 'light') listen();
  });
  if (location.hash === '#light') listen();
}

// ---- Server events ------------------------------------------------------------------------

function listen() {
  if (events) return;
  events = new EventSource('/api/pods/events');
  events.addEventListener('pods', (e) => {
    snap = JSON.parse(e.data);
    store.pods = snap;
    render(false);
  });
  events.onerror = () => {
    // EventSource reconnects on its own; the badge shows the gap.
    $('#podsBadge', card)?.classList.add('warn');
  };
}

function err(e) {
  const now = Date.now();
  if (now - lastToast < 1500) return;
  lastToast = now;
  toast(e?.message || String(e), 'bad', 5000);
}

// ---- Render -------------------------------------------------------------------------------

function render(full) {
  if (!card) return;
  const sig = armsOf().map((a) => `${a.name}|${a.pod}|${a.port}`).join(',') + '|' + podsOf().map((p) => p.name).join(',') + '|' + Object.keys(snap?.looks || {}).join(',');
  if (full || card.dataset.sig !== sig) {
    card.dataset.sig = sig;
    card.innerHTML = template();
    hydrateIcons(card);
  }
  patch();
}

function template() {
  return `
    <div class="card-h">
      <i class="ico" data-icon="bulb"></i><h2>Adaptalux pods</h2>${helpBtn('light.pods')}
      <span class="badge" id="podsBadge"></span>
      <div class="actions" id="podsActions"></div>
    </div>
    <div class="pods-setup" id="podsSetup" hidden></div>
    <div class="light-rows" id="podArms"></div>
    <div class="row wrap pods-foot" id="podsFoot"></div>
    <div class="row wrap pods-foot" id="podsRave"></div>
    <div class="hub-note" id="podsNote"></div>`;
}

function armHtml(a) {
  return `<div class="light-row pod-arm" data-arm="${esc(a.name)}">
    <div class="lr-head">
      <button type="button" class="pod-label" data-act="rename" title="Rename this arm"><b data-label></b>${icon('edit')}</button>
      <span class="role-tag" data-port></span>
      <span class="kind-tag bad" data-noarm hidden>no arm</span>
      <span class="spacer"></span>
      <select class="select lr-mod pod-link" data-f="link" aria-label="Follow a light on the stage"></select>
      <label class="toggle"><input type="checkbox" data-f="on" />On</label>
    </div>
    <label class="lr-slider pod-slider"><span>Level</span><input type="range" data-f="pct" min="0" max="100" step="1" /><output data-o="pct"></output></label>
  </div>`;
}

function setupHtml() {
  const pods = podsOf();
  const rows = pods.map(
    (p) => `<div class="pod-row" data-pod="${esc(p.name)}">
      <b>${esc(p.label || p.name)}</b><span class="faint">${esc(MODELS[p.model] || p.model)} · <span class="mono">${esc(p.address)}</span></span>
      <span class="pod-state">${podState(p)}</span>
      <button class="btn small ghost icon danger" data-act="pod-remove" aria-label="Remove this pod">${icon('trash')}</button>
    </div>`,
  );
  const found = (scanResults || []).filter((f) => !pods.some((p) => p.address === f.address));
  const scanBlock =
    scanResults === null
      ? ''
      : found.length
        ? found
            .map(
              (f) => `<div class="pod-row found" data-address="${esc(f.address)}" data-model="${esc(f.model)}">
          <b>${esc(f.name)}</b><span class="faint">${esc(MODELS[f.model] || f.model)} · <span class="mono">${esc(f.address)}</span>${f.rssi != null ? ` · ${f.rssi} dBm` : ''}</span>
          <span></span><button class="btn small" data-act="pod-add">${icon('plus')}Add</button></div>`,
            )
            .join('')
        : `<p class="muted" style="margin:0;font-size:12.5px">No new pods advertising. A pod only shows while it is on, in Bluetooth mode (flashing blue) and not connected to the phone app.</p>`;
  return `<div class="subhead"><i class="ico" data-icon="sliders"></i>Pods<span class="spacer"></span><button class="btn small" data-act="scan" ${scanning ? 'disabled' : ''}>${icon('search')}${scanning ? 'Scanning…' : 'Scan'}</button></div>
    ${rows.join('') || '<p class="muted" style="margin:0 0 10px;font-size:12.5px">No pods set up yet. Turn them on in Bluetooth mode, close the phone app, and scan.</p>'}
    ${scanBlock}
    <div class="row wrap pod-manual">
      <input class="input" id="podAddr" placeholder="Or type an address: E7:FD:17:2F:11:8A" autocomplete="off" spellcheck="false" />
      <select class="select" id="podModel"><option value="pod_mini">Pod Mini 2.0</option><option value="pod3">Control Pod 3.0</option></select>
      <button class="btn small" data-act="pod-add-manual">${icon('plus')}Add</button>
    </div>`;
}

function podState(p) {
  if (p.connected) return `<span class="badge good">${p.batteryPct != null ? `${p.batteryPct}%${p.usb ? ' · USB' : ''}` : 'on'}${p.firmware != null ? ` · fw ${p.firmware}` : ''}</span>`;
  if (p.error) return `<span class="badge bad" title="${esc(p.error)}">${esc(shortError(p.error))}</span>`;
  return '<span class="badge">off</span>';
}

const shortError = (s) => (s.length > 42 ? `${s.slice(0, 40)}…` : s);

function patch() {
  const s = snap;
  const badge = $('#podsBadge', card);
  const actions = $('#podsActions', card);
  const setupOpen = storage.get(SETUP_KEY) ?? !s?.configured;
  // Badge
  let cls = 'badge';
  let text;
  if (!s) text = 'no server';
  else if (!s.configured) text = 'no pods set up';
  else if (s.connecting) text = 'connecting…';
  else if (s.connected) {
    const live = s.pods.filter((p) => p.connected);
    const batt = live.filter((p) => p.batteryPct != null).map((p) => p.batteryPct);
    text = `${live.length} of ${s.pods.length} pod${s.pods.length === 1 ? '' : 's'}${batt.length ? ` · ${Math.min(...batt)}%` : ''}${s.sim ? ' · sim' : ''}`;
    cls += s.connectError ? ' warn' : ' good';
  } else text = s.connectError ? 'could not connect' : 'not connected';
  if (s?.connectError && !s.connected) cls += ' bad';
  badge.className = cls;
  badge.textContent = text;
  badge.title = s?.connectError || '';
  // Actions
  const connected = Boolean(s?.connected);
  actions.innerHTML = [
    `<button class="btn small ghost" data-act="setup" aria-pressed="${setupOpen}">${icon('sliders')}Set-up</button>`,
    connected
      ? `<button class="btn small" data-act="disconnect" ${busy ? 'disabled' : ''}>Disconnect</button>`
      : `<button class="btn small ghost" data-act="connect-sim" ${busy || s?.connecting ? 'disabled' : ''}>Sim</button>
         <button class="btn small primary" data-act="connect" ${busy || s?.connecting || !s?.configured ? 'disabled' : ''}>${icon('bulb')}Connect</button>`,
  ].join('');
  hydrateIcons(actions);
  // Set-up block
  const setup = $('#podsSetup', card);
  setup.hidden = !setupOpen;
  if (setupOpen) {
    const html = setupHtml();
    if (setup.dataset.html !== html) {
      const addr = $('#podAddr', setup)?.value;
      setup.innerHTML = html;
      setup.dataset.html = html;
      if (addr) $('#podAddr', setup).value = addr;
      hydrateIcons(setup);
    }
  }
  // Arms
  const rowsEl = $('#podArms', card);
  const arms = armsOf();
  if (!arms.length) {
    rowsEl.innerHTML = s?.configured ? '' : `<div class="empty">${icon('bulb')}<b>No arms yet</b>Add your pods under Set-up; each port becomes an arm here.</div>`;
    hydrateIcons(rowsEl);
  } else {
    if ($$('.pod-arm', rowsEl).length !== arms.length) {
      rowsEl.innerHTML = arms.map(armHtml).join('');
      hydrateIcons(rowsEl);
    }
    for (const a of arms) patchArm(a);
  }
  // Footer
  renderFoot();
  renderRave();
  const note = $('#podsNote', card);
  note.innerHTML = !s?.configured
    ? ''
    : !connected
      ? 'Connecting takes the pods away from the Adaptalux phone app until you disconnect; their buttons still work.'
      : links && Object.keys(links).some((k) => arms.some((a) => a.name === k))
        ? 'Arms set to follow a stage light take that light’s Power slider; moving their own slider overrides it until the stage changes again.'
        : '';
}

function patchArm(a) {
  const row = $(`.pod-arm[data-arm="${CSS.escape(a.name)}"]`, card);
  if (!row) return;
  const live = a.connected;
  row.classList.toggle('off', !live);
  $('[data-label]', row).textContent = a.label;
  $('[data-port]', row).textContent = `${a.pod} · port ${a.port}`;
  $('[data-noarm]', row).hidden = a.present !== false;
  const range = $('input[data-f="pct"]', row);
  range.disabled = !live;
  if (!dragging.has(a.name)) {
    range.value = String(Math.round(a.pct));
    setRangeFill(range);
    $('[data-o="pct"]', row).textContent = `${Math.round(a.pct)}%`;
  }
  const onBox = $('input[data-f="on"]', row);
  onBox.disabled = !live;
  if (!dragging.has(a.name)) onBox.checked = a.pct > 0;
  const sel = $('select[data-f="link"]', row);
  const options = [['', 'Own slider'], ...(stageInfo ? stageInfo.lights.map((p) => [p.key, `Follows ${stageInfo.names[p.key] || p.key}`]) : [])];
  const want = options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if (sel.dataset.html !== want) {
    sel.innerHTML = want;
    sel.dataset.html = want;
  }
  sel.value = links[a.name] && options.some(([v]) => v === links[a.name]) ? links[a.name] : '';
  sel.hidden = !stageInfo || !stageInfo.lights.length;
}

function renderFoot() {
  const foot = $('#podsFoot', card);
  const looks = Object.keys(snap?.looks || {});
  const live = Boolean(snap?.connected);
  const sel = $('#podLook', foot);
  const chosen = sel?.value || '';
  const name = $('#podLookName', foot)?.value || '';
  const html = `
    <button class="btn small" data-act="all-on" ${live ? '' : 'disabled'}>${icon('bulb')}All on 100%</button>
    <button class="btn small" data-act="all-off" ${live ? '' : 'disabled'}>All off</button>
    <span class="spacer"></span>
    <select class="select lr-mod" id="podLook" aria-label="Saved looks"><option value="">${looks.length ? 'Looks…' : 'No looks saved'}</option>${looks.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
    <button class="btn small" data-act="look-apply" ${live && looks.length ? '' : 'disabled'}>Apply</button>
    <button class="btn small ghost icon danger" data-act="look-delete" aria-label="Delete this look" ${looks.length ? '' : 'disabled'}>${icon('trash')}</button>
    <input class="input pod-look-name" id="podLookName" placeholder="Name this look" autocomplete="off" maxlength="40" />
    <button class="btn small" data-act="look-save" ${live ? '' : 'disabled'}>${icon('check')}Save look</button>`;
  if (foot.dataset.html !== html) {
    foot.innerHTML = html;
    foot.dataset.html = html;
    hydrateIcons(foot);
    if (chosen) $('#podLook', foot).value = chosen;
    if (name) $('#podLookName', foot).value = name;
  }
}

function renderRave() {
  const el = $('#podsRave', card);
  const live = Boolean(snap?.connected);
  const bpmNow = $('#podBpm', el)?.value;
  if (!el.dataset.ready) {
    el.innerHTML = `<label class="toggle"><input type="checkbox" data-f="rave" />Rave</label>
      <input class="input pod-bpm" id="podBpm" inputmode="numeric" value="128" aria-label="BPM" /><span class="faint">BPM · 40 to 180, never faster than 3 changes a second</span>`;
    el.dataset.ready = '1';
  }
  const box = $('input[data-f="rave"]', el);
  box.disabled = !live;
  box.checked = Boolean(snap?.rave);
  const bpm = $('#podBpm', el);
  bpm.disabled = !live;
  if (snap?.rave && document.activeElement !== bpm) bpm.value = String(snap.rave.bpm);
  else if (bpmNow) bpm.value = bpmNow;
}

// ---- Sending levels -----------------------------------------------------------------------

// One request in flight per arm; the newest value waits its turn (a slider fires many a second).
function sendLevel(arm, pct, confirm = true) {
  lastSent.set(arm, pct);
  const st = pending.get(arm) || { inflight: null, next: null };
  pending.set(arm, st);
  const run = (job) => {
    st.inflight = api
      .post('/api/pods/set', { levels: { [arm]: job.pct }, confirm: job.confirm })
      .catch(err)
      .finally(() => {
        st.inflight = null;
        if (st.next) {
          const n = st.next;
          st.next = null;
          run(n);
        }
      });
  };
  if (st.inflight) st.next = { pct, confirm };
  else run({ pct, confirm });
}

async function action(fn, { refresh = true } = {}) {
  busy = true;
  patch();
  try {
    await fn();
  } catch (e) {
    err(e);
  } finally {
    busy = false;
    if (refresh && !events) {
      try {
        snap = await api.get('/api/pods');
        store.pods = snap;
      } catch {}
    }
    render(false);
  }
}

// ---- Events -------------------------------------------------------------------------------

function onInput(e) {
  const t = e.target;
  const row = t.closest('.pod-arm');
  if (row && t.dataset.f === 'pct') {
    const arm = row.dataset.arm;
    dragging.add(arm);
    setRangeFill(t);
    $('[data-o="pct"]', row).textContent = `${t.value}%`;
    $('input[data-f="on"]', row).checked = Number(t.value) > 0;
    sendLevel(arm, Number(t.value), false);
  }
}

function onRelease(e) {
  const t = e.target;
  const row = t.closest?.('.pod-arm');
  if (row && t.dataset.f === 'pct') {
    const arm = row.dataset.arm;
    if (dragging.has(arm)) {
      dragging.delete(arm);
      sendLevel(arm, Number(t.value), true);
    }
  }
}

function onChange(e) {
  const t = e.target;
  const row = t.closest('.pod-arm');
  if (row) {
    const arm = row.dataset.arm;
    if (t.dataset.f === 'pct') {
      dragging.delete(arm);
      sendLevel(arm, Number(t.value), true);
    } else if (t.dataset.f === 'on') {
      sendLevel(arm, t.checked ? 100 : 0, true);
    } else if (t.dataset.f === 'link') {
      if (t.value) links[arm] = t.value;
      else delete links[arm];
      storage.set(LINKS_KEY, links);
      lastSent.delete(arm);
      followStage();
      patch();
    }
    return;
  }
  if (t.dataset.f === 'rave') {
    action(() => api.post('/api/pods/rave', t.checked ? { bpm: Number($('#podBpm', card).value) || 128 } : { on: false }));
  } else if (t.id === 'podBpm' && snap?.rave) {
    action(() => api.post('/api/pods/rave', { bpm: Number(t.value) || 128 }));
  } else if (t.id === 'podLook') {
    $('#podLookName', card).value = t.value;
  }
}

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const row = btn.closest('.pod-arm');
  switch (act) {
    case 'setup': {
      const open = !(storage.get(SETUP_KEY) ?? !snap?.configured);
      storage.set(SETUP_KEY, open);
      patch();
      break;
    }
    case 'connect':
      action(() => api.post('/api/pods/connect', { sim: false }).then((r) => r.problems?.length && toast(r.problems.join('; '), 'warn', 6000)));
      break;
    case 'connect-sim':
      action(() => api.post('/api/pods/connect', { sim: true }));
      break;
    case 'disconnect':
      action(() => api.post('/api/pods/disconnect'));
      break;
    case 'scan':
      scanning = true;
      patch();
      api
        .post('/api/pods/scan', { ms: 6000 })
        .then((r) => {
          scanResults = r.found;
          if (!r.found.length) toast('No pods found advertising', 'warn');
        })
        .catch(err)
        .finally(() => {
          scanning = false;
          patch();
        });
      break;
    case 'pod-add': {
      const found = btn.closest('.found');
      addPod(found.dataset.address, found.dataset.model);
      break;
    }
    case 'pod-add-manual':
      addPod($('#podAddr', card).value, $('#podModel', card).value);
      break;
    case 'pod-remove': {
      const name = btn.closest('.pod-row').dataset.pod;
      confirmModal({ title: `Remove pod ${name}?`, body: 'Its arms, their labels and links go with it. Saved looks keep their other arms.', ok: 'Remove' }).then((ok) => {
        if (!ok) return;
        const cfg = currentConfig();
        delete cfg.pods[name];
        for (const [arm, a] of Object.entries(cfg.arms)) if (a.pod === name) delete cfg.arms[arm];
        action(() => api.put('/api/pods/config', cfg));
      });
      break;
    }
    case 'rename': {
      const arm = armsOf().find((a) => a.name === row.dataset.arm);
      const text = prompt(`Name for this arm (${arm.pod} port ${arm.port}). Blank goes back to "${arm.name}".`, arm.label === arm.name ? '' : arm.label);
      if (text === null) return;
      action(() => api.put(`/api/pods/arms/${encodeURIComponent(arm.name)}/label`, { label: text }));
      break;
    }
    case 'all-on':
      action(() => api.post('/api/pods/all', { pct: 100 }));
      break;
    case 'all-off':
      action(() => api.post('/api/pods/all', { pct: 0 }));
      break;
    case 'look-apply': {
      const name = $('#podLook', card).value;
      if (!name) return toast('Pick a look first', 'warn');
      action(() => api.post(`/api/pods/looks/${encodeURIComponent(name)}/apply`));
      break;
    }
    case 'look-save': {
      const name = $('#podLookName', card).value.trim();
      if (!name) return toast('Give the look a name', 'warn');
      action(() => api.post('/api/pods/looks', { name }).then(() => toast(`Saved look “${name}”`)));
      break;
    }
    case 'look-delete': {
      const name = $('#podLook', card).value;
      if (!name) return toast('Pick a look first', 'warn');
      confirmModal({ title: `Delete look “${name}”?`, ok: 'Delete' }).then((ok) => ok && action(() => api.del(`/api/pods/looks/${encodeURIComponent(name)}`)));
      break;
    }
  }
}

// The set-up as the server holds it, ready to edit and PUT back.
function currentConfig() {
  const pods = {};
  for (const p of podsOf()) pods[p.name] = { address: p.address, model: p.model, boost: p.boost ?? null, label: p.label === p.name ? '' : p.label };
  const arms = {};
  for (const a of armsOf()) arms[a.name] = { pod: a.pod, port: a.port, label: a.label === a.name ? '' : a.label };
  return { pods, arms, settings: snap?.settings || {} };
}

function addPod(address, model) {
  const cfg = currentConfig();
  const clean = String(address || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
  if (clean.length !== 12) return toast('A Bluetooth address is 6 hex bytes, like E7:FD:17:2F:11:8A', 'warn');
  const addr = clean.match(/../g).join(':');
  if (Object.values(cfg.pods).some((p) => p.address === addr)) return toast('That pod is already set up', 'warn');
  const base = model === 'pod3' ? 'big' : 'mini';
  let name = base;
  for (let i = 2; cfg.pods[name]; i++) name = `${base}_${i}`;
  cfg.pods[name] = { address: addr, model, boost: null, label: '' };
  const ports = model === 'pod3' ? [1, 2, 3, 4, 5] : [2];
  for (const port of ports) cfg.arms[ports.length === 1 ? name : `${name}_${port}`] = { pod: name, port, label: '' };
  action(() =>
    api.put('/api/pods/config', cfg).then(() => {
      toast(`Added ${MODELS[model]} as ${name}`);
      if ($('#podAddr', card)) $('#podAddr', card).value = '';
    }),
  );
}

// ---- The stage ----------------------------------------------------------------------------

function onStage(info) {
  stageInfo = info;
  for (const a of armsOf()) patchArm(a);
  followStage();
}

// Arms that follow a stage light take its Power (0 when it is off).
function followStage() {
  if (!stageInfo || !snap?.connected) return;
  for (const a of armsOf()) {
    const key = links[a.name];
    if (!key || !a.connected) continue;
    const p = stageInfo.lights.find((l) => l.key === key);
    if (!p) continue;
    const pct = p.on === false ? 0 : Math.round(Math.min(100, Math.max(0, Number(p.power ?? 100))));
    if (lastSent.get(a.name) === pct) continue;
    sendLevel(a.name, pct, false);
  }
}
