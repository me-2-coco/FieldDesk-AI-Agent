const test=require('node:test');
const assert=require('node:assert/strict');
const {buildHomeTodos}=require('../services/home-todos');
const {createApp}=require('../server');
const orders=[{rmaNo:'SYNTH-1',technicianId:'T1',status:'ON_HOLD',updatedAt:new Date().toISOString(),hold:{reason:'网点缺件'},supervisionOrders:[{id:'M1',readBy:[]}],manufacturerWarrantyConversion:{requested:true,status:'PENDING_APPROVAL'}},{rmaNo:'SYNTH-2',technicianId:'T2',status:'ON_HOLD',updatedAt:new Date().toISOString(),hold:{reason:'总部缺件'}}];
const tasks=[{id:'TASK-1',rmaNo:'SYNTH-1',status:'FAILED'},{id:'TASK-2',rmaNo:'SYNTH-2',status:'FAILED'}];
test('technician todos are self-only for both role formats; unknown roles fail closed',()=>{
 for(const role of ['TECHNICIAN','technician']) {
  const tech=buildHomeTodos(orders,tasks,{userId:'T1',role});
  assert.ok(tech.items.every(i=>i.rmaNo==='SYNTH-1'));
  assert.deepEqual(tech.groups.map(g=>g.id),['exceptions','shortage','messages','materials']);
  assert.equal(tech.groups.find(g=>g.id==='shortage').count,1);
 }
 assert.equal(buildHomeTodos(orders,tasks,{}).items.length,0);
 assert.equal(buildHomeTodos(orders,tasks,{role:'TECHNICIAN'}).items.length,0);
 const info=buildHomeTodos(orders,tasks,{role:'INFORMATION_CLERK'});
 assert.equal(info.groups.find(g=>g.id==='warranty').count,1);
 assert.equal(info.groups.find(g=>g.id==='shortage').count,2);
 assert.equal(buildHomeTodos(orders,tasks,{role:'ADMIN'}).groups.find(g=>g.id==='sync').count,2);
});
test('todo endpoint enforces role and own-order boundary',async t=>{
 for(const role of ['TECHNICIAN','ADMIN','INFORMATION_CLERK','WAREHOUSE']){
  const app=createApp({}, {readAll:async()=>orders},{getCurrentUser:()=>({role,userId:'T1'})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>{server.closeAllConnections();server.close()});
  const res=await fetch(`http://127.0.0.1:${server.address().port}/api/home/todos`);
  assert.equal(res.status,role==='WAREHOUSE'?403:200);
  if(role==='TECHNICIAN'){const {data}=await res.json();assert.ok(data.items.every(i=>i.rmaNo==='SYNTH-1'));}
 }
});
