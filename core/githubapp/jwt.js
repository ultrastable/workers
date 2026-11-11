// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// App JWT (RS256) with WebCrypto only. GitHub issues PKCS1 ("BEGIN RSA PRIVATE KEY") PEMs; WebCrypto imports PKCS8,
// so a PKCS1 key is wrapped in a PKCS8 envelope (the DER is not re-encoded, only wrapped).
const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const derLen = n => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
const tlv = (tag, body) => Uint8Array.from([tag, ...derLen(body.length), ...body]);

export function pemToDer(pem) {
  const m = String(pem).match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error('githubapp: private key is not a PEM');
  const der = Uint8Array.from(atob(m[2].replace(/\s/g, '')), c => c.charCodeAt(0));
  return { type: m[1], der };
}

export function pkcs1ToPkcs8(pkcs1) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return tlv(0x30, [0x02, 0x01, 0x00, ...algo, ...tlv(0x04, pkcs1)]);
}

export async function importPrivateKey(pem) {
  const { type, der } = pemToDer(pem);
  const pkcs8 = type === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** now is milliseconds. iat is 60 s back for clock drift; exp is 9 minutes ahead (GitHub allows at most 10). */
export async function signJwt({ appId, pem, now = Date.now() }) {
  const s = Math.floor(now / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ iat: s - 60, exp: s + 540, iss: String(appId) })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importPrivateKey(pem), enc.encode(head + '.' + body));
  return head + '.' + body + '.' + b64url(new Uint8Array(sig));
}
