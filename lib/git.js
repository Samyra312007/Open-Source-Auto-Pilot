import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export class GitError extends Error {
  constructor(message, { code = 'GIT_ERROR', stdout = '', stderr = '', exitCode = null } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

function redact(text, secrets) {
  let output = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function authArgs(url, token) {
  if (!token || typeof url !== 'string' || !/^https?:/i.test(url)) return { args: [], secrets: [] };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { args: [], secrets: [] };
  }
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    args: ['-c', `http.${parsed.origin}/.extraheader=AUTHORIZATION: basic ${basic}`, '-c', 'credential.helper='],
    secrets: [token, basic],
  };
}

/**
 * Run a process without pipes. Captured output goes to temporary files so the
 * helper works under DSH's Windows sandbox as well as in the host process.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number, secrets?: string[], allowFailure?: boolean }} [options]
 */
export async function runProcess(command, args, {
  cwd,
  signal,
  timeoutMs = 120_000,
  secrets = [],
  allowFailure = false,
} = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-oss-git-'));
  const stdoutPath = path.join(tempDir, 'stdout.txt');
  const stderrPath = path.join(tempDir, 'stderr.txt');
  let stdoutHandle;
  let stderrHandle;
  let child;
  let timer;
  let abortListener;

  try {
    stdoutHandle = await open(stdoutPath, 'w');
    stderrHandle = await open(stderrPath, 'w');
    if (signal?.aborted) throw new GitError(`${command} was cancelled before it started`, { code: 'GIT_ABORTED' });

    child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        LC_ALL: 'C',
        LANG: 'C',
      },
    });

    const outcome = await new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortListener) signal?.removeEventListener('abort', abortListener);
        fn(value);
      };
      child.once('error', (error) => finish(reject, error));
      child.once('close', (exitCode, closeSignal) => finish(resolve, { exitCode, closeSignal, timedOut }));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // The close event still settles the promise.
        }
      }, Math.max(1_000, timeoutMs));
      timer.unref?.();
      if (signal) {
        abortListener = () => {
          try {
            child.kill();
          } catch {
            // The close event still settles the promise.
          }
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    if (outcome.timedOut) {
      throw new GitError(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'GIT_TIMEOUT' });
    }
    if (signal?.aborted) {
      throw new GitError(`${command} was cancelled`, { code: 'GIT_ABORTED' });
    }

    const [stdoutRaw, stderrRaw] = await Promise.all([
      readFile(stdoutPath, 'utf8').catch(() => ''),
      readFile(stderrPath, 'utf8').catch(() => ''),
    ]);
    const stdout = redact(stdoutRaw.slice(0, MAX_CAPTURE_BYTES), secrets).trim();
    const stderr = redact(stderrRaw.slice(-MAX_CAPTURE_BYTES), secrets).trim();
    if (outcome.exitCode !== 0 && !allowFailure) {
      throw new GitError(
        `${command} ${args.filter((arg) => !arg.startsWith('http.')).join(' ')} failed (exit ${String(outcome.exitCode)}).\n${stderr || stdout || 'No output.'}`,
        {
          code: 'GIT_EXIT',
          stdout,
          stderr,
          exitCode: outcome.exitCode,
        },
      );
    }
    return { code: outcome.exitCode, signal: outcome.closeSignal, stdout, stderr };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new GitError(`Cannot run "${command}": it is not installed or not on PATH.`, { code: 'GIT_NOT_FOUND' });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    await stdoutHandle?.close().catch(() => {});
    await stderrHandle?.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ url?: string, token?: string, signal?: AbortSignal, timeoutMs?: number, allowFailure?: boolean }} [options]
 */
export async function runGit(cwd, args, { url, token, signal, timeoutMs = 120_000, allowFailure = false } = {}) {
  const auth = authArgs(url, token);
  return runProcess('git', [...auth.args, ...args], {
    cwd,
    signal,
    timeoutMs,
    secrets: auth.secrets,
    allowFailure,
  });
}

export async function gitText(cwd, args, options) {
  const result = await runGit(cwd, args, options);
  return result.stdout.trim();
}

export async function gitVersion() {
  const result = await runProcess('git', ['--version'], { timeoutMs: 15_000 });
  return result.stdout.trim();
}

