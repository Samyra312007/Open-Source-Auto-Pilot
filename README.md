# Open Source Autopilot for DeepSeek Harness

An installable DeepSeek Harness **plugin + agent skill** that turns a normal coding agent into an end-to-end open-source contributor:

1. find a suitable GitHub issue,
2. ask the maintainers to assign it (with AI disclosure),
3. wait for assignment and follow up politely at most twice,
4. clone the repository and implement the fix,
5. commit, push, and open a pull request,
6. watch CI and review activity, fix failures, and respond to change requests,
7. merge when GitHub reports the PR clean and the authenticated operator has permission.

It is designed for the realistic GitHub model: **maintainers assign issues, reviewers approve PRs, and only people with write access can merge.** The plugin automates everything within the operator's permissions and stops cleanly when a human decision is required.

## What is in the box

| Piece | Purpose |
|---|---|
| `oss_doctor` | Checks token, git, API access, merge policy, and saved runs. Start here. |
| `oss_find_issues` | Read-only issue search with assignment, label, and scope filters. |
| `oss_claim_issue` | Posts one claim comment, checks assignment, or performs a due follow-up. |
| `oss_start_work` | Clones the repo, creates an issue branch, and switches the session cwd into it. |
| `oss_submit_pr` | Stages, scans, commits, pushes (origin or fork), and creates/updates the PR. |
| `oss_sync_status` | Refreshes issue/PR/CI/review state and returns one `next_action`. |
| `oss_merge` | Re-checks all gates and merges with an expected-head SHA guard. |
| `oss_stop` | Stops recurring checks without closing the PR or deleting anything. |
| `oss_batch_status` | Refreshes and aggregates status for multiple runs at once. |
| `oss_config` | Reads or updates the plugin configuration file. |
| `open-source-autopilot` skill | The full contribution policy and phase-by-phase operating instructions. |
| Persistent watcher | A DSH schedule reminder wakes the session while a claim or PR is waiting. |

Runs survive DSH restarts because state is stored outside the agent context and the watcher uses DSH's durable schedule service.

## Requirements

- DeepSeek Harness with the schedule, skills, and subprocess/git capabilities (the desktop profile has them).
- **git** on `PATH`.
- A **GitHub token** with access to the target repositories:
  - Issues: read/write (claim comments),
  - Contents: read/write (clone/push),
  - Pull requests: read/write (open/update/merge),
  - Metadata: read.
  - Classic tokens usually use `repo` + `workflow`; fine-grained tokens need those repository permissions.
- Permission to push to the repository, or the ability to create a fork. The plugin forks automatically when the operator lacks push access.
- Merge permission for hands-off merging. Without it, the plugin shepherds the PR to green and waits for a maintainer.

## Install

The plugin lives in this directory as a local DSH bundle.

```text
plugin_manager:
  action: install_bundle
  target: C:\Users\kumar\OneDrive\Desktop\opensourceplugin
```

This installs the bundle and activates the `oss-autopilot` row for the current profile. If the manager reports a restart requirement, restart the DSH host.

Then set the token **in the environment of the DSH host process** (not merely in a terminal that talks to it) and restart DSH:

```powershell
# Current user, persists across DSH launches
[Environment]::SetEnvironmentVariable('GITHUB_TOKEN', 'github_pat_...', 'User')
```

`GH_TOKEN` and `GITHUB_TOKEN` are both recognized. `config.tokenEnv` can point to a different variable. The token is never written to plugin state.

Confirm the installation:

```text
oss_doctor
```

You should see `ok: true`, your GitHub login, git version, and any saved runs.

## Use it from a prompt

After installation, any agent in this profile can see the skill and tools. A minimal prompt:

> Use the open-source-autopilot skill. Find a small unassigned issue in `owner/repo`, ask the maintainers to assign it, implement the fix, open a PR, and take it through CI and review. Only merge if I have permission. Show me the issue and PR links.

Or drive it deliberately:

```text
oss_find_issues(repo="owner/repo", label="good first issue", limit=5)
oss_claim_issue(repo="owner/repo", issue_number=123, action="request", acknowledge_public_post=true)
oss_start_work(repo="owner/repo", issue_number=123)
# ... edit, test ...
oss_submit_pr(run_id="owner/repo#123", title="Fix ...", body="...")
oss_sync_status(run_id="owner/repo#123")
oss_merge(run_id="owner/repo#123", confirm=true)
```

The skill tells the model how to choose issues, when to follow up, how to write a good PR, and how to handle every `next_action`.

## How the automation loop works

```text
doctor
  → find issue
  → post claim comment + arm claim watcher
  → maintainer assigns
  → watcher wakes agent → start work
  → agent edits + tests
  → submit PR + arm PR watcher
  → watcher wakes agent on CI/review changes
  → fix / reply / update branch
  → merge when clean and permitted
  → watcher deleted, run complete
```

`oss_sync_status` is the single source of truth for what to do next. It returns values such as:

- `wait_for_assignment`, `follow_up`, `start_work`
- `wait_for_ci`, `fix_ci`
- `wait_for_review`, `address_review`
- `resolve_conflicts`, `update_branch`, `mark_ready`
- `wait_for_maintainer_merge`, `merge`, `done`

