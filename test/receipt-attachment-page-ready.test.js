const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {readRmaReceiptAttachmentSnapshot}=require('../connectors/recloud');
async function setup(t,other=false){
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('http://fixture.test/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<body>正在加载<script>setTimeout(()=>{document.body.innerHTML='<h1>RMA JXTH209901010001</h1>${other?'<p>JXTH209901010002</p>':''}<div class="apaas-sub-content" label="附件" style="width:300px;height:200px"><div class="file-detail"><span class="item-name">fixture.jpg</span><div class="uploadTime-and-operation"><span>1 KB</span></div></div></div>';},200)</script></body>`}));
 await page.goto('http://fixture.test/');return page;
}
test('attachment readback waits for asynchronously loaded order and files after reload',async t=>{
 const page=await setup(t);const result=await readRmaReceiptAttachmentSnapshot(page,'JXTH209901010001',{timeoutMs:2000,pollIntervalMs:30});
 assert.equal(result.readBackVerified,true);assert.deepEqual(result.attachments,[{name:'fixture.jpg',size:1024}]);
});
test('attachment readback still refuses another order',async t=>{
 const page=await setup(t);await assert.rejects(readRmaReceiptAttachmentSnapshot(page,'JXTH209901019999',{timeoutMs:450,pollIntervalMs:30}),{code:'RECEIPT_ATTACHMENT_ORDER_MISMATCH'});
});
test('attachment readback still refuses ambiguous order identities',async t=>{
 const page=await setup(t,true);await assert.rejects(readRmaReceiptAttachmentSnapshot(page,'JXTH209901010001',{timeoutMs:450,pollIntervalMs:30}),{code:'RECEIPT_ATTACHMENT_ORDER_MISMATCH'});
});
