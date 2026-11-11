// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Adapter for an OpenAI-compatible chat completions API. Uses only the injected fetch.
export const kind = 'openai';

export function buildRequest(provider, model, req, key) {
  const body = { model: model.id, messages: req.messages || [], max_tokens: req.max_tokens };
  if (req.tools) body.tools = req.tools;
  if (req.json) body.response_format = { type: 'json_object' };
  return {
    url: String(provider.base_url).replace(/\/+$/, '') + '/chat/completions',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    },
  };
}

export function parseResponse(json) {
  const msg = json?.choices?.[0]?.message || {};
  return {
    text: msg.content ?? '',
    tool_calls: msg.tool_calls || [],
    tokens_in: Number(json?.usage?.prompt_tokens) || 0,
    tokens_out: Number(json?.usage?.completion_tokens) || 0,
  };
}
