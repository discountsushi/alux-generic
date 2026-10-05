// Every set-up pod and arm: connect, set levels, looks, labels, rave. Levels are percent (0..100)
// and arms are addressed by name. The set-up (pod addresses, arms, labels) and the saved looks
// live in the app's database through a tiny key/value store.
import { EventEmitter } from 'node:events';
import { BlePodLink, scanPods } from './ble.js';
import { Pod } from './pod.js';
import { MODELS, PodError, checkLabel, checkLookName, checkPct, levelToPct, normalizeAddress, pctToLevel } from './protocol.js';
import { RAVE_BAR, RAVE_BPM_DEFAULT, clampBpm, makeRng, ravePattern, raveLevels } from './rave.js';
import { SimPod } from './sim.js';

export const DEFAULT_SETTINGS = {
  confirmTimeoutMs: 2000, // a pod must report a change within this, or the change fails
  connectTimeoutMs: 10000, // find and connect one pod
  keepaliveMs: 1500, // the server polls each pod this often (the phone app does the same)
  settleMs: 200, // wait after a lights change before a shot
  autoConnect: false, // connect the pods when the server starts
};

const NAME_RE = /^[A-Za-z0-9][\w-]{0,39}$/;

// What is plugged into a port. A pod only reports that an arm is present, not which, so the
// kind is set by hand and drawn as an icon. (The Adaptalux app offers white, red, green, blue,
// yellow and flash; Super Bright, Warm White, Cold White and UV are missing there.)
export const ARM_KINDS = {
  white: { name: 'White LED', group: 'led' },
  super: { name: 'Super Bright LED', group: 'led' },
  warm: { name: 'Warm White LED', group: 'led' },
  cold: { name: 'Cold White LED', group: 'led' },
  uv: { name: 'UV LED', group: 'led' },
  red: { name: 'Red LED', group: 'led' },
  green: { name: 'Green LED', group: 'led' },
  blue: { name: 'Blue LED', group: 'led' },
  yellow: { name: 'Yellow LED', group: 'led' },
  flash: { name: 'Xenon flash arm', group: 'flash' },
};

export function checkKind(kind) {
  const key = String(kind ?? '').trim().toLowerCase();
  if (!key) return null;
  if (!ARM_KINDS[key]) throw new PodError('bad_request', `arm kind ${JSON.stringify(kind)}: one of ${Object.keys(ARM_KINDS).join(', ')}`);
  return key;
}

const quiet = { warn: () => {}, debug: () => {}, info: () => {} };

export function defaultLinkFactory({ simOptions = {}, log = console } = {}) {
  return (cfg, sim, settings) =>
    sim
      ? new SimPod(cfg, simOptions[cfg.name])
      : new BlePodLink(cfg, { connectTimeoutMs: settings.connectTimeoutMs, keepaliveMs: settings.keepaliveMs, log });
}

// Checks a set-up and fills in what is left out. Arms left out: one per pod port, named after
// the pod ("big_1".."big_5" for a Control Pod 3.0, "mini_a" for a Pod Mini's one port).
export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pods = {};
  for (const [name, p] of Object.entries(src.pods || {})) {
    if (!NAME_RE.test(name)) throw new PodError('bad_request', `pod name ${JSON.stringify(name)}: 1 to 40 letters, digits, _ or -`);
    const model = p?.model || 'pod_mini';
    if (!MODELS[model]) throw new PodError('bad_request', `pod ${name}: model must be one of ${Object.keys(MODELS).join(', ')}`);
    pods[name] = {
      name,
      address: normalizeAddress(p?.address),
      model,
      boost: p?.boost == null ? null : Boolean(p.boost),
      label: checkLabel(p?.label || ''),
    };
  }
  const addresses = new Set();
  for (const p of Object.values(pods)) {
    if (addresses.has(p.address)) throw new PodError('bad_request', `two pods have the address ${p.address}`);
    addresses.add(p.address);
  }
  const arms = {};
  const given = src.arms && typeof src.arms === 'object' ? Object.entries(src.arms) : [];
  if (given.length) {
    const taken = new Set();
    for (const [name, a] of given) {
      if (!NAME_RE.test(name)) throw new PodError('bad_request', `arm name ${JSON.stringify(name)}: 1 to 40 letters, digits, _ or -`);
      const pod = pods[a?.pod];
      if (!pod) throw new PodError('bad_request', `arm ${name}: pod ${JSON.stringify(a?.pod)} is not set up`);
      const port = a?.port == null && pod.model === 'pod_mini' ? 2 : Number(a?.port);
      if (!MODELS[pod.model].ports.includes(port)) throw new PodError('bad_request', `arm ${name}: ${MODELS[pod.model].name} ${pod.name} has no port ${a?.port} (ports ${MODELS[pod.model].ports.join(', ')})`);
      const key = `${pod.name}:${port}`;
      if (taken.has(key)) throw new PodError('bad_request', `arm ${name}: port ${port} of pod ${pod.name} is already an arm`);
      taken.add(key);
      arms[name] = { name, pod: pod.name, port, label: checkLabel(a?.label || ''), kind: checkKind(a?.kind) };
    }
  } else {
    for (const pod of Object.values(pods)) {
      const ports = MODELS[pod.model].ports;
      for (const port of ports) {
        const name = ports.length === 1 ? pod.name : `${pod.name}_${port}`;
        arms[name] = { name, pod: pod.name, port, label: '', kind: null };
      }
    }
  }
  const settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(src.settings || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k === 'autoConnect') settings[k] = Boolean(v);
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 120000) throw new PodError('bad_request', `settings.${k} must be 0..120000 ms`);
      settings[k] = n;
    }
  }
  return { pods, arms, settings };
}

