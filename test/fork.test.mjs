import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { normalizeConfig } from '../lib/config.js';
import { ensureStateRoot } from '../lib/state.js';
import { runGit } from '../lib/git.js';
import { claimIssue, startWork, submitPullRequest } from '../lib/workflow.js';

class FakeClient {
  constructor(cloneUrl) {
    this.cloneUrl = cloneUrl;
    this.repo = { full_name: 'acme/widget', default_branch: 'main', clone_url: cloneUrl, permissions: { push: false, admin: false, maintain: false } };
    this.issue = { number: 12, title: 'Fix the widget crash', body: 'crash', state: 'open', html_url: 'https://github.com/acme/widget/issues/12', labels: [{ name: 'bug' }], assignees: [] };
    this.assigned = false;
    this.comments = [];
    this.pull = null;
    this.commentSeq = 0;
  }
  async getAuthenticatedUser() { return { login: 'octocat', id: 123, name: 'Octo Cat' }; }
  async getRepo() { return this.repo; }
  async requestRaw() { return { data: { login: 'octocat' }, headers: new Headers({ 'x-oauth-scopes': 'repo' }) }; }
  async getRateLimit() { return { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } }; }
  async getIssue() { return { ...this.issue, assignees: this.assigned ? [{ login: 'octocat' }] : [] }; }
  async listIssueComments() { return this.comments; }
  async createIssueComment(_o, _r, _n, body) {
    this.commentSeq += 1;
    const comment = { body, user: { login: 'octocat' }, author_association: 'NONE', created_at: new Date().toISOString(), html_url: `https://github.com/acme/widget/issues/12#issuecomment-${this.commentSeq}` };
    this.comments.push(comment);
    return comment;
  }
  async searchIssues() { return { total_count: 1, items: [{ number: 12, title: 'Fix the widget crash', html_url: 'https://github.com/acme/widget/issues/12', repository_url: 'https://api.github.com/repos/acme/widget', labels: [{ name: 'bug' }], assignees: [], comments: 0, state: 'open', locked: false, updated_at: new Date().toISOString(), body: 'crash' }] }; }
  async getPull() { if (!this.pull) throw new Error('no pull'); return this.pull; }
  async createPull(_o, _r, input) {
    this.pull = { number: 7, html_url: 'https://github.com/acme/widget/pull/7', state: 'open', draft: Boolean(input.draft), title: input.title, body: input.body, head: { ref: input.head, sha: null }, base: { ref: input.base }, mergeable: true, mergeable_state: 'clean', merged: false, merged_at: null, closed_at: null, changed_files: 1, additions: 1, deletions: 0, created_at: new Date().toISOString() };
    return this.pull;
  }
  async updatePull(_o, _r, _n, patch) { this.pull = { ...this.pull, ...patch }; return this.pull; }
  async listPullsByHead() { return this.pull ? [this.pull] : []; }
  async listReviews() { return []; }
  async listReviewComments() { return []; }
  async getChecks() { return { overall: 'success', total: 1, passingCount: 1, failing: [], pending: [], checks: [], headSha: 'sha' }; }
  async mergePull() { this.pull = { ...this.pull, merged: true, state: 'closed', merged_at: new Date().toISOString() }; return { merged: true, sha: 'merge-sha' }; }
  async updateBranch() { return { message: 'updated' }; }
  async getFork() { return null; }
  async createFork() { return { full_name: 'octocat/widget', clone_url: this.cloneUrl }; }
  async addLabels() { return []; }
}

async function seedRepository(root) {
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  await runGit(root, ['init', '--bare', bare]);
  await runGit(root, ['init', seed]);
  await writeFile(path.join(seed, 'README.md'), '# Widget\n', 'utf8');
  await runGit(seed, ['add', '.']);
  await runGit(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-m', 'initial']);
  await runGit(seed, ['branch', '-M', 'main']);
  await runGit(seed, ['remote', 'add', 'origin', bare]);
  await runGit(seed, ['push', 'origin', 'main']);
  await runGit(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return bare;
}

test('fork end-to-end: claim, start, PR via fork', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-fork-e2e-'));
  try {
    const bare = await seedRepository(root);
    const client = new FakeClient(bare);
    const schedule = { created: [], deleted: [], seq: 0, async create(s, r) { this.seq += 1; const rec = { id: `sched-${this.seq}`, sessionId: s, ...r }; this.created.push(rec); return rec; }, async delete(r) { this.deleted.push(r); return { id: r.id, deleted: true }; } };
    const stateRoot = path.join(root, 'state');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await ensureStateRoot(stateRoot);
    const deps = {
      client,
      config: normalizeConfig({ pollSeconds: 60, claimPollSeconds: 60, claimFollowUpHours: 1, maxClaimFollowUps: 2, autoMerge: true, fork: true, requireAssignment: true, dryRun: false }),
      stateRoot,
      tokenInfo: { token: 'test-token', source: 'test' },
      token: 'test-token',
      workspace,
      agent: { id: 'session-test' },
      schedule,
      signal: new AbortController().signal,
      login: 'octocat',
      user: { login: 'octocat', id: 123 },
      tokenHelp: 'set a token',
      setWorkingDirectory: async () => {},
    };

    await claimIssue(deps, { repo: 'acme/widget', issue_number: 12, action: 'request', acknowledge_public_post: true });
    client.assigned = true;
    await claimIssue(deps, { repo: 'acme/widget', issue_number: 12, action: 'status' });
    const started = await startWork(deps, { repo: 'acme/widget', issue_number: 12 });
    assert.equal(started.ok, true);
    await writeFile(path.join(started.repo_path, 'fix.txt'), 'fixed\n', 'utf8');
    const submitted = await submitPullRequest(deps, { run_id: 'acme/widget#12', title: 'Fix widget crash', body: '## Summary\nFix the crash.\n\n## Testing\n- node --test passed', commit_message: 'Fix widget crash' });
    assert.equal(submitted.created, true);
    assert.equal(submitted.push.remote, 'fork');
    assert.equal(submitted.push.fork, 'octocat/widget');
    assert.match(client.pull.head.ref, /octocat:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});