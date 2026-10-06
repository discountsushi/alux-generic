// Adaptalux pod protocol (Pod Mini 2.0, Control Pod 3.0), as the Adaptalux Android app speaks it:
// a Microchip Transparent UART service over Bluetooth LE, no pairing. Decoded from com.adaptalux
// 2.0.1 (PodManagerService, Profile and Pod). Pure functions and constants only; the radio is in
// ble.js and the firmware emulator in sim.js.
//
//   '#'                       status request: the pod answers with one 11-byte status frame
//   77 L0 L1 L2 L3 L4 BB      set every lamp. Ln = 255 - level (0xFF off, 0x00 full), BB = boost
//                             0/1. Exactly 7 bytes in a write of its own: the pod ignores the
//                             frame without the boost byte, and with a '#' appended (the app's
//                             code can build that, but never sends it).
//
// Lamp bytes are in lamp-index order: ports 2, 1, 3, 4, 5. Status frame: bytes 0-4 lamp levels
// (inverted, same order), 5 USB power, 6 battery raw (134..202 = 0..100%), 7 battery condition,
// 8 arm-present bits (port 1 0x02, 2 0x01, 3 0x04, 4 0x08, 5 0x10), 9 boost, 10 firmware.
//
// Seen on a Pod Mini 2.0 (firmware 119, 2026-10-05): the status reports the level the pod
// DRIVES, which is the level asked for with boost on and a third of it with boost off (255 -> 84,
// 127 -> 42). A set frame without the boost byte is ignored. So "100%" with boost off is a third
// of the arm's power, and a change is confirmed against the driven level.

// noble wants UUIDs lower-case without dashes.
export const SERVICE_UUID = '49535343fe7d4ae58fa99fafd205e455';
export const CMD_CHAR = '49535343884143f4a8d4ecbe34729bb3'; // write without response
export const NOTIFY_CHAR = '495353431e4d4bd9ba6123c647249616'; // notifications

export const BLE_NAMES = { podmini: 'pod_mini', adaptalux3: 'pod3' }; // advertised name -> model
export const MODELS = {
  pod_mini: { name: 'Pod Mini 2.0', ports: [2], bleName: 'podmini' },
  pod3: { name: 'Control Pod 3.0', ports: [1, 2, 3, 4, 5], bleName: 'Adaptalux3' },
};

export const SET_CMD = 0x77; // 'w'
export const STATUS_REQUEST = Buffer.from('#');
export const STATUS_LEN = 11;
export const LAMP_INDEX = { 1: 1, 2: 0, 3: 2, 4: 3, 5: 4 }; // port -> byte position in frames
export const ARM_BIT = { 1: 0x02, 2: 0x01, 3: 0x04, 4: 0x08, 5: 0x10 }; // port -> status byte 8 bit
export const PORTS = [1, 2, 3, 4, 5];
export const BATTERY_MIN = 134;
export const BATTERY_MAX = 202;
export const CONFIRM_TOLERANCE = 1; // levels: a status within this of the commanded level confirms it
export const LABEL_MAX = 40;
export const LOOK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
export const LOOK_NAME_RULE = '1 to 40 letters, digits, spaces, _ or -, starting with a letter or digit';

export class PodError extends Error {
  // code: not_connected | timeout | busy | bad_request | unavailable
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The app only offers whole percent; the pods take every level 0..255.
export const pctToLevel = (pct) => Math.round((clamp(Number(pct), 0, 100) * 255) / 100);
export const levelToPct = (level) => Math.round((clamp(Number(level), 0, 255) * 1000) / 255) / 10;

export function checkPct(value, what = 'level') {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new PodError('bad_request', `${what} must be a number 0..100, got ${JSON.stringify(value)}`);
  if (n < 0 || n > 100) throw new PodError('bad_request', `${what} must be 0..100, got ${n}`);
  return n;
}

export function checkLookName(name) {
  const key = String(name ?? '').trim();
  if (!LOOK_NAME_RE.test(key)) throw new PodError('bad_request', `look name ${JSON.stringify(name)}: ${LOOK_NAME_RULE}`);
  return key;
}

export function checkLabel(text) {
  const clean = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  if (clean.length > LABEL_MAX) throw new PodError('bad_request', `label is longer than ${LABEL_MAX} characters`);
  if (/[\u0000-\u001f]/.test(clean)) throw new PodError('bad_request', 'label has control characters');
  return clean;
}

// Set command for every lamp of one pod. levels: {port: 0..255}; ports left out are off.
export function buildSetFrame(levels, boost, wantStatus = false) {
  const lamps = [0xff, 0xff, 0xff, 0xff, 0xff];
  for (const [portKey, level] of Object.entries(levels)) {
    const port = Number(portKey);
    if (!(port in LAMP_INDEX)) throw new PodError('bad_request', `port ${portKey} does not exist (1 to 5)`);
    lamps[LAMP_INDEX[port]] = 255 - clamp(Math.round(Number(level)) || 0, 0, 255);
  }
  const frame = Buffer.from([SET_CMD, ...lamps, boost ? 1 : 0]);
  return wantStatus ? Buffer.concat([frame, STATUS_REQUEST]) : frame;
}

// The level a pod drives (and reports) for a commanded level: the same with boost, a third without.
export function driveLevel(level, boost) {
  const l = clamp(Math.round(Number(level)) || 0, 0, 255);
  return boost ? l : Math.floor((l * 85) / 256);
}

// The commanded level a reported (driven) level most likely came from.
export function commandedLevel(drive, boost) {
  const d = clamp(Math.round(Number(drive)) || 0, 0, 255);
  return boost ? d : clamp(Math.round((d * 256) / 85), 0, 255);
}

export function batteryPct(raw) {
  return clamp(Math.round(((raw - BATTERY_MIN) * 100) / (BATTERY_MAX - BATTERY_MIN)), 0, 100);
}

export function parseStatus(data) {
  const b = Buffer.from(data);
  if (b.length !== STATUS_LEN) throw new PodError('bad_request', `pod status frame must be ${STATUS_LEN} bytes, got ${b.length}: ${b.toString('hex')}`);
  const levels = {};
  for (const port of PORTS) levels[port] = 255 - b[LAMP_INDEX[port]];
  return {
    levels,
    arms: PORTS.filter((p) => b[8] & ARM_BIT[p]),
    usb: Boolean(b[5]),
    batteryRaw: b[6],
    batteryPct: batteryPct(b[6]),
    batteryCondition: b[7],
    boost: Boolean(b[9]),
    firmware: b[10],
    raw: b.toString('hex'),
  };
}

// Notification bytes -> status frames. A notification is normally one whole frame. One that is
// exactly a frame long always is one, and drops whatever partial frame was buffered (resync
// after a lost packet).
export class StatusDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  feed(data) {
    const chunk = Buffer.from(data);
    this.buf = chunk.length === STATUS_LEN ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= STATUS_LEN) {
      out.push(parseStatus(this.buf.subarray(0, STATUS_LEN)));
      this.buf = this.buf.subarray(STATUS_LEN);
    }
    return out;
  }
}

// Bluetooth addresses as the UI shows them: AA:BB:CC:DD:EE:FF.
export function normalizeAddress(text) {
  const hex = String(text ?? '')
    .trim()
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
  if (hex.length !== 12) throw new PodError('bad_request', `Bluetooth address ${JSON.stringify(text)} is not 6 hex bytes`);
  return hex.match(/../g).join(':');
}
