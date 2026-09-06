param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "print-agent.json")
)

$ErrorActionPreference = "Stop"
$AgentVersion = "1.0.0"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "未找到打印助手配置：$ConfigPath"
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$ApiBaseUrl = [string]$Config.apiBaseUrl
$TerminalId = [string]$Config.terminalId
$TerminalToken = [string]$Config.terminalToken
$PrinterName = [string]$Config.printerName
$ConfiguredPollSeconds = if ($null -eq $Config.pollSeconds) { 2 } else { [int]$Config.pollSeconds }
$PollSeconds = [Math]::Max(1, $ConfiguredPollSeconds)
$StatePath = Join-Path (Split-Path -Parent $ConfigPath) "print-agent-state.json"
$PrintedJobIds = New-Object "System.Collections.Generic.HashSet[string]"
if (Test-Path -LiteralPath $StatePath) {
  try {
    $SavedState = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    foreach ($SavedJobId in @($SavedState.printedJobIds)) {
      if ($SavedJobId) { [void]$PrintedJobIds.Add([string]$SavedJobId) }
    }
  } catch {
    Write-Warning "打印去重记录读取失败，将建立新记录。"
  }
}

if (-not $ApiBaseUrl -or -not $TerminalId -or -not $TerminalToken -or -not $PrinterName) {
  throw "配置不完整，需要 apiBaseUrl、terminalId、terminalToken、printerName"
}

if (-not ("FieldDesk.RawPrinter" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FieldDesk {
  public static class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO {
      [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
      [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
      [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern int StartDocPrinter(IntPtr printer, int level, [In] DOCINFO docInfo);
    [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

    public static void Send(string printerName, byte[] bytes, string documentName) {
      IntPtr printer;
      if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw new Win32Exception();
      try {
        var info = new DOCINFO { pDocName = documentName, pDataType = "RAW", pOutputFile = null };
        if (StartDocPrinter(printer, 1, info) == 0) throw new Win32Exception();
        try {
          if (!StartPagePrinter(printer)) throw new Win32Exception();
          try {
            int written;
            if (!WritePrinter(printer, bytes, bytes.Length, out written) || written != bytes.Length) throw new Win32Exception();
          } finally { EndPagePrinter(printer); }
        } finally { EndDocPrinter(printer); }
      } finally { ClosePrinter(printer); }
    }
  }
}
"@
}

$Headers = @{
  "X-Print-Terminal-Id" = $TerminalId
  "X-Print-Terminal-Token" = $TerminalToken
  "X-Print-Agent-Version" = $AgentVersion
  "X-Print-Computer-Name" = $env:COMPUTERNAME
}

function Invoke-FieldDeskApi {
  param([string]$Method, [string]$Path, [object]$Body = $null)
  $Arguments = @{
    Method = $Method
    Uri = "$($ApiBaseUrl.TrimEnd('/'))$Path"
    Headers = $Headers
    TimeoutSec = 30
  }
  if ($null -ne $Body) {
    $Arguments.ContentType = "application/json; charset=utf-8"
    $Arguments.Body = $Body | ConvertTo-Json -Depth 8 -Compress
  }
  return Invoke-RestMethod @Arguments
}

function Save-PrintedJobId {
  param([string]$JobId)
  [void]$script:PrintedJobIds.Add($JobId)
  $RecentIds = @($script:PrintedJobIds | Select-Object -Last 500)
  $TemporaryPath = "$StatePath.tmp"
  @{ printedJobIds = $RecentIds } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $TemporaryPath -Encoding UTF8
  Move-Item -LiteralPath $TemporaryPath -Destination $StatePath -Force
}

Write-Host "FieldDesk 打印助手已启动：$TerminalId -> $PrinterName"
while ($true) {
  try {
    $Response = Invoke-FieldDeskApi -Method Get -Path "/api/print-agent/jobs/next"
    $Job = $Response.data
    if ($null -eq $Job -or -not $Job.id) {
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    if ($PrintedJobIds.Contains([string]$Job.id)) {
      Invoke-FieldDeskApi -Method Post -Path "/api/print-agent/jobs/complete" -Body @{
        jobId = $Job.id
        success = $true
      } | Out-Null
      Start-Sleep -Milliseconds 200
      continue
    }

    try {
      $Bytes = [Convert]::FromBase64String([string]$Job.payloadBase64)
      $Copies = [Math]::Max(1, [Math]::Min(20, [int]$Job.copies))
      for ($Copy = 1; $Copy -le $Copies; $Copy++) {
        [FieldDesk.RawPrinter]::Send($PrinterName, $Bytes, "FieldDesk-$($Job.id)-$Copy")
      }
    } catch {
      $Message = $_.Exception.Message
      Invoke-FieldDeskApi -Method Post -Path "/api/print-agent/jobs/complete" -Body @{
        jobId = $Job.id
        success = $false
        error = $Message
      } | Out-Null
      Write-Warning "打印失败：$Message"
      continue
    }

    # 先在终端本地登记，再确认服务器任务。若确认时断网，租约过期后
    # 会再次取得同一任务，但本地记录可防止标签重复打印。
    Save-PrintedJobId -JobId ([string]$Job.id)
    Invoke-FieldDeskApi -Method Post -Path "/api/print-agent/jobs/complete" -Body @{
      jobId = $Job.id
      success = $true
    } | Out-Null
    Write-Host "打印成功：$($Job.title)"
  } catch {
    Write-Warning "连接 FieldDesk 失败，将自动重试：$($_.Exception.Message)"
    Start-Sleep -Seconds 10
  }
}
