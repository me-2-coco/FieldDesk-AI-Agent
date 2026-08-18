# FieldDesk-Agent collaboration rules

These rules apply to every human and Codex session working in this repository.

## Repository scope

- Work only in `fielddesk-ai/FieldDesk-Agent` for this project.
- Preserve unrelated local changes. Never stage, overwrite, discard, or commit another person's work.
- Do not delete tracked project files unless the repository owner explicitly requests the deletion.

## Flexible development workflow

- Routine development does not require approval, a separate Issue, or a pull request for every edit.
- `me-2-coco` works freely on the long-lived branch `dev/me-2-coco`.
- The collaborator may edit, test, commit, and push that development branch without owner approval.
- Never commit or push directly to `main`; the repository owner controls integration into `main`.
- Use Issues for larger assignments or progress tracking, and use a pull request only when work is ready to enter `main`.

## Visibility and recoverability

- Fetch the latest remote state before starting work.
- Make normal, descriptive commits so changes remain reviewable and recoverable.
- Push the current development branch at the end of every work session and after meaningful milestones.
- Local-only changes are not visible to the repository owner and are not considered delivered.
- Never delete `main`, `dev/me-2-coco`, or another shared branch.
- Never force-push, rewrite shared history, or bypass normal Git history.

## Quality, security, and data rules

- Run relevant tests before pushing and report any failures.
- Never commit passwords, API keys, tokens, credentials, `.env` files, or private configuration.
- Never commit `runtime/`, `uploads/`, generated artifacts, or real customer/business data.
- Use synthetic or anonymized fixtures for tests and examples.
- Stop and notify the repository owner if completing a task would expose sensitive data.

## Integration into main

- The collaborator does not need approval for routine work on `dev/me-2-coco`.
- When the owner decides work is ready for release, create a pull request from `dev/me-2-coco` to `main`.
- The collaborator must not merge that pull request; the repository owner decides when to merge it.
