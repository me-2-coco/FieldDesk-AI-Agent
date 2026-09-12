const path = require("path");
const formats = require("../shared/media-formats.json");

const ATTACHMENT_NAME_PATTERN = new RegExp(`\\.(?:${Object.values(formats.types).flat().join("|")})$`, "i");

function parseDisplayedSize(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?(?:\s*\|)?$/i);
  if (!match) return 0;
  const units = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(Number(match[1]) * units[match[2].toUpperCase()]);
}

function mimeTypeFromName(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return Object.entries(formats.types).find(([, extensions]) => extensions.includes(extension.slice(1)))?.[0] || "";
}

function parseRepairAttachmentPanelText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const attachments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fileName = lines[index];
    if (!ATTACHMENT_NAME_PATTERN.test(fileName) || fileName.includes("/")) continue;
    let size = 0;
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 6); lookahead += 1) {
      size = parseDisplayedSize(lines[lookahead]);
      if (size) break;
      if (ATTACHMENT_NAME_PATTERN.test(lines[lookahead])) break;
    }
    attachments.push({ fileName, size, mimeType: mimeTypeFromName(fileName) });
  }
  return attachments;
}

async function locateRepairAttachmentPanel(page, target = "附件") {
  const headings = page.getByText(target, { exact: true }).filter({ visible: true });
  const count = await headings.count();
  if (count !== 1) {
    const error = new Error(count ? "维修附件区域不唯一" : "没有找到维修附件区域");
    error.code = count ? "RECLOUD_REPAIR_ATTACHMENT_SECTION_AMBIGUOUS" : "RECLOUD_REPAIR_ATTACHMENT_SECTION_NOT_FOUND";
    error.status = 502;
    error.missingFields = ["repair.attachmentsSection"];
    throw error;
  }
  const panel = headings.first().locator("xpath=ancestor::*[.//*[normalize-space(text())='下载']][1]");
  return await panel.count() ? panel.first() : headings.first().locator("xpath=parent::*");
}

async function readExistingRepairAttachments(page, target = "附件") {
  const panel = await locateRepairAttachmentPanel(page, target);
  return parseRepairAttachmentPanelText(await panel.innerText());
}

async function inspectRepairAttachmentPanel(page) {
  const attachments = await readExistingRepairAttachments(page);
  return {
    attachmentCount: attachments.length,
    withSizeCount: attachments.filter((item) => item.size > 0).length,
    imageCount: attachments.filter((item) => item.mimeType.startsWith("image/")).length,
    videoCount: attachments.filter((item) => item.mimeType.startsWith("video/")).length,
  };
}

module.exports = {
  parseDisplayedSize,
  mimeTypeFromName,
  parseRepairAttachmentPanelText,
  locateRepairAttachmentPanel,
  readExistingRepairAttachments,
  inspectRepairAttachmentPanel,
};
