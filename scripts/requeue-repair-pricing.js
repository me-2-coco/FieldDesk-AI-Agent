const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { JsonRecloudSyncOutbox } = require("../database/recloud-sync-outbox");
const { resolveRepairCharge } = require("../services/repair-charge-policy");
const { MAPPING_VERSION, buildNodePayload } = require("../connectors/recloud-sync-mapping");

async function main() {
  const rmaNo = String(process.argv[2] || "").trim();
  if (!rmaNo) throw new Error("用法：node scripts/requeue-repair-pricing.js <寄修单号>");
  const receiptStore = new JsonReceiptPreparationStore();
  const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
  if (!order?.repairCompletion?.pricing) throw new Error(`未找到已完工费用记录：${rmaNo}`);
  const previous = order.repairCompletion.pricing;
  const pricing = {
    ...previous,
    ...resolveRepairCharge({
      partsFee: previous.partsFee,
      repairFee: previous.fee,
      oneWayLogisticsFee: previous.oneWayLogisticsFee,
      logisticsChargeMode: previous.logisticsChargeMode,
      discountEnabled: previous.discountEnabled,
      discountScope: previous.discountScope,
      discountRate: previous.discountRate,
    }),
  };
  const updated = await receiptStore.updateRepairCompletionPricing(rmaNo, pricing, {
    userId: "SYSTEM",
    displayName: "FieldDesk 费用规则更正",
  });
  const outbox = new JsonRecloudSyncOutbox();
  const task = await outbox.enqueue({
    workOrderNo: updated.id || updated.rmaNo,
    rmaNo: updated.rmaNo,
    logisticsNo: updated.logisticsNo,
    sn: updated.sn,
    nodeType: "REPAIR_COMPLETED",
    localBusinessRecordId: `${updated.repairCompletion.submittedAt}:pricing:${MAPPING_VERSION}`,
    idempotencyKey: `REPAIR_COMPLETED_PRICING:${updated.rmaNo}:${MAPPING_VERSION}`,
    mappingVersion: MAPPING_VERSION,
    payload: buildNodePayload(updated, "REPAIR_COMPLETED"),
  });
  process.stdout.write(`${JSON.stringify({ rmaNo, taskId: task.id, status: task.status, mappingVersion: task.mappingVersion })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code || "REPAIR_PRICING_REQUEUE_FAILED"}: ${error.message}\n`);
  process.exitCode = 1;
});
