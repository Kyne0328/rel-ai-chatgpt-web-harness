$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Run this script in its own PowerShell process. GitHub's elevated runner
# defaults new NTFS objects to the Administrators group, whereas the recovery
# suite models a desktop service whose files belong to its individual user.
# Node and the native controllers inherit this process's default owner. No
# group memberships, privileges, host settings or production ACLs change.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if (-not $identity.User.Equals($identity.Owner)) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class RelAiBookkeepingFixtureToken {
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenOwner { public IntPtr Owner; }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int informationClass,
        ref TokenOwner information, int length);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static void UseCurrentUserAsDefaultOwner(SecurityIdentifier user) {
        byte[] sid = new byte[user.BinaryLength];
        user.GetBinaryForm(sid, 0);
        GCHandle pinnedSid = GCHandle.Alloc(sid, GCHandleType.Pinned);
        try {
            IntPtr token;
            const uint TokenAdjustDefault = 0x80;
            if (!OpenProcessToken(GetCurrentProcess(), TokenAdjustDefault, out token))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open fixture token");
            try {
                const int TokenOwnerInformation = 4;
                TokenOwner owner = new TokenOwner { Owner = pinnedSid.AddrOfPinnedObject() };
                if (!SetTokenInformation(token, TokenOwnerInformation, ref owner, Marshal.SizeOf(typeof(TokenOwner))))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot set fixture token default owner");
            } finally {
                CloseHandle(token);
            }
        } finally {
            pinnedSid.Free();
        }
    }
}
'@
        [RelAiBookkeepingFixtureToken]::UseCurrentUserAsDefaultOwner($identity.User)
    }
} finally {
    $identity.Dispose()
}

$verifiedIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if (-not $verifiedIdentity.User.Equals($verifiedIdentity.Owner)) {
        throw 'Windows bookkeeping fixture token must default new objects to the current user.'
    }
} finally {
    $verifiedIdentity.Dispose()
}

& node (Join-Path $PSScriptRoot 'windows-bookkeeping-ownership-unit.mjs')
exit $LASTEXITCODE
