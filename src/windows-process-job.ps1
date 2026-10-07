# Native Windows ownership for Rel.AI-created processes only. Protocol 1.
# This is a lifetime boundary, not a sandbox for hostile same-user code.
# Target environment travels only in a nonce-bound inherited JSON payload, limited to
# 24000 UTF-16 characters. Oversize/invalid requests fail before user code; no fallback.
# Finite jobs wait for every newly owned descendant, including detached daemons.
# Managed persistent jobs retain their controller/job for the declared lifetime.
# Pre-existing shared services and externally broker-created processes are not enrolled.
# Existing parent-job restrictions are respected; assignment failure never resumes the target.
param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    [Parameter(Mandatory = $true)][string]$ControlPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$native = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Globalization;

// Preserve JSON strings as UTF-16 code units, including escaped lone surrogates.
// Framework JSON readers can interpret dates or reject valid JSON string values.
public sealed class RelAiJobJson {
    readonly string text;
    int position;
    RelAiJobJson(string value) { text = value; }
    void Space() { while (position < text.Length && " \t\r\n".IndexOf(text[position]) >= 0) position++; }
    char Take() { if (position >= text.Length) throw new ArgumentException("Truncated owned-job JSON"); return text[position++]; }
    void Expect(char value) { if (Take() != value) throw new ArgumentException("Invalid owned-job JSON token"); }
    string StringValue() {
        Expect('"');
        StringBuilder result = new StringBuilder();
        while (true) {
            char value = Take();
            if (value == '"') return result.ToString();
            if (value < 32) throw new ArgumentException("Invalid owned-job JSON string");
            if (value != '\\') { result.Append(value); continue; }
            switch (Take()) {
                case '"': result.Append('"'); break;
                case '\\': result.Append('\\'); break;
                case '/': result.Append('/'); break;
                case 'b': result.Append('\b'); break;
                case 'f': result.Append('\f'); break;
                case 'n': result.Append('\n'); break;
                case 'r': result.Append('\r'); break;
                case 't': result.Append('\t'); break;
                case 'u':
                    int code = 0;
                    for (int i = 0; i < 4; i++) {
                        char digit = Take();
                        int hex = digit >= '0' && digit <= '9' ? digit - '0' : digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 : digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : -1;
                        if (hex < 0) throw new ArgumentException("Invalid owned-job JSON escape");
                        code = code * 16 + hex;
                    }
                    result.Append((char)code); break;
                default: throw new ArgumentException("Invalid owned-job JSON escape");
            }
        }
    }
    object Value(int depth) {
        if (depth > 32) throw new ArgumentException("Owned-job JSON is too deep");
        Space();
        if (position >= text.Length) throw new ArgumentException("Truncated owned-job JSON");
        char token = text[position];
        if (token == '"') return StringValue();
        if (token == '{' || token == '[') {
            position++; Space();
            Dictionary<string, object> map = token == '{' ? new Dictionary<string, object>(StringComparer.Ordinal) : null;
            List<object> list = token == '[' ? new List<object>() : null;
            char end = token == '{' ? '}' : ']';
            if (position < text.Length && text[position] == end) { position++; return map != null ? (object)map : list.ToArray(); }
            while (true) {
                Space(); string key = null;
                if (map != null) { key = StringValue(); Space(); Expect(':'); }
                object value = Value(depth + 1);
                if (map != null) {
                    if (map.ContainsKey(key)) throw new ArgumentException("Duplicate owned-job JSON member");
                    map.Add(key, value);
                } else {
                    if (list.Count >= 65536) throw new ArgumentException("Owned-job JSON array is too large");
                    list.Add(value);
                }
                Space(); char separator = Take();
                if (separator == end) return map != null ? (object)map : list.ToArray();
                if (separator != ',') throw new ArgumentException("Invalid owned-job JSON separator");
            }
        }
        foreach (string literal in new string[] { "true", "false", "null" }) {
            if (position + literal.Length <= text.Length && String.CompareOrdinal(text, position, literal, 0, literal.Length) == 0) {
                position += literal.Length;
                return literal == "null" ? null : (object)(literal == "true");
            }
        }
        int start = position;
        if (text[position] == '-') position++;
        if (position >= text.Length) throw new ArgumentException("Invalid owned-job JSON number");
        if (text[position] == '0') position++;
        else {
            if (text[position] < '1' || text[position] > '9') throw new ArgumentException("Invalid owned-job JSON number");
            while (position < text.Length && text[position] >= '0' && text[position] <= '9') position++;
        }
        foreach (char marker in new char[] { '.', 'e' }) {
            if (position < text.Length && (text[position] == marker || (marker == 'e' && text[position] == 'E'))) {
                position++;
                if (marker == 'e' && position < text.Length && (text[position] == '+' || text[position] == '-')) position++;
                int digits = position;
                while (position < text.Length && text[position] >= '0' && text[position] <= '9') position++;
                if (position == digits) throw new ArgumentException("Invalid owned-job JSON number");
            }
        }
        string number = text.Substring(start, position - start);
        int integer;
        if (Int32.TryParse(number, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out integer)) return integer;
        return Double.Parse(number, NumberStyles.Float, CultureInfo.InvariantCulture);
    }
    public static Dictionary<string, object> Parse(string text) {
        if (text == null || text.Length > 1048576) throw new ArgumentException("Owned-job JSON is too large");
        RelAiJobJson parser = new RelAiJobJson(text);
        Dictionary<string, object> result = parser.Value(0) as Dictionary<string, object>;
        parser.Space();
        if (result == null || parser.position != text.Length) throw new ArgumentException("Expected one owned-job JSON object");
        return result;
    }
}

