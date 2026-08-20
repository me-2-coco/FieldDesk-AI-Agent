# FieldDesk 正式数据模型设计

## 1. 目标与约束

本设计面向关系型数据库（建议 PostgreSQL），当前只做结构设计，不创建迁移、不修改生产数据。正式数据以 UUID/ULID 作为内部主键，瑞云/飞书编号作为外部键；所有业务表包含 `created_at`、`updated_at`，关键表包含 `version` 用于乐观锁。时间统一存 UTC，展示时转换门店时区。

客户隐私、外部凭据与业务记录分离。数据库不保存瑞云 Cookie、浏览器登录状态、账号密码、飞书密钥或环境变量；这些由秘密管理设施提供。手机号、地址等敏感字段应加密存储并按权限脱敏展示。

## 2. 关系概览

```text
users ──< user_roles >── roles
  │                         │
  └──────────────┐          └──< role_permissions >── permissions
                 v
work_orders ──1 repair_orders (瑞云寄修单)
  │    │   │
  │    │   ├──< logistics_orders
  │    │   ├──< service_orders (瑞云服务单)
  │    │   ├──< inspections
  │    │   ├──< repair_actions / completion_records
  │    │   ├──< attachments
  │    │   └──< sync_tasks
  │    └──< work_order_devices >── devices (SN)
  └──< part_requests ──< part_request_items >── parts
                         │
warehouses ──< inventory_accounts ──< inventory_balances
                              └──< inventory_transactions >── parts
operation_logs 关联以上任意业务实体
```

## 3. 身份、角色与权限

### `users`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 用户 ID |
| `employee_no` | varchar unique nullable | 工号 |
| `account` | varchar unique | 登录账号 |
| `display_name` | varchar | 姓名 |
| `mobile_ciphertext` | text nullable | 加密手机号 |
| `store_id` | uuid nullable FK | 所属门店 |
| `status` | enum | `ACTIVE/LOCKED/DISABLED` |
| `last_login_at` | timestamptz nullable | 最近登录 |

### `roles`、`permissions`、`user_roles`、`role_permissions`

- `roles(id, code unique, name, data_scope, status)`：预置 `TECHNICIAN`、`WAREHOUSE`、`ADMIN`、`SERVICE_ACCOUNT`。
- `permissions(id, code unique, name, risk_level)`：动作级权限，不以页面菜单代替。
- `user_roles(user_id, role_id, store_id nullable, valid_from, valid_to, PK(user_id, role_id, store_id))`。
- `role_permissions(role_id, permission_id, PK(role_id, permission_id))`。

可补充 `stores(id, code unique, name, timezone, status)` 支持多门店数据隔离。

## 4. 工单、物流与设备

### `work_orders`

FieldDesk 聚合根，一次维修履约一条。

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | FieldDesk 工单 ID |
| `work_order_no` | varchar unique | FieldDesk 可读编号 |
| `store_id` | uuid FK | 执行门店 |
| `technician_id` | uuid FK nullable | 当前维修师傅 |
| `aggregate_status` | varchar | 聚合状态 |
| `previous_status` | varchar nullable | 挂起/恢复使用 |
| `priority` | varchar | 优先级 |
| `source` | varchar | `RECLOUD/MANUAL/IMPORT` |
| `current_repair_order_id` | uuid nullable | 当前寄修单 |
| `opened_at/closed_at` | timestamptz nullable | 生命周期 |
| `version` | integer not null | 乐观锁 |

索引：`(store_id, aggregate_status, updated_at)`、`technician_id`。

### `logistics_orders`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 物流记录 |
| `work_order_id` | uuid FK | 关联工单 |
| `direction` | enum | `INBOUND/RETURN` |
| `carrier_code/name` | varchar nullable | 承运商 |
| `tracking_no` | varchar | 物流单号 |
| `status` | varchar | 物流子状态 |
| `recloud_external_id` | varchar nullable | 瑞云外部标识 |
| `arrived_at/shipped_at/delivered_at` | timestamptz nullable | 节点时间 |
| `raw_status` | varchar nullable | 外部原始状态 |

