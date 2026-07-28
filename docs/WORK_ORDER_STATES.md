# FieldDesk 工单状态与流转

## 1. 设计约定

FieldDesk 不用一个字符串承载全部流程。物流、寄修、设备/SN、服务、检测、配件、维修、完工和返程发货是相互关联但独立的状态域。聚合工单状态用于列表展示，具体能否执行动作必须检查相关子状态、权限、数据完整性和瑞云同步结果。

每次流转必须记录：实体、原状态、目标状态、动作、操作者、时间、原因、关联请求 ID、幂等键及同步结果。状态只通过领域动作推进，不允许前端直接写任意状态值。

当前第一阶段只有只读查询流转可启用。下文中的所有瑞云写入、库存写入、检测提交、完工和发货动作均为后续设计，当前必须由 `DRY_RUN=true` 和写功能开关阻断。

## 2. 聚合工单状态

| 状态 | 含义 | 进入条件 | 可前往 |
| --- | --- | --- | --- |
| `AWAITING_ARRIVAL` | 已知寄修业务，机器未到店 | 已有关联寄修单且未扫描到店 | `ARRIVAL_LOOKUP_DONE`、`CANCELLED` |
| `ARRIVAL_LOOKUP_DONE` | 已只读查到瑞云信息 | 物流查询唯一匹配且字段快照可展示 | `AWAITING_RECEIPT`；V1 到此结束 |
| `AWAITING_RECEIPT` | 待拆包录 SN 并确认签收 | 瑞云状态允许签收 | `RECEIVED`、`ON_HOLD` |
| `RECEIVED` | 瑞云签收成功 | SN/备注校验通过且签收同步成功 | `INSPECTING` |
| `INSPECTING` | 检测中 | 已签收并分配师傅 | `WAITING_FOR_PARTS`、`REPAIRING`、`ON_HOLD` |
| `WAITING_FOR_PARTS` | 缺件暂停 | 检测确认需配件且个人库不足 | `INSPECTING`、`REPAIRING`、`ON_HOLD` |
| `REPAIRING` | 服务单已生成并维修中 | 检测完成、瑞云服务单生成成功 | `WAITING_FOR_PARTS`、`AWAITING_COMPLETION`、`ON_HOLD` |
| `AWAITING_COMPLETION` | 待完工确认 | 故障、措施、责任、用件和附件完整 | `COMPLETED`、`REPAIRING` |
| `COMPLETED` | FieldDesk 与瑞云维修节点完成 | 瑞云完工同步成功 | `AWAITING_RETURN_SHIPMENT` |
| `AWAITING_RETURN_SHIPMENT` | 待返程发货 | 已完工且收件信息可用 | `RETURN_SHIPPED` |
| `RETURN_SHIPPED` | 已返程发货 | 瑞云发货同步成功且有承运商/运单号 | `CLOSED` |
| `CLOSED` | 工单闭环 | 发货后满足关闭规则或确认送达 | 无 |
| `ON_HOLD` | 异常挂起 | 数据冲突、外部系统失败或人工暂停 | 返回挂起前状态或 `CANCELLED` |
| `CANCELLED` | 业务取消 | 有权限且符合瑞云取消规则 | 无 |

聚合状态由子状态计算并保留 `previous_state`，不能用聚合状态替代子状态对账。

## 3. 子状态机

### 3.1 物流单 `logistics_status`

| 状态 | 说明 | 流转条件 |
| --- | --- | --- |
| `CREATED` | 400 已在瑞云创建物流单 | 瑞云返回物流单号 |
| `IN_TRANSIT_TO_STORE` | 寄往维修门店 | 承运信息显示运输中（如接入） |
| `ARRIVED_AT_STORE` | 门店扫描到件 | 合法物流单号被扫描，物理包裹到店 |
| `MATCHED` | 唯一匹配寄修单 | 只读查询返回唯一寄修单 |
| `NO_MATCH` | 未匹配 | 瑞云查无结果；可重查，不自动创建单据 |
| `AMBIGUOUS` | 匹配多单 | 必须人工选择/瑞云修正，禁止签收 |
| `RETURN_PENDING` | 待返程发货 | 维修已完成 |
| `RETURN_SHIPPED` | 已返程发货 | 瑞云发货成功且运单信息完整 |

