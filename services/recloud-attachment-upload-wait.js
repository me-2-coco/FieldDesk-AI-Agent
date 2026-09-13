// Slow mobile videos need a bounded transfer budget, not a 30-second UI budget.
function attachmentUploadTimeout(files = []) {
  const bytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.size) || 0), 0);
  return Math.min(15 * 60_000, Math.max(120_000, 60_000 + Math.ceil(bytes / (128 * 1024)) * 1000));
}

async function waitForAttachmentDialog(dialogs) {
  await dialogs.first().waitFor({ state: 'visible', timeout: 15_000 });
  if (await dialogs.count() !== 1) {
    const error = new Error('附件上传窗口不唯一');
    error.code = 'RECLOUD_REPAIR_ATTACHMENT_DIALOG_AMBIGUOUS';
    throw error;
  }
  return dialogs.first();
}

module.exports = { attachmentUploadTimeout, waitForAttachmentDialog };
