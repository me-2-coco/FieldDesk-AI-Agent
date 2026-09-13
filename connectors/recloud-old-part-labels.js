const { locateRepairPartsSection, readWidestHeaderRow, findHeaderIndex, resolveReturnFlag } = require("./recloud-repair-parts-reader");

function fail(code) {
  return Object.assign(new Error("瑞云旧件标签页面无法唯一核对，已停止打印"), { code, phase: "OLD_PART_LABELS", status: 502 });
}

async function captureOldPartLabels(page, parts, context) {
  const body = await page.locator("body").innerText();
  const serviceOrders = [...new Set(body.match(/FWD\d{8,}/g) || [])];
  if (!context.rmaNo || !body.includes(context.rmaNo) || serviceOrders.length !== 1) {
    throw fail("RECLOUD_LABEL_ORDER_MISMATCH");
  }
  const dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .rtxpc-dialog:visible")
    .filter({ hasText: "面单打印" });
  if (await dialogs.count()) throw fail("RECLOUD_LABEL_PREVIEW_ALREADY_OPEN");
  const section = await locateRepairPartsSection(page);
  const { headers } = await readWidestHeaderRow(section);
  const codeIndex = findHeaderIndex(headers, ["新件编码", "配件编码", "物料编码"]);
  const returnIndex = findHeaderIndex(headers, ["是否返厂"]);
  const quantityIndex = findHeaderIndex(headers, ["数量", "配件数量", "更换数量"]);
  if (Math.min(codeIndex, returnIndex, quantityIndex) < 0) throw fail("RECLOUD_LABEL_COLUMNS_MISSING");
  const expected = new Map();
  for (const part of parts) {
    const code = String(part.partCode || part.code || "").trim();
    const quantity = Number(part.quantity || 1);
    if (!code || expected.has(code) || !Number.isInteger(quantity) || quantity < 1 || part.returnRequired !== true) {
      throw fail("RECLOUD_LABEL_PARTS_INVALID");
    }
    expected.set(code, quantity);
  }
  const rows = section.getByRole("row").filter({ visible: true });
  const plan = [];
  const found = new Set();
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    const cells = row.getByRole("cell").filter({ visible: true });
    if (await cells.count() <= Math.max(codeIndex, returnIndex, quantityIndex)) continue;
    const code = (await cells.nth(codeIndex).innerText()).trim();
    if (!code) continue;
    const selected = expected.has(code);
    const returnCell = cells.nth(returnIndex);
    const returnText = (await returnCell.innerText()).trim();
    const returnChecks = returnCell.locator("input[type='checkbox']");
    const checkCount = await returnChecks.count();
    const returnRequired = selected ? resolveReturnFlag(returnText, checkCount,
      checkCount === 1 ? await returnChecks.isChecked() : undefined) : false;
    if (selected && (found.has(code) || !returnRequired
      || Number((await cells.nth(quantityIndex).innerText()).trim()) !== expected.get(code))) {
      throw fail("RECLOUD_LABEL_PARTS_MISMATCH");
    }
    // The selection column is distinct from the disabled 'return required' field.
    const check = cells.first().locator("input[type='checkbox'], [role='checkbox']");
    if (await check.count() !== 1) throw fail("RECLOUD_LABEL_SELECTION_AMBIGUOUS");
    plan.push({ check, selected });
    if (selected) found.add(code);
  }
  if (found.size !== expected.size || found.size === 0) throw fail("RECLOUD_LABEL_PARTS_MISSING");
  const button = page.getByRole("button", { name: "旧件打印标签", exact: true }).filter({ visible: true });
  if (await button.count() !== 1 || !await button.isEnabled()) throw fail("RECLOUD_LABEL_BUTTON_NOT_READY");
  const previous = [];
  let dialog;
  try {
    for (const item of plan) {
      previous.push({ check: item.check, selected: await item.check.isChecked() });
      await item.check.setChecked(item.selected);
    }
    for (const item of plan) if (await item.check.isChecked() !== item.selected) throw fail("RECLOUD_LABEL_SELECTION_FAILED");
    await button.click({ timeout: 5000 });
    await dialogs.first().waitFor({ state: "visible", timeout: 15000 });
    if (await dialogs.count() !== 1) throw fail("RECLOUD_LABEL_PREVIEW_AMBIGUOUS");
    dialog = dialogs.first();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const sources = await dialog.locator("iframe, embed, object").evaluateAll(nodes =>
        [...new Set(nodes.map(node => node.getAttribute("src") || node.getAttribute("data") || "").filter(Boolean))]);
      if (sources.length > 1) throw fail("RECLOUD_LABEL_PDF_AMBIGUOUS");
      if (sources.length === 1) {
        const base64 = await page.evaluate(async source => {
          const url = new URL(source, location.href);
          if (!["blob:", "https:"].includes(url.protocol) && url.origin !== location.origin) return null;
          const response = await fetch(url.href, { credentials: "same-origin", signal: AbortSignal.timeout(8000) });
          if (!response.ok) return null;
          const blob = await response.blob();
          if (blob.size > 8 * 1024 * 1024) return null;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return null;
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return btoa(binary);
        }, sources[0]);
        if (base64) return { pdf: Buffer.from(base64, "base64"), serviceOrderNo: serviceOrders[0] };
      }
      await page.waitForTimeout(300);
    }
    throw fail("RECLOUD_LABEL_PDF_UNAVAILABLE");
  } finally {
    if (dialog) {
      const close = dialog.locator(".el-dialog__headerbtn, .rtxpc-dialog__headerbtn, button[aria-label='Close'], button[aria-label='关闭']");
      if (await close.count() === 1) {
        await close.click({ timeout: 3000 });
        await dialog.waitFor({ state: "hidden", timeout: 3000 });
      } else {
        throw fail("RECLOUD_LABEL_PREVIEW_CLOSE_REQUIRED");
      }
    }
    for (const item of previous) await item.check.setChecked(item.selected);
  }
}

module.exports = { captureOldPartLabels };
