const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { chromium } = require("playwright");

const RECLOUD_PROFILE_DIRECTORY = path.join(
  __dirname,
  ".recloud-browser-profile"
);
const RECLOUD_PROFILE_LOCK = `${RECLOUD_PROFILE_DIRECTORY}.lock`;
const KEYCHAIN_SERVICE = "FieldDesk-Recloud";

function isLoginAutofillEnabled(env = process.env) {
  return (
    String(env.RECLOUD_LOGIN_AUTOFILL_ENABLED ?? "false").toLowerCase() ===
    "true"
  );
}

function logSession(stage, logger = console) {
  logger.info(`RECLOUD_SESSION: ${stage}`);
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireProfileLock(
  lockPath = RECLOUD_PROFILE_LOCK,
  fsApi = fs,
  options = {}
) {
  fsApi.mkdirSync(path.dirname(lockPath), { recursive: true });
  const processIsAlive = options.isProcessAlive || isProcessAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fsApi.writeFileSync(lockPath, String(process.pid), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      let ownerPid = 0;
      try {
        ownerPid = Number.parseInt(
          fsApi.readFileSync(lockPath, "utf8").trim(),
          10
        );
      } catch {
        ownerPid = 0;
      }
      if (processIsAlive(ownerPid)) {
        const lockError = new Error(
          "瑞云浏览器资料目录已被其他存活进程占用，请先关闭重复的后端或登录初始化命令"
        );
        lockError.code = "RECLOUD_PROFILE_IN_USE";
        lockError.ownerPid = ownerPid;
        throw lockError;
      }
      if (attempt === 0) {
        try {
          fsApi.unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError.code === "ENOENT") continue;
          throw unlinkError;
        }
      }
      const lockError = new Error(
        "无法安全恢复瑞云浏览器应用锁，请人工检查运行中的 FieldDesk 进程"
      );
      lockError.code = "RECLOUD_PROFILE_IN_USE";
      throw lockError;
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const ownerPid = Number.parseInt(
        fsApi.readFileSync(lockPath, "utf8").trim(),
        10
      );
      if (ownerPid === process.pid) fsApi.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

function readPasswordFromKeychain(username, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    execFileImpl(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        username,
        "-w",
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          const keychainError = new Error(
            "无法从 macOS 钥匙串读取瑞云密码，请人工登录"
          );
          keychainError.code = "RECLOUD_KEYCHAIN_UNAVAILABLE";
          reject(keychainError);
          return;
        }
        const passwordBuffer = Buffer.from(stdout);
        while (
          passwordBuffer.length > 0 &&
          [10, 13].includes(passwordBuffer[passwordBuffer.length - 1])
        ) {
          passwordBuffer[passwordBuffer.length - 1] = 0;
          resolve(passwordBuffer.subarray(0, passwordBuffer.length - 1));
          return;
        }
        resolve(passwordBuffer);
      }
    );
  });
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function hasLoginChallenge(page) {
  const challengeText = page
    .getByText(/验证码|短信验证|滑块|安全验证|二次确认|异常验证/)
    .filter({ visible: true })
    .first();
  if (await challengeText.isVisible().catch(() => false)) return true;
  const challengeControl = page
    .locator(
      [
        'input[placeholder*="验证码"]',
        'input[name*="captcha"]',
        'iframe[src*="captcha"]',
        '[class*="slider"]',
        '[class*="captcha"]',
      ].join(", ")
    )
    .first();
  return challengeControl.isVisible().catch(() => false);
}

