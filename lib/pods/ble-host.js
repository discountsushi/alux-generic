// The Bluetooth host: a child process that owns @stoprocent/noble and the real pod links, so a
// crash in the module's native code (seen on Windows: exit 0xC0000005 while pods came and went)
// costs a reconnect, not the server. ble.js forks it on first use and talks to it over IPC:
//
//   parent -> child  { id, op: 'scan',  ms }
//                    { id, op: 'open',  link, address, connectTimeoutMs, keepaliveMs }
//                    { id, op: 'write', link, data: [bytes] }
//                    { id, op: 'close', link }
//   child -> parent  { id, ok: true, result } | { id, ok: false, code, message }
//                    { event: 'data', link, data: [bytes] } | { event: 'lost', link, reason }
//                    { event: 'log', level, message }
import { BLE_NAMES, CMD_CHAR, NOTIFY_CHAR, PodError, SERVICE_UUID, STATUS_REQUEST } from './protocol.js';

const log = {
  warn: (message) => send({ event: 'log', level: 'warn', message }),
  info: (message) => send({ event: 'log', level: 'info', message }),
  debug: (message) => send({ event: 'log', level: 'debug', message }),
};

function send(msg) {
  if (process.connected) process.send(msg);
}

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
async function scanPods(ms = 6000) {
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
  log.debug(`pods scan: ${seen.size} found`);
  return [...seen.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}

// One real pod over Bluetooth LE.
class RealLink {
  constructor(id, address, { connectTimeoutMs = 10000, keepaliveMs = 1500 } = {}) {
    this.id = id;
    this.address = address;
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepaliveMs = keepaliveMs;
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

  // Windows answers "Device is unreachable while discovering services" for a pod that was
  // disconnected a moment ago (by us, or by the phone app): a short wait and a second try is
  // all it needs, so a connect gets three goes within its timeout.
  async open() {
    const noble = await loadNoble();
    await poweredOn(noble, this.connectTimeoutMs);
    this.closing = false;
    const deadline = Date.now() + this.connectTimeoutMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.openOnce(noble);
      } catch (err) {
        const again = attempt < 3 && Date.now() + 2000 < deadline && /unreachable|disconnected|timed out|GATT|0x8065/i.test(err.message);
        if (!again) throw err;
        log.debug(`pod ${this.address}: attempt ${attempt}: ${err.message}; trying again`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  async openOnce(noble) {
    let peripheral;
    try {
      peripheral = await withTimeout(this.find(noble), this.connectTimeoutMs, `find pod ${this.address}`);
      // a direct connect by address hands back a peripheral that is connected already
      if (peripheral.state !== 'connected') await withTimeout(peripheral.connectAsync(), this.connectTimeoutMs, `connect pod ${this.address}`);
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
      notify.on('data', (data) => send({ event: 'data', link: this.id, data: [...Buffer.from(data)] }));
      await notify.subscribeAsync();
      peripheral.once('disconnect', (reason) => {
        this.stopKeepalive();
        this.peripheral = null;
        this.cmd = null;
        if (!this.closing) send({ event: 'lost', link: this.id, reason: `the Bluetooth link dropped${reason ? ` (${reason})` : ''}` });
      });
      this.peripheral = peripheral;
      this.cmd = cmd;
      this.bleName = peripheral.advertisement?.localName || null;
      this.lastWrite = Date.now();
      this.startKeepalive();
      return { bleName: this.bleName };
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
        log.debug(`pod ${this.address}: direct connect: ${err.message}; scanning`);
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
      this.write(STATUS_REQUEST).catch((err) => log.debug(`pod ${this.address} keepalive: ${err.message}`));
    }, Math.max(100, Math.floor(this.keepaliveMs / 2)));
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
      log.debug(`pod ${this.address} disconnect: ${err.message}`);
    }
  }
}

const links = new Map();

async function handle(msg) {
  switch (msg.op) {
    case 'scan':
      return scanPods(msg.ms);
    case 'open': {
      const old = links.get(msg.link);
      if (old) await old.close().catch(() => {});
      const link = new RealLink(msg.link, msg.address, { connectTimeoutMs: msg.connectTimeoutMs, keepaliveMs: msg.keepaliveMs });
      links.set(msg.link, link);
      try {
        return await link.open();
      } catch (err) {
        links.delete(msg.link);
        throw err;
      }
    }
    case 'write': {
      const link = links.get(msg.link);
      if (!link) throw new PodError('not_connected', `pod ${msg.link} is not connected`);
      await link.write(Buffer.from(msg.data));
      return null;
    }
    case 'close': {
      const link = links.get(msg.link);
      links.delete(msg.link);
      if (link) await link.close();
      return null;
    }
    case 'ping':
      return 'pong';
    default:
      throw new PodError('bad_request', `unknown op ${msg.op}`);
  }
}

process.on('message', (msg) => {
  if (!msg || msg.id == null) return;
  handle(msg).then(
    (result) => send({ id: msg.id, ok: true, result }),
    (err) => send({ id: msg.id, ok: false, code: err.code || 'unavailable', message: err.message }),
  );
});

// The parent went away: give the pods back to their buttons and the phone app.
process.on('disconnect', async () => {
  for (const link of links.values()) await link.close().catch(() => {});
  process.exit(0);
});

process.on('unhandledRejection', (err) => log.warn(`bluetooth host: ${err?.message || err}`));
process.on('uncaughtException', (err) => {
  log.warn(`bluetooth host: ${err?.message || err}`);
  process.exit(2);
});
