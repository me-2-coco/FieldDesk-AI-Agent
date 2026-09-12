const test = require("node:test");
const assert = require("node:assert/strict");
const { enrichExpectedAttachmentMetadata } = require('../connectors/recloud-repair-page-adapter');

test('local desired metadata never overwrites remote attachment evidence', () => {
  const expected = [{ fileName: 'same.jpg', size: 100000, mimeType: 'image/jpeg' }];
  for (const observed of [{ fileName: 'same.jpg', size: 0 }, { fileName: 'same.jpg', size: 555, mimeType: 'video/mp4' }]) {
    assert.deepEqual(enrichExpectedAttachmentMetadata([observed], expected), [observed]);
  }
});
const {
  parseDisplayedSize,
  parseRepairAttachmentPanelText,
} = require("../connectors/recloud-repair-attachments-reader");

test("repair attachment reader parses displayed binary sizes", () => {
  assert.equal(parseDisplayedSize("156.14K |"), Math.round(156.14 * 1024));
  assert.equal(parseDisplayedSize("24.11M"), Math.round(24.11 * 1024 * 1024));
  assert.equal(parseDisplayedSize("2026-07-28 11:10:20"), 0);
});

test("repair attachment reader extracts only supported file cards", () => {
  const parsed = parseRepairAttachmentPanelText([
    "附件",
    "finish.JPG",
    "模拟人员",
    "156.14K |",
    "2026-07-28 11:10:20",
    "下载",
    "video.mp4",
    "24.11M |",
    "下载",
    "compressed.webm",
    "88.00M |",
    "下载",
  ].join("\n"));
  assert.deepEqual(parsed.map((item) => [item.fileName, item.mimeType]), [
    ["finish.JPG", "image/jpeg"],
    ["video.mp4", "video/mp4"],
    ["compressed.webm", "video/webm"],
  ]);
  assert.ok(parsed.every((item) => item.size > 0));
});
