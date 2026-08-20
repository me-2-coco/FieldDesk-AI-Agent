const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const readline = require("readline/promises");

const KEYCHAIN_SERVICE = "FieldDesk-Recloud";

function updateEnvContent(content, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = String(content || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function validUsername(value) {
  return /^[A-Za-z0-9@._+\-]{3,128}$/.test(String(value || "").trim());
}

async function configure(options = {}) {
  const projectRoot = options.projectRoot || path.join(__dirname, "..");
  const envPath = options.envPath || path.join(projectRoot, ".env");
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const prompt = options.prompt || readline.createInterface({ input, output });
  try {
    const username = String(await prompt.question("请输入瑞云账号（密码稍后由 macOS 钥匙串隐藏输入）：")).trim();
    if (!validUsername(username)) throw new Error("瑞云账号格式不正确，未修改任何配置");

    output.write("接下来由 macOS 钥匙串接管密码输入；输入内容不会显示，也不会写入 Git。\n");
    const result = (options.spawnSync || spawnSync)(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        username,
        "-s",
        KEYCHAIN_SERVICE,
        "-l",
        KEYCHAIN_SERVICE,
        "-j",
        "FieldDesk 瑞云自动登录（仅存储在本机钥匙串）",
        "-w",
      ],
      { stdio: "inherit" }
    );
    if (result.status !== 0) throw new Error("钥匙串未保存，未开启自动登录");

    const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const updated = updateEnvContent(current, {
      RECLOUD_LOGIN_AUTOFILL_ENABLED: "true",
      RECLOUD_LOGIN_USERNAME: username,
    });
    fs.writeFileSync(envPath, updated, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    output.write("配置完成：瑞云密码已保存到钥匙串，自动登录已开启。请重启 FieldDesk 后端生效。\n");
    return { usernameConfigured: true, autofillEnabled: true };
  } finally {
    prompt.close?.();
  }
}

if (require.main === module) {
  configure().catch((error) => {
    console.error(`配置失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { KEYCHAIN_SERVICE, configure, updateEnvContent, validUsername };
