#!/usr/bin/env node
// Adaptalux pod control: a local server. Serves the page and API on the LAN so a phone at the
// rig can use it.
//   PORT (default 4810) · HOST (default 0.0.0.0; set 127.0.0.1 to keep it on this computer only)
//   PODS_DB (default ./data/pods.db)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { createApp } from './lib/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4810;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.PODS_DB || path.join(ROOT, 'data', 'pods.db');

function lanUrls() {
  if (HOST === '127.0.0.1' || HOST === 'localhost') return [];
  const host = os.hostname().replace(/\.local$/i, '').toLowerCase();
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  // Home-LAN addresses first; Hyper-V / Docker / WSL bridges (usually 172.16–31.x) last.
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  ips.sort((a, b) => rank(a) - rank(b));
  return [...(host ? [`http://${host}.local:${PORT}`] : []), ...ips.slice(0, 3).map((ip) => `http://${ip}:${PORT}`)];
}

const db = openDb(DB_FILE);
const app = createApp({ db, publicDir: path.join(ROOT, 'public'), lanUrls });
const server = http.createServer(app);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy — is the pod control already running? (PORT=xxxx npm start to change)`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Adaptalux pod control running (${new Date().toLocaleString()})`);
  console.log(`  this computer: http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  phone/LAN:     ${u}`);
  console.log(`  database:      ${DB_FILE}`);
  if (app.pods.configured && app.pods.settings.autoConnect) {
    app.pods.connect().then(
      (problems) => console.log(`  pods:          connected${problems.length ? ` (${problems.join('; ')})` : ''}`),
      (err) => console.log(`  pods:          ${err.message}`),
    );
  }
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await app.pods.close().catch(() => {}); // gives the pods back to their buttons and the phone app
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
