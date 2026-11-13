// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// GAP-LOOP-GITHUB (#183): a downstream loop's issues, PRs and merges go through the Worker and the GitHub App, not a workflow's
// GITHUB_TOKEN. `tokenProvider` is createInstallationTokenProvider(...) (short-lived installation tokens). Ports only: injected fetch.
// openIssue is idempotent (a hidden marker in the body is searched first); openDraftPr is always a DRAFT; mergeHost() is a codeloop
// host ({ name, merge }), so it is reached only through codeloop's trust-ladder gate: this module never decides to merge.
const MARK = k => `<!-- ultrastable-key:${k} -->`;

export function createDownstreamGithub({ fetch, repo, tokenProvider, base = 'main', apiBase = 'https://api.github.com' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) throw new Error('downstream: repo must be "owner/name"');
  if (typeof tokenProvider !== 'function') throw new Error('downstream: a GitHub App tokenProvider is required (no GITHUB_TOKEN path)');
  const origin = String(apiBase).replace(/\/+$/, '');
  const root = `${origin}/repos/${repo}`;

  async function api(method, url, body) {
    const token = await tokenProvider();
    if (!token) throw new Error('downstream: token provider returned no token');
    const scrub = s => String(s ?? '').split(token).join('[redacted]').slice(0, 200);
    const init = { method, headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'x-github-api-version': '2022-11-28', 'user-agent': 'ultrastable-loop' } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, init); } catch (e) { throw new Error('downstream: network error: ' + scrub(e?.message)); }
    const text = await res.text();
    if (!res.ok) throw new Error(`downstream: ${method} ${url.replace(origin, '').split('?')[0]} -> http ${res.status} ${scrub(text)}`);
    return text ? JSON.parse(text) : {};
  }

  return {
    /** Open one issue per `key` (e.g. a brief id): a repeat returns the existing issue instead of a duplicate. */
    async openIssue({ key, title, body = '', labels = [] }) {
      if (!key || !title) throw new Error('downstream: openIssue needs key and title');
      const q = encodeURIComponent(`repo:${repo} is:issue "ultrastable-key:${key}"`);
      const found = await api('GET', `${origin}/search/issues?q=${q}&per_page=5`);
      const hit = (found.items || []).find(i => String(i.body || '').includes(MARK(key)));
      if (hit) return { number: hit.number, url: hit.html_url, created: false };
      const r = await api('POST', `${root}/issues`, { title, body: `${body}\n\n${MARK(key)}`, labels });
      return { number: r.number, url: r.html_url, created: true };
    },
    /** Always a draft; merging is a separate, gated step. */
    async openDraftPr({ branch, title, body = '', base: target = base }) {
      const r = await api('POST', `${root}/pulls`, { title, head: branch, base: target, body, draft: true });
      return { number: r.number, url: r.html_url };
    },
    /** A codeloop merge host: codeloop calls this only after its trust-ladder gate allowed the merge. */
    mergeHost() {
      return {
        name: 'github-app',
        merge: async ({ pr, method = 'squash' }) => {
          try {
            const r = await api('PUT', `${root}/pulls/${pr}/merge`, { merge_method: method });
            return r.merged ? { merged: true } : { merged: false, reason: String(r.message || 'not_merged').slice(0, 200) };
          } catch (e) { return { merged: false, reason: String(e.message).slice(0, 200) }; }
        },
      };
    },
  };
}
