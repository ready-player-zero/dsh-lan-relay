[CmdletBinding()]
param(
  [ValidateSet('hub', 'peer')][string]$Role = 'hub',
  [string]$Self = '',
  [string]$HubUrl = '',
  [string]$Token = '',
  [int]$Port = 8787,
  [string]$ConfigPath = '',
  [string]$DefaultSession = '',
  [switch]$DisablePush,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot

function New-Token {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-LanIps {
  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -ExpandProperty IPAddress
  } catch {
    @()
  }
}

function Pick-LanIp {
  param([string[]]$Ips)
  $order = @('192.168.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.20.*', '172.21.*', '172.22.*', '172.23.*', '172.24.*', '172.25.*', '172.26.*', '172.27.*', '172.28.*', '172.29.*', '172.30.*', '172.31.*')
  foreach ($pattern in $order) {
    $hit = $Ips | Where-Object { $_ -like $pattern } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return ($Ips | Select-Object -First 1)
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $env:USERPROFILE '.dsh\lan-relay\config.json'
}
$ConfigDir = Split-Path -Parent $ConfigPath

$existing = $null
if ((Test-Path $ConfigPath) -and -not $Force) {
  try {
    $existing = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
  } catch {
    Write-Warning "已存在的配置无法解析，将按参数重新生成：$ConfigPath"
    $existing = $null
  }
}

function Get-ExistingValue {
  param([string]$Name, $Default)
  if ($existing -and ($existing.PSObject.Properties.Name -contains $Name)) {
    $value = $existing.$Name
    if ($null -ne $value -and "$value" -ne '') { return $value }
  }
  return $Default
}

$hostname = ($env:COMPUTERNAME -as [string])
if (-not $hostname) { $hostname = 'dsh' }
$defaultSelf = $hostname.ToLower() -replace '[^a-z0-9._-]', '-'

$resolvedSelf = if ($Self) { $Self.ToLower() } else { Get-ExistingValue -Name 'self' -Default $defaultSelf }
$resolvedToken = if ($Token) { $Token } else { Get-ExistingValue -Name 'token' -Default (New-Token) }

if ($Role -eq 'hub') {
  $lanIp = Pick-LanIp -Ips (Get-LanIps)
  $defaultUrl = if ($lanIp) { "http://${lanIp}:$Port" } else { "http://127.0.0.1:$Port" }
  $resolvedUrl = if ($HubUrl) { $HubUrl } else { Get-ExistingValue -Name 'relay_url' -Default $defaultUrl }
} else {
  $resolvedUrl = if ($HubUrl) { $HubUrl } else { Get-ExistingValue -Name 'relay_url' -Default '' }
  if (-not $resolvedUrl) {
    $resolvedUrl = Read-Host '请输入 hub 机器的局域网地址（例如 http://10.0.0.10:8787）'
    if (-not $resolvedUrl) { throw '缺少 -HubUrl：peer 模式必须知道 hub 的地址' }
  }
}

$resolvedUrl = $resolvedUrl.TrimEnd('/')

$hubConfig = $null
if ($existing -and ($existing.PSObject.Properties.Name -contains 'hub')) { $hubConfig = $existing.hub }

$dataDir = if ($hubConfig -and ($hubConfig.PSObject.Properties.Name -contains 'data_dir') -and $hubConfig.data_dir) {
  $hubConfig.data_dir
} else {
  Join-Path $env:USERPROFILE '.dsh\lan-relay\hub'
}

$stateDir = Get-ExistingValue -Name 'state_dir' -Default (Join-Path $env:USERPROFILE '.dsh\lan-relay\state')

# push 段：保留已有配置；可用 -DefaultSession 指定默认投递会话，-DisablePush 关闭自动唤醒
$existingPush = $null
if ($existing -and ($existing.PSObject.Properties.Name -contains 'push')) { $existingPush = $existing.push }
$pushDefault = ''
if ($DefaultSession) {
  $pushDefault = $DefaultSession
} elseif ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'default_session')) {
  $pushDefault = [string]$existingPush.default_session
}
$pushEnabled = $true
if ($DisablePush) {
  $pushEnabled = $false
} elseif ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'enabled')) {
  $pushEnabled = [bool]$existingPush.enabled
}
$pushWake = $true
if ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'wake')) { $pushWake = [bool]$existingPush.wake }
$pushTimeout = 25
if ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'poll_timeout_seconds')) { $pushTimeout = [int]$existingPush.poll_timeout_seconds }
# 策略开关：目标会话不在线时是否兜底改投；无 to_session 是否拒收
$pushOfflineFallback = $false
if ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'offline_fallback')) { $pushOfflineFallback = [bool]$existingPush.offline_fallback }
$pushRequireSession = $false
if ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'require_session')) { $pushRequireSession = [bool]$existingPush.require_session }
# 目标会话不在线时：prompt = 冷启动投递（sessionController.prompt 自动 resume）；drop = 放弃
$pushColdSession = 'prompt'
if ($existingPush -and ($existingPush.PSObject.Properties.Name -contains 'cold_session') -and "$($existingPush.cold_session)" -eq 'drop') { $pushColdSession = 'drop' }

New-Item -ItemType Directory -Force -Path $ConfigDir, $stateDir | Out-Null

