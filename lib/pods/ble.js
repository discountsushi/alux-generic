// Real pods over Bluetooth LE, through the Bluetooth host (ble-host.js): a child process that
// owns @stoprocent/noble, forked on first use and started again after a crash. Native crashes
// in the module's Windows code have taken a whole server down; here they cost the pods a
// reconnect. The links below are proxies that talk to the host over IPC.
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodError } from './protocol.js';

const HOST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ble-host.js');
const CALL_TIMEOUT_MS = 60000;

class BleHost {
  constructor(log = console) {
    this.log = log;
    this.child = null;
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.links = new Map(); // link id -> { onData, onLost }
    this.restarts = 0;
  }

  start() {
    if (this.child) return this.child;
    const child = fork(HOST_FILE, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'json' });
    this.child = child;
    child.on('message', (msg) => this.onMessage(msg));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const why = signal ? `signal ${signal}` : `exit code ${code}${code === 3221225477 ? ' (access violation in the Bluetooth module)' : ''}`;
      if (this.pending.size || this.links.size) this.log.warn(`bluetooth host stopped (${why}); it starts again on the next use`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new PodError('unavailable', `Bluetooth stopped (${why}); try again`));
      }
      this.pending.clear();
      for (const [, l] of this.links) l.onLost(`the Bluetooth host stopped (${why})`);
      this.links.clear();
      this.restarts++;
    });
    child.on('error', (err) => this.log.warn(`bluetooth host: ${err.message}`));
    return child;
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.event === 'data') {
      this.links.get(msg.link)?.onData(Buffer.from(msg.data));
    } else if (msg.event === 'lost') {
      const l = this.links.get(msg.link);
      this.links.delete(msg.link);
      l?.onLost(msg.reason);
    } else if (msg.event === 'log') {
      this.log[msg.level]?.(msg.message);
    } else if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new PodError(msg.code || 'unavailable', msg.message));
    }
  }

  call(op, fields = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const child = this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PodError('timeout', `Bluetooth ${op}: no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, op, ...fields });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new PodError('unavailable', `Bluetooth host: ${err.message}`));
      }
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    for (const [, l] of this.links) l.onLost('Bluetooth stopped');
    this.links.clear();
    child.disconnect?.();
    await new Promise((r) => {
      const t = setTimeout(() => {
        child.kill();
        r();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

let host = null;
export function bleHost(log = console) {
  if (!host) host = new BleHost(log);
  return host;
}

let linkSeq = 0;

export class BlePodLink {
  constructor(cfg, { connectTimeoutMs = 10000, keepaliveMs = 1500, log = console } = {}) {
    this.cfg = cfg;
    this.address = cfg.address;
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepaliveMs = keepaliveMs;
    this.log = log;
    this.bleName = null;
    this.id = `${cfg.name}#${++linkSeq}`;
    this.open_ = false;
  }

  get connected() {
    return this.open_;
  }

  async open(onData, onLost) {
    const h = bleHost(this.log);
    h.links.set(this.id, {
      onData,
      onLost: (reason) => {
        this.open_ = false;
        onLost(reason);
      },
    });
    try {
      const r = await h.call('open', { link: this.id, address: this.address, connectTimeoutMs: this.connectTimeoutMs, keepaliveMs: this.keepaliveMs }, this.connectTimeoutMs * 3 + 10000);
      this.bleName = r?.bleName || null;
      this.open_ = true;
    } catch (err) {
      h.links.delete(this.id);
      throw err;
    }
  }

  async write(data) {
    if (!this.open_) throw new PodError('not_connected', `pod ${this.address} is not connected`);
    await bleHost(this.log).call('write', { link: this.id, data: [...Buffer.from(data)] }, 10000);
  }

  async close() {
    const h = bleHost(this.log);
    h.links.delete(this.id);
    const wasOpen = this.open_;
    this.open_ = false;
    if (!wasOpen || !h.child) return;
    try {
      await h.call('close', { link: this.id }, 15000);
    } catch (err) {
      this.log.debug?.(`pod ${this.address} disconnect: ${err.message}`);
    }
  }
}

// Adaptalux pods advertising nearby (in Bluetooth mode and not connected to anything).
export function scanPods(ms = 6000, { log = console } = {}) {
  return bleHost(log).call('scan', { ms }, ms + 15000);
}

// Stops the Bluetooth host (server shutdown).
export function stopBle() {
  return host ? host.stop() : Promise.resolve();
}
