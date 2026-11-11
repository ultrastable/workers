// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Local demo of the guided console on an in-memory database. Access key: demo. Run: npm run demo
import http from 'node:http';
import { makeDb } from '../../../core/test/d1shim.js';
import { handleConsole } from '../../../core/src/console.js';
const db = makeDb();
db.raw.exec(`INSERT INTO items (id,title,owner_role,done_check,status,priority) VALUES
 ('A','Build the booking page','staff','x','ready',10),('B','Write the booking rules specification','product-manager','x','claimed',20),
 ('D1','Set up the landing page','staff','x','done',5),('D2','Write the charter','portfolio-manager','x','done',5);
 INSERT INTO items (id,title,owner_role,done_check,status,blocker) VALUES ('C','Take payments for deposits','staff','x','blocked','Needs your decision on spending');
 INSERT INTO gate_cards (id,what,why_gated,default_in_effect,closing_probe) VALUES ('G1','Approve spending up to 50 USD a month on running costs','money','spending stays at zero and only free tools are used','manual'),('G2','Add your cloud account key so the system can set itself up','only you hold it','the system runs as a dry run and changes nothing','env:CLOUDFLARE_API_TOKEN');
 INSERT INTO tick_runs (started_at,finished_at,steps_completed,steps_total,report) VALUES (datetime('now'),datetime('now'),11,11,'ok');`);
const port = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' });
  const out = (await handleConsole(r, { DB: db, CONSOLE_TOKEN: 'demo' }, { org: 'demo' })) || new Response('not found', { status: 404 });
  res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log(`console demo: http://localhost:${port}/console  (key: demo)`));
