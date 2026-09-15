const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch();
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto('http://127.0.0.1:5178');
  await page.evaluate(async()=>{
   const {default:React}=await import('/node_modules/.vite/deps/react.js');
   const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
   const {default:Identity}=await import('/src/components/RepairIdentity.jsx');
   document.body.innerHTML='<main id="fixture"></main>';
   ReactDOM.createRoot(document.getElementById('fixture')).render(React.createElement(Identity,{order:{sn:'LAB-SN-0001',crmOrderNo:'LAB-RMA-0002',logisticsNo:'LAB-SF-0003',customer:'测试客户',phone:'13800000000',product:'测试品类',technician:'测试师傅'}}));
  });
  await page.getByText('13800000000',{exact:true}).waitFor();
  assert.equal(await page.locator('.parts-order-hero strong').innerText(),'LAB-SN-0001');
  assert.deepEqual(await page.locator('dt').allInnerTexts(),['寄修单号','物流单号','客户姓名','客户电话','产品线','维修师傅']);
  assert.deepEqual(await page.locator('dd').allInnerTexts(),['LAB-RMA-0002','LAB-SF-0003','测试客户','13800000000','测试品类','测试师傅']);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>390),false);
  console.log('Mobile identity mapping passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
