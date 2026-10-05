// Rave: a random light show on the connected arms, one change per beat. Each bar of 8 beats
// picks a pattern: scatter (random arms on, off or in between), solo (one arm), chase (round the
// arms) or strobe (all on, all off). 180 BPM is 3 changes a second, kept under the 3 Hz where
// flashing light can trigger photosensitive seizures.

export const RAVE_BPM_MIN = 40;
export const RAVE_BPM_MAX = 180;
export const RAVE_BPM_DEFAULT = 128;
export const RAVE_BAR = 8; // beats per pattern
export const RAVE_PATTERNS = [
  ['scatter', 5],
  ['solo', 2],
  ['chase', 2],
  ['strobe', 1],
]; // [pattern, weight]

// A small seedable generator (mulberry32) so tests can replay a show.
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

export function ravePattern(rng) {
  const total = RAVE_PATTERNS.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [name, w] of RAVE_PATTERNS) {
    r -= w;
    if (r < 0) return name;
  }
  return RAVE_PATTERNS[RAVE_PATTERNS.length - 1][0];
}

// Every arm's level (percent) on this beat of a rave pattern.
export function raveLevels(pattern, beat, arms, rng) {
  if (!arms.length) return {};
  const out = {};
  if (pattern === 'solo') {
    const hit = pick(rng, arms);
    for (const a of arms) out[a] = a === hit ? 100 : 0;
    return out;
  }
  if (pattern === 'chase') {
    const hit = arms[beat % arms.length];
    for (const a of arms) out[a] = a === hit ? 100 : 0;
    return out;
  }
  if (pattern === 'strobe') {
    for (const a of arms) out[a] = beat % 2 === 0 ? 100 : 0;
    return out;
  }
  for (const a of arms) {
    // scatter
    const r = rng();
    out[a] = r < 0.45 ? 0 : r < 0.8 ? 100 : 10 + Math.floor(rng() * 81);
  }
  if (!Object.values(out).some(Boolean)) out[pick(rng, arms)] = 100; // scatter is never a blackout
  return out;
}

export function clampBpm(bpm) {
  const n = Number(bpm);
  if (typeof bpm === 'boolean' || !Number.isFinite(n)) throw new TypeError(`bpm must be a number, got ${JSON.stringify(bpm)}`);
  return Math.round(Math.min(RAVE_BPM_MAX, Math.max(RAVE_BPM_MIN, n)));
}
