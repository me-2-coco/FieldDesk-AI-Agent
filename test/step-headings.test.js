const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('step headings use a shared blue card with independently centered titles', () => {
  const css = fs.readFileSync(path.join(__dirname,'../frontend/src/step-headings.css'),'utf8');
  for (const selector of ['.top-bar','.repair-query-header','.repair-decision-header','.history-page-header','.desktop-subpage-heading','.records-page-heading']) assert.ok(css.includes(selector));
  assert.ok(css.includes('grid-template-columns: 44px minmax(0, 1fr) 44px'));
  assert.ok(css.includes('text-align: center !important'));
  assert.ok(css.includes(':has(h1)'));
  assert.ok(css.includes('linear-gradient'));
  const app=fs.readFileSync(path.join(__dirname,'../frontend/src/App.jsx'),'utf8');
  assert.ok(app.includes('import "./step-headings.css"'));
});
