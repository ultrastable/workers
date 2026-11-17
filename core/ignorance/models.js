// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Model routes for the red team, shaped as core/modelport endpoints: async ({ model, messages, max_tokens }) => { text, tokens_in, tokens_out }.
//  - GitHub Models through an Actions run's own token (permission `models: read`; nothing a person mints), or any token with that scope.
//  - Workers AI through an `AI` binding.
// `redTeamModel` turns a modelport alias into the `model({prompt})` function core/ignorance takes. Its output is parsed defensively and is
// still validated and tagged unverified by sanitizeModel; a failing route degrades to the rule-based red team, never to silence.
const est = s => Math.ceil(String(s || '').length / 4);

export const githubModelsEndpoint = ({ fetch: f = globalThis.fetch, token, url = 'https://models.github.ai/inference/chat/completions' } = {}) => async ({ model, messages, max_tokens = 900 }) => {
  if (!token) throw new Error('no token for GitHub Models');
  const r = await f(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ model, messages, max_tokens, temperature: 0.4 }) });
  if (!r.ok) throw new Error(`GitHub Models HTTP ${r.status}`);
  const j = await r.json(), text = j?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('GitHub Models returned no text');
  return { text, tokens_in: j.usage?.prompt_tokens ?? est(JSON.stringify(messages)), tokens_out: j.usage?.completion_tokens ?? est(text) };
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
