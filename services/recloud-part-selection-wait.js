async function waitForExpectedPartCode(input, expected, wait) {
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    code = String(await input.inputValue().catch(() => '')).trim().toUpperCase();
    if (code === expected) return code;
    if (attempt < 4) await wait(100);
  }
  return code;
}
module.exports = { waitForExpectedPartCode };
