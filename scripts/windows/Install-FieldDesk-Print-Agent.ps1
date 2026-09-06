param(
  [Parameter(Mandatory=$true)][string]$ApiBaseUrl,
  [Parameter(Mandatory=$true)][string]$TerminalId,
  [Parameter(Mandatory=$true)][string]$TerminalToken,
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [string]$InstallDirectory = "$env:ProgramData\FieldDeskPrintAgent",
  [string]$TaskName = "FieldDesk Print Agent"
)

$ErrorActionPreference = "Stop"
$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "请右键 PowerShell，选择‘以管理员身份运行’，再执行安装命令。"
}

$AgentSource = Join-Path $PSScriptRoot "FieldDesk-Print-Agent.ps1"
if (-not (Test-Path -LiteralPath $AgentSource)) {
  Write-Host "正在从 FieldDesk 下载打印助手..."
  Invoke-WebRequest -UseBasicParsing -Uri "$($ApiBaseUrl.TrimEnd('/'))/api/print-agent/download/agent" -OutFile $AgentSource
}
if (-not (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue)) {
  throw "Windows 中未找到打印机‘$PrinterName’，请先安装驱动并打印 Windows 测试页。"
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
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

& icacls.exe $InstallDirectory /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

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
