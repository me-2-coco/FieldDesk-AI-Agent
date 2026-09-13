const test=require('node:test'),assert=require('node:assert/strict');
const {JsonReceiptPreparationStore}=require('../database/receipt-preparation-store');
const {MemoryDocumentBackend}=require('../database/storage-backend');
const {reviewVersion}=require('../services/review-confirmation');
const {buildHomeTodos}=require('../services/home-todos');
const {completedInformationTodos}=require('../services/completed-information-todos');
test('manual confirmation moves only review todo; retains business status and identity; duplicate safe',async()=>{
 const o={rmaNo:'LAB-REVIEW',status:'REPAIR_COMPLETED_PENDING_SHIPMENT',technicianId:'TECH',inspectionOnlyHandoff:{status:'PENDING_INFORMATION',updatedAt:'2026-01-01'},repairCompletion:{}};
 const store=new JsonReceiptPreparationStore(new MemoryDocumentBackend([o]));
 const user={role:'INFORMATION_CLERK',userId:'CLERK',displayName:'测试信息员'},input={confirmed:true,version:reviewVersion(o)};
 await assert.rejects(()=>store.confirmInformationReview(o.rmaNo,input,{role:'TECHNICIAN'}),/只有/);
 await assert.rejects(()=>store.confirmInformationReview(o.rmaNo,{...input,version:'old'},user),/更新/);
 await assert.rejects(()=>store.confirmInformationReview(o.rmaNo,{...input,confirmed:false},user),/请确认/);
 await store.confirmInformationReview(o.rmaNo,input,user);await store.confirmInformationReview(o.rmaNo,input,user);
 const saved=(await store.readAll())[0];assert.equal(saved.timeline.length,1);assert.equal(saved.status,o.status);assert.equal(saved.inspectionOnlyHandoff.status,'PENDING_INFORMATION');
 const todos=buildHomeTodos([saved],[],user);assert.equal(todos.items.filter(i=>i.group==='review').length,0);assert.ok(todos.items.some(i=>i.group==='materials'));
 assert.equal(completedInformationTodos([saved],[])[0].completedBy,'测试信息员');
 await store.markRepairReviewConfirmed(o.rmaNo);assert.equal(completedInformationTodos(await store.readAll(),[]).length,1);
});
