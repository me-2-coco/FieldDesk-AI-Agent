const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveReportedFault}=require('../services/reported-fault');
const {createReportedFaultLoader,assertReportedFaultForSubmission}=require('../services/reported-fault');
test('completion rejects missing or substituted source text',()=>{
 assert.throws(()=>assertReportedFaultForSubmission({},'机器故障# 测试'),{code:'REPORTED_FAULT_REQUIRED'});
 assert.throws(()=>assertReportedFaultForSubmission({reportedFault:'水泵故障'},'机器故障# 测试'),{code:'REPORTED_FAULT_MISMATCH'});
 assert.doesNotThrow(()=>assertReportedFaultForSubmission({reportedFault:'水泵故障'},'水泵故障# 测试'));
});
test('missing description retries transient reads and persists only exact order',async()=>{
 let calls=0;const saved=[];
 const load=createReportedFaultLoader({query:async()=>{if(++calls===1)throw new Error('timeout');return {rmaNo:'TEST',reportedFault:'水泵故障'}},save:async(...v)=>saved.push(v)});
 const results=await Promise.all([load({rmaNo:'TEST'}),load({rmaNo:'TEST'})]);
 assert.equal(calls,2);assert.deepEqual(saved,[['TEST','水泵故障']]);assert.equal(results[1].reportedFault,'水泵故障');
});
test('wrong order and confirmed empty source never become a saved description',async()=>{
 for(const detail of [{rmaNo:'OTHER',reportedFault:'其他描述'},{rmaNo:'TEST',reportedFault:''}]){
 const load=createReportedFaultLoader({query:async()=>detail,save:async()=>assert.fail('must not save')});
 await assert.rejects(load({rmaNo:'TEST'}));
 }
});
test('login failure is not hammered and a later retry can recover',async()=>{
 let calls=0;const load=createReportedFaultLoader({query:async()=>{if(++calls===1)throw Object.assign(new Error('login'),{code:'RECLOUD_LOGIN_REQUIRED'});return {rmaNo:'TEST',reportedFault:'原文'}},save:async()=>{}});
 await assert.rejects(load({rmaNo:'TEST'}),{code:'RECLOUD_LOGIN_REQUIRED'});
 assert.equal(calls,1);assert.equal((await load({rmaNo:'TEST'})).reportedFault,'原文');
});
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
