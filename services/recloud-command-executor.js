const { validateNodePayload } = require("../connectors/recloud-sync-mapping");
const { orchestrateRepairCompletion, repairCompletionFingerprint } = require("./recloud-repair-completion-orchestrator");

function commandError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.permanent = true;
  Object.assign(error, details);
  return error;
}

function createRecloudCommandExecutor(options = {}) {
  const repairAdapterProvider = options.repairAdapterProvider || null;
  const checkpointStore = options.checkpointStore || null;

  return {
    async reconcileTask(task) {
      if (task.nodeType !== "REPAIR_COMPLETED" || !checkpointStore?.load) return null;
      const orderKey = task.rmaNo || task.workOrderNo;
      const prior = await checkpointStore.load(String(orderKey || ""));
      if (!prior || !["SUBMITTING", "SUCCESS", "ATTACHMENTS_UPLOADING"].includes(prior.status)
        || prior.fingerprint !== repairCompletionFingerprint(orderKey, task.payload)) return null;
      const inspect = async adapter => {
        if (typeof adapter?.readRemoteState !== "function") return null;
        const remote = await adapter.readRemoteState();
        if (prior.status === 'ATTACHMENTS_UPLOADING') {
          if (typeof adapter.prepareAttachmentIdentities !== 'function') return null;
          const files = await adapter.prepareAttachmentIdentities((task.payload.attachments || []).filter(file => file.source !== 'INSPECTION_REPORT'));
          if (!require('./repair-attachment-identity').verifiedRepairManifest(files, remote.attachments, prior.attachmentManifest)) return null;
          // Another authorized operator may have submitted while this task was
          // paused. Finalize locally only; never reopen a submitted repair for writes.
          if (remote.completed === true) return { status: 'SUCCESS', completedSteps: ['REMOTE_SUBMISSION_RECONCILED'] };
          // Preserve the checkpoint until a scheduled execution has re-read it;
          // returning READY_TO_RESUME does not claim the repair is completed.
          return { status: 'READY_TO_RESUME', step: 'ATTACHMENTS_VERIFIED' };
        }
        if (remote?.completed !== true) return null;
        return { status: "SUCCESS", completedSteps: ["REMOTE_SUBMISSION_RECONCILED"] };
      };
      if (typeof repairAdapterProvider?.run === "function") return repairAdapterProvider.run(task, inspect);
      if (typeof repairAdapterProvider?.open !== "function") return null;
      const adapter = await repairAdapterProvider.open(task);
      try { return await inspect(adapter); }
      finally { if (adapter && repairAdapterProvider.release) await repairAdapterProvider.release(adapter, task); }
    },

    isReady(nodeKey) {
      return nodeKey === "repair" && (
        typeof repairAdapterProvider?.run === "function"
        || typeof repairAdapterProvider?.open === "function"
      );
    },

    async syncRepairCompleted(task) {
      validateNodePayload("REPAIR_COMPLETED", task?.payload);
      if (!repairAdapterProvider || (
        typeof repairAdapterProvider.run !== "function"
        && typeof repairAdapterProvider.open !== "function"
      )) {
        throw commandError(
          "瑞云维修完工页面执行器尚未装配",
          "RECLOUD_REPAIR_PAGE_ADAPTER_NOT_CONFIGURED",
          { nodeKey: "repair" }
        );
      }
      const execute = async (adapter) => {
        if (!adapter) {
          throw commandError(
            "无法打开瑞云维修完工页面执行器",
            "RECLOUD_REPAIR_PAGE_ADAPTER_UNAVAILABLE",
            { nodeKey: "repair" }
          );
        }
        // The durable outbox handoff is a second read-only guard even if the
        // browser checkpoint is missing or the global setting later changes.
        if (task.resultStatus === 'AWAITING_INFORMATION_CLERK') {
          const remote = await adapter.readRemoteState();
          return { status: remote.completed === true ? 'SUCCESS' : 'AWAITING_INFORMATION_CLERK',
            completedSteps: task.completedSteps || [], finalConfirmClicked: false,
            informationClerkAction: task.payload?.treatmentMode === 'INSPECTION_ONLY'
              ? '开检测报告、上传检测报告、修改地址并提交' : '核对维修资料并提交' };
        }
        return orchestrateRepairCompletion(
          task.rmaNo || task.workOrderNo,
          task.payload,
          adapter,
          {
            writeEnabled: options.writeEnabled === true,
            checkpointStore,
            submitReadyTimeoutMs: options.submitReadyTimeoutMs,
            submitReadyPollIntervalMs: options.submitReadyPollIntervalMs,
            preparationCompleted: Boolean(task.payload?.repairPreparationCompletedAt),
            allowPreparationRecovery: task.payload?.repairPreparationStatus === "FAILED",
            authorizedSkippedPartCodes: task.payload?.completionAuthorizedSkippedPartCodes || [],
            authorizedExistingPartCodes: task.payload?.completionAuthorizedExistingPartCodes || [],
            missingParts: task.payload?.missingParts || [],
          }
        );
      };
      if (typeof repairAdapterProvider.run === "function") {
        return repairAdapterProvider.run(task, execute);
      }
      const adapter = await repairAdapterProvider.open(task);
      if (!adapter) {
        throw commandError(
          "无法打开瑞云维修完工页面执行器",
          "RECLOUD_REPAIR_PAGE_ADAPTER_UNAVAILABLE",
          { nodeKey: "repair" }
        );
      }
      try {
        return await execute(adapter);
      } finally {
        if (typeof repairAdapterProvider.release === "function") {
          await repairAdapterProvider.release(adapter, task);
        }
      }
    },
  };
}

module.exports = { commandError, createRecloudCommandExecutor };
