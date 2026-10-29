$ErrorActionPreference = 'Stop'

$systemRoot = $env:SystemRoot
if ($systemRoot -notmatch '^[A-Za-z]:\\Windows$') {
  throw 'Trusted Windows system root is unavailable.'
}
$powerShell = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskkill = Join-Path $systemRoot 'System32\taskkill.exe'
$node = (Get-Command node -ErrorAction Stop).Source
$actor = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\windows-daemon-peer-actor.mjs'
$runId = $env:GITHUB_RUN_ID
if ($runId -notmatch '^[0-9]{1,20}$' -or -not (Test-Path -LiteralPath $actor)) {
  throw 'Windows baseline actor or run identity is unavailable.'
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Two-user Windows baseline requires the runner administrator for setup.'
}

# Resolve and construct the exact credential type before creating either user.
# This preflight has no account side effect and no real password.
$credentialType = 'System.Management.Automation.PSCredential' -as [type]
if ($null -eq $credentialType -or $credentialType.FullName -ne 'System.Management.Automation.PSCredential') {
  throw 'Windows baseline PSCredential type resolution failed before account creation.'
}
$preflightSecure = ConvertTo-SecureString 'fixture-type-preflight-only' -AsPlainText -Force
$preflightCredential = [System.Management.Automation.PSCredential]::new('fixture-preflight', $preflightSecure)
if ($preflightCredential.GetType() -ne $credentialType) {
  throw 'Windows baseline PSCredential construction failed before account creation.'
}

function New-TestCredential($name) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $password = [Convert]::ToBase64String($bytes) + 'aA1!'
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  $user = New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires
  $identity = @{ User = $user; Credential = $null; Sid = $user.SID.Value }
  # Record ownership before the remaining setup can throw, so final cleanup
  # also removes an account whose credential construction failed.
  $script:users += $identity
  $identity.Credential = [System.Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
  return $identity
}

function Get-ProfilePath($sid) {
  $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
  if ($null -eq $profile -or [string]::IsNullOrWhiteSpace($profile.LocalPath)) {
    throw 'Standard-user profile did not load.'
  }
  return $profile.LocalPath
}

function Read-ActorDiagnostic($path) {
  $result = @{ status = 'unavailable'; stage = 'unavailable'; errorClass = 'unavailable';
    errorCode = 'unavailable'; homeProfileMismatch = $null }
  $stream = $null
  try {
    if (-not (Test-Path -LiteralPath $path)) { $result.status = 'missing'; return $result }
    $stream = [IO.File]::OpenRead($path)
    $bytes = New-Object byte[] 1025
    $count = $stream.Read($bytes, 0, $bytes.Length)
    if ($count -gt 1024) { $result.status = 'oversized'; return $result }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, 0, $count)
    if (-not $text.TrimStart().StartsWith('{')) { $result.status = 'invalid'; return $result }
    $parsed = $text | ConvertFrom-Json -ErrorAction Stop
    $fields = @('version', 'stage', 'errorClass', 'errorCode', 'homeProfileMismatch')
    if (@($parsed.PSObject.Properties).Count -ne $fields.Count -or
        @($parsed.PSObject.Properties.Name | Where-Object { $fields -cnotcontains $_ }).Count -ne 0 -or
        ($parsed.version -isnot [int] -and $parsed.version -isnot [long]) -or $parsed.version -ne 1 -or
        $parsed.stage -isnot [string] -or $parsed.errorClass -isnot [string] -or $parsed.errorCode -isnot [string] -or
        ($null -ne $parsed.homeProfileMismatch -and $parsed.homeProfileMismatch -isnot [bool])) {
      $result.status = 'invalid'; return $result
    }
    $result.status = 'valid'
    $result.stage = if ($parsed.stage -cin @('arguments', 'paths', 'profile', 'tools', 'identity',
        'commands', 'state', 'cleanup', 'result', 'complete')) { $parsed.stage } else { 'unavailable' }
    $result.errorClass = if ($parsed.errorClass -cin @('none', 'Error', 'TypeError', 'RangeError',
        'SyntaxError', 'other')) { $parsed.errorClass } else { 'other' }
    $result.errorCode = if ($parsed.errorCode -cin @('none', 'EACCES', 'EPERM', 'EINVAL', 'ENOENT',
        'ENOTSUP', 'ETIMEDOUT', 'ENOBUFS', 'other')) { $parsed.errorCode } else { 'other' }
    $result.homeProfileMismatch = $parsed.homeProfileMismatch
  } catch { $result.status = 'invalid' }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
  return $result
}

