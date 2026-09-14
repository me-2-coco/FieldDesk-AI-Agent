// Start Vite on 127.0.0.1:5178 before running. Synthetic identifiers only.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:5178');
    const result = await page.evaluate(async () => {
      const writer = await import('/node_modules/zxing-wasm/dist/es/writer/index.js');
      writer.prepareZXingModule({overrides:{locateFile:()=>'/node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'}});
      const {decodeBarcodeFrame}=await import('/src/shared/barcodeDecoder.js');
      const expected='W1234567LAB7654321';
      const barcode=await writer.writeBarcode(expected,{format:'Code128',scale:2});
      const qr=await writer.writeBarcode('APPPAIR123456',{format:'QRCode',scale:4});
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1280,720);
      ctx.drawImage(await createImageBitmap(barcode.image),150,300);
      ctx.drawImage(await createImageBitmap(qr.image),850,100);
      const frame=ctx.getImageData(0,0,1280,720);frame.scannerMode='sn';
      const actual=await decodeBarcodeFrame(frame);
      ctx.fillStyle='white';ctx.fillRect(0,0,1280,720);
      ctx.drawImage(await createImageBitmap(qr.image),850,100);
      const qrOnly=ctx.getImageData(0,0,1280,720);qrOnly.scannerMode='sn';
      return {expected,actual,qrOnly:await decodeBarcodeFrame(qrOnly)};
    });
    assert.equal(result.actual,result.expected);
    assert.equal(result.qrOnly,'');
    console.log('PASS: SN Code128 is decoded beside an unrelated pairing QR');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
