// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256ChainCheckpoints, solveChallenge, powWorkerSource, base64urlToBytes } from '../src/pow.js';

const sha = (b) => createHash('sha256').update(b).digest();

function reference(seed, k, g) {
  const cps = [];
  let h = sha(seed); cps.push(h);
  for (let s = 0; s < k; s++) { for (let i = 0; i < g; i++) h = sha(h); cps.push(h); }
  return Buffer.concat(cps);
}

test('the in-page SHA-256 chain equals the published reference algorithm', () => {
  for (const [k, g] of [[1, 1], [3, 5], [7, 13], [20, 100]]) {
    const seed = randomBytes(32);
    assert.equal(Buffer.from(sha256ChainCheckpoints(seed, k, g)).toString('hex'), reference(seed, k, g).toString('hex'), `k=${k} g=${g}`);
  }
});

test('solveChallenge decodes the base64url seed and returns standard base64 checkpoints', () => {
  const seed = randomBytes(32);
  const seedB64u = seed.toString('base64url');
  assert.deepEqual([...base64urlToBytes(seedB64u)], [...seed]);
  const r = solveChallenge({ challengeToken: 'tok', seed: seedB64u, k: 4, g: 9 });
  assert.equal(r.challengeToken, 'tok');
  assert.equal(r.solution.checkpoints, reference(seed, 4, 9).toString('base64'));
});

test('out-of-bounds or malformed challenges are refused before any work', () => {
  const seed = randomBytes(32).toString('base64url');
  assert.throws(() => solveChallenge({ challengeToken: 't', seed, k: 0, g: 5 }), /bounds/);
  assert.throws(() => solveChallenge({ challengeToken: 't', seed, k: 8001, g: 8000 }), /bounds/);
  assert.throws(() => solveChallenge({ challengeToken: 't', seed: 'AAAA', k: 2, g: 2 }), /32 bytes/);
});

test('the Web Worker source is self-contained and gives the same answer', () => {
  const src = powWorkerSource();
  const results = [];
  const self = { postMessage: (m) => results.push(m) };
  new Function('self', 'atob', 'btoa', src + '\nself.onmessage({ data: { seed: "' + Buffer.alloc(32, 7).toString('base64url') + '", k: 3, g: 4 } });')(self, atob, btoa);
  assert.equal(results[0].checkpoints, reference(Buffer.alloc(32, 7), 3, 4).toString('base64'));
});

test('speed: the published example size (k=8000, g=2000) is feasible on a device', () => {
  const t = Date.now();
  sha256ChainCheckpoints(randomBytes(32), 200, 2000); // 1/40 of the example: 400k hashes
  const perSecond = 400000 / ((Date.now() - t) / 1000);
  console.log(`# pow throughput: ${Math.round(perSecond).toLocaleString()} hashes/s; example size 16,000,000 hashes in about ${(16000000 / perSecond).toFixed(1)} s on this machine`);
  assert.ok(perSecond > 300000, `too slow: ${perSecond}`);
});
