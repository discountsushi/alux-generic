// One pod: its link, the levels last commanded, the last status it reported.
//
// Every set command carries every lamp, so `levels` ({port: 0..255}) is the whole state the pod
// is asked to hold. Changes are confirmed by the status frame the set asks for.
import { BLE_NAMES, CONFIRM_TOLERANCE, MODELS, PodError, STATUS_REQUEST, StatusDecoder, buildSetFrame, commandedLevel, driveLevel, levelToPct } from './protocol.js';

export class Pod {
  constructor(cfg, link, { confirmTimeoutMs = 2000, statusGapMs = 120, checkPorts = [], onChange = null, log = console } = {}) {
    this.cfg = cfg;
    this.link = link;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.statusGapMs = statusGapMs;
    this.checkPorts = checkPorts.length ? [...new Set(checkPorts)].sort() : [...MODELS[cfg.model].ports];
    this.onChange = onChange;
    this.log = log;
    this.levels = Object.fromEntries(MODELS[cfg.model].ports.map((p) => [p, 0]));
    this.boost = Boolean(cfg.boost);
    this.status = null;
    this.error = null;
    this.decoder = new StatusDecoder();
    this.seq = 0;
    this.waiters = new Set();
  }

  get name() {
    return this.cfg.name;
  }

  get connected() {
    return this.link.connected;
  }

  // ---------------------------------------------------------------- link callbacks

  onData = (data) => {
    let frames;
    try {
      frames = this.decoder.feed(data);
    } catch (err) {
      this.log.warn(`pod ${this.name}: ${err.message}`);
      return;
    }
    if (!frames.length) return;
    this.status = frames[frames.length - 1];
    this.seq += frames.length;
    for (const w of this.waiters) if (w.ok(this.status)) w.resolve(this.status);
    this.changed();
  };

  onLost = (reason) => {
    this.error = `link lost: ${reason}`;
    this.log.warn(`pod ${this.name}: ${this.error}`);
    for (const w of this.waiters) w.reject(new PodError('not_connected', `pod ${this.name}: ${w.what}: the link is down (${this.error})`));
    this.changed();
  };

  changed() {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch (err) {
      this.log.debug?.(`pods change hook: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- operations

  // Connect and read the pod. The commanded levels start from what it reports, so connecting
  // never changes the light.
  async open() {
    this.error = null;
    await this.link.open(this.onData, this.onLost);
    try {
      const st = await this.requestStatus();
      const model = BLE_NAMES[(this.link.bleName || '').toLowerCase()];
      if (model && model !== this.cfg.model) {
        this.log.warn(`pod ${this.name} advertises as "${this.link.bleName}" (${MODELS[model].name}) but is set up as ${MODELS[this.cfg.model].name}`);
      }
      // the pod reports what it drives: with boost off that is a third of what was asked for
      for (const p of Object.keys(this.levels)) this.levels[p] = commandedLevel(st.levels[p], st.boost);
      if (this.cfg.boost == null) this.boost = st.boost;
      else if (st.boost !== Boolean(this.cfg.boost)) await this.confirm(await this.send({}, { boost: Boolean(this.cfg.boost), wantStatus: true }));
      return st;
    } catch (err) {
      await this.link.close().catch(() => {}); // a pod that failed to open must not keep its one connection
      throw err;
    }
  }

  async close() {
    try {
      await this.link.close();
    } finally {
      for (const w of this.waiters) w.reject(new PodError('not_connected', `pod ${this.name}: ${w.what}: disconnected`));
      this.changed();
    }
  }

  // Resolves with the first status after seq0 that `ok` accepts.
  wait(seq0, ok, timeoutMs, what) {
    if (this.status && this.seq > seq0 && ok(this.status)) return Promise.resolve(this.status);
    if (!this.link.connected) return Promise.reject(new PodError('not_connected', `pod ${this.name}: ${what}: the link is down (${this.error || 'disconnected'})`));
    return new Promise((resolve, reject) => {
      const w = { ok, what };
      const done = (fn) => (v) => {
        clearTimeout(timer);
        this.waiters.delete(w);
        fn(v);
      };
      w.resolve = done(resolve);
      w.reject = done(reject);
      const timer = setTimeout(() => w.reject(new PodError('timeout', this.timeoutText(what, timeoutMs, this.seq > seq0 ? this.status : null))), timeoutMs);
      this.waiters.add(w);
    });
  }

  timeoutText(what, timeoutMs, st) {
    let text = `pod ${this.name}: ${what}: no confirmation in ${timeoutMs / 1000} s`;
    if (st) {
      const got = this.checkPorts.map((p) => `port ${p} ${levelToPct(st.levels[p])}%`).join(', ');
      const want = this.checkPorts.map((p) => `port ${p} ${levelToPct(driveLevel(this.levels[p], this.boost))}%`).join(', ');
      text += ` (it drives ${got}; asked for ${want}${this.boost ? '' : ', boost off'})`;
    }
    return text;
  }

  async requestStatus(timeoutMs = this.confirmTimeoutMs) {
    const seq0 = this.seq;
    await this.link.write(STATUS_REQUEST);
    return this.wait(seq0, () => true, timeoutMs, 'status request');
  }

  // Change these ports (others keep their level) and send the whole state. Resolves with the
  // status sequence number to pass to confirm().
  async send(levels, { boost = null, wantStatus = true } = {}) {
    for (const [portKey, level] of Object.entries(levels)) {
      if (!(portKey in this.levels)) throw new PodError('bad_request', `pod ${this.name} (${MODELS[this.cfg.model].name}) has no port ${portKey}`);
      this.levels[portKey] = Math.min(255, Math.max(0, Math.round(Number(level)) || 0));
    }
    if (boost != null) this.boost = Boolean(boost);
    const frame = buildSetFrame(this.levels, this.boost, false);
    const seq0 = this.seq;
    await this.link.write(frame);
    // The status request goes in a write of its own, a moment later: a set frame with '#'
    // appended is ignored by the pod, and a Pod Mini dropped the link when the two writes
    // followed each other at once (the Adaptalux app only ever polls on its 1.5 s timer).
    if (wantStatus) {
      await new Promise((r) => setTimeout(r, this.statusGapMs));
      await this.link.write(STATUS_REQUEST);
    }
    return seq0;
  }

  // The pod's report must show every checked port at the level it should drive, and the boost
  // state asked for.
  matches(st) {
    return st.boost === this.boost && this.checkPorts.every((p) => Math.abs(st.levels[p] - driveLevel(this.levels[p], this.boost)) <= CONFIRM_TOLERANCE);
  }

  confirm(seq0, timeoutMs = this.confirmTimeoutMs) {
    return this.wait(seq0, (st) => this.matches(st), timeoutMs, 'set');
  }

  // Boost on: the arms get the level asked for; off: a third of it. Confirmed like any set.
  async setBoost(on) {
    return this.confirm(await this.send({}, { boost: Boolean(on), wantStatus: true }));
  }

  snapshot() {
    const st = this.status;
    return {
      name: this.name,
      label: this.cfg.label || this.name,
      model: this.cfg.model,
      modelName: MODELS[this.cfg.model].name,
      address: this.cfg.address,
      connected: this.connected,
      error: this.error,
      boost: this.boost,
      batteryPct: st ? st.batteryPct : null,
      usb: st ? st.usb : null,
      firmware: st ? st.firmware : null,
      armsPresent: st ? [...st.arms] : null,
      levels: { ...this.levels },
    };
  }
}
