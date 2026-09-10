const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveReportedFault}=require('../services/reported-fault');
const {JsonReceiptPreparationStore}=require('../database/receipt-preparation-store');
test('empty index does not mask pending receipt description; orders stay isolated',()=>{
 assert.equal(resolveReportedFault('TEST-A',[{rmaNo:'TEST-A',reportedFault:''},{rmaNo:'OTHER',reportedFault:'其他故障'},{rmaNo:'TEST-A',reportedFault:'万向轮损坏'}]),'万向轮损坏');
 assert.equal(resolveReportedFault('TEST-B',[{rmaNo:'TEST-A',reportedFault:'故障'}]),'');
});
test('description refresh preserves workflow and never overwrites with empty values',async()=>{
 let rows=[{rmaNo:'TEST-A',reportedFault:'',status:'COMPLETED',updatedAt:'unchanged',repairCompletion:{repairMeasure:'测试'}}];
 const store=new JsonReceiptPreparationStore({read:async()=>structuredClone(rows),write:async value=>{rows=structuredClone(value)}});
 const original=structuredClone(rows[0]);
 await store.saveReportedFault('TEST-A','万向轮损坏');
 assert.deepEqual(rows[0],{...original,reportedFault:'万向轮损坏'});
 await store.saveReportedFault('TEST-A','');
 assert.equal(rows[0].reportedFault,'万向轮损坏');
 await store.saveReportedFault('TEST-A','新的用户描述');
 assert.equal(rows[0].reportedFault,'新的用户描述');
 assert.equal(await store.saveReportedFault('OTHER','其他描述'),null);
 assert.equal(rows.length,1);
});
