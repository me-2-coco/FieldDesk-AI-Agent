const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs/promises');
const os=require('os');
const path=require('path');
const {parseReturnRow}=require('../connectors/recloud-return-logistics');
const {ReturnLogisticsService}=require('../services/return-logistics-service');
const order={rmaNo:'TEST-RMA-1',sn:'TEST-SN-1'};
const row={'寄修单号':order.rmaNo,'产品序列号':order.sn,'发货物流状态':'已发货','物流单号':'RETURN-1','取件物流单号':'INBOUND-1','物流签收时间':'2026-09-01 12:00:00'};
test('return identity is checked and inbound tracking/signature never become return values',()=>{
 const value=parseReturnRow(row,order);assert.equal(value.trackingNo,'RETURN-1');assert.equal(value.signedAt,undefined);assert.equal(value.status,'SHIPPED');
 assert.throws(()=>parseReturnRow({...row,'产品序列号':'OTHER'},order));
 assert.throws(()=>parseReturnRow({...row,'寄修单号':'OTHER'},order));
 assert.equal(parseReturnRow({...row,'发货物流状态':''},order).status,'UNKNOWN');
 assert.equal(parseReturnRow({...row,'发货物流状态':'已下单'},order).status,'PENDING');
});
test('failed reads preserve last successful result and unrelated order data',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shipping-sync-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let fail=false;const service=new ReturnLogisticsService(path.join(dir,'cache.json'),async()=>{if(fail)throw Error('offline');return parseReturnRow(row,order)});
 const success=await service.sync(order);fail=true;await assert.rejects(service.sync(order));
 const [decorated]=await service.decorate([{...order,status:'REPAIR_COMPLETED_PENDING_SHIPMENT',repairCompletion:{submittedAt:'original'}}]);
 assert.equal(decorated.recloudShipping.syncedAt,success.syncedAt);assert.equal(decorated.recloudShipping.trackingNo,'RETURN-1');assert.ok(decorated.recloudShipping.error);
 assert.equal(decorated.repairCompletion.submittedAt,'original');assert.equal(decorated.status,'REPAIR_COMPLETED_PENDING_SHIPMENT');
 assert.equal((await service.decorate([{...order,sn:'CHANGED'}]))[0].recloudShipping,null);
});
test('batch continues after an individual error; concurrent requests deduplicate',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shipping-sync-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let calls=0;const service=new ReturnLogisticsService(path.join(dir,'cache.json'),async o=>{calls++; if(o.rmaNo==='BAD')throw Error('bad');return {...parseReturnRow(row,order),rmaNo:o.rmaNo}});
 await Promise.all([service.sync(order),service.sync(order)]);assert.equal(calls,1);
 service.start([{...order,rmaNo:'BAD'},order]);await service.work;assert.equal(service.job.done,2);assert.equal(service.job.failed,1);assert.equal(service.job.running,false);
});
test('shipping synchronization rejects unauthorized roles and unknown orders before reading Recloud',async t=>{
 const {createApp}=require('../server');let user={userId:'TEST',role:'TECHNICIAN'},calls=0;
 const app=createApp({}, {listShippingOrders:async()=>[order]}, {syncService:{},getCurrentUser:()=>user,operationalLogger:{write(){}},returnLogisticsService:{job:{running:false},sync:async()=>{calls++;return {status:'SHIPPED'}},start:()=>{calls++;return {running:true}},decorate:async rows=>rows}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=rmaNo=>fetch(base+'/api/shipping/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rmaNo})});
 assert.equal((await post(order.rmaNo)).status,403);assert.equal((await fetch(base+'/api/shipping/sync-status')).status,403);assert.equal(calls,0);
 user={userId:'TEST',role:'INFORMATION_CLERK'};assert.equal((await post('OTHER')).status,404);assert.equal(calls,0);
 assert.equal((await post(order.rmaNo)).status,200);assert.equal(calls,1);assert.equal((await post('')).status,202);assert.equal(calls,2);
});
test('automatic list synchronization includes traces and skips fresh cache',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shipping-auto-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let calls=0;const service=new ReturnLogisticsService(path.join(dir,'cache.json'),async(o,options)=>{calls++;assert.equal(options.includeTraces,true);return {...parseReturnRow(row,o),traces:[{at:'2026-09-14 10:00:00',description:'测试运输记录'}],traceStatus:'SUCCESS'}});
 await service.ensureAll([order]);await service.work;assert.equal(calls,1);
 await service.ensureAll([order]);await service.ensure(order);assert.equal(calls,1);
 const decorated=await service.decorate([order]);assert.equal(decorated[0].recloudShipping.traces.length,1);
});
test('opening an order automatically fills missing traces, with failure backoff',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shipping-auto-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let calls=0;const service=new ReturnLogisticsService(path.join(dir,'cache.json'),async()=>{calls++;throw Error('offline')});
 await service.save(order.rmaNo,{...parseReturnRow(row,order),attemptedAt:new Date().toISOString()});
 await service.ensure(order);await assert.rejects(service.inflight.get(order.rmaNo));assert.equal(calls,1);
 await service.ensure(order);assert.equal(calls,1);
 assert.equal(service.needsRefresh(order,{sn:order.sn,status:'SHIPPED',traceStatus:'SUCCESS',attemptedAt:new Date(Date.now()-31*60000).toISOString()}),true);
});
