// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Adapter for the Workers AI binding. No key and no payment: the binding is the credential. The router injects the
// binding as the port `ai` (an object with run(model, input)). Model names come from config only.
export const kind = 'workers_ai';
export const keyless = true;

const estimate = s => Math.ceil(String(s ?? '').length / 4);

export async function invoke(ai, provider, model, req) {
  const run = typeof ai === 'function' ? ai : ai?.run?.bind(ai);
  if (!run) throw new Error('workers ai binding missing');
  const messages = req.messages || [];
  const input = { messages, max_tokens: req.max_tokens };
  if (req.json) input.response_format = { type: 'json_object' };
  const json = await run(model.id, input);
  const choice = json?.choices?.[0]?.message;
  let text = json?.response ?? choice?.content ?? '';
  if (text && typeof text === 'object') text = JSON.stringify(text); // json mode may return a parsed object
  text = String(text ?? '');
  const u = json?.usage || {};
  const tokens_in = Number(u.prompt_tokens) || estimate(messages.map(m => m.content).join('\n'));
  const tokens_out = Number(u.completion_tokens) || estimate(text);
  return { text, tool_calls: json?.tool_calls || choice?.tool_calls || [], tokens_in, tokens_out };
}