唯一约束建议为 `(direction, carrier_code, tracking_no)`；若业务允许承运商未知，使用规范化追踪号的部分唯一索引并明确冲突处理。

### `devices`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 设备主键 |
| `sn_normalized` | varchar unique | 大写、去空格后的 SN |
| `sn_display` | varchar | 原展示值 |
| `product_id` | uuid nullable FK | 产品型号 |
| `device_status` | varchar | 当前设备状态 |
| `first_seen_at` | timestamptz | 首次扫描 |
| `last_seen_at` | timestamptz | 最近扫描 |

### `work_order_devices`

`(id, work_order_id, device_id, relation_type, bound_at, unbound_at, status)`。同一工单默认只有一个 `PRIMARY` 设备；同一设备允许历史上多次维修，但同一时刻只能绑定一个进行中工单，使用部分唯一索引实现。

### `products`

`(id, product_code, name, model, category, project_code, source, source_version, active)`。`category` 至少支持 `ROBOT_VACUUM`（扫地机）和 `FLOOR_WASHER`（洗地机）；映射与备注规则不可只靠名称模糊判断。

## 5. 瑞云寄修单、服务单和客户快照

### `repair_orders`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 本地寄修记录 |
| `work_order_id` | uuid FK | FieldDesk 工单 |
| `recloud_order_no` | varchar unique | 瑞云寄修单号 |
| `status` | varchar | 规范化寄修状态 |
| `recloud_status_raw` | varchar | 瑞云原值 |
| `customer_name_ciphertext` | text nullable | 客户姓名（按要求加密） |
| `customer_phone_ciphertext` | text nullable | 手机号密文 |
| `customer_phone_hash` | char(64) nullable index | 规范化值加盐哈希，用于精确查重 |
| `customer_address_ciphertext` | text nullable | 地址密文 |
| `product_name_snapshot` | varchar nullable | 查询时产品名称 |
| `product_model_snapshot` | varchar nullable | 查询时型号 |
| `reported_fault` | text nullable | 用户报修故障 |
| `receipt_remark` | varchar nullable | 后续签收备注 |
| `received_at` | timestamptz nullable | 瑞云签收时间 |
| `last_read_at` | timestamptz | 最近只读查询时间 |
| `source_payload_ref` | varchar nullable | 加密对象存储引用，不直接存整页 HTML |

如果 V1 只展示不落业务库，可先将结果写短期缓存和查询审计；是否持久化客户快照需由数据保留规则决定。

### `service_orders`

`(id, work_order_id, repair_order_id, recloud_service_no unique, status, recloud_status_raw, created_in_recloud_at, completed_in_recloud_at, last_synced_at, version)`。创建结果未知时不得另建新记录，应先按寄修单对账。

## 6. 检测、维修、故障、责任与完工

### `inspections`

`(id, work_order_id, inspector_id, status, finding, conclusion_code, started_at, completed_at, version)`。可增加 `inspection_items(id, inspection_id, item_code, result, note)` 支持标准检测清单。

### `fault_catalog`

`(id, source, level1_code/name, level2_code/name, level3_code/name, product_category, active, valid_from, valid_to, source_version)`；唯一约束 `(source, level3_code, source_version)`。工单选择必须保留编码、名称和版本快照。

### `repair_actions`

| 字段 | 说明 |
| --- | --- |
| `id/work_order_id/service_order_id` | 关联信息 |
| `technician_id` | 执行师傅 |
| `status` | 维修状态 |
| `fault_catalog_id` | 选中的三级故障 |
| `fault_code/name_snapshot` | 防止字典变化影响历史 |
| `measure_template` | 当时固定话术 |
| `generated_measure` | 系统生成的“固定话术 + 实际用件” |
| `technician_note` | 师傅补充说明，不覆盖生成内容 |
| `started_at/ready_at/completed_at` | 节点时间 |

