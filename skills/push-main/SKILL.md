---
name: push-main
description: Reconcile requested application changes with the latest GitHub main branch and push a focused, verified commit to main. Use when asked to push or deploy this repository's changes through its main-only GitHub Actions workflow.
---

# Push changes to main

Use this workflow for `chiefxai/attendance-call-service` when the user asks to push the current requested work. The production deploy workflow runs from `main`, so target `main` unless the user says otherwise. Creating this skill does not itself authorize a push; push only when the user asks.

## Keep the change focused

1. Inspect the workspace status and identify files changed for the current request. Leave unrelated edits, generated output, `.env` files, credentials, and private keys out of the commit. Do not clean or reset the user's workspace.
2. Read the current remote `main` head and tree before preparing the commit. If the working branch is behind or based on an older `main`, preserve newer remote work. For each overlapping file, start from the current `main` version and apply only the requested changes; do not replace it with an older whole-file copy.
3. Use the GitHub connector when available. Fetch only overlapping files and required context. Keep source contents in tool state; do not print large files into the conversation. Build the new tree on the current `main` tree, with the current `main` SHA as the commit parent.
4. Make one focused commit. Move `main` using an expected-SHA check and a fast-forward update. Never force-push. If the expected SHA no longer matches, reread `main` and reconcile again before retrying.

## Validate and report

- Run relevant lightweight syntax, formatting, or build checks when practical. Do not claim a frontend build or tests passed unless they ran successfully.
- After pushing, verify remote `main` points to the new commit. Check whether the main-only GitHub Actions workflow started and report its state when available.
- In the final reply, include the commit link, the changes, checks actually performed, and workflow or deployment status. Never include secrets or credential values.

## Git fallback

If the GitHub connector is unavailable, use the configured Git remote and credentials. Fetch `main`, reconcile without discarding local edits, commit only selected files, and use a normal fast-forward push. Stop and report a specific authentication or conflict problem if the operation cannot proceed safely; do not force-push.
