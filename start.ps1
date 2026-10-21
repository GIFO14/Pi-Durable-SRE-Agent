param([switch]$Login)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
$demoNode = $null
foreach ($candidate in $nodeCandidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) {
    $version = & $candidate --version
    $major = ($version -replace '^v', '').Split('.')[0]
    if ([int]$major -ge 24) { $demoNode = $candidate; break }
  }
}
if (!$demoNode) { throw 'Install Node.js 24 or newer, then run this script again.' }
$env:Path = (Split-Path -Parent $demoNode) + ';' + $env:Path
if (!$env:SRE_BASH) {
  $gitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
  if (Test-Path -LiteralPath $gitBash) { $env:SRE_BASH = $gitBash }
}
if ($Login) { & $demoNode scripts/login.ts }
else { & $demoNode --env-file-if-exists=.env src/server.ts }
exit $LASTEXITCODE
