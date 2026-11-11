#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Builds demos/dist/worker.mjs: one Worker module that serves demos/public under /demos/ (no asset-upload API, small enough for an inline upload, BG-27).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
const pub = new URL("./public/", import.meta.url), TYPES = { html: "text/html;charset=utf-8", js: "text/javascript;charset=utf-8", css: "text/css;charset=utf-8", json: "application/json" };
export function build() {
  const files = {}; for (const f of readdirSync(pub)) files[f] = readFileSync(new URL(f, pub), "utf8");
  return `const FILES=${JSON.stringify(files)};const TYPES=${JSON.stringify(TYPES)};
export default{fetch(req){const u=new URL(req.url);let p=u.pathname.replace(/^\\/demos\\/?/,"")||"index.html";
if(!(p in FILES))return new Response("Not found",{status:404});
return new Response(FILES[p],{headers:{"content-type":TYPES[p.split(".").pop()]||"text/plain","cache-control":"public,max-age=300","x-content-type-options":"nosniff"}})}};\n`;
}
if (import.meta.url === `file://${process.argv[1]}`) { mkdirSync(new URL("./dist/", import.meta.url), { recursive: true }); const s = build(); writeFileSync(new URL("./dist/worker.mjs", import.meta.url), s); console.log("demos/dist/worker.mjs", s.length, "bytes"); }
