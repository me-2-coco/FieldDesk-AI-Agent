process.on('disconnect', () => process.exit(0));
if (process.env.LAB_IGNORE_TERM === 'true') process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
