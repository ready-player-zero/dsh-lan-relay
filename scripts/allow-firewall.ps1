[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = "DSH LAN Relay $Port"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限：请在 DSH 设置页点「一键放行防火墙」（会弹出 UAC 授权），' -ForegroundColor Red
  Write-Host '或用管理员 PowerShell 执行本脚本。也可以手动执行下面任一条命令：' -ForegroundColor Yellow
  Write-Host "  New-NetFirewallRule -DisplayName `"$ruleName`" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -RemoteAddress LocalSubnet" -ForegroundColor Gray
  Write-Host "  netsh advfirewall firewall add rule name=`"$ruleName`" dir=in action=allow protocol=TCP localport=$Port profile=private remoteip=localsubnet" -ForegroundColor Gray
  exit 1
}

$hasCmdlet = $null -ne (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue)
$existing = if ($hasCmdlet) { Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue } else { $null }

if ($Remove) {
  if ($hasCmdlet -and $existing) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "已删除防火墙规则：$ruleName" -ForegroundColor Green
  } else {
    & netsh advfirewall firewall delete rule name="$ruleName" | Out-Null
    Write-Host "已尝试删除防火墙规则：$ruleName" -ForegroundColor Green
  }
  exit 0
}

if ($hasCmdlet -and $existing) {
  Write-Host "规则已存在：$ruleName" -ForegroundColor Green
  Get-NetFirewallRule -DisplayName $ruleName | Select-Object DisplayName, Enabled, Direction, Action | Format-Table -AutoSize
  exit 0
}

if ($hasCmdlet) {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow `
    -Profile Private `
    -RemoteAddress LocalSubnet `
    -Description 'Allow DSH LAN Relay hub on the local subnet only' | Out-Null
} else {
  # 部分精简版 Windows 没有 NetSecurity 模块，退回 netsh（同样需要管理员）
  & netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$Port profile=private remoteip=localsubnet | Out-Null
}

Write-Host "已创建防火墙规则：$ruleName（仅 Private 配置文件、仅本地子网、TCP $Port）" -ForegroundColor Green
Write-Host '如果两台机器不在同一子网，需要把 remoteip / -RemoteAddress 改成具体网段，例如 192.168.0.0/16。' -ForegroundColor DarkGray