export async function cloneRepo({ url, destination, token, signal, timeoutMs = 300_000 }) {
  await mkdir(path.dirname(destination), { recursive: true });
  await runGit(path.dirname(destination), ['clone', '--no-tags', '--origin', 'origin', url, destination], {
    url,
    token,
    signal,
    timeoutMs,
  });
  return destination;
}

export async function fetchOrigin(cwd, { url, token, signal, branch } = {}) {
  const args = ['fetch', '--no-tags', '--prune', 'origin'];
  if (branch) args.push(branch);
  return gitText(cwd, args, { url, token, signal, timeoutMs: 180_000 });
}

export async function branchExists(cwd, branch) {
  const result = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true });
  return result.code === 0;
}

export async function currentBranch(cwd) {
  return gitText(cwd, ['symbolic-ref', '--short', 'HEAD']);
}

export async function checkoutBranch(cwd, { branch, base, url, token, signal, allowExisting = true }) {
  if (await branchExists(cwd, branch)) {
    if (!allowExisting) throw new GitError(`Local branch already exists: ${branch}`, { code: 'GIT_BRANCH_EXISTS' });
    await gitText(cwd, ['checkout', branch], { url, token, signal });
    return { created: false };
  }
  await gitText(cwd, ['checkout', '-b', branch, `origin/${base}`], { url, token, signal });
  return { created: true };
}

export async function statusPorcelain(cwd) {
  return gitText(cwd, ['status', '--porcelain=v1', '-uall']);
}

export async function stageAll(cwd) {
  await gitText(cwd, ['add', '-A']);
}

export async function stagedFiles(cwd) {
  const output = await gitText(cwd, ['diff', '--cached', '--name-only']);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function stagedNameStatus(cwd) {
  return gitText(cwd, ['diff', '--cached', '--name-status']);
}

export async function stagedDiff(cwd, maxBytes = 1_500_000) {
  const result = await runGit(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff', '--unified=0']);
  return result.stdout.slice(0, maxBytes);
}

export async function stagedStat(cwd) {
  return gitText(cwd, ['diff', '--cached', '--stat', '--no-color']);
}

export async function commit(cwd, message, { signal } = {}) {
  const result = await runGit(cwd, ['commit', '-m', message], { signal, allowFailure: true });
  if (result.code !== 0) {
    if (/nothing to commit|no changes added/i.test(`${result.stdout}\n${result.stderr}`)) return { committed: false };
    throw new GitError(`git commit failed: ${result.stderr || result.stdout}`, {
      code: 'GIT_COMMIT_FAILED',
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    });
  }
  return { committed: true, stdout: result.stdout };
}

export async function push(cwd, { remote, branch, url, token, signal, timeoutMs = 180_000 }) {
  return gitText(cwd, ['push', '--set-upstream', remote, `HEAD:refs/heads/${branch}`], {
    url,
    token,
    signal,
    timeoutMs,
  });
}

export async function revParse(cwd, ref = 'HEAD') {
  return gitText(cwd, ['rev-parse', ref]);
}

export async function commitsAhead(cwd, { remote = 'origin', base = 'main' } = {}) {
  const output = await gitText(cwd, ['rev-list', '--count', `${remote}/${base}..HEAD`]);
  return Number.parseInt(output, 10) || 0;
}

export async function getConfig(cwd, key) {
  const result = await runGit(cwd, ['config', '--get', key], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : '';
}

export async function setConfig(cwd, key, value) {
  await gitText(cwd, ['config', '--local', key, value]);
}

export async function remoteUrl(cwd, remote) {
  const result = await runGit(cwd, ['remote', 'get-url', remote], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : '';
}

export async function addOrSetRemote(cwd, remote, url) {
  const existing = await remoteUrl(cwd, remote);
  if (existing) {
    if (existing !== url) await gitText(cwd, ['remote', 'set-url', remote, url]);
    return { created: false };
  }
  await gitText(cwd, ['remote', 'add', remote, url]);
  return { created: true };
}

export async function isGitRepository(cwd) {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  return result.code === 0 && result.stdout.trim() === 'true';
}

export function hasDisclosure(text) {
  const value = String(text ?? '');
  return /dsh-oss-autopilot:ai-disclosure/i.test(value) || /\bAI[- ]?assisted\b/i.test(value) || /\bartificial intelligence\b/i.test(value);
}

export function scanForDisclosure(text) {
  return hasDisclosure(text) ? [] : ['missing AI disclosure'];
}
