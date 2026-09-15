# Completion timing diagnostics

`RECLOUD_DEPENDENCY_TIMING` records each prerequisite check, with task ID,
creation/check timestamps, retry count and readiness. `taskAgeMs` is task age,
not pure dependency wait (it can include scheduling or recovery). The first
blocked check through the ready check bounds observed prerequisite waiting.

`RECLOUD_PHASE_TIMING` records start/end timestamps, monotonic elapsed milliseconds,
order ID, task context when available and whether the operation returned normally.
No payload, filenames, credentials, response bodies or error messages are logged.
`success` means the operation returned, not that the business task is SUCCESS;
consult the outbox for business status and manual-review handoff.

Totals are nested; never sum a total with its children:

- `sync_execute_total`: ready task processing, including adapter and local finalization.
- `sync_adapter_total`: adapter work including browser queue/session acquisition.
- `completion_open_service_order`: navigating to the target service order.
- `completion_orchestrator_total`: completion flow after opening the order.
- `completion_upload_total`: full upload, including guard, files, dialog, transfer,
  saving and reload. `completion_upload_transfer` is only the dialog-close wait.
- Attachment pre/post-checks, identity preparation, field verification attempts
  and retry waits, submit-ready wait, return flags and checkpoints are separate.

Use timestamps to attribute uncovered intervals and existing queue timing for
queue duration. Retries have distinct retry counts. Dependency checks repeat;
do not add their cumulative ages. Logging does not change waits, write guards,
retry policy, final-submit policy or business data. Do not replay completed
orders to obtain historical timings: collect the next normal order instead.
