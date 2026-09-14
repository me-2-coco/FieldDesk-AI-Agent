const test = require('node:test');
const assert = require('node:assert/strict');
const {splitFaultCategoryPath}=require('../services/fault-category-path');
test('fault labels may contain slash without becoming another hierarchy level',()=>{
  assert.deepEqual(splitFaultCategoryPath('产品质量 / 牵引力小/无牵引力 / 大轮不良'),['产品质量','牵引力小/无牵引力','大轮不良']);
  assert.deepEqual(splitFaultCategoryPath('A|B/C|D'),['A','B/C','D']);
  assert.deepEqual(splitFaultCategoryPath('A/B/C'),['A','B','C']);
});
