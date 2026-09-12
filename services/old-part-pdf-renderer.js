const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const localPython = path.join(__dirname, "../runtime/print-python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3");

function renderOldPartPdf(pdf, expected, options = {}) {
  if (!Buffer.isBuffer(pdf) || pdf.length > 8 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return Promise.reject(Object.assign(new Error("瑞云标签文件不是有效 PDF"), { code: "PRINT_PDF_INVALID" }));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(options.python || process.env.FIELDDESK_PRINT_PYTHON || (fs.existsSync(localPython) ? localPython : "python3"),
      [path.join(__dirname, "../scripts/render-old-part-pdf.py")],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: options.env || process.env },
      (error, stdout) => {
        let data;
        try { data = JSON.parse(stdout); } catch { /* Never expose renderer stderr or document data. */ }
        if (error || data?.error || !data?.pages?.length) {
          return reject(Object.assign(new Error("瑞云原始标签校验失败，请检查 PDF、返厂配件数量和打印依赖"),
            { code: data?.error || "PRINT_PDF_RENDER_FAILED" }));
        }
        resolve(data);
      });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ pdfBase64: pdf.toString("base64"), expected }));
  });
}

module.exports = { renderOldPartPdf };
