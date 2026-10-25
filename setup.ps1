# JobCairn one-click setup for Windows (setup.sh is the macOS one). Safe to re-run: it skips anything already installed.
# Tools come from winget (App Installer, from the Microsoft Store). Windows may ask you to allow an installer: choose Yes.
# Usage, in PowerShell from this folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1            install everything that is missing
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 doctor     check only, change nothing
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
function Say($text) { Write-Host ''; Write-Host "==> $text" }
# Picks up tools installed since this window opened (winget adds them to the saved PATH, not this session's).
function Update-SessionPath {
  $env:Path = (@($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';'
}
function Test-NodeReady {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  node -e "process.exit(+process.versions.node.split('.')[0]>=22?0:1)"
  return ($LASTEXITCODE -eq 0)
}

if ($env:OS -ne 'Windows_NT') { Write-Host 'This setup is for Windows. On a Mac, run ./setup.sh.'; exit 1 }

if (-not (Test-NodeReady)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host 'winget (App Installer from the Microsoft Store) is needed first. Install or update App Installer from the Microsoft Store, then run setup again.'
    exit 1
  }
  Say 'Installing Node.js'
  winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) { Write-Host "Node.js didn't install (winget exit code $LASTEXITCODE). Run setup again, or install Node.js 22 or newer from https://nodejs.org"; exit 1 }
  Update-SessionPath
  if (-not (Test-NodeReady)) { Write-Host 'Node.js is installed, but this window cannot see it yet. Close PowerShell, open it again and run setup again.'; exit 1 }
}

if ($args.Count -gt 0 -and $args[0] -eq 'doctor') {
  $rest = @($args | Select-Object -Skip 1)
  node scripts/setup/run.mjs doctor @rest
  exit $LASTEXITCODE
}

Say 'Installing JobCairn'
npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "Installing JobCairn's own packages didn't work (npm exit code $LASTEXITCODE). Check your internet connection and run setup again."; exit 1 }
Say 'Installing tools (skips anything already there)'
node scripts/setup/run.mjs install @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Say 'All set. Run setup.ps1 doctor any time to check.'
