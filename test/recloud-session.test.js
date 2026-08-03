const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
  KEYCHAIN_SERVICE,
  acquireProfileLock,
  autofillLoginOnce,
  createRecloudSessionManager,
  isLoginAutofillEnabled,
  readPasswordFromKeychain,
} = require("../connectors/recloud-session");
const { initializeRecloudSession } = require("../server");
const {
  runLoginInitialization,
} = require("../init-recloud-login");

async function createTemporaryDirectory(t) {
  const directory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fielddesk-recloud-session-")
  );
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function invisibleLocator() {
  return {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    isVisible: async () => false,
  };
}

function createSessionBrowser(initialUrl) {
  let currentUrl = initialUrl;
  let launchCount = 0;
  let closeCount = 0;
  let launchOptions = null;
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    setDefaultTimeout() {},
    async goto(url) {
      if (!currentUrl.includes("auth4.recloud.com.cn")) currentUrl = url;
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => {
      closeCount += 1;
    },
  };
  return {
    chromium: {
      async launchPersistentContext(profileDirectory, options) {
        launchCount += 1;
        launchOptions = options;
        return context;
      },
    },
    get closeCount() {
      return closeCount;
    },
    get launchCount() {
      return launchCount;
    },
    get launchOptions() {
      return launchOptions;
    },
    page,
  };
}

function createInitializationPage(initialUrl) {
  let currentUrl = initialUrl;
  let closed = false;
  let ready = false;
  const visible = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    isVisible: async () => ready,
  };
  return {
    close: () => {
      closed = true;
    },
    isClosed: () => closed,
    locator: () => visible,
    getByText: () => visible,
    setReady: (value) => {
      ready = value;
    },
    setUrl: (url) => {
      currentUrl = url;
    },
    url: () => currentUrl,
  };
}

test("logged-in persistent profile is reused in one backend process", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const profile = path.join(directory, "profile");
  await fsp.mkdir(profile);
  const browser = createSessionBrowser("https://crm2.recloud.com.cn/home");
  const logs = [];
  const manager = createRecloudSessionManager({
    chromium: browser.chromium,
    profileDirectory: profile,
    lockPath: path.join(directory, "profile.lock"),
    targetUrl: "https://crm2.recloud.com.cn/#/scanSignin/query",
    isLoginPage: (url) => url.includes("auth4.recloud.com.cn"),
    env: { RECLOUD_HEADLESS: "true" },
    logger: { info: (message) => logs.push(message) },
  });

  const first = await manager.ensureOpen();
  const second = await manager.ensureOpen();

  assert.equal(first.page, second.page);
  assert.equal(browser.launchCount, 1);
  assert.equal(browser.launchOptions.serviceWorkers, "block");
  assert.ok(logs.includes("RECLOUD_SESSION: reused"));
  assert.ok(logs.includes("RECLOUD_SESSION: ready"));
  await manager.close();
  assert.equal(browser.closeCount, 1);
});

test("expired session enters login-required flow without keychain access", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const browser = createSessionBrowser(
    "https://auth4.recloud.com.cn/login"
  );
  let keychainReads = 0;
  const logs = [];
  const manager = createRecloudSessionManager({
    chromium: browser.chromium,
    profileDirectory: path.join(directory, "profile"),
    lockPath: path.join(directory, "profile.lock"),
    targetUrl: "https://crm2.recloud.com.cn/#/scanSignin/query",
    isLoginPage: (url) => url.includes("auth4.recloud.com.cn"),
    env: {
      RECLOUD_HEADLESS: "true",
      RECLOUD_LOGIN_AUTOFILL_ENABLED: "false",
    },
    readPassword: async () => {
      keychainReads += 1;
      return Buffer.from("must-not-read");
    },
    logger: { info: (message) => logs.push(message) },
  });

  const session = await manager.ensureOpen();

  assert.equal(session.loginRequired, true);
  assert.equal(keychainReads, 0);
  assert.ok(logs.includes("RECLOUD_SESSION: login_required"));
  await manager.close();
});

