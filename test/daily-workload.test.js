const test = require('node:test');
const assert = require('node:assert/strict');
const technicians = [{userId:'a',displayName:'师傅甲',repairSpecialties:['扫地机','洗地机']},{userId:'b',displayName:'师傅乙',repairSpecialties:['扫地机']}];
const row = (rmaNo, treatmentMode, extras={}) => ({rmaNo,treatmentMode,technicianId:'a',productLine:'扫地机',repairCompletion:{submittedAt:'2026-09-09T02:00:00Z'},...extras});
test('natural day uses Shanghai midnight regardless of host timezone', async()=>{
  const {shanghaiDay}=await import('../frontend/src/shared/dailyWorkload.js');
  assert.equal(shanghaiDay('2026-09-08T15:59:59Z'),'2026-09-08');
  assert.equal(shanghaiDay('2026-09-08T16:00:00Z'),'2026-09-09');
  assert.equal(shanghaiDay('2026-09-09T16:00:00Z'),'2026-09-10');
});
test('four categories, product separation, deduplication, zero rows and excluded drafts',async()=>{
  const {dailyWorkload}=await import('../frontend/src/shared/dailyWorkload.js');
  const orders=[row('1','REPAIR'),row('1','REPAIR'),row('2','ABANDONED'),row('3','DEBUGGING'),row('4','INSPECTION_ONLY'),row('5','REPAIR',{productLine:'洗地机'}),row('6','REPAIR',{repairCompletion:null}),row('7','ON_HOLD'),row('8','REPAIR',{repairCompletion:{submittedAt:'2026-09-08T15:00:00Z'}})];
  const boards=dailyWorkload({orders,technicians,user:{role:'admin'},day:'2026-09-09'});
  assert.deepEqual(boards[0].totals,{repair:1,abandoned:1,debugging:1,inspection:1,total:4});
  assert.equal(boards[0].people.find(p=>p.userId==='b').total,0);
  assert.equal(boards[1].totals.total,1);
});
test('technician only sees their own rows even if response contains others',async()=>{
  const {dailyWorkload}=await import('../frontend/src/shared/dailyWorkload.js');
  const boards=dailyWorkload({orders:[row('1','REPAIR'),row('2','REPAIR',{technicianId:'b'})],technicians,user:{id:'a',name:'甲',role:'technician'},day:'2026-09-09'});
  assert.equal(boards[0].people.length,1);
  assert.equal(boards[0].totals.total,1);
});
