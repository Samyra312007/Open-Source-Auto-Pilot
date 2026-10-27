import { getTokenType } from './config.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  constructor(message, { status = 0, code = 'GITHUB_ERROR', details, url, acceptedScopes } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.url = url;
    this.acceptedScopes = Array.isArray(acceptedScopes) ? acceptedScopes : (typeof acceptedScopes === 'string' ? acceptedScopes.split(',').map((scope) => scope.trim()).filter(Boolean) : []);
  }
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function issuePath(owner, repo, number) {
  return `${repoPath(owner, repo)}/issues/${number}`;
}

function pullPath(owner, repo, number) {
  return `${repoPath(owner, repo)}/pulls/${number}`;
}

function short(value, max = 1200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class GitHubClient {
  /**
   * @param {{ token: string, apiBaseUrl?: string, fetchImpl?: typeof fetch, userAgent?: string }} options
   */
  constructor({ token, apiBaseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, userAgent = 'dsh-oss-autopilot/0.1.0' }) {
    if (typeof token !== 'string' || token.length === 0) throw new Error('A GitHub token is required');
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
  }

  url(path) {
    if (!path.startsWith('/')) throw new Error(`GitHub API path must start with "/": ${path}`);
    return `${this.apiBaseUrl}${path}`;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, signal?: AbortSignal, allow404?: boolean, timeoutMs?: number }} [options]
   */
  async requestRaw(method, path, { body, signal, allow404 = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = this.url(path);
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'user-agent': this.userAgent,
      'x-github-api-version': API_VERSION,
    });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const init = { method, headers, signal: undefined };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal !== undefined) {
      init.signal = AbortSignal.timeout ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal;
    } else if (AbortSignal.timeout) {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new GitHubError(`GitHub request timed out or was cancelled: ${method} ${url}`, { code: 'GITHUB_ABORTED', url });
      }
      throw new GitHubError(`GitHub request failed: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'GITHUB_NETWORK_ERROR',
        url,
      });
    }

    const text = await response.text();
    let data = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      if (response.status === 404 && allow404) return { status: response.status, data: null, headers: response.headers, url };
      const apiMessage = data !== null && typeof data === 'object' && typeof data.message === 'string' ? data.message : short(data, 600);
      let hint = '';
      if (response.status === 401) hint = ' The token is invalid or expired.';
      else if (response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0') hint = ' The GitHub API rate limit is exhausted.';
        else hint = ' The token may lack the required scope or repository access.';
      } else if (response.status === 422) hint = ' GitHub rejected the request fields or the operation is not allowed.';
      const acceptedScopesHeader = response.headers.get('x-accepted-oauth-scopes');
      const acceptedScopes = acceptedScopesHeader ? acceptedScopesHeader.split(',').map((scope) => scope.trim()).filter(Boolean) : [];
      throw new GitHubError(`GitHub ${method} ${url} -> ${response.status}: ${apiMessage || response.statusText}.${hint}`.trim(), {
        status: response.status,
        code: apiMessage ? short(apiMessage, 120) : `HTTP_${response.status}`,
        details: data,
        url,
        acceptedScopes,
      });
    }

    return { status: response.status, data, headers: response.headers, url };
  }

  async request(method, path, options) {
    const { data } = await this.requestRaw(method, path, options);
    return data;
  }

  async paginate(path, { perPage = 100, maxPages = 5, signal } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.request('GET', `${path}${separator}per_page=${perPage}&page=${page}`, { signal });
      if (!Array.isArray(batch)) return items;
      items.push(...batch);
      if (batch.length < perPage) break;
    }
    return items;
  }

  async getAuthenticatedUser(signal) {
    return this.request('GET', '/user', { signal });
  }

  async getRateLimit(signal) {
    return this.request('GET', '/rate_limit', { signal });
  }

  async getRepo(owner, repo, signal) {
    return this.request('GET', repoPath(owner, repo), { signal });
  }

  async getIssue(owner, repo, number, signal) {
    return this.request('GET', issuePath(owner, repo, number), { signal });
  }

  async listIssueComments(owner, repo, number, { signal, maxPages = 5 } = {}) {
    return this.paginate(`${issuePath(owner, repo, number)}/comments`, { signal, maxPages });
  }

  async createIssueComment(owner, repo, number, body, signal) {
    return this.request('POST', `${issuePath(owner, repo, number)}/comments`, { body: { body }, signal });
  }

  async searchIssues(query, { perPage = 10, signal } = {}) {
    const params = new URLSearchParams({
      q: query,
      per_page: String(perPage),
      sort: 'updated',
      order: 'desc',
    });
    return this.request('GET', `/search/issues?${params.toString()}`, { signal });
  }

  async getPull(owner, repo, number, signal) {
    return this.request('GET', pullPath(owner, repo, number), { signal });
  }

  async listPullsByHead(owner, repo, head, signal) {
    const params = new URLSearchParams({ state: 'all', head, per_page: '10' });
    return this.request('GET', `${repoPath(owner, repo)}/pulls?${params.toString()}`, { signal });
  }

  async createPull(owner, repo, { title, head, base, body, draft = false }, signal) {
    return this.request('POST', `${repoPath(owner, repo)}/pulls`, {
      body: { title, head, base, body, draft },
      signal,
    });
  }

  async updatePull(owner, repo, number, patch, signal) {
    return this.request('PATCH', pullPath(owner, repo, number), { body: patch, signal });
  }

  async listReviews(owner, repo, number, { signal, maxPages = 3 } = {}) {
    return this.paginate(`${pullPath(owner, repo, number)}/reviews`, { signal, maxPages });
  }

  async listReviewComments(owner, repo, number, { signal, maxPages = 3 } = {}) {
    return this.paginate(`${pullPath(owner, repo, number)}/comments`, { signal, maxPages });
  }

  async getChecks(owner, repo, ref, signal) {
    const [runsPayload, statusPayload] = await Promise.all([
      this.request('GET', `${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`, { signal }),
      this.request('GET', `${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}/status`, { signal, allow404: true }),
    ]);
    const checks = [];
    const failingConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
    for (const run of runsPayload?.check_runs ?? []) {
      const failed = run.status === 'completed' && failingConclusions.has(run.conclusion);
      const pending = run.status !== 'completed';
      checks.push({
        name: run.name,
        source: 'check_run',
        status: pending ? 'pending' : failed ? 'failure' : 'success',
        conclusion: run.conclusion ?? null,
        url: run.html_url ?? null,
        summary: short(run.output?.summary ?? run.output?.title ?? '', 500) || null,
      });
    }
    for (const status of statusPayload?.statuses ?? []) {
      const failed = status.state === 'failure' || status.state === 'error';
      checks.push({
        name: status.context,
        source: 'status',
        status: failed ? 'failure' : status.state === 'pending' ? 'pending' : 'success',
        conclusion: status.state ?? null,
        url: status.target_url ?? null,
        summary: short(status.description ?? '', 500) || null,
      });
    }
    const failing = checks.filter((check) => check.status === 'failure');
    const pending = checks.filter((check) => check.status === 'pending');
    const passing = checks.filter((check) => check.status === 'success');
    return {
      overall: failing.length > 0 ? 'failure' : pending.length > 0 ? 'pending' : checks.length > 0 ? 'success' : 'none',
      total: checks.length,
      failing,
      pending,
      passingCount: passing.length,
      checks,
      headSha: ref,
    };
  }

  async mergePull(owner, repo, number, { method = 'squash', sha, commitTitle } = {}, signal) {
    return this.request('PUT', `${pullPath(owner, repo, number)}/merge`, {
      body: {
        merge_method: method,
        ...(sha === undefined ? {} : { sha }),
        ...(commitTitle === undefined ? {} : { commit_title: commitTitle }),
      },
      signal,
    });
  }

  async updateBranch(owner, repo, number, expectedHeadSha, signal) {
    return this.request('PUT', `${pullPath(owner, repo, number)}/update-branch`, {
      body: expectedHeadSha === undefined ? {} : { expected_head_sha: expectedHeadSha },
      signal,
    });
  }

  async createFork(owner, repo, signal) {
    return this.request('POST', `${repoPath(owner, repo)}/forks`, { body: { default_branch_only: false }, signal });
  }

  async getFork(login, repo, signal) {
    return this.request('GET', repoPath(login, repo), { signal, allow404: true });
  }

  async addLabels(owner, repo, number, labels, signal) {
    const normalized = [...new Set((Array.isArray(labels) ? labels : []).map((label) => String(label).trim()).filter(Boolean))];
    if (normalized.length === 0) return [];
    return this.request('POST', `${issuePath(owner, repo, number)}/labels`, {
      body: { labels: normalized },
      signal,
    });
  }

  getTokenType() {
    return getTokenType(this.token);
  }

  async getTokenScopes(signal) {
    const response = await this.requestRaw('GET', '/user', { signal });
    const scopesHeader = response.headers.get('x-oauth-scopes');
    const acceptedHeader = response.headers.get('x-accepted-oauth-scopes');
    const scopes = scopesHeader ? scopesHeader.split(',').map((scope) => scope.trim()).filter(Boolean) : [];
    const acceptedScopes = acceptedHeader ? acceptedHeader.split(',').map((scope) => scope.trim()).filter(Boolean) : [];
    return {
      tokenType: getTokenType(this.token),
      scopes,
      acceptedScopes,
      user: response.data ?? null,
    };
  }
}

export function checksFailingNames(checks) {
  return (checks?.failing ?? []).map((check) => check.name);
}

export { repoPath, issuePath, pullPath, getTokenType };
