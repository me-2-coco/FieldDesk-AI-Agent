const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

test('warehouse selects active technician accounts; allocation resolves authoritative name', async t => {
  const accounts = [
    {userId:'TEST-A',displayName:'合成师傅',role:'TECHNICIAN',active:true,phone:'private'},
    {userId:'TEST-B',displayName:'停用师傅',role:'TECHNICIAN',active:false},
    {userId:'TEST-C',displayName:'库管',role:'WAREHOUSE'},
    {userId:'TEST-D',displayName:'已删除',role:'TECHNICIAN',deletedAt:'2026-01-01'},
  ];
  let role = 'WAREHOUSE';
  let recipient;
  const app = createApp({}, {readAll:async()=>[]}, {
    getCurrentUser:()=>({userId:'TEST-OP',role}),
    accountStore:{list:async()=>accounts},
    inventoryStore:{allocate:async(code,quantity,technician)=>{recipient=technician;return {}}},
  });
  const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  t.after(()=>{server.closeAllConnections();server.close()});
  const url=`http://127.0.0.1:${server.address().port}/api/inventory`;
  const list=await fetch(url+'/technicians');
  assert.equal(list.status,200);
  assert.deepEqual((await list.json()).data,[{userId:'TEST-A',displayName:'合成师傅'}]);
  const allocate=(id)=>fetch(url+'/allocate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partCode:'SYNTHETIC',quantity:1,technicianId:id,technicianName:'伪造姓名'})});
  assert.equal((await allocate('TEST-A')).status,200);
  assert.equal(recipient.displayName,'合成师傅');
  for(const id of ['TEST-B','TEST-C','TEST-D','UNKNOWN','']) assert.equal((await allocate(id)).status,400);
  for(const deniedRole of ['TECHNICIAN','INFORMATION_CLERK']) {
    role=deniedRole;
    assert.equal((await fetch(url+'/technicians')).status,403);
    assert.equal((await allocate('TEST-A')).status,403);
  }
});
