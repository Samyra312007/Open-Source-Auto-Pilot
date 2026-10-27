import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  checkoutBranch,
  cloneRepo,
  commit,
  commitsAhead,
  currentBranch,
  gitVersion,
  push,
  remoteUrl,
  runGit,
  stageAll,
  stagedFiles,
} from '../lib/git.js';

async function seedRepository(root) {
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  await runGit(root, ['init', '--bare', bare]);
  await runGit(root, ['init', seed]);
  await writeFile(path.join(seed, 'README.md'), '# Demo\n', 'utf8');
  await runGit(seed, ['add', '.']);
  await runGit(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-m', 'initial']);
  await runGit(seed, ['branch', '-M', 'main']);
  await runGit(seed, ['remote', 'add', 'origin', bare]);
  await runGit(seed, ['push', 'origin', 'main']);
  await runGit(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { bare, seed };
}

test('git helpers clone, branch, commit, and push without pipes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-git-'));
  try {
    assert.match(await gitVersion(), /^git version/);
    const { bare } = await seedRepository(root);
    const clone = path.join(root, 'clone');
    await cloneRepo({ url: bare, destination: clone });
    assert.equal(await currentBranch(clone), 'main');
    assert.equal(await remoteUrl(clone, 'origin'), bare);

    await checkoutBranch(clone, { branch: 'oss/issue-1-demo', base: 'main' });
    assert.equal(await currentBranch(clone), 'oss/issue-1-demo');
    await writeFile(path.join(clone, 'fix.txt'), 'fixed\n', 'utf8');
    await stageAll(clone);
    assert.deepEqual(await stagedFiles(clone), ['fix.txt']);
    assert.equal(await commitsAhead(clone, { base: 'main' }), 0);
    await commit(clone, 'Fix demo');
    assert.equal(await commitsAhead(clone, { base: 'main' }), 1);
    await push(clone, { remote: 'origin', branch: 'oss/issue-1-demo' });
    const log = await runGit(clone, ['log', '--oneline', 'origin/oss/issue-1-demo']).then((result) => result.stdout);
    assert.match(log, /Fix demo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
