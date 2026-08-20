const path = require("path");
const crypto = require("crypto");
const { JsonDocumentBackend } = require("./storage-backend");

const DEFAULT_FILE = path.join(__dirname, "data", "inventory.json");
const DEFAULT_PARTS = [
  { code: "00100123", name: "主刷电机", stock: 50 },
  { code: "00100234", name: "电池组件", stock: 20 },
  { code: "00100345", name: "滚刷", stock: 0 },
];

function quantity(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    const error = new Error("数量必须是正整数");
    error.code = "INVENTORY_QUANTITY_INVALID";
    error.status = 400;
    throw error;
  }
  return result;
}

class JsonInventoryStore {
  constructor(filePath = DEFAULT_FILE) {
    this.filePath = typeof filePath === "string" ? filePath : DEFAULT_FILE;
    this.backend = typeof filePath === "object"
      ? filePath
      : new JsonDocumentBackend(this.filePath, { totalStock: structuredClone(DEFAULT_PARTS), technicianStock: {}, returnRequests: [], transactions: [] });
    this.queue = Promise.resolve();
  }
  async read() {
    return this.backend.read();
  }
  async write(data) {
    await this.backend.write(data);
  }
  run(work) {
    const operation = this.queue.then(async () => {
      const data = await this.read();
      const result = await work(data);
      await this.write(data);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  transaction(data, type, context, part, count, user) {
    data.transactions.push({
      id: crypto.randomUUID(), type, rmaNo: context.rmaNo, sn: context.sn,
      partCode: part.code, partName: part.name, quantity: count,
      technicianId: user.userId, technicianName: user.displayName,
      createdAt: new Date().toISOString(),
    });
  }
  technicianPart(data, user, part, create = false) {
    data.technicianStock[user.userId] ||= { technicianName: user.displayName, parts: [] };
    let item = data.technicianStock[user.userId].parts.find((entry) => entry.code === part.code);
    if (!item && create) {
      item = { code: part.code, name: part.name, stock: 0 };
      data.technicianStock[user.userId].parts.push(item);
    }
    return item;
  }
  async view(user, roles) {
    const data = await this.read();
    const privileged = [roles.ADMIN, roles.WAREHOUSE].includes(user.role);
    return {
      totalStock: data.totalStock,
      technicianStock: privileged
        ? data.technicianStock
        : { [user.userId]: data.technicianStock[user.userId] || { technicianName: user.displayName, parts: [] } },
      returnRequests: privileged ? data.returnRequests : data.returnRequests.filter((item) => item.technicianId === user.userId),
      transactions: privileged ? data.transactions : data.transactions.filter((item) => item.technicianId === user.userId),
    };
  }
  async usedPartsForOrder(rmaNo, sn) {
    const data = await this.read();
    const totals = new Map();
    data.transactions
      .filter((item) =>
        item.type === "PART_USED" &&
        item.rmaNo === rmaNo &&
        item.sn === sn
      )
      .forEach((item) => {
        const current = totals.get(item.partCode) || {
          partCode: item.partCode,
          partName: item.partName,
          quantity: 0,
        };
        current.quantity += item.quantity;
        totals.set(item.partCode, current);
      });
    return [...totals.values()];
  }
  apply(context, partCode, count, user) {
    return this.run((data) => {
      const amount = quantity(count);
      const total = data.totalStock.find((part) => part.code === partCode);
      if (!total) throw Object.assign(new Error("配件不存在"), { code: "PART_NOT_FOUND", status: 404 });
      if (total.stock < amount) throw Object.assign(new Error("总库库存不足"), { code: "PART_OUT_OF_STOCK", status: 409 });
      total.stock -= amount;
      const personal = this.technicianPart(data, user, total, true);
      personal.stock += amount;
      this.transaction(data, "PART_APPLIED", context, total, amount, user);
      const transaction = data.transactions.at(-1);
      return {
        application: {
          id: transaction.id,
          partCode: total.code,
          partName: total.name,
          quantity: amount,
          sn: context.sn,
        },
        part: personal,
        totalStock: total.stock,
      };
    });
  }
  use(context, partCode, count, user) {
    return this.run((data) => {
      const amount = quantity(count);
      const total = data.totalStock.find((part) => part.code === partCode);
      const personal = total && this.technicianPart(data, user, total);
      if (!personal || personal.stock < amount) throw Object.assign(new Error("个人库存不足"), { code: "TECHNICIAN_STOCK_INSUFFICIENT", status: 409 });
      personal.stock -= amount;
      this.transaction(data, "PART_USED", context, total, amount, user);
      return { part: personal };
    });
  }
  requestReturn(context, partCode, count, user) {
    return this.run((data) => {
      const amount = quantity(count);
      const total = data.totalStock.find((part) => part.code === partCode);
      const personal = total && this.technicianPart(data, user, total);
      if (!personal || personal.stock < amount) throw Object.assign(new Error("个人库存不足，不能超量退还"), { code: "RETURN_QUANTITY_EXCEEDED", status: 409 });
      personal.stock -= amount;
      const request = { id: crypto.randomUUID(), status: "PENDING_WAREHOUSE_CONFIRMATION", rmaNo: context.rmaNo, sn: context.sn, partCode: total.code, partName: total.name, quantity: amount, technicianId: user.userId, technicianName: user.displayName, createdAt: new Date().toISOString() };
      data.returnRequests.push(request);
      this.transaction(data, "RETURN_REQUESTED", context, total, amount, user);
      return request;
    });
  }
  confirmReturn(requestId, confirmer) {
    return this.run((data) => {
      const request = data.returnRequests.find((item) => item.id === requestId);
      if (!request || request.status !== "PENDING_WAREHOUSE_CONFIRMATION") throw Object.assign(new Error("未找到待确认退还申请"), { code: "RETURN_REQUEST_NOT_FOUND", status: 404 });
      const total = data.totalStock.find((part) => part.code === request.partCode);
      total.stock += request.quantity;
      request.status = "RETURN_CONFIRMED";
      request.confirmedBy = confirmer.displayName;
      request.confirmedAt = new Date().toISOString();
      this.transaction(data, "RETURN_CONFIRMED", request, total, request.quantity, { userId: request.technicianId, displayName: request.technicianName });
      return request;
    });
  }
}

module.exports = { JsonInventoryStore, DEFAULT_PARTS };
