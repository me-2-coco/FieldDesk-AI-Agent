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
