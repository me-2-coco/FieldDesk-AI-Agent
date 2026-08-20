# FieldDesk 生产部署与多用户基础

## 存储

设置 `FIELDDESK_STORAGE_DRIVER`：

- `json`：兼容现有本地开发数据（默认）。
- `memory`：仅用于自动化测试。
- `sqlite`：单机生产部署，启用 WAL 与 5 秒 busy timeout。通过 `FIELDDESK_SQLITE_FILE` 指定数据库文件。

工单与库存通过统一文档存储接口读写；账号、工单锁、幂等记录和审计使用相同驱动。生产数据库文件必须位于持久化卷并纳入备份，不得提交 Git。

## 正式账号

设置 `FIELDDESK_AUTH_MODE=accounts` 后，API 仅接受 `Authorization: Bearer <token>`。首次启动通过本地密钥配置 `FIELDDESK_BOOTSTRAP_ADMIN_TOKEN` 创建唯一管理员；创建成功后应轮换并移除该环境变量。

管理员通过 `/api/admin/users` 配置账号。角色为 `ADMIN`、`WAREHOUSE`、`TECHNICIAN`；师傅品类仅允许“扫地机”“洗地机”或两者。访问令牌仅保存 SHA-256 摘要，不通过 API 返回。

## 并发与审计

- `/api/orders/lock` 与 `/api/orders/unlock` 提供十分钟工单租约，其他用户不能修改已锁工单。
- 写请求可携带 `Idempotency-Key`；处理中重复请求返回冲突，已完成请求返回首次结果。
- 本地工单写操作记录操作人、动作、工单号、结果和时间；管理员通过 `/api/admin/audit-logs` 查看。

瑞云安全开关继续保持 `DRY_RUN=true`、`RECLOUD_WRITE_ENABLED=false`、`RECLOUD_REVEAL_PHONE_ENABLED=false`。
