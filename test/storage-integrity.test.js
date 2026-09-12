const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonDocumentBackend } = require('../database/storage-backend');
const { createApp } = require('../server');

test('malformed coordination data fails closed without resetting records', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fielddesk-integrity-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'coordination.json');
 const raw='{"locks":{},"idempotency":{"saved":{"state":"SUCCESS"}},"audits":[]}\nfragment';
 await fs.writeFile(file,raw);
 const backend=new JsonDocumentBackend(file,{locks:{},idempotency:{},audits:[]});
 await assert.rejects(backend.read(),{code:'LOCAL_DATA_CORRUPT',status:503});
 await assert.rejects(backend.update(d=>{d.audits.push({});}),{code:'LOCAL_DATA_CORRUPT'});
 assert.equal(await fs.readFile(file,'utf8'),raw);
});

test('concurrent snapshot writers use independent staging files and leave a complete document',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fielddesk-atomic-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json');
 const writers=Array.from({length:12},()=>new JsonDocumentBackend(file,{}));
 const values=writers.map((_,i)=>({id:i,text:String(i).repeat(80000+i*1000)}));
 await Promise.all(writers.map((w,i)=>w.write(values[i])));
 const final=JSON.parse(await fs.readFile(file,'utf8'));
 assert.deepEqual(final,values[final.id]);
 assert.deepEqual(await fs.readdir(dir),['state.json']);
});

for(const corrupted of [false,true])test(`readiness checks coordination data: corrupted=${corrupted}`,async t=>{
 const app=createApp({},null,{env:{DRY_RUN:'true',FIELDDESK_STORAGE_DRIVER:'memory'},
  recloudRecoveryWatchdogEnabled:false,resumePendingRecloudReceipts:false,resumePendingRecloudDetections:false,resumePendingRecloudServiceOrders:false,
  operationalLogger:{write(){}},coordinationStore:{backend:{read:async()=>{if(corrupted)throw Object.assign(new Error('corrupt'),{code:'LOCAL_DATA_CORRUPT'});return {locks:{},idempotency:{},audits:[]};}}}});
 const server=app.listen(0,'127.0.0.1');t.after(()=>server.close());
 await new Promise(r=>server.once('listening',r));
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api/ready`);
 assert.equal(r.status,corrupted?503:200);
 assert.equal((await r.json()).success,!corrupted);
});
