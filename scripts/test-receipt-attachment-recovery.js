const assert=require('node:assert/strict');
const {canRecoverAttachments,verifyRecoverySnapshots}=require('../services/receipt-attachment-recovery');
const now=Date.now();
const order={recloudReceiptAttachmentSyncStatus:'RESULT_UNKNOWN',recloudReceiptConfirmedAt:'confirmed',recloudProjectVerificationConfirmedAt:'confirmed',receiptAttachments:[{}],recloudReceiptAttachmentLastError:{at:new Date(now-301000).toISOString()}};
assert.equal(canRecoverAttachments(order,now),true);
for(const patch of [
  {recloudReceiptAttachmentRecoveryAttempts:2},
  {recloudReceiptConfirmedAt:''},
  {recloudProjectVerificationConfirmedAt:''},
  {recloudReceiptAttachmentConfirmedAt:'confirmed'},
  {recloudReceiptAttachmentLastError:{at:new Date(now).toISOString()}},
  {receiptAttachments:[]},
]) assert.equal(canRecoverAttachments({...order,...patch},now),false);
const files=[{name:'a'},{name:'b'}];
const snap={rmaNo:'synthetic',readBackVerified:true,attachments:[{name:'a'}]};
assert.deepEqual(verifyRecoverySnapshots('synthetic',files,snap,snap),[{name:'b'}]);
for(const patch of [
  {rmaNo:'wrong'}, {readBackVerified:false},
  {attachments:[{name:'a'},{name:'a'}]},
  {attachments:[{name:'legacy.jpeg'}]},
  {attachments:[{name:'a'},{name:'b'}]},
]) assert.throws(()=>verifyRecoverySnapshots('synthetic',files,snap,{...snap,...patch}));
assert.deepEqual(verifyRecoverySnapshots('synthetic',files,{...snap,attachments:files},{...snap,attachments:files}),[]);
console.log('Attachment recovery safety checks passed');
