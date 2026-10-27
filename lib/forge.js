/**
 * Minimal forge abstraction. GitHub is the only implemented forge today; the
 * adapter keeps the door open for GitLab, Bitbucket, or Gitea support without
 * changing the tool layer.
 */
export class ForgeAdapter {
  constructor(kind) {
    this.kind = kind;
  }

  async getRepository() {
    throw new Error(`${this.kind} forge does not implement getRepository`);
  }

  async getIssue() {
    throw new Error(`${this.kind} forge does not implement getIssue`);
  }

  async createPullRequest() {
    throw new Error(`${this.kind} forge does not implement createPullRequest`);
  }
}

export class GitHubForge extends ForgeAdapter {
  constructor(client) {
    super('github');
    this.client = client;
  }

  async getRepository(owner, repo) {
    return this.client.getRepo(owner, repo);
  }

  async getIssue(owner, repo, number) {
    return this.client.getIssue(owner, repo, number);
  }

  async createPullRequest(owner, repo, input) {
    return this.client.createPull(owner, repo, input);
  }
}

export function createForge(kind, options = {}) {
  if (kind === 'github') return new GitHubForge(options.client);
  throw new Error(`Unsupported forge: ${kind}`);
}