const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { buildNodePayload } = require("../connectors/recloud-sync-mapping");

const TECH = { userId: "TECH-1", displayName: "测试师傅", role: "TECHNICIAN" };
const INFO = { userId: "INFO-1", displayName: "测试信息员", role: "INFORMATION_CLERK" };

async function readyStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-warranty-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await store.prepare({ logisticsNo: "SF-WARRANTY", rmaNo: "RMA-WARRANTY", sn: "P212602C2CN0050505", productLine: "洗地机" });
  await store.markModelAuthorization("RMA-WARRANTY", { repairability: "SUPPORTED", status: "MATCHED" }, TECH);
  await store.addReceiptAttachment("RMA-WARRANTY", { id: "RECEIPT", name: "receipt.jpg", mimeType: "image/jpeg" }, TECH);
  await store.completeReceipt("RMA-WARRANTY", TECH);
  return store;
}

test("师傅保外转保内选择生成信息员待办，凭证保持锁定", async (t) => {
  const store = await readyStore(t);
  const requested = await store.saveWarrantyDecision("RMA-WARRANTY", {
    technicianWarranty: "保外",
    conversionRequested: true,
    warrantyDecision: { status: "DETERMINED", warrantyStatus: "保外" },
  }, TECH);
  assert.equal(requested.manufacturerWarrantyConversion.status, "PENDING_APPROVAL");
  assert.equal(requested.warrantyOverridden, false);

  const approved = await store.addWarrantyConversionProof("RMA-WARRANTY", {
    id: "PROOF-1", name: "总部转保凭证.jpg", mimeType: "image/jpeg", fileName: "proof.jpg",
  }, {}, INFO);
  assert.equal(approved.manufacturerWarrantyConversion.status, "APPROVED");
  assert.equal(approved.manufacturerWarrantyConversion.approved, true);
  assert.equal(approved.manufacturerWarrantyConversion.proofAttachments[0].locked, true);
});

test("瑞云维修完工载荷将转保凭证作为普通维修附件上传", () => {
  const proof = { id: "PROOF-1", name: "总部转保凭证.jpg", mimeType: "image/jpeg", locked: true };
  const payload = buildNodePayload({
    rmaNo: "RMA-WARRANTY", technicianName: "测试师傅",
    manufacturerWarrantyConversion: { requested: true, approved: true, status: "APPROVED", proofAttachments: [proof] },
    repairCompletion: { attachments: [{ id: "PHOTO-1", mimeType: "image/jpeg" }, proof] },
  }, "REPAIR_COMPLETED");
  assert.equal(payload.attachmentTarget, "REPAIR_ORDER_ATTACHMENT");
  assert.equal(payload.attachments.some((item) => item.id === "PROOF-1"), true);
});

test("前端提供师傅选择、信息员待办和不可删除凭证", async () => {
  const warranty = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairWarranty.jsx"), "utf8");
  const approvals = await fs.readFile(path.join(__dirname, "../frontend/src/pages/WarrantyConversionApprovals.jsx"), "utf8");
  const completion = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  assert.match(warranty, /无需修改可直接进入下一步/);
  assert.match(warranty, /需要申请时勾选，不申请可直接下一步/);
  assert.match(warranty, /selectedWarranty === "保外"/);
  assert.match(approvals, /上传总部申请凭证/);
  assert.match(completion, /信息员上传的凭证已锁定/);
});