export class Pods extends EventEmitter {
  constructor({ store, linkFactory = defaultLinkFactory(), scan = scanPods, log = console } = {}) {
    super();
    this.store = store || memoryStore();
    this.linkFactory = linkFactory;
    this.scanFn = scan;
    this.log = log;
    this.pods = {}; // name -> Pod (while connected or connecting)
    this.sim = false;
    this.connecting = false;
    this.connectError = null;
    this.rave = null;
    this.queue = Promise.resolve(); // one change in flight at a time
    this.lastEvent = '';
    this.config = normalizeConfig(this.store.get('config'));
    this.looks = loadLooks(this.store.get('looks'), log);
  }

  // ---------------------------------------------------------------- set-up

  get configured() {
    return Object.keys(this.config.pods).length > 0;
  }

  get settings() {
    return this.config.settings;
  }

  arm(name) {
    const key = String(name ?? '').trim();
    const arm = this.config.arms[key] || Object.values(this.config.arms).find((a) => a.name.toLowerCase() === key.toLowerCase());
    if (!arm) {
      const known = Object.keys(this.config.arms).join(', ') || 'none';
      throw new PodError('bad_request', `no arm ${JSON.stringify(name)} (arms: ${known})`);
    }
    return arm;
  }

  // Replace the set-up: {pods, arms, settings}. Sections left out keep what they have; pods
  // given with no arms get one arm per port. Connected pods are disconnected first.
  async setConfig(patch = {}) {
    const next = normalizeConfig({
      pods: patch.pods ?? this.config.pods,
      arms: patch.arms ?? (patch.pods ? {} : this.config.arms),
      settings: { ...this.config.settings, ...(patch.settings || {}) },
    });
    if (this.connected) await this.disconnect();
    this.config = next;
    this.store.set('config', { pods: next.pods, arms: next.arms, settings: next.settings });
    this.changed();
    return this.snapshot();
  }

  // ---------------------------------------------------------------- connection

  get connected() {
    return Object.values(this.pods).some((p) => p.connected);
  }

