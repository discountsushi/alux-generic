// A real pod over Bluetooth LE, through @stoprocent/noble (Windows WinRT, macOS CoreBluetooth,
// Linux HCI). Loaded only when a real connection or scan is asked for, so the app, the tests
// and "Connect sim" work without the module or an adapter.
import { BLE_NAMES, CMD_CHAR, NOTIFY_CHAR, PodError, SERVICE_UUID, STATUS_REQUEST } from './protocol.js';

let noblePromise = null;

async function loadNoble() {
  if (!noblePromise) {
    noblePromise = import('@stoprocent/noble')
      .then((m) => m.default || m)
      .catch((err) => {
        noblePromise = null;
        throw new PodError('unavailable', `Bluetooth needs the @stoprocent/noble package (${err.message}): run npm install in the app folder`);
      });
  }
  return noblePromise;
}

async function poweredOn(noble, timeoutMs) {
  if (noble.state === 'poweredOn') return;
  try {
    await noble.waitForPoweredOnAsync(timeoutMs);
  } catch (err) {
    throw new PodError('unavailable', `Bluetooth is not on (adapter state: ${noble.state}): ${err.message}`);
  }
}

// noble reports addresses lower-case with colons on Windows and Linux; on a Mac it only has a
// per-machine id, so there we match by id too.
const same = (a, b) => String(a || '').replace(/[^0-9a-f]/gi, '').toLowerCase() === String(b || '').replace(/[^0-9a-f]/gi, '').toLowerCase();

export class BlePodLink {
  constructor(cfg, { connectTimeoutMs = 10000, keepaliveMs = 1500, log = console } = {}) {
    this.cfg = cfg;
    this.address = cfg.address;
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepaliveMs = keepaliveMs;
    this.log = log;
    this.bleName = null;
    this.peripheral = null;
    this.cmd = null;
    this.timer = null;
    this.lastWrite = 0;
    this.closing = false;
  }

  get connected() {
    return Boolean(this.peripheral && this.peripheral.state === 'connected');
  }

  async open(onData, onLost) {
    const noble = await loadNoble();
    await poweredOn(noble, this.connectTimeoutMs);
    this.closing = false;
    let peripheral;
    try {
      peripheral = await withTimeout(this.find(noble), this.connectTimeoutMs, `find pod ${this.address}`);
      await withTimeout(peripheral.connectAsync(), this.connectTimeoutMs, `connect pod ${this.address}`);
    } catch (err) {
      if (err instanceof PodError) throw err;
      throw new PodError('not_connected', `pod ${this.address}: ${err.message}`);
    }
    try {
      const { characteristics } = await withTimeout(
        peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [CMD_CHAR, NOTIFY_CHAR]),
        this.connectTimeoutMs,
        `read services of pod ${this.address}`,
      );
      const cmd = characteristics.find((c) => same(c.uuid, CMD_CHAR));
      const notify = characteristics.find((c) => same(c.uuid, NOTIFY_CHAR));
      if (!cmd || !notify) throw new PodError('not_connected', `pod ${this.address} has no Adaptalux UART service: is it a Pod Mini 2.0 or Control Pod 3.0?`);
      notify.on('data', (data) => onData(Buffer.from(data)));
      await notify.subscribeAsync();
      peripheral.once('disconnect', (reason) => {
        this.stopKeepalive();
        if (!this.closing) onLost(`the Bluetooth link dropped${reason ? ` (${reason})` : ''}`);
      });
      this.peripheral = peripheral;
      this.cmd = cmd;
      this.bleName = peripheral.advertisement?.localName || null;
      this.lastWrite = Date.now();
      this.startKeepalive();
    } catch (err) {
      await peripheral.disconnectAsync().catch(() => {});
      if (err instanceof PodError) throw err;
      throw new PodError('not_connected', `pod ${this.address}: ${err.message}`);
    }
  }

  // The pod by address: a direct connect where the binding supports it, else a short scan.
  async find(noble) {
    if (typeof noble.connectAsync === 'function') {
      try {
        const p = await noble.connectAsync(this.address.toLowerCase());
        if (p) return p;
      } catch (err) {
        this.log.debug?.(`pod ${this.address}: direct connect: ${err.message}; scanning`);
      }
    }
    const found = await scanFor(noble, this.connectTimeoutMs, (p) => same(p.address, this.address) || same(p.id, this.address));
    if (!found) {
      throw new PodError(
        'not_connected',
        `pod ${this.address} not found: is it on, in Bluetooth mode (flashing blue), and not connected to the phone app? A pod takes one connection at a time.`,
      );
    }
    return found;
  }

  // The Adaptalux app sends '#' every 1.5 s while it controls a pod; the pod reports back.
  startKeepalive() {
    this.stopKeepalive();
    this.timer = setInterval(() => {
      if (Date.now() - this.lastWrite < this.keepaliveMs || !this.connected) return;
      this.write(STATUS_REQUEST).catch((err) => this.log.debug?.(`pod ${this.address} keepalive: ${err.message}`));
    }, Math.max(100, Math.floor(this.keepaliveMs / 2)));
    this.timer.unref?.();
  }

  stopKeepalive() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async write(data) {
    if (!this.connected || !this.cmd) throw new PodError('not_connected', `pod ${this.address} is not connected`);
    this.lastWrite = Date.now();
    try {
      await withTimeout(this.cmd.writeAsync(Buffer.from(data), true), 3000, `write to pod ${this.address}`);
    } catch (err) {
      if (err instanceof PodError) throw err;
      throw new PodError('not_connected', `pod ${this.address}: write failed: ${err.message}`);
    }
  }

  async close() {
    this.closing = true;
    this.stopKeepalive();
    const p = this.peripheral;
    this.peripheral = null;
    this.cmd = null;
    if (!p) return;
    try {
      await withTimeout(p.disconnectAsync(), 10000, `disconnect pod ${this.address}`);
    } catch (err) {
      this.log.debug?.(`pod ${this.address} disconnect: ${err.message}`);
    }
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PodError('timeout', `${what}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// Scans until `match` finds a peripheral or the time is up (null).
async function scanFor(noble, ms, match) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = async (value, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
      await noble.stopScanningAsync().catch(() => {});
      if (err) reject(err);
      else resolve(value);
    };
    const onDiscover = (p) => {
      if (match(p)) finish(p);
    };
    const timer = setTimeout(() => finish(null), ms);
    noble.on('discover', onDiscover);
    noble.startScanningAsync([], true).catch((err) => finish(null, new PodError('unavailable', `Bluetooth scan failed: ${err.message}`)));
  });
}

// Adaptalux pods advertising nearby (in Bluetooth mode and not connected to anything).
export async function scanPods(ms = 6000, { log = console } = {}) {
  const noble = await loadNoble();
  await poweredOn(noble, ms);
  const seen = new Map();
  await scanFor(noble, ms, (p) => {
    const name = p.advertisement?.localName || '';
    const model = BLE_NAMES[name.toLowerCase()];
    if (!model) return false;
    const address = (p.address && p.address !== 'unknown' ? p.address : p.id).toUpperCase();
    seen.set(address, { address, name, model, rssi: p.rssi ?? null });
    return false; // keep going until the time is up
  });
  log.debug?.(`pods scan: ${seen.size} found`);
  return [...seen.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}
