# PRIVATE SOURCE ONLY. Function definitions: no import-time Emit/native call.
function New-SecDaemonNativeApi {
    if(-not $IsWindows -or [IntPtr]::Size -ne 8 -or
        [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -cne 'X64' -or
        $ExecutionContext.SessionState.LanguageMode.ToString() -cne 'FullLanguage' -or
        -not [Runtime.CompilerServices.RuntimeFeature]::IsDynamicCodeSupported) { throw 'ffi-platform-refused' }
    $a=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
        [Reflection.AssemblyName]::new('SecDaemonOutsideObserver'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $t=$a.DefineDynamicModule('Fixed').DefineType('SecDaemonFixedNative',
        [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
    $P=[IntPtr];$U=[UInt32];$I=[Int32];$Z=[UIntPtr];$V=[void];$S=[string]
    # Closed literal surface. No caller-selected DLL/API/signature/opcode resolver.
    # Int32 represents native BOOL; raw owned pointers represent output buffers.
    $rows=@(
        @('kernel32','CreateJobObjectW',$P,@($P,$S),$true),
        @('kernel32','SetInformationJobObject',$I,@($P,$I,$P,$U),$true),
        @('kernel32','QueryInformationJobObject',$I,@($P,$I,$P,$U,$P),$true),
        @('kernel32','IsProcessInJob',$I,@($P,$P,$P),$true),
        @('kernel32','GetHandleInformation',$I,@($P,$P),$true),
        @('kernel32','GetProcessAffinityMask',$I,@($P,$P,$P),$true),
        @('kernel32','GetActiveProcessorGroupCount',[UInt16],@(),$false),
        @('kernel32','CloseHandle',$I,@($P),$true),
        @('kernel32','CreateProcessW',$I,@($S,$P,$P,$P,$I,$U,$P,$S,$P,$P),$true),
        @('kernel32','InitializeProcThreadAttributeList',$I,@($P,$U,$U,$P),$true),
        @('kernel32','UpdateProcThreadAttribute',$I,@($P,$U,$Z,$P,$Z,$P,$P),$true),
        @('kernel32','DeleteProcThreadAttributeList',$V,@($P),$false),
        @('kernel32','ResumeThread',$U,@($P),$true),
        @('kernel32','GetProcessId',$U,@($P),$true),
        @('kernel32','GetProcessTimes',$I,@($P,$P,$P,$P,$P),$true),
        @('kernel32','GetExitCodeProcess',$I,@($P,$P),$true),
        @('kernel32','WaitForSingleObject',$U,@($P,$U),$true),
        @('kernel32','TerminateProcess',$I,@($P,$U),$true),
        @('kernel32','TerminateJobObject',$I,@($P,$U),$true),
        @('kernel32','CreateFileW',$P,@($S,$U,$U,$P,$U,$U,$P),$true),
        @('kernel32','GetFileType',$U,@($P),$true),
        @('kernel32','GetFileInformationByHandleEx',$I,@($P,$I,$P,$U),$true),
        @('kernel32','ReadFile',$I,@($P,$P,$U,$P,$P),$true),
        @('kernel32','LocalFree',$P,@($P),$false),
        @('advapi32','GetSecurityInfo',$U,@($P,$I,$U,$P,$P,$P,$P,$P),$false),
        @('advapi32','IsValidSecurityDescriptor',$I,@($P),$false),
        @('advapi32','GetSecurityDescriptorLength',$U,@($P),$false),
        @('advapi32','IsValidAcl',$I,@($P),$false),
        @('advapi32','AccessCheck',$I,@($P,$P,$U,$P,$P,$P,$P,$P),$true),
        @('advapi32','GetTokenInformation',$I,@($P,$I,$P,$U,$P),$true),
        @('advapi32','LookupPrivilegeValueW',$I,@($S,$S,$P),$true)
    )
    $ctor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
    $fields=[Reflection.FieldInfo[]]@(
        [Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'),
        [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'),
        [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
        [Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'),
        [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
        [Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig'))
    foreach($r in $rows) {
        $dll='C:\Windows\System32\'+$r[0]+'.dll'
        $m=$t.DefinePInvokeMethod($r[1],$dll,$r[1],
            [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl,
            [Reflection.CallingConventions]::Standard,$r[2],[Type[]]$r[3],
            [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
        # DllImport is a pseudo attribute; verify its baked result before any call.
        $ca=[Reflection.Emit.CustomAttributeBuilder]::new($ctor,[object[]]@($dll),$fields,
            [object[]]@($r[1],$true,[bool]$r[4],[Runtime.InteropServices.CallingConvention]::Winapi,
                [Runtime.InteropServices.CharSet]::Unicode,$true))
        $m.SetCustomAttribute($ca)
        $m.SetImplementationFlags($m.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    }
    $n=$t.CreateType()
    foreach($r in $rows) {
        $di=$n.GetMethod($r[1]).GetCustomAttributes([Runtime.InteropServices.DllImportAttribute],$false)
        if($di.Count -ne 1 -or $di[0].Value -cne ('C:\Windows\System32\'+$r[0]+'.dll') -or
            $di[0].EntryPoint -cne $r[1] -or -not $di[0].ExactSpelling -or
            $di[0].SetLastError -ne [bool]$r[4] -or -not $di[0].PreserveSig -or
            $di[0].CallingConvention -ne [Runtime.InteropServices.CallingConvention]::Winapi -or
            $di[0].CharSet -ne [Runtime.InteropServices.CharSet]::Unicode) { throw 'ffi-metadata-refused' }
    }
    return $n
}
function New-SecNativeBuffer {
    param([Collections.Generic.List[object]]$Owned,[int]$Bytes)
    if($Bytes -lt 1 -or $Bytes -gt 1048576 -or $Owned.Count -ge 32) { throw 'buffer-cap' }
    $sum=[Int64]$Bytes
    foreach($b in $Owned) { $sum+=$b.Bytes }
    if($sum -ge 1048576) { throw 'aggregate-buffer-cap' }
    # Reserve all fallible managed owner construction/list growth BEFORE acquire.
    $record=[pscustomobject]@{Pointer=[IntPtr]::Zero;Bytes=$Bytes}
    if($Owned.Capacity -lt $Owned.Count+1) { $Owned.Capacity=$Owned.Count+1 }
    $Owned.Add($record)
    # Allocation failure leaves an owned zero slot with no native obligation.
    $record.Pointer=[Runtime.InteropServices.Marshal]::AllocHGlobal($Bytes)
    [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($Bytes),0,$record.Pointer,$Bytes)
    return $record.Pointer
}
function Clear-SecNativeBuffers {
    param([Collections.Generic.List[object]]$Owned)
    for($i=$Owned.Count-1;$i -ge 0;$i--) {
        if($Owned[$i].Pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($Owned[$i].Pointer)
            $Owned[$i].Pointer=[IntPtr]::Zero
        }
        $Owned.RemoveAt($i)
    }
}
# X64 layout inferences, not executed ABI proof:
# EXTENDED_LIMIT144 flags16/active40/affinity48/jobCommit120.
# ACCOUNTING48 lifetimeProcesses36/active40/terminated44. PID_LIST8+8*N IDs8.
# STARTUPINFOEX112 cb0/flags60/stdin80/stdout88/stderr96/attributes104.
# PROCESS_INFORMATION24 process0/thread8/pid16/tid20.
# SECURITY_ATTRIBUTES24 length0/sd8/inherit16. FILE_ID_INFO24 volume0/id128bits8.
# STANDARD_INFO24 eof8/links16/deletePending BOOLEAN20/directory BOOLEAN21.
# BASIC_INFO40 attrs32; ATTRIBUTE_TAG_INFO8 attrs0/tag4; GENERIC_MAPPING16.