$config = [ordered]@{
  relay_url          = $resolvedUrl
  token              = $resolvedToken
  self               = $resolvedSelf
  state_dir          = $stateDir
  request_timeout_ms = 15000
  hub                = [ordered]@{
    host     = '0.0.0.0'
    port     = $Port
    data_dir = $dataDir
  }
  push               = [ordered]@{
    enabled              = $pushEnabled
    default_session      = $pushDefault
    wake                 = $pushWake
    poll_timeout_seconds = $pushTimeout
    offline_fallback     = $pushOfflineFallback
    require_session      = $pushRequireSession
    cold_session         = $pushColdSession
  }
}

$json = $config | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$nodePath = $null
try { $nodePath = (Get-Command node -ErrorAction Stop).Source } catch { $nodePath = $null }

$mcpServerPath = Join-Path $ProjectDir 'mcp-server.mjs'
$connectorJson = [ordered]@{
  mcpServers = [ordered]@{
    'lan-relay' = [ordered]@{
      command = 'node'
      args    = @($mcpServerPath)
      env     = [ordered]@{ LAN_RELAY_CONFIG = $ConfigPath }
    }
  }
} | ConvertTo-Json -Depth 8

$connectorFile = Join-Path $ConfigDir 'mcp-connector.json'
[System.IO.File]::WriteAllText($connectorFile, $connectorJson, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "  LAN Relay 配置完成（$Role）" -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "  角色       : $Role"
Write-Host "  peer 名    : $resolvedSelf"
Write-Host "  hub 地址   : $resolvedUrl"
Write-Host "  token      : $resolvedToken"
Write-Host "  配置文件   : $ConfigPath"
Write-Host "  游标目录   : $stateDir"
Write-Host "  push 自动唤醒 : $(if ($pushEnabled) { '开启' } else { '关闭' })  默认会话: $(if ($pushDefault) { $pushDefault } else { '(最近活跃会话)' })"
Write-Host "  MCP 路径   : $mcpServerPath"
Write-Host "  MCP 配置   : $connectorFile"
Write-Host "  Node       : $(if ($nodePath) { "$nodePath $(& node --version)" } else { '未找到！请安装 Node.js 18+ 并加入 PATH' })"
Write-Host ''

if ($Role -eq 'hub') {
  $allIps = Get-LanIps
  if ($allIps.Count -gt 1) {
    Write-Host "  注意：检测到多个局域网 IP：$($allIps -join ', ')" -ForegroundColor Yellow
    Write-Host "        relay_url 目前用的是 $resolvedUrl，请确认与另一台机器在同一网段；不对就改配置文件或用 -HubUrl 重跑。" -ForegroundColor Yellow
    Write-Host ''
  }
  Write-Host '接下来（hub 机器）：' -ForegroundColor Yellow
  Write-Host "  1) 启动 hub："
  Write-Host "       node `"$ProjectDir\hub.mjs`" --config `"$ConfigPath`""
  Write-Host "     或后台常驻："
  Write-Host "       powershell -NoProfile -ExecutionPolicy Bypass -File `"$ProjectDir\scripts\install-autostart.ps1`""
  Write-Host "  2) 放行防火墙（管理员 PowerShell 执行一次）："
  Write-Host "       powershell -NoProfile -ExecutionPolicy Bypass -File `"$ProjectDir\scripts\allow-firewall.ps1`" -Port $Port"
  Write-Host ''
} else {
  Write-Host '接下来（peer 机器）：' -ForegroundColor Yellow
  Write-Host "  1) 确认能访问 hub：node `"$ProjectDir\relay-cli.mjs`" status"
  Write-Host "  2) 装自动唤醒插件（需要本机 DSH 自带的 CLI，装完重启 DSH）："
  Write-Host "       & `"<本机 DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`" plugin --profile desktop add `"file:$ProjectDir\push-plugin`""
  Write-Host "  3) 想让消息默认投到某个会话：先拿到会话 id（DSH 会话里执行 echo `$env:DSH_SESSION_ID），再重跑："
  Write-Host "       scripts\setup.ps1 -Role peer -Self $resolvedSelf -HubUrl $resolvedUrl -Token $resolvedToken -DefaultSession <session-id>"
  Write-Host "  4) 重启 DSH 后验证：node `"$ProjectDir\relay-cli.mjs`" status && node `"$ProjectDir\relay-cli.mjs`" peers"
  Write-Host '  注意：peer 机器不要启动 hub（不要跑 install-autostart.ps1 / start-hub.cmd），hub 只跑在 hub 机器上。'
  Write-Host ''
}

Write-Host '把下面这段作为自定义 stdio MCP 连接加进 DSH（两台机器都要加）：' -ForegroundColor Yellow
Write-Host '  - GUI：设置 → MCP 连接器 → 自定义 → 传输方式 stdio，命令填 node，参数填 mcp-server.mjs 的绝对路径'
Write-Host '  - 或把 mcp-connector.json 导入：'
Write-Host '       mcp_connector_import_json，内容如下：' -ForegroundColor DarkGray
Write-Host ''
Write-Host $connectorJson -ForegroundColor Gray
Write-Host ''
Write-Host '另一台机器的配置只需要改 relay_url（指向 hub）和 self（本机名字），token 必须一致。' -ForegroundColor DarkGray
Write-Host '把该值发给另一台机器，在那边执行：' -ForegroundColor DarkGray
Write-Host "  scripts\setup.ps1 -Role peer -Self <对方名字> -HubUrl $resolvedUrl -Token $resolvedToken" -ForegroundColor DarkGray
Write-Host ''
