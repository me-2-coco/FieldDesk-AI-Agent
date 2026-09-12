const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { captureOldPartLabels } = require('../connectors/recloud-old-part-labels');
const { PrintJobStore } = require('../database/print-job-store');
const { createRecloudRepairPageAdapter } = require('../connectors/recloud-repair-page-adapter');
const pdf = Buffer.from('%PDF-1.4\nsynthetic fixture');
const rendered = { sha256: crypto.createHash('sha256').update(pdf).digest('hex'), pages: [
  {payloadBase64: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'), widthMm:60,heightMm:80,partCode:'P1',rasterWidth:480,rasterHeight:640,rasterBase64:Buffer.alloc(38400,255).toString('base64')}
]};
const parts = [{partCode:'P1',quantity:1,returnRequired:true}];

async function fixture(t, options = {}) {
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = `<meta charset="UTF-8"><p>JXTH209901010001 FWD209901010001</p><h3>服务单更换件明细</h3>
  <div class="el-table"><table><thead><tr><th>选择</th><th>新件编码</th><th>是否返厂</th><th>数量</th></tr></thead>
  <tbody><tr><td><input type="checkbox"></td><td>P1</td><td>${options.returnNo?'否':'是'}</td><td>1</td></tr>
  <tr><td><input type="checkbox" checked></td><td>P2</td><td>否</td><td>1</td></tr></tbody></table></div>
  <button id="print" ${options.disabled?'disabled':''}>旧件打印标签</button>
  <div role="dialog" style="display:none"><span>面单打印</span><button aria-label="关闭" id="close">X</button><iframe></iframe></div>
  <script>window.clicks=0;document.querySelector('#print').onclick=()=>{window.clicks++;const d=document.querySelector('[role=dialog]');d.style.display='block';d.querySelector('iframe').src=URL.createObjectURL(new Blob(['%PDF-1.4\\nsynthetic fixture'],{type:'application/pdf'}));};document.querySelector('#close').onclick=()=>document.querySelector('[role=dialog]').style.display='none';</script>`;
  await page.route('http://label.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('http://label.test/');
  return page;
}
test('only return rows selected; PDF captured and selection restored', async t=>{
  const page=await fixture(t);
  const result=await captureOldPartLabels(page,parts,{rmaNo:'JXTH209901010001'});
  assert.deepEqual(result.pdf,pdf);
  assert.equal(result.serviceOrderNo,'FWD209901010001');
  assert.equal(await page.locator('tbody input').nth(0).isChecked(),false);
  assert.equal(await page.locator('tbody input').nth(1).isChecked(),true);
  assert.equal(await page.getByRole('dialog').isVisible(),false);
});
for(const scenario of ['wrong order','wrong part','return no','not complete']){
 test(`capture refuses ${scenario} before printing`,async t=>{
  const page=await fixture(t,{returnNo:scenario==='return no',disabled:scenario==='not complete'});
  await assert.rejects(captureOldPartLabels(page,scenario==='wrong part'?[{...parts[0],partCode:'MISSING'}]:parts,
    {rmaNo:scenario==='wrong order'?'WRONG':'JXTH209901010001'}), {code:({'wrong order':'RECLOUD_LABEL_ORDER_MISMATCH','wrong part':'RECLOUD_LABEL_PARTS_MISSING','return no':'RECLOUD_LABEL_PARTS_MISMATCH','not complete':'RECLOUD_LABEL_BUTTON_NOT_READY'})[scenario]});
  assert.equal(await page.evaluate(()=>window.clicks),0);
 });
}
test('PDF bitmap jobs atomic, idempotent, original PDF not in public list',async()=>{
 const store=new PrintJobStore({driver:'memory'});
 const {terminal}=await store.saveTerminal({name:'fixture',printerName:'fixture',memberUserIds:['U1']});
 const input={pdf,rendered,userId:'U1',rmaNo:'R1',idempotencyKey:'batch1'};
 const a=await store.enqueueOriginalPdf(input); const b=await store.enqueueOriginalPdf(input);
 assert.equal(a[0].id,b[0].id);
 assert.equal((await store.listJobs()).length,1);
 assert.equal((await store.listJobs())[0].originalPdfBase64,undefined);
 const job=await store.leaseNext(terminal.id,'1.0.0');
 assert.equal(job.payloadFormat,'TSPL');assert.equal(job.copies,1);
 const bytes=Buffer.from(job.payloadBase64,'base64');
 const header='SIZE 76 mm,130 mm\r\nGAP 2 mm,0 mm\r\nDENSITY 8\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\nBITMAP 64,200,60,640,0,';
 assert.equal(bytes.subarray(0,header.length).toString(),header);
 assert.deepEqual(bytes.subarray(header.length,header.length+38400),Buffer.alloc(38400,255));
 assert.equal(bytes.subarray(header.length+38400).toString(),'\r\nPRINT 1,1\r\n');
 assert.equal(job.renderMethod,'ORIGINAL_PDF_BITMAP');
 assert.equal(job.originalPdfBase64,undefined);
 assert.equal(job.paperWidthMm,76);assert.equal(job.paperHeightMm,130);
 assert.equal(job.sourcePdfSha256,rendered.sha256);
});
test('adapter never substitutes handwritten label for capture failure; warranty skip',async()=>{
 const store=new PrintJobStore({driver:'memory'});
 const adapter=createRecloudRepairPageAdapter({}, {rmaNo:'R1',printJobStore:store,
   captureOldPartLabels:async()=>{throw Error('capture failed');},payload:{technicianId:'U1'}});
 await assert.rejects(adapter.printOldPartLabels(parts));assert.equal((await store.listJobs()).length,0);
 const skip=createRecloudRepairPageAdapter({}, {printJobStore:store,payload:{responsibilityType:'保外维修'}});
 assert.equal((await skip.printOldPartLabels(parts)).skipped,true);
});

test('malformed raster rejected before any page is queued',async()=>{
 const store=new PrintJobStore({driver:'memory'});
 const bad={...rendered,pages:[rendered.pages[0],{...rendered.pages[0],rasterBase64:'AA=='}]};
 assert.throws(()=>store.enqueueOriginalPdf({pdf,rendered:bad,idempotencyKey:'bad'}),{code:'PRINT_PDF_INVALID'});
 assert.equal((await store.listJobs()).length,0);
});
test('legacy PNG remains gated to a compatible Windows agent',async()=>{
 const store=new PrintJobStore({driver:'memory'});
 await store.backend.update(data=>{data.jobs=[{id:'legacy',terminalId:'T',status:'PENDING',minimumAgentVersion:'1.1.0',payloadFormat:'PNG'}];});
 assert.equal(await store.leaseNext('T','1.0.0'),null);
 assert.equal((await store.leaseNext('T','1.1.0')).payloadFormat,'PNG');
});
