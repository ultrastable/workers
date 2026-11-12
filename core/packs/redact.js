// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Keeps secret values out of pack loop logs (US-21-R09): errors, run rows, backlog item titles, tick notes and delivery failures
// all pass through one redactor in the host wrapper. Two sources: the values of the secret names a manifest declares (and settings
// whose key looks secret), and the secret shapes in SECRET_PATTERNS. Values are matched raw, URL-encoded and base64 encoded.
import { SECRET_PATTERNS } from './guard.js';

export const REDACTED = '[redacted]';
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
const MIN_LEN = 6;                                              // shorter values would redact ordinary words
const globalOf = re => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
const GLOBAL_PATTERNS = SECRET_PATTERNS.map(globalOf);

const b64 = s => { try { return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, ''); } catch { return null; } };
export function forms(value) {
  const v = String(value);
  return [...new Set([v, encodeURIComponent(v), b64(v)].filter(x => x && x.length >= MIN_LEN))];
}

// values: array or function returning an array of secret strings (read at each call, so late-learned values apply).
export function createRedactor({ values = [] } = {}) {
  const current = () => (typeof values === 'function' ? values() : values);
  function redact(text) {
    let t = String(text ?? '');
    const all = [];
    for (const v of current()) if (typeof v === 'string' && v.length >= MIN_LEN) all.push(...forms(v));
    all.sort((a, b) => b.length - a.length);                    // longest first so a secret containing another is fully removed
    for (const f of all) if (t.includes(f)) t = t.split(f).join(REDACTED);
    for (const re of GLOBAL_PATTERNS) t = t.replace(re, REDACTED);
    return t;
  }
  function deep(x, seen = new WeakSet()) {
    if (typeof x === 'string') return redact(x);
    if (!x || typeof x !== 'object' || seen.has(x)) return x;
    seen.add(x);
    return Array.isArray(x) ? x.map(v => deep(v, seen)) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v, seen)]));
  }
  return { redact, deep };
}

// The secret values one pack can see: its declared secret names resolved in env, plus string settings under a secret-looking key.
export function secretValuesFor(manifest, { env = {}, settings = {} } = {}) {
  const out = [];
  for (const name of manifest?.requires?.secrets || []) if (typeof env?.[name] === 'string') out.push(env[name]);
  const walk = (o, hit) => {
    if (typeof o === 'string') { if (hit) out.push(o); return; }
    if (Array.isArray(o)) return o.forEach(v => walk(v, hit));
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, hit || SECRET_KEY.test(k));
  };
  walk(settings, false);
  return out.filter(v => v.length >= MIN_LEN);
}

// A notes/errors list the loop can only push to; everything pushed is redacted first and written to the real list.
export function redactingSink(target, redact) {
  return Object.freeze({ push: (...xs) => target.push(...xs.map(x => redact(x))), get length() { return target.length; } });
}