public sealed class RelAiOwnedJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd,
        ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);

    delegate bool ControlHandlerRoutine(uint kind);
    static readonly ControlHandlerRoutine ControlHandler = delegate(uint kind) { return kind == 0 || kind == 1; };
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetConsoleCtrlHandler(ControlHandlerRoutine handler, bool add);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetConsoleMode(IntPtr console, out uint mode);
    bool controlHandlerInstalled;
    IntPtr job, process;
    public uint RootPid { get; private set; }
    public string RootCreationIdentity { get; private set; }
    public bool Assigned { get; private set; }
    public bool CommandStarted { get; private set; }
    static void Check(bool result, string operation) {
        if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    public RelAiOwnedJob() {
        job = CreateJobObjectW(IntPtr.Zero, null); // Unnamed and non-inheritable.
        Check(job != IntPtr.Zero, "CreateJobObjectW");
        try {
            uint mode;
            if (GetConsoleMode(GetStdHandle(-10), out mode)) {
                // A non-null handler is controller-local; the target retains normal Ctrl+C behavior.
                Check(SetConsoleCtrlHandler(ControlHandler, true), "SetConsoleCtrlHandler");
                controlHandlerInstalled = true;
            }
            EXTENDED_LIMIT limits = new EXTENDED_LIMIT();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE only; no breakaway.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<EXTENDED_LIMIT>()),
                "SetInformationJobObject");
        } catch { CloseHandle(job); job = IntPtr.Zero; throw; }
    }
    // Quote one literal argument using Windows CRT/CommandLineToArgvW-compatible rules.
    public static string Quote(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid argument");
        // Match libuv's fast path: cmd.exe interprets unnecessarily quoted switches differently.
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    public void Start(string executable, string[] args, string cwd, string rawCommandLine, string argv0, bool windowsVerbatimArguments, string[] environmentEntries) {
        // Match Node's UTF-8 conversion before Windows process creation. Passing
        // lone surrogates to the OS environment yields invalid UTF-8 in targets.
        UTF8Encoding encoding = new UTF8Encoding(false);
        executable = encoding.GetString(encoding.GetBytes(executable));
        cwd = encoding.GetString(encoding.GetBytes(cwd));
        if (rawCommandLine != null) rawCommandLine = encoding.GetString(encoding.GetBytes(rawCommandLine));
        if (argv0 != null) argv0 = encoding.GetString(encoding.GetBytes(argv0));
        for (int i = 0; i < args.Length; i++) args[i] = encoding.GetString(encoding.GetBytes(args[i]));
        for (int i = 0; i < environmentEntries.Length; i++) environmentEntries[i] = encoding.GetString(encoding.GetBytes(environmentEntries[i]));
        StringBuilder command = new StringBuilder();
        if (!String.IsNullOrEmpty(rawCommandLine)) command.Append(rawCommandLine);
        else {
            command.Append(Quote(String.IsNullOrEmpty(argv0) ? executable : argv0));
            foreach (string arg in args) command.Append(" ").Append(windowsVerbatimArguments ? arg : Quote(arg));
        }
        if (command.Length == 0 || command.Length >= 32767 || command.ToString().IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid Windows command line");
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = (uint)Marshal.SizeOf<STARTUPINFOEX>();
        startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES.
        IntPtr[] std = new IntPtr[3];
        IntPtr handleList = IntPtr.Zero, jobList = IntPtr.Zero, attributes = IntPtr.Zero, thread = IntPtr.Zero;
        bool attributesReady = false;
        string environmentBlock = String.Join("\0", environmentEntries) + "\0\0";
        if (environmentBlock.Length > 32767) throw new ArgumentException("Target environment is too large");
        IntPtr environment = Marshal.StringToHGlobalUni(environmentBlock);
        try {
            for (int i = 0; i < 3; i++) {
                IntPtr source = GetStdHandle(-10 - i);
                if (source == IntPtr.Zero || source == new IntPtr(-1))
                    throw new InvalidOperationException("Valid standard handles are required");
                Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out std[i],
                    0, true, 2), "DuplicateHandle(stdio)");
            }
            startup.StartupInfo.hStdInput = std[0]; startup.StartupInfo.hStdOutput = std[1];
            startup.StartupInfo.hStdError = std[2];
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Attribute list size");
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList");
            attributesReady = true;
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.Copy(std, 0, handleList, 3);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002),
                handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handles)");
            // Windows 10 / Server 2016 minimum, also required by the supported Node runtime.
            // Assign during creation so controller death cannot orphan an unowned suspended root.
            // Unsupported/restricted setup fails here or in CreateProcess; no racy fallback.
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D),
                jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(job list)");
            startup.lpAttributeList = attributes;
            PROCESS_INFORMATION created;
            // Do not request CREATE_BREAKAWAY_FROM_JOB or bypass existing parent-job restrictions.
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00000004 | 0x00080000 | 0x00000400, environment, cwd, ref startup, out created),
                "CreateProcessW(suspended, owned job)");
            process = created.hProcess; thread = created.hThread; RootPid = created.dwProcessId;
            FILETIME creation, exitTime, kernel, user;
            if (GetProcessTimes(process, out creation, out exitTime, out kernel, out user)) {
                try {
                    long fileTime = (long)(((ulong)creation.High << 32) | creation.Low);
                    RootCreationIdentity = "win32:" + DateTime.FromFileTimeUtc(fileTime).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                } catch (ArgumentOutOfRangeException) { /* Optional diagnostics do not weaken containment. */ }
            }
            bool inJob;
            Check(IsProcessInJob(process, job, out inJob), "IsProcessInJob");
            if (!inJob) throw new InvalidOperationException("Created process is not in its owned job");
            Assigned = true;
            uint prior = ResumeThread(thread);
            if (prior == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
            CommandStarted = true;
            if (prior != 1) throw new InvalidOperationException("Unexpected suspended thread state");
        } finally {
            Marshal.FreeHGlobal(environment);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            foreach (IntPtr handle in std) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    public uint ActiveProcesses() {
        ACCOUNTING info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf<ACCOUNTING>(), IntPtr.Zero),
            "QueryInformationJobObject");
        return info.ActiveProcesses;
    }
    public bool RootExited() {
        if (process == IntPtr.Zero) return false;
        uint result = WaitForSingleObject(process, 0);
        if (result == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
        return result == 0;
    }
    public void WaitForChange(int milliseconds) {
        if (process != IntPtr.Zero && !RootExited()) WaitForSingleObject(process, (uint)milliseconds);
        else System.Threading.Thread.Sleep(milliseconds);
    }
    public uint RootExitCode() {
        uint code;
        Check(GetExitCodeProcess(process, out code), "GetExitCodeProcess");
        return code;
    }
    public void Stop() {
        Check(TerminateJobObject(job, 125), "TerminateJobObject");
        // If membership verification fails, only this verified, still-suspended
        // created process handle is eligible for defensive fallback termination.
        if (process != IntPtr.Zero && !Assigned && !RootExited())
            Check(TerminateProcess(process, 125), "TerminateProcess(unstarted target)");
    }
    public void Dispose() {
        // Closing the exclusive job handle also handles an abnormal controller exit.
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        if (controlHandlerInstalled) { SetConsoleCtrlHandler(ControlHandler, false); controlHandlerInstalled = false; }
    }
}
'@
# BEGIN VERIFIED NATIVE ASSEMBLY
# Generated only from the C# above: node scripts/generate-windows-process-job-native.mjs --write
# The trusted script pins both hashes; runtime never trusts external cache metadata.
$nativeSourceSha256 = 'ad295fe82418ccd37418a8df6485e3983fe0132d87b90b41c78ec52a049b3d40'
$nativeAssemblySha256 = '589fa6215f636917fb908500d69d3c44f17c0142dffbc54245879ba8ee4ae346'
$nativeAssemblyBase64 = @'
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
gACRIHICpAAuAAAAAACAAJEgjAKvADUAAAAAAIAAkSDEArQANgAAAAAAgACRIOICywBAAAAAAACAAJEg+AJ1AEIA7ycAAAAAhggrA9gARAD3JwAAAACBCDcD
3ABEAAAoAAAAAIYIQwMiAEUACCgAAAAAgQhcAxAARQARKAAAAACGCHUD4QBGABkoAAAAAIEIggPlAEYAIigAAAAAhgiPA+EARwAqKAAAAACBCKID5QBHADMo
AAAAAJEAtQPqAEgARCgAAAAAhhgDARUASgAgKQAAAACWALsD8ABKAPApAAAAAIYAwQP1AEsAVC8AAAAAhgDHA9gAUgCMLwAAAACGANcD4QBSANIvAAAAAIYA
4gMCAVIABDAAAAAAhgDwA9gAUwAsMAAAAACGAP0DFQBTAIwwAAAAAOYBAgQVAFMAETEAAAAAkRi5DdwCUwAGMQAAAACRAMAN4AJTAAAAAAADAIYYAwEuAVQA
AAAAAAMAxgG3BzQBVgAAAAAAAwDGAdkHOQFXAAAAAAADAMYB5QdCAVoAAAABAO8HAAABAO8HAAABAPUHAAABAPUAAAABAPsHAAACAAQIAAABAB8DAAACAAkI
AAADAA4IAAAEABMIAAABAB8DAAACAAkIAgADAA4IAAAEABMIAAAFAEQIAAABACMDAAACAB8DAgADAE0IAAABAB8DAAACAFQIAAABACMDAAACAFQIAAABAFkI
AAACAGAIAAABACMDAgACAG0IAgADAHYIAgAEAHsIAgAFAIIIAAABACMDAgACAFQIAAABAIcIAAABAFkIAAABAAkIAAABAI4IAAACAJwIAAADAKMIAgAEALEI
AAAFALgIAAAGAL8IAAAHAMcIAAABAM8IAAACANQIAAADANoIAAAEABMIAAABAM8IAAACANoIAAADAOAIAAAEAO8HAAAFABMIAAAGAOoIAAAHAEQIAAABAM8I
AAABAPMIAAACAP8IAAADAAcJAAAEABcJAAAFAL8IAAAGANoIAAAHACYJAAAIADIJAAAJADYJAgAKACMDAAABAD4JAAACAEYJAAABAEoJAgACAFIJAAABAO8H
AAABAO8HAAABAO8HAAABAO8HAAABAE0IAAACAFcJAAABAO8HAAABAGEJAAACAGwJAAADADIJAAAEAHEJAAAFAIAJAAAGAIYJAAAHAJ8JAAABAGAIAAABAAkI
AAABALIJAAACALkJAAABAAkIAAABAAkIAAACAMAJAAADALIJAAABAE0IAwAJAEkAAwEVAFEAAwECAVkAAwEVAAkAAwEVAGEALgpIAWEAOQpMAWEAQwpRAWkA
AwEQADEAAwEVAAkAXQoiADEAZgpaAXEAfAprAQwAAwF3ARQAAwEVABQAowqHAQwAqwqNAQwAtwqTARQAuwpIARQAtwqbAWEAxQqhAWEA1AqqAWEA7QqwAZkA
GAu2AaEAUAu7AbkAVQHGAcEAAwEQAMkAAwEVANEAowsDAtkAAwEHAuEA4QvVAOEA5gsNAtEA9AsTAukAmAwnAmEAqAwvAjEAAwEQADEAZgo1AgEBAwHlAAkB
yQxFAgkB0gxLAmEA3AxRAjEAZgpWAjEALgpIAWEA6gxhAmEA7wxoAtEA9gxuAuEA1AoNAuEAAwECAREBAwEQANEAIw1zAuEAMA0DAtEAIw2KANEAOQ14AtEA
Pg2BAhkBUw2HAhkBYw2OAiEBXQqSAtEAcw2vADEBsw3XAjkBAwHlAi4AGwD1Ai4AEwDsAuEA2wD+AQEB2wD+ASEB2wD+AUEB2wD+AWEB2wD+AaMB2wD+AYAD
2wD+AaAD2wD+AcAD2wD+AeAD2wD+AQAE2wD+ASAE2wD+AUAE2wD+AWAE2wD+AeAF2wD+AQEABgAAAA4AVgFgAc8B8wEdAjwCmALOAtMCAwABAAAAgwQKAQAA
iwQOAQAAoAQSAQAAqQQSAQIAHAADAAEAHQADAAEAHwAFAAIAHgAFAAEAIQAHAAIAIAAHAAIAIgAJAAEAIwAJAHMLcAGBAUQBEQBbAQEAQAETAGwBAQBAARUA
hAEBAEABFwCeAQEAQAEZAK0BAQBAARsAwAEBAEABHQDRAQEAQAEfAOUBAQBAASEA9QEBAEABIwAIAgEAQAElABUCAQAAAScAIQIBAEABKQAzAgEAQAErAEAC
AQBAAS0AUAIBAEABLwByAgEAAAExAIwCAQBEATMAxAIBAEABNQDiAgEAQAE3APgCAQAYKQAAQwAEgAAAAAAAAAAAAAAAAAAAAAApAAAABAAAAAAAAAAAAAAA
AQC2AAAAAAAEAAAAAAAAAAAAAAABAL8AAAAAAAQAAwAFAAMABgADAAcAAwAIAAMACQADAAoAAwALAAMADAADAA4ADQBBABgCQQBcAkEAyQIAAAA8TW9kdWxl
PgBSZWxBaU93bmVkSm9iLmRsbABSZWxBaUpvYkpzb24AUmVsQWlPd25lZEpvYgBCQVNJQ19MSU1JVABJT19DT1VOVEVSUwBFWFRFTkRFRF9MSU1JVABBQ0NP
VU5USU5HAFNUQVJUVVBJTkZPAFNUQVJUVVBJTkZPRVgAUFJPQ0VTU19JTkZPUk1BVElPTgBGSUxFVElNRQBDb250cm9sSGFuZGxlclJvdXRpbmUAbXNjb3Js
aWIAU3lzdGVtAE9iamVjdABJRGlzcG9zYWJsZQBWYWx1ZVR5cGUATXVsdGljYXN0RGVsZWdhdGUAdGV4dABwb3NpdGlvbgAuY3RvcgBTcGFjZQBUYWtlAEV4
cGVjdABTdHJpbmdWYWx1ZQBWYWx1ZQBTeXN0ZW0uQ29sbGVjdGlvbnMuR2VuZXJpYwBEaWN0aW9uYXJ5YDIAUGFyc2UAQ3JlYXRlSm9iT2JqZWN0VwBTZXRJ
bmZvcm1hdGlvbkpvYk9iamVjdABRdWVyeUluZm9ybWF0aW9uSm9iT2JqZWN0AElzUHJvY2Vzc0luSm9iAFRlcm1pbmF0ZUpvYk9iamVjdABUZXJtaW5hdGVQ
cm9jZXNzAFdhaXRGb3JTaW5nbGVPYmplY3QAR2V0UHJvY2Vzc1RpbWVzAEdldEV4aXRDb2RlUHJvY2VzcwBSZXN1bWVUaHJlYWQAQ2xvc2VIYW5kbGUAR2V0
Q3VycmVudFByb2Nlc3MAR2V0U3RkSGFuZGxlAER1cGxpY2F0ZUhhbmRsZQBJbml0aWFsaXplUHJvY1RocmVhZEF0dHJpYnV0ZUxpc3QAVXBkYXRlUHJvY1Ro
cmVhZEF0dHJpYnV0ZQBEZWxldGVQcm9jVGhyZWFkQXR0cmlidXRlTGlzdABTeXN0ZW0uVGV4dABTdHJpbmdCdWlsZGVyAENyZWF0ZVByb2Nlc3NXAENvbnRy
b2xIYW5kbGVyAFNldENvbnNvbGVDdHJsSGFuZGxlcgBHZXRDb25zb2xlTW9kZQBjb250cm9sSGFuZGxlckluc3RhbGxlZABqb2IAcHJvY2VzcwBnZXRfUm9v
dFBpZABzZXRfUm9vdFBpZABnZXRfUm9vdENyZWF0aW9uSWRlbnRpdHkAc2V0X1Jvb3RDcmVhdGlvbklkZW50aXR5AGdldF9Bc3NpZ25lZABzZXRfQXNzaWdu
ZWQAZ2V0X0NvbW1hbmRTdGFydGVkAHNldF9Db21tYW5kU3RhcnRlZABDaGVjawBRdW90ZQBTdGFydABBY3RpdmVQcm9jZXNzZXMAUm9vdEV4aXRlZABXYWl0
Rm9yQ2hhbmdlAFJvb3RFeGl0Q29kZQBTdG9wAERpc3Bvc2UAPFJvb3RQaWQ+a19fQmFja2luZ0ZpZWxkADxSb290Q3JlYXRpb25JZGVudGl0eT5rX19CYWNr
aW5nRmllbGQAPEFzc2lnbmVkPmtfX0JhY2tpbmdGaWVsZAA8Q29tbWFuZFN0YXJ0ZWQ+a19fQmFja2luZ0ZpZWxkAFJvb3RQaWQAUm9vdENyZWF0aW9uSWRl
bnRpdHkAQXNzaWduZWQAQ29tbWFuZFN0YXJ0ZWQAUGVyUHJvY2Vzc1VzZXJUaW1lTGltaXQAUGVySm9iVXNlclRpbWVMaW1pdABMaW1pdEZsYWdzAE1pbmlt
dW1Xb3JraW5nU2V0U2l6ZQBNYXhpbXVtV29ya2luZ1NldFNpemUAQWN0aXZlUHJvY2Vzc0xpbWl0AEFmZmluaXR5AFByaW9yaXR5Q2xhc3MAU2NoZWR1bGlu
Z0NsYXNzAFJlYWRPcGVyYXRpb25Db3VudABXcml0ZU9wZXJhdGlvbkNvdW50AE90aGVyT3BlcmF0aW9uQ291bnQAUmVhZFRyYW5zZmVyQ291bnQAV3JpdGVU
cmFuc2ZlckNvdW50AE90aGVyVHJhbnNmZXJDb3VudABCYXNpY0xpbWl0SW5mb3JtYXRpb24ASW9JbmZvAFByb2Nlc3NNZW1vcnlMaW1pdABKb2JNZW1vcnlM
aW1pdABQZWFrUHJvY2Vzc01lbW9yeVVzZWQAUGVha0pvYk1lbW9yeVVzZWQAVG90YWxVc2VyVGltZQBUb3RhbEtlcm5lbFRpbWUAVGhpc1BlcmlvZFRvdGFs
VXNlclRpbWUAVGhpc1BlcmlvZFRvdGFsS2VybmVsVGltZQBUb3RhbFBhZ2VGYXVsdENvdW50AFRvdGFsUHJvY2Vzc2VzAFRvdGFsVGVybWluYXRlZFByb2Nl
c3NlcwBjYgBscFJlc2VydmVkAGxwRGVza3RvcABscFRpdGxlAGR3WABkd1kAZHdYU2l6ZQBkd1lTaXplAGR3WENvdW50Q2hhcnMAZHdZQ291bnRDaGFycwBk
d0ZpbGxBdHRyaWJ1dGUAZHdGbGFncwB3U2hvd1dpbmRvdwBjYlJlc2VydmVkMgBscFJlc2VydmVkMgBoU3RkSW5wdXQAaFN0ZE91dHB1dABoU3RkRXJyb3IA
U3RhcnR1cEluZm8AbHBBdHRyaWJ1dGVMaXN0AGhQcm9jZXNzAGhUaHJlYWQAZHdQcm9jZXNzSWQAZHdUaHJlYWRJZABMb3cASGlnaABJbnZva2UASUFzeW5j
UmVzdWx0AEFzeW5jQ2FsbGJhY2sAQmVnaW5JbnZva2UARW5kSW52b2tlAHZhbHVlAGRlcHRoAHNlY3VyaXR5AG5hbWUAa2luZABpbmZvAHNpemUAU3lzdGVt
LlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzAE91dEF0dHJpYnV0ZQByZXR1cm5lZAByZXN1bHQAY29kZQBoYW5kbGUAbWlsbGlzZWNvbmRzAGNyZWF0aW9uAGV4
aXQAa2VybmVsAHVzZXIAdGhyZWFkAHNvdXJjZVByb2Nlc3MAc291cmNlAHRhcmdldFByb2Nlc3MAdGFyZ2V0AGFjY2VzcwBpbmhlcml0AG9wdGlvbnMAbGlz
dABjb3VudABmbGFncwBhdHRyaWJ1dGUAcHJldmlvdXMAYXBwbGljYXRpb24AY29tbWFuZABwcm9jZXNzU2VjdXJpdHkAdGhyZWFkU2VjdXJpdHkAZW52aXJv
bm1lbnQAY3dkAHN0YXJ0dXAAaGFuZGxlcgBhZGQAY29uc29sZQBtb2RlAG9wZXJhdGlvbgBleGVjdXRhYmxlAGFyZ3MAcmF3Q29tbWFuZExpbmUAYXJndjAA
d2luZG93c1ZlcmJhdGltQXJndW1lbnRzAGVudmlyb25tZW50RW50cmllcwBvYmplY3QAbWV0aG9kAGNhbGxiYWNrAFN5c3RlbS5SdW50aW1lLkNvbXBpbGVy
U2VydmljZXMAQ29tcGlsYXRpb25SZWxheGF0aW9uc0F0dHJpYnV0ZQBSdW50aW1lQ29tcGF0aWJpbGl0eUF0dHJpYnV0ZQBTdHJpbmcAZ2V0X0xlbmd0aABn
ZXRfQ2hhcnMASW5kZXhPZgBBcmd1bWVudEV4Y2VwdGlvbgBUb1N0cmluZwBBcHBlbmQAU3RyaW5nQ29tcGFyZXIAZ2V0X09yZGluYWwASUVxdWFsaXR5Q29t
cGFyZXJgMQBMaXN0YDEAVG9BcnJheQBDb250YWluc0tleQBBZGQAZ2V0X0NvdW50AENvbXBhcmVPcmRpbmFsAG9wX0VxdWFsaXR5AEJvb2xlYW4AQ2hhcgBT
dWJzdHJpbmcAU3lzdGVtLkdsb2JhbGl6YXRpb24AQ3VsdHVyZUluZm8AZ2V0X0ludmFyaWFudEN1bHR1cmUASW50MzIATnVtYmVyU3R5bGVzAElGb3JtYXRQ
cm92aWRlcgBUcnlQYXJzZQBEb3VibGUARGxsSW1wb3J0QXR0cmlidXRlAGtlcm5lbDMyLmRsbABDb21waWxlckdlbmVyYXRlZEF0dHJpYnV0ZQBNYXJzaGFs
AEdldExhc3RXaW4zMkVycm9yAFN5c3RlbS5Db21wb25lbnRNb2RlbABXaW4zMkV4Y2VwdGlvbgBJbnRQdHIAWmVybwBvcF9JbmVxdWFsaXR5AFNpemVPZgA8
UHJpdmF0ZUltcGxlbWVudGF0aW9uRGV0YWlscz57QTI0ODI4OTItRUUxOS00RUVGLThGNzEtMEFDQ0M1REVCQzBEfQBfX1N0YXRpY0FycmF5SW5pdFR5cGVT
aXplPTYAJCRtZXRob2QweDYwMDAwMjYtMQBSdW50aW1lSGVscGVycwBBcnJheQBSdW50aW1lRmllbGRIYW5kbGUASW5pdGlhbGl6ZUFycmF5AEluZGV4T2ZB
bnkAVVRGOEVuY29kaW5nAEVuY29kaW5nAEdldEJ5dGVzAEdldFN0cmluZwBJc051bGxPckVtcHR5AEpvaW4AQ29uY2F0AFN0cmluZ1RvSEdsb2JhbFVuaQBJ
bnZhbGlkT3BlcmF0aW9uRXhjZXB0aW9uAEFsbG9jSEdsb2JhbABnZXRfU2l6ZQBDb3B5AFdyaXRlSW50UHRyAERhdGVUaW1lAEZyb21GaWxlVGltZVV0YwBn
ZXRfVGlja3MASW50NjQARnJlZUhHbG9iYWwAQXJndW1lbnRPdXRPZlJhbmdlRXhjZXB0aW9uAFN5c3RlbS5UaHJlYWRpbmcAVGhyZWFkAFNsZWVwAC5jY3Rv
cgA8LmNjdG9yPmJfXzAAQ1MkPD45X19DYWNoZWRBbm9ueW1vdXNNZXRob2REZWxlZ2F0ZTEAU3RydWN0TGF5b3V0QXR0cmlidXRlAExheW91dEtpbmQAAAAA
AAkgAAkADQAKAAAxVAByAHUAbgBjAGEAdABlAGQAIABvAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AATlJAG4AdgBhAGwAaQBkACAAbwB3AG4AZQBkAC0A
agBvAGIAIABKAFMATwBOACAAdABvAGsAZQBuAAE7SQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAHMAdAByAGkAbgBnAAE7
SQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAGUAcwBjAGEAcABlAAE1TwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAA
aQBzACAAdABvAG8AIABkAGUAZQBwAAE/RAB1AHAAbABpAGMAYQB0AGUAIABvAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABtAGUAbQBiAGUAcgABQ08A
dwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAGEAcgByAGEAeQAgAGkAcwAgAHQAbwBvACAAbABhAHIAZwBlAAFBSQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUA
ZAAtAGoAbwBiACAASgBTAE8ATgAgAHMAZQBwAGEAcgBhAHQAbwByAAEJdAByAHUAZQAAC2YAYQBsAHMAZQAACW4AdQBsAGwAADtJAG4AdgBhAGwAaQBkACAA
bwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAbgB1AG0AYgBlAHIAATdPAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABpAHMAIAB0AG8AbwAgAGwA
YQByAGcAZQABRUUAeABwAGUAYwB0AGUAZAAgAG8AbgBlACAAbwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAbwBiAGoAZQBjAHQAASFDAHIAZQBhAHQA
ZQBKAG8AYgBPAGIAagBlAGMAdABXAAArUwBlAHQAQwBvAG4AcwBvAGwAZQBDAHQAcgBsAEgAYQBuAGQAbABlAHIAAC9TAGUAdABJAG4AZgBvAHIAbQBhAHQA
aQBvAG4ASgBvAGIATwBiAGoAZQBjAHQAACFJAG4AdgBhAGwAaQBkACAAYQByAGcAdQBtAGUAbgB0AAADIgAAAyAAADlJAG4AdgBhAGwAaQBkACAAVwBpAG4A
ZABvAHcAcwAgAGMAbwBtAG0AYQBuAGQAIABsAGkAbgBlAAADAAABBQAAAAABP1QAYQByAGcAZQB0ACAAZQBuAHYAaQByAG8AbgBtAGUAbgB0ACAAaQBzACAA
dABvAG8AIABsAGEAcgBnAGUAAEdWAGEAbABpAGQAIABzAHQAYQBuAGQAYQByAGQAIABoAGEAbgBkAGwAZQBzACAAYQByAGUAIAByAGUAcQB1AGkAcgBlAGQA
AC1EAHUAcABsAGkAYwBhAHQAZQBIAGEAbgBkAGwAZQAoAHMAdABkAGkAbwApAAAnQQB0AHQAcgBpAGIAdQB0AGUAIABsAGkAcwB0ACAAcwBpAHoAZQAAQ0kA
bgBpAHQAaQBhAGwAaQB6AGUAUAByAG8AYwBUAGgAcgBlAGEAZABBAHQAdAByAGkAYgB1AHQAZQBMAGkAcwB0AABFVQBwAGQAYQB0AGUAUAByAG8AYwBUAGgA
cgBlAGEAZABBAHQAdAByAGkAYgB1AHQAZQAoAGgAYQBuAGQAbABlAHMAKQAAR1UAcABkAGEAdABlAFAAcgBvAGMAVABoAHIAZQBhAGQAQQB0AHQAcgBpAGIA
dQB0AGUAKABqAG8AYgAgAGwAaQBzAHQAKQAASUMAcgBlAGEAdABlAFAAcgBvAGMAZQBzAHMAVwAoAHMAdQBzAHAAZQBuAGQAZQBkACwAIABvAHcAbgBlAGQA
IABqAG8AYgApAAANdwBpAG4AMwAyADoAAB1JAHMAUAByAG8AYwBlAHMAcwBJAG4ASgBvAGIAAE9DAHIAZQBhAHQAZQBkACAAcAByAG8AYwBlAHMAcwAgAGkA
cwAgAG4AbwB0ACAAaQBuACAAaQB0AHMAIABvAHcAbgBlAGQAIABqAG8AYgAAGVIAZQBzAHUAbQBlAFQAaAByAGUAYQBkAABDVQBuAGUAeABwAGUAYwB0AGUA
ZAAgAHMAdQBzAHAAZQBuAGQAZQBkACAAdABoAHIAZQBhAGQAIABzAHQAYQB0AGUAADNRAHUAZQByAHkASQBuAGYAbwByAG0AYQB0AGkAbwBuAEoAbwBiAE8A
YgBqAGUAYwB0AAAnVwBhAGkAdABGAG8AcgBTAGkAbgBnAGwAZQBPAGIAagBlAGMAdAAAJUcAZQB0AEUAeABpAHQAQwBvAGQAZQBQAHIAbwBjAGUAcwBzAAAl
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
SgBvAGIALgBkAGwAbAAAACgAAgABAEwAZQBnAGEAbABDAG8AcAB5AHIAaQBnAGgAdAAAACAAAABMABIAAQBPAHIAaQBnAGkAbgBhAGwARgBpAGwAZQBuAGEA
bQBlAAAAUgBlAGwAQQBpAE8AdwBuAGUAZABKAG8AYgAuAGQAbABsAAAANAAIAAEAUAByAG8AZAB1AGMAdABWAGUAcgBzAGkAbwBuAAAAMAAuADAALgAwAC4A
MAAAADgACAABAEEAcwBzAGUAbQBiAGwAeQAgAFYAZQByAHMAaQBvAG4AAAAwAC4AMAAuADAALgAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAADAAAAKA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAA==
'@
# END VERIFIED NATIVE ASSEMBLY

