# Open Source Autopilot

Use this skill for an end-to-end contribution to an open-source GitHub repository: find a suitable issue, ask maintainers for assignment, implement the change, open a pull request, handle CI and review, and merge only when GitHub and repository policy allow it.

The `oss_*` tools are the only supported way to touch GitHub. They keep durable run state and a recurring watcher. Do not use ad-hoc `gh`, `curl`, or browser automation for public GitHub actions; those bypass the state machine, duplicate checks, and disclosure.

## Non-negotiable rules

1. **Maintainers are the authority.** A comment request does not assign an issue. Only `assignment: "assigned_to_operator"` from `oss_claim_issue`/`oss_sync_status` means the issue is assigned. Never tell the user or a maintainer that you were assigned when you were not.
2. **Disclose AI assistance.** The plugin appends the configured disclosure to every claim comment and PR. Do not remove it. Never impersonate a human maintainer or contributor.
3. **One claim at a time.** Do not claim multiple issues in one repository, mass-comment on issues, or follow up more than the configured limit (default: two follow-ups, 48 hours apart). The tool enforces this; do not work around it.
4. **Respect the repository.** Read `CONTRIBUTING.md`, the issue thread, the code of conduct, and the test instructions. Follow DCO/CLA and commit-signing requirements. Do not reformat unrelated code or add drive-by changes.
5. **Do not bypass quality gates.** Never merge with failing or pending checks, unresolved change requests, conflicts, a draft PR, or without merge permission. Never disable branch protection, required reviews, or CI. Never use `--force` to push over a review unless a maintainer explicitly asks.
6. **Never expose secrets.** Do not commit `.env` files, private keys, tokens, credentials, generated dependency trees, or large binaries. The tool scans the staged diff and refuses high-confidence secrets; treat a refusal as real.
7. **Do not spam.** One claim comment, at most the configured follow-ups, one PR, and concise replies to actual review threads. Do not ping maintainers repeatedly or ask them to merge on every check run.
8. **Stop when human judgment is needed.** If scope is ambiguous, the issue is taken, the repository forbids AI contributions, the contributor agreement cannot be met, or the maintainer declines, call `oss_stop` and explain the blocker. Do not invent consent.

## Phase 0 — prerequisites

Run:

```text
oss_doctor
```

It checks the GitHub token, git, API reachability, merge policy, and saved runs. If it reports no token or no git, stop and give the operator the exact fix. Do not attempt public actions with missing credentials.

Read the operator's request. If they have not authorized public GitHub activity, ask before the first public comment or PR. If they said "do it end to end" or equivalent, that authorizes the workflow, but the rules above still apply.

## Phase 1 — choose a suitable issue

```text
oss_find_issues(repo="owner/repo", label="good first issue", limit=5)
```

or a targeted query:

```text
oss_find_issues(query="is:issue is:open no:assignee label:\"help wanted\" language:TypeScript", limit=10)
```

Prefer issues that are:

- open, unassigned, unlocked, and not already linked to an open PR;
- small enough for a focused patch: a clear bug, a missing test, a scoped feature, or documentation with a precise ask;
- backed by a reproducible report and enough context to verify the fix;
- in a repository that accepts outside contributions and whose contribution guide you can follow.

Avoid issues that are assigned to someone else, have an active claimant, are broad epics, require maintainer-only infrastructure, or ask for design decisions you cannot validate. Read the issue body and recent comments before deciding. Check whether the repository forbids AI-generated contributions; if it does, stop.

## Phase 2 — request assignment

Inspect the issue and thread first. If it is already assigned to the operator, skip to Phase 3.

```text
oss_claim_issue(repo="owner/repo", issue_number=123, action="status")
```

If unassigned and eligible, post one claim:

```text
oss_claim_issue(
  repo="owner/repo",
  issue_number=123,
  action="request",
  acknowledge_public_post=true
)
```

The comment is public and includes the AI disclosure. Use the default wording unless the repository has a required assignment format; a custom `message` is allowed but the disclosure and marker are still appended.

Then wait. `oss_claim_issue` arms a persistent watcher that wakes this session. You can also check immediately:

```text
oss_claim_issue(repo="owner/repo", issue_number=123, action="status")
```

- `next_action: "wait_for_assignment"` → do nothing public. The watcher will retry.
- `next_action: "follow_up"` and `follow_up_due: true` → at most one polite follow-up, after the configured cooldown, with `action="follow_up"`.
- `maintainer_signal.possible_go_ahead: true` → read the actual comment. A maintainer must have explicitly invited work. If they did, you may proceed with `allow_unassigned=true`; otherwise wait.
- `next_action: "start_work"` → go to Phase 3.
- Issue closed or assigned to someone else → `oss_stop` and report.

Do not send a follow-up just because time passed if a maintainer responded or the issue is no longer available. Never ask for assignment twice in the same window.

## Phase 3 — implement

```text
oss_start_work(repo="owner/repo", issue_number=123)
```

