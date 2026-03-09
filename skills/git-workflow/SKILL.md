---
name: "git-workflow"
description: "Git version control workflows for AI coding agents. Use when tasks involve committing changes, creating branches, opening pull requests, resolving merge conflicts, writing commit messages, reviewing diffs, rebasing, stashing, cherry-picking, tagging releases, or any git-related operation. Triggers on: 'commit my changes', 'create a PR', 'push this branch', 'fix merge conflict', 'git status', 'review changes', 'squash commits', 'tag a release', 'revert a commit', or any git/GitHub/GitLab CLI workflow."
---

# Git Workflow Skill

Structured git workflows for AI coding agents. Follow these procedures instead of ad-hoc bash commands.

## Pre-flight: Assess State

Before any git operation, gather context:

```bash
git status --short --branch
git log --oneline -5
git remote -v
```

Check for uncommitted changes, current branch, and remote configuration before proceeding.

## Commit Workflow

### 1. Stage changes intentionally

Never use `git add .` blindly. Review what changed first:

```bash
git diff --stat
git diff              # unstaged changes
git diff --cached     # staged changes
```

Stage related changes together. Use `git add -p` for partial staging when a file contains unrelated changes.

### 2. Write Conventional Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short summary>

<optional body — explain WHY, not WHAT>

<optional footer — references, breaking changes>
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

Examples:
```
feat(auth): add OAuth2 token refresh with exponential backoff

fix(parser): handle nested quotes in CSV fields

docs(api): add rate limiting section to REST reference

refactor(db): extract connection pooling into shared module

test(auth): add integration tests for token expiry edge cases
```

Rules:
- Subject line ≤ 72 characters, imperative mood ("add" not "added")
- Scope is optional but preferred for non-trivial repos
- Body wraps at 72 characters, separated by blank line
- Reference issues with `Closes #123` or `Refs #456`

### 3. Commit command

```bash
git commit -m "type(scope): summary" -m "Optional body explaining why."
```

For multi-line messages, use a temp file:
```bash
cat > /tmp/commit-msg.txt << 'EOF'
feat(session): add token usage and cost tracking

Track per-turn and cumulative token usage with estimated costs.
Supports budget alerts (warn + hard-stop thresholds) and
per-model cost breakdown.

Closes #42
EOF
git commit -F /tmp/commit-msg.txt
```

## Branch Workflow

### Naming convention

```
<type>/<short-description>
```

Examples: `feat/cost-tracking`, `fix/oauth-refresh`, `docs/api-reference`, `refactor/db-pooling`

### Create and switch

```bash
git checkout -b feat/my-feature           # from current branch
git checkout -b feat/my-feature origin/main  # from remote main
```

### Keep branch updated

```bash
git fetch origin
git rebase origin/main    # preferred: linear history
# OR
git merge origin/main     # if rebase would be destructive
```

If rebase conflicts arise, resolve each file, then:
```bash
git add <resolved-file>
git rebase --continue
```

To abort a bad rebase: `git rebase --abort`

## Pull Request Workflow

### Pre-PR checklist

1. Ensure tests pass locally
2. Ensure branch is up-to-date with target
3. Review own diff: `git diff origin/main...HEAD --stat`

### Using GitHub CLI (`gh`)

```bash
# Create PR
gh pr create --title "feat(scope): summary" \
  --body "## What\nDescription of changes.\n\n## Why\nMotivation.\n\n## Testing\nHow it was tested." \
  --base main

# Create draft PR
gh pr create --draft --title "wip: exploration" --body "Early draft."

# List open PRs
gh pr list

# View PR details
gh pr view <number>

# Merge PR (squash preferred for clean history)
gh pr merge <number> --squash --delete-branch
```

### PR description template

```markdown
## What
Brief description of the change.

## Why
Motivation and context.

## How
Implementation approach (optional, for complex changes).

## Testing
- [ ] Unit tests added/updated
- [ ] Manual testing performed
- [ ] CI passes

## Related
Closes #<issue>
```

## Merge Conflict Resolution

### Identify conflicts

```bash
git status                    # shows conflicted files
git diff --name-only --diff-filter=U  # only conflicted files
```

### Resolution strategy

1. Open each conflicted file
2. Look for conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`
3. Decide: keep ours, keep theirs, or merge manually
4. Remove ALL conflict markers
5. Stage resolved files: `git add <file>`
6. Continue the operation:
   - Merge: `git commit` (auto-generated message is fine)
   - Rebase: `git rebase --continue`
   - Cherry-pick: `git cherry-pick --continue`

### Quick resolution commands

```bash
git checkout --ours <file>    # keep current branch version
git checkout --theirs <file>  # keep incoming version
```

## Stash Workflow

Save work-in-progress without committing:

```bash
git stash push -m "wip: description"   # always name stashes
git stash list                          # see all stashes
git stash pop                           # apply and remove latest
git stash apply stash@{1}              # apply specific stash
git stash drop stash@{0}               # remove specific stash
```

## History Management

### Interactive rebase (squash, reword, reorder)

```bash
git rebase -i HEAD~3          # last 3 commits
git rebase -i origin/main     # all commits since main
```

In the editor: `pick`, `squash` (or `s`), `reword` (or `r`), `drop` (or `d`), `edit` (or `e`)

### Undo operations

```bash
git revert <sha>              # safe: creates new undo commit
git reset --soft HEAD~1       # undo commit, keep changes staged
git reset --mixed HEAD~1      # undo commit, unstage changes
git reset --hard HEAD~1       # DESTRUCTIVE: discard commit + changes
```

Prefer `git revert` on shared branches. Use `git reset` only on local/personal branches.

### Cherry-pick

```bash
git cherry-pick <sha>                      # single commit
git cherry-pick <sha1> <sha2>              # multiple commits
git cherry-pick <sha> --no-commit          # apply without committing
```

## Tagging Releases

```bash
git tag -a v1.2.0 -m "Release v1.2.0: cost tracking feature"
git push origin v1.2.0
git push origin --tags        # push all tags
```

Use semantic versioning: `vMAJOR.MINOR.PATCH`

## Safety Rules

1. **Never force-push shared branches** (`main`, `develop`, `release/*`)
2. **Never `git reset --hard` on shared branches** — use `git revert`
3. **Always fetch before rebase** — `git fetch origin && git rebase origin/main`
4. **Check branch before destructive ops** — `git branch --show-current`
5. **Back up before risky operations** — `git stash` or create a temp branch
6. When unsure, ask the user before: force-pushing, resetting, or deleting branches

## Git Configuration Tips

```bash
git config --global init.defaultBranch main
git config --global pull.rebase true
git config --global rerere.enabled true     # remember conflict resolutions
git config --global core.autocrlf input     # normalize line endings
```