test("login initialization keeps waiting after login_required", async () => {
  const page = createInitializationPage(
    "https://auth4.recloud.com.cn/login"
  );
  const context = { pages: () => [page] };
  let polls = 0;
  let closes = 0;
  const logs = ["RECLOUD_SESSION: login_required"];
  const signals = new EventEmitter();

  const result = await runLoginInitialization({
    signalTarget: signals,
    openSession: async () => ({ context, page, loginRequired: true }),
    closeSession: async () => {
      closes += 1;
    },
    sleep: async () => {
      polls += 1;
      page.setUrl("https://crm2.recloud.com.cn/home");
      page.setReady(true);
    },
    pollInterval: 1,
    timeout: 100,
    logger: { info: (message) => logs.push(message) },
  });

  assert.equal(result, true);
  assert.equal(polls, 1);
  assert.equal(closes, 1);
  assert.ok(logs.includes("RECLOUD_SESSION: login_required"));
  assert.ok(logs.includes("RECLOUD_SESSION: ready"));
  assert.ok(logs.includes("RECLOUD_SESSION: profile_saved"));
});

test("successful initialization releases lock for immediate backend reuse", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const lockPath = path.join(directory, "profile.lock");
  const page = createInitializationPage(
    "https://crm2.recloud.com.cn/home"
  );
  page.setReady(true);
  let release;

  await runLoginInitialization({
    signalTarget: new EventEmitter(),
    openSession: async () => {
      release = acquireProfileLock(lockPath);
      return { context: { pages: () => [page] }, page };
    },
    closeSession: async () => release(),
    logger: { info() {} },
  });

  assert.equal(fs.existsSync(lockPath), false);
  const backendRelease = acquireProfileLock(lockPath);
  backendRelease();
});