  // Connect every pod. Resolves with the problems of pods that did not connect; rejects when
  // none did, or while another connect is running.
  async connect({ sim = false } = {}) {
    if (!this.configured) throw new PodError('bad_request', 'no pods are set up yet: scan for them and add them first');
    if (this.connecting) throw new PodError('busy', 'the pods are already connecting: wait for that to finish');
    this.connecting = true;
    this.changed();
    try {
      await this.stopRave({ restore: false });
      const old = this.pods;
      this.pods = {};
      this.sim = Boolean(sim);
      await Promise.all(Object.values(old).map((p) => p.close().catch(() => {})));
      const problems = [];
      const pods = {};
      for (const cfg of Object.values(this.config.pods)) {
        const ports = Object.values(this.config.arms)
          .filter((a) => a.pod === cfg.name)
          .map((a) => a.port);
        const pod = new Pod(cfg, this.linkFactory(cfg, this.sim, this.settings), {
          confirmTimeoutMs: this.settings.confirmTimeoutMs,
          checkPorts: ports,
          onChange: () => this.changed(),
          log: this.log,
        });
        pods[cfg.name] = pod;
        this.pods = { ...pods }; // visible while the rest connect
        try {
          const st = await pod.open();
          this.log.info?.(`pod ${cfg.name} (${MODELS[cfg.model].name} ${cfg.address}) connected: battery ${st.batteryPct}%, firmware ${st.firmware}${this.sim ? ', sim' : ''}`);
        } catch (err) {
          pod.error = err.message;
          problems.push(`${cfg.name}: ${err.message}`);
          this.log.warn(`pod ${cfg.name}: ${err.message}`);
        }
      }
      this.pods = pods;
      this.connectError = problems.join('; ') || null;
      if (problems.length && problems.length === Object.keys(pods).length) throw new PodError('not_connected', `no pod connected: ${problems.join('; ')}`);
      return problems;
    } finally {
      this.connecting = false;
      this.changed();
    }
  }

  async disconnect() {
    await this.stopRave({ restore: false });
    const pods = this.pods;
    this.pods = {};
    this.connectError = null;
    for (const pod of Object.values(pods)) {
      try {
        await pod.close();
      } catch (err) {
        this.log.warn(`pod ${pod.name}: disconnect: ${err.message}`);
      }
    }
    this.changed();
  }

  async scan(ms = 6000) {
    if (this.sim && this.connected) {
      return Object.values(this.config.pods).map((p) => ({ address: p.address, name: MODELS[p.model].bleName, model: p.model, rssi: -50 }));
    }
    return this.scanFn(ms, { log: this.log });
  }

  // PodError unless the pod of every one of these arms is connected.
  require(arms) {
    const missing = [];
    for (const name of arms) {
      const arm = this.config.arms[name];
      if (!arm) continue;
      const pod = this.pods[arm.pod];
      if (!pod || !pod.connected) missing.push(`${name} (pod ${arm.pod}: ${pod?.error || 'not connected'})`);
    }
    if (missing.length) throw new PodError('not_connected', `lights not connected: ${[...new Set(missing)].join(', ')}`);
  }

  liveArms() {
    return Object.values(this.config.arms)
      .filter((a) => this.pods[a.pod]?.connected)
      .map((a) => a.name);
  }

  // ---------------------------------------------------------------- levels

  // Commanded level of every arm, percent.
  levels() {
    const out = {};
    for (const a of Object.values(this.config.arms)) {
      const pod = this.pods[a.pod];
      out[a.name] = pod ? levelToPct(pod.levels[a.port] ?? 0) : 0;
    }
    return out;
  }

  // Set arms to these percentages. full: every other arm goes off (a look). One set command per
  // pod; with confirm, each pod's status must show the change. A rave stops first.
  async setLevels(levels, { full = false, confirm = true } = {}) {
    await this.stopRave({ restore: false });
    return this.apply(levels, { full, confirm });
  }

