# Production manual-review trial

Production remains read-only by default. To allow the existing repair automation
while reserving final Recloud submission for an information clerk, explicitly set:

```
FIELDDESK_PRODUCTION_RECLOUD_MODE=manual-review
RECLOUD_MANUAL_REVIEW_REQUIRED=true
```

This permits the existing DRY_RUN and RECLOUD_WRITE_ENABLED switches to be
configured for real writes. It does not enable them on its own. An absent or
misspelled mode retains the original write prohibition. In this mode a missing,
false, or misspelled manual-review guard prevents startup. Production account,
HTTPS, bootstrap secret and phone privacy checks remain in effect.

Do not enable the cloud worker until the local worker has been stopped and data,
attachments, credentials and printing have been migrated and verified. The
maintenance HTTPS endpoint is not evidence that business deployment is complete.
