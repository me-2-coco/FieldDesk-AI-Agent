const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSnProductionMonth, evaluateWarranty } = require("../services/warranty-policy");

test("SN seventh and eighth positions resolve production year and letter month", () => {
  assert.deepEqual(parseSnProductionMonth("ABCDEF5A123"), { status: "PARSED", year: 2025, month: 10 });
  assert.deepEqual(parseSnProductionMonth("ABCDEF5B123"), { status: "PARSED", year: 2025, month: 11 });
  assert.deepEqual(parseSnProductionMonth("ABCDEF5C123"), { status: "PARSED", year: 2025, month: 12 });
});

test("purchase date takes priority and uses configured two-year warranty", () => {
  const result = evaluateWarranty({ sn: "ABCDEF53123", purchaseDate: "2025-03-10", now: "2027-03-10", warrantyYears: 2 });
  assert.equal(result.warrantyStatus, "保内");
  assert.equal(result.source, "PURCHASE_DATE");
  assert.equal(result.graceMonths, 0);
});

test("missing purchase date uses SN production month plus three-month grace", () => {
  const withinGrace = evaluateWarranty({ sn: "ABCDEF53123", now: "2027-06-30", warrantyYears: 2 });
  const expired = evaluateWarranty({ sn: "ABCDEF53123", now: "2027-07-01", warrantyYears: 2 });
  assert.equal(withinGrace.warrantyStatus, "保内");
  assert.equal(withinGrace.graceMonths, 3);
  assert.equal(expired.warrantyStatus, "保外");
});

test("three-year models override the default duration", () => {
  const result = evaluateWarranty({ sn: "ABCDEF53123", now: "2028-06-30", warrantyYears: 3 });
  assert.equal(result.warrantyStatus, "保内");
});

test("official refurbished machines always require human confirmation", () => {
  const result = evaluateWarranty({ sn: "ABCDEF53123", isOfficialRefurbished: true });
  assert.equal(result.status, "MANUAL_CONFIRMATION_REQUIRED");
});
