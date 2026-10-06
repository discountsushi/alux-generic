// lib/pods against the pod simulator: protocol, one pod, the manager, and the HTTP API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import { createApp } from '../lib/app.js';
import { StatusDecoder, buildSetFrame, checkLookName, levelToPct, normalizeAddress, parseStatus, pctToLevel, PodError } from '../lib/pods/protocol.js';
import { SimPod } from '../lib/pods/sim.js';
import { Pod } from '../lib/pods/pod.js';
import { Pods, memoryStore, normalizeConfig, quietLog } from '../lib/pods/pods.js';
import { RAVE_BPM_MAX, RAVE_BPM_MIN, clampBpm, makeRng, ravePattern, raveLevels } from '../lib/pods/rave.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  pods: {
    mini_a: { address: 'E7:FD:17:2F:11:8A', model: 'pod_mini' },
    big: { address: 'aa-bb-cc-dd-ee-ff', model: 'pod3' },
  },
  arms: {
    key: { pod: 'mini_a' },
    rim: { pod: 'big', port: 1, label: 'Rim light' },
    fill: { pod: 'big', port: 4 },
  },
  settings: { confirmTimeoutMs: 100 },
};

// A manager on simulated pods, with the SimPod instances to hand for the tests.
function makePods({ config = CONFIG, simOptions = {}, store = memoryStore() } = {}) {
  const sims = {};
  const linkFactory = (cfg, sim) => {
    assert.equal(sim, true);
    return (sims[cfg.name] = new SimPod(cfg, simOptions[cfg.name]));
  };
  store.set('config', config);
  const pods = new Pods({ store, linkFactory, log: quietLog, scan: async () => [] });
  return { pods, sims, store };
}

// --------------------------------------------------------------------------- protocol

test('percent <-> level rounds like the pods take it', () => {
  assert.equal(pctToLevel(0), 0);
  assert.equal(pctToLevel(100), 255);
  assert.equal(pctToLevel(10), 26);
  assert.equal(levelToPct(26), 10.2);
  assert.equal(pctToLevel(150), 255);
  assert.equal(levelToPct(-5), 0);
});

test('set frame: inverted lamps in port order 2,1,3,4,5, boost byte, optional status request', () => {
  const f = buildSetFrame({ 1: 255, 2: 0, 4: 128 }, true);
  assert.equal(f.toString('hex'), '77ff00ff7fff01');
  assert.equal(buildSetFrame({}, false, true).toString('hex'), '77ffffffffff0023');
  assert.throws(() => buildSetFrame({ 6: 1 }, false), /port 6/);
});

test('status frame decodes levels, arms, battery and boost', () => {
  const st = parseStatus(Buffer.from([0x00, 0xff, 0x80, 0xff, 0xff, 1, 190, 0, 0x03, 1, 7]));
  assert.deepEqual(st.levels, { 1: 0, 2: 255, 3: 127, 4: 0, 5: 0 });
  assert.deepEqual(st.arms, [1, 2]);
  assert.equal(st.usb, true);
  assert.equal(st.batteryPct, 82);
  assert.equal(st.boost, true);
  assert.equal(st.firmware, 7);
  assert.throws(() => parseStatus(Buffer.alloc(10)), /11 bytes/);
});

test('status decoder joins split notifications and resyncs on a whole frame', () => {
  const d = new StatusDecoder();
  const frame = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0, 150, 0, 1, 0, 7]);
  assert.equal(d.feed(frame.subarray(0, 4)).length, 0);
  assert.equal(d.feed(frame.subarray(4)).length, 1);
  assert.equal(d.feed(frame.subarray(0, 3)).length, 0); // a lost packet leaves 3 stray bytes
  assert.equal(d.feed(frame).length, 1); // a whole frame drops them
  assert.equal(d.buf.length, 0);
});

test('addresses and look names are checked', () => {
  assert.equal(normalizeAddress('e7:fd:17:2f:11:8a'), 'E7:FD:17:2F:11:8A');
  assert.equal(normalizeAddress('E7FD172F118A'), 'E7:FD:17:2F:11:8A');
  assert.throws(() => normalizeAddress('nope'), PodError);
  assert.equal(checkLookName(' Key left '), 'Key left');
  assert.throws(() => checkLookName('-bad'), /look name/);
  assert.throws(() => checkLookName('x'.repeat(41)), /look name/);
});

// --------------------------------------------------------------------------- one pod

