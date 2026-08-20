class SupervisionInboxStore {
  constructor(backend) {
    this.backend = backend;
  }

  async readAll() {
    return this.backend.read();
  }

  save(input) {
    return this.backend.update((records) => {
      const now = new Date().toISOString();
      const existing = records.find((item) => item.sourceId === input.sourceId);
      const safe = {
        sourceId: input.sourceId,
        rmaNo: input.rmaNo,
        type: input.type || "",
        subtype: input.subtype || "",
        originalContent: input.originalContent,
        analysis: input.analysis,
        recloudStatus: input.recloudStatus || "未处理",
        matchedLocalOrder: input.matchedLocalOrder === true,
        updatedAt: now,
        archivedAt: null,
      };
      if (existing) {
        Object.assign(existing, safe);
        existing.capturedAt ||= now;
        existing.readBy ||= [];
        return structuredClone(existing);
      }
      const created = { ...safe, capturedAt: now, readBy: [] };
      records.push(created);
      return structuredClone(created);
    });
  }

  archive(sourceId) {
    return this.backend.update((records) => {
      const existing = records.find((item) => item.sourceId === sourceId);
      if (!existing) return null;
      existing.archivedAt = new Date().toISOString();
      existing.recloudStatus = "已完成";
      return structuredClone(existing);
    });
  }
}

module.exports = { SupervisionInboxStore };
