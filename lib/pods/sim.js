// Pod firmware emulator: answers '#', applies set frames, records every write. Same link
// interface as ble.js (open / write / close / connected), so everything above the radio runs
// against it: the tests, and "Connect sim" in the app.
import { ARM_BIT, LAMP_INDEX, MODELS, PodError, SET_CMD, STATUS_REQUEST } from './protocol.js';

const defaults = {
  arms: null, // ports with an arm plugged in (null: every port of the model)
  batteryRaw: 190,
  usb: false,
  firmware: 7,
  boost: false,
  failOpen: null, // open() rejects with this text
  silent: false, // never answer (timeout tests)
  answerSets: true, // false: '#' alone is answered, a set's trailing '#' is not
  staleReplies: 0, // this many answers to a set report the old levels first
  openDelayMs: 0,
};

export class SimPod {
  constructor(cfg, options = {}) {
    this.cfg = cfg;
    this.options = { ...defaults, ...options };
    this.address = cfg.address;
    this.bleName = MODELS[cfg.model].bleName;
    this.arms = new Set(this.options.arms ?? MODELS[cfg.model].ports);
    this.lamps = [0xff, 0xff, 0xff, 0xff, 0xff]; // as the firmware keeps them: inverted, lamp-index order
    this.boost = this.options.boost;
    this.writes = [];
    this.onData = null;
    this.onLost = null;
    this.open_ = false;
    this.stale = 0;
  }

  async open(onData, onLost) {
    if (this.options.openDelayMs) await new Promise((r) => setTimeout(r, this.options.openDelayMs));
    if (this.options.failOpen) throw new PodError('not_connected', this.options.failOpen);
    this.onData = onData;
    this.onLost = onLost;
    this.open_ = true;
  }

  async close() {
    this.open_ = false;
  }

  get connected() {
    return this.open_;
  }

  level(port) {
    return 255 - this.lamps[LAMP_INDEX[port]];
  }

  // The pod goes away (switched off, out of range).
  drop(reason = 'simulated link loss') {
    this.open_ = false;
    if (this.onLost) this.onLost(reason);
  }

  statusFrame(lamps = this.lamps) {
    let bits = 0;
    for (const port of this.arms) bits |= ARM_BIT[port];
    const o = this.options;
    return Buffer.from([...lamps, o.usb ? 1 : 0, o.batteryRaw, 0, bits, this.boost ? 1 : 0, o.firmware]);
  }

  async write(data) {
    if (!this.open_) throw new PodError('not_connected', `pod ${this.address} is not connected`);
    const buf = Buffer.from(data);
    this.writes.push(buf);
    let reply = false;
    const old = [...this.lamps];
    if (buf.equals(STATUS_REQUEST)) {
      reply = true;
    } else if ((buf.length === 7 || buf.length === 8) && buf[0] === SET_CMD) {
      this.lamps = [...buf.subarray(1, 6)];
      this.boost = Boolean(buf[6]);
      reply = buf.length === 8 && buf[7] === STATUS_REQUEST[0] && this.options.answerSets;
      if (reply && this.stale < this.options.staleReplies) {
        this.stale++;
        this.send(this.statusFrame(old));
      }
    }
    // anything else: the firmware ignores it, like the real pod presumably does
    if (reply) this.send(this.statusFrame());
  }

  send(frame) {
    if (this.options.silent || !this.onData) return;
    // Like a notification: it arrives after the write returns, never inside it.
    queueMicrotask(() => this.onData && this.onData(frame));
  }
}
