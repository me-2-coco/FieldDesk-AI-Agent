# FieldDesk-Agent collaboration rules

These rules apply to every human and Codex session working in this repository.

## Repository scope

- Work only in `fielddesk-ai/FieldDesk-Agent` for this project.
- Start every implementation from a GitHub Issue with a clear goal and acceptance criteria.
- Keep one task per Issue, branch, and pull request.
- Preserve unrelated local changes. Never stage, overwrite, discard, or commit another person's work.

## Required Git workflow

1. Fetch the latest `main` from `origin` before starting.
2. Create a branch from the latest `main` named `codex/issue-<number>-<task-name>`.
3. Never commit or push directly to `main`.
4. Make only the changes required by the linked Issue.
5. Run the relevant tests before delivery and report the results.
6. Commit only files belonging to the task, then push the current branch to `origin`.
7. Create a pull request that links the Issue using `Closes #<number>`.
8. Do not merge the pull request. The repository owner reviews and merges it.

## Security and data rules

- Never commit passwords, API keys, tokens, credentials, `.env` files, or private configuration.
- Never commit `runtime/`, `uploads/`, generated artifacts, or real customer/business data.
- Use synthetic or anonymized fixtures for tests and examples.
- Stop and notify the repository owner if completing a task would expose sensitive data.
- Never force-push or rewrite shared branch history.

## Completion standard

A task is complete only when its tests have been run, its branch has been pushed, and its pull request is ready for owner review. Local-only changes are not a completed delivery.
