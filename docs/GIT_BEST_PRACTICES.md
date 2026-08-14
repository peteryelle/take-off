# Git Best Practices

A practical guide for working with Git branches safely and consistently.

## Standard Workflow

``` text
Development
  ↓
Create branch
  ↓
Make changes
  ↓
Commit
  ↓
Push
  ↓
Merge to Development
  ↓
Pull Request Development -> Main
  ↓
Testing = QA
  ↓
Release
```

**Avoid developing directly on `main`.**

------------------------------------------------------------------------

## 1. Start From an Updated `development`

Before starting new work:

``` bash
git checkout development
git pull origin development
git status
```

Ideally, `git status` should show a clean working tree.

------------------------------------------------------------------------

## 2. Create a Branch

Create and immediately switch to a new branch:

``` bash
git checkout -b analysis-page
```

Avoid vague names such as `changes`, `test2`, or `new-code`.

------------------------------------------------------------------------

## 3. Check or Switch Branches

See your branches:

``` bash
git branch
```

The `*` marks your current branch:

``` text
  main
  development
* analysis-page
```

Switch to an existing branch:

``` bash
git checkout analysis-page
```

or:

``` bash
git switch analysis-page
```

------------------------------------------------------------------------

## 4. Review Your Changes

Check repository status frequently:

``` bash
git status
```

See unstaged changes:

``` bash
git diff
```

Review changes before committing instead of blindly committing
everything.

------------------------------------------------------------------------

## 5. Stage Changes

Stage all current changes:

``` bash
git add .
```

Then review what is staged:

``` bash
git diff --staged
```

Use `git add .` carefully. Make sure everything shown by `git status`
belongs in the commit.

------------------------------------------------------------------------

## 6. Commit

Create a commit:

``` bash
git commit -m "Add analysis retry handling"
```

Good commit messages explain what changed:

``` text
Add page retry handling
Fix duplicate device instances on rerun
Add tenant isolation tests
Validate PDF page limit
```

Avoid messages such as:

``` text
changes
updates
fix
stuff
final
```

Prefer small, logical commits over one large commit containing unrelated
work.

------------------------------------------------------------------------

## 7. Push Your Branch

The first time you push a new branch:

``` bash
git push -u origin analysis-page
```

After that:

``` bash
git push
```

The `-u` connects your local branch to its remote branch.

------------------------------------------------------------------------

## 8. Open a Pull Request

For a shared repository, merge changes through a GitHub Pull Request.

``` text
feature branch
      ↓
Merge to development
      ↓
Pull Request
      ↓
Automated tests
      ↓
Code review
      ↓
Merge
      ↓
main
```

A good PR explains:

-   what changed,
-   why it changed,
-   how it was tested,
-   any risks or follow-up work.

Keep PRs focused. Avoid combining unrelated features, fixes, and
refactors.

------------------------------------------------------------------------

## 9. Update Your Branch With `main` and `development`

Other work may be merged while you are developing.

Update your local `development`:

``` bash
git checkout development
git pull origin development
```

Return to your branch:

``` bash
git checkout analysis-page
```

Merge current `development` into it:

``` bash
git merge development
```

Resolve any conflicts, run tests, then:

``` bash
git push
```

------------------------------------------------------------------------

## 10. Resolve Merge Conflicts

A conflict may look like:

``` text
<<<<<<< HEAD
your branch code
=======
main branch code
>>>>>>> main
```

Review both versions and decide what the final code should contain.
Remove the conflict markers.

Stage the resolved file:

``` bash
git add .
```

Then finish the merge:

``` bash
git commit
```

Run tests before pushing.

**Do not blindly accept one side of a conflict.** Understand both
changes first.

------------------------------------------------------------------------

## 11. Merge a Branch

### Recommended: GitHub Pull Request

For production/team repositories, prefer:

``` text
Branch → PR → Tests → Review → Merge
```

This preserves review history and allows branch protection and CI
checks.

### Local merge

If you intentionally need to merge locally:

``` bash
git checkout main
git pull origin main
git merge feature/analysis-page
git push origin main
```

Prefer Pull Requests unless the team's workflow specifically calls for
local merges.

------------------------------------------------------------------------

## 12. Clean Up After Merge

Update local `main`:

``` bash
git checkout main
git pull origin main
```

Delete the merged local branch:

``` bash
git branch -d feature/analysis-page
```

Delete the remote branch if GitHub did not already remove it:

``` bash
git push origin --delete feature/analysis-page
```

Create your next branch from the newly updated `main`.

------------------------------------------------------------------------

## 13. Temporarily Save Uncommitted Work

If you need to switch branches but are not ready to commit:

``` bash
git stash
```

Later:

``` bash
git checkout feature/analysis-page
git stash pop
```

View stashes:

``` bash
git stash list
```

Use stash temporarily, not as long-term storage.

------------------------------------------------------------------------

## 14. Useful Commands

  Task                      Command
  ------------------------- ----------------------------------------------
  Check status              `git status`
  See branches              `git branch`
  See remote branches too   `git branch -a`
  Create branch             `git checkout -b feature/name`
  Switch branch             `git checkout branch-name`
  Update main               `git checkout main && git pull origin main`
  See unstaged changes      `git diff`
  Stage all changes         `git add .`
  Review staged changes     `git diff --staged`
  Commit                    `git commit -m "Description"`
  First push                `git push -u origin branch-name`
  Later pushes              `git push`
  Merge main into branch    `git merge main`
  Unstage file              `git restore --staged file.js`
  Delete local branch       `git branch -d branch-name`
  View history              `git log --oneline --graph --decorate --all`

------------------------------------------------------------------------

## 15. `fetch` vs `pull`

`git fetch` downloads information about remote changes without modifying
your current branch:

``` bash
git fetch origin
```

`git pull` fetches changes and integrates them into your current branch:

``` bash
git pull origin main
```

Check `git status` before pulling so you understand your current local
state.

------------------------------------------------------------------------

## 17. Recommended Daily Workflow

Start:

``` bash
git checkout main
git pull origin main
git checkout -b feature/my-feature
```

Work and review:

``` bash
git status
git diff
```

Commit:

``` bash
git add .
git diff --staged
git commit -m "Add my feature"
```

Push:

``` bash
git push -u origin feature/my-feature
```

Then:

``` text
Open Pull Request
      ↓
Run tests
      ↓
Code review
      ↓
Merge
```

After merge:

``` bash
git checkout main
git pull origin main
git branch -d feature/my-feature
```

------------------------------------------------------------------------

## 18. Recommended Team Rules

1.  Do not develop directly on `main`.
2.  Create a branch for each focused feature, fix, test, or refactor.
3.  Start new branches from an updated `main`.
4.  Commit small, logical units of work.
5.  Review `git diff` before committing.
6.  Merge production changes through Pull Requests.
7.  Require automated tests before merge.
8.  Require review for important changes.
9.  Never commit secrets.
10. Delete branches after they are merged.
11. Keep unrelated work in separate branches/PRs.
12. Make sure your branch works with current `main` before merging.

------------------------------------------------------------------------

# Quick Mental Model

``` text
Update main
    ↓
Create branch
    ↓
Make commit(s)
    ↓
Push commit(s)
    ↓
Merge branch to Development 
    ↓
Pull Request
    ↓
Tests + Review
    ↓
Merge
    ↓
Update local main
    ↓
Delete old branch
```

This keeps `main` stable while making changes easier to review, test,
and undo.