test("login timeout closes session and releases profile lock", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const lockPath = path.join(directory, "profile.lock");
  const page = createInitializationPage(
    "https://auth4.recloud.com.cn/login"
  );
  let clock = 0;
  let release;

  await assert.rejects(
    runLoginInitialization({
      signalTarget: new EventEmitter(),
      openSession: async () => {
        release = acquireProfileLock(lockPath);
        return { context: { pages: () => [page] }, page };
      },
      closeSession: async () => release(),
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
      pollInterval: 1000,
      timeout: 1000,
      logger: { info() {} },
    }),
    (error) => error.code === "RECLOUD_LOGIN_TIMEOUT"
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test("Control+C closes session and releases profile lock", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const lockPath = path.join(directory, "profile.lock");
  const page = createInitializationPage(
    "https://auth4.recloud.com.cn/login"
  );
  const signals = new EventEmitter();
  let release;
  let closes = 0;

  const running = runLoginInitialization({
    signalTarget: signals,
    openSession: async () => {
      release = acquireProfileLock(lockPath);
      return { context: { pages: () => [page] }, page };
    },
    closeSession: async () => {
      closes += 1;
      release();
    },
    sleep: () => new Promise(() => {}),
    logger: { info() {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  signals.emit("SIGINT");

  await assert.rejects(
    running,
    (error) => error.code === "RECLOUD_LOGIN_INTERRUPTED"
  );
  assert.equal(closes, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test("manually closed login browser releases profile lock", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const lockPath = path.join(directory, "profile.lock");
  const page = createInitializationPage(
    "https://auth4.recloud.com.cn/login"
  );
  let release;

  await assert.rejects(
    runLoginInitialization({
      signalTarget: new EventEmitter(),
      openSession: async () => {
        release = acquireProfileLock(lockPath);
        return { context: { pages: () => [page] }, page };
      },
      closeSession: async () => release(),
      sleep: async () => page.close(),
      pollInterval: 1,
      timeout: 100,
      logger: { info() {} },
    }),
    (error) =>
      error.code === "RECLOUD_LOGIN_BROWSER_CLOSED" &&
      error.message === "登录浏览器已关闭，未确认瑞云登录成功"
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test("autofill switch is disabled by default", () => {
  assert.equal(isLoginAutofillEnabled({}), false);
  assert.equal(
    isLoginAutofillEnabled({ RECLOUD_LOGIN_AUTOFILL_ENABLED: "false" }),
    false
  );
  assert.equal(
    isLoginAutofillEnabled({ RECLOUD_LOGIN_AUTOFILL_ENABLED: "true" }),
    true
  );
});

test("keychain reader invokes only the macOS security service lookup", async () => {
  const calls = [];
  const password = await readPasswordFromKeychain("TEST_ACCOUNT", {
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, Buffer.from("TEST_PASSWORD\n"), Buffer.alloc(0));
    },
  });

  assert.equal(password.toString(), "TEST_PASSWORD");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "security");
  assert.deepEqual(calls[0].args, [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    "TEST_ACCOUNT",
    "-w",
  ]);
  password.fill(0);
});

function createLoginPage({ challenge = false } = {}) {
  const calls = [];
  const usernameInput = {
    isVisible: async () => true,
    fill: async () => calls.push("username_filled"),
  };
  const passwordInput = {
    isVisible: async () => true,
    fill: async () => calls.push("password_filled"),
  };
  const submit = {
    isVisible: async () => true,
    click: async () => calls.push("submitted"),
  };
  const challengeLocator = {
    ...invisibleLocator(),
    isVisible: async () => challenge,
  };
  const page = {
    getByText() {
      return challengeLocator;
    },
    getByRole() {
      return { first: () => submit };
    },
    locator(selector) {
      if (/captcha|slider/.test(selector)) return challengeLocator;
      if (selector.includes("username") || selector.includes("账号")) {
        return { first: () => usernameInput };
      }
      if (selector.includes("password")) {
        return { first: () => passwordInput };
      }
      if (selector.includes("submit")) return { first: () => submit };
      return invisibleLocator();
    },
  };
  return { calls, page };
}

test("verification challenge prevents autofill submission", async () => {
  const { calls, page } = createLoginPage({ challenge: true });
  let keychainReads = 0;

  await assert.rejects(
    autofillLoginOnce(page, {
      enabled: true,
      username: "TEST_ACCOUNT",
      readPassword: async () => {
        keychainReads += 1;
        return Buffer.from("TEST_PASSWORD");
      },
    }),
    (error) => error.code === "RECLOUD_MANUAL_VERIFICATION_REQUIRED"
  );
  assert.equal(keychainReads, 0);
  assert.deepEqual(calls, []);
});

test("autofill reads password once and submits only once", async () => {
  const { calls, page } = createLoginPage();
  let keychainReads = 0;
  const result = await autofillLoginOnce(page, {
    enabled: true,
    username: "TEST_ACCOUNT",
    readPassword: async () => {
      keychainReads += 1;
      return Buffer.from("TEST_PASSWORD");
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(keychainReads, 1);
  assert.deepEqual(calls, [
    "username_filled",
    "password_filled",
    "submitted",
  ]);
});

test("failed automatic login is not retried in the same startup", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const login = createLoginPage();
  Object.assign(login.page, {
    isClosed: () => false,
    url: () => "https://auth4.recloud.com.cn/login",
    setDefaultTimeout() {},
    goto: async () => {},
    waitForURL: async () => {
      throw new Error("still on login page");
    },
  });
  const context = {
    pages: () => [login.page],
    newPage: async () => login.page,
    close: async () => {},
  };
  let keychainReads = 0;
  const manager = createRecloudSessionManager({
    chromium: {
      launchPersistentContext: async () => context,
    },
    profileDirectory: path.join(directory, "profile"),
    lockPath: path.join(directory, "profile.lock"),
    targetUrl: "https://crm2.recloud.com.cn/#/scanSignin/query",
    isLoginPage: (url) => url.includes("auth4.recloud.com.cn"),
    env: {
      RECLOUD_HEADLESS: "true",
      RECLOUD_LOGIN_AUTOFILL_ENABLED: "true",
      RECLOUD_LOGIN_USERNAME: "TEST_ACCOUNT",
    },
    readPassword: async () => {
      keychainReads += 1;
      return Buffer.from("TEST_PASSWORD");
    },
    loginTimeout: 1,
  });

  await assert.rejects(
    manager.ensureOpen(),
    (error) => error.code === "RECLOUD_AUTO_LOGIN_FAILED"
  );
  const second = await manager.ensureOpen();

  assert.equal(second.loginRequired, true);
  assert.equal(keychainReads, 1);
  assert.equal(
    login.calls.filter((call) => call === "submitted").length,
    1
  );
  await manager.close();
});

test("profile lock rejects a concurrent backend", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const lockPath = path.join(directory, "profile.lock");
  const release = acquireProfileLock(lockPath);

  assert.throws(
    () => acquireProfileLock(lockPath),
    (error) => error.code === "RECLOUD_PROFILE_IN_USE"
  );
  assert.equal(fs.existsSync(lockPath), true);
  release();
  const releaseAgain = acquireProfileLock(lockPath);
  releaseAgain();
});

test("stale application lock is recovered without touching Chromium SingletonLock", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const profile = path.join(directory, "profile");
  const lockPath = `${profile}.lock`;
  const singletonLock = path.join(profile, "SingletonLock");
  await fsp.mkdir(profile);
  await fsp.writeFile(singletonLock, "chromium-owned");
  await fsp.writeFile(lockPath, "99999999");

  const release = acquireProfileLock(lockPath, fs, {
    isProcessAlive: () => false,
  });

  assert.equal(fs.existsSync(singletonLock), true);
  assert.equal(fs.readFileSync(singletonLock, "utf8"), "chromium-owned");
  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("credential values never enter session logs or errors", async () => {
  const username = "PRIVATE_ACCOUNT_MARKER";
  const password = "PRIVATE_PASSWORD_MARKER";
  const { page } = createLoginPage();
  const logs = [];

  await autofillLoginOnce(page, {
    enabled: true,
    username,
    readPassword: async () => Buffer.from(password),
    logger: { info: (message) => logs.push(message) },
  });

  assert.doesNotMatch(logs.join("\n"), new RegExp(`${username}|${password}`));
});

test("Recloud profiles and login artifacts are ignored by Git", async () => {
  const ignore = await fsp.readFile(
    path.join(__dirname, "../.gitignore"),
    "utf8"
  );
  assert.match(ignore, /connectors\/\.recloud-browser-profile\//);
  assert.match(ignore, /connectors\/recloud-state\.json/);
  assert.match(ignore, /connectors\/recloud-downloads\//);
  assert.match(ignore, /connectors\/recloud-screenshots\//);
  assert.match(ignore, /connectors\/\*cookie\*/);
  assert.match(ignore, /connectors\/\*token\*/);
});

test("backend startup initializes once and logs only a safe failure code", async () => {
  let opens = 0;
  const logs = [];
  const credentialMarker = "PRIVATE_CREDENTIAL_MARKER";
  const connector = {
    async openRecloud() {
      opens += 1;
      const error = new Error(credentialMarker);
      error.code = "RECLOUD_AUTO_LOGIN_FAILED";
      throw error;
    },
  };

  const session = await initializeRecloudSession(connector, {
    error: (message) => logs.push(message),
  });

  assert.equal(session, null);
  assert.equal(opens, 1);
  assert.equal(
    logs[0],
    "RECLOUD_SESSION: failed RECLOUD_AUTO_LOGIN_FAILED"
  );
  assert.doesNotMatch(logs.join("\n"), new RegExp(credentialMarker));
});
