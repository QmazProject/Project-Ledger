# Git Conflict Cheat Sheet

Use this guide from the Project Ledger repository root in Git Bash.

## Golden rules

- Run `git status` first. It tells you whether Git is merging, rebasing, or cherry-picking.
- Do not automatically choose **Accept Both Changes**. It can create duplicate properties or combine incompatible implementations.
- Treat **Current** and **Incoming** as hints, not as “old” and “new.” Their meaning depends on the active Git operation.
- Inspect the final code after using the Merge Editor.
- Test before continuing the Git operation.
- Use `--force-with-lease`, never plain `--force`, when a completed rebase requires rewriting your remote branch.

## 1. Identify the operation and conflicts

```bash
git status
git diff --name-only --diff-filter=U
git ls-files -u
```

Read the first lines from `git status`:

| Status says | Finish with | Cancel with |
|---|---|---|
| Merge in progress | `git merge --continue` or `git commit` | `git merge --abort` |
| Rebase in progress | `git rebase --continue` | `git rebase --abort` |
| Cherry-pick in progress | `git cherry-pick --continue` | `git cherry-pick --abort` |

Do not run `git pull` while one of these operations is unfinished.

## 2. Understand Current and Incoming

### Normal merge

- **Current** is normally the branch currently checked out.
- **Incoming** is normally the branch being merged into it.

### Rebase

- **Current** is commonly the upstream/base commit onto which Git is rebasing.
- **Incoming** is commonly your commit currently being replayed.

This is why **Accept Incoming** was correct for the recent `saveManualRow` conflict. Do not assume it will always be correct. Read both sides and decide what the finished program should contain.

### Merge Editor buttons

- **Accept Current**: keep only the Current block.
- **Accept Incoming**: keep only the Incoming block.
- **Accept Both**: keep both blocks. Use only when both are compatible and not duplicated.
- **Compare Changes**: inspect both sides before deciding.

The safest option for code with overlapping logic is often to edit the result manually.

## 3. Understand conflict markers

Git writes unresolved conflicts like this:

```text
<<<<<<< HEAD
Current version
=======
Incoming version
>>>>>>> commit-name
```

Replace the entire section with the intended final code and remove all three marker lines.

Check the repository for remaining markers:

```bash
rg -n '^(<<<<<<< |=======$|>>>>>>> )' . -g '!node_modules' -g '!dist'
```

No output means no standard conflict markers were found.

## 4. Project Ledger example

The incorrect **Accept Both** result placed legacy target fields and two `contract_amount` properties in `saveManualRow`:

```jsx
contract_amount: hasContract ? toNum(values.contract) : null,
target_qty: values.target === "" || values.target === null ? null : toNum(values.target),
unit: values.unit || null,
start_date: values.start || null,
target_completion: values.due || null,
actual_completion: values.finish || null,
actual_output: values.actual === "" || values.actual === null ? null : toNum(values.actual),
contract_amount: numOrNull(values.contract),
```

The correct final code is:

```jsx
project_id: id,
status: CLEAN(values.status) || null,
contract_amount: numOrNull(values.contract),
remarks: values.note || null,
updated_by: userId,
updated_at: new Date().toISOString(),
```

Why: `saveManualRow` stores project-level manual values. Target quantity, unit, target dates, actual completion, and actual output are saved through the dedicated `project_targets` workflow and its audited RPCs. The default inline single-target interface still uses that target system.

## 5. Review and validate the resolution

Review the edited file and whitespace:

```bash
git diff
git diff --check
```

Run the Project Ledger checks:

```bash
npm test
npm run build
npx eslint src/ProjectLedger.jsx
```

If a check fails, read the exact file and line. Do not assume every failure was caused by the conflict. Fix or document unrelated existing failures separately.

## 6. Mark the file resolved

Stage only the files you deliberately resolved:

```bash
git add src/ProjectLedger.jsx
git status
```

Git should say that all conflicts are fixed. If the file still appears under **Unmerged paths**, it is not staged as resolved.

Before continuing, inspect everything that will enter the commit:

```bash
git diff --cached --stat
git diff --cached --check
```

## 7. Finish the active operation

Use the command matching `git status`.

### Rebase

```bash
git -c core.editor=true rebase --continue
```

### Merge

```bash
git merge --continue
```

### Cherry-pick

```bash
git cherry-pick --continue
```

Run `git status` again afterward. Repeat the resolution workflow if Git reports another conflict.

## 8. Push safely

### Normal merge or normal commit

```bash
git push origin main
```

### Rebase that rewrote commits already on GitHub

```bash
git fetch origin
git status
git log --oneline --left-right main...origin/main
git push --force-with-lease origin main
```

`--force-with-lease` refuses to overwrite unexpected remote work that appeared after the last fetch. Only use it when rewriting the remote branch is intentional.

A successful rewritten push looks similar to:

```text
+ old-commit...new-commit main -> main (forced update)
```

## 9. Cancel or recover

If you are unsure and have not completed the operation, abort it safely:

```bash
git merge --abort
```

or:

```bash
git rebase --abort
```

or:

```bash
git cherry-pick --abort
```

If the operation already completed and you need to find the previous state:

```bash
git reflog --date=local
```

Do not run `git reset --hard` unless you have identified the exact recovery commit and intentionally accept losing uncommitted work.

## 10. Keep temporary files out of commits

Supabase CLI linkage metadata is local and should not normally be committed. Keep this in `.gitignore`:

```gitignore
supabase/.temp/
```

If the file was staged accidentally:

```bash
git restore --staged supabase/.temp/linked-project.json
```

If `vercel.json` shows only accidental line-ending changes:

```bash
git restore vercel.json
```

Always inspect a file before restoring it so intentional edits are not discarded.

## Quick workflow

```bash
# 1. Understand the operation
git status
git diff --name-only --diff-filter=U

# 2. Resolve in the editor, then check markers
rg -n '^(<<<<<<< |=======$|>>>>>>> )' . -g '!node_modules' -g '!dist'

# 3. Review and test
git diff --check
npm test
npm run build

# 4. Stage the resolved file
git add path/to/resolved-file
git status

# 5. Continue using the command named by git status
git -c core.editor=true rebase --continue

# 6. After a completed rebase, push intentionally
git fetch origin
git push --force-with-lease origin main
```