function Invoke-Actor($identity, $role) {
  $nonce = [Guid]::NewGuid().ToString('N')
  # Only the already-verified administrator-private root receives raw capture.
  $stdout = Join-Path $env:LCM_WINDOWS_BOOTSTRAP_ROOT "$nonce.stdout"
  $stderr = Join-Path $env:LCM_WINDOWS_BOOTSTRAP_ROOT "$nonce.stderr"
  $observation = @{ role = $role; stage = 'launch'; exitCode = $null; resultPresent = $null;
    stderrPresent = $null; captureCleanupVerified = $true; actor = $null }
  try {
    $arguments = '"' + $actor + '" ' + $role + ' ' + $runId
    $process = Start-Process -FilePath $node -ArgumentList $arguments -Credential $identity.Credential `
      -LoadUserProfile -UseNewEnvironment -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $observation.stage = 'wait'
    if (-not $process.WaitForExit(120000)) {
      & $taskkill /PID $process.Id /T /F | Out-Null
      throw 'Standard-user actor exceeded its 120-second process deadline.'
    }
    $process.Refresh()
    if ($process.ExitCode -is [int]) { $observation.exitCode = $process.ExitCode }
    $observation.stage = 'profile-result'
    $profilePath = Get-ProfilePath $identity.Sid
    $resultPath = Join-Path $profilePath "lcm-peer-baseline-$runId.json"
    $observation.resultPresent = [bool](Test-Path -LiteralPath $resultPath)
    if ($observation.exitCode -ne 0 -or -not $observation.resultPresent) {
      throw 'Standard-user actor failed before returning a baseline result.'
    }
    $observation.stage = 'result-validation'
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.role -ne $role -or $result.tokenUserSid -ne $identity.Sid) {
      throw 'Standard-user actor token SID did not match its account.'
    }
    $reportedProfile = [IO.Path]::GetFullPath([string]$result.profile).TrimEnd('\')
    $actualProfile = [IO.Path]::GetFullPath($profilePath).TrimEnd('\')
    if (-not [string]::Equals($reportedProfile, $actualProfile,
        [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Standard-user actor did not use its own profile.'
    }
    $observation.stage = 'complete'
    return @{ Profile = $profilePath; Result = $result }
  } catch { throw 'Standard-user actor failed baseline observation or validation.' }
  finally {
    $observation.actor = Read-ActorDiagnostic $stdout
    try {
      if (Test-Path -LiteralPath $stderr) {
        $observation.stderrPresent = (Get-Item -LiteralPath $stderr -ErrorAction Stop).Length -gt 0
      }
    } catch { }
    foreach ($path in @($stdout, $stderr)) {
      try {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -ErrorAction Stop }
      } catch { $observation.captureCleanupVerified = $false }
    }
    Write-Host ('WINDOWS_ACTOR_DIAGNOSTIC_JSON=' + ($observation | ConvertTo-Json -Depth 4 -Compress))
    if (-not $observation.captureCleanupVerified) { throw 'Actor diagnostic capture cleanup failed.' }
  }
}

function Get-AclWitness($path) {
  if (-not (Test-Path -LiteralPath $path)) { return @{ present = $false } }
  $item = Get-Item -LiteralPath $path -Force
  $acl = Get-Acl -LiteralPath $path
  $ownerSid = 'unavailable'
  try {
    $ownerSid = if ($acl.Owner -match '^S-1-') { $acl.Owner } else {
      ([Security.Principal.NTAccount]$acl.Owner).Translate(
        [Security.Principal.SecurityIdentifier]).Value
    }
  } catch { }
  $fileIdText = & (Join-Path $systemRoot 'System32\fsutil.exe') file queryfileid $path 2>$null
  $fileId = [regex]::Match(($fileIdText -join ' '), '(?i)0x[0-9a-f]+').Value
  return @{
    present = $true
    ownerSid = $ownerSid
    sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    fileId = if ($fileId) { $fileId } else { 'unavailable' }
  }
}

function Get-AncestryWitnesses($profilePath) {
  $paths = New-Object System.Collections.Generic.List[string]
  $current = $profilePath
  while ($true) {
    $paths.Add($current)
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
    $current = $parent
  }
  $result = @{}
  foreach ($path in $paths) { $result[$path] = Get-AclWitness $path }
  foreach ($name in @('.lcm', '.lcm\daemon.pid', '.lcm\daemon.token')) {
    $path = Join-Path $profilePath $name
    $result[$path] = Get-AclWitness $path
  }
  return $result
}

function Assert-PrivateBootstrapAcl($path, $role, $adminSid, $actorSids) {
  try { $witness = Get-AclWitness $path }
  catch { throw "Verified pnpm ACL query failed for $role ($($_.Exception.GetType().Name))." }
  if (-not $witness.present -or $witness.ownerSid -notin @($adminSid, 'S-1-5-18', 'S-1-5-32-544')) {
    throw "Verified pnpm $role owner is not trusted ($($witness.ownerSid))."
  }
  $acl = Get-Acl -LiteralPath $path
  $sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  if ($sddl -notmatch 'D:' -or $sddl -match 'NO_ACCESS_CONTROL') {
    throw "Verified pnpm $role has an unknown or null DACL."
  }
  $trusted = @($adminSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    $trustee = $rule.IdentityReference.Value
    $rights = [int64]$rule.FileSystemRights
    # Admin-profile traversal does not grant access to the private package.
    $traverseOnly = $role -ceq 'admin-profile' -and
      ($rights -band (-bnot [int64]0x00100020)) -eq 0
    if ($actorSids -contains $trustee -or ($trusted -notcontains $trustee -and -not $traverseOnly)) {
      throw "Verified pnpm $role DACL grants untrusted SID $trustee rights $rights."
    }
  }
  return $witness
}

function Assert-BootstrapContainment($adminProfile, $adminSid, $actorSids) {
  $bootstrapRoot = $env:LCM_WINDOWS_BOOTSTRAP_ROOT
  $pnpmLink = $env:LCM_WINDOWS_PNPM_SCRIPT
  if ([string]::IsNullOrWhiteSpace($bootstrapRoot) -or [string]::IsNullOrWhiteSpace($pnpmLink)) {
    throw 'Verified pnpm bootstrap locations are unavailable.'
  }
  $root = [IO.Path]::GetFullPath($bootstrapRoot).TrimEnd('\')
  $profile = [IO.Path]::GetFullPath($adminProfile).TrimEnd('\')
  if (-not $root.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Verified pnpm bootstrap is outside the private runner administrator profile.'
  }
  $launcher = Join-Path $root 'verified\package\bin\pnpm.cjs'
  $expectedLink = Join-Path $root 'verified\bin\pnpm'
  if (-not [string]::Equals([IO.Path]::GetFullPath($pnpmLink),
      [IO.Path]::GetFullPath($expectedLink), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Verified pnpm launcher path differs from the bootstrap result.'
  }
  $script = 'const fs=require("node:fs"); const a=process.argv[1], b=process.argv[2]; console.log(JSON.stringify({link:fs.lstatSync(a).isSymbolicLink(), regular:fs.lstatSync(b).isFile(), target:fs.realpathSync(a).toLowerCase()===fs.realpathSync(b).toLowerCase()}));'
  $linkProof = @(& $node -e $script $pnpmLink $launcher)
  if ($LASTEXITCODE -ne 0 -or $linkProof.Count -ne 1) {
    throw 'Verified pnpm symlink traversal could not be observed.'
  }
  $linkState = $linkProof[0] | ConvertFrom-Json
  if (-not $linkState.link -or -not $linkState.regular -or -not $linkState.target) {
    throw 'Verified pnpm symlink does not resolve to the checked launcher.'
  }
  $witnesses = @{}
  $current = $root
  while ($true) {
    $role = if ([string]::Equals($current, $root, [StringComparison]::OrdinalIgnoreCase)) {
      'bootstrap-root'
    } elseif ([string]::Equals($current, $profile, [StringComparison]::OrdinalIgnoreCase)) {
      'admin-profile'
    } else { 'bootstrap-ancestor' }
    $witnesses[$current] = Assert-PrivateBootstrapAcl $current $role $adminSid $actorSids
    if ([string]::Equals($current, $profile, [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) {
      throw 'Verified pnpm bootstrap ancestry is incomplete.'
    }
    $current = $parent
  }
  foreach ($entry in @(
      @{ path = $launcher; role = 'package-launcher' },
      @{ path = (Split-Path -Parent $launcher); role = 'package-bin' },
      @{ path = $pnpmLink; role = 'verified-link' },
      @{ path = (Split-Path -Parent $pnpmLink); role = 'verified-bin' }
    )) {
    $witnesses[$entry.path] = Assert-PrivateBootstrapAcl $entry.path $entry.role $adminSid $actorSids
  }
  return @{ symlinkBound = $true; acl = $witnesses }
}

function Stop-RemainingFixtureProcesses($sids) {
  $matches = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.CommandLine -match 'windows-daemon-peer-actor|dist[\\/]lcm\.mjs'
  })
  if ($matches.Count -gt 32) { throw 'Fixture process census exceeded its bound.' }
  foreach ($candidate in $matches) {
    $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) {
      throw 'Fixture process ownership could not be verified.'
    }
    if ($sids -notcontains $owner.Sid) { continue }
    & $taskkill /PID $candidate.ProcessId /T /F | Out-Null
  }
  $matches = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.CommandLine -match 'windows-daemon-peer-actor|dist[\\/]lcm\.mjs'
  })
  if ($matches.Count -gt 32) { throw 'Fixture process census exceeded its bound.' }
  $remaining = @($matches | Where-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.Sid)) {
      throw 'Fixture process ownership could not be verified.'
    }
    $sids -contains $owner.Sid
  })
  if ($remaining.Count -gt 0) { throw 'Fixture-owned processes remain after cleanup.' }
}

$users = @()
$summary = $null
$primaryError = $null
try {
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $victim = New-TestCredential "lcmv$suffix"
  $squatter = New-TestCredential "lcms$suffix"
  $adminSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $adminProfile = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\')
  $bootstrap = Assert-BootstrapContainment $adminProfile $adminSid @($victim.Sid, $squatter.Sid)
  $victimRun = Invoke-Actor $victim 'victim'
  $squatterRun = Invoke-Actor $squatter 'squatter'
  if ($victim.Sid -eq $squatter.Sid) { throw 'Victim and squatter SIDs are not distinct.' }
  foreach ($path in @($victimRun.Profile, $squatterRun.Profile)) {
    if ([string]::Equals([IO.Path]::GetFullPath($path).TrimEnd('\'), $adminProfile,
        [StringComparison]::OrdinalIgnoreCase)) {
      throw 'A standard-user actor used the runner administrator profile.'
    }
  }
  if ([string]::Equals($victimRun.Profile, $squatterRun.Profile,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Victim and squatter profiles are not distinct.'
  }
  $summary = @{
    pushedSha = $env:GITHUB_SHA
    victimSid = $victim.Sid
    squatterSid = $squatter.Sid
    victim = $victimRun.Result
    squatter = $squatterRun.Result
    bootstrap = $bootstrap
    acl = Get-AncestryWitnesses $victimRun.Profile
  }
  Write-Host ('WINDOWS_BASELINE_JSON=' + ($summary | ConvertTo-Json -Depth 12 -Compress))
  if ($victimRun.Result.commands.freshInstall.exitCode -ne 0 -or
      $victimRun.Result.commands.existingInstall.exitCode -ne 0 -or
      $victimRun.Result.commands.daemonStart.exitCode -ne 0) {
    throw 'Normal standard-user install or detached start did not pass the baseline.'
  }
} catch {
  $primaryError = $_
}

$cleanupErrors = New-Object System.Collections.Generic.List[string]
$cleanupReadback = @()
$sids = @($users | ForEach-Object { $_.Sid })
try { Stop-RemainingFixtureProcesses $sids }
catch { $cleanupErrors.Add('fixture-process-cleanup') }
foreach ($identity in $users) {
  try { Remove-LocalUser -Name $identity.User.Name -ErrorAction Stop }
  catch { $cleanupErrors.Add('local-user-removal') }
  try {
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($identity.Sid)'" -ErrorAction Stop
    if ($null -ne $profile) {
      if ($profile.Loaded) {
        $cleanupErrors.Add('user-profile-loaded')
      } else {
        Remove-CimInstance -InputObject $profile -ErrorAction Stop
      }
    }
  } catch { $cleanupErrors.Add('user-profile-removal') }
  $profileRemains = $null
  try {
    $profileRemains = $null -ne (Get-CimInstance Win32_UserProfile -Filter "SID='$($identity.Sid)'" -ErrorAction Stop)
  } catch { $cleanupErrors.Add('user-profile-readback') }
  if ($profileRemains) {
    $cleanupErrors.Add('user-profile-remains')
  }
  $accountRemains = $null
  try {
    $accountRemains = $null -ne (Get-LocalUser -ErrorAction Stop | Where-Object {
      $_.SID.Value -eq $identity.Sid
    })
  } catch { $cleanupErrors.Add('local-user-readback') }
  if ($accountRemains) {
    $cleanupErrors.Add('local-user-remains')
  }
  $cleanupReadback += @{
    sid = $identity.Sid
    accountRemains = $accountRemains
    profileRemains = $profileRemains
  }
}
try { Stop-RemainingFixtureProcesses $sids }
catch { $cleanupErrors.Add('fixture-process-remains') }

Write-Host ('WINDOWS_BASELINE_CLEANUP_JSON=' + (@{
  createdAccountCount = $users.Count
  accounts = $cleanupReadback
  processCleanupVerified = -not $cleanupErrors.Contains('fixture-process-cleanup') -and
    -not $cleanupErrors.Contains('fixture-process-remains')
  errors = @($cleanupErrors.ToArray())
} | ConvertTo-Json -Depth 6 -Compress))

if ($primaryError) {
  if ($cleanupErrors.Count -gt 0) {
    Write-Host ('WINDOWS_BASELINE_CLEANUP_FAILURE=' + ($cleanupErrors -join ','))
  }
  throw $primaryError
}
if ($cleanupErrors.Count -gt 0) {
  throw ('Windows baseline cleanup failed: ' + ($cleanupErrors -join ','))
}
