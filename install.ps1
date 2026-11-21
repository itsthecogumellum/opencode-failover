#Requires -Version 5.1
<#
  opencode-failover installer (Windows)

  Local:   powershell -ExecutionPolicy Bypass -File .\install.ps1
  Remote:  irm https://raw.githubusercontent.com/itsthecogumellum/opencode-failover/main/install.ps1 | iex

  Flags:
    -Port 8787     gateway port
    -Autostart     register a logon scheduled task
    -SkipPath      do not touch the user PATH
#>
param(
  [int]$Port = 8787,
  [switch]$Autostart,
  [switch]$SkipPath
)

$ErrorActionPreference = "Stop"
$RepoZip = "https://github.com/itsthecogumellum/opencode-failover/archive/refs/heads/main.zip"
$dest = Join-Path $HOME ".config\opencode-failover"

Write-Host ""
Write-Host "opencode-failover" -ForegroundColor Cyan
Write-Host "installing to $dest"
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 20+ is required. Install it from https://nodejs.org and run this again."
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) {
  throw "Node.js 20+ is required (found $major)."
}

$local = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "src\cli.mjs"))) {
  $local = $PSScriptRoot
}

if (-not $local) {
  Write-Host "downloading repository..."
  $tmp = Join-Path $env:TEMP ("failover-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Invoke-WebRequest $RepoZip -OutFile (Join-Path $tmp "repo.zip") -UseBasicParsing
  Expand-Archive (Join-Path $tmp "repo.zip") -DestinationPath $tmp
  $local = (Get-ChildItem $tmp -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "src\cli.mjs") } |
    Select-Object -First 1).FullName
  if (-not $local) { throw "could not unpack the repository" }
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($item in @("src", "scripts", "skill", "package.json", "README.md", "LICENSE")) {
  $source = Join-Path $local $item
  if (Test-Path $source) {
    Copy-Item $source $dest -Recurse -Force
  }
}

$configPath = Join-Path $dest "gateway.json"
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $local "gateway.config.example.json") $configPath
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  $config.port = $Port
  $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8
  Write-Host "config created: $configPath"
} else {
  Write-Host "config kept:    $configPath"
}

$binDir = Join-Path $dest "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir "failover.cmd"
@"
@echo off
node "%USERPROFILE%\.config\opencode-failover\src\cli.mjs" %*
"@ | Set-Content $shim -Encoding ascii
Write-Host "command:        $shim"

if (-not $SkipPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($userPath) { $parts = $userPath.Split(";") | Where-Object { $_ } }
  if ($parts -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $binDir) -join ";"), "User")
    Write-Host "PATH:           added $binDir (open a new terminal)"
  } else {
    Write-Host "PATH:           already contains $binDir"
  }
  if (($env:Path -split ";") -notcontains $binDir) {
    $env:Path = "$env:Path;$binDir"
  }
}

$env:FAILOVER_PORT = "$Port"
& node (Join-Path $dest "scripts\register.mjs")
if ($LASTEXITCODE -ne 0) { throw "failed to register the OpenCode provider" }

if ($Autostart) {
  try {
    $action = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$dest\src\cli.mjs`" serve"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "opencode-failover" -Action $action -Trigger $trigger -Force | Out-Null
    Write-Host "autostart:      scheduled task 'opencode-failover' created"
  } catch {
    Write-Warning "could not create the scheduled task: $($_.Exception.Message)"
    Write-Host "run it manually with: failover serve"
  }
}

Write-Host ""
Write-Host "done." -ForegroundColor Green
Write-Host ""
Write-Host "1. edit your keys and models:  $configPath"
Write-Host "2. start the gateway:          failover serve"
Write-Host "3. check the chain:            failover status"
Write-Host "4. pick the model in OpenCode: failover/auto"
Write-Host ""
Write-Host "The gateway only uses providers you already have credentials for."
Write-Host "It fails over. It does not create new quotas or change your IP."