This clones the repository under the workspace, creates `oss/issue-123-<slug>` from the default branch, and changes the session working directory into the clone. If a maintainer explicitly invited work without formal assignment, add `allow_unassigned=true`; otherwise wait for assignment.

Then:

1. Read the contribution guide and the relevant code before editing.
2. Reproduce the bug or confirm the requested behavior with a test or a small script.
3. Make the smallest complete change. Preserve existing style and public behavior unless the issue asks otherwise.
4. Add or update tests that would fail without the fix.
5. Run the repository's documented test, lint, type-check, and formatting commands. If a command cannot run, say exactly why; never claim a passing result you did not observe.
6. Keep secrets, generated files, and unrelated changes out of the diff.

If the fix requires a design decision the issue does not answer, stop and ask in the issue thread only if that is the repository's norm; otherwise ask the operator. Do not guess at product behavior.

## Phase 4 — publish the pull request

Before publishing, inspect your own diff:

```text
git status
git diff
```

Then call:

```text
oss_submit_pr(
  run_id="owner/repo#123",
  title="Fix ...",
  body="## Summary\n...\n\n## Testing\n- `...` passed\n\nCloses #123",
  commit_message="Fix ...",
  draft=false
)
```

The tool stages the working tree, scans the diff, commits, pushes to the origin when the operator has write access (or to a fork when they do not), and creates or updates the PR. It appends `Closes #123` and the AI disclosure. It refuses credential files, likely secrets, and files over 5 MiB.

A good PR body states:

- the problem and the chosen fix;
- the exact tests/commands run and their outcomes;
- anything deliberately not addressed;
- compatibility or migration notes, if any.

After it opens, `oss_submit_pr` arms a persistent PR watcher. Do not comment on the PR just to announce it; the PR is the announcement.

## Phase 5 — shepherd the PR

The watcher wakes this session periodically. At each wake, call:

```text
oss_sync_status(run_id="owner/repo#123")
```

Follow `next_action`:

| next_action | What to do |
|---|---|
| `wait_for_ci` | Do nothing public; let checks finish. |
| `fix_ci` | Read the failing logs. Reproduce locally, fix the root cause, run the tests, then call `oss_submit_pr` again with the same `run_id` and a fresh body. |
| `address_review` | Read every review thread. Change code or explain with evidence. Push new commits; do not force-push unless asked. Reply concisely to each actual concern. |
| `resolve_conflicts` | Fetch the base branch and resolve conflicts carefully. Re-run tests. Push normally (a merge commit or rebase is acceptable unless the repo forbids it). |
| `mark_ready` | If the draft was intentional and is now complete, call `oss_submit_pr` with `draft=false` and an updated body. |
| `update_branch` | Call `oss_merge(confirm=true)` only to request GitHub's branch update, then wait; or ask a maintainer. Do not rewrite shared history casually. |
| `wait_for_review` | Wait. Do not ping reviewers or maintainers just to ask for review. |
| `wait_for_maintainer_merge` | The operator lacks merge permission or `autoMerge` is off. Wait for a maintainer. Do not ask repeatedly. |
| `merge` | Call `oss_merge(confirm=true)` only after verifying the gates and that the operator authorized merge. |
| `done` | The PR was merged or closed. Stop and report. |

Never merge because a check is green alone. The merge tool re-checks GitHub's merge state, permissions, and gates. If it refuses, do not look for a workaround.

Review replies should be short and specific: what changed, where, and what you verified. If you disagree, explain with evidence and defer to the maintainer. If a reviewer asks for a rewrite, do it in new commits unless they ask for a clean history.

## Phase 6 — finish

When `oss_sync_status` reports `phase: "merged"` or `"closed"`, the watcher is stopped automatically. Report:

- the issue and PR URLs;
- the merge state and merge commit if available;
- the tests run and their outcomes;
- anything the operator should do next (for example, delete the branch or respond to a follow-up).

If the PR is closed without merging, do not reopen it or open a duplicate unless a maintainer asks. Ask the operator what they want next.

If the maintainers go quiet, do not escalate by spamming. After the configured follow-up limit, stop the watcher and tell the operator the PR or issue is waiting on maintainers.

## Recovery after a restart

Run `oss_doctor` to see saved runs. Use `oss_sync_status` with the run id to refresh state and re-arm the watcher. The clone remains under `<workspace>/.oss-autopilot/repos/`. Do not create a second run for the same issue.

## Stop conditions

Call `oss_stop` and explain the blocker when:

- the issue is closed, taken, or the maintainer declines;
- the repository forbids AI contributions or the operator cannot meet its CLA/DCO;
- credentials, permissions, or CI infrastructure are unavailable and cannot be fixed;
- the correct fix requires a product or security decision you cannot make;
- the PR has been waiting for maintainers beyond the configured window and no further action is appropriate.

`oss_stop` stops recurring checks only. It does not close the PR, delete the branch, or erase public comments.
