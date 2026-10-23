---
name: git-collection
description: Implement or review safe Git pre-push capture, remote verification, hook installation and removal.
---
# Git collection
1. Inspect `docs/architecture.md` and existing hook before modifying.
2. Hook receives remote name/URL as args and `local_ref local_sha remote_ref remote_sha` lines via stdin. Persist the attempt without blocking push.
3. `pre-push` runs BEFORE network push: do not mark success. Verify remote later, record VERIFIED/UNVERIFIED/REJECTED where evidence permits.
4. Support multiple repositories, branch creation/deletion, force push and zero SHA conservatively; never fabricate a commit range.
5. Test hook chaining, paths with spaces, duplicate attempts, failures, and no remote access.
