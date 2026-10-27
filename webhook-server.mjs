import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig, resolveStateRoot, findToken } from './lib/config.js';
import { GitHubClient } from './lib/github.js';
import { processWebhook } from './lib/workflow.js';

const port = Number(process.env.OSS_WEBHOOK_PORT || 8787);
const stateRoot = resolveStateRoot();
const config = await loadConfig({ root: stateRoot });
const tokenInfo = findToken(config);
if (!tokenInfo?.token) {
  console.error('No GitHub token found. Set GITHUB_TOKEN before starting the webhook server.');
  process.exit(1);
}

const client = new GitHubClient({ token: tokenInfo.token, apiBaseUrl: config.apiBaseUrl });
const user = await client.getAuthenticatedUser();
const deps = {
  client,
  config,
  stateRoot,
  token: tokenInfo.token,
  workspace: process.cwd(),
  signal: new AbortController().signal,
  login: user.login,
  user,
};

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/webhook') {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret) {
    const signature = request.headers['x-hub-signature-256'];
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (typeof signature !== 'string' || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      response.statusCode = 401;
      response.end('invalid signature');
      return;
    }
  }
  let payload = {};
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    response.statusCode = 400;
    response.end('invalid JSON');
    return;
  }
  const event = request.headers['x-github-event'] || 'unknown';
  try {
    const result = await processWebhook(deps, { event, payload });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result, null, 2));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, () => {
  console.log(`OSS Autopilot webhook server listening on http://localhost:${port}/webhook`);
});