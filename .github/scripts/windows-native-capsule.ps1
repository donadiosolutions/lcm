# PRIVATE SOURCE ONLY. Outside observer O never joins tested job J.
# O is provided pwsh/.NET TCB; the provided supervisor owns O's final exit.
function New-SecCapsuleState {
    param([Type]$Native)
    return [pscustomobject]@{
        Native=$Native;Job=[IntPtr]::Zero;Process=[IntPtr]::Zero;Thread=[IntPtr]::Zero
        Nul=[IntPtr[]]::new(3);Buffers=[Collections.Generic.List[object]]::new()
        Status='unstarted';Reason='none';ObserverOutside='unknown';JobZero='unknown'
        LimitsConfigured='unknown';EmissionVerified='unknown'
        ChildSignaled='unknown';ChildExit='unknown';IoQuiescent='unknown';ChildPid=0
        ChildBirth='unknown';TotalProcesses='unknown';Affinity=[UInt64]0
        NativeCalls=0;Clock=[Diagnostics.Stopwatch]::StartNew();DeadlineMs=5000
        CleanupOwned=$true;ObserverExit='supervisor-owned-unobserved'
    }
}
function Assert-SecNativeWindow {
    param($State)
    $State.NativeCalls++
    if($State.NativeCalls -gt 128 -or $State.Clock.ElapsedMilliseconds -ge $State.DeadlineMs) { throw 'original-native-window' }
}
function Assert-SecOutside {
    param($State)
    if($State.Job -eq [IntPtr]::Zero) { throw 'explicit-job-required' }
    $n=$State.Native;$m=New-SecNativeBuffer $State.Buffers 4
    Assert-SecNativeWindow $State
    if($n::IsProcessInJob([IntPtr]::new(-1),$State.Job,$m) -eq 0 -or
        [Runtime.InteropServices.Marshal]::ReadInt32($m) -ne 0) { throw 'observer-not-outside' }
    $State.ObserverOutside=$true
}
function Get-SecJobCensus {
    param($State)
    if($State.Job -eq [IntPtr]::Zero) { throw 'explicit-job-required' }
    $n=$State.Native
    # Fixed complete capacity, no ERROR_MORE_DATA/truncation retry or event assumption.
    $list=New-SecNativeBuffer $State.Buffers 1032
    $a=New-SecNativeBuffer $State.Buffers 48;$len=New-SecNativeBuffer $State.Buffers 4
    Assert-SecNativeWindow $State
    if($n::QueryInformationJobObject($State.Job,3,$list,1032,$len) -eq 0) { throw 'census-list-failed' }
    $assigned=[Runtime.InteropServices.Marshal]::ReadInt32($list,0)
    $returned=[Runtime.InteropServices.Marshal]::ReadInt32($list,4)
    $bytes=[Runtime.InteropServices.Marshal]::ReadInt32($len)
    if($assigned -lt 0 -or $assigned -gt 128 -or $returned -ne $assigned -or
        $bytes -lt (8+8*$returned) -or $bytes -gt 1032) { throw 'census-list-incomplete' }
    $ids=[UInt64[]]::new($returned)
    for($i=0;$i -lt $returned;$i++) { $ids[$i]=[UInt64][Runtime.InteropServices.Marshal]::ReadInt64($list,8+8*$i) }
    Assert-SecNativeWindow $State
    if($n::QueryInformationJobObject($State.Job,1,$a,48,$len) -eq 0 -or
        [Runtime.InteropServices.Marshal]::ReadInt32($len) -ne 48) { throw 'census-accounting-failed' }
    $total=[Runtime.InteropServices.Marshal]::ReadInt32($a,36)
    $active=[Runtime.InteropServices.Marshal]::ReadInt32($a,40)
    if($active -ne $returned -or $total -lt $active -or $total -gt 1) { throw 'census-count-or-churn' }
    $State.TotalProcesses=$total
    return [pscustomobject]@{Ids=$ids;Active=$active;Total=$total}
}
function Open-SecConfiguredJob {
    param($State)
    $n=$State.Native
    Assert-SecNativeWindow $State
    $State.Job=$n::CreateJobObjectW([IntPtr]::Zero,$null)
    if($State.Job -eq [IntPtr]::Zero) { throw 'job-create-failed' }
    $flags=New-SecNativeBuffer $State.Buffers 4
    Assert-SecNativeWindow $State
    if($n::GetHandleInformation($State.Job,$flags) -eq 0 -or
        ([Runtime.InteropServices.Marshal]::ReadInt32($flags) -band 1) -ne 0) { throw 'job-inheritable' }
    Assert-SecOutside $State
    Assert-SecNativeWindow $State
    if($n::GetActiveProcessorGroupCount() -ne 1) { throw 'processor-groups-refused' }
    $pm=New-SecNativeBuffer $State.Buffers 8;$sm=New-SecNativeBuffer $State.Buffers 8
    Assert-SecNativeWindow $State
    if($n::GetProcessAffinityMask([IntPtr]::new(-1),$pm,$sm) -eq 0) { throw 'affinity-query-failed' }
    $mask=[BitConverter]::ToUInt64([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt64($pm)),0)
    $system=[BitConverter]::ToUInt64([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt64($sm)),0)
    if($mask -eq 0 -or ($mask -band $system) -ne $mask) { throw 'affinity-ambiguous' }
    $bit=[UInt64]1
    for($i=0;$i -lt 64;$i++) {
        if(($mask -band $bit) -ne 0) { break }
        if($i -eq 63) { throw 'affinity-empty' }
        $bit=$bit -shl 1
    }
    $State.Affinity=$bit
    $limits=New-SecNativeBuffer $State.Buffers 144
    # KILL_ON_JOB_CLOSE0x2000|ACTIVE_PROCESS8|JOB_MEMORY0x200|AFFINITY0x10.
    # No breakaway; job COMMIT is not RSS. CPU rate10000 is not one CPU.
    [Runtime.InteropServices.Marshal]::WriteInt32($limits,16,0x2218)
    [Runtime.InteropServices.Marshal]::WriteInt32($limits,40,1)
    [Runtime.InteropServices.Marshal]::WriteInt64($limits,48,[BitConverter]::ToInt64([BitConverter]::GetBytes($bit),0))
    [Runtime.InteropServices.Marshal]::WriteInt64($limits,120,536870912)
    Assert-SecNativeWindow $State
    if($n::SetInformationJobObject($State.Job,9,$limits,144) -eq 0) { throw 'job-limits-failed' }
    $back=New-SecNativeBuffer $State.Buffers 144;$len=New-SecNativeBuffer $State.Buffers 4
    Assert-SecNativeWindow $State
    if($n::QueryInformationJobObject($State.Job,9,$back,144,$len) -eq 0 -or
        [Runtime.InteropServices.Marshal]::ReadInt32($len) -ne 144 -or
        [Runtime.InteropServices.Marshal]::ReadInt32($back,16) -ne 0x2218 -or
        [Runtime.InteropServices.Marshal]::ReadInt32($back,40) -ne 1 -or
        [Runtime.InteropServices.Marshal]::ReadInt64($back,48) -ne [Runtime.InteropServices.Marshal]::ReadInt64($limits,48) -or
        [Runtime.InteropServices.Marshal]::ReadInt64($back,120) -ne 536870912) { throw 'job-readback-failed' }
    $State.LimitsConfigured=$true
    $c=Get-SecJobCensus $State
    if($c.Active -ne 0 -or $c.Total -ne 0) { throw 'new-job-not-empty' }
}
function Close-SecCapsuleHandle {
    param($State,[ValidateSet('Job','Process','Thread')]$Slot)
    if($State.$Slot -eq [IntPtr]::Zero) { return $true }
    $State.NativeCalls++
    if($State.NativeCalls -gt 128) { $State.Reason='cleanup-call-cap';return $false }
    $n=$State.Native
    if($n::CloseHandle($State.$Slot) -eq 0) { $State.Reason='handle-close-failed';return $false }
    $State.$Slot=[IntPtr]::Zero
    return $true
}
function Invoke-SecEmptyJobCapability {
    # Sole first-carrier entrypoint. Clock begins BEFORE Emit. ZERO children.
    $s=New-SecCapsuleState $null;$jobCloseAttempted=$false
    $script:OwnedCapsuleState=$s # Preserve the ledger if invocation/finalization throws.
    try {
        $s.Native=New-SecDaemonNativeApi;$s.EmissionVerified=$true
        Open-SecConfiguredJob $s
        Assert-SecOutside $s
        $c=Get-SecJobCensus $s
        if($c.Active -ne 0 -or $c.Total -ne 0) { throw 'empty-final-census' }
        $s.JobZero=$true;$s.IoQuiescent=$true # No child/I/O task ever created.
        $jobCloseAttempted=$true
        if(-not (Close-SecCapsuleHandle $s Job)) { throw 'job-close-failed' }
        if($s.Clock.ElapsedMilliseconds -ge 5000) { throw 'original-native-window' }
        $s.Status='empty-job-observed' # Ownership clears only after buffer disposal below.
    } catch {
        $s.Reason='native-capability-refused';$s.Status='refused'
        if($s.Job -ne [IntPtr]::Zero -and -not $jobCloseAttempted) {
            $jobCloseAttempted=$true
            $closed=Close-SecCapsuleHandle $s Job
        }
        if($s.Job -ne [IntPtr]::Zero) {
            # No retries after failed CloseHandle: preserve unresolved native lease.
            $s.Status='cleanup-pending'
        }
    } finally {
        try { Clear-SecNativeBuffers $s.Buffers }
        catch { $s.Status='cleanup-pending';$s.Reason='buffer-release-failed' }
    }
    $s.CleanupOwned=($s.Job -ne [IntPtr]::Zero -or $s.Buffers.Count -ne 0)
    if($s.CleanupOwned) { $s.Status='cleanup-pending' }
    return $s
}

