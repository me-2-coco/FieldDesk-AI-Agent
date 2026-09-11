# FieldDesk 生产部署与多用户基础

## 存储

设置 `FIELDDESK_STORAGE_DRIVER`：

- `json`：兼容现有本地开发数据（默认）。
- `memory`：仅用于自动化测试。
- `sqlite`：单机生产部署，启用 WAL 与 5 秒 busy timeout。通过 `FIELDDESK_SQLITE_FILE` 指定数据库文件。

工单与库存通过统一文档存储接口读写；账号、工单锁、幂等记录和审计使用相同驱动。生产数据库文件必须位于持久化卷并纳入备份，不得提交 Git。

## 持久化目录与代理配置

新部署使用模板的持久化布局：数据库和业务数据在 `/var/lib/fielddesk/data`，附件在 `/var/lib/fielddesk/uploads`。API 签收、维修（含申请表）和发货附件统一读取 `FIELDDESK_UPLOAD_DIRECTORY`，备份/恢复也读取此变量。不要另设不同的 `FIELDDESK_BACKUP_UPLOAD_DIRECTORY`，冲突会被拒绝。systemd 的只读保护保持开启，上述两个目录均处于允许写入的 `/var/lib/fielddesk` 内；上线前应创建目录并授予服务账号权限。

这不是自动迁移：已有服务器改用新模板之前，必须停写、备份并迁移旧数据库和附件，然后校验恢复。未设置上传变量的本地环境仍使用原 `database/uploads`，本次不移动现用文件。备份仍要求停写，不代表在线一致性备份。

Nginx 请求体上限调整为 `140m`，与 API `140mb` 对齐，容纳 100 MB 文件的 Base64 包装；文件本身仍受后端大小及并发准入限制。移除所有业务请求共用的低额度 IP 桶，保留 API 按账号分开的业务限流、登录/认证失败 IP 限流。上线验收须在目标 Linux 上运行 `nginx -t`，测试同网点多账号和大文件上传；本机没有 Nginx，静态配置测试不等于目标服务器验收。

## 正式账号

本轮验证：部署路径/备份/限流针对性测试 12 项通过；独立临时副本的恢复回归 186 项通过（包含新增 3 项配置测试）。未启动 Nginx/systemd，也未执行正式数据迁移、服务重启或代码推送。

设置 `FIELDDESK_AUTH_MODE=accounts` 后，API 仅接受 `Authorization: Bearer <token>`。首次启动通过本地密钥配置 `FIELDDESK_BOOTSTRAP_ADMIN_TOKEN` 创建唯一管理员；创建成功后应轮换并移除该环境变量。

管理员通过 `/api/admin/users` 配置账号。角色为 `ADMIN`、`WAREHOUSE`、`TECHNICIAN`；师傅品类仅允许“扫地机”“洗地机”或两者。访问令牌仅保存 SHA-256 摘要，不通过 API 返回。

## 并发与审计

- `/api/orders/lock` 与 `/api/orders/unlock` 提供十分钟工单租约，其他用户不能修改已锁工单。
- 写请求可携带 `Idempotency-Key`；处理中重复请求返回冲突，已完成请求返回首次结果。
- 本地工单写操作记录操作人、动作、工单号、结果和时间；管理员通过 `/api/admin/audit-logs` 查看。

瑞云安全开关继续保持 `DRY_RUN=true`、`RECLOUD_WRITE_ENABLED=false`、`RECLOUD_REVEAL_PHONE_ENABLED=false`。
