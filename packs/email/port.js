// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The channel port. emailChannel is the interface a mail provider adapter implements:
//   deliver({ to, subject, text, html, headers }) -> { providerId }
// guardPorts() adapts one emailChannel to the ports core/packs' guard delivers through (one per declared channel).
export function assertEmailChannel(ch) {
  if (!ch || typeof ch.deliver !== 'function') throw new Error('emailChannel must implement deliver({ to, subject, text, html, headers })');
  return ch;
}

export function guardPorts({ channel, senderLine }) {
  assertEmailChannel(channel);
  if (!String(senderLine || '').trim()) throw new Error('senderLine is required (honest sender identification)');
  const port = {
    senderId: String(senderLine),     // the guard refuses any message that does not carry it
    maxLength: 200000,
    async send({ recipient, content }) {
      const m = JSON.parse(content);
      const r = await channel.deliver({ to: recipient, subject: m.subject, text: m.text, html: m.html, headers: m.headers || {} });
      return { id: r && r.providerId != null ? String(r.providerId) : null };
    },
  };
  return { email: port, email_confirm: port };
}
