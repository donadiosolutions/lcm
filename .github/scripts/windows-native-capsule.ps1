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

function Invoke-SecFutureFixedChild {
    # UNREACHABLE from carrier; no caller-controlled executable/argv/environment.
    # The concrete launch is source-only until this lock is changed under fresh
    # A/B/synthesis/root grant. No public JSON handle or grant-token interface.
    throw 'future-fixed-child-source-locked'
}
function Invoke-SecFutureFixedChildCore {
    # NO CALLSITE. Future fixed-role source, no grant. Caller must be the reviewed
    # trusted controller after a fresh runtime witness; cannot be actor input.
    param([Type]$Native)
    $s=New-SecCapsuleState $Native;$n=$s.Native
    $attrs=[IntPtr]::Zero;$attrsInitialized=$false
    try {
        Open-SecConfiguredJob $s
        $sa=New-SecNativeBuffer $s.Buffers 24
        [Runtime.InteropServices.Marshal]::WriteInt32($sa,0,24)
        [Runtime.InteropServices.Marshal]::WriteInt32($sa,16,1)
        for($i=0;$i -lt 3;$i++) {
            Assert-SecNativeWindow $s
            $access=if($i -eq 0){[UInt32]2147483648}else{[UInt32]1073741824}
            $s.Nul[$i]=$n::CreateFileW('NUL',$access,3,$sa,3,0,[IntPtr]::Zero)
            if($s.Nul[$i] -eq [IntPtr]::new(-1)) { $s.Nul[$i]=[IntPtr]::Zero;throw 'nul-open-failed' }
        }
        $size=New-SecNativeBuffer $s.Buffers 8
        Assert-SecNativeWindow $s
        $sizing=$n::InitializeProcThreadAttributeList([IntPtr]::Zero,2,0,$size)
        $last=[Runtime.InteropServices.Marshal]::GetLastPInvokeError()
        $bytes=[Runtime.InteropServices.Marshal]::ReadInt64($size)
        if($sizing -ne 0 -or $last -ne 122 -or $bytes -lt 1 -or $bytes -gt 65536) { throw 'attribute-sizing-failed' }
        $attrs=New-SecNativeBuffer $s.Buffers ([int]$bytes)
        Assert-SecNativeWindow $s
        if($n::InitializeProcThreadAttributeList($attrs,2,0,$size) -eq 0) { throw 'attribute-init-failed' }
        $attrsInitialized=$true
        $hl=New-SecNativeBuffer $s.Buffers 24;$jl=New-SecNativeBuffer $s.Buffers 8
        for($i=0;$i -lt 3;$i++) { [Runtime.InteropServices.Marshal]::WriteIntPtr($hl,8*$i,$s.Nul[$i]) }
        [Runtime.InteropServices.Marshal]::WriteIntPtr($jl,$s.Job)
        Assert-SecNativeWindow $s
        if($n::UpdateProcThreadAttribute($attrs,0,[UIntPtr]::new(0x20002),$hl,[UIntPtr]::new(24),[IntPtr]::Zero,[IntPtr]::Zero) -eq 0) { throw 'handle-list-failed' }
        Assert-SecNativeWindow $s
        if($n::UpdateProcThreadAttribute($attrs,0,[UIntPtr]::new(0x2000D),$jl,[UIntPtr]::new(8),[IntPtr]::Zero,[IntPtr]::Zero) -eq 0) { throw 'atomic-job-list-failed' }
        $si=New-SecNativeBuffer $s.Buffers 112;$pi=New-SecNativeBuffer $s.Buffers 24
        [Runtime.InteropServices.Marshal]::WriteInt32($si,0,112)
        [Runtime.InteropServices.Marshal]::WriteInt32($si,60,0x100)
        for($i=0;$i -lt 3;$i++) { [Runtime.InteropServices.Marshal]::WriteIntPtr($si,80+8*$i,$s.Nul[$i]) }
        [Runtime.InteropServices.Marshal]::WriteIntPtr($si,104,$attrs)
        $text='"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo -NoProfile -NonInteractive -Command "exit 0"'+[char]0
        $bytes=[Text.Encoding]::Unicode.GetBytes($text)
        $cmd=New-SecNativeBuffer $s.Buffers $bytes.Length
        [Runtime.InteropServices.Marshal]::Copy($bytes,0,$cmd,$bytes.Length)
        $text='SystemRoot=C:\Windows'+[char]0+'WINDIR=C:\Windows'+[char]0+[char]0
        $bytes=[Text.Encoding]::Unicode.GetBytes($text)
        $envBlock=New-SecNativeBuffer $s.Buffers $bytes.Length
        [Runtime.InteropServices.Marshal]::Copy($bytes,0,$envBlock,$bytes.Length)
        Assert-SecOutside $s
        Assert-SecNativeWindow $s
        # SUSPENDED4|UNICODE_ENV0x400|EXTENDED0x80000|NO_WINDOW0x8000000.
        # HANDLE_LIST requires bInheritHandles=TRUE; J remains noninheritable.
        $ok=$n::CreateProcessW('C:\Program Files\PowerShell\7\pwsh.exe',$cmd,[IntPtr]::Zero,[IntPtr]::Zero,
            1,0x08080404,$envBlock,'C:\Program Files\PowerShell\7',$si,$pi)
        if($ok -eq 0) { throw 'create-process-failed' }
        $s.Process=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,0)
        $s.Thread=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,8)
        $s.ChildPid=[UInt32][Runtime.InteropServices.Marshal]::ReadInt32($pi,16)
        $birth=New-SecNativeBuffer $s.Buffers 32
        Assert-SecNativeWindow $s
        if($n::GetProcessTimes($s.Process,$birth,[IntPtr]::Add($birth,8),[IntPtr]::Add($birth,16),[IntPtr]::Add($birth,24)) -eq 0) { throw 'birth-query-failed' }
        $s.ChildBirth=[Runtime.InteropServices.Marshal]::ReadInt64($birth,0).ToString('X16')
        Assert-SecNativeWindow $s
        if($n::GetProcessId($s.Process) -ne $s.ChildPid) { throw 'pid-binding-failed' }
        $member=New-SecNativeBuffer $s.Buffers 4
        Assert-SecNativeWindow $s
        if($n::IsProcessInJob($s.Process,$s.Job,$member) -eq 0 -or
            [Runtime.InteropServices.Marshal]::ReadInt32($member) -ne 1) { throw 'membership-failed' }
        $c=Get-SecJobCensus $s
        if($c.Active -ne 1 -or $c.Total -ne 1 -or $c.Ids[0] -ne $s.ChildPid) { throw 'pre-resume-census-failed' }
        Assert-SecOutside $s
        Assert-SecNativeWindow $s
        if($n::ResumeThread($s.Thread) -ne 1) { throw 'resume-count-failed' }
        $left=[Math]::Max(0,4000-$s.Clock.ElapsedMilliseconds)
        $s.NativeCalls++;$wait=$n::WaitForSingleObject($s.Process,[UInt32]$left)
        if($wait -ne 0) { throw 'child-wait-failed-or-timeout' }
        $s.ChildSignaled=$true
        $exit=New-SecNativeBuffer $s.Buffers 4
        Assert-SecNativeWindow $s
        if($n::GetExitCodeProcess($s.Process,$exit) -eq 0) { throw 'exit-query-failed' }
        $s.ChildExit=[Runtime.InteropServices.Marshal]::ReadInt32($exit)
        if($s.ChildExit -ne 0) { throw 'child-nonzero-exit' }
        $s.IoQuiescent=$true # Synchronous NUL only, no pending capture/overlapped I/O.
        $s.Status='child-signaled'
    } catch { $s.Status='cleanup-pending';$s.Reason='fixed-child-refused' }
    finally {
        if($attrsInitialized) { $s.NativeCalls++;$n::DeleteProcThreadAttributeList($attrs) }
        # Attribute value buffers/handles remain alive through DeleteAttributeList.
        for($i=0;$i -lt 3;$i++) {
            if($s.Nul[$i] -ne [IntPtr]::Zero) {
                $s.NativeCalls++
                if($n::CloseHandle($s.Nul[$i]) -ne 0) { $s.Nul[$i]=[IntPtr]::Zero }
                else { $s.Status='cleanup-pending';$s.Reason='nul-close-failed' }
            }
        }
        if($s.Process -ne [IntPtr]::Zero -and $s.ChildSignaled -ne $true) {
            if($s.Job -ne [IntPtr]::Zero) { $s.NativeCalls++;$stopJob=$n::TerminateJobObject($s.Job,1) }
            $s.NativeCalls++;$stopChild=$n::TerminateProcess($s.Process,1)
            $left=[Math]::Max(0,5000-$s.Clock.ElapsedMilliseconds)
            $s.NativeCalls++;$w=$n::WaitForSingleObject($s.Process,[UInt32]$left)
            if($w -eq 0) {
                $s.ChildSignaled=$true;$s.IoQuiescent=$true
                $x=New-SecNativeBuffer $s.Buffers 4
                $s.NativeCalls++
                if($n::GetExitCodeProcess($s.Process,$x) -ne 0) { $s.ChildExit=[Runtime.InteropServices.Marshal]::ReadInt32($x) }
            }
        }
        if($s.Job -eq [IntPtr]::Zero) {
            # Acquisition refusal: no NULL membership/census, including inherited
            # platform-job semantics. Only genuinely empty ownership can clear.
            $empty=($s.Process -eq [IntPtr]::Zero -and $s.Thread -eq [IntPtr]::Zero -and
                $s.Nul[0] -eq [IntPtr]::Zero -and $s.Nul[1] -eq [IntPtr]::Zero -and $s.Nul[2] -eq [IntPtr]::Zero)
            if($empty) { $s.Status='refused-cleaned' }
            else { $s.Status='cleanup-pending';$s.CleanupOwned=$true }
        } elseif($s.Process -eq [IntPtr]::Zero -or ($s.ChildSignaled -eq $true -and $s.ChildExit -ne 'unknown' -and $s.IoQuiescent -eq $true)) {
            # Release process/thread references BEFORE J active-zero query.
            $tc=Close-SecCapsuleHandle $s Thread;$pc=Close-SecCapsuleHandle $s Process
            if($tc -and $pc) {
                try {
                    Assert-SecOutside $s
                    $c=Get-SecJobCensus $s
                    if($c.Active -eq 0 -and $c.Ids.Count -eq 0 -and $c.Total -le 1) {
                        $s.JobZero=$true
                        $nulClosed=($s.Nul[0] -eq [IntPtr]::Zero -and $s.Nul[1] -eq [IntPtr]::Zero -and $s.Nul[2] -eq [IntPtr]::Zero)
                        if($nulClosed -and (Close-SecCapsuleHandle $s Job)) {
                            $s.CleanupOwned=$false
                            $s.Status=if($s.Reason -eq 'none'){'fixed-child-observed'}else{'refused-cleaned'}
                        }
                    }
                } catch { $s.Status='cleanup-pending';$s.Reason='final-census-unknown' }
            }
        }
        try { Clear-SecNativeBuffers $s.Buffers }
        catch { $s.Status='cleanup-pending';$s.Reason='buffer-release-failed' }
        $s.CleanupOwned=($s.Job -ne [IntPtr]::Zero -or $s.Process -ne [IntPtr]::Zero -or
            $s.Thread -ne [IntPtr]::Zero -or $s.Nul[0] -ne [IntPtr]::Zero -or
            $s.Nul[1] -ne [IntPtr]::Zero -or $s.Nul[2] -ne [IntPtr]::Zero -or $s.Buffers.Count -ne 0)
        # Any remaining native handles stay in returned owner state. No rerun.
        # No deadline/termination/last-J-close/platform completion certifies exit.
        # A future caller must preserve this state and stop; no finite abandonment
        # path or automatic supervisor success is implemented here.
    }
    if($s.CleanupOwned) { $s.Status='cleanup-pending' }
    return $s
}
