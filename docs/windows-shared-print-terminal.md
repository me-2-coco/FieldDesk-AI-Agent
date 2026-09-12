# FieldDesk Windows 共享打印终端

一台长期在线的 Windows 电脑连接一台 XP-420B，2–5 名师傅共用。师傅在手机 FieldDesk 中产生旧件标签任务后，后台按账号分配到对应打印终端；电脑端打印助手每 2 秒取一次任务并发送给 Windows 打印机。

## 首次安装

1. 用 USB 把 XP-420B 接到 Windows 电脑，安装芯烨驱动，并先从 Windows 打印测试页确认打印机正常。
2. 在 FieldDesk 的“我的 → 打印终端”中新增终端，填写 Windows 中显示的完整打印机名称，勾选这台打印机服务的师傅。
3. 创建后立即复制终端 ID 和一次性密钥。密钥不会再次显示。
4. 把 `scripts/windows` 文件夹复制到 Windows，以管理员身份打开 PowerShell，在该目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-FieldDesk-Print-Agent.ps1 `
  -ApiBaseUrl "https://你的FieldDesk地址" `
  -TerminalId "终端ID" `
  -TerminalToken "一次性密钥" `
  -PrinterName "XP-420B"
```

安装脚本会把程序和终端密钥放到 `C:\ProgramData\FieldDeskPrintAgent`，并限制为 SYSTEM 和管理员可访问；随后注册为 SYSTEM 开机任务并立即启动。

## 日常运行规则

- Windows 锁屏、显示器熄屏不影响打印。
- 不能让电脑进入睡眠或休眠；建议把“接通电源后睡眠”设置为“从不”。
- 网络或打印机短暂离线时，任务保留在服务器；管理页面可查看失败原因并重试。
- 电脑关机时不会打印，重新开机后打印助手会继续取队列中的任务。
- 不需要在每位师傅手机上安装打印助手，iPhone 和 Android 都只负责提交任务。
- 真实终端密钥只保存在安装电脑，禁止放入 Git 或截图转发。

## 瑞云原始旧件标签（XP-420B 点阵输出）

- 仅在保内完工后，按工单实际用件核对瑞云“是否返厂”和数量，勾选目标行，再点击“旧件打印标签”。保外跳过。
- 读取新打开的“面单打印”窗口中的原始 PDF；找不到、多个候选、页面/数量/条码不匹配时停止，禁止用 FieldDesk 自制标签替代。
- 每页必须是 80×60 mm，并包含本单寄修条码和“维修单号+配件编码”条码。保留原 PDF、SHA-256 和页码；按原文档栅格化，不重新排字或生成条码。
- 当前已确认纸张为 76×130 mm。原标签旋转后等比放大 120% 为 72×96 mm，居中打印（左右各留 2 mm，上下各留 17 mm；PDF 自身白边仍保留）。服务端转换为 576×768 单色点阵，并再次解码核对两个原始条码；不通过则停止。通过 TSPL BITMAP 把原图交给 Windows RAW 通道，每张先 CLS 清空打印缓冲区。正式标签不包含诊断标记。
- 每页独立任务，同一批次重复执行不产生重复队列；队列完成表示已提交 Windows 打印系统，实物是否出纸与扫码仍需现场核验。
- 正式原图点阵任务使用 TSPL，现有助手无需再升级。历史 PNG 任务仍要求 1.1.0 助手。升级时先下载新脚本，再停止计划任务、替换程序、启动计划任务，原配置与去重记录保留。不要在任务正在打印时升级。

后端需要专用 Python 环境：`python3 -m venv runtime/print-python`，使用该环境安装 `requirements-print.txt`，并设置 `FIELDDESK_PRINT_PYTHON` 为其中 Python 的绝对路径。PDF 在独立进程中解析，设有大小、页数和超时限制；缺依赖会明确停止，不会静默改用自制标签。

验证：`node --test test/old-part-pdf.test.js test/print-job-store-store.test.js test/recloud-repair-completion-orchestrator.test.js`；Python 测试还需安装 reportlab，并运行 `python test/old-part-pdf-renderer_test.py`。浏览器测试只访问模拟页面，不能代表瑞云实际 DOM 已通过验收。

现场验证：76×130 mm 纸张上的原图对照样张已确认包含完整中文表格、两个条码和独立诊断标记。该验证只确认 RAW 点阵输出，未替代正式瑞云工单自动获取 PDF 的验收，也未代表现场扫码已通过。