const miniCfg = { name: 'mini_a', address: 'E7:FD:17:2F:11:8A', model: 'pod_mini', boost: null, label: '' };

test('boost off: the pod drives a third, and that is what a set is confirmed against', async () => {
  const sim = new SimPod(miniCfg, { boost: false });
  sim.lamps[0] = 255 - 255; // the phone app left port 2 at 100%, boost off: the pod reports 84
  const pod = new Pod(miniCfg, sim, { confirmTimeoutMs: 100, log: quietLog });
  const st = await pod.open();
  assert.equal(st.levels[2], 84);
  assert.equal(pod.levels[2], 253, 'read back as the level that was asked for');
  assert.equal(pod.boost, false);
  const got = await pod.confirm(await pod.send({ 2: 127 }));
  assert.equal(got.levels[2], 42, 'driven at a third');
  assert.equal(sim.level(2), 127, 'the pod holds what was asked');
  const full = await pod.setBoost(true);
  assert.equal(full.boost, true);
  assert.equal(full.levels[2], 127, 'boost on: driven as asked');
  const back = await pod.confirm(await pod.send({ 2: 200 }, { boost: false }));
  assert.equal(back.boost, false);
  assert.equal(back.levels[2], 66, 'boost off again: a third of 200');
  await pod.close();
});

test('a pod connects without changing the light and confirms a set', async () => {
  const sim = new SimPod(miniCfg, { boost: true });
  sim.lamps[0] = 255 - 128; // port 2 at 50% before we connect
  const pod = new Pod(miniCfg, sim, { confirmTimeoutMs: 100, log: quietLog });
  const st = await pod.open();
  assert.equal(st.levels[2], 128);
  assert.equal(pod.levels[2], 128); // commanded = reported, so nothing was sent but '#'
  assert.deepEqual(
    sim.writes.map((w) => w.toString('hex')),
    ['23'],
  );
  const seq0 = await pod.send({ 2: 255 });
  const got = await pod.confirm(seq0);
  assert.equal(got.levels[2], 255);
  assert.equal(sim.level(2), 255);
  assert.equal(pod.snapshot().batteryPct, 82);
  await pod.close();
  assert.equal(pod.connected, false);
});

test('a pod that never answers times out with what it last reported', async () => {
  const sim = new SimPod(miniCfg, { answerSets: false });
  const pod = new Pod(miniCfg, sim, { confirmTimeoutMs: 60, log: quietLog });
  await pod.open();
  const seq0 = await pod.send({ 2: 255 });
  await assert.rejects(pod.confirm(seq0), (err) => err.code === 'timeout' && /no confirmation in 0.06 s/.test(err.message));
  await pod.close();
});

test('a stale status before the real one does not confirm a set', async () => {
  const sim = new SimPod(miniCfg, { staleReplies: 1, boost: true });
  const pod = new Pod(miniCfg, sim, { confirmTimeoutMs: 100, log: quietLog });
  await pod.open();
  const seq0 = await pod.send({ 2: 200 });
  const st = await pod.confirm(seq0);
  assert.equal(st.levels[2], 200);
  await pod.close();
});

test('a dropped link fails the wait and shows in the snapshot', async () => {
  const sim = new SimPod(miniCfg, { answerSets: false });
  const pod = new Pod(miniCfg, sim, { confirmTimeoutMs: 500, log: quietLog });
  await pod.open();
  const seq0 = await pod.send({ 2: 10 });
  const waiting = pod.confirm(seq0);
  sim.drop('battery died');
  await assert.rejects(waiting, (err) => err.code === 'not_connected' && /battery died/.test(err.message));
  assert.match(pod.snapshot().error, /link lost/);
});

test('a pod that fails to open releases its link', async () => {
  const sim = new SimPod(miniCfg, { silent: true });
  const pod = new Pod(miniCfg, sim, { confirmTimeoutMs: 30, log: quietLog });
  await assert.rejects(pod.open(), (err) => err.code === 'timeout');
  assert.equal(sim.connected, false);
});

// --------------------------------------------------------------------------- set-up