V1 只允许记录查询结果 `MATCHED`、`NO_MATCH` 或 `AMBIGUOUS`，不得推进瑞云状态。

### 3.2 寄修单 `repair_order_status`

| 状态 | 说明 | 流转条件 |
| --- | --- | --- |
| `PENDING_ARRIVAL` | 待机器到店 | 瑞云寄修单有效 |
| `PENDING_RECEIPT` | 已到店待签收 | 物流单匹配且瑞云允许签收 |
| `RECEIPT_PREPARED` | SN/备注已准备 | 后续阶段：拆包完成、SN 合法、备注符合品类；不代表瑞云已签收 |
| `RECEIVED` | 已签收 | 明确确认且瑞云返回成功 |
| `IN_SERVICE` | 已进入服务处理 | 关联服务单已生成 |
| `SERVICE_COMPLETED` | 维修节点完成 | 瑞云完工成功 |
| `RETURN_SHIPPED` | 已发货 | 瑞云返程发货成功 |
| `CANCELLED` | 已取消 | 瑞云或授权业务取消 |
| `SYNC_CONFLICT` | 状态冲突 | FieldDesk 与瑞云不一致，需对账 |

任何瑞云原始状态都同时保存为 `recloud_status_raw`，映射失败时进入同步异常而非猜测状态。

### 3.3 设备/SN `device_status`

| 状态 | 说明 | 流转条件 |
| --- | --- | --- |
| `UNSCANNED` | 尚未拆包扫描 | 到件查询后初始状态 |
| `SCANNED` | 已读取 SN | 扫描值非空且格式通过 |
| `VALIDATED` | SN 已校验 | SN 唯一、型号匹配、未绑定其他进行中工单 |
| `BOUND` | 已绑定本工单 | 签收准备确认后建立唯一有效绑定 |
| `IN_REPAIR` | 设备维修中 | 服务单开始维修 |
| `REPAIR_COMPLETED` | 设备维修完成 | 完工资料完整且维修确认 |
| `SHIPPED` | 已返程 | 关联返程物流已发货 |
| `QUARANTINED` | 隔离处理 | SN 冲突、型号不符或安全问题 |

SN 不是工单状态的一部分，应建独立设备记录和有时效的工单绑定关系，以支持同一机器多次维修。

### 3.4 服务单 `service_order_status`

| 状态 | 说明 | 流转条件 |
| --- | --- | --- |
| `NOT_CREATED` | 瑞云尚无服务单 | 签收后、点击维修前 |
| `CREATE_PENDING` | 等待创建 | 后续阶段：检测完成且收到点击维修命令 |
| `CREATED` | 瑞云已生成服务单 | 获取唯一服务单号并落库 |
| `IN_PROGRESS` | 维修处理中 | 服务单进入维修节点 |
| `COMPLETION_PENDING` | 待同步完工 | FieldDesk 完工资料校验通过 |
| `COMPLETED` | 瑞云已完工 | 瑞云确认成功并对账一致 |
| `FAILED` | 创建/推进失败 | 记录可重试错误，不重复生成 |
| `CANCELLED` | 服务单取消 | 瑞云正式取消 |

### 3.5 检测 `inspection_status`

`NOT_STARTED → IN_PROGRESS → COMPLETED`。只有寄修单 `RECEIVED` 且师傅已分配才能开始；完成必须具备检测结论、检测人和时间，并满足业务要求的证据。需要配件时可标记 `WAITING_FOR_PARTS`，异常可进入 `BLOCKED`，修正后回到 `IN_PROGRESS`。检测提交瑞云当前禁用。

### 3.6 配件申请与用件 `part_request_status` / `part_usage_status`

配件申请：

`DRAFT → SUBMITTED → APPROVED → ISSUED → CLOSED`

- 师傅按已校验 SN 和工单申请。
- 若配件已经在师傅个人库且规则允许，可走 `SUBMITTED → APPROVED` 自动批准，但仍不得绕过账务流水。
- 总库发至个人库时为 `ISSUED`，必须以同一库存事务生成总库出库和个人库入库双边流水。
- 拒绝为 `REJECTED`，取消为 `CANCELLED`，不得删除记录。

实际用件：