  apply(levels, { full = false, confirm = true } = {}) {
    const wanted = {};
    for (const [name, pct] of Object.entries(levels || {})) wanted[this.arm(name).name] = checkPct(pct, `arm ${name}`);
    if (full) for (const name of Object.keys(this.config.arms)) wanted[name] ??= 0;
    const run = async () => {
      const byPod = {};
      for (const [name, pct] of Object.entries(wanted)) {
        const arm = this.config.arms[name];
        (byPod[arm.pod] ??= {})[arm.port] = pctToLevel(pct);
      }
      const missing = Object.keys(byPod).filter((n) => !this.pods[n]?.connected);
      if (missing.length) {
        // an arm that should light needs its pod; one that should be off on a pod that is not
        // here is left out (a look still works with that pod switched off)
        const lit = Object.entries(wanted)
          .filter(([a, pct]) => missing.includes(this.config.arms[a].pod) && pctToLevel(pct) > 0)
          .map(([a]) => a);
        this.require(lit);
        for (const a of Object.keys(wanted)) if (missing.includes(this.config.arms[a].pod)) delete wanted[a];
      }
      const sent = [];
      for (const [name, ports] of Object.entries(byPod)) {
        if (missing.includes(name)) continue;
        // always ask for the status (one byte): without confirm nothing waits for it, but the
        // pod's report stays current
        sent.push([this.pods[name], await this.pods[name].send(ports, { wantStatus: true })]);
      }
      if (confirm) for (const [pod, seq0] of sent) await pod.confirm(seq0);
      this.changed();
      return Object.fromEntries(Object.entries(wanted).map(([k, v]) => [k, levelToPct(pctToLevel(v))]));
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  // Every connected arm to pct (All on = 100, All off = 0).
  all(pct = 100, { confirm = true } = {}) {
    const arms = this.liveArms();
    if (!arms.length) throw new PodError('not_connected', 'no light arm is connected: connect the pods first');
    return this.setLevels(Object.fromEntries(arms.map((a) => [a, pct])), { confirm });
  }

  applyLook(name, { confirm = true } = {}) {
    return this.setLevels(this.look(name), { full: true, confirm });
  }

  // ---------------------------------------------------------------- rave

  get raveBpm() {
    return this.rave ? this.rave.bpm : null;
  }

  // Random light show on the connected arms, one change per beat, until stopRave() or any other
  // change. Running already: only the tempo changes. Resolves with the BPM used.
  async startRave(bpm = RAVE_BPM_DEFAULT, { seed } = {}) {
    let n;
    try {
      n = clampBpm(bpm);
    } catch (err) {
      throw new PodError('bad_request', err.message);
    }
    if (this.rave) {
      this.rave.bpm = n;
      this.changed();
      return n;
    }
    if (!this.liveArms().length) throw new PodError('not_connected', 'no light arm is connected: connect the pods first');
    const rave = { bpm: n, before: this.levels(), rng: makeRng(seed), beat: 0, pattern: 'scatter', timer: null, stopped: false };
    this.rave = rave;
    this.log.info?.(`rave on at ${n} BPM`);
    this.changed();
    this.raveBeat(rave);
    return n;
  }

  raveBeat(rave) {
    if (rave.stopped || this.rave !== rave) return;
    const arms = this.liveArms();
    if (!arms.length) {
      this.raveFailed(rave, 'every pod disconnected');
      return;
    }
    if (rave.beat % RAVE_BAR === 0) rave.pattern = ravePattern(rave.rng);
    const started = Date.now();
    this.apply(raveLevels(rave.pattern, rave.beat, arms, rave.rng), { confirm: false })
      .then(() => {
        if (rave.stopped || this.rave !== rave) return;
        rave.beat++;
        const wait = Math.max(0, 60000 / rave.bpm - (Date.now() - started));
        rave.timer = setTimeout(() => this.raveBeat(rave), wait);
        rave.timer.unref?.();
      })
      .catch((err) => this.raveFailed(rave, err.message));
  }

  raveFailed(rave, why) {
    if (rave.stopped) return;
    this.log.warn(`rave stopped: ${why}`);
    rave.stopped = true;
    if (this.rave === rave) this.rave = null;
    this.changed();
  }

  // End the rave. restore: put back the levels from before it started. Resolves false if none ran.
  async stopRave({ restore = true } = {}) {
    const rave = this.rave;
    if (!rave) return false;
    this.rave = null;
    rave.stopped = true;
    if (rave.timer) clearTimeout(rave.timer);
    await this.queue; // the beat in flight
    this.log.info?.('rave off');
    if (restore && this.connected) {
      const live = new Set(this.liveArms());
      try {
        await this.apply(Object.fromEntries(Object.entries(rave.before).filter(([a]) => live.has(a))), { confirm: false });
      } catch (err) {
        this.log.warn(`rave off: could not put the lights back: ${err.message}`);
      }
    }
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------- labels and looks

  label(name) {
    const arm = this.arm(name);
    return arm.label || arm.name;
  }

  saveConfig() {
    this.store.set('config', { pods: this.config.pods, arms: this.config.arms, settings: this.config.settings });
  }

  // An arm's label (blank goes back to its name) and kind (what is plugged in; blank clears it).
  // Neither touches the connection.
  setArm(name, { label, kind } = {}) {
    const arm = this.arm(name);
    if (label !== undefined) arm.label = checkLabel(label);
    if (kind !== undefined) arm.kind = checkKind(kind);
    this.saveConfig();
    this.changed();
    return { name: arm.name, label: arm.label || arm.name, kind: arm.kind ?? null };
  }

  setLabel(name, text) {
    return this.setArm(name, { label: text }).label;
  }

  pod(name) {
    const key = String(name ?? '').trim();
    const pod = this.config.pods[key] || Object.values(this.config.pods).find((p) => p.name.toLowerCase() === key.toLowerCase());
    if (!pod) throw new PodError('bad_request', `no pod ${JSON.stringify(name)} (pods: ${Object.keys(this.config.pods).join(', ') || 'none'})`);
    return pod;
  }

  // Rename a pod in the UI. Blank goes back to its name.
  setPodLabel(name, text) {
    const pod = this.pod(name);
    pod.label = checkLabel(text);
    this.saveConfig();
    this.changed();
    return pod.label || pod.name;
  }

  look(name) {
    const key = String(name ?? '').trim();
    const hit = this.looks[key] ?? Object.entries(this.looks).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
    if (!hit) throw new PodError('bad_request', `look "${key}" is not saved (looks: ${Object.keys(this.looks).join(', ') || 'none'})`);
    return { ...hit };
  }

  // Save a look: these levels, or every arm's current level. Arms left out are off.
  saveLook(name, levels = null) {
    const key = checkLookName(name);
    const clean = {};
    for (const [arm, pct] of Object.entries(levels ?? this.levels())) clean[this.arm(arm).name] = checkPct(pct, `look ${key} arm ${arm}`);
    for (const k of Object.keys(this.looks)) if (k.toLowerCase() === key.toLowerCase() && k !== key) delete this.looks[k];
    this.looks[key] = clean;
    this.store.set('looks', this.looks);
    this.changed();
    return { ...clean };
  }

  deleteLook(name) {
    const key = String(name ?? '').trim();
    const hit = Object.keys(this.looks).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!hit) throw new PodError('bad_request', `look "${key}" is not saved`);
    delete this.looks[hit];
    this.store.set('looks', this.looks);
    this.changed();
    return hit;
  }

  // ---------------------------------------------------------------- state and events

  snapshot() {
    const levels = this.levels();
    const arms = Object.values(this.config.arms).map((a) => {
      const pod = this.pods[a.pod];
      const st = pod?.status || null;
      return {
        name: a.name,
        label: a.label || a.name,
        kind: a.kind ?? null,
        pod: a.pod,
        port: a.port,
        pct: levels[a.name] ?? 0,
        connected: Boolean(pod?.connected),
        present: st ? st.arms.includes(a.port) : null,
        reportedPct: st ? levelToPct(st.levels[a.port]) : null,
      };
    });
    const pods = Object.values(this.config.pods).map((cfg) =>
      this.pods[cfg.name]
        ? this.pods[cfg.name].snapshot()
        : { name: cfg.name, label: cfg.label || cfg.name, model: cfg.model, modelName: MODELS[cfg.model].name, address: cfg.address, connected: false, error: null },
    );
    return {
      configured: this.configured,
      connected: pods.some((p) => p.connected),
      connecting: this.connecting,
      sim: this.sim,
      connectError: this.connectError,
      settings: { ...this.settings },
      pods,
      arms,
      looks: Object.fromEntries(Object.entries(this.looks).map(([k, v]) => [k, { ...v }])),
      rave: this.rave ? { bpm: this.rave.bpm } : null,
    };
  }

  subscribe(fn) {
    this.on('change', fn);
    return () => this.off('change', fn);
  }

  // Emits the snapshot when anything visible changed.
  changed() {
    if (!this.listenerCount('change')) return;
    const snap = this.snapshot();
    const sig = JSON.stringify(snap);
    if (sig === this.lastEvent) return;
    this.lastEvent = sig;
    this.emit('change', snap);
  }

  async close() {
    await this.disconnect();
  }
}

export function createPods(options) {
  return new Pods(options);
}

export function memoryStore() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) };
}

function loadLooks(raw, log) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, levels] of Object.entries(raw)) {
    if (!levels || typeof levels !== 'object') continue;
    try {
      const key = checkLookName(name);
      out[key] = Object.fromEntries(Object.entries(levels).map(([a, p]) => [String(a), checkPct(p, `look ${key}`)]));
    } catch (err) {
      log.warn(`skipping saved look ${JSON.stringify(name)}: ${err.message}`);
    }
  }
  return out;
}

export { quiet as quietLog };
