// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
import test from 'node:test';
import assert from 'node:assert';
import { manifest, PRODUCTS } from './release_bundle.mjs';
test('manifest hashes bundle and migrations and lists products', () => {
  const m = manifest('a', 'b', '1.0.0');
  assert.equal(m.bundle_sha256, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.equal(m.version, '1.0.0');
  assert.deepEqual(m.products, PRODUCTS);
});