`RESERVED → CONSUMED`，或 `RESERVED → RELEASED`。

- “申请”和“使用”是两个事实；安装后立即确认 `CONSUMED`，从个人可用库存扣减并绑定工单/SN。
- 数量必须大于零且不得造成负库存。
- 错误使用通过冲销流水纠正，不修改或删除原流水。

配件归还：

`RETURN_REQUESTED → WAREHOUSE_PENDING → RETURN_CONFIRMED`，或 `RETURN_REJECTED/CANCELLED`。

- 师傅提交归还只冻结个人库存，不增加总库。
- 库房核验实物后，一笔事务同时减少师傅库存、增加总库并写双边流水。
- 旧件归还、未使用新件退料和报废应使用不同业务类型，具体规则待业务方确认。

### 3.7 维修 `repair_status`

| 状态 | 进入条件 | 退出条件 |
| --- | --- | --- |
| `NOT_STARTED` | 检测未完成 | 检测完成且服务单存在 |
| `IN_PROGRESS` | 师傅点击维修，服务单已生成 | 可转等待配件或待完工 |
| `WAITING_FOR_PARTS` | 缺少必要配件 | 配件可用后回 `IN_PROGRESS` |
| `PAUSED` | 人工暂停并填写原因 | 原师傅或管理员恢复 |
| `READY_TO_COMPLETE` | 三级故障、措施、责任、附件、实际用件齐备 | 人工确认提交 |
| `COMPLETED` | 瑞云维修节点完成且同步成功 | 进入返程发货 |
| `REWORK` | 完工前校验失败或授权返工 | 回 `IN_PROGRESS` |

维修措施由固定话术模板和 `CONSUMED` 的实际用件生成。申请中、已发料但未使用或已归还的配件不能进入措施。

### 3.8 完工 `completion_status`

`DRAFT → VALIDATED → CONFIRM_PENDING → SYNCING → COMPLETED`。校验必须覆盖三级故障、维修措施、质保责任、附件、用件一致性、服务单状态和操作者权限。失败进入 `VALIDATION_FAILED` 或 `SYNC_FAILED`，可修正/幂等重试；不得因前端显示成功而视为完成。当前所有同步动作禁用。

### 3.9 返程发货 `return_shipment_status`

`NOT_READY → READY → SUBMIT_PENDING → SHIPPED → DELIVERED/CLOSED`。只有完工已同步、客户收件资料有效且无阻断异常时为 `READY`。后续发货命令必须携带承运商、返程物流单号和幂等键，瑞云成功后才进入 `SHIPPED`。撤销、改址、拒收和物流异常规则待确认。当前发货动作禁用。

## 4. 跨域流转守卫

| 动作 | 必须满足 | 当前是否启用 |
| --- | --- | --- |
| 查询到店信息 | 合法物流单号、已登录只读会话 | 仅 mock/接口设计；不真实查询 |
| 准备签收 | 唯一寄修单、状态允许、SN 校验、品类备注确定 | 否 |
| 确认签收 | `receipt.confirm` 权限、人工确认、写开关、非 DRY_RUN、幂等键 | 否 |
| 开始检测 | 瑞云签收成功、师傅已分配 | 否 |
| 创建服务单 | 检测完成、人工点击维修、写开关 | 否 |
| 使用配件 | SN 已绑定、个人可用库存足够、数量合法、幂等键 | 否 |
| 确认归还 | 库房权限、实物核验、冻结库存足够 | 否 |
| 提交完工 | 三级故障/措施/责任/附件/用件齐全，人工确认 | 否 |
| 返程发货 | 瑞云完工成功、收件信息有效、物流资料完整 | 否 |

## 5. 并发、失败与补偿

- 状态表使用版本号做乐观锁；状态变化写唯一事件 ID。
- 外部写操作使用 outbox/sync task，不在数据库事务内假设瑞云成功。
- 超时状态视为“结果未知”，先查询对账再重试，防止重复签收、完工或发货。
- 库存用数据库事务和行锁/原子条件更新，禁止前端 `localStorage` 作为正式库存账。
- 人工纠错使用补偿事件和原因码，不覆盖历史。
- 第一阶段只读查询失败不会推进任何业务状态；重复查询只更新查询日志或快照时间。
