const {
  LOGIN_STATE,
  RECLOUD_URL,
  getLogisticsInput,
  openRecloud,
  saveLogin,
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

async function waitForCrmQueryPage(page) {
  const logisticsInput = getLogisticsInput(page);

  while (!page.isClosed()) {
    if (
      isCrmQueryUrl(page.url()) &&
      (await logisticsInput.isVisible().catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("浏览器已关闭，瑞云登录状态未保存");
}

async function main() {
  console.log("正在打开瑞云登录页面，请在浏览器中手动完成登录。");
  console.log("程序会持续等待 CRM 物流查询页面，不会查询或签收任何工单。");

  const { browser, context, page } = await openRecloud({
    headless: false,
    useStorageState: false,
  });

  try {
    await waitForCrmQueryPage(page);
    await saveLogin(context);
    console.log(`瑞云登录状态初始化成功，已保存到 ${LOGIN_STATE}`);
    console.log("现在可以关闭此命令并启动 FieldDesk 后端。");
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`瑞云登录状态初始化失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { isCrmQueryUrl, waitForCrmQueryPage };