# SOURCE ONLY. ROOT selected G5 and adopted S2 source policy; separate exact-source
# review/publication/native grants remain required. Custody is retained only while
# O lives; unresolved bounded O death loses handle access and leaves ROOT RESOURCEBLOCK,
# NONTERMINAL cap charge, no dependent native work/replacement/campaign completion
# until original-host physical exit AND owned cleanup are externally proven.
# Lost custody without existing reconciliation proof REQUIRES user/external recovery;
# remain blocked. A fresh Actions run is NOT a census of the original host.
function New-SecFixedChildKeeper {
    $sizes=@(4,4,8,8,144,144,4,1032,48,24,8,65536,24,8,112,24,1024,1024,32,4)
    $buffers=[object[]]::new(20)
    for($i=0;$i -lt 20;$i++) {
        $buffers[$i]=[pscustomobject]@{Pointer=[IntPtr]::Zero;Bytes=$sizes[$i];Lease='reserved';ReleaseAttempted=$false}
    }
    $handles=[object[]]::new(6)
    for($i=0;$i -lt 6;$i++) {
        $handles[$i]=[pscustomobject]@{Handle=[IntPtr]::Zero;Lease='absent';CloseAttempted=$false;CaptureKnown=$false}
    }
    # Handles: J0, process1, thread2, NUL stdin3/stdout4/stderr5. All records
    # and raw PI/attribute lifecycle fields exist before any acquisition.
    return [pscustomobject]@{
        Native=$null;Buffers=$buffers;Handles=$handles;BufferBytes=69216
        Clock=[Diagnostics.Stopwatch]::StartNew();DeadlineMs=5000;NativeCalls=0
        Status='rooted-unstarted';Reason='none';Stage='buffers';EmissionVerified=$false
        CreateAttempted=$false;CreateReturned='unknown';LaunchReservationCharged=$false
        ProcessInfoCaptureComplete=$false;RecoveryAttempted=$false;PidKnown=$false;TidKnown=$false
        ChildPid=[UInt32]0;ChildTid=[UInt32]0;ChildBirth=[Int64]0;ChildBirthKnown=$false
        NoChildProven=$true;ChildPidBound=$false;MemberBeforeResume=$false;CensusBeforeResume=$false
        ActualAffinityVerified=$false;Affinity=[UInt64]0;ObserverOutside=$false;LimitsConfigured=$false
        AttributesState='absent';AttributesDeleteAttempted=$false;AttributesDeleted=$false
        ResumeAttempted=$false;ResumeReturnedCount=[UInt32]0;ResumeReturnedKnown=$false
        NormalWaitAttempted=$false;CancelAttempted=$false;StopJobResult='unattempted';StopProcessResult='unattempted'
        CancelWaitAttempted=$false;ChildSignaled=$false;ExitAttempted=$false;ChildExitKnown=$false;ChildExit=[Int32]0
        IoQuiescent=$false;CleanupPassAttempted=$false;CleanupOwned=$true;CleanupUnknown=$true
        ChildReferencesClosed=$false;FinalJobZero=$false;TotalByHistory=$false;FinalCensusAttempts=0
        CensusCount=0;CensusActive=0;CensusTotal=0;CensusPid=[UInt64]0;CensusConsistent=$false
        NulLeasesClosed=$false;BufferLeasesClosed=$false;OperationObserved=$false
        KeeperAccessible=$true;PolicyRootDecisionPending=$false;ObserverExit='supervisor-owned-unobserved'
    }
}
function Assert-SecFixedTime {
    param($State)
    if($State.Clock.ElapsedMilliseconds -ge 5000) { throw 'original-native-window' }
}
function Assert-SecFixedCall {
    param($State)
    Assert-SecFixedTime $State
    if($State.NativeCalls -ge 128) { throw 'native-call-cap' }
    $State.NativeCalls++ # Reservation consumed even when the invocation throws.
}
function Assert-SecFixedLaunchTime {
    param($State)
    Assert-SecFixedTime $State
    if($State.Clock.ElapsedMilliseconds -ge 2000) { throw 'launch-window' }
}
function Assert-SecFixedOutside {
    param($State)
    if($State.Handles[0].Lease -cne 'owned') { throw 'explicit-job-required' }
    $n=$State.Native;$p=$State.Buffers[1].Pointer
    [Runtime.InteropServices.Marshal]::WriteInt32($p,0)
    Assert-SecFixedCall $State
    $ok=$n::IsProcessInJob([IntPtr]::new(-1),$State.Handles[0].Handle,$p)
    Assert-SecFixedTime $State
    if($ok -eq 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($p) -ne 0) { throw 'observer-not-outside' }
    $State.ObserverOutside=$true
}
function Read-SecFixedCensus {
    param($State)
    if($State.Handles[0].Lease -cne 'owned') { throw 'explicit-job-required' }
    $n=$State.Native;$list=$State.Buffers[7].Pointer;$a=$State.Buffers[8].Pointer;$len=$State.Buffers[6].Pointer
    Assert-SecFixedCall $State
    $ok=$n::QueryInformationJobObject($State.Handles[0].Handle,3,$list,1032,$len)
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'census-list-failed' }
    $assigned=[Runtime.InteropServices.Marshal]::ReadInt32($list)
    $returned=[Runtime.InteropServices.Marshal]::ReadInt32($list,4)
    $bytes=[Runtime.InteropServices.Marshal]::ReadInt32($len)
    if($assigned -lt 0 -or $assigned -gt 1 -or $returned -ne $assigned -or
       $bytes -lt (8+8*$returned) -or $bytes -gt 1032) { throw 'census-list-incomplete' }
    $State.CensusPid=[UInt64]0
    if($returned -eq 1) {
        $State.CensusPid=[UInt64][Runtime.InteropServices.Marshal]::ReadInt64($list,8)
        if($State.CensusPid -eq 0 -or ($State.CreateAttempted -and $State.PidKnown -and
            $State.CensusPid -ne $State.ChildPid)) { throw 'unexpected-census-pid' }
    }
    Assert-SecFixedCall $State
    $ok=$n::QueryInformationJobObject($State.Handles[0].Handle,1,$a,48,$len)
    Assert-SecFixedTime $State
    if($ok -eq 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($len) -ne 48) { throw 'census-accounting-failed' }
    $State.CensusTotal=[Runtime.InteropServices.Marshal]::ReadInt32($a,36)
    $State.CensusActive=[Runtime.InteropServices.Marshal]::ReadInt32($a,40)
    $State.CensusCount=$returned
    if($State.CensusTotal -lt 0 -or $State.CensusTotal -gt 1 -or $State.CensusActive -lt 0 -or
       $State.CensusActive -gt 1 -or $State.CensusTotal -lt $State.CensusActive) { throw 'census-count-or-churn' }
    $State.CensusConsistent=($State.CensusActive -eq $returned)
}
function Assert-SecFixedLimits {
    param($State)
    $n=$State.Native;$back=$State.Buffers[5].Pointer;$len=$State.Buffers[6].Pointer
    Assert-SecFixedCall $State
    $ok=$n::QueryInformationJobObject($State.Handles[0].Handle,9,$back,144,$len)
    Assert-SecFixedTime $State
    if($ok -eq 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($len) -ne 144 -or
       [Runtime.InteropServices.Marshal]::ReadInt32($back,16) -ne 0x2218 -or
       [Runtime.InteropServices.Marshal]::ReadInt32($back,40) -ne 1 -or
       [Runtime.InteropServices.Marshal]::ReadInt64($back,48) -ne
           [Runtime.InteropServices.Marshal]::ReadInt64($State.Buffers[4].Pointer,48) -or
       [Runtime.InteropServices.Marshal]::ReadInt64($back,120) -ne 536870912) { throw 'job-readback-failed' }
    $State.LimitsConfigured=$true
}
function Read-SecFixedProcessInfo {
    param($State)
    if(-not $State.CreateAttempted -or $State.ProcessInfoCaptureComplete) { return }
    $pi=$State.Buffers[15].Pointer
    # Reads are idempotent while raw PI remains rooted. Cleanup gets one recovery
    # pass for still-unknown captures; released aliases are NEVER read/adopted again.
    for($i=1;$i -le 2;$i++) {
        $r=$State.Handles[$i]
        if($r.CloseAttempted -or $r.Lease -ceq 'released') { continue }
        if(-not $r.CaptureKnown) {
            $r.Handle=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,8*($i-1))
            $r.CaptureKnown=$true
        }
        # Captured raw PI is NOT handle authority. Only recorded TRUE creation
        # permits owned process/thread aliases under the successful-call contract.
        # FALSE/contradictory and unknown invocation outputs remain opaque/charged.
        # Reclassify known captured but not-yet-adopted TRUE aliases on recovery;
        # never re-read/adopt a released or close-attempted alias.
        if($State.CreateReturned -cne 'true') {
            if($State.CreateReturned -ceq 'false' -and $r.Handle -eq [IntPtr]::Zero) { $r.Lease='absent' }
            else { $r.Lease='opaque-output' }
        } elseif($r.Handle -eq [IntPtr]::Zero) { $r.Lease='absent' }
        elseif($r.Handle -eq [IntPtr]::new(-1)) { $r.Lease='capture-unknown' }
        else { $r.Lease='owned' }
    }
    if(-not $State.PidKnown) {
        $State.ChildPid=[BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($pi,16)),0)
        $State.PidKnown=$true
    }
    if(-not $State.TidKnown) {
        $State.ChildTid=[BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($pi,20)),0)
        $State.TidKnown=$true
    }
    $State.ProcessInfoCaptureComplete=($State.Handles[1].CaptureKnown -and $State.Handles[2].CaptureKnown -and $State.PidKnown -and $State.TidKnown)
    if($State.CreateReturned -ceq 'false' -and $State.ProcessInfoCaptureComplete -and
       $State.Handles[1].Lease -ceq 'absent' -and $State.Handles[2].Lease -ceq 'absent' -and
       $State.ChildPid -eq 0 -and $State.ChildTid -eq 0) {
        $State.NoChildProven=$true;$State.LaunchReservationCharged=$false
    }
}
function Read-SecFixedExitOnce {
    param($State)
    if($State.CreateReturned -cne 'true' -or -not $State.ChildSignaled -or $State.ExitAttempted -or $State.Handles[1].Lease -cne 'owned') { return }
    $State.ExitAttempted=$true;$n=$State.Native
    Assert-SecFixedCall $State
    $ok=$n::GetExitCodeProcess($State.Handles[1].Handle,$State.Buffers[19].Pointer)
    if($ok -ne 0) {
        $State.ChildExit=[Runtime.InteropServices.Marshal]::ReadInt32($State.Buffers[19].Pointer)
        $State.ChildExitKnown=$true
    }
    Assert-SecFixedTime $State
    if(-not $State.ChildExitKnown) { throw 'exit-query-failed' }
}
function Invoke-SecFixedChildCancelOnce {
    param($State)
    if($State.CancelAttempted -or $State.NoChildProven -or $State.ChildSignaled) { return }
    $State.CancelAttempted=$true;$n=$State.Native
    if(-not $State.ChildSignaled) {
        if($State.Handles[0].Lease -ceq 'owned') {
            try {
                $State.StopJobResult='unknown'
                Assert-SecFixedCall $State
                $ok=$n::TerminateJobObject($State.Handles[0].Handle,1)
                $State.StopJobResult=if($ok -ne 0){'true'}else{'false'}
                Assert-SecFixedTime $State
            } catch { }
        }
        if($State.CreateReturned -ceq 'true' -and $State.Handles[1].Lease -ceq 'owned') {
            try {
                $State.StopProcessResult='unknown'
                Assert-SecFixedCall $State
                $ok=$n::TerminateProcess($State.Handles[1].Handle,1)
                $State.StopProcessResult=if($ok -ne 0){'true'}else{'false'}
                Assert-SecFixedTime $State
            } catch { }
            try {
                $State.CancelWaitAttempted=$true
                Assert-SecFixedCall $State
                $left=4500-$State.Clock.ElapsedMilliseconds
                if($left -le 0) { throw 'cancel-wait-window' }
                $wait=$n::WaitForSingleObject($State.Handles[1].Handle,[UInt32]$left)
                if($wait -eq 0) { $State.ChildSignaled=$true;$State.IoQuiescent=$true }
                Assert-SecFixedTime $State
                if($State.Clock.ElapsedMilliseconds -ge 4500) { throw 'cancel-wait-deadline' }
            } catch { }
        }
    }
    try { Read-SecFixedExitOnce $State } catch { }
}
function Close-SecFixedLeaseOnce {
    param($State,$Record)
    if($Record.Lease -ceq 'absent' -or $Record.Lease -ceq 'released' -or $Record.CloseAttempted) { return }
    if($Record.Lease -cne 'owned') { return }
    if(([Object]::ReferenceEquals($Record,$State.Handles[1]) -or
        [Object]::ReferenceEquals($Record,$State.Handles[2])) -and $State.CreateReturned -cne 'true') { return }
    $Record.CloseAttempted=$true
    $Record.Lease='release-unknown';$n=$State.Native
    Assert-SecFixedCall $State
    $ok=$n::CloseHandle($Record.Handle)
    if($ok -ne 0) { $Record.Lease='released';$Record.Handle=[IntPtr]::Zero }
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'handle-close-failed' }
}
function Complete-SecFixedChildOnce {
    param($State)
    if($State.CleanupPassAttempted) { return }
    $State.CleanupPassAttempted=$true;$n=$State.Native
    if($State.CreateAttempted -and -not $State.ProcessInfoCaptureComplete -and -not $State.RecoveryAttempted) {
        $State.RecoveryAttempted=$true
        try { Read-SecFixedProcessInfo $State } catch { }
    }
    try { Invoke-SecFixedChildCancelOnce $State } catch { }
    try { Read-SecFixedExitOnce $State } catch { }
    # Attribute initialization is unknown from BEFORE its invocation until a known
    # result. Only known initialization may be deleted; an interrupted void delete
    # stays unknown. The backing list, value arrays and referenced handles survive.
    if($State.AttributesState -ceq 'initialized' -and -not $State.AttributesDeleteAttempted) {
        $State.AttributesDeleteAttempted=$true;$State.AttributesState='delete-unknown'
        try {
            Assert-SecFixedCall $State
            $n::DeleteProcThreadAttributeList($State.Buffers[11].Pointer)
            $State.AttributesState='released';$State.AttributesDeleted=$true
            Assert-SecFixedTime $State
        } catch { }
    }
    $attrSafe=($State.AttributesState -ceq 'absent' -or $State.AttributesState -ceq 'released')
    if($attrSafe) {
        for($i=3;$i -le 5;$i++) {
            try { Close-SecFixedLeaseOnce $State $State.Handles[$i] } catch { }
        }
    }
    if($State.NoChildProven -or ($State.ChildSignaled -and $State.ChildExitKnown -and $State.IoQuiescent)) {
        try { Close-SecFixedLeaseOnce $State $State.Handles[2] } catch { }
        try { Close-SecFixedLeaseOnce $State $State.Handles[1] } catch { }
    }
    $State.ChildReferencesClosed=(($State.Handles[1].Lease -ceq 'absent' -or $State.Handles[1].Lease -ceq 'released') -and
        ($State.Handles[2].Lease -ceq 'absent' -or $State.Handles[2].Lease -ceq 'released') -and
        (-not $State.CreateAttempted -or $State.ProcessInfoCaptureComplete))
    $State.NulLeasesClosed=$true
    for($i=3;$i -le 5;$i++) {
        if($State.Handles[$i].Lease -cne 'absent' -and $State.Handles[$i].Lease -cne 'released') { $State.NulLeasesClosed=$false }
    }
    # Known history only: TRUE creation must have Total1; consistent FALSE/empty
    # output or no attempt must have Total0. Unknown invocation never becomes no-child.
    $historyKnown=($State.NoChildProven -or ($State.CreateReturned -ceq 'true' -and
        $State.ProcessInfoCaptureComplete -and $State.ChildPid -ne 0 -and $State.ChildTid -ne 0))
    if($State.Handles[0].Lease -ceq 'owned' -and $State.ChildReferencesClosed -and $historyKnown -and
       ($State.NoChildProven -or ($State.ChildSignaled -and $State.ChildExitKnown -and $State.IoQuiescent))) {
        try {
            Assert-SecFixedOutside $State
            $expectedTotal=if($State.NoChildProven){0}else{1}
            for($attempt=0;$attempt -lt 3;$attempt++) {
                $State.FinalCensusAttempts++
                Read-SecFixedCensus $State
                if($State.CensusTotal -ne $expectedTotal) { throw 'final-lifetime-count' }
                if($State.CensusConsistent -and $State.CensusCount -eq 0 -and $State.CensusActive -eq 0) {
                    $State.FinalJobZero=$true;$State.TotalByHistory=$true;break
                }
                if($attempt -lt 2) {
                    Assert-SecFixedTime $State
                    if($State.Clock.ElapsedMilliseconds -ge 4990) { throw 'census-sleep-window' }
                    [Threading.Thread]::Sleep(10)
                    Assert-SecFixedTime $State
                }
            }
        } catch { }
        if($State.FinalJobZero -and $attrSafe -and $State.NulLeasesClosed) {
            try { Close-SecFixedLeaseOnce $State $State.Handles[0] } catch { }
        }
    }
    # No generic Clear-SecNativeBuffers: fixed records NEVER enter its collection.
    # Keep ALL PI-dependent storage when output capture/history/references are
    # unknown, and ALL attribute-dependent storage until void deletion returned.
    $piSafe=(-not $State.CreateAttempted -or ($State.ProcessInfoCaptureComplete -and $historyKnown -and $State.ChildReferencesClosed))
    for($i=19;$i -ge 0;$i--) {
        $r=$State.Buffers[$i]
        $eligible=$true
        if($i -eq 15 -and -not $piSafe) { $eligible=$false }
        if(($i -eq 9 -or $i -eq 10 -or $i -eq 11 -or $i -eq 12 -or $i -eq 13 -or $i -eq 14) -and -not $attrSafe) { $eligible=$false }
        if(-not $eligible -or $r.ReleaseAttempted -or $r.Lease -ceq 'released') { continue }
        if($r.Lease -ceq 'reserved') { $r.Lease='released';continue }
        if($r.Lease -cne 'owned') { continue }
        $r.ReleaseAttempted=$true;$r.Lease='release-unknown'
        try {
            Assert-SecFixedTime $State
            [Runtime.InteropServices.Marshal]::FreeHGlobal($r.Pointer)
            $r.Lease='released';$r.Pointer=[IntPtr]::Zero
            Assert-SecFixedTime $State
        } catch { }
    }
    $State.BufferLeasesClosed=$true
    for($i=0;$i -lt 20;$i++) { if($State.Buffers[$i].Lease -cne 'released') { $State.BufferLeasesClosed=$false } }
    $State.CleanupOwned=(-not $attrSafe -or -not $State.BufferLeasesClosed -or -not $State.ChildReferencesClosed -or -not $historyKnown)
    for($i=0;$i -lt 6;$i++) {
        if($State.Handles[$i].Lease -cne 'absent' -and $State.Handles[$i].Lease -cne 'released') { $State.CleanupOwned=$true }
    }
    if(-not $State.NoChildProven -and -not ($State.FinalJobZero -and $State.TotalByHistory)) { $State.CleanupOwned=$true }
    $State.CleanupUnknown=$State.CleanupOwned
    if(-not $State.CleanupOwned) {
        $State.LaunchReservationCharged=$false
        # ROOT-adopted S2 source policy: known late closure may retire resource
        # charge, but MUST refuse the original operation; no new dispatch window.
        if($State.Clock.ElapsedMilliseconds -ge 5000) {
            $State.Status='refused-cleaned'
            if($State.Reason -ceq 'none') { $State.Reason='original-native-window' }
        } else {
            $State.Status=if($State.OperationObserved -and $State.Reason -ceq 'none'){'fixed-child-observed'}else{'refused-cleaned'}
        }
    } else {
        $State.Status='retained-unknown'
        if($State.Reason -ceq 'none') { $State.Reason='cleanup-unknown' }
    }
}
function Invoke-SecFutureFixedChildCore {
    # Internal fixed controller: only the no-argument entrypoint calls this.
    # No Type, executable, argv, environment, API, role or grant selector accepted.
    param($State)
    $n=$State.Native;$h=$State.Handles;$b=$State.Buffers
    $State.Stage='job'
    $h[0].Lease='acquire-unknown'
    Assert-SecFixedCall $State
    $h[0].Handle=$n::CreateJobObjectW([IntPtr]::Zero,$null)
    if($h[0].Handle -eq [IntPtr]::Zero) { $h[0].Lease='absent';throw 'job-create-failed' }
    $h[0].Lease='owned'
    Assert-SecFixedTime $State
    Assert-SecFixedCall $State
    $ok=$n::GetHandleInformation($h[0].Handle,$b[0].Pointer)
    Assert-SecFixedTime $State
    if($ok -eq 0 -or ([Runtime.InteropServices.Marshal]::ReadInt32($b[0].Pointer) -band 1) -ne 0) { throw 'job-inheritable' }
    Assert-SecFixedOutside $State
    Assert-SecFixedCall $State
    $groups=$n::GetActiveProcessorGroupCount()
    Assert-SecFixedTime $State
    if($groups -ne 1) { throw 'processor-groups-refused' }
    Assert-SecFixedCall $State
    $ok=$n::GetProcessAffinityMask([IntPtr]::new(-1),$b[2].Pointer,$b[3].Pointer)
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'parent-affinity-query' }
    $mask=[BitConverter]::ToUInt64([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt64($b[2].Pointer)),0)
    $system=[BitConverter]::ToUInt64([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt64($b[3].Pointer)),0)
    if($mask -eq 0 -or ($mask -band $system) -ne $mask) { throw 'parent-affinity-refused' }
    $bit=[UInt64]1
    for($i=0;$i -lt 64;$i++) {
        if(($mask -band $bit) -ne 0) { break }
        if($i -eq 63) { throw 'affinity-empty' }
        $bit=$bit -shl 1
    }
    $State.Affinity=$bit
    [Runtime.InteropServices.Marshal]::WriteInt32($b[4].Pointer,16,0x2218)
    [Runtime.InteropServices.Marshal]::WriteInt32($b[4].Pointer,40,1)
    [Runtime.InteropServices.Marshal]::WriteInt64($b[4].Pointer,48,[BitConverter]::ToInt64([BitConverter]::GetBytes($bit),0))
    [Runtime.InteropServices.Marshal]::WriteInt64($b[4].Pointer,120,536870912)
    Assert-SecFixedCall $State
    $ok=$n::SetInformationJobObject($h[0].Handle,9,$b[4].Pointer,144)
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'job-limits-failed' }
    Assert-SecFixedLimits $State
    Read-SecFixedCensus $State
    if(-not $State.CensusConsistent -or $State.CensusActive -ne 0 -or $State.CensusTotal -ne 0) { throw 'new-job-not-empty' }
    $State.Stage='attributes'
    [Runtime.InteropServices.Marshal]::WriteInt32($b[9].Pointer,24)
    [Runtime.InteropServices.Marshal]::WriteInt32($b[9].Pointer,16,1)
    for($i=3;$i -le 5;$i++) {
        $access=if($i -eq 3){[UInt32]2147483648}else{[UInt32]1073741824}
        $h[$i].Lease='acquire-unknown'
        Assert-SecFixedCall $State
        $h[$i].Handle=$n::CreateFileW('NUL',$access,3,$b[9].Pointer,3,0,[IntPtr]::Zero)
        if($h[$i].Handle -eq [IntPtr]::new(-1)) { $h[$i].Handle=[IntPtr]::Zero;$h[$i].Lease='absent';throw 'nul-open-failed' }
        if($h[$i].Handle -eq [IntPtr]::Zero) { throw 'nul-output-unknown' }
        $h[$i].Lease='owned'
        Assert-SecFixedTime $State
        Assert-SecFixedCall $State
        $ok=$n::GetHandleInformation($h[$i].Handle,$b[0].Pointer)
        Assert-SecFixedTime $State
        if($ok -eq 0 -or ([Runtime.InteropServices.Marshal]::ReadInt32($b[0].Pointer) -band 1) -ne 1) { throw 'nul-inheritance-failed' }
        Assert-SecFixedCall $State
        $kind=$n::GetFileType($h[$i].Handle)
        Assert-SecFixedTime $State
        if($kind -ne 2) { throw 'nul-not-character' }
    }
    Assert-SecFixedCall $State
    $sizing=$n::InitializeProcThreadAttributeList([IntPtr]::Zero,2,0,$b[10].Pointer)
    $last=[Runtime.InteropServices.Marshal]::GetLastPInvokeError()
    Assert-SecFixedTime $State
    $size=[Runtime.InteropServices.Marshal]::ReadInt64($b[10].Pointer)
    if($sizing -ne 0 -or $last -ne 122 -or $size -lt 1 -or $size -gt 65536) { throw 'attribute-sizing-failed' }
    $State.AttributesState='initialize-unknown'
    Assert-SecFixedCall $State
    $ok=$n::InitializeProcThreadAttributeList($b[11].Pointer,2,0,$b[10].Pointer)
    $State.AttributesState=if($ok -eq 0){'absent'}else{'initialized'}
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'attribute-init-failed' }
    for($i=0;$i -lt 3;$i++) { [Runtime.InteropServices.Marshal]::WriteIntPtr($b[12].Pointer,8*$i,$h[3+$i].Handle) }
    [Runtime.InteropServices.Marshal]::WriteIntPtr($b[13].Pointer,$h[0].Handle)
    Assert-SecFixedCall $State
    $ok=$n::UpdateProcThreadAttribute($b[11].Pointer,0,[UIntPtr]::new(0x20002),$b[12].Pointer,[UIntPtr]::new(24),[IntPtr]::Zero,[IntPtr]::Zero)
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'handle-list-failed' }
    Assert-SecFixedCall $State
    $ok=$n::UpdateProcThreadAttribute($b[11].Pointer,0,[UIntPtr]::new(0x2000D),$b[13].Pointer,[UIntPtr]::new(8),[IntPtr]::Zero,[IntPtr]::Zero)
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'atomic-job-list-failed' }
    [Runtime.InteropServices.Marshal]::WriteInt32($b[14].Pointer,112)
    [Runtime.InteropServices.Marshal]::WriteInt32($b[14].Pointer,60,0x100)
    for($i=0;$i -lt 3;$i++) { [Runtime.InteropServices.Marshal]::WriteIntPtr($b[14].Pointer,80+8*$i,$h[3+$i].Handle) }
    [Runtime.InteropServices.Marshal]::WriteIntPtr($b[14].Pointer,104,$b[11].Pointer)
    $cmd=[Text.Encoding]::Unicode.GetBytes('"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo -NoProfile -NonInteractive -Command "exit 0"'+[char]0)
    $envBlock=[Text.Encoding]::Unicode.GetBytes('SystemRoot=C:\Windows'+[char]0+'WINDIR=C:\Windows'+[char]0+[char]0)
    if($cmd.Length -gt 1024 -or $envBlock.Length -gt 1024) { throw 'fixed-recipe-size' }
    [Runtime.InteropServices.Marshal]::Copy($cmd,0,$b[16].Pointer,$cmd.Length)
    [Runtime.InteropServices.Marshal]::Copy($envBlock,0,$b[17].Pointer,$envBlock.Length)
    Assert-SecFixedOutside $State
    Assert-SecFixedLaunchTime $State
    if($State.CreateAttempted) { throw 'single-create-only' }
    $State.Stage='create';$State.NoChildProven=$false;$State.LaunchReservationCharged=$true
    $State.CreateAttempted=$true;$h[1].Lease='possibly-produced';$h[2].Lease='possibly-produced'
    Assert-SecFixedCall $State
    Assert-SecFixedLaunchTime $State
    # Exactly ONE atomic JOB_LIST + suspended launch; no AssignProcess fallback.
    $created=$n::CreateProcessW('C:\Program Files\PowerShell\7\pwsh.exe',$b[16].Pointer,[IntPtr]::Zero,[IntPtr]::Zero,
        1,0x08080404,$b[17].Pointer,'C:\Program Files\PowerShell\7',$b[14].Pointer,$b[15].Pointer)
    $State.CreateReturned=if($created -eq 0){'false'}else{'true'}
    Read-SecFixedProcessInfo $State
    Assert-SecFixedTime $State
    if($State.CreateReturned -cne 'true' -or -not $State.ProcessInfoCaptureComplete -or
       $h[1].Lease -cne 'owned' -or $h[2].Lease -cne 'owned' -or $State.ChildPid -eq 0 -or $State.ChildTid -eq 0) { throw 'create-output-refused' }
    $State.Stage='bind'
    Assert-SecFixedCall $State
    $ok=$n::GetProcessTimes($h[1].Handle,$b[18].Pointer,[IntPtr]::Add($b[18].Pointer,8),[IntPtr]::Add($b[18].Pointer,16),[IntPtr]::Add($b[18].Pointer,24))
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'birth-query-failed' }
    $State.ChildBirth=[Runtime.InteropServices.Marshal]::ReadInt64($b[18].Pointer)
    if($State.ChildBirth -le 0) { throw 'birth-value-refused' }
    $State.ChildBirthKnown=$true
    Assert-SecFixedCall $State
    $pidResult=$n::GetProcessId($h[1].Handle)
    Assert-SecFixedTime $State
    if($pidResult -ne $State.ChildPid) { throw 'pid-binding-failed' }
    $State.ChildPidBound=$true
    for($i=1;$i -le 2;$i++) {
        Assert-SecFixedCall $State
        $ok=$n::GetHandleInformation($h[$i].Handle,$b[0].Pointer)
        Assert-SecFixedTime $State
        if($ok -eq 0 -or ([Runtime.InteropServices.Marshal]::ReadInt32($b[0].Pointer) -band 1) -ne 0) { throw 'child-reference-inheritable' }
    }
    Assert-SecFixedCall $State
    $ok=$n::IsProcessInJob($h[1].Handle,$h[0].Handle,$b[1].Pointer)
    Assert-SecFixedTime $State
    if($ok -eq 0 -or [Runtime.InteropServices.Marshal]::ReadInt32($b[1].Pointer) -ne 1) { throw 'child-membership-failed' }
    $State.MemberBeforeResume=$true
    Assert-SecFixedCall $State
    $ok=$n::GetProcessAffinityMask($h[1].Handle,$b[2].Pointer,$b[3].Pointer)
    Assert-SecFixedTime $State
    if($ok -eq 0) { throw 'child-affinity-query' }
    $actual=[BitConverter]::ToUInt64([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt64($b[2].Pointer)),0)
    $system=[BitConverter]::ToUInt64([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt64($b[3].Pointer)),0)
    if($actual -ne $State.Affinity -or ($actual -band $system) -ne $actual) { throw 'child-affinity-drift' }
    $State.ActualAffinityVerified=$true
    Assert-SecFixedLimits $State
    Read-SecFixedCensus $State
    if(-not $State.CensusConsistent -or $State.CensusActive -ne 1 -or $State.CensusTotal -ne 1 -or
       $State.CensusCount -ne 1 -or $State.CensusPid -ne $State.ChildPid) { throw 'pre-resume-census-failed' }
    $State.CensusBeforeResume=$true
    Assert-SecFixedOutside $State
    Assert-SecFixedLaunchTime $State
    if($State.ResumeAttempted) { throw 'single-resume-only' }
    $State.Stage='resume';$State.ResumeAttempted=$true
    Assert-SecFixedCall $State
    Assert-SecFixedLaunchTime $State
    $State.ResumeReturnedCount=$n::ResumeThread($h[2].Handle)
    $State.ResumeReturnedKnown=$true
    Assert-SecFixedTime $State
    if($State.ResumeReturnedCount -ne 1) { throw 'resume-count-failed' }
    $State.Stage='wait';$State.NormalWaitAttempted=$true
    Assert-SecFixedCall $State
    $left=3500-$State.Clock.ElapsedMilliseconds
    if($left -le 0) { throw 'normal-wait-window' }
    $wait=$n::WaitForSingleObject($h[1].Handle,[UInt32]$left)
    if($wait -eq 0) { $State.ChildSignaled=$true;$State.IoQuiescent=$true }
    Assert-SecFixedTime $State
    if($State.Clock.ElapsedMilliseconds -ge 3500) { throw 'normal-wait-deadline' }
    if(-not $State.ChildSignaled) { throw 'child-wait-failed-or-timeout' }
    Read-SecFixedExitOnce $State
    if(-not $State.ChildExitKnown -or $State.ChildExit -ne 0) { throw 'child-exit-refused' }
    $State.OperationObserved=$true
}
function Invoke-SecFixedChildCapability {
    # Fixed no-argument entry; ROOT source policies selected/adopted, but exact-source
    # reviews, publication AND distinct child grant remain. No runtime role selector.
    if($null -ne $script:OwnedCapsuleState) { throw 'single-keeper-only' }
    $s=New-SecFixedChildKeeper
    $script:OwnedCapsuleState=$s
    try {
        # All20 records/69216 bytes are registered before acquire and BEFORE Emit.
        if($s.Buffers.Count -ne 20 -or $s.BufferBytes -ne 69216 -or $s.Buffers.Count -gt 32 -or $s.BufferBytes -ge 1048576) { throw 'buffer-layout-cap' }
        for($i=0;$i -lt 20;$i++) {
            $r=$s.Buffers[$i];$r.Lease='acquire-unknown'
            Assert-SecFixedTime $s
            $r.Pointer=[Runtime.InteropServices.Marshal]::AllocHGlobal($r.Bytes)
            $r.Lease='owned'
            [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($r.Bytes),0,$r.Pointer,$r.Bytes)
            Assert-SecFixedTime $s
        }
        $s.Stage='emit'
        $s.Native=New-SecDaemonNativeApi;$s.EmissionVerified=$true
        Assert-SecFixedTime $s
        Invoke-SecFutureFixedChildCore $s
    } catch { $s.Reason='fixed-child-refused' }
    finally {
        try { Complete-SecFixedChildOnce $s }
        catch { $s.Status='retained-unknown';$s.CleanupOwned=$true;$s.CleanupUnknown=$true }
    }
    # Projection never removes the root. At report time custody remains in live O.
    # Unresolved O death loses custody: ROOT RESOURCEBLOCK/charge remains until
    # external original-host physical-exit AND owned-cleanup proof; otherwise
    # user/external recovery is REQUIRED. A fresh Actions run supplies no such census.
    return $s
}
