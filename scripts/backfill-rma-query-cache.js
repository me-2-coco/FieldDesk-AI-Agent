try {
  process.loadEnvFile?.();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const { RmaQueryCacheStore } = require("../database/rma-query-cache-store");
const { openRecloud, closeRecloud, readRecentRmaOrders } = require("../connectors/recloud");
const { shanghaiCalendarStart } = require("./backfill-pending-receipts");

async function main() {
  const store = new RmaQueryCacheStore();
  const snapshot = await store.readSnapshot();
  const dateFrom = process.env.RMA_QUERY_BACKFILL_FROM || shanghaiCalendarStart(3);
  const existingRmaNos = snapshot.orders
    .filter((order) => /^1[3-9]\d{9}$/.test(String(order.phone || "").trim()))
    .map((order) => order.rmaNo)
    .filter(Boolean);
  console.info(`RECLOUD_RMA_BACKFILL: start dateFrom=${dateFrom.slice(0, 10)} existingFullPhones=${existingRmaNos.length}`);
  const session = await openRecloud({ serviceWorkers: "allow" });
  if (session.loginRequired) throw Object.assign(new Error("瑞云登录已失效，请先重新登录"), { code: "RECLOUD_LOGIN_REQUIRED" });
  const result = await readRecentRmaOrders(session.page, {
    dateFrom,
    existingRmaNos,
    maxRecords: Number(process.env.RMA_QUERY_CACHE_CAPACITY || 10000),
    maxPages: Number(process.env.RMA_QUERY_BACKFILL_MAX_PAGES || 500),
    phoneRevealTimeout: Number(process.env.RMA_QUERY_BACKFILL_PHONE_TIMEOUT_MS || 8000),
    onOrder: async (order) => store.mergeIncremental([order], {
      activeRmaNos: null,
      syncedAt: new Date().toISOString(),
    }),
    logger: console,
  });
  console.info(`RECLOUD_RMA_BACKFILL: finished discovered=${result.discovered} cached=${result.orders.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RECLOUD_RMA_BACKFILL: failed ${error.code || "UNKNOWN"}`);
    process.exitCode = 1;
  }).finally(() => closeRecloud());
}
