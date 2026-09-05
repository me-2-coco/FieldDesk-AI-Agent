const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const modulePromise = import(pathToFileURL(path.join(
  __dirname,
  "../frontend/src/shared/videoCompression.js"
)).href);

test("video compression starts only above the decimal 100MB boundary", async () => {
  const { MAX_VIDEO_UPLOAD_BYTES, needsVideoCompression } = await modulePromise;
  assert.equal(MAX_VIDEO_UPLOAD_BYTES, 100_000_000);
  assert.equal(needsVideoCompression({ type: "video/mp4", size: 100_000_000 }), false);
  assert.equal(needsVideoCompression({ type: "video/mp4", size: 100_000_001 }), true);
  assert.equal(needsVideoCompression({ type: "image/jpeg", size: 150_000_000 }), false);
});

test("video bitrate reserves room for audio inside the target size", async () => {
  const { TARGET_VIDEO_BYTES, targetVideoBitrate } = await modulePromise;
  const duration = 120;
  const videoBits = targetVideoBitrate(duration);
  assert.ok(videoBits >= 250_000);
  assert.ok(((videoBits + 96_000) * duration) / 8 <= TARGET_VIDEO_BYTES);
});
