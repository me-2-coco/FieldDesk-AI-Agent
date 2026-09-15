const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
// Execute just this route with synthetic stores; never initialize the server.
test('local completion context returns without querying Recloud',async()=>{
  const source=fs.readFileSync(require.resolve('../server'),'utf8');
  const start=source.indexOf('  app.post("/api/repairs/completion/context"');
  const end=source.indexOf('  app.post("/api/repairs/completion/attachments"',start);
  let handler;let queries=0;
  const order={rmaNo:'synthetic',status:'REPAIR_COMPLETION_DRAFT',technicianWarranty:'保内'};
  const context={app:{post:(path,fn)=>handler=fn},receiptStore:{readAll:async()=>[order]},
    loadReportedFault:async o=>{queries++;return {...o,reportedFault:'verified'};},
    hydratePartApplications:async()=>[],inventoryStore:{usedPartsForOrder:async()=>[]},
    getOutOfWarrantyFeePolicy:()=>({noPartsService:false}),repairFeesForOrder:async()=>[],
    resolveOutOfWarrantyFee:()=>({canPrice:true,fee:0}),resolvePartsFee:()=>({canPrice:true,partsFee:0}),
  };
  vm.runInNewContext(source.slice(start,end),context);
  let result;const res={json:value=>result=value};const next=e=>{throw e;};
  await handler({body:{rmaNo:'synthetic',localOnly:true}},res,next);
  assert.equal(queries,0);assert.equal(result.success,true);assert.equal(result.data.order.reportedFault,undefined);
  await handler({body:{rmaNo:'synthetic'}},res,next);
  assert.equal(queries,1);assert.equal(result.data.order.reportedFault,'verified');
});
