#!/usr/bin/env node
const recloud = require("../connectors/recloud");
const { createRecloudRepairPageAdapter } = require("../connectors/recloud-repair-page-adapter");
const { createBusinessStores } = require("../database/business-store-factory");
const { orchestrateRepairStart } = require("../services/recloud-repair-start-orchestrator");

async function main() {
  const logisticsNo = String(process.argv[2] || "").trim();
  if (!logisticsNo) throw Object.assign(new Error("missing logistics number"), { code: "LOGISTICS_NO_REQUIRED" });

  const { receiptStore } = createBusinessStores(process.env);
  let order = (await receiptStore.readAll()).find((item) => item.logisticsNo === logisticsNo);
  if (!order) throw Object.assign(new Error("FieldDesk order not found"), { code: "ORDER_NOT_FOUND" });
  const skipAssignmentReason = String(process.argv[3] === "--keep-current-assignee" ? process.argv[4] || "" : "").trim();
  if (process.argv[3] && (!skipAssignmentReason || !order.recloudServiceOrderNo)) {
    throw new Error("Keeping the current assignee requires an existing service order and an explicit authorization reason");
  }
  const operator = {
    userId: order.technicianId || order.operatorId || "SYSTEM",
    displayName: order.technicianName || order.operatorName || "FieldDesk 后台恢复",
  };

  let opened;
  let serviceOrderCreated = Boolean(order.recloudServiceOrderCreatedAt);
  try {
    process.stderr.write("RECOVERY_STAGE: opening_session\n");
    opened = await recloud.openRecloud({ headless: true });
    if (opened.loginRequired) throw Object.assign(new Error("login required"), { code: "RECLOUD_LOGIN_REQUIRED" });

    process.stderr.write("RECOVERY_STAGE: locating_rma_fast\n");
    const detail = await recloud.queryRmaByLogisticsNo(opened.page, logisticsNo, {
      preserveDetailPage: true,
      fastDomRead: true,
      revealPhoneEnabled: false,
    });
    if (detail.rmaNo && detail.rmaNo !== order.rmaNo) {
      throw Object.assign(new Error("Recloud RMA does not match FieldDesk"), { code: "RECLOUD_REPAIR_ORDER_MISMATCH" });
    }

    let serviceOrderNo = String(order.recloudServiceOrderNo || "").trim();
    if (!serviceOrderCreated) {
      const bodyText = await opened.page.locator("body").innerText({ timeout: 5000 });
      const existing = recloud.extractRepairServiceOrderCandidates(bodyText);
      if (existing.length > 1) {
        throw Object.assign(new Error("multiple Recloud service orders found"), { code: "RECLOUD_REPAIR_SERVICE_ORDER_AMBIGUOUS" });
      }
      if (existing.length === 1) {
        serviceOrderNo = existing[0];
        await receiptStore.markRecloudServiceOrderConfirmed(order.rmaNo, operator, { serviceOrderNo });
        await recloud.openExistingRepairServiceOrder(opened.page, {
          rmaNo: order.rmaNo,
          logisticsNo,
          serviceOrderNo,
        });
      } else {
        if (order.recloudServiceOrderSyncStatus === "RESULT_UNKNOWN") {
          await receiptStore.reconcileRecloudServiceOrderNotCreated(order.rmaNo, operator);
        }
        await receiptStore.markRecloudServiceOrderSyncing(order.rmaNo);
        process.stderr.write("RECOVERY_STAGE: creating_service_order\n");
        const result = await recloud.startRepair(opened.page, { dryRun: false, writeEnabled: true });
        if (!result?.serviceOrderCreated) {
          throw Object.assign(new Error("Recloud did not confirm service order creation"), { code: "RECLOUD_SERVICE_ORDER_NOT_CREATED" });
        }
        serviceOrderNo = String(result.serviceOrderNo || "").trim();
        await receiptStore.markRecloudServiceOrderConfirmed(order.rmaNo, operator, { serviceOrderNo });
      }
      serviceOrderCreated = true;
    } else {
      await recloud.openExistingRepairServiceOrder(opened.page, {
        rmaNo: order.rmaNo,
        logisticsNo,
        serviceOrderNo,
      });
    }

    order = (await receiptStore.readAll()).find((item) => item.rmaNo === order.rmaNo);
    process.stderr.write("RECOVERY_STAGE: preparing_repair_order\n");
    const adapter = createRecloudRepairPageAdapter(opened.page, {
      rmaNo: order.rmaNo,
      logisticsNo,
      sn: order.sn,
      payload: order.recloudRepairPreparation,
    });
    const preparation = await orchestrateRepairStart({
      assignee: order.recloudRepairPreparation?.assignee,
      assignmentSource: order.recloudRepairPreparation?.assignmentSource,
      warrantyConversionRequested: order.recloudRepairPreparation?.warrantyConversionRequested === true,
      usedParts: order.recloudRepairPreparation?.usedParts || [],
    }, adapter, { writeEnabled: true, skipAssignment: Boolean(skipAssignmentReason), skipAssignmentReason });
    if (!["SUCCESS", "PARTS_SHORTAGE"].includes(preparation?.status)) {
      throw Object.assign(new Error("Recloud repair preparation not confirmed"), { code: "RECLOUD_REPAIR_PREPARATION_NOT_CONFIRMED" });
    }
    const saved = await receiptStore.markRecloudRepairPreparationConfirmed(order.rmaNo, preparation, operator);
    process.stdout.write(`${JSON.stringify({
      logisticsNo,
      rmaNo: order.rmaNo,
      serviceOrderNo: saved.recloudServiceOrderNo,
      serviceOrderStatus: saved.recloudServiceOrderSyncStatus,
      preparationStatus: saved.recloudRepairPreparation?.status,
      completedSteps: saved.recloudRepairPreparation?.completedSteps || [],
    })}\n`);
  } catch (error) {
    if (serviceOrderCreated) {
      await receiptStore.markRecloudRepairPreparationFailed(order.rmaNo, {
        code: error.code,
        message: error.message,
      }).catch(() => {});
    }
    throw error;
  } finally {
    await recloud.closeRecloud().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.code || "RECLOUD_REPAIR_RECOVERY_FAILED"}: ${error.message}\n`);
  process.exitCode = 1;
});
