import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const APP_DIR_NAME = 'oss-autopilot';
export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  tokenEnv: 'GITHUB_TOKEN',
  apiBaseUrl: 'https://api.github.com',
  pollSeconds: 600,
  claimPollSeconds: 3600,
  claimFollowUpHours: 48,
  maxClaimFollowUps: 2,
  autoMerge: true,
  mergeMethod: 'squash',
  fork: true,
  requireAssignment: true,
  gitAuthorName: '',
  gitAuthorEmail: '',
  disclosure: 'This contribution was prepared with AI assistance by @{login}.',
  dryRun: false,
});

const MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

export function defaultStateRoot() {
  if (process.env.DSH_OSS_AUTOPILOT_DIR) return path.resolve(process.env.DSH_OSS_AUTOPILOT_DIR);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, APP_DIR_NAME);
}

export function resolveStateRoot(override) {
  return override ? path.resolve(override) : defaultStateRoot();
}

export function configPath(root) {
  return path.join(root, 'config.json');
}

export function statePath(root) {
  return path.join(root, 'state.json');
}

export function normalizeDisclosure(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) text = DEFAULT_CONFIG.disclosure;
  if (!text.includes('{login}')) text = `${text} (operator: @{login})`;
  if (!/\b(ai|a\.i\.|artificial intelligence|assistant|automated)\b/i.test(text)) {
    text = `AI-assisted contribution. ${text}`;
  }
  if (text.length > 600) text = text.slice(0, 600);
  return text;
}

function requireBoolean(name, value) {
  if (typeof value !== 'boolean') throw new Error(`config.${name} must be a boolean`);
  return value;
}

function requireInteger(name, value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`config.${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requireNumber(name, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`config.${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function optionalString(name, value, max = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`config.${name} must be a string`);
  const text = value.trim();
  if (text.length > max) throw new Error(`config.${name} must be at most ${max} characters`);
  return text;
}

/**
 * Validate and normalize a merged configuration object. Configuration is plain
 * JSON so the plugin needs no runtime dependency beyond Node itself.
 *
 * @param {Record<string, unknown>} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG, ...raw };
  const apiBaseUrl = String(merged.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error('config.apiBaseUrl must be an absolute http(s) URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('config.apiBaseUrl must use http or https');

  const tokenEnv = optionalString('tokenEnv', merged.tokenEnv, 80);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error('config.tokenEnv must be a valid environment variable name');
  }

  const mergeMethod = optionalString('mergeMethod', merged.mergeMethod, 20).toLowerCase();
  if (!MERGE_METHODS.has(mergeMethod)) throw new Error('config.mergeMethod must be squash, merge, or rebase');

  return {
    tokenEnv,
    apiBaseUrl,
    pollSeconds: requireInteger('pollSeconds', merged.pollSeconds, 60, 86400),
    claimPollSeconds: requireInteger('claimPollSeconds', merged.claimPollSeconds, 60, 86400),
    claimFollowUpHours: requireNumber('claimFollowUpHours', merged.claimFollowUpHours, 1, 24 * 30),
    maxClaimFollowUps: requireInteger('maxClaimFollowUps', merged.maxClaimFollowUps, 0, 5),
    autoMerge: requireBoolean('autoMerge', merged.autoMerge),
    mergeMethod,
    fork: requireBoolean('fork', merged.fork),
    requireAssignment: requireBoolean('requireAssignment', merged.requireAssignment),
    gitAuthorName: optionalString('gitAuthorName', merged.gitAuthorName, 120),
    gitAuthorEmail: optionalString('gitAuthorEmail', merged.gitAuthorEmail, 200),
    disclosure: normalizeDisclosure(merged.disclosure),
    dryRun: requireBoolean('dryRun', merged.dryRun),
  };
}

/**
 * Load defaults, the optional profile-level config file, then the row config
 * from cordis.patch.yml. The row wins because it is the most local decision.
 *
 * @param {{ root?: string, patchConfig?: Record<string, unknown> }} options
 */
export async function loadConfig({ root, patchConfig = {} } = {}) {
  const resolvedRoot = resolveStateRoot(root);
  let fileConfig = {};
  const file = configPath(resolvedRoot);
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config.json must contain a JSON object');
    }
    fileConfig = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return normalizeConfig({ ...fileConfig, ...patchConfig });
}

/**
 * Resolve a GitHub token without ever reading it from plugin config.
 * Fine-grained and classic tokens are both accepted.
 *
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {{ token: string, source: string } | undefined}
 */
export function findToken(config) {
  const names = [...new Set([config.tokenEnv, 'GITHUB_TOKEN', 'GH_TOKEN'])].filter(Boolean);
  for (const name of names) {
    const value = process.env[name];
    if (typeof value !== 'string') continue;
    const token = value.trim();
    if (token.length > 0 && !/\s/.test(token)) return { token, source: name };
  }
  return undefined;
}

export function tokenHelp(config) {
  return `Set ${config.tokenEnv} (or GITHUB_TOKEN / GH_TOKEN) to a GitHub token with Issues write, Contents read/write, and Pull requests write, then restart the DSH host. Fine-grained tokens need access to the target repositories.`;
}
