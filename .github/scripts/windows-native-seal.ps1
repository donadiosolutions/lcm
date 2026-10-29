# PRIVATE FUTURE READ-ONLY SOURCE. Not composed into the first carrier.
# No actor setup, ACL mutation, privilege enablement, deletion or payload load.
function Invoke-SecFutureSeal {
    throw 'future-seal-needs-root-reviewed-launcher-actual-tokens-and-manifest'
}
function Assert-SecSealBudget {
    param($Lease,[int]$Calls=1)
    $Lease.NativeCalls+=$Calls
    if($Lease.NativeCalls -gt 8192 -or $Lease.Clock.ElapsedMilliseconds -ge 20000) { throw 'seal-budget' }
}
function New-SecSealScope {
    param($Lease)
    if($Lease.CleanupBlocked -or $Lease.TempScopes.Count -ge 32) { throw 'seal-scope-admission' }
    # Scalar wrapper, never return a bare empty List through the PS pipeline.
    # Registry capacity/record/insertion all precede this scope's acquisitions.
    $scope=[pscustomobject]@{
        Buffers=[Collections.Generic.List[object]]::new()
        DescriptorOutputCell=[IntPtr]::Zero;Descriptor=[IntPtr]::Zero
        DescriptorCaptureKnown=$true;CaptureRecoveryAttempted=$false
        Hash=$null;CleanupStarted=$false;CleanupUnknown=$false
    }
    $Lease.TempScopes.Add($scope)
    return $scope
}
function New-SecSealBuffer {
    param($Lease,$Scope,[int]$Bytes)
    if($Lease.CleanupBlocked -or $Scope.CleanupStarted -or -not $Lease.TempScopes.Contains($Scope)) { throw 'seal-buffer-owner' }
    # Apply existing32/<1MiB HGlobal caps across ALL registered collections.
    # Zero-pointer reservations remain charged until their record is removed.
    $count=0;$total=[Int64]$Bytes
    foreach($owner in $Lease.TempScopes) {
        $count+=$owner.Buffers.Count
        foreach($record in $owner.Buffers) { $total+=$record.Bytes }
    }
    if($count -ge 32 -or $Bytes -lt 1 -or $total -ge 1048576) { throw 'seal-global-buffer-cap' }
    return (New-SecNativeBuffer $Scope.Buffers $Bytes)
}
function Test-SecSealScopeEmpty {
    param($Scope)
    return (-not $Scope.CleanupUnknown -and $Scope.DescriptorCaptureKnown -and
        $Scope.Descriptor -eq [IntPtr]::Zero -and $Scope.DescriptorOutputCell -eq [IntPtr]::Zero -and
        $Scope.Buffers.Count -eq 0 -and $null -eq $Scope.Hash)
}
function Close-SecSealScope {
    param($Lease,$Scope)
    # One state-preserving cleanup pass. A later lease close never retries this
    # scope's failed/canceled release attempts or silently renews a call budget.
    if($Scope.CleanupStarted) { return (Test-SecSealScopeEmpty $Scope) }
    $Scope.CleanupStarted=$true
    $n=$Lease.Native
    # The registered output buffer is authoritative if immediate capture failed.
    # Never free its only pointer source while capture remains unknown.
    if(-not $Scope.DescriptorCaptureKnown -and -not $Scope.CaptureRecoveryAttempted) {
        $Scope.CaptureRecoveryAttempted=$true
        try {
            $Scope.Descriptor=[Runtime.InteropServices.Marshal]::ReadIntPtr($Scope.DescriptorOutputCell)
            $Scope.DescriptorCaptureKnown=$true
        } catch { $Scope.CleanupUnknown=$true }
    }
    # Descriptor, hash and buffer cleanup have separate guarded attempts. One
    # failed Clear/Dispose/LocalFree cannot skip the other independent owners.
    try {
        if($Scope.DescriptorCaptureKnown -and $Scope.Descriptor -ne [IntPtr]::Zero) {
            if($Lease.NativeCalls -ge 8192) { $Scope.CleanupUnknown=$true }
            else {
                $Lease.NativeCalls++
                if($n::LocalFree($Scope.Descriptor) -eq [IntPtr]::Zero) { $Scope.Descriptor=[IntPtr]::Zero }
                else { $Scope.CleanupUnknown=$true }
            }
        }
    } catch { $Scope.CleanupUnknown=$true }
    try {
        if($null -ne $Scope.Hash) { $Scope.Hash.Dispose();$Scope.Hash=$null }
    } catch { $Scope.CleanupUnknown=$true }
    try {
        if($Scope.DescriptorCaptureKnown) {
            Clear-SecNativeBuffers $Scope.Buffers
            if($Scope.Buffers.Count -eq 0) { $Scope.DescriptorOutputCell=[IntPtr]::Zero }
        }
    } catch { $Scope.CleanupUnknown=$true }
    $empty=Test-SecSealScopeEmpty $Scope
    if($empty) {
        try {
            if(-not $Lease.TempScopes.Remove($Scope)) { $Scope.CleanupUnknown=$true;$empty=$false }
        } catch { $Scope.CleanupUnknown=$true;$empty=$false }
    }
    if(-not $empty) { $Lease.CleanupBlocked=$true;$Lease.CleanupOwned=$true }
    return $empty
}
function Get-SecTokenBytes {
    param($Lease,[IntPtr]$Token,[int]$Class)
    # Fixed classes chosen only by Assert-SecActorToken, not external JSON.
    $n=$Lease.Native;$scope=New-SecSealScope $Lease
    try {
        $b=New-SecSealBuffer $Lease $scope 65536;$len=New-SecSealBuffer $Lease $scope 4
        Assert-SecSealBudget $Lease
        if($n::GetTokenInformation($Token,$Class,$b,65536,$len) -eq 0) { throw 'token-query-failed' }
        $size=[Runtime.InteropServices.Marshal]::ReadInt32($len)
        if($size -lt 4 -or $size -gt 65536) { throw 'token-size' }
        # Keep native memory until embedded SID pointers have been normalized.
        return [pscustomobject]@{Buffer=$b;Length=$size;Owner=$scope}
    } catch { $null=Close-SecSealScope $Lease $scope;throw }
}
function Get-SecSidInTokenBuffer {
    param($TokenBuffer,[IntPtr]$Sid)
    # SID header8 plus <=15 subauthorities; embedded pointer must stay in buffer.
    $start=$TokenBuffer.Buffer.ToInt64();$at=$Sid.ToInt64()
    if($at -lt $start -or $at+8 -gt $start+$TokenBuffer.Length) { throw 'token-sid-range' }
    $count=[Runtime.InteropServices.Marshal]::ReadByte($Sid,1)
    $size=8+4*$count
    if($count -gt 15 -or $at+$size -gt $start+$TokenBuffer.Length -or
        [Runtime.InteropServices.Marshal]::ReadByte($Sid,0) -ne 1) { throw 'token-sid-shape' }
    $bytes=[byte[]]::new($size);[Runtime.InteropServices.Marshal]::Copy($Sid,$bytes,0,$size)
    return [Security.Principal.SecurityIdentifier]::new($bytes,0).Value
}
function Assert-SecActorToken {
    param($Lease,$Actor)
    # Actor is a trusted in-memory launcher role with borrowed actual token;
    # no string/JSON-to-native-handle conversion is offered anywhere.
    if($Actor.Role -cnotin @('victim','foreign') -or $Actor.Token -isnot [IntPtr] -or
        $Actor.Token -eq [IntPtr]::Zero -or $Actor.Token -eq [IntPtr]::new(-1) -or
        $null -eq $Actor.ExpectedPolicy) { throw 'actual-actor-token-required' }
    $policy=$Actor.ExpectedPolicy
    if($policy.Profile -cne 'SeChangeNotify-only-v1') { throw 'unsupported-limited-token-policy' }
    # Compatibility with ordinary standard tokens is UNKNOWN; other present
    # privileges conservatively refuse. No stripping/enabling/automatic widening.
    foreach($c in @(8,9,20)) {
        $b=Get-SecTokenBytes $Lease $Actor.Token $c
        try {
            $value=[Runtime.InteropServices.Marshal]::ReadInt32($b.Buffer)
            if(($c -eq 8 -and $value -ne 2) -or ($c -eq 9 -and $value -ne 2) -or
                ($c -eq 20 -and $value -ne 0)) { throw 'actor-type-level-or-elevation' }
        } finally { if(-not (Close-SecSealScope $Lease $b.Owner)) { throw 'seal-scope-cleanup-pending' } }
    }
    $b=Get-SecTokenBytes $Lease $Actor.Token 1
    try {
        $sid=Get-SecSidInTokenBuffer $b ([Runtime.InteropServices.Marshal]::ReadIntPtr($b.Buffer))
        if($sid -cne $policy.UserSid) { throw 'actor-user-binding' }
    } finally { if(-not (Close-SecSealScope $Lease $b.Owner)) { throw 'seal-scope-cleanup-pending' } }
    foreach($c in @(2,11)) {
        $b=Get-SecTokenBytes $Lease $Actor.Token $c
        try {
            $count=[Runtime.InteropServices.Marshal]::ReadInt32($b.Buffer)
            if($count -lt 0 -or $count -gt 4096 -or ($count -gt 0 -and 8+16*$count -gt $b.Length)) { throw 'token-groups-size' }
            $expected=if($c -eq 2){$policy.Groups}else{$policy.RestrictedSids}
            if($null -eq $expected -or $expected.Count -ne $count) { throw 'actor-groups-binding' }
            for($i=0;$i -lt $count;$i++) {
                $base=[IntPtr]::Add($b.Buffer,8+16*$i)
                $groupSid=Get-SecSidInTokenBuffer $b ([Runtime.InteropServices.Marshal]::ReadIntPtr($base))
                $attrs=[BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($base,8)),0)
                if($groupSid -cne $expected[$i].Sid -or $attrs -ne $expected[$i].Attributes) { throw 'actor-group-policy' }
            }
        } finally { if(-not (Close-SecSealScope $Lease $b.Owner)) { throw 'seal-scope-cleanup-pending' } }
    }
    $lookupScope=New-SecSealScope $Lease
    try {
        $lookup=New-SecSealBuffer $Lease $lookupScope 8;$n=$Lease.Native
        Assert-SecSealBudget $Lease
        if($n::LookupPrivilegeValueW($null,'SeChangeNotifyPrivilege',$lookup) -eq 0) { throw 'privilege-name-binding-failed' }
        $changeNotify=[Runtime.InteropServices.Marshal]::ReadInt64($lookup)
    } finally { if(-not (Close-SecSealScope $Lease $lookupScope)) { throw 'seal-scope-cleanup-pending' } }
    $b=Get-SecTokenBytes $Lease $Actor.Token 3
    try {
        $count=[Runtime.InteropServices.Marshal]::ReadInt32($b.Buffer)
        if($count -lt 0 -or $count -gt 256 -or 4+12*$count -gt $b.Length -or
            $policy.Privileges.Count -ne $count) { throw 'actor-privilege-size' }
        for($i=0;$i -lt $count;$i++) {
            $at=4+12*$i;$luid=[Runtime.InteropServices.Marshal]::ReadInt64($b.Buffer,$at)
            $attrs=[BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($b.Buffer,$at+8)),0)
            if($luid -ne $policy.Privileges[$i].Luid -or $attrs -ne $policy.Privileges[$i].Attributes -or
                ($luid -ne $changeNotify)) { throw 'actor-privilege-policy' }
        }
        # Only name-bound SeChangeNotifyPrivilege may be PRESENT. This limited
        # profile rejects all other present privileges, including backup/restore/
        # take-ownership/debug/security privilege bypass accepted or enabled.
        # Supported-profile eligibility remains unproved without actual actors.
    } finally { if(-not (Close-SecSealScope $Lease $b.Owner)) { throw 'seal-scope-cleanup-pending' } }
    $b=Get-SecTokenBytes $Lease $Actor.Token 10
    try {
        if($b.Length -lt 56 -or [Runtime.InteropServices.Marshal]::ReadInt64($b.Buffer,8) -ne $policy.AuthenticationId -or
            [Runtime.InteropServices.Marshal]::ReadInt64($b.Buffer,0) -ne $policy.TokenId -or
            [Runtime.InteropServices.Marshal]::ReadInt64($b.Buffer,48) -ne $policy.ModifiedId) { throw 'actor-token-statistics' }
    } finally { if(-not (Close-SecSealScope $Lease $b.Owner)) { throw 'seal-scope-cleanup-pending' } }
    return $sid
}
function Get-SecFileWitness {
    param($Lease,[IntPtr]$Handle)
    $n=$Lease.Native;$scope=New-SecSealScope $Lease
    try {
        $id=New-SecSealBuffer $Lease $scope 24;$standard=New-SecSealBuffer $Lease $scope 24
        $basic=New-SecSealBuffer $Lease $scope 40;$tag=New-SecSealBuffer $Lease $scope 8
        foreach($q in @(@(18,$id,24),@(1,$standard,24),@(0,$basic,40),@(9,$tag,8))) {
            Assert-SecSealBudget $Lease
            if($n::GetFileInformationByHandleEx($Handle,$q[0],$q[1],$q[2]) -eq 0) { throw 'file-info-failed' }
        }
        Assert-SecSealBudget $Lease
        if($n::GetFileType($Handle) -ne 1) { throw 'file-not-disk' }
        $bytes=[byte[]]::new(24);[Runtime.InteropServices.Marshal]::Copy($id,$bytes,0,24)
        $attrs=[BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($basic,32)),0)
        if(($attrs -band 0x400) -ne 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($tag,4) -ne 0 -or
            [Runtime.InteropServices.Marshal]::ReadByte($standard,20) -ne 0) { throw 'reparse-or-delete-pending' }
        return [pscustomobject]@{
            Identity=[Convert]::ToHexString($bytes).ToLowerInvariant()
            Size=[Runtime.InteropServices.Marshal]::ReadInt64($standard,8)
            Links=[Runtime.InteropServices.Marshal]::ReadInt32($standard,16)
            Directory=([Runtime.InteropServices.Marshal]::ReadByte($standard,21) -ne 0)
            Attributes=$attrs
        }
    } finally { if(-not (Close-SecSealScope $Lease $scope)) { throw 'seal-scope-cleanup-pending' } }
}
function Assert-SecIndividualAccess {
    param($Lease,[IntPtr]$Descriptor,$Actor,[UInt32]$Right,[bool]$ShouldGrant)
    $n=$Lease.Native;$scope=New-SecSealScope $Lease
    try {
        $mapping=New-SecSealBuffer $Lease $scope 16
        foreach($x in @(@(0,0x120089),@(4,0x120116),@(8,0x1200A0),@(12,0x1F01FF))) {
            [Runtime.InteropServices.Marshal]::WriteInt32($mapping,$x[0],$x[1])
        }
        $priv=New-SecSealBuffer $Lease $scope 65536;$len=New-SecSealBuffer $Lease $scope 4
        $granted=New-SecSealBuffer $Lease $scope 4;$status=New-SecSealBuffer $Lease $scope 4
        [Runtime.InteropServices.Marshal]::WriteInt32($len,65536)
        Assert-SecSealBudget $Lease
        if($n::AccessCheck($Descriptor,$Actor.Token,$Right,$mapping,$priv,$len,$granted,$status) -eq 0) { throw 'access-check-api-failed' }
        if([Runtime.InteropServices.Marshal]::ReadInt32($len) -gt 65536 -or
            [Runtime.InteropServices.Marshal]::ReadInt32($priv) -ne 0) { throw 'access-check-privileges-used' }
        $ok=([Runtime.InteropServices.Marshal]::ReadInt32($status) -ne 0)
        $mask=[UInt32][Runtime.InteropServices.Marshal]::ReadInt32($granted)
        if($ok -ne $ShouldGrant -or ($ShouldGrant -and ($mask -band $Right) -ne $Right) -or
            (-not $ShouldGrant -and $mask -ne 0)) { throw 'effective-individual-right-policy' }
    } finally { if(-not (Close-SecSealScope $Lease $scope)) { throw 'seal-scope-cleanup-pending' } }
}
function Get-SecSecurityWitness {
    param($Lease,[IntPtr]$Handle,$Entry,$Actors)
    $n=$Lease.Native;$scope=New-SecSealScope $Lease;$sd=[IntPtr]::Zero
    try {
        $out=New-SecSealBuffer $Lease $scope 40
        # The SD obligation/output cell is already rooted before this native call.
        $scope.DescriptorOutputCell=[IntPtr]::Add($out,32)
        $scope.DescriptorCaptureKnown=$false
        Assert-SecSealBudget $Lease
        $err=$n::GetSecurityInfo($Handle,1,7,$out,[IntPtr]::Add($out,8),[IntPtr]::Add($out,16),[IntPtr]::Add($out,24),$scope.DescriptorOutputCell)
        $scope.Descriptor=[Runtime.InteropServices.Marshal]::ReadIntPtr($scope.DescriptorOutputCell)
        $scope.DescriptorCaptureKnown=$true # Adopt BEFORE result/inspection/cleanup.
        $sd=$scope.Descriptor
        if($err -ne 0 -or $sd -eq [IntPtr]::Zero) { throw 'security-info-failed' }
        Assert-SecSealBudget $Lease
        if($n::IsValidSecurityDescriptor($sd) -eq 0) { throw 'invalid-security-descriptor' }
        Assert-SecSealBudget $Lease
        $length=$n::GetSecurityDescriptorLength($sd)
        if($length -lt 20 -or $length -gt 1048576) { throw 'security-descriptor-size' }
        $bytes=[byte[]]::new($length);[Runtime.InteropServices.Marshal]::Copy($sd,$bytes,0,$length)
        $raw=[Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)
        if($null -eq $raw.Owner -or $null -eq $raw.Group -or $null -eq $raw.DiscretionaryAcl -or
            $raw.DiscretionaryAcl.Count -gt 4096 -or $raw.Owner.Value -cne $Entry.OwnerSid) { throw 'owner-or-dacl-policy' }
        $acl=[Runtime.InteropServices.Marshal]::ReadIntPtr($out,16)
        Assert-SecSealBudget $Lease
        if($acl -eq [IntPtr]::Zero -or $n::IsValidAcl($acl) -eq 0) { throw 'invalid-or-null-dacl' }
        foreach($ace in $raw.DiscretionaryAcl) {
            # Refuse callbacks, object-specific and other policy forms this source
            # has not modeled. AccessCheck still evaluates groups/restrictions.
            if($ace.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed,[Security.AccessControl.AceType]::AccessDenied)) { throw 'unsupported-ace-form' }
        }
        $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        if($digest -cne $Entry.SecuritySha256) { throw 'descriptor-binding' }
        foreach($actor in $Actors) {
            if($raw.Owner.Value -ceq $actor.ExpectedPolicy.UserSid) { throw 'actor-owner-refused' }
            # Each forbidden right checked separately; denied union is insufficient.
            foreach($right in @([UInt32]2,[UInt32]4,[UInt32]16,[UInt32]256,[UInt32]65536,[UInt32]262144,[UInt32]524288)) {
                Assert-SecIndividualAccess $Lease $sd $actor $right $false
            }
            if($Entry.Kind -ceq 'directory') { Assert-SecIndividualAccess $Lease $sd $actor ([UInt32]64) $false }
            if($actor.Role -ceq 'victim') {
                foreach($right in @([UInt32]1,[UInt32]32,[UInt32]128,[UInt32]131072)) {
                    Assert-SecIndividualAccess $Lease $sd $actor $right $true
                }
            }
        }
        return $digest
    } finally {
        if(-not (Close-SecSealScope $Lease $scope)) { throw 'seal-scope-cleanup-pending' }
    }
}
function Get-SecHandleDigest {
    param($Lease,[IntPtr]$Handle,[Int64]$Size,[bool]$Manifest)
    $cap=if($Manifest){65536}else{33554432}
    if($Size -lt 0 -or $Size -gt $cap -or $Lease.HashBytes+$Size -gt 134217728) { throw 'seal-hash-size' }
    $n=$Lease.Native;$scope=New-SecSealScope $Lease
    try {
        $buffer=New-SecSealBuffer $Lease $scope 65536;$got=New-SecSealBuffer $Lease $scope 4
        $copy=[byte[]]::new(65536);$scope.Hash=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
        $total=[Int64]0
        # <=513 reads/file including explicit EOF; global4096. Synchronous native
        # I/O, no detached reader; cooperative deadline cannot cancel stalled I/O.
        for($i=0;$i -lt 513;$i++) {
            $request=[int][Math]::Min(65536,[Math]::Max(1,$Size-$total))
            if($Lease.ReadCalls -ge 4096) { throw 'seal-read-cap' }
            $Lease.ReadCalls++;Assert-SecSealBudget $Lease
            if($n::ReadFile($Handle,$buffer,$request,$got,[IntPtr]::Zero) -eq 0) { throw 'seal-read-failed' }
            $count=[Runtime.InteropServices.Marshal]::ReadInt32($got)
            if($count -lt 0 -or $count -gt $request -or $total+$count -gt $Size) { throw 'seal-read-shape' }
            if($count -eq 0) {
                if($total -ne $Size) { throw 'seal-premature-eof' }
                return [Convert]::ToHexString($scope.Hash.GetHashAndReset()).ToLowerInvariant()
            }
            [Runtime.InteropServices.Marshal]::Copy($buffer,$copy,0,$count)
            $scope.Hash.AppendData($copy,0,$count);$total+=$count;$Lease.HashBytes+=$count
        }
        throw 'seal-read-iteration-cap'
    } finally { if(-not (Close-SecSealScope $Lease $scope)) { throw 'seal-scope-cleanup-pending' } }
}
function Open-SecFutureSealCore {
    # Trusted in-memory controller contract only. No callsite or public JSON parser.
    # Manifest is independently authenticated BEFORE this role, never self-trusted.
    param([Type]$Native,$Expected,$Victim,$Foreign)
    $lease=[pscustomobject]@{
        Native=$Native;Handles=[Collections.Generic.List[IntPtr]]::new(80)
        Witnesses=[Collections.Generic.List[object]]::new();Clock=[Diagnostics.Stopwatch]::StartNew()
        NativeCalls=0;HashBytes=[Int64]0;ReadCalls=0;Status='unknown';SealValidated=$false
        TempScopes=[Collections.Generic.List[object]]::new(32);CleanupBlocked=$false
        ClosePassStarted=$false;CleanupOwned=$true;ActorBindings=@()
    }
    try {
        if($Expected.ControllerRole -cne 'root-reviewed-seal-controller' -or
            $Expected.TrustedSetupWritableHandlesReleased -ne $true -or
            $Expected.TrustedSetupNoMutationWhileLeased -ne $true -or
            $Expected.ManifestAuthenticated -ne $true -or
            $Expected.TrustedDosNamespaceImmutableWhileLeased -ne $true -or
            $Expected.AuthenticatedManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $Expected.Entries.Count -lt 1 -or
            $Expected.Entries.Count -gt 80 -or $Victim.Role -cne 'victim' -or $Foreign.Role -cne 'foreign') { throw 'seal-trusted-inputs-missing' }
        $actors=@($Victim,$Foreign)
        $vs=Assert-SecActorToken $lease $Victim;$fs=Assert-SecActorToken $lease $Foreign
        if($vs -ceq $fs) { throw 'actors-not-distinct' }
        $lease.ActorBindings=@(
            [pscustomobject]@{Role='victim';UserSid=$vs;TokenId=$Victim.ExpectedPolicy.TokenId;AuthenticationId=$Victim.ExpectedPolicy.AuthenticationId;ModifiedId=$Victim.ExpectedPolicy.ModifiedId},
            [pscustomobject]@{Role='foreign';UserSid=$fs;TokenId=$Foreign.ExpectedPolicy.TokenId;AuthenticationId=$Foreign.ExpectedPolicy.AuthenticationId;ModifiedId=$Foreign.ExpectedPolicy.ModifiedId})
        $roleCounts=@{source=0;binary=0;manifest=0;harness=0;directory=0}
        $seen=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
        $files=0
        foreach($entry in $Expected.Entries) {
            $path=$entry.Path
            if($path -isnot [string] -or $path.Length -gt 260 -or $path -cnotmatch '^[A-Z]:\\' -or
                $path.Substring(2).Contains(':') -or $path.Contains('/') -or $path.Substring(3).Contains('\\') -or ($path.Length -gt 3 -and $path.EndsWith('\')) -or $seen.ContainsKey($path) -or
                $entry.Kind -cnotin @('directory','binary','source','manifest','harness')) { throw 'seal-path-or-role' }
            $roleCounts[$entry.Kind]++
            if($entry.Kind -ceq 'manifest' -and $entry.Sha256 -cne $Expected.AuthenticatedManifestSha256) { throw 'independent-manifest-binding' }
            $root=$path.Substring(0,3)
            if($root -cne $Expected.TrustedRoot) { throw 'seal-root-escape' }
            $parts=$path.Substring(3).Split('\',[StringSplitOptions]::RemoveEmptyEntries)
            if($parts.Count -gt 64) { throw 'seal-depth' }
            foreach($part in $parts) {
                if($part -in @('.','..') -or $part -match '[<>:"/\\|?*\x00-\x1f]' -or
                    $part.EndsWith('.') -or $part.EndsWith(' ') -or
                    $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'seal-component' }
            }
            if($path -cne $root) {
                $parent=[IO.Path]::GetDirectoryName($path)
                if(-not $seen.ContainsKey($parent) -or $seen[$parent].Kind -cne 'directory') { throw 'unleased-ancestor' }
            } elseif($seen.Count -ne 0 -or $entry.Kind -cne 'directory') { throw 'seal-root-order' }
            # CreateFileW is NOT openat. Previous ancestry must ALREADY be retained
            # and individually immutable to both actors before the absolute open.
            $access=[UInt32]0x20080
            if($entry.Kind -cne 'directory') { $access=$access -bor 1;$files++ }
            if($files -gt 16 -or $lease.Handles.Count -ge 80) { throw 'seal-handle-or-file-cap' }
            # Reserve an existing-capacity zero slot BEFORE native acquisition.
            $slot=$lease.Handles.Count
            $lease.Handles.Add([IntPtr]::Zero)
            Assert-SecSealBudget $lease
            $lease.Handles[$slot]=$Native::CreateFileW($path,$access,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
            if($lease.Handles[$slot] -eq [IntPtr]::new(-1)) {
                $lease.Handles[$slot]=[IntPtr]::Zero;throw 'seal-open-failed'
            }
            $h=$lease.Handles[$slot] # Already owned before identity/security reads.
            $w=Get-SecFileWitness $lease $h
            if($w.Identity -cne $entry.Identity -or $w.Directory -ne ($entry.Kind -ceq 'directory') -or
                $w.Links -ne $entry.Links -or $w.Attributes -ne $entry.Attributes -or
                ($entry.Kind -cne 'directory' -and ($w.Links -ne 1 -or $w.Size -ne $entry.Bytes))) { throw 'seal-identity-binding' }
            $sd=Get-SecSecurityWitness $lease $h $entry $actors
            $digest='directory-no-content'
            if($entry.Kind -cne 'directory') {
                $digest=Get-SecHandleDigest $lease $h $w.Size ($entry.Kind -ceq 'manifest')
                if($digest -cne $entry.Sha256) { throw 'seal-content-binding' }
                $after=Get-SecFileWitness $lease $h
                if($after.Identity -cne $w.Identity -or $after.Size -ne $w.Size -or $after.Links -ne 1) { throw 'seal-posthash-change' }
            }
            $seen.Add($path,$entry)
            $lease.Witnesses.Add([pscustomobject]@{Role=$entry.Kind;Identity=$w.Identity;Descriptor=$sd;Content=$digest})
        }
        if($roleCounts.source -lt 1 -or $roleCounts.binary -lt 1 -or $roleCounts.manifest -ne 1 -or $roleCounts.harness -lt 1) { throw 'incomplete-seal-role-set' }
        # Bind tokens again after all access checks, preserving their actual roles.
        $null=Assert-SecActorToken $lease $Victim;$null=Assert-SecActorToken $lease $Foreign
        if($lease.CleanupBlocked -or $lease.TempScopes.Count -ne 0) { throw 'seal-temporary-ownership-pending' }
        $lease.Status='leases-held-source-only';$lease.SealValidated=$true
        # Caller retains this SAME lease through future Node require + fixed sibling
        # worker creation/exit; no API to substitute paths/worker payload is added.
    } catch { $lease.Status='seal-refused-owned';$lease.SealValidated=$false }
    return $lease
}
function Close-SecFutureSealLease {
    param($Lease)
    # Exactly one finite close pass; old failed scope/handle releases are not retried.
    if($Lease.ClosePassStarted) { return $Lease }
    $Lease.ClosePassStarted=$true
    $n=$Lease.Native
    for($i=$Lease.TempScopes.Count-1;$i -ge 0;$i--) {
        try { $null=Close-SecSealScope $Lease $Lease.TempScopes[$i] }
        catch { $Lease.CleanupBlocked=$true }
    }
    for($i=$Lease.Handles.Count-1;$i -ge 0;$i--) {
        try {
            if($Lease.Handles[$i] -eq [IntPtr]::Zero) { $Lease.Handles.RemoveAt($i);continue }
            if($Lease.NativeCalls -ge 8192) { $Lease.CleanupBlocked=$true;continue }
            $Lease.NativeCalls++
            if($n::CloseHandle($Lease.Handles[$i]) -ne 0) {
                $Lease.Handles[$i]=[IntPtr]::Zero;$Lease.Handles.RemoveAt($i)
            } else { $Lease.CleanupBlocked=$true }
        } catch { $Lease.CleanupBlocked=$true }
    }
    # Registry records retire only after all buffer/SD-output/captured-pointer/hash
    # obligations are proven empty. Retained unknown records prohibit closure.
    $closed=($Lease.Handles.Count -eq 0 -and $Lease.TempScopes.Count -eq 0 -and -not $Lease.CleanupBlocked)
    foreach($owner in $Lease.TempScopes) {
        if(-not (Test-SecSealScopeEmpty $owner)) { $closed=$false }
    }
    $Lease.CleanupOwned=(-not $closed)
    $Lease.Status=if($closed){'leases-closed'}else{'cleanup-pending'}
    return $Lease
}
