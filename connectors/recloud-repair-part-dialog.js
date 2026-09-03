function partDialogError(message, code, missingFields = []) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.missingFields = missingFields;
  return error;
}

function chooseUniqueNearbyAddButton(headingBox, buttonBoxes, maxDistance = 90) {
  if (!headingBox) {
    throw partDialogError("无法定位服务单更换件明细标题", "RECLOUD_REPAIR_PART_ADD_HEADING_NOT_FOUND", ["repair.partsHeading"]);
  }
  const headingY = headingBox.y + headingBox.height / 2;
  const candidates = (Array.isArray(buttonBoxes) ? buttonBoxes : [])
    .map((box, index) => ({ index, box, distance: box ? Math.abs(box.y + box.height / 2 - headingY) : Number.POSITIVE_INFINITY }))
    .filter((item) => item.box && item.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance);
  if (candidates.length !== 1) {
    throw partDialogError(
      `服务单更换件明细同一行匹配到 ${candidates.length} 个新增按钮`,
      candidates.length ? "RECLOUD_REPAIR_PART_ADD_AMBIGUOUS" : "RECLOUD_REPAIR_PART_ADD_NOT_FOUND",
      ["repair.partsAddButton"]
    );
  }
  return candidates[0];
}

async function openRepairPartAddDialog(page, options = {}) {
  const headings = page.getByText("服务单更换件明细", { exact: true }).filter({ visible: true });
  if (await headings.count() !== 1) {
    throw partDialogError("服务单更换件明细标题不唯一", "RECLOUD_REPAIR_PART_ADD_HEADING_AMBIGUOUS", ["repair.partsHeading"]);
  }
  const heading = headings.first();
  await heading.scrollIntoViewIfNeeded();
  const headingBox = await heading.boundingBox();
  const buttons = page.getByRole("button", { name: /^\s*新增\s*$/ }).filter({ visible: true });
  const buttonBoxes = [];
  for (let index = 0; index < await buttons.count(); index += 1) {
    buttonBoxes.push(await buttons.nth(index).boundingBox().catch(() => null));
  }
  const selected = chooseUniqueNearbyAddButton(headingBox, buttonBoxes);
  const dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible");
  const countBefore = await dialogs.count();
  const box = selected.box;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const deadline = Date.now() + (options.timeoutMs || 5000);
  while (Date.now() < deadline && await dialogs.count() <= countBefore) await page.waitForTimeout?.(100);
  if (await dialogs.count() <= countBefore) {
    throw partDialogError("点击更换件新增后没有出现窗口", "RECLOUD_REPAIR_PART_ADD_DIALOG_NOT_FOUND", ["repair.partsAddDialog"]);
  }
  if (typeof options.assertSafe === "function") await options.assertSafe();
  const dialog = dialogs.last();
  const dialogText = String(await dialog.innerText()).replace(/\s+/g, " ").trim();
  if (!dialogText.includes("新件信息") || !dialogText.includes("新件名称")) {
    throw partDialogError("打开的不是更换件新增窗口", "RECLOUD_REPAIR_PART_ADD_DIALOG_MISMATCH", ["repair.partsAddDialog"]);
  }
  return dialog;
}

async function inspectAndCloseRepairPartAddDialog(page, dialog) {
  const fieldLabels = [...new Set((await dialog
    .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
    .allInnerTexts())
    .map((value) => String(value).replace(/^\*+|\*+$/g, "").trim())
    .filter((value) => value && value.length <= 50))];
  const saveButtonCount = await dialog.getByRole("button", { name: /^\s*保存\s*$/ }).filter({ visible: true }).count();
  const cancel = dialog.getByRole("button", { name: /^\s*取消\s*$/ }).filter({ visible: true }).last();
  if (await cancel.count()) await cancel.click({ timeout: 3000 }).catch(() => {});
  const close = dialog.locator(
    "button[aria-label*='关闭']:visible, button[title*='关闭']:visible, .el-dialog__headerbtn:visible, .rt-dialog__close:visible"
  ).last();
  if (await dialog.isVisible().catch(() => false) && await close.count()) await close.click({ timeout: 3000 }).catch(() => {});
  if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
  await dialog.waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
  await page.waitForTimeout?.(100);
  return {
    fieldLabels,
    saveButtonCount,
    dialogClosed: !await dialog.isVisible().catch(() => false),
    saveClicked: false,
    confirmed: false,
  };
}

module.exports = {
  chooseUniqueNearbyAddButton,
  openRepairPartAddDialog,
  inspectAndCloseRepairPartAddDialog,
};
