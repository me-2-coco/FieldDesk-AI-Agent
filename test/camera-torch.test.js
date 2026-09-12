const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../frontend/src/shared/cameraTorch.js');
test('torch on and off preserve focus and resolution constraints', async () => {
  const { supportsTorch, setCameraTorch } = await modulePromise;
  let actual = false;
  let applied;
  const track = {
    readyState:'live', getCapabilities:()=>({torch:true}),
    getConstraints:()=>({width:{ideal:1920}, advanced:[{focusMode:'continuous',torch:false}]}),
    applyConstraints:async value=>{applied=value;actual=value.torch;},
    getSettings:()=>({torch:actual}),
  };
  assert.equal(supportsTorch(track),true);
  assert.equal(await setCameraTorch(track,true),true);
  assert.deepEqual(applied.width,{ideal:1920});
  assert.deepEqual(applied.advanced,[{focusMode:'continuous'},{torch:true}]);
  assert.equal(await setCameraTorch(track,false),false);
});
test('unsupported, ended, ignored and rejected light operations never report success', async () => {
  const { supportsTorch, setCameraTorch } = await modulePromise;
  assert.equal(supportsTorch(null),false);
  assert.equal(supportsTorch({readyState:'ended',getCapabilities:()=>({torch:true})}),false);
  assert.equal(supportsTorch({readyState:'live',getCapabilities:()=>{throw Error('unsupported')}}),false);
  await assert.rejects(setCameraTorch(null,true));
  const ignored = {readyState:'live',getCapabilities:()=>({torch:[false,true]}),applyConstraints:async()=>{},getSettings:()=>({torch:false})};
  await assert.rejects(setCameraTorch(ignored,true),/无法确认/);
  await assert.rejects(setCameraTorch({...ignored,getSettings:()=>({})},true),/无法确认/);
  await assert.rejects(setCameraTorch({...ignored,applyConstraints:async()=>{throw Error('device refused')}},true),/device refused/);
});
