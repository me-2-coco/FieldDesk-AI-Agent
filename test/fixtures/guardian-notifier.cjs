// Deliberately no network transport in lifecycle integration tests.
exports.createFeishuAlertSender = () => async () => ({ messageId: 'synthetic' });
exports.createAlertNotifier = () => ({ deliver: async () => ({ status: 'SENT' }) });
