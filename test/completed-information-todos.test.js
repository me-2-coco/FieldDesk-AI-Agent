const test=require('node:test');const assert=require('node:assert/strict');
const {completedInformationTodos}=require('../services/completed-information-todos');
test('completion requires evidence and excludes pending submissions and unpaid notes',()=>{
 const order={rmaNo:'LAB-1',inspectionOnlyHandoff:{status:'PENDING_INFORMATION'},paymentFollowup:{entries:[{paid:false,syncStatus:'CONFIRMED',syncedAt:'2026-01-01'}]}};
 assert.deepEqual(completedInformationTodos([order],[{id:'t1',rmaNo:'LAB-1',status:'SUCCESS',resultStatus:'AWAITING_INFORMATION_CLERK',updatedAt:'2026-01-01'}]),[]);
 const done={...order,inspectionOnlyHandoff:{status:'CONFIRMED',confirmedAt:'2026-01-02'},partsShortage:{status:'RESOLVED',resolvedAt:'2026-01-03',resolvedBy:{displayName:'测试信息员'}}};
 const rows=completedInformationTodos([done],[]);assert.equal(rows.length,2);assert.equal(rows[0].completedBy,'测试信息员');assert.ok(rows.every(r=>r.status==='COMPLETED'));
});
test('paid but unverified remark stays pending; verified payment retains completion evidence',()=>{
 const order={rmaNo:'LAB-2',paymentFollowup:{entries:[{paid:true,syncStatus:'PENDING',at:'2026-01-01',note:'收到'}]}};
 assert.equal(completedInformationTodos([order],[]).length,0);
 order.paymentFollowup.entries[0]={...order.paymentFollowup.entries[0],syncStatus:'CONFIRMED',syncedAt:'2026-01-02',operatorName:'测试员'};
 const rows=completedInformationTodos([order],[]);assert.equal(rows.length,1);assert.equal(rows[0].type,'PAYMENT_FOLLOWUP');
 assert.equal(completedInformationTodos([order],[{status:'SUCCESS',resultStatus:'SUCCESS',rmaNo:'LAB-2'}]).length,1);
});
