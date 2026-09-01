try {
  process.loadEnvFile?.();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const { PendingReceiptStore } = require("../database/pending-receipt-store");
const { openRecloud, closeRecloud, readPendingReceiptOrders } = require("../connectors/recloud");

function shanghaiCalendarStart(monthCount = 3, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  const start = new Date(Date.UTC(values.year, values.month - monthCount, 1));
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00+08:00`;
}

async function main() {
  const store = new PendingReceiptStore();
  const snapshot = await store.readSnapshot();
  const dateFrom = process.env.PENDING_RECEIPT_BACKFILL_FROM || shanghaiCalendarStart(3);
  const existingRmaNos = snapshot.orders
    .filter((order) => /^1[3-9]\d{9}$/.test(String(order.phone || "").trim()))
    .map((order) => order.rmaNo)
    .filter(Boolean);
  console.info(`PENDING_RECEIPT_BACKFILL: start dateFrom=${dateFrom.slice(0, 10)} existingFullPhones=${existingRmaNos.length}`);
  const session = await openRecloud({ serviceWorkers: "allow" });
  if (session.loginRequired) {
    const error = new Error("瑞云登录已失效，请先重新登录");
    error.code = "RECLOUD_LOGIN_REQUIRED";
    throw error;
  }
  const result = await readPendingReceiptOrders(session.page, {
    dateFrom,
    catchUp: true,
    existingRmaNos,
    maxPhoneDetailsPerRun: Number.MAX_SAFE_INTEGER,
    phoneRevealTimeout: Number(process.env.PENDING_RECEIPT_BACKFILL_PHONE_TIMEOUT_MS || 8000),
    settleDelay: Number(process.env.PENDING_RECEIPT_BACKFILL_SETTLE_MS || 5000),
    priorityPhone: process.env.PENDING_RECEIPT_PRIORITY_PHONE || "",
    onOrder: async (order) => {
      await store.mergeIncremental([order], {
        activeRmaNos: null,
        syncedAt: new Date().toISOString(),
      });
    },
    logger: console,
  });
  const merged = await store.mergeIncremental(result.orders || [], {
    activeRmaNos: null,
    syncedAt: new Date().toISOString(),
  });
  console.info(`PENDING_RECEIPT_BACKFILL: finished added=${merged.added} updated=${merged.updated} total=${merged.total}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`PENDING_RECEIPT_BACKFILL: failed ${error.code || "UNKNOWN"}`);
    process.exitCode = 1;
  }).finally(() => closeRecloud());
}

module.exports = { shanghaiCalendarStart };
