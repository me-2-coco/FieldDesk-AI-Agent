const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveAssignmentTarget,DEFAULT_ASSIGNEE}=require('../services/recloud-assignment-fallback');
test('matching technician wins without absence query',async()=>{
  const result=await resolveAssignmentTarget('测试师傅',async()=>['row'],async()=>{throw Error('unexpected');});
  assert.equal(result.name,'测试师傅'); assert.equal(result.fallback,false);
});
test('confirmed absent technician uses unique fallback',async()=>{
  const calls=[];
  const result=await resolveAssignmentTarget('新师傅',async name=>{calls.push(name);return name===DEFAULT_ASSIGNEE?['row']:[];},async()=>true);
  assert.equal(result.name,DEFAULT_ASSIGNEE); assert.equal(result.fallback,true);
  assert.deepEqual(calls,['新师傅',DEFAULT_ASSIGNEE]);
});
test('ambiguous and unverified absence never select fallback',async()=>{
  for(const rows of [[],['a','b']]) {
    let calls=0;
    await assert.rejects(resolveAssignmentTarget('测试师傅',async()=>{calls++;return rows;},async()=>false));
    assert.equal(calls,1);
  }
});
test('query errors propagate, no fallback on timeout',async()=>{
  let calls=0;
  await assert.rejects(resolveAssignmentTarget('测试师傅',async()=>{calls++;throw Error('timeout');},async()=>true),/timeout/);
  assert.equal(calls,1);
});
test('fallback itself must be unique',async()=>{
  for(const rows of [[],['a','b']]) await assert.rejects(resolveAssignmentTarget('新师傅',async n=>n===DEFAULT_ASSIGNEE?rows:[],async()=>true),{code:'RECLOUD_ASSIGNMENT_FALLBACK_NOT_UNIQUE'});
});
test('orchestrator verifies remote fallback without mutating actual technician',async()=>{
  const {orchestrateRepairStart}=require('../services/recloud-repair-start-orchestrator');
  const payload={assignee:'新师傅',fieldDeskUserId:'synthetic',fieldDeskDisplayName:'新师傅',usedParts:[]};
  let current='原负责人';
  const result=await orchestrateRepairStart(payload,{
    async readAssignee(){return current;},
    async assignResponsible(){current=DEFAULT_ASSIGNEE;return {assignee:current,fallback:true};},
    async readRemoteState(){return {parts:[]};},
    async confirmWarrantyConversion(){},
  },{writeEnabled:true});
  assert.equal(result.assignee,DEFAULT_ASSIGNEE);
  assert.equal(result.assignmentSource,'NAME_NOT_FOUND_FALLBACK');
  assert.equal(payload.assignee,'新师傅');assert.equal(payload.fieldDeskUserId,'synthetic');
});
