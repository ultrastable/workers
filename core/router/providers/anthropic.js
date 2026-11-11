// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Adapter for an Anthropic-style messages API. Uses only the injected fetch.
export const kind = 'anthropic';

export function buildRequest(provider, model, req, key) {
  const msgs = req.messages || [];
  const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const body = { model: model.id, max_tokens: req.max_tokens, messages: msgs.filter(m => m.role !== 'system') };
  if (system) body.system = system;
  if (req.tools) body.tools = req.tools;
  return {
    url: String(provider.base_url).replace(/\/+$/, '') + '/messages',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': provider.api_version || '2023-06-01' },
      body: JSON.stringify(body),
    },
  };
}

export function parseResponse(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
    tool_calls: blocks.filter(b => b.type === 'tool_use'),
    tokens_in: Number(json?.usage?.input_tokens) || 0,
    tokens_out: Number(json?.usage?.output_tokens) || 0,
  };
}
