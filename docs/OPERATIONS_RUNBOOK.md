# FieldDesk 生产部署与故障恢复

## 部署

1. 从 `deploy/env/production.env.template` 生成 `/etc/fielddesk/fielddesk.env`，权限设为 `600`。密钥由密钥管理服务注入，禁止写入镜像或 Git。
2. 首次执行 `npm ci && npm run db:init && npm run db:migrate`，前端执行 `npm ci && npm run build`。
3. 安装 `deploy/systemd/fielddesk.service`，或使用 `docker compose up -d`。容器数据目录必须挂载持久化卷。
4. 使用 `deploy/nginx/fielddesk.conf` 终止 TLS。应用只监听回环地址，`TRUST_PROXY=loopback`，仅信任 Nginx 注入的代理头。
5. `/api/health` 用于进程存活检查，`/api/ready` 会验证工单和库存存储可读。

## 配置与安全

- production 启动时会拒绝本地测试账号、弱管理员密钥、HTTP 前端来源以及任何瑞云写开关。
- 管理员引导密钥至少 32 位；首次创建管理员后立即轮换并从环境移除。
- 正式访问令牌默认 12 小时过期，最长 168 小时。API 和登录接口分别限流。
- 上传仅允许 JPEG、PNG、WebP、MP4、MOV；默认单文件 25MB、总容量 5GB，文件名随机化且目录按工单哈希隔离。
- 应用和错误日志为 JSON Lines，按大小轮转并保留指定份数；审计日志保存在业务存储中，默认保留 365 天且最多 100000 条，并纳入备份。

## 备份、导出与恢复

- 每日执行 `npm run db:backup`；默认保留 30 天。备份目录必须放在异机或对象存储的加密卷。
- `npm run data:export -- /var/backups/fielddesk/export-YYYYMMDD` 导出业务数据。导出文件与生产数据同级保密。
- 恢复前停止 FieldDesk，验证备份校验和并额外备份当前数据，然后执行：
  `npm run db:restore -- /var/backups/fielddesk/<backup> --confirm`。
- 恢复后运行 `npm run db:migrate`，启动服务并检查 `/api/ready`，再抽查工单、库存、outbox 和审计记录。

## 故障处理

1. 就绪检查失败：停止流量，检查持久化卷权限、磁盘容量和 SQLite WAL 文件。
2. 数据库损坏：保留现场副本，停止服务，从最近成功备份恢复；不得直接覆盖仍运行的数据库。
3. 上传容量耗尽：停止上传，迁移整个上传目录到扩容卷；禁止只删除数据库仍引用的附件。
4. 密钥泄露：立即停用账号、轮换令牌，审计异常操作并重新部署环境密钥。
5. 瑞云同步异常：保持 outbox，不开启真实写入；进入人工复核，不重复提交业务节点。