test('config: arms default to one per port, ports and addresses are checked', () => {
  const c = normalizeConfig({ pods: { mini_a: { address: 'E7FD172F118A' }, big: { address: '00:11:22:33:44:55', model: 'pod3' } } });
  assert.deepEqual(Object.keys(c.arms), ['mini_a', 'big_1', 'big_2', 'big_3', 'big_4', 'big_5']);
  assert.equal(c.arms.mini_a.port, 2);
  assert.equal(c.settings.confirmTimeoutMs, 2000);
  assert.throws(() => normalizeConfig({ pods: { a: { address: 'E7FD172F118A' } }, arms: { x: { pod: 'a', port: 3 } } }), /has no port 3/);
  assert.throws(() => normalizeConfig({ pods: { a: { address: 'E7FD172F118A' }, b: { address: 'e7:fd:17:2f:11:8a' } } }), /two pods have the address/);
  assert.throws(() => normalizeConfig({ pods: { a: { address: 'E7FD172F118A', model: 'pod3' } }, arms: { x: { pod: 'a', port: 1 }, y: { pod: 'a', port: 1 } } }), /already an arm/);
  assert.throws(() => normalizeConfig({ pods: { a: { address: 'E7FD172F118A' } }, settings: { keepaliveMs: -1 } }), /settings.keepaliveMs/);
});

// --------------------------------------------------------------------------- manager

test('connect sim, set arms, all on/off, levels', async () => {
  const { pods, sims } = makePods();
  const events = [];
  pods.subscribe((s) => events.push(s));
  assert.deepEqual(await pods.connect({ sim: true }), []);
  assert.equal(pods.connected, true);
  assert.equal(pods.sim, true);
  assert.deepEqual(await pods.setLevels({ key: 60, rim: 25 }), { key: 60, rim: 25.1 });
  assert.equal(sims.mini_a.level(2), 153);
  assert.equal(sims.big.level(1), 64);
  assert.equal(sims.big.level(4), 0);
  assert.deepEqual(pods.levels(), { key: 60, rim: 25.1, fill: 0 });
  await pods.all(100);
  assert.deepEqual(pods.levels(), { key: 100, rim: 100, fill: 100 });
  await pods.all(0);
  assert.deepEqual(pods.levels(), { key: 0, rim: 0, fill: 0 });
  assert.equal(sims.big.level(2), 0); // ports with no arm set up are sent off
  const snap = pods.snapshot();
  assert.equal(snap.arms.find((a) => a.name === 'rim').label, 'Rim light');
  assert.equal(snap.arms.find((a) => a.name === 'rim').present, true);
  assert.ok(events.length >= 3, 'change events were published');
  await pods.disconnect();
  assert.equal(pods.connected, false);
  assert.deepEqual(pods.levels(), { key: 0, rim: 0, fill: 0 });
});

test('bad levels and unknown arms are refused before anything is sent', async () => {
  const { pods, sims } = makePods();
  await pods.connect({ sim: true });
  const before = sims.big.writes.length;
  await assert.rejects(pods.setLevels({ rim: 101 }), /must be 0..100/);
  await assert.rejects(pods.setLevels({ nope: 10 }), /no arm "nope"/);
  assert.equal(sims.big.writes.length, before);
  await pods.disconnect();
});