### `warranty_responsibilities`

`(id, work_order_id unique, responsibility_code, responsibility_label, selected_by, selected_at, reason, rule_version)`。正式枚举待业务方提供，不能把“保内/保外”与责任主体混为一个自由文本字段。

### `completion_records`

`(id, work_order_id, service_order_id, status, validation_result jsonb, confirmed_by, confirmed_at, recloud_completed_at, idempotency_key unique, version)`。`validation_result` 保存当次校验项和结果，但核心查询字段仍需结构化。

## 7. 配件、仓库、个人库和库存流水

### `parts`

`(id, part_code unique, name, specification, unit, serialized boolean, active, source, source_version)`。串码配件可另建 `part_serials(id, part_id, serial_no unique, status)`。

### `warehouses` 与 `inventory_accounts`

- `warehouses(id, store_id, code unique, name, status)` 表示物理总库/库位。
- `inventory_accounts(id, account_type, warehouse_id nullable, user_id nullable, status)` 表示库存账账户；`account_type` 为 `WAREHOUSE` 或 `TECHNICIAN`，两种所有者只能存在一个。
- 对 `(account_type, warehouse_id)` 和 `(account_type, user_id)` 建条件唯一约束，避免重复账户。

### `inventory_balances`

`(inventory_account_id, part_id, on_hand_qty numeric, reserved_qty numeric, available_qty generated/validated, version, PK(inventory_account_id, part_id))`。数量单位规则确定后选择整数或定点数。任何更新不得使 `on_hand_qty`、`reserved_qty` 或可用量为负。

### `inventory_transactions`

库存流水为不可变账本：

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 流水 ID |
| `transaction_group_id` | uuid index | 同一次双边转移分组 |
| `account_id` | uuid FK | 发生账户 |
| `part_id` | uuid FK | 配件 |
| `quantity_delta` | numeric non-zero | 正入负出 |
| `balance_after` | numeric | 便于审计 |
| `transaction_type` | enum | 发料、领用、使用、退料、旧件归还、报废、盘点、冲销等 |
| `work_order_id/device_id` | uuid nullable | 绑定工单/SN |
| `reference_type/reference_id` | varchar/uuid | 申请、用件或归还来源 |
| `reversal_of_id` | uuid nullable FK | 冲销原流水 |
| `operator_id` | uuid FK | 操作人 |
| `occurred_at` | timestamptz | 业务时间 |
| `idempotency_key` | varchar unique | 防重复 |

库存余额与流水必须在同一数据库事务内更新。调拨生成来源账户负流水与目标账户正流水，二者 `transaction_group_id` 相同且数量守恒。

### `part_requests`、`part_request_items`、`part_usages`、`part_returns`

- `part_requests(id, request_no unique, work_order_id, device_id, requester_id, status, submitted_at, approved_by, approved_at, reason, version)`。
- `part_request_items(id, request_id, part_id, requested_qty, approved_qty, issued_qty, status)`。
- `part_usages(id, work_order_id, device_id, part_id, inventory_account_id, quantity, status, consumed_at, inventory_transaction_id, idempotency_key unique)`；只有 `CONSUMED` 进入维修措施。
- `part_returns(id, return_no unique, work_order_id, return_type, from_account_id, to_account_id, status, requested_by/at, confirmed_by/at, version)` 与 `part_return_items(id, return_id, part_id, quantity, condition_code, outbound_tx_id, inbound_tx_id)`。

## 8. 附件

### `attachments`

| 字段 | 说明 |
| --- | --- |
| `id/work_order_id` | 主键与工单 |
| `attachment_type` | 维修前、铭牌/SN、故障证据、维修后、视频、物流等 |
| `media_type` | `IMAGE/VIDEO/OTHER` |
| `storage_provider/object_key` | 私有对象存储定位；不保存公开永久 URL |
| `original_filename/mime_type/size_bytes/checksum` | 文件元数据与去重 |
| `status` | `UPLOADING/READY/FAILED/QUARANTINED/DELETED` |
| `uploaded_by/uploaded_at` | 上传人和时间 |
| `recloud_attachment_id/sync_status` | 后续瑞云同步信息 |

