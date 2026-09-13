// Server-owned setting only. Missing/invalid settings fail closed for trial use.
function requiresManualReview(env = process.env) {
  return env.RECLOUD_MANUAL_REVIEW_REQUIRED !== 'false';
}
function assertAutomaticSubmitAllowed() {
  if (requiresManualReview()) throw Object.assign(new Error('待信息员在瑞云审核并手动提交，自动提交已关闭'), {
    code: 'RECLOUD_MANUAL_REVIEW_REQUIRED', permanent: true, status: 409,
  });
}
module.exports = { requiresManualReview, assertAutomaticSubmitAllowed };
