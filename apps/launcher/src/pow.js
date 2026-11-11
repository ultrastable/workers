// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Cloudflare's temporary-account proof of work: a sequential SHA-256 chain (k segments of g hashes). It must run on the
// person's device (a Worker on the free plan has 10 ms of CPU), so this function is self-contained: the page ships its
// source text to a Web Worker. Verified against Node's crypto in the tests.

/** Returns the concatenated checkpoints (k + 1 of 32 bytes) for a 32-byte seed. Self-contained on purpose. */
export function sha256ChainCheckpoints(seed, k, g) {
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);
  const h = new Int32Array(8);
  const out = new Uint8Array((k + 1) * 32);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));

  // one 32-byte message = one padded block: words 0..7 are the message, then 0x80000000, zeros, and the bit length 256
  function round(m) {
    for (let i = 0; i < 8; i++) w[i] = m[i];
    w[8] = 0x80000000 | 0;
    for (let i = 9; i < 15; i++) w[i] = 0;
    w[15] = 256;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ror(a, 7) ^ ror(a, 18) ^ (a >>> 3);
      const s1 = ror(b, 17) ^ ror(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = IV[0] | 0, b = IV[1] | 0, c = IV[2] | 0, d = IV[3] | 0, e = IV[4] | 0, f = IV[5] | 0, gg = IV[6] | 0, hh = IV[7] | 0;
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & gg);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = gg; gg = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (IV[0] + a) | 0; h[1] = (IV[1] + b) | 0; h[2] = (IV[2] + c) | 0; h[3] = (IV[3] + d) | 0;
    h[4] = (IV[4] + e) | 0; h[5] = (IV[5] + f) | 0; h[6] = (IV[6] + gg) | 0; h[7] = (IV[7] + hh) | 0;
  }
  const put = (idx) => { for (let i = 0; i < 8; i++) { const v = h[i]; const o = idx * 32 + i * 4; out[o] = v >>> 24; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255; } };
  const first = new Int32Array(8);
  for (let i = 0; i < 8; i++) first[i] = (seed[i * 4] << 24) | (seed[i * 4 + 1] << 16) | (seed[i * 4 + 2] << 8) | seed[i * 4 + 3];
  round(first); put(0); // checkpoint[0] = SHA-256(seed)
  for (let s = 0; s < k; s++) {
    for (let n = 0; n < g; n++) round(h);
    put(s + 1);
  }
  return out;
}

export function base64urlToBytes(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Solve a challenge as Cloudflare returns it: {challengeToken, seed, k, g}. Enforces the published bounds first. */
export function solveChallenge({ challengeToken, seed, k, g }) {
  if (!Number.isInteger(k) || !Number.isInteger(g) || k <= 0 || g <= 0 || k * g > 64_000_000) throw new Error('challenge parameters out of bounds');
  const bytes = base64urlToBytes(seed);
  if (bytes.length !== 32) throw new Error('challenge seed must be 32 bytes');
  return { challengeToken, solution: { checkpoints: bytesToBase64(sha256ChainCheckpoints(bytes, k, g)) } };
}

/** Source text for a Web Worker that solves a challenge off the page's main thread. */
export function powWorkerSource() {
  return `${sha256ChainCheckpoints.toString()}\n${base64urlToBytes.toString()}\n${bytesToBase64.toString()}\n` +
    `self.onmessage = (e) => { try { const { seed, k, g } = e.data; ` +
    `const bytes = base64urlToBytes(seed); const cp = sha256ChainCheckpoints(bytes, k, g); self.postMessage({ checkpoints: bytesToBase64(cp) }); } ` +
    `catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };`;
}