async function autofillLoginOnce(page, options = {}) {
  if (options.enabled !== true) return { attempted: false };
  if (await hasLoginChallenge(page)) {
    const error = new Error("检测到安全验证，请在瑞云页面人工完成登录");
    error.code = "RECLOUD_MANUAL_VERIFICATION_REQUIRED";
    throw error;
  }

  const username = String(options.username || "").trim();
  if (!username) {
    const error = new Error("未配置瑞云登录用户名，请人工登录");
    error.code = "RECLOUD_LOGIN_USERNAME_REQUIRED";
    throw error;
  }

  const usernameInput = await firstVisible([
    page.locator('input[name="username"]').first(),
    page.locator('input[autocomplete="username"]').first(),
    page.locator('input[placeholder*="账号"]').first(),
    page.locator('input[placeholder*="用户名"]').first(),
  ]);
  const passwordInput = await firstVisible([
    page.locator('input[type="password"][name="password"]').first(),
    page.locator('input[type="password"][autocomplete="current-password"]').first(),
    page.locator('input[type="password"]').first(),
  ]);
  if (!usernameInput || !passwordInput) {
    const error = new Error("无法安全定位瑞云登录输入框，请人工登录");
    error.code = "RECLOUD_LOGIN_FORM_CHANGED";
    throw error;
  }

  const secret = await options.readPassword(username);
  const passwordBuffer = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(secret);
  let password = "";
  try {
    password = passwordBuffer.toString("utf8").replace(/[\r\n]+$/, "");
    await usernameInput.fill(username);
    await passwordInput.fill(password);
    if (await hasLoginChallenge(page)) {
      const error = new Error("检测到安全验证，请在瑞云页面人工完成登录");
      error.code = "RECLOUD_MANUAL_VERIFICATION_REQUIRED";
      throw error;
    }
    const submit = await firstVisible([
      page.getByRole("button", { name: "登录", exact: true }).first(),
      page.locator('button[type="submit"]').first(),
      page.locator('input[type="submit"]').first(),
    ]);
    if (!submit) {
      const error = new Error("无法安全定位瑞云登录按钮，请人工登录");
      error.code = "RECLOUD_LOGIN_FORM_CHANGED";
      throw error;
    }
    await submit.click();
    return { attempted: true };
  } finally {
    password = "";
    passwordBuffer.fill(0);
  }
}

