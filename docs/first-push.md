# Push checklist

1. Set the repo's commit identity to your GitHub no-reply address:
   `git config user.email "<id>+<username>@users.noreply.github.com"` and `git config user.name "<username>"`.
2. Create `~/.config/careeros/denylist.txt` (outside the repo) with one entry per line:
   your real name variants, personal emails, phone, street address, employer, ID numbers.
3. Run `node scripts/privacy/scan.mjs --history --require-denylist`. It must print "clean".
4. Run `docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:v8.30.1 git /repo --redact --log-opts="--all" --config /repo/.gitleaks.toml`.
5. Add the remote and push. The pre-push hook re-runs the scan on every push.
6. On GitHub: Settings > Branches > protect both `main` and `develop`, require the `checks` workflow to pass.

## Branch strategy

- `develop` is the default branch; `main` is production, merged only when stable.
- Feature branches merge into `develop`.
- Remove the worktree and delete the branch after each merge.

## Note

If a personal email ever lands in history, rewrite before pushing:
`git rebase -r --root --exec 'git commit --amend --no-edit --reset-author'`.
