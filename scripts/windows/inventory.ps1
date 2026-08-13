$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()
$package = $null
try { $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Select-Object -First 1 Name,PackageFamilyName,Version,InstallLocation }
catch { $errors.Add("package: $($_.Exception.Message)") }
$startApps = @()
try { $startApps = @(Get-StartApps | Where-Object { $_.AppID -like '*OpenAI.Codex*' -or $_.Name -match 'Codex|ChatGPT' } | ForEach-Object { [ordered]@{ name=$_.Name; appId=$_.AppID } }) }
catch { $errors.Add("start-apps: $($_.Exception.Message)") }
$processes = @()
foreach ($name in @('ChatGPT','Codex')) {
  $matchingProcesses = @()
  try { $matchingProcesses = @(Get-Process -Name $name -ErrorAction Stop) }
  catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenName,*') { continue }
    $errors.Add("processes[$name]: $($_.Exception.Message)")
    continue
  }
  foreach ($process in $matchingProcesses) {
    $path = $null
    try { $path = $process.Path } catch { $errors.Add("process-path: $($_.Exception.Message)") }
    $processes += [ordered]@{ pid=$process.Id; name=$process.ProcessName; path=$path }
  }
}
$commands = @()
foreach ($commandName in @('codex.exe','codex.cmd')) {
  try {
    foreach ($command in @(Get-Command $commandName -All -ErrorAction Stop)) {
      $commands += [ordered]@{ kind=$command.CommandType.ToString(); name=$command.Name; source=$command.Source }
    }
  }
  catch {
    if ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { continue }
    $errors.Add("commands[$commandName]: $($_.Exception.Message)")
  }
}
[ordered]@{
  package = if ($package) { [ordered]@{ name=$package.Name; packageFamilyName=$package.PackageFamilyName; version=$package.Version.ToString(); installLocation=$package.InstallLocation } } else { $null }
  startApps=$startApps; processes=$processes; commands=$commands; errors=@($errors)
} | ConvertTo-Json -Depth 8 -Compress
