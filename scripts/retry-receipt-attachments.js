const path = require("path");

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const connector = require("../connectors/recloud");
const { createBusinessStores } = require("../database/business-store-factory");
const { LocalRepairAttachmentStore } = require("../database/repair-attachment-store");
const { FeishuModelCatalog } = require("../connectors/feishu-model-catalog");
const { withRecloud } = require("../server");

async function main() {
  const rmaNo = String(process.argv[2] || "").trim().toUpperCase();
  if (!/^JXTH\d+$/.test(rmaNo)) throw new Error("请提供明确的 JXTH 寄修单号");

  const { receiptStore } = createBusinessStores(process.env);
  const attachmentStore = new LocalRepairAttachmentStore(
    path.join(__dirname, "..", "database", "uploads", "receipts"),
    { allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] }
  );
  const catalog = new FeishuModelCatalog({ env: process.env });
  const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
  if (!order) throw new Error("未找到本地签收记录");
  if (!order.recloudReceiptConfirmedAt) throw new Error("瑞云签收尚未确认，禁止单独补传照片");
  if (!(order.receiptAttachments || []).length) throw new Error("这张工单没有本地签收照片");
  if (order.recloudReceiptAttachmentSyncStatus === "RESULT_UNKNOWN") {
    throw new Error("上次上传结果未知，需先人工核对瑞云附件列表");
  }

  const result = await withRecloud(connector, async (page) => {
    let detail = await connector.queryRmaByLogisticsNo(page, order.logisticsNo, { preserveDetailPage: true });
    if (detail.rmaNo && detail.rmaNo !== rmaNo) throw new Error("瑞云查询结果与目标寄修单不一致");
    const identity = detail.projectCode
      ? { sn: order.sn, projectCode: detail.projectCode }
      : await connector.readRmaProductIdentity(page, {
          sn: order.sn,
          logisticsNo: order.logisticsNo,
          productLine: detail.productLine || detail.productType || order.productLine,
        });
    if (String(identity.sn || "").trim().toUpperCase() !== String(order.sn || "").trim().toUpperCase()) {
      throw new Error("瑞云产品序列号与 FieldDesk 扫描 SN 不一致");
    }
    const authorization = await catalog.authorize({
      sn: order.sn,
      currentProjectCode: identity.projectCode,
    });
    if (authorization.status !== "MATCHED") {
      throw new Error("瑞云项目号与 SN 未确认一致；本次不会修改项目号或上传附件");
    }

    detail = await connector.queryRmaByLogisticsNo(page, order.logisticsNo, { preserveDetailPage: true });
    if (detail.rmaNo && detail.rmaNo !== rmaNo) throw new Error("补传前瑞云工单发生变化");
    const attachments = await Promise.all(order.receiptAttachments.map(async (attachment) => ({
      ...attachment,
      buffer: await attachmentStore.read(rmaNo, attachment),
    })));
    return connector.uploadRmaAttachments(page, attachments, { writeEnabled: true });
  }, { background: true });

  await receiptStore.markRecloudReceiptAttachmentsConfirmed(rmaNo, {
    result,
    operator: { userId: "SYSTEM", displayName: "负责人授权补传" },
  });
  console.log(`签收附件补传完成：uploaded=${result.uploaded.length} skipped=${result.skipped.length}`);
}

main()
  .catch((error) => {
    console.error(`签收附件补传失败：${error.code || "ERROR"} ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => connector.closeRecloud?.());
