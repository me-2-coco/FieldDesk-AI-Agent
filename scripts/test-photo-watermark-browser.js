// Frontend-only Vite server on 5178; fake camera/location, no backend or business data.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:5178');
    const result = await page.evaluate(async () => {
      const { stampPhoto } = await import('/src/shared/photoWatermark.js');
      const source = document.createElement('canvas'); source.width = 720; source.height = 960;
      const ctx = source.getContext('2d'); ctx.fillStyle = '#77aabb'; ctx.fillRect(0, 0, 720, 960);
      const texts = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { texts.push(text); return original.call(this, text, ...args); };
      const stamped = stampPhoto(source, new Date('2026-01-01T00:00:00Z'), { coords: { latitude: 30, longitude: 104, accuracy: 12 } });
      CanvasRenderingContext2D.prototype.fillText = original;
      stamped.id = 'watermark-sample'; document.body.appendChild(stamped);
      let rejected = false;
      try { stampPhoto(source, new Date(), { coords: { latitude: NaN, longitude: 104 } }); } catch { rejected = true; }
      return { texts, height: stamped.height, pixel: [...stamped.getContext('2d').getImageData(0, 0, 1, 1).data], rejected };
    });
    assert.match(result.texts[0], /2026-01-01 08:00:00/);
    assert.match(result.texts[1], /30\.000000.*104\.000000/);
    assert.ok(result.height > 960 && result.rejected);
    assert.deepEqual(result.pixel, [119, 170, 187, 255]);
    await page.locator('#watermark-sample').screenshot({ path: '/tmp/fielddesk-watermark-sample.png' });
    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { default: Photo } = await import('/src/components/PhotoCaptureModal.jsx');
      window.captures = []; window.geoMode = 'denied';
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
        getCurrentPosition(ok, fail, options) {
          window.geoOptions = options;
          if (window.geoMode === 'denied') return fail({ code: 1 });
          if (window.geoMode === 'pending') { window.pendingGeo = ok; return; }
          ok({ coords: { latitude: 30, longitude: 104, accuracy: 10 } });
        }
      } });
      const root = ReactDOM.createRoot(document.body.appendChild(document.createElement('div')));
      window.showPhoto = () => root.render(React.createElement(Photo, { open: true, onClose() { root.render(null); }, onCapture(file) { window.captures.push(file); } }));
      window.showPhoto();
    });
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
    await page.getByRole('button', { name: '拍照', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '允许位置权限' }).waitFor();
    assert.equal(await page.evaluate(() => window.captures.length), 0);
    await page.evaluate(() => { window.geoMode = 'success'; });
    await page.getByRole('button', { name: '拍照', exact: true }).click();
    await page.waitForFunction(() => window.captures.length === 1);
    const capture = await page.evaluate(async () => {
      const file = window.captures[0]; const bitmap = await createImageBitmap(file);
      return { type: file.type, width: bitmap.width, height: bitmap.height, options: window.geoOptions };
    });
    assert.equal(capture.type, 'image/jpeg');
    assert.ok(capture.height > capture.width * 0.75); // fake camera 4:3 plus bottom strip
    assert.equal(capture.options.maximumAge, 0);
    await page.evaluate(() => { window.geoMode = 'pending'; window.showPhoto(); });
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
    await page.getByRole('button', { name: '拍照', exact: true }).click();
    assert.ok(await page.getByRole('button', { name: '拍照', exact: true }).isDisabled());
    await page.getByRole('button', { name: '关闭相机' }).click();
    await page.evaluate(() => window.pendingGeo({ coords: { latitude: 30, longitude: 104 } }));
    assert.equal(await page.evaluate(() => window.captures.length), 1);
    console.log('PASS: bottom watermark, timestamp, coordinates, preserved image, denied-location retry, JPEG capture, cancel and duplicate protection');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
