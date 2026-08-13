[CmdletBinding()]
param(
  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$Phase0Report,

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$LogPath,

  [Parameter()]
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -CommandType Application -All -ErrorAction Stop |
  Select-Object -First 1
$nodeExecutable = $nodeCommand.Source
if ([string]::IsNullOrWhiteSpace($nodeExecutable)) {
  throw 'The selected Node command has no executable path.'
}
$nodeExecutable = [IO.Path]::GetFullPath($nodeExecutable)
if ($Check) {
  [Console]::Out.WriteLine($nodeExecutable)
  exit 0
}

$arguments = @('src/phase-1/sidebar-cli.js')
if ($PSBoundParameters.ContainsKey('Phase0Report')) {
  $arguments += @('--phase0-report', $Phase0Report)
}

Set-Location -LiteralPath $repositoryRoot
if (-not $PSBoundParameters.ContainsKey('LogPath')) {
  $LogPath = Join-Path $repositoryRoot 'artifacts\phase-1\sidebar-startup-latest.log'
} elseif (-not [IO.Path]::IsPathRooted($LogPath)) {
  $LogPath = Join-Path $repositoryRoot $LogPath
}
$LogPath = [IO.Path]::GetFullPath($LogPath)
$logDirectory = Split-Path -Parent $LogPath
[void](New-Item -ItemType Directory -Path $logDirectory -Force)
$newline = [Environment]::NewLine
[IO.File]::WriteAllText(
  $LogPath,
  "Projectboard sidebar startup diagnostic$newline" +
    "Started: $([DateTimeOffset]::Now.ToString('o'))$newline" +
    "Repository: $repositoryRoot$newline" +
    "Node: $nodeExecutable$newline$newline",
  $utf8
)

$exitCode = 1
try {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 wraps native stderr as non-terminating ErrorRecord
    # objects. Keep them in the log stream without treating them as a launcher
    # exception or replacing the controller's real exit code.
    $ErrorActionPreference = 'Continue'
    & $nodeExecutable @arguments 2>&1 | ForEach-Object {
      $line = $_.ToString()
      [Console]::Out.WriteLine($line)
      [IO.File]::AppendAllText($LogPath, "$line$newline", $utf8)
    }
    $controllerExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $controllerExitCode) {
    $exitCode = 0
  } else {
    $exitCode = [int]$controllerExitCode
  }
} catch {
  $line = $_.Exception.Message
  [Console]::Error.WriteLine($line)
  [IO.File]::AppendAllText($LogPath, "$line$newline", $utf8)
}

$finished = "Finished: $([DateTimeOffset]::Now.ToString('o')); exit code: $exitCode"
[IO.File]::AppendAllText($LogPath, "$newline$finished$newline", $utf8)
[Console]::Out.WriteLine("Diagnostic log: $LogPath")
exit $exitCode
