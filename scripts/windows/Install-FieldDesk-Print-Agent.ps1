param(
  [string]$ApiBaseUrl,
  [string]$TerminalId,
  [string]$TerminalToken,
  [string]$PrinterName,
  [string]$InstallDirectory = "$env:ProgramData\FieldDeskPrintAgent",
  [string]$TaskName = "FieldDesk Print Agent"
)

$ErrorActionPreference = "Stop"
$SetupPath = Join-Path $PSScriptRoot "setup.json"
$PackagedSetup = Test-Path -LiteralPath $SetupPath
$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($PackagedSetup) {
    $Child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit $Child.ExitCode
  }
  throw "请右键 PowerShell，选择‘以管理员身份运行’，再执行安装命令。"
}
if ($PackagedSetup) {
  $Setup = Get-Content -LiteralPath $SetupPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $ApiBaseUrl = [string]$Setup.apiBaseUrl
  $TerminalId = [string]$Setup.terminalId
  $TerminalToken = [string]$Setup.terminalToken
  $PrinterName = [string]$Setup.printerName
}
if (-not $ApiBaseUrl -or -not $TerminalId -or -not $TerminalToken) { throw "安装配置不完整，请重新下载安装包。" }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AgentSource = Join-Path $PSScriptRoot "FieldDesk-Print-Agent.ps1"
if (-not (Test-Path -LiteralPath $AgentSource)) {
  Write-Host "正在从 FieldDesk 下载打印助手..."
  Invoke-WebRequest -UseBasicParsing -Uri "$($ApiBaseUrl.TrimEnd('/'))/api/print-agent/download/agent" -OutFile $AgentSource
}
if (-not (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue)) {
  $Printers = @(Get-Printer | Where-Object { $_.DriverName -notmatch 'Microsoft|OneNote|Fax' })
  if ($Printers.Count -eq 0) { throw "未找到实体打印机，请先安装打印机驱动，然后重新运行安装程序。" }
  Write-Host "请选择旧件标签打印机："
  for ($i = 0; $i -lt $Printers.Count; $i++) { Write-Host "$($i + 1). $($Printers[$i].Name)" }
  $Choice = 0
  if (-not [int]::TryParse((Read-Host "输入打印机序号"), [ref]$Choice) -or $Choice -lt 1 -or $Choice -gt $Printers.Count) { throw "未选择有效打印机，请重新安装。" }
  $PrinterName = $Printers[$Choice - 1].Name
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName
  $StopDeadline = (Get-Date).AddSeconds(15)
  while ((Get-ScheduledTask -TaskName $TaskName).State -eq "Running") {
    if ((Get-Date) -gt $StopDeadline) { throw "旧版打印助手仍在运行，请稍后重试。" }
    Start-Sleep -Milliseconds 200
  }
}
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
& icacls.exe $InstallDirectory /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法保护终端密钥目录，已停止安装。" }
$AgentTarget = Join-Path $InstallDirectory "FieldDesk-Print-Agent.ps1"
$ConfigTarget = Join-Path $InstallDirectory "print-agent.json"
Copy-Item -LiteralPath $AgentSource -Destination $AgentTarget -Force

@{
  apiBaseUrl = $ApiBaseUrl.TrimEnd('/')
  terminalId = $TerminalId
  terminalToken = $TerminalToken
  printerName = $PrinterName
  pollSeconds = 2
} | ConvertTo-Json | Set-Content -LiteralPath $ConfigTarget -Encoding UTF8

$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentTarget`" -ConfigPath `"$ConfigTarget`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$User = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $User -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "安装完成。打印助手已启动，Windows 重启后会自动运行。"
Write-Host "终端：$TerminalId"
Write-Host "打印机：$PrinterName"
Write-Host "请在 FieldDesk 打印终端页面确认在线，并点击测试打印。安装包包含密钥，请删除下载包及解压目录。"
if ($PackagedSetup) { Read-Host "按回车关闭" | Out-Null }
