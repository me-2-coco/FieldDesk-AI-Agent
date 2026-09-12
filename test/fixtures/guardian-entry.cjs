require('./scripts/start-service-guardian').main({ intervalMs: 100 }).catch(() => { process.exitCode = 1; });
