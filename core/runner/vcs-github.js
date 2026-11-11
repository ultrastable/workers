// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Vcs port over the GitHub REST API (US-SPEC-11). Ports: fetch (injected), env (read at request time; the token is
// never stored on the object, logged, or included in an error). Only the six port methods exist: there is no merge.

const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0)));
const seg = p => String(p).split('/').map(encodeURIComponent).join('/');

export function createGithubVcs({ fetch, repo, base = 'main', env = {}, tokenEnv = 'VCS_TOKEN', apiBase = 'https://api.github.com' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) throw new Error('vcs: repo must be "owner/name"');
  const root = `${String(apiBase).replace(/\/+$/, '')}/repos/${repo}`;

  const scrub = text => {
    let s = String(text ?? '');
    const t = env[tokenEnv];
    if (t && t.length > 3) s = s.split(t).join('[redacted]');
    return s.slice(0, 300);
  };

  async function api(method, path, body, { accept = 'application/vnd.github+json', raw = false, okStatuses = [] } = {}) {
    const token = env[tokenEnv];
    if (!token) throw new Error(`vcs: token variable ${tokenEnv} is not set`);
    const init = {
      method,
      headers: { accept, authorization: 'Bearer ' + token, 'x-github-api-version': '2022-11-28', 'user-agent': 'ultrastable-runner' },
    };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(root + path, init); } catch (e) { throw new Error('vcs: network error: ' + scrub(e?.message)); }
    if (okStatuses.includes(res.status)) return { status: res.status, data: null };
    if (!res.ok) {
      let detail = ''; try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error(`vcs: ${method} ${path.split('?')[0]} -> http ${res.status} ${scrub(detail)}`);
    }
    return { status: res.status, data: raw ? await res.text() : await res.json() };
  }

  async function refSha(ref) {
    const r = await api('GET', `/git/ref/heads/${seg(ref)}`);
    return r.data.object.sha;
  }

  return {
    // Text of a file at a ref (default: the base branch), or null when it does not exist.
    async getFile(path, ref = base) {
      const r = await api('GET', `/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`, undefined, { okStatuses: [404] });
      if (r.status === 404) return null;
      if (Array.isArray(r.data) || r.data.type !== 'file') return null;
      return r.data.encoding === 'base64' ? b64decode(r.data.content) : String(r.data.content ?? '');
    },

    // Idempotent: an existing branch is returned, not an error, so a resumed run does not fail.
    async createBranch(name, from = base) {
      const sha = await refSha(from);
      const r = await api('POST', '/git/refs', { ref: `refs/heads/${name}`, sha }, { okStatuses: [422] });
      if (r.status === 422) return { name, sha: await refSha(name), existed: true };
      return { name, sha, existed: false };
    },

    // One commit with every file (whole-file replacements) via the git data API; the branch ref moves to it.
    async commitFiles({ branch, message, files }) {
      const parent = await refSha(branch);
      const parentCommit = await api('GET', `/git/commits/${parent}`);
      const tree = await api('POST', '/git/trees', {
        base_tree: parentCommit.data.tree.sha,
        tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      const commit = await api('POST', '/git/commits', { message, tree: tree.data.sha, parents: [parent] });
      await api('PATCH', `/git/refs/heads/${seg(branch)}`, { sha: commit.data.sha, force: false });
      return { sha: commit.data.sha };
    },

    // Always a draft. The port has no way to merge.
    async openDraftPr({ branch, title, body, base: target = base }) {
      const r = await api('POST', '/pulls', { title, head: branch, base: target, body, draft: true });
      return { number: r.data.number, url: r.data.html_url };
    },

    // Combines check runs and commit statuses: pending until something has reported and everything has finished.
    async getChecks(ref) {
      const runs = await api('GET', `/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`);
      const stat = await api('GET', `/commits/${encodeURIComponent(ref)}/status`);
      const checks = [];
      for (const c of runs.data.check_runs || []) {
        const done = c.status === 'completed';
        const ok = done && ['success', 'neutral', 'skipped'].includes(c.conclusion);
        checks.push({ name: c.name, state: !done ? 'pending' : ok ? 'success' : 'failure', detail: c.conclusion || c.status, url: c.html_url });
      }
      for (const s of stat.data.statuses || []) {
        checks.push({ name: s.context, state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure', detail: s.description || s.state, url: s.target_url });
      }
      let state = 'pending';
      if (checks.length && !checks.some(c => c.state === 'pending')) state = checks.some(c => c.state === 'failure') ? 'failure' : 'success';
      if (checks.some(c => c.state === 'failure')) state = 'failure';
      return { state, checks };
    },

    async getDiff(baseRef, head) {
      const r = await api('GET', `/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(head)}`, undefined, { accept: 'application/vnd.github.diff', raw: true });
      return r.data;
    },
  };
}
