if (require.main === module) {
  try {
    process.loadEnvFile?.();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const {
  RECLOUD_URL,
  closeRecloud,
  getLogisticsInput,
  openRecloud,
} = require("./connectors/recloud");

function isCrmQueryUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase() === "crm2.recloud.com.cn" &&
      parsed.hash.includes("/scanSignin/query")
    );
  } catch {
    return false;
  }
}

function isCrmPage(url) {
  try {
    return new URL(url).hostname.toLowerCase() === "crm2.recloud.com.cn";
  } catch {
    return false;
  }
}

async function hasCrmReadyMarker(page) {
  if (await getLogisticsInput(page).isVisible().catch(() => false)) {
    return true;
  }
  if (typeof page.getByText !== "function") return false;
  for (const text of ["服务管理", "扫码签收"]) {
    const marker = page
      .getByText(text, { exact: true })
      .filter({ visible: true })
      .first();
    if (await marker.isVisible().catch(() => false)) return true;
  }
  return false;
}

async function waitForCrmQueryPage(context, initialPage, options = {}) {
  const timeout = options.timeout ?? 10 * 60 * 1000;
  const pollInterval = options.pollInterval ?? 1000;
  const startedAt = (options.now || Date.now)();
  const sleep =
    options.sleep ||
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));

  while (true) {
    if (options.isAborted?.()) {
      const error = new Error("瑞云登录初始化已中止");
      error.code = "RECLOUD_LOGIN_INTERRUPTED";
      throw error;
    }

    const contextPages =
      typeof context?.pages === "function" ? context.pages() : [];
    const pages = [...new Set([initialPage, ...contextPages])]
      .filter((page) => page && !page.isClosed());
    if (pages.length === 0) {
      const error = new Error("登录浏览器已关闭，未确认瑞云登录成功");
      error.code = "RECLOUD_LOGIN_BROWSER_CLOSED";
      throw error;
    }

    for (const page of pages) {
      if (
        isCrmPage(page.url()) &&
        (await hasCrmReadyMarker(page))
      ) {
        return page;
      }
    }

    if ((options.now || Date.now)() - startedAt >= timeout) {
      const error = new Error("等待瑞云人工登录超时，请重新运行初始化命令");
      error.code = "RECLOUD_LOGIN_TIMEOUT";
      throw error;
    }

    const delay = sleep(pollInterval);
    if (options.abortPromise) {
      await Promise.race([delay, options.abortPromise]);
    } else {
      await delay;
    }
  }
}

async function runLoginInitialization(options = {}) {
  const logger = options.logger || console;
  const openSession = options.openSession || openRecloud;
  const closeSession = options.closeSession || closeRecloud;
  const signalTarget = options.signalTarget || process;
  let interrupted = false;
  let resolveAbort;
  const abortPromise = new Promise((resolve) => {
    resolveAbort = resolve;
  });
  const handleSignal = () => {
    interrupted = true;
    resolveAbort();
  };

  logger.info("正在打开瑞云登录页面，请在浏览器中手动完成登录。");
  logger.info("程序会持续等待有效 CRM 页面，不会查询或签收任何工单。");

  signalTarget.on("SIGINT", handleSignal);
  signalTarget.on("SIGTERM", handleSignal);
  let session;
  try {
    session = await openSession({
      headless: false,
    });
    await waitForCrmQueryPage(session.context, session.page, {
      abortPromise,
      isAborted: () => interrupted,
      now: options.now,
      pollInterval: options.pollInterval,
      sleep: options.sleep,
      timeout: options.timeout,
    });
    logger.info("RECLOUD_SESSION: ready");
    logger.info("RECLOUD_SESSION: profile_saved");
    return true;
  } finally {
    signalTarget.off("SIGINT", handleSignal);
    signalTarget.off("SIGTERM", handleSignal);
    await closeSession();
  }
}

async function main() {
  await runLoginInitialization({
    timeout: Number(process.env.RECLOUD_LOGIN_WAIT_MS) || 10 * 60 * 1000,
  });
}

if (require.main === module) {
  main().catch((error) => {
    if (error.code === "RECLOUD_LOGIN_INTERRUPTED") {
      console.error("瑞云登录初始化已中止，浏览器和profile锁已释放");
      process.exitCode = 130;
      return;
    }
    console.error(`瑞云登录状态初始化失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  hasCrmReadyMarker,
  isCrmPage,
  isCrmQueryUrl,
  runLoginInitialization,
  waitForCrmQueryPage,
};