function Initialize-NativeType {
    # This is shipped acceleration data, never a writable runtime cache. Verify the
    # current source as well as the exact in-memory bytes which Assembly.Load uses.
    # Editing the C# invalidates acceleration automatically, including private tests.
    $sha = $null
    $assembly = $null
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        $sourceBytes = [Text.Encoding]::UTF8.GetBytes($native.Replace("`r`n", "`n"))
        $sourceDigest = ([BitConverter]::ToString($sha.ComputeHash($sourceBytes))).Replace('-', '').ToLowerInvariant()
        if ($sourceDigest -ceq $nativeSourceSha256 -and $nativeAssemblyBase64.Length -le 262144) {
            $assemblyBytes = [Convert]::FromBase64String($nativeAssemblyBase64)
            $assemblyDigest = ([BitConverter]::ToString($sha.ComputeHash($assemblyBytes))).Replace('-', '').ToLowerInvariant()
            if ($assemblyDigest -ceq $nativeAssemblySha256) {
                $assembly = [Reflection.Assembly]::Load($assemblyBytes)
                # Type/API validation is below, outside the compilation fallback catch.
            }
        }
    } catch {
        # Unsupported runtime, absent/stale/malformed/tampered data falls back only
        # to compilation of trusted source. No unverified native bytes are loaded.
    } finally {
        if ($null -ne $sha) { $sha.Dispose() }
    }
    if ($null -ne $assembly) {
        # A successfully loaded assembly with an invalid API fails before target
        # startup rather than attempting a second, ambiguously named type load.
        return @{ Type = $assembly.GetType('RelAiOwnedJob', $true, $false); Mode = 'precompiled' }
    }
    Add-Type -TypeDefinition $native -Language CSharp -ErrorAction Stop
    return @{ Type = [RelAiOwnedJob]; Mode = 'compiled' }
}
$owner = $null
$receipt = $null
$exitCode = 125
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Receipt {
    $receipt.sequence++
    $receipt.updatedAt = [DateTime]::UtcNow.ToString('o')
    $temporary = $ReceiptPath + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Compress -Depth 4), $utf8)
    if ([IO.File]::Exists($ReceiptPath)) {
        [IO.File]::Replace($temporary, $ReceiptPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
        [IO.File]::Move($temporary, $ReceiptPath)
    }
}
function Update-Facts {
    $receipt.commandStarted = $owner.CommandStarted
    $receipt.rootPid = $owner.RootPid
    $receipt.rootCreationIdentity = $owner.RootCreationIdentity
    $receipt.activeProcesses = $owner.ActiveProcesses()
    $receipt.rootExited = $owner.RootExited()
    if ($receipt.rootExited) { $receipt.rootExitCode = $owner.RootExitCode() }
}
try {
    $nativeImplementation = Initialize-NativeType
    $jsonType = $nativeImplementation.Type.Assembly.GetType('RelAiJobJson', $true)
    $jsonParse = $jsonType.GetMethod('Parse')
    $request = $jsonParse.Invoke($null, @([IO.File]::ReadAllText($RequestPath, $utf8)))
    if ($request.protocol -ne 1 -or $request.nonce -isnot [string] -or $request.nonce -notmatch '^[a-fA-F0-9]{32,128}$') {
        throw 'Invalid owned-job protocol or nonce'
    }
    $receipt = [ordered]@{
        protocol = 1; nonce = $request.nonce; helperPid = $PID; sequence = 0
        rootPid = $null; rootCreationIdentity = $null; rootExitCode = $null; rootExited = $false; activeProcesses = $null
        commandStarted = $false; startupFailedBeforeCommand = $false
        jobComplete = $false; cleanupConfirmed = $false; final = $false
        stopReason = $null; error = $null; updatedAt = $null
    }
    if ($request.executable -isnot [string] -or -not [IO.Path]::IsPathRooted($request.executable) -or
        $request.executable.IndexOf([char]0) -ge 0 -or -not [IO.File]::Exists($request.executable)) {
        throw 'An existing absolute native executable is required'
    }
    if ($request.cwd -isnot [string] -or -not [IO.Path]::IsPathRooted($request.cwd) -or -not [IO.Directory]::Exists($request.cwd)) {
        throw 'An existing absolute working directory is required'
    }
    if ($null -eq $request.args -or $request.args -isnot [System.Array]) { throw 'args must be an array of strings' }
    foreach ($argument in $request.args) { if ($argument -isnot [string]) { throw 'args must contain only strings' } }
    $rawCommandLine = $null
    if ($null -ne $request.rawCommandLine) {
        if ($request.rawCommandLine -isnot [string] -or
            -not [string]::Equals([IO.Path]::GetFileName($request.executable), 'cmd.exe', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'rawCommandLine is restricted to the prepared cmd.exe shell path'
        }
        $rawCommandLine = $request.rawCommandLine
    }
    $receipt.nativeImplementation = $nativeImplementation.Mode
    $owner = [Activator]::CreateInstance($nativeImplementation.Type)
    Write-Receipt # Verify the private metadata destination before any user code can run.
    if ([IO.File]::Exists($ControlPath)) {
        $control = $jsonParse.Invoke($null, @([IO.File]::ReadAllText($ControlPath, $utf8)))
        if ($control.protocol -ne 1 -or $control.nonce -cne $request.nonce -or $control.action -ne 'stop') {
            throw 'Invalid owned-job control request'
        }
        $receipt.stopReason = if ($control.reason -in @('cancel', 'timeout', 'stop')) { $control.reason } else { 'stop' }
        throw 'Owned job stopped before command startup'
    }
    # The controller starts with its own trusted environment. Target values cross only
    # this bounded private in-memory channel and never initialize the PowerShell host.
    $transportKey = 'REL_AI_JOB_ENV_' + $request.nonce
    if ($request.environmentTransportKey -cne $transportKey) { throw 'Invalid private environment transport key' }
    $transportJson = [Environment]::GetEnvironmentVariable($transportKey, 'Process')
    if ([string]::IsNullOrEmpty($transportJson) -or $transportJson.Length -gt 24000) {
        throw 'Missing or oversized private target environment payload'
    }
    [Environment]::SetEnvironmentVariable($transportKey, $null, 'Process')
    try { $transport = $jsonParse.Invoke($null, @($transportJson)) }
    catch { throw 'Invalid private target environment payload' }
    if ($transport.protocol -ne 1 -or $transport.nonce -cne $request.nonce -or $transport.entries -isnot [System.Array]) {
        throw 'Invalid private target environment payload'
    }
    $environmentEntries = New-Object 'System.Collections.Generic.List[string]'
    $seenEnvironmentKeys = @{}
    foreach ($entry in $transport.entries) {
        if ($entry -isnot [System.Array] -or $entry.Length -ne 2 -or $entry[0] -isnot [string] -or $entry[1] -isnot [string] -or
            $entry[0].Length -eq 0 -or $entry[0].IndexOf('=') -ge 0 -or $entry[0].IndexOf([char]0) -ge 0 -or
            $entry[1].IndexOf([char]0) -ge 0 -or $seenEnvironmentKeys.ContainsKey($entry[0])) {
            throw 'Invalid or duplicate target environment entry'
        }
        $seenEnvironmentKeys[$entry[0]] = $true
        $environmentEntries.Add($entry[0] + '=' + $entry[1])
    }
    $environmentEntries.Sort([StringComparer]::OrdinalIgnoreCase)
    $argv0 = $request.argv0
    if ($null -ne $argv0 -and $argv0 -isnot [string]) { throw 'argv0 must be a string' }
    if ($null -ne $request.windowsVerbatimArguments -and $request.windowsVerbatimArguments -isnot [bool]) {
        throw 'windowsVerbatimArguments must be a boolean'
    }
    $owner.Start($request.executable, [string[]]$request.args, $request.cwd, $rawCommandLine, [string]$argv0, [bool]$request.windowsVerbatimArguments, $environmentEntries.ToArray())
    Update-Facts
    Write-Receipt
    $lastRootExited = $receipt.rootExited
    $lastActive = $receipt.activeProcesses
    $stopDeadline = $null
    while ($true) {
        Update-Facts
        if ($receipt.activeProcesses -eq 0 -and $receipt.rootExited) {
            $receipt.jobComplete = $true; $receipt.cleanupConfirmed = $true; $receipt.final = $true
            Write-Receipt
            $exitCode = [int][Math]::Min([double]$receipt.rootExitCode, 2147483647)
            break
        }
        if ($null -eq $receipt.stopReason -and [IO.File]::Exists($ControlPath)) {
            $control = $jsonParse.Invoke($null, @([IO.File]::ReadAllText($ControlPath, $utf8)))
            if ($control.protocol -ne 1 -or $control.nonce -cne $request.nonce -or $control.action -ne 'stop') {
                throw 'Invalid owned-job control request'
            }
            $receipt.stopReason = if ($control.reason -in @('cancel', 'timeout', 'stop')) { $control.reason } else { 'stop' }
            $owner.Stop()
            $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
            Write-Receipt
        }
        if ($null -ne $stopDeadline -and [DateTime]::UtcNow -gt $stopDeadline) {
            throw 'Owned job termination was not confirmed within 10 seconds'
        }
        if ($lastRootExited -ne $receipt.rootExited -or $lastActive -ne $receipt.activeProcesses) {
            Write-Receipt
            $lastRootExited = $receipt.rootExited; $lastActive = $receipt.activeProcesses
        }
        Start-Sleep -Milliseconds 25
    }
} catch {
    $failure = $_.Exception.Message
    if ($null -ne $receipt) {
        if ($null -ne $owner) {
            $receipt.commandStarted = $owner.CommandStarted
            $receipt.rootPid = $owner.RootPid
            try {
                $owner.Stop()
                $deadline = [DateTime]::UtcNow.AddSeconds(10)
                do {
                    Update-Facts
                    if ($receipt.activeProcesses -eq 0 -and ($receipt.rootPid -eq 0 -or $receipt.rootExited)) {
                        $receipt.jobComplete = $true; $receipt.cleanupConfirmed = $true; break
                    }
                    Start-Sleep -Milliseconds 25
                } while ([DateTime]::UtcNow -lt $deadline)
            } catch { $failure += '; cleanup: ' + $_.Exception.Message }
        } else {
            $receipt.activeProcesses = 0; $receipt.jobComplete = $true; $receipt.cleanupConfirmed = $true
        }
        $receipt.startupFailedBeforeCommand = -not $receipt.commandStarted
        $receipt.error = $failure
        $receipt.final = $true
        try { Write-Receipt } catch { }
    }
    # Failure details belong only to the private receipt. Never emit control markers into stdio.
} finally {
    if ($null -ne $owner) { $owner.Dispose() }
}
exit $exitCode
