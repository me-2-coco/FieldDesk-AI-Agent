const test=require('node:test');
const assert=require('node:assert/strict');
const {eligible,recordFollowup,appendRemark,currentFollowup}=require('../services/payment-followup');
const {buildHomeTodos}=require('../services/home-todos');
const {JsonReceiptPreparationStore}=require('../database/receipt-preparation-store');
const {MemoryDocumentBackend}=require('../database/storage-backend');
const user={role:'INFORMATION_CLERK',userId:'LAB-CLERK',displayName:'测试信息员'};
const order={rmaNo:'LAB-PAY',status:'ON_HOLD',technicianId:'LAB-TECH',hold:{category:'保外',reason:'用户要求暂放',remark:'原有备注',requestedAt:'2026-01-01'}};
const input={id:'lab-operation-000001',holdRequestedAt:order.hold.requestedAt,paid:false,note:'用户仍在考虑'};
test('only out-of-warranty non-shortage holds are payment followups',()=>{
 assert.equal(eligible(order),true);
 for(const reason of ['网点缺件','总部缺件','待补寄配件']) assert.equal(eligible({...order,hold:{...order.hold,reason}}),false);
 assert.equal(eligible({...order,hold:{...order.hold,category:'保内'}}),false);
});
test('append preserves originals and deduplicates uncertain retries; limit fails closed',()=>{
 const next=recordFollowup(order,input,user),entry=next.paymentFollowup.entries[0];
 assert.ok(next.hold.remark.startsWith(order.hold.remark+'\n'));
 assert.equal(recordFollowup(next,input,user),next);
 const remote=appendRemark('瑞云别人写的备注',entry);
 assert.equal(appendRemark(remote,entry),remote);
 assert.throws(()=>appendRemark('x'.repeat(5000),entry),/5000/);
 assert.throws(()=>appendRemark(entry.marker,entry),/不一致/);
 assert.equal(order.hold.remark,'原有备注');
});
test('permissions and stale holds cannot record payment; paid notifies only original technician',()=>{
 assert.throws(()=>recordFollowup(order,input,{...user,role:'TECHNICIAN'}),/只有/);
 assert.throws(()=>recordFollowup(order,{...input,holdRequestedAt:'old'},user),/批次/);
 const next=recordFollowup(order,{...input,paid:true},user);
 assert.equal(next.status,'ON_HOLD');
 assert.equal(buildHomeTodos([next],[],{role:'TECHNICIAN',userId:'LAB-TECH'}).items.some(i=>i.id.endsWith(':PAYMENT_RECEIVED')),true);
 assert.equal(buildHomeTodos([next],[],{role:'TECHNICIAN',userId:'OTHER'}).items.length,0);
 assert.throws(()=>recordFollowup(next,{...input,id:'lab-operation-000002'},user),/已经确认/);
 assert.equal(currentFollowup({...next,hold:{...next.hold,requestedAt:'new'}}),null);
});
test('serialized store retains both followups and only confirms read-back evidence',async()=>{
 const store=new JsonReceiptPreparationStore(new MemoryDocumentBackend([order]));
 await Promise.all([store.recordPaymentFollowup(order.rmaNo,input,user),store.recordPaymentFollowup(order.rmaNo,{...input,id:'lab-operation-000002',note:'再次跟进'},user)]);
 const saved=(await store.readAll())[0];
 assert.equal(saved.paymentFollowup.entries.length,2);
 await assert.rejects(()=>store.confirmPaymentRemark(order.rmaNo,input.id,'无对应备注'),/未确认/);
 await store.confirmPaymentRemark(order.rmaNo,input.id,saved.hold.remark);
 assert.equal((await store.readAll())[0].paymentFollowup.entries[0].syncStatus,'CONFIRMED');
});
