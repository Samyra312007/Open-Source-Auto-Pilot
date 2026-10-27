import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeDisclosure,
} from '../lib/config.js';
import {
  appendEvent,
  createRun,
  ensureStateRoot,
  getRun,
  listRuns,
  makeRunId,
  mutateState,
  parseRunId,
  readState,
  saveRun,
} from '../lib/state.js';
import {
  blockedFileName,
  claimState,
  ensureIssueLink,
  isValidBranchName,
  nextActionForNoPr,
  nextActionForPr,
  scanDiff,
  slugify,
  summarizeReviews,
} from '../lib/workflow.js';

test('normalizeConfig applies defaults and validates values', () => {
  const config = normalizeConfig({});
  assert.equal(config.pollSeconds, DEFAULT_CONFIG.pollSeconds);
  assert.equal(config.autoMerge, true);
  assert.match(config.disclosure, /AI assistance/);
  assert.throws(() => normalizeConfig({ pollSeconds: 1 }), /pollSeconds/);
  assert.throws(() => normalizeConfig({ mergeMethod: 'octopus' }), /mergeMethod/);
  assert.throws(() => normalizeConfig({ apiBaseUrl: 'file:///tmp/api' }), /http/);
});

test('disclosure always mentions AI and the operator', () => {
  assert.match(normalizeDisclosure('Prepared by @{login}.'), /AI-assisted/);
  assert.match(normalizeDisclosure('AI-assisted by {@login}.'), /@\{login\}/);
});

test('state is durable, versioned, and serialized per root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-state-'));
  try {
    await ensureStateRoot(root);
    const initial = await readState(root);
    assert.equal(initial.version, 1);
    assert.equal(Object.keys(initial.runs).length, 0);

    const run = createRun({ owner: 'acme', repo: 'widget', issueNumber: 12, issueTitle: 'Fix it', workspace: root });
    assert.equal(run.id, 'acme/widget#12');
    appendEvent(run, 'test', 'first');
    await saveRun(root, run);
    assert.equal((await getRun(root, run.id)).issueTitle, 'Fix it');

    await Promise.all(Array.from({ length: 8 }, (_, index) => mutateState(root, (state) => {
      state.runs[`r${index}`] = { id: `r${index}`, updatedAt: String(index) };
    })));
    const state = await readState(root);
    assert.equal(Object.keys(state.runs).length, 9);
    assert.equal((await listRuns(root)).length, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run ids round-trip and reject unsafe values', () => {
  assert.equal(makeRunId('owner', 'repo', 7), 'owner/repo#7');
  assert.deepEqual(parseRunId('owner/repo#7'), { owner: 'owner', repo: 'repo', issueNumber: 7 });
  assert.throws(() => parseRunId('owner/repo'), /run_id/);
  assert.throws(() => parseRunId('../repo#1'), /run_id/);
});

test('issue link, branch and slug helpers are defensive', () => {
  assert.match(ensureIssueLink('A change.', 4), /Closes #4/);
  assert.equal(ensureIssueLink('Fixes #4', 4), 'Fixes #4');
  assert.equal(isValidBranchName('oss/issue-12-fix'), true);
  assert.equal(isValidBranchName('-bad'), false);
  assert.equal(isValidBranchName('bad..branch'), false);
  assert.equal(slugify('Fix: crash on startup!'), 'fix-crash-on-startup');
  assert.equal(slugify('修复'), 'fix');
});

test('secret and credential-file scanning catches high-confidence leaks', () => {
  assert.deepEqual(scanDiff('const x = 1;'), []);
  assert.deepEqual(scanDiff('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private key block']);
  assert.deepEqual(scanDiff('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['GitHub token']);
  assert.equal(blockedFileName('.env'), 'environment file');
  assert.equal(blockedFileName('.env.example'), null);
  assert.equal(blockedFileName('node_modules/pkg/index.js'), 'generated or dependency directory');
  assert.equal(blockedFileName('certs/server.pem'), 'private key or certificate store');
  assert.equal(blockedFileName('src/index.js'), null);
});

test('claim state counts markers and respects cooldown and maximum', () => {
  const config = normalizeConfig({ claimFollowUpHours: 2, maxClaimFollowUps: 1 });
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const comments = [{
    body: 'hello <!-- dsh-oss-autopilot:claim -->',
    user: { login: 'octocat' },
    created_at: old,
    html_url: 'https://example.test/1',
  }];
  const state = claimState(comments, 'octocat', config, false);
  assert.equal(state.requested, true);
  assert.equal(state.follow_ups, 0);
  assert.equal(state.follow_up_due, true);
  const followUp = claimState([
    ...comments,
    { body: 'ping <!-- dsh-oss-autopilot:claim-followup -->', user: { login: 'octocat' }, created_at: new Date().toISOString() },
  ], 'octocat', config, false);
  assert.equal(followUp.follow_ups, 1);
  assert.equal(followUp.follow_up_due, false);
  assert.equal(claimState(comments, 'octocat', config, true).follow_up_due, false);
});

test('review summary uses latest decisive review per user', () => {
  const reviews = [
    { state: 'CHANGES_REQUESTED', user: { login: 'a' }, submitted_at: '2026-01-01T00:00:00Z' },
    { state: 'APPROVED', user: { login: 'a' }, submitted_at: '2026-01-02T00:00:00Z' },
    { state: 'APPROVED', user: { login: 'b' }, submitted_at: '2026-01-01T00:00:00Z' },
  ];
  const summary = summarizeReviews(reviews);
  assert.equal(summary.decision, 'approved');
  assert.deepEqual(summary.approvals.sort(), ['a', 'b']);
});

test('PR next-action never merges on a blocked or unknown state', () => {
  const config = normalizeConfig({ autoMerge: true });
  const repo = { permissions: { push: true } };
  const checksGreen = { overall: 'success', failing: [], pending: [] };
  const clean = { merged: false, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean' };
  assert.equal(nextActionForPr({ pr: clean, checks: checksGreen, review: { decision: 'approved' }, repo, config }).kind, 'merge');
  assert.equal(nextActionForPr({ pr: { ...clean, mergeable_state: 'unknown' }, checks: checksGreen, review: { decision: 'approved' }, repo, config }).kind, 'wait');
  assert.equal(nextActionForPr({ pr: { ...clean, mergeable_state: 'blocked' }, checks: checksGreen, review: { decision: 'none' }, repo, config }).kind, 'wait_for_review');
  assert.equal(nextActionForPr({ pr: clean, checks: { overall: 'failure', failing: [], pending: [] }, review: { decision: 'approved' }, repo, config }).kind, 'fix_ci');
  assert.equal(nextActionForPr({ pr: { ...clean, draft: true }, checks: checksGreen, review: { decision: 'approved' }, repo, config }).kind, 'mark_ready');
});

test('no-PR next-action distinguishes assignment, go-ahead, and follow-up', () => {
  const claim = { follow_up_due: false };
  assert.equal(nextActionForNoPr({ assignment: 'assigned_to_operator', issueClosed: false, claim, maintainer: {} }).kind, 'start_work');
  assert.equal(nextActionForNoPr({ assignment: 'assigned_to_other', issueClosed: false, claim, maintainer: {} }).kind, 'done');
  assert.equal(nextActionForNoPr({ assignment: 'unassigned', issueClosed: false, claim: { follow_up_due: true }, maintainer: {} }).kind, 'follow_up');
  assert.equal(nextActionForNoPr({ assignment: 'unassigned', issueClosed: false, claim, maintainer: { possible_go_ahead: true } }).kind, 'start_work');
});
