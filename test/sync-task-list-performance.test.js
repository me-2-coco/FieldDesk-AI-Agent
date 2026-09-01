const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("sync task history remains searchable without rendering every card at once", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/pages/SyncTasks.jsx"), "utf8");
  assert.match(source, /const PAGE_SIZE = 30/);
  assert.match(source, /filteredTasks\.slice\(0, visibleLimit\)/);
  assert.match(source, /按寄修单号筛选/);
  assert.match(source, /只看待处理/);
  assert.match(source, /全部历史任务/);
  assert.match(source, /再显示/);
  assert.doesNotMatch(source, /tasks\.map\(\(task\)/);
});
