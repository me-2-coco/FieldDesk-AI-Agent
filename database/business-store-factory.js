const path = require("path");
const { createDocumentBackend } = require("./storage-backend");
const { JsonReceiptPreparationStore } = require("./receipt-preparation-store");
const { JsonInventoryStore, DEFAULT_PARTS } = require("./inventory-store");
const { SupervisionInboxStore } = require("./supervision-inbox-store");

function createBusinessStores(env = process.env) {
  const driver = String(env.FIELDDESK_STORAGE_DRIVER || "json").toLowerCase();
  const dataDirectory = env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, "data");
  const sqliteFile = env.FIELDDESK_SQLITE_FILE || path.join(dataDirectory, "fielddesk.sqlite");
  const backend = (namespace, jsonFile, initialValue) => createDocumentBackend({
    driver,
    filePath: driver === "sqlite" ? sqliteFile : path.join(dataDirectory, jsonFile),
    namespace,
    initialValue,
  });
  return {
    receiptStore: new JsonReceiptPreparationStore(backend("work_orders", "receipt-preparations.json", [])),
    supervisionInboxStore: new SupervisionInboxStore(backend("supervision_inbox", "supervision-inbox.json", [])),
    inventoryStore: new JsonInventoryStore(backend("inventory", "inventory.json", { totalStock: structuredClone(DEFAULT_PARTS), technicianStock: {}, returnRequests: [], transactions: [] })),
    driver,
  };
}

module.exports = { createBusinessStores };