function createRecloudSessionManager(options = {}) {
  const chromiumImpl = options.chromium || chromium;
  const profileDirectory =
    options.profileDirectory || RECLOUD_PROFILE_DIRECTORY;
  const lockPath = options.lockPath || `${profileDirectory}.lock`;
  const logger = options.logger || console;
  const env = options.env || process.env;
  const targetUrl = options.targetUrl;
  const isLoginPage = options.isLoginPage;
  const isReadyPage = options.isReadyPage;
  const defaultTimeout = options.defaultTimeout || 30000;
  const readPassword =
    options.readPassword ||
    ((username) => readPasswordFromKeychain(username, options));

  let context = null;
  let page = null;
  let opening = null;
  let releaseLock = null;
  let autoLoginAttempted = false;

  function findLivePage() {
    if (!context) return null;
    return context
      .pages()
      .find((candidate) => !candidate.isClosed());
  }

  async function ensureOpen(openOptions = {}) {
    const navigationTimeout =
      openOptions.navigationTimeout ?? defaultTimeout;
    if (context) {
      page = findLivePage() || (await context.newPage().catch(() => null));
      if (!page) await close();
    }
    if (context && page && !page.isClosed()) {
      logSession("reused", logger);
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
      return preparePage();
    }
    if (opening) return opening;

    opening = (async () => {
      const profileAlreadyExists = (options.fs || fs).existsSync(
        profileDirectory
      );
      releaseLock = acquireProfileLock(lockPath, options.fs || fs, {
        isProcessAlive: options.isProcessAlive,
      });
      try {
        context = await chromiumImpl.launchPersistentContext(
          profileDirectory,
          {
            headless:
              openOptions.headless ??
              !["0", "false"].includes(
                String(env.RECLOUD_HEADLESS).toLowerCase()
              ),
            // Playwright routing cannot observe requests claimed by a Service Worker.
            // Blocking Service Workers ensures the receipt simulation guard sees
            // every page request before it reaches the network.
            serviceWorkers: openOptions.serviceWorkers ?? "block",
          }
        );
        page = context.pages()[0] || (await context.newPage());
        page.setDefaultTimeout(defaultTimeout);
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        });
        if (profileAlreadyExists) logSession("reused", logger);
        return await preparePage();
      } catch (error) {
        const recoverableLoginCodes = new Set([
          "RECLOUD_AUTO_LOGIN_FAILED",
          "RECLOUD_KEYCHAIN_UNAVAILABLE",
          "RECLOUD_LOGIN_USERNAME_REQUIRED",
          "RECLOUD_LOGIN_FORM_CHANGED",
          "RECLOUD_MANUAL_VERIFICATION_REQUIRED",
        ]);
        if (!recoverableLoginCodes.has(error.code)) await close();
        throw error;
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  async function preparePage() {
    const loginPage = context
      ?.pages?.()
      .find((candidate) => !candidate.isClosed() && isLoginPage(candidate.url()));
    if (loginPage) page = loginPage;
    if (!isLoginPage(page.url())) {
      if (
        typeof isReadyPage === "function" &&
        !(await isReadyPage(page).catch(() => false))
      ) {
        const redirectedLoginPage = context
          ?.pages?.()
          .find((candidate) => !candidate.isClosed() && isLoginPage(candidate.url()));
        if (redirectedLoginPage) {
          page = redirectedLoginPage;
          return preparePage();
        }
        logSession("login_required", logger);
        return { context, page, loginRequired: true };
      }
      // A completed authenticated visit starts a fresh login-expiry cycle.
      // This permits one new Keychain login if Recloud expires again tomorrow.
      autoLoginAttempted = false;
      logSession("ready", logger);
      return { context, page, reused: true };
    }

    logSession("login_required", logger);
    if (!isLoginAutofillEnabled(env) || autoLoginAttempted) {
      return { context, page, loginRequired: true };
    }
    autoLoginAttempted = true;

    await autofillLoginOnce(page, {
      enabled: true,
      username: env.RECLOUD_LOGIN_USERNAME,
      readPassword,
    });
    try {
      await page.waitForURL(
        (url) => !isLoginPage(String(url)),
        { timeout: options.loginTimeout || 10000 }
      );
    } catch {
      if (await hasLoginChallenge(page)) {
        const verificationError = new Error(
          "检测到安全验证，请在瑞云页面人工完成登录"
        );
        verificationError.code = "RECLOUD_MANUAL_VERIFICATION_REQUIRED";
        throw verificationError;
      }
      const error = new Error("自动登录失败，请人工检查账号状态");
      error.code = "RECLOUD_AUTO_LOGIN_FAILED";
      throw error;
    }
    if (await hasLoginChallenge(page)) {
      const error = new Error("检测到安全验证，请在瑞云页面人工完成登录");
      error.code = "RECLOUD_MANUAL_VERIFICATION_REQUIRED";
      throw error;
    }
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    autoLoginAttempted = false;
    logSession("ready", logger);
    return { context, page, reused: false };
  }

  async function close() {
    const activeContext = context;
    context = null;
    page = null;
    if (activeContext) await activeContext.close().catch(() => {});
    if (releaseLock) {
      const release = releaseLock;
      releaseLock = null;
      release();
    }
  }

  return {
    close,
    ensureOpen,
    get autoLoginAttempted() {
      return autoLoginAttempted;
    },
  };
}

module.exports = {
  KEYCHAIN_SERVICE,
  RECLOUD_PROFILE_DIRECTORY,
  RECLOUD_PROFILE_LOCK,
  acquireProfileLock,
  autofillLoginOnce,
  createRecloudSessionManager,
  hasLoginChallenge,
  isLoginAutofillEnabled,
  isProcessAlive,
  logSession,
  readPasswordFromKeychain,
};
