[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = "DSH LAN Relay $Port"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限：右键“终端/PowerShell”选择“以管理员身份运行”，再执行本脚本。' -ForegroundColor Red
  Write-Host "也可以手动执行：" -ForegroundColor Yellow
  Write-Host "  New-NetFirewallRule -DisplayName `"$ruleName`" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -RemoteAddress LocalSubnet" -ForegroundColor Gray
  exit 1
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($Remove) {
  if ($existing) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "已删除防火墙规则：$ruleName" -ForegroundColor Green
  } else {
    Write-Host "没有找到规则：$ruleName" -ForegroundColor Yellow
  }
  exit 0
}

if ($existing) {
  Write-Host "规则已存在：$ruleName" -ForegroundColor Green
  Get-NetFirewallRule -DisplayName $ruleName | Select-Object DisplayName, Enabled, Direction, Action | Format-Table -AutoSize
  exit 0
}

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort $Port `
  -Action Allow `
  -Profile Private `
  -RemoteAddress LocalSubnet `
  -Description 'Allow DSH LAN Relay hub on the local subnet only' | Out-Null

Write-Host "已创建防火墙规则：$ruleName（仅 Private 配置文件、仅本地子网、TCP $Port）" -ForegroundColor Green
Write-Host '如果两台机器不在同一子网，需要把 -RemoteAddress 改成具体网段，例如 192.168.0.0/16。' -ForegroundColor DarkGray
