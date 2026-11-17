// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Model routes for the red team, shaped as core/modelport endpoints: async ({ model, messages, max_tokens }) => { text, tokens_in, tokens_out }.
//  - GitHub Models through an Actions run's own token (permission `models: read`; nothing a person mints), or any token with that scope.
//  - Workers AI through an `AI` binding.
// `redTeamModel` turns a modelport alias into the `model({prompt})` function core/ignorance takes. Its output is parsed defensively and is
// still validated and tagged unverified by sanitizeModel; a failing route degrades to the rule-based red team, never to silence.
const est = s => Math.ceil(String(s || '').length / 4);

export const GITHUB_MODELS_URLS = ['https://models.github.ai/inference/chat/completions', 'https://models.inference.ai.azure.com/chat/completions'];
// Tries each URL in turn: a route that answers without a JSON completion (seen: 200 "OK") is a failed route, not an answer.
export const githubModelsEndpoint = ({ fetch: f = globalThis.fetch, token, url, urls = url ? [url] : GITHUB_MODELS_URLS } = {}) => async ({ model, messages, max_tokens = 900 }) => {
  if (!token) throw new Error('no token for GitHub Models');
  const fails = [];
  for (const u of urls) {
    const name = u.includes('azure') ? String(model).replace(/^[^/]+\//, '') : model;
    const r = await f(u, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ model: name, messages, max_tokens, temperature: 0.4 }) });
    const raw = await r.text(); let j = null;
    try { j = JSON.parse(raw); } catch { /* not JSON: recorded below */ }
    const text = j?.choices?.[0]?.message?.content;
    if (r.ok && typeof text === 'string') return { text, tokens_in: j.usage?.prompt_tokens ?? est(JSON.stringify(messages)), tokens_out: j.usage?.completion_tokens ?? est(text) };
    fails.push(`${new URL(u).host} HTTP ${r.status} ${raw.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
  throw new Error(`GitHub Models failed: ${fails.join('; ')}`);
};

export const workersAiEndpoint = ({ ai }) => async ({ model, messages, max_tokens = 900 }) => {
  if (!ai) throw new Error('no AI binding');
  const j = await ai.run(model, { messages, max_tokens }), text = typeof j === 'string' ? j : j?.response;
  if (typeof text !== 'string') throw new Error('Workers AI returned no text');
  return { text, tokens_in: est(JSON.stringify(messages)), tokens_out: est(text) };
};

export const parseJsonObject = text => {
  const t = String(text || ''), i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('no JSON object in model output');
  return JSON.parse(t.slice(i, j + 1));
};

// port: a core/modelport instance (complete(alias, {messages})). The family comes from the alias, so the independence check is real.
export const redTeamModel = (port, alias) => async ({ prompt }) => {
  const r = await port.complete(alias, { messages: [{ role: 'system', content: 'You are a careful adversarial reviewer. Reply with one JSON object only.' }, { role: 'user', content: prompt }], max_tokens: 900 });
  if (!r.ok) throw new Error(r.error);
  const o = parseJsonObject(r.text);
  return { family: r.family, findings: Array.isArray(o.findings) ? o.findings : [] };
};
