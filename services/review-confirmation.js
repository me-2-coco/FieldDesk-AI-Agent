const {createHash}=require('node:crypto');
function reviewVersion(order) {
 const h=order.inspectionOnlyHandoff || {};
 return createHash('sha256').update(JSON.stringify([h.updatedAt,h.createdAt,h.message,order.repairCompletion?.submittedAt])).digest('hex');
}
module.exports={reviewVersion};
