const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KEYCHAIN_SERVICE,
  updateEnvContent,
  validUsername,
} = require("../scripts/configure-recloud-credentials");

test("瑞云安全配置只在 env 保存账号和自动登录开关", () => {
  const updated = updateEnvContent(
    "DRY_RUN=true\nRECLOUD_LOGIN_AUTOFILL_ENABLED=false\nRECLOUD_LOGIN_USERNAME=\n",
    {
      RECLOUD_LOGIN_AUTOFILL_ENABLED: "true",
      RECLOUD_LOGIN_USERNAME: "safe.account@example.com",
    }
  );
  assert.match(updated, /RECLOUD_LOGIN_AUTOFILL_ENABLED=true/);
  assert.match(updated, /RECLOUD_LOGIN_USERNAME=safe\.account@example\.com/);
  assert.doesNotMatch(updated, /PASSWORD|SECRET/);
});

test("瑞云账号经过严格格式校验并使用固定钥匙串服务名", () => {
  assert.equal(KEYCHAIN_SERVICE, "FieldDesk-Recloud");
  assert.equal(validUsername("safe.account@example.com"), true);
  assert.equal(validUsername("18800001111"), true);
  assert.equal(validUsername("bad account\nPASSWORD=x"), false);
});
