// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The code-host port of core/ghcost over the REST API (US-SPEC-24). Every call is a bounded retry (US-24-R53): at most
// `maxAttempts` tries, then the error is the caller's finding. The token is read from env by NAME at request time and is
// never stored, returned or put in an error. org and repository names come from configuration.
export function githubPort({ fetch, env = {}, org, tokenEnv = 'VCS_TOKEN', apiBase = 'https://api.github.com', maxAttempts = 2, jobsVariable = 'DISABLED_JOBS' }) {
  if (typeof fetch !== 'function') throw new Error('ghcost: a fetch port is required');
  if (!/^[\w.-]+$/.test(String(org || ''))) throw new Error('ghcost: config.ghcost.org is required');
  const call = async (method, path, body, { allow404 = false } = {}) => {
    const token = env[tokenEnv]; if (!token) throw new Error(`ghcost: token variable ${tokenEnv} is not set`);
    let last;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      try {
        const res = await fetch(apiBase + path, { method, headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'content-type': 'application/json', 'user-agent': 'ultrastable-ghcost' }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (res.status === 404 && allow404) return null;
        if (res.status >= 500) { last = new Error(`ghcost: ${method} ${path} -> http ${res.status}`); continue; }
        if (!res.ok) throw Object.assign(new Error(`ghcost: ${method} ${path} -> http ${res.status}`), { final: true });
        return res.status === 204 ? {} : await res.json();
      } catch (e) { if (e.final) throw e; last = e; }
    }
    throw last;
  };
  const split = wf => { const [file, job] = String(wf).split(':'); return { file, job }; };
  const disabledJobs = async repo => {
    const v = await call('GET', `/repos/${org}/${repo}/actions/variables/${jobsVariable}`, undefined, { allow404: true });
    return { exists: !!v, list: String(v?.value || '').split(',').map(s => s.trim()).filter(Boolean) };
  };
  return {
    name: 'github',
    usage: month => { const [y, m] = String(month).split('-'); return call('GET', `/organizations/${org}/settings/billing/usage?year=${Number(y)}&month=${Number(m)}`); },
    budgets: () => call('GET', `/organizations/${org}/settings/billing/budgets`),
    /** enabled | disabled, read back from the platform. A job entry (`file.yml:job`) lives in a repository variable the workflow honours. */
    async workflowState({ repo, workflow }) {
      const { file, job } = split(workflow);
      if (job) return (await disabledJobs(repo)).list.includes(`${file}:${job}`) ? 'disabled' : 'enabled';
      const w = await call('GET', `/repos/${org}/${repo}/actions/workflows/${file}`, undefined, { allow404: true });
      if (!w) return 'absent';
      return w.state === 'active' ? 'enabled' : 'disabled';
    },
    async setWorkflow({ repo, workflow, enabled }) {
      const { file, job } = split(workflow);
      if (!job) return call('PUT', `/repos/${org}/${repo}/actions/workflows/${file}/${enabled ? 'enable' : 'disable'}`);
      const cur = await disabledJobs(repo), key = `${file}:${job}`;
      const list = enabled ? cur.list.filter(x => x !== key) : [...new Set([...cur.list, key])];
      const value = list.join(',');
      return cur.exists ? call('PATCH', `/repos/${org}/${repo}/actions/variables/${jobsVariable}`, { name: jobsVariable, value })
        : call('POST', `/repos/${org}/${repo}/actions/variables`, { name: jobsVariable, value });
    },
    listWorkflows: async repo => ((await call('GET', `/repos/${org}/${repo}/actions/workflows?per_page=100`)).workflows || []).map(w => ({ file: String(w.path || '').split('/').pop(), state: w.state })),
    listRuns: async repo => ((await call('GET', `/repos/${org}/${repo}/actions/runs?per_page=100`)).workflow_runs || []).map(r => ({ workflow: String(r.path || '').split('/').pop().split('@')[0], at: r.run_started_at || r.created_at, runner: (r.labels || []).join('+') || 'hosted' })),
    repo: repo => call('GET', `/repos/${org}/${repo}`),
    pages: repo => call('GET', `/repos/${org}/${repo}/pages`, undefined, { allow404: true }),
    rulesets: repo => call('GET', `/repos/${org}/${repo}/rulesets`),
    forkApproval: () => call('GET', `/orgs/${org}/actions/permissions/fork-pr-contributor-approval`),
    releases: async repo => (await call('GET', `/repos/${org}/${repo}/releases?per_page=30`)) || [],
  };
}
