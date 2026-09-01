import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("主要业务入口使用统一名称", () => {
  const home = read("frontend/src/pages/Home.jsx")
  const profile = read("frontend/src/pages/Profile.jsx")
  const login = read("frontend/src/pages/Login.jsx")
  const navigation = read("frontend/src/shared/userStore.js")

  for (const name of ["网点维修管理", "机器去向", "维修档案", "问题工单", "历史工单"]) {
    assert.match(home, new RegExp(name))
  }

  for (const name of ["瑞云同步", "同步检查", "账号管理"]) {
    assert.match(profile, new RegExp(name))
  }

  assert.match(home, /FieldDesk 工作台/)
  assert.doesNotMatch(home, /在手机器|异常补救工作台|历史维修记录/)
  assert.doesNotMatch(profile, /同步任务|同步诊断|账号与权限/)
  assert.match(login, /网点维修管理/)
  assert.doesNotMatch(login, /FieldDesk AI|智能维修工作台/)
  assert.doesNotMatch(navigation, /label: "维修"|label: "记录"|label: "在手机器"|label: "报告"|label: "异常"/)
})
