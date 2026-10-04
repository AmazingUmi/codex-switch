param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('production', 'preview')]
  [string]$Variant
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Installer smoke requires Windows PowerShell 7.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
  throw 'Installer smoke is restricted to a clean GitHub hosted runner; it modifies per-user installer registration.'
}
$repoRoot = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $repoRoot "src-tauri/target/windows/$Variant/x86_64-pc-windows-msvc/release/bundle"
$built = Get-Content (Join-Path $bundle 'WINDOWS_BUILD.json') -Raw | ConvertFrom-Json
$installers = @(Get-ChildItem (Join-Path $bundle 'nsis') -Filter '*.exe')
if ($installers.Count -ne 1) { throw 'Expected one fresh NSIS installer.' }
$testRoot = Join-Path $env:RUNNER_TEMP "Codex Switch 烟雾 $Variant $([guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $testRoot 'install'
# NSIS treats the unquoted tail after /D= as the path, including spaces.
$testHome = Join-Path $testRoot 'home'
New-Item -ItemType Directory -Path $testHome -Force | Out-Null
$dataDir = if ($Variant -eq 'preview') { $testHome } else { Join-Path $testHome '.codex-switch' }
$usageDir = Join-Path $testHome '.codex'
New-Item -ItemType Directory -Path $dataDir, $usageDir -Force | Out-Null
@{ codexUsageSourceDir = $usageDir } | ConvertTo-Json |
  Set-Content (Join-Path $dataDir 'settings.json') -Encoding utf8NoBOM
$app = $null
$savedEnv = @{}
try {
  foreach ($name in @('CODEX_SWITCH_TEST_HOME', 'APPDATA', 'LOCALAPPDATA')) {
    $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $env:CODEX_SWITCH_TEST_HOME = $testHome
  $env:APPDATA = Join-Path $testRoot 'appdata'
  $env:LOCALAPPDATA = Join-Path $testRoot 'localappdata'
  New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA -Force | Out-Null
  $protocol = 'Registry::HKEY_CURRENT_USER\Software\Classes\codexswitch'
  if ($Variant -eq 'preview' -and (Test-Path $protocol)) {
    throw 'Preview smoke requires a clean runner without an existing codexswitch protocol.'
  }
  $installerProcess = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /D=$installDir" -PassThru
  if (-not $installerProcess.WaitForExit(180000)) {
    $installerProcess.Kill($true)
    throw 'Silent NSIS installation timed out.'
  }
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS installer exited $($installerProcess.ExitCode)." }
  $exe = Join-Path $installDir 'codex-switch.exe'
  if (-not (Test-Path $exe)) { throw 'Installed application executable missing.' }
  $builtExe = Join-Path (Split-Path $bundle -Parent) 'codex-switch.exe'
  $installedHash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedHash -ne (Get-FileHash $builtExe -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Installed application does not match the compiled executable.'
  }
  $version = (Get-Item $exe).VersionInfo
  if ($version.ProductName -ne $built.productName -or
      $version.ProductVersion -notmatch "^$([regex]::Escape($built.version))(\.0)?$") {
    throw 'Installed PE product name/version does not match the build identity.'
  }
  if ($Variant -eq 'preview' -and (Test-Path $protocol)) {
    throw 'Preview installer registered the production external URL protocol.'
  }
  $app = Start-Process -FilePath $exe -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $app.Refresh()
    if ($app.HasExited) { throw "Application exited during startup ($($app.ExitCode))." }
    $db = Join-Path $dataDir 'codex-switch.db'
    if ($app.MainWindowHandle -ne 0 -and (Test-Path $db) -and (Get-Item $db).Length -gt 0) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw 'No native window and isolated database observed within 60 seconds.' }
  Start-Sleep -Seconds 5
  $app.Refresh()
  if ($app.HasExited) { throw 'Application exited after startup.' }
  if ($Variant -eq 'preview' -and (Test-Path $protocol)) {
    throw 'Preview launch registered the production external URL protocol.'
  }
  @{
    status = 'passed'
    variant = $Variant
    identifier = $built.identifier
    productName = $version.ProductName
    executableSha256 = $installedHash
    installerSha256 = (Get-FileHash $installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    installedPayloadMatches = $true
    nativeWindowObserved = $true
    isolatedDatabaseObserved = $true
    previewProtocolAbsent = if ($Variant -eq 'preview') { $true } else { $null }
    coverage = 'Silent installer, PE identity, installed payload, native window and isolated database startup only.'
  } | ConvertTo-Json | Set-Content (Join-Path $bundle 'WINDOWS_SMOKE.json') -Encoding utf8NoBOM
} finally {
  if ($app -and -not $app.HasExited) {
    $null = $app.CloseMainWindow()
    if (-not $app.WaitForExit(5000)) { $app.Kill($true); $app.WaitForExit() }
  }
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) {
    # _?= prevents NSIS copying/spawning another uninstaller, so WaitForExit
    # observes the actual cleanup. Its unquoted directory must be the last arg.
    $cleanup = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installDir" -PassThru
    if (-not $cleanup.WaitForExit(30000)) { $cleanup.Kill($true) }
  }
  foreach ($name in $savedEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
  }
  Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
