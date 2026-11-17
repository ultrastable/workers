// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Distributions and a seeded generator, so every estimate is a range and every run is reproducible.
// A distribution is a number (a point) or { kind, ... }:
//   { kind:'ci90', low, high, shape:'normal'|'lognormal' }  a 90% subjective confidence interval (the form evidence is usually reported in)
//   { kind:'tri', min, mode, max } | { kind:'uniform', min, max } | { kind:'beta', a, b }
export function rng(seed = 1) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const Z90 = 1.6448536269514722;
export function normal(rand) { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gamma(k, rand) { // Marsaglia-Tsang
  if (k < 1) return gamma(k + 1, rand) * Math.pow(rand() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(rand); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = rand(); if (Math.log(u || 1e-12) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v; }
}
export function validDist(d) {
  if (typeof d === 'number') return Number.isFinite(d);
  if (!d || typeof d !== 'object') return false;
  if (d.kind === 'ci90') return Number.isFinite(d.low) && Number.isFinite(d.high) && d.low <= d.high && (d.shape !== 'lognormal' || d.low > 0);
  if (d.kind === 'tri') return d.min <= d.mode && d.mode <= d.max;
  if (d.kind === 'uniform') return d.min <= d.max;
  if (d.kind === 'beta') return d.a > 0 && d.b > 0;
  return false;
}
export function sample(d, rand) {
  if (typeof d === 'number') return d;
  switch (d.kind) {
    case 'ci90': {
      if (d.shape === 'lognormal') { const lo = Math.log(d.low), hi = Math.log(d.high); return Math.exp((lo + hi) / 2 + ((hi - lo) / (2 * Z90)) * normal(rand)); }
      return (d.low + d.high) / 2 + ((d.high - d.low) / (2 * Z90)) * normal(rand);
    }
    case 'uniform': return d.min + (d.max - d.min) * rand();
    case 'tri': { const u = rand(), f = (d.mode - d.min) / ((d.max - d.min) || 1); return u < f ? d.min + Math.sqrt(u * (d.max - d.min) * (d.mode - d.min)) : d.max - Math.sqrt((1 - u) * (d.max - d.min) * (d.max - d.mode)); }
    case 'beta': { const x = gamma(d.a, rand), y = gamma(d.b, rand); return x / (x + y); }
    default: throw new Error('unknown distribution kind ' + d.kind);
  }
}
// Mean and standard deviation in the space the distribution is reported in (used by evidence pooling).
export function moments(d) {
  if (typeof d === 'number') return { mean: d, sd: 0 };
  if (d.kind === 'ci90') {
    if (d.shape === 'lognormal') { const lo = Math.log(d.low), hi = Math.log(d.high); return { mean: (lo + hi) / 2, sd: (hi - lo) / (2 * Z90), log: true }; }
    return { mean: (d.low + d.high) / 2, sd: (d.high - d.low) / (2 * Z90) };
  }
  if (d.kind === 'uniform') return { mean: (d.min + d.max) / 2, sd: (d.max - d.min) / Math.sqrt(12) };
  if (d.kind === 'tri') return { mean: (d.min + d.mode + d.max) / 3, sd: Math.sqrt((d.min ** 2 + d.mode ** 2 + d.max ** 2 - d.min * d.mode - d.min * d.max - d.mode * d.max) / 18) };
  return { mean: d.a / (d.a + d.b), sd: Math.sqrt((d.a * d.b) / ((d.a + d.b) ** 2 * (d.a + d.b + 1))) };
}
export function quantile(sorted, q) { if (!sorted.length) return NaN; const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
export function summarize(xs) {
  const s = Float64Array.from(xs).sort(); const n = s.length; let sum = 0; for (const x of s) sum += x;
  return { n, mean: sum / n, p5: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95) };
}
