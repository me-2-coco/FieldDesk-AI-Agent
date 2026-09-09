const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../server');
const { monthlyStatistics, exportMonthly, formalMonthlyOrders } = require('../shared/monthly-statistics');
test('only managed formal accounts count; disabled accounts retain historical work',()=>{
  const ids=['LOCAL-TECH-SWEEP','FieldDesk0004','FieldDesk0005','FieldDesk0006','FieldDesk0007'];
  const accounts=ids.slice(0,4).map(userId=>({userId,active:false}));
  assert.deepEqual(formalMonthlyOrders(ids.map(technicianId=>({technicianId})),accounts).map(o=>o.technicianId),['FieldDesk0005','FieldDesk0006']);
});
const orders = ['REPAIR','ABANDONED','DEBUGGING','INSPECTION_ONLY'].map((mode,i)=>({
  rmaNo:`TEST-${i}`,technicianId:i===3?'OTHER':'TECH',technicianName:'测试师傅',productLine:i===3?'洗地机':'扫地机',
  sn:'0000123',logisticsNo:'0000456',customerName:'合成客户',phone:'00000000000',customerAddress:'测试地址',
  treatmentMode:mode,repairCompletion:{submittedAt:'2026-08-31T16:00:00Z',usedParts:[{partCode:'00005807',partName:'测试配件',quantity:2,unitPrice:1.5}]}
}));
test('Shanghai month boundary, self scope, filters and non-abandoned totals',()=>{
  const data=monthlyStatistics(orders,{userId:'TECH',role:'TECHNICIAN'},{month:'2026-09',includeDetails:true});
  assert.deepEqual(data.summary,{repair:2,abandoned:1,total:3});
  assert.equal(data.canExport,false); assert.equal(data.rows[0].customerName,undefined);
  assert.equal(monthlyStatistics(orders,{role:'ADMIN'},{month:'2026-08'}).rows.length,0);
  assert.equal(monthlyStatistics(orders,{role:'ADMIN'},{month:'2026-09',product:'洗地机'}).rows.length,1);
  assert.equal(monthlyStatistics([...orders,orders[0]],{role:'ADMIN'},{month:'2026-09'}).rows.length,4);
  assert.throws(()=>monthlyStatistics([],{role:'ADMIN'},{month:'2026-13'}));
});
test('XLSX preserves identifiers, customer details, quantities and three sheets',async()=>{
  const data=monthlyStatistics(orders,{role:'ADMIN'},{month:'2026-09',includeDetails:true});
  const wb=new ExcelJS.Workbook(); await wb.xlsx.load(await exportMonthly(data));
  assert.deepEqual(wb.worksheets.map(s=>s.name),['月度汇总','工单明细','更换配件明细']);
  const detail=wb.getWorksheet('工单明细');
  assert.equal(detail.getCell('G2').value,'0000123');
  assert.equal(detail.getCell('J2').value,'合成客户');
  assert.equal(detail.getCell('K2').value,'00000000000');
  assert.equal(detail.getCell('L2').value,'测试地址');
  assert.equal(detail.getCell('A2').value.toISOString().slice(0,10),'2026-09-01');
  const parts=wb.getWorksheet('更换配件明细');
  assert.equal(parts.getCell('D2').value,'00005807');
  assert.equal(parts.getCell('F2').value,2); assert.equal(parts.getCell('H2').value,3);
});
test('HTTP export is admin/owner only, including test technician account',async t=>{
  for(const [userId,role,readStatus,exportStatus] of [['TECH','TECHNICIAN',200,403],['FieldDesk0004','TECHNICIAN',200,403],['INFO','INFORMATION_CLERK',403,403],['ADMIN','ADMIN',200,200],['FieldDesk0001','ADMIN',200,200]]) {
    const formalOrders=orders.map(o=>({...o,technicianId:'FieldDesk0005'}));
    const app=createApp({}, {readAll:async()=>[...orders,...formalOrders]}, {accountStore:{list:async()=>[{userId:'FieldDesk0005'},{userId:'FieldDesk0004'}]},getCurrentUser:()=>({userId,role})});
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
    t.after(()=>{server.closeAllConnections();server.close()});
    const url=`http://127.0.0.1:${server.address().port}/api/repairs/monthly-statistics`;
    const response=await fetch(url+'?month=2026-09&includeDetails=true'); assert.equal(response.status,readStatus);
    if(readStatus===200){ const {data}=await response.json(); assert.ok(data.rows.every(r=>!r.customerName)); if(role==='TECHNICIAN') assert.ok(data.rows.every(r=>r.technicianId===userId)); else assert.equal(data.summary.total,4); }
    const exported=await fetch(url+'/export?month=2026-09'); assert.equal(exported.status,exportStatus);
    if(exportStatus===200) assert.match(exported.headers.get('content-type'),/spreadsheetml/);
  }
});
