const test = require("node:test");
const assert = require("node:assert/strict");
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
  ].join("\n"));
  assert.deepEqual(parsed.map((item) => [item.fileName, item.mimeType]), [
    ["finish.JPG", "image/jpeg"],
    ["video.mp4", "video/mp4"],
  ]);
  assert.ok(parsed.every((item) => item.size > 0));
});