test('one pod missing: its lit arms fail, looks still run on the rest', async () => {
  const { pods } = makePods({ simOptions: { big: { failOpen: 'pod big not found' } } });
  const problems = await pods.connect({ sim: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /big not found/);
  assert.equal(pods.connected, true);
  assert.match(pods.snapshot().connectError, /big/);
  await assert.rejects(pods.setLevels({ rim: 50 }), (err) => err.code === 'not_connected' && /rim \(pod big/.test(err.message));
  pods.saveLook('key only', { key: 80, rim: 0 });
  assert.deepEqual(await pods.applyLook('key only'), { key: 80 });
  assert.deepEqual(pods.liveArms(), ['key']);
  await pods.disconnect();
});

test('no pod connects: connect rejects and a second connect is refused while one runs', async () => {
  const { pods } = makePods({ simOptions: { mini_a: { failOpen: 'a' }, big: { failOpen: 'b' } } });
  await assert.rejects(pods.connect({ sim: true }), /no pod connected: mini_a: a; big: b/);
  assert.equal(pods.connected, false);
  const slow = makePods({ simOptions: { mini_a: { openDelayMs: 80 }, big: { openDelayMs: 80 } } });
  const first = slow.pods.connect({ sim: true });
  await assert.rejects(slow.pods.connect({ sim: true }), (err) => err.code === 'busy');
  assert.equal(slow.pods.snapshot().connecting, true);
  await first;
  assert.equal(slow.pods.snapshot().connecting, false);
  await slow.pods.disconnect();
});

test('connect never changes the light; a pod with boost set gets it', async () => {
  const { pods, sims } = makePods({ config: { ...CONFIG, pods: { ...CONFIG.pods, big: { ...CONFIG.pods.big, boost: true } } } });
  await pods.connect({ sim: true });
  assert.deepEqual(
    sims.mini_a.writes.map((w) => w.toString('hex')),
    ['23'],
  );
  assert.equal(sims.big.boost, true);
  assert.equal(pods.snapshot().pods.find((p) => p.name === 'big').boost, true);
  await pods.disconnect();
});

test('labels and looks persist in the store', async () => {
  const store = memoryStore();
  const { pods } = makePods({ store });
  assert.equal(pods.setLabel('key', '  Key  left '), 'Key left');
  assert.equal(pods.setLabel('key', ''), 'key');
  assert.throws(() => pods.setLabel('key', 'x'.repeat(41)), /longer than 40/);
  await pods.connect({ sim: true });
  await pods.setLevels({ key: 30, fill: 70 });
  assert.deepEqual(pods.saveLook('Soft'), { key: 30.2, rim: 0, fill: 70.2 }); // as the pods hold them
  assert.deepEqual(pods.saveLook('soft', { key: 10 }), { key: 10 }); // renames the same look
  assert.deepEqual(Object.keys(pods.snapshot().looks), ['soft']);
  assert.throws(() => pods.saveLook('/junk'), /look name/);
  await pods.disconnect();
  pods.setLabel('rim', 'Rim');
  const again = new Pods({ store, linkFactory: () => new SimPod(miniCfg), log: quietLog });
  assert.deepEqual(again.looks, { soft: { key: 10 } });
  assert.equal(again.label('rim'), 'Rim');
  assert.equal(again.deleteLook('SOFT'), 'soft');
  assert.throws(() => again.deleteLook('soft'), /not saved/);
});

test('arm kinds and pod labels: set, kept, checked, and never a disconnect', async () => {
  const store = memoryStore();
  const { pods } = makePods({ store });
  await pods.connect({ sim: true });
  assert.deepEqual(pods.setArm('key', { kind: 'UV' }), { name: 'key', label: 'key', kind: 'uv' });
  assert.deepEqual(pods.setArm('rim', { label: 'Rim', kind: 'super' }), { name: 'rim', label: 'Rim', kind: 'super' });
  assert.throws(() => pods.setArm('rim', { kind: 'laser' }), /arm kind "laser"/);
  assert.equal(pods.setArm('rim', { kind: '' }).kind, null, 'blank clears the kind');
  assert.equal(pods.setArm('rim', {}).label, 'Rim', 'nothing given, nothing changed');
  assert.equal(pods.setPodLabel('big', ' Control  Pod '), 'Control Pod');
  assert.throws(() => pods.setPodLabel('nope', 'x'), /no pod "nope"/);
  assert.equal(pods.connected, true, 'labels and kinds never drop the link');
  const snap = pods.snapshot();
  assert.equal(snap.arms.find((a) => a.name === 'key').kind, 'uv');
  assert.equal(snap.pods.find((p) => p.name === 'big').label, 'Control Pod');
  await pods.disconnect();
  const again = new Pods({ store, linkFactory: () => new SimPod(miniCfg), log: quietLog });
  assert.equal(again.config.arms.key.kind, 'uv');
  assert.equal(again.config.pods.big.label, 'Control Pod');
  assert.throws(() => normalizeConfig({ pods: { a: { address: 'E7FD172F118A' } }, arms: { x: { pod: 'a', kind: 'plasma' } } }), /arm kind/);
});

test('setConfig replaces the set-up and disconnects first', async () => {
  const { pods } = makePods();
  await pods.connect({ sim: true });
  const snap = await pods.setConfig({ pods: { solo: { address: '11:22:33:44:55:66', model: 'pod_mini' } } });
  assert.equal(snap.connected, false);
  assert.deepEqual(
    snap.arms.map((a) => a.name),
    ['solo'],
  );
  assert.equal(snap.settings.confirmTimeoutMs, 100); // settings kept
  await assert.rejects(pods.setConfig({ pods: { bad: { address: 'zz' } } }), /not 6 hex bytes/);
  assert.deepEqual(
    pods.snapshot().arms.map((a) => a.name),
    ['solo'],
  ); // a bad set-up changes nothing
});

// --------------------------------------------------------------------------- rave

test('rave patterns: never a blackout in scatter, chase walks the arms, bpm is clamped', () => {
  const rng = makeRng(7);
  const arms = ['a', 'b', 'c'];
  for (let beat = 0; beat < 50; beat++) {
    const s = raveLevels('scatter', beat, arms, rng);
    assert.ok(Object.values(s).some((v) => v > 0));
    assert.ok(Object.values(s).every((v) => v >= 0 && v <= 100));
  }
  assert.deepEqual(raveLevels('chase', 4, arms, rng), { a: 0, b: 100, c: 0 });
  assert.deepEqual(raveLevels('strobe', 3, arms, rng), { a: 0, b: 0, c: 0 });
  assert.equal(Object.values(raveLevels('solo', 0, arms, rng)).filter((v) => v === 100).length, 1);
  assert.deepEqual(raveLevels('solo', 0, [], rng), {});
  assert.ok(['scatter', 'solo', 'chase', 'strobe'].includes(ravePattern(rng)));
  assert.equal(clampBpm(1000), RAVE_BPM_MAX);
  assert.equal(clampBpm(1), RAVE_BPM_MIN);
  assert.equal(RAVE_BPM_MAX / 60, 3, 'never faster than 3 changes a second');
  assert.throws(() => clampBpm('fast'), TypeError);
});

test('rave runs on the beat, any set ends it, off puts the lights back', async () => {
  const { pods, sims } = makePods();
  await pods.connect({ sim: true });
  await pods.setLevels({ key: 40, rim: 20 });
  const writesBefore = sims.big.writes.length;
  assert.equal(await pods.startRave(180, { seed: 1 }), 180);
  assert.deepEqual(pods.snapshot().rave, { bpm: 180 });
  await sleep(1200);
  const beats = sims.big.writes.slice(writesBefore).filter((w) => w.length === 7).length; // set frames, not the '#' after each
  assert.ok(beats >= 2 && beats <= 5, `about 3 beats a second at 180 BPM, got ${beats} in 1.2 s`);
  assert.equal(await pods.startRave(60), 60, 'running: only the tempo changes');
  await pods.setLevels({ fill: 100 });
  assert.equal(pods.snapshot().rave, null, 'a set ends the rave');
  assert.equal(pods.levels().fill, 100);
  await pods.setLevels({ key: 40, rim: 20 });
  await pods.startRave(120);
  await sleep(50);
  assert.equal(await pods.stopRave(), true);
  assert.deepEqual(pods.levels(), { key: 40, rim: 20, fill: 100 }, 'rave off restores what was set before it');
  assert.equal(await pods.stopRave(), false);
  await pods.disconnect();
});

test('rave stops on its own when every pod is gone', async () => {
  const { pods, sims } = makePods();
  await pods.connect({ sim: true });
  await pods.startRave(180);
  sims.mini_a.drop();
  sims.big.drop();
  await sleep(500);
  assert.equal(pods.snapshot().rave, null);
  await pods.disconnect();
});

// --------------------------------------------------------------------------- HTTP API

let server;
let base;
let appPods;

before(async () => {
  const { pods } = makePods();
  appPods = pods;
  const db = openDb(':memory:');
  server = http.createServer(createApp({ db, publicDir: path.join(ROOT, 'public'), pluginDir: '/tmp/plugin', pods }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await appPods.close();
  server.close();
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

test('api: bootstrap carries the pods, connect sim, set, looks, label, rave, errors by code', async () => {
  const boot = await call('GET', '/api/bootstrap');
  assert.equal(boot.body.pods.connected, false);
  assert.deepEqual(
    boot.body.pods.arms.map((a) => a.name),
    ['key', 'rim', 'fill'],
  );

  let r = await call('POST', '/api/pods/set', { levels: { key: 50 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'not_connected');

  r = await call('POST', '/api/pods/connect', { sim: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, true);
  assert.deepEqual(r.body.problems, []);

  r = await call('POST', '/api/pods/set', { levels: { key: 50, rim: 'abc' } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/pods/set', { levels: { key: 50 } });
  assert.deepEqual(r.body, { set: { key: 50.2 } });
  r = await call('POST', '/api/pods/all', { pct: 100 });
  assert.deepEqual(r.body.set, { key: 100, rim: 100, fill: 100 });

  r = await call('POST', '/api/pods/looks', { name: 'Hero', levels: { key: 100, rim: 30 } });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/pods/looks');
  assert.deepEqual(r.body, { Hero: { key: 100, rim: 30 } });
  r = await call('POST', '/api/pods/looks/hero/apply');
  assert.deepEqual(r.body.set, { key: 100, rim: 30.2, fill: 0 });
  r = await call('PUT', '/api/pods/arms/key/label', { label: 'Key left' });
  assert.deepEqual(r.body, { label: 'Key left' });
  r = await call('PUT', '/api/pods/arms/key', { kind: 'warm' });
  assert.deepEqual(r.body, { name: 'key', label: 'Key left', kind: 'warm' });
  r = await call('PUT', '/api/pods/arms/key', { kind: 'nope' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/pods/pods/mini_a/label', { label: 'Left mini' });
  assert.deepEqual(r.body, { label: 'Left mini' });
  assert.equal((await call('GET', '/api/pods')).body.pods[0].label, 'Left mini');
  r = await call('PUT', '/api/pods/pods/mini_a/boost', { on: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.boost, true);
  assert.equal((await call('GET', '/api/pods')).body.pods[0].boost, true);
  r = await call('DELETE', '/api/pods/looks/Hero');
  assert.deepEqual(r.body, { deleted: 'Hero' });
  r = await call('DELETE', '/api/pods/looks/Hero');
  assert.equal(r.status, 400);

  r = await call('POST', '/api/pods/rave', { bpm: 150 });
  assert.deepEqual(r.body, { rave: { bpm: 150 } });
  r = await call('GET', '/api/pods');
  assert.deepEqual(r.body.rave, { bpm: 150 });
  r = await call('POST', '/api/pods/rave', { on: false });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/pods')).body.rave, null);

  r = await call('POST', '/api/pods/scan', {});
  assert.equal(r.body.found.length, 2, 'sim scan lists the set-up pods');

  r = await call('POST', '/api/pods/disconnect');
  assert.equal(r.body.connected, false);
});

test('api: config round-trips and a bad one is refused', async () => {
  let r = await call('PUT', '/api/pods/config', { pods: { mini_a: { address: 'e7fd172f118a', model: 'pod_mini', label: 'Mini' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.arms.map((a) => a.name),
    ['mini_a'],
  );
  assert.equal(r.body.pods[0].address, 'E7:FD:17:2F:11:8A');
  r = await call('PUT', '/api/pods/config', { pods: { x: { address: '1' } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not 6 hex bytes/);
  await call('PUT', '/api/pods/config', CONFIG);
});

test('pods mode: the stand-alone page, only the pods API, a small bootstrap', async () => {
  const { pods } = makePods();
  const db = openDb(':memory:');
  const srv = http.createServer(createApp({ db, publicDir: path.join(ROOT, 'public'), pluginDir: '/tmp/plugin', pods, mode: 'pods' }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    const home = await fetch(`${b}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /<title>Adaptalux pod control<\/title>/);
    assert.match(html, /js\/pods-app\.js/);
    assert.equal((await fetch(`${b}/pods.html`)).status, 200);
    assert.equal((await fetch(`${b}/index.html`)).headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await (await fetch(`${b}/index.html`)).text(), /Adaptalux pod control/, 'index.html is the pods page too');
    assert.equal((await fetch(`${b}/api/stacks`)).status, 404, 'the planner API is off');
    assert.equal((await fetch(`${b}/api/cameras`)).status, 404);
    const boot = await (await fetch(`${b}/api/bootstrap`)).json();
    assert.deepEqual(Object.keys(boot).sort(), ['lan', 'mode', 'pods', 'version']);
    assert.equal(boot.mode, 'pods');
    const health = await (await fetch(`${b}/api/health`)).json();
    assert.equal(health.app, 'adaptalux-pods');
    const r = await fetch(`${b}/api/pods/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sim":true}' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).connected, true);
  } finally {
    await pods.close();
    srv.close();
  }
});

test('api: the event stream sends the state now and on every change', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/pods/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const until = async (n) => {
    while ((text.match(/^event: pods$/gm) || []).length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
  };
  await until(1);
  await call('POST', '/api/pods/connect', { sim: true });
  await until(2);
  const last = text.trim().split('\n\n').pop();
  const snap = JSON.parse(last.split('\ndata: ')[1]);
  assert.equal(snap.connected, true);
  ctrl.abort();
  await call('POST', '/api/pods/disconnect');
});
