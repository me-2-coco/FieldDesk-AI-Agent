const test = require("node:test")
const assert = require("node:assert/strict")

test("fault search prefers the selected part name and removes a generic suffix", async () => {
  const { getPreferredFaultKeyword } = await import("../frontend/src/shared/faultSearch.js")

  assert.equal(getPreferredFaultKeyword([{ name: "上下水模组主机" }]), "上下水模组")
  assert.equal(getPreferredFaultKeyword([{ partName: "水泵组件" }]), "水泵")
  assert.equal(getPreferredFaultKeyword([]), "")
  assert.equal(getPreferredFaultKeyword([], "地刷电机不转"), "地刷电机不转")
})

test("fault options match level 2 by customer symptom and level 3 by replaced part", async () => {
  const { rankFaultOptions } = await import("../frontend/src/shared/faultSearch.js")
  const options = [
    "产品质量 / 电机不启动 / 微动开关不良",
    "产品质量 / 地刷不转 / 微动开关不良",
    "产品质量 / 地刷不转 / 主板不良",
  ]
  const ranked = rankFaultOptions(options, {
    reportedFault: "地刷电机不转",
    parts: [{ name: "微动开关组件" }],
  })
  assert.equal(ranked[0], "产品质量 / 地刷不转 / 微动开关不良")
})