The recurring reminder contains only a short instruction to call `oss_sync_status` and act; the tool result carries the details. The watcher uses DSH's schedule service, so it survives host restarts and does not depend on a terminal staying open.

## Safety gates

The plugin is deliberately conservative about public and irreversible actions.

- **AI disclosure is mandatory.** Claim comments and PRs get the configured disclosure; removing the marker does not make the work human-authored.
- **One claim per issue.** Existing claim comments are detected by hidden markers; duplicate requests are refused.
- **Follow-ups are rate-limited.** Default maximum: two, at least 48 hours apart.
- **No assignment fabrication.** The tool reads GitHub's assignee list every time.
- **No merge without write permission.** `oss_merge` checks GitHub's merge state, the operator's repository permissions, draft/conflict/check/review gates, and the expected head SHA. It cannot bypass branch protection.
- **No force-push.** The push path never uses `--force`.
- **Secret scan before push.** High-confidence tokens/private keys and credential files are refused. Files over 5 MiB are refused.
- **No maintainer spam.** The skill forbids repeated pings, mass claims, and merge requests.
- **No silent success.** If a command or check is not run, the agent is instructed to say so.

## Configuration

Defaults are built in. To override them, create:

```text
%DSH_HOME%\oss-autopilot\config.json
```

On this machine that is usually `C:\Users\<you>\.dsh\oss-autopilot\config.json`. The row config in `cordis.patch.yml` is merged last and wins.

| Key | Default | Meaning |
|---|---|---|
| `tokenEnv` | `GITHUB_TOKEN` | Environment variable holding the token. `GITHUB_TOKEN`/`GH_TOKEN` are fallbacks. |
| `apiBaseUrl` | `https://api.github.com` | GitHub API base URL. |
| `pollSeconds` | `600` | PR watcher interval (min 60). |
| `claimPollSeconds` | `3600` | Claim watcher interval (min 60). |
| `claimFollowUpHours` | `48` | Minimum hours before a polite follow-up. |
| `maxClaimFollowUps` | `2` | Maximum follow-ups per claim (0-5). |
| `autoMerge` | `true` | Allow `next_action: merge` when all gates pass. Set false to require a maintainer merge. |
| `mergeMethod` | `squash` | `squash`, `merge`, or `rebase`. |
| `fork` | `true` | Fork automatically when the operator cannot push to the base repo. |
| `requireAssignment` | `true` | Require formal assignment unless a maintainer explicitly invited work. |
| `enforceDisclosure` | `true` | Automatically append the AI disclosure marker to PR bodies when it is missing. |
| `prLabels` | `[]` | Labels applied to newly created or updated pull requests. |
| `usePrTemplate` | `true` | Prepend the repository's pull request template to generated PR bodies. Supports `{issue_number}`, `{login}`, and `{title}` placeholders. |
| Repo override | `.github/oss-autopilot.json` | Optional repository-level overrides for labels, template usage, disclosure, and other config keys. |
| `gitAuthorName` / `gitAuthorEmail` | empty | Optional commit identity override. |
| `disclosure` | AI-assisted disclosure with `{login}` | Public disclosure text. `{login}` is replaced. |
| `dryRun` | `false` | Block public mutations for a test pass. |

The config file is read on each tool call, so you can change polling or `autoMerge` without reinstall.

## Files and state

- Runs and config: `%DSH_HOME%\oss-autopilot\state.json`, `config.json`.
- Clones: `<session workspace>\.oss-autopilot\repos\<owner>\<repo>-issue-<n>`.
- The tool switches the session's working directory into the clone so the normal read/write/edit/grep tools work on the repository.
- State is versioned. An unknown/newer state file is refused rather than overwritten.
- `oss_stop` removes the run's reminder; the PR and branch remain.

## Limits you should know

- **Assignment and merge are social operations, not API switches.** The plugin can ask, wait, follow up, and merge only when GitHub allows it. It cannot make a maintainer assign an issue or approve a PR.
- **Fork PRs still need maintainer review.** CI may run only after a maintainer approves workflows for first-time contributors.
- **Some repositories forbid AI-generated contributions.** The skill tells the agent to stop if the repository's rules say so. The operator remains responsible for following them.
- **Public actions are public.** `oss_claim_issue` and `oss_submit_pr` post under the token owner's GitHub identity.
- **The watcher is a reminder, not a separate daemon.** It needs the DSH host to be running at some point to deliver the reminder. Missed recurring reminders deliver only the latest occurrence after downtime.
- **Two runs on the same issue should not exist.** The run id is `owner/repo#issue`; the state machine refuses duplicate PR work.
- **The skill is guidance, not a security boundary.** Tool gates are the boundary: no merge without permissions, no unsafe diff, no duplicate claim, no force-push.

## Development

```powershell
npm run check
npm test
```

Tests cover config validation, state concurrency, issue/PR state machines, secret scanning, GitHub request/response handling, git clone/branch/commit/push, and a full mocked GitHub end-to-end run. The git and workflow tests need git and write access to a temporary directory; run them outside a restricted Windows sandbox if `git push` cannot create its helper pipe.

## License

MIT. See [LICENSE](LICENSE).
