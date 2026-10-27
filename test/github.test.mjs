import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError } from '../lib/github.js';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('GitHubClient sends auth, API version, and parses JSON', async () => {
  const calls = [];
  const client = new GitHubClient({
    token: 'secret-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json({ login: 'octocat', id: 1 });
    },
  });
  const user = await client.getAuthenticatedUser();
  assert.equal(user.login, 'octocat');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer secret-token');
  assert.equal(calls[0].init.headers.get('x-github-api-version'), '2022-11-28');
});

test('GitHubClient paginates and stops on a short page', async () => {
  let page = 0;
  const client = new GitHubClient({
    token: 't',
    fetchImpl: async (url) => {
      page += 1;
      assert.match(url, new RegExp(`page=${page}`));
      if (page === 1) return json([{ id: 1 }, { id: 2 }]);
      return json([{ id: 3 }]);
    },
  });
  const items = await client.paginate('/repos/a/b/issues', { perPage: 2, maxPages: 3 });
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
});

test('GitHubClient allow404 returns null and errors carry status', async () => {
  const client = new GitHubClient({
    token: 't',
    fetchImpl: async (url) => {
      if (url.endsWith('/repos/me/repo')) return json({ message: 'Not Found' }, 404);
      return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
    },
  });
  assert.equal(await client.getFork('me', 'repo'), null);
  await assert.rejects(() => client.getRepo('a', 'b'), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 403);
    assert.match(error.message, /rate limit/i);
    return true;
  });
});

test('getChecks merges check runs and legacy statuses', async () => {
  const client = new GitHubClient({
    token: 't',
    fetchImpl: async (url) => {
      if (url.includes('/check-runs')) {
        return json({
          total_count: 2,
          check_runs: [
            { name: 'tests', status: 'completed', conclusion: 'failure', html_url: 'https://ci/1', output: { summary: '2 failed' } },
            { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://ci/2' },
          ],
        });
      }
      if (url.endsWith('/status')) {
        return json({ state: 'pending', statuses: [{ context: 'deploy', state: 'pending', target_url: 'https://ci/3' }] });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const checks = await client.getChecks('a', 'b', 'abc123');
  assert.equal(checks.overall, 'failure');
  assert.equal(checks.total, 3);
  assert.equal(checks.failing[0].name, 'tests');
  assert.equal(checks.pending[0].name, 'deploy');
});

test('mergePull sends the expected method and guard SHA', async () => {
  let body;
  const client = new GitHubClient({
    token: 't',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return json({ merged: true, sha: 'deadbeef' });
    },
  });
  const result = await client.mergePull('a', 'b', 4, { method: 'rebase', sha: 'head-sha', commitTitle: 'Fix it (#4)' });
  assert.equal(result.merged, true);
  assert.deepEqual(body, { merge_method: 'rebase', sha: 'head-sha', commit_title: 'Fix it (#4)' });
});
