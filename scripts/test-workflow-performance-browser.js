// Synthetic browser fixtures only; no business requests or remote writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { readExistingRepairParts } = require('../connectors/recloud-repair-parts-reader');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<h2>服务单更换件明细</h2><div class="rt-table-content"><div class="el-pagination">共 1 条记录</div><table><tr><th>新件编码</th><th>数量</th><th>新件名称</th><th>是否返厂</th></tr><tr><td>LAB-1</td><td>2</td><td>测试配件</td><td>是</td></tr></table></div>');
    assert.deepEqual(await readExistingRepairParts(page, {requireReturnFlag:true}), [{partCode:'LAB-1', quantity:2, partName:'测试配件', returnRequired:true}]);
    await page.locator('.el-pagination').evaluate(el => el.textContent = '共 2 条记录');
    // No page-size selector: totals still fail closed rather than add duplicates.
    await assert.rejects(readExistingRepairParts(page));
    const source = fs.readFileSync('frontend/src/shared/photoUpload.js', 'utf8').replace('export async function', 'async function');
    const result = await page.evaluate(async source => {
      const optimize = new Function(`${source}; return optimizeUploadPhoto`)();
      const canvas = document.createElement('canvas'); canvas.width=2400; canvas.height=1800;
      const ctx = canvas.getContext('2d');
      const data = ctx.createImageData(2400,1800);
      let seed=1;
      for(let i=0;i<data.data.length;i+=4) { seed=(seed*1664525+1013904223)>>>0; data.data[i]=seed&255; data.data[i+1]=(seed>>>8)&255; data.data[i+2]=(seed>>>16)&255; data.data[i+3]=255; }
      ctx.putImageData(data,0,0); ctx.fillStyle='black'; ctx.fillRect(0,1600,2400,200);
      ctx.fillStyle='white'; ctx.font='50px sans-serif'; ctx.fillText('成都追觅维修中心 2026-01-01 08:00:00',60,1700);
      const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.98));
      const original = new File([blob], 'synthetic.jpg', {type:'image/jpeg'});
      const encoded = await optimize(original); const bitmap=await createImageBitmap(encoded);
      return {before:original.size, after:encoded.size, width:bitmap.width,height:bitmap.height};
    }, source);
    assert.equal(result.width,2400); assert.equal(result.height,1800);
    assert.ok(result.after < result.before * 0.9);
    console.log('Browser fixtures passed', result);
  } finally { await browser.close(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