上传需校验 MIME、大小、病毒/恶意内容和业务必传类型；下载使用短期签名 URL并审计。

## 9. 瑞云同步任务与操作日志

### `sync_tasks`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 任务 ID |
| `system` | enum | `RECLOUD/FEISHU` |
| `operation` | varchar | `LOOKUP_REPAIR_ORDER`、`CONFIRM_RECEIPT` 等 |
| `mode` | enum | `READ_ONLY/DRY_RUN/WRITE` |
| `entity_type/entity_id` | varchar/uuid nullable | 业务关联 |
| `status` | enum | `PENDING/RUNNING/SUCCEEDED/RETRY_WAIT/FAILED/DEAD_LETTER/CANCELLED` |
| `idempotency_key` | varchar | 写操作必填 |
| `request_payload_redacted` | jsonb | 脱敏请求摘要 |
| `response_payload_redacted` | jsonb | 脱敏响应摘要 |
| `attempt_count/max_attempts/next_attempt_at` | integer/integer/timestamptz | 重试控制 |
| `last_error_code/message` | varchar/text | 脱敏错误 |
| `correlation_id` | varchar index | 全链路关联 |
| `started_at/finished_at` | timestamptz nullable | 执行时间 |

建议唯一约束 `(system, operation, idempotency_key)`（只读查询可不使用业务幂等键）。第一阶段的任务只允许 `operation=LOOKUP_REPAIR_ORDER` 且 `mode=READ_ONLY`；数据库约束之外，应用层还要使用写操作 allowlist，默认空集。

### `operation_logs`

不可变审计表：`(id, actor_type, actor_user_id, action, entity_type, entity_id, result, reason_code, before_summary jsonb, after_summary jsonb, ip_hash, user_agent_hash, correlation_id, occurred_at)`。禁止记录秘密、完整 Cookie、完整页面 HTML和不必要的客户隐私。审计日志不通过普通业务接口更新或删除。

可补充 `work_order_state_events(id, work_order_id, domain, from_state, to_state, action, actor_id, reason, correlation_id, occurred_at)` 作为状态历史的结构化来源。

## 10. 关键完整性与索引

- 瑞云寄修单号、服务单号、配件编码、规范化 SN 各自唯一。
- 一个进行中工单只能有一个主 SN；一个 SN 同时只能绑定一个进行中工单。
- `part_usages.quantity > 0`、所有库存余额非负、库存流水增量非零。
- 完工、签收、发货等外部命令具有唯一幂等键。
- 外键默认 `RESTRICT`；业务记录采用状态停用而非级联删除。
- 常用索引：工单状态+门店、师傅+状态、物流单号、客户手机号哈希、SN、同步任务状态+下次执行时间、审计实体+时间。
- 状态值建议使用受控字典表或检查约束；迁移时可扩展，不允许任意自由文本。

## 11. 数据归属与保留

- 瑞云权威：寄修单/服务单编号、客户报修信息、瑞云节点状态、三级故障字典（若由瑞云维护）。
- FieldDesk 权威：维修执行过程、本地任务分配、附件元数据、库存账与操作审计；与实际财务库存的权威关系待确认。
- 飞书：当前视为参考字典/厂家资料来源，不作为事务型库存或工单数据库。
- 客户快照、附件和日志的保留期限、删除/匿名化流程、门店数据隔离规则须由业务与合规确认后落库。

## 12. 实施前待确认

正式建迁移前需确认：数据库引擎与部署方式、多门店范围、客户字段加密方案、手机号查重需求、库存单位与小数精度、负库存政策、串码件范围、旧件归还/报废会计规则、状态字典、附件存储与期限、瑞云 API 能力、飞书字段及数据权威关系。
