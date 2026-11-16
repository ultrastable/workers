// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Vector search inside the tenant's own store. Embeddings are int8-quantized (1 byte per dimension, about 4x smaller than float32)
// and ranked by cosine similarity. Brute force is exact, needs no extra service, and is bounded by maxVectors, so cost is bounded too.
// Past the cap a tenant is promoted to a Vectorize namespace through the VectorPort (adapters), never silently.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS _vec (id TEXT PRIMARY KEY, ns TEXT NOT NULL DEFAULT '', dim INTEGER NOT NULL, scale REAL NOT NULL, q BLOB NOT NULL, meta TEXT);
CREATE INDEX IF NOT EXISTS _vec_ns ON _vec(ns);
`;

export function quantize(v) {
  let max = 0; for (const x of v) max = Math.max(max, Math.abs(x));
  const scale = max / 127 || 1, q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { q, scale };
}
export function cosineQ(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const toI8 = (blob) => new Int8Array(blob.buffer ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) : blob);

export class VectorIndex {
  constructor(sql, guard) { this.sql = sql; this.guard = guard; this.sql.exec(SCHEMA); }
  count() { return this.sql.exec('SELECT COUNT(*) n FROM _vec').rows[0].n; }
  upsert(id, vector, { ns = '', meta = null } = {}) {
    this.guard.check();
    const exists = this.sql.exec('SELECT 1 x FROM _vec WHERE id=?', [id]).rows.length;
    if (!exists && this.count() >= this.guard.budget.maxVectors) { const e = new Error('vector_cap'); e.code = 'vector_cap'; e.max = this.guard.budget.maxVectors; throw e; }
    const { q, scale } = quantize(vector);
    const r = this.sql.exec('INSERT OR REPLACE INTO _vec(id,ns,dim,scale,q,meta) VALUES(?,?,?,?,?,?)', [id, ns, vector.length, scale, q, meta === null ? null : JSON.stringify(meta)]);
    this.guard.record({ writes: r.rowsWritten, reads: r.rowsRead });
  }
  remove(id) { const r = this.sql.exec('DELETE FROM _vec WHERE id=?', [id]); this.guard.record({ writes: r.rowsWritten }); }
  // Reads only the namespace's rows and charges every one of them: the cost of a query is its candidate count, visibly.
  query(vector, { k = 5, ns = '' } = {}) {
    this.guard.check();
    const { q } = quantize(vector);
    const r = this.sql.exec('SELECT id,q,meta FROM _vec WHERE ns=? AND dim=?', [ns, vector.length]);
    if (r.rowsRead > this.guard.budget.perQueryReads) { this.guard.record({ reads: r.rowsRead, vecDims: r.rowsRead * vector.length }); const e = new Error('query_too_wide'); e.code = 'query_too_wide'; throw e; }
    const scored = r.rows.map(row => ({ id: row.id, score: cosineQ(q, toI8(row.q)), meta: row.meta ? JSON.parse(row.meta) : null }));
    scored.sort((a, b) => b.score - a.score);
    this.guard.record({ reads: r.rowsRead, vecDims: r.rowsRead * vector.length });
    return scored.slice(0, k);
  }
}
