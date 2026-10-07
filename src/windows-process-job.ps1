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
    // Readers such as antivirus/indexers can briefly deny deletion of the current
    // receipt on Windows. Retry only the atomic rename, never the target command
    // or an in-place write. The retry budget is 500 ms; persistent errors fail closed.
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFileExW(string existing, string destination, uint flags);
    public static void PublishReceipt(string temporary, string destination) {
        System.Diagnostics.Stopwatch timer = System.Diagnostics.Stopwatch.StartNew();
        while (true) {
            if (MoveFileExW(temporary, destination, 1)) return;
            int error = Marshal.GetLastWin32Error();
            long remaining = 500 - timer.ElapsedMilliseconds;
            if ((error != 5 && error != 32 && error != 33) || remaining <= 0)
                throw new System.IO.IOException("Atomic receipt publication failed: " + error);
            System.Threading.Thread.Sleep((int)Math.Min(10, remaining));
            if (timer.ElapsedMilliseconds >= 500)
                throw new System.IO.IOException("Atomic receipt publication failed: " + error);
        }
    }

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
$nativeSourceSha256 = 'c63e2a2b2756fc30b8bc452dffe4c635b431373ac1c1860dd8812b38bef73bdf'
$nativeAssemblySha256 = '62e11cd76c8fd4f5b0059192399e73a0880cb9f5f1b6c03b3f8bfdbd8f8a1b84'
$nativeAssemblyBase64 = @'
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
vwAGAEYLMQsGAGcLvwAGAG0LMQsGAHoLvwAGAJMLvwAGAJoLWAgKAM0LugsGAOALWAgGACMMGQwGAC8MvwAGAEkMOAwGAFYMAwoKAIcMcQwGAJYMvwAGACwN
AwoGADsNvwAGAEENvwAGAG8NxQIGAHwNxQIGAL4NvwAGAP8NvwAGACIOvwAGADQOvwAGAIsOWAgGAKEOWAgAAAAAAQAAAAAAAQABAAEBEAAcAAAABQABAAEA
AQEQACkAAAAFAAMACAALARAANwAAAA0ADAAyAAsBEABDAAAADQAVADIACwEQAE8AAAANABsAMgALARAAXgAAAA0AIQAyAAsBEQBpAAAADQApADIACwEQAHUA
AAANADsAMgALARAAgwAAAA0APQAyAAsBEACXAAAADQBBADIAAwEAAKAAAAARAEMAMgAAAAAAtwwAAAUAQwA2ABMBAAD8DAAADQBEADYAIQD1AAoAAQD6AA0A
MQDuAtQAAQAiA98AAQA6A+IAAQA+A+IAAQAlBBQBAQA+BAoAAQBkBN8AAQB+BN8AEQBkDtQABgDTBCMBBgDrBCMBBgD/BBQBBgAKBSYBBgAgBSYBBgA2BRQB
BgBJBSYBBgBSBRQBBgBgBRQBBgBwBSkBBgCDBSkBBgCXBSkBBgCrBSkBBgC9BSkBBgDQBSkBBgDjBSwBBgD5BTABBgAABiYBBgATBiYBBgAiBiYBBgA4BiYB
BgBKBiMBBgBYBiMBBgBoBiMBBgCABiMBBgCaBhQBBgCuBhQBBgDiAxQBBgC9BhQBBgDWBhQBBgDZBgoABgDkBgoABgDuBgoABgD2BhQBBgD6BhQBBgD+BhQB
BgAGBxQBBgAOBxQBBgAcBxQBBgAqBxQBBgA6BxQBBgBCBzQBBgBOBzQBBgBaB+IABgBmB+IABgBwB+IABgB7B+IABgCFBzcBBgCRB+IABgChB+IABgCqB+IA
BgCyBxQBBgC+BxQBBgDJBxQBBgDNBxQBEwEYDVECUCAAAAAAgRgDARAAAQBgIAAAAACBAAkBFQACALAgAAAAAIEADwEZAAIA9yAAAAAAgQAUAR0AAgAQIQAA
AACBABsBIgADALgiAAAAAIEAJwEmAAMAkCcAAAAAlgBVASsABAAAAAAAgACRIFsBNQAFAPAnAAAAAJYAZwE8AAgAAAAAAIAAkSB2AUIACgAAAAAAgACRIIcB
SAAMAAAAAACAAJEgnwFSABAAAAAAAIAAkSC5AV0AFQAAAAAAgACRIMgBZQAYAAAAAACAAJEg2wFlABoAAAAAAIAAkSDsAWsAHAAAAAAAgACRIAACcQAeAAAA
AACAAJEgEAKCACMAAAAAAIAAkSAjAokAJQAAAAAAgACRIDACjgAmAAAAAACAAJEgPAKTACcAAAAAAIAAkSBOApcAJwAAAAAAgACRIFsCnAAoAAAAAACAAJEg
awKoAC8AAAAAAIAAkSCNArEAMwAAAAAAgACRIKcCvAA6AAAAAACAAJEg3wLBADsAAAAAAIAAkSD9AtgARQAAAAAAgACRIBMDggBHAH0oAAAAAIYIRgPlAEkA
hSgAAAAAgQhSA+kASQCOKAAAAACGCF4DIgBKAJYoAAAAAIEIdwMQAEoAnygAAAAAhgiQA+4ASwCnKAAAAACBCJ0D8gBLALAoAAAAAIYIqgPuAEwAuCgAAAAA
gQi9A/IATADBKAAAAACRANAD9wBNANQoAAAAAIYYAwEVAE8AsCkAAAAAlgDWA/0ATwCAKgAAAACGANwDAgFQAOQvAAAAAIYA4gPlAFcAHDAAAAAAhgDyA+4A
VwBiMAAAAACGAP0DDwFXAJQwAAAAAIYACwTlAFgAvDAAAAAAhgAYBBUAWAAcMQAAAADmAR0EFQBYAKExAAAAAJEYUA4DA1gAljEAAAAAkQBXDgcDWAAAAAAA
AwCGGAMBOwFZAAAAAAADAMYB0gdBAVsAAAAAAAMAxgH0B0YBXAAAAAAAAwDGAQAITwFfAAAAAQAKCAAAAQAKCAAAAQAQCAAAAQD1AAAAAQAWCAAAAgAfCAAA
AwArCAAAAQAxCAAAAgAfCAAAAQA7CAAAAgBECAAAAQA6AwAAAgBJCAAAAwBOCAAABABTCAAAAQA6AwAAAgBJCAIAAwBOCAAABABTCAAABQCECAAAAQA+AwAA
AgA6AwIAAwCNCAAAAQA6AwAAAgCUCAAAAQA+AwAAAgCUCAAAAQCZCAAAAgCgCAAAAQA+AwIAAgCtCAIAAwC2CAIABAC7CAIABQDCCAAAAQA+AwIAAgCUCAAA
AQDHCAAAAQCZCAAAAQBJCAAAAQDOCAAAAgDcCAAAAwDjCAIABADxCAAABQD4CAAABgD/CAAABwAHCQAAAQAPCQAAAgAUCQAAAwArCAAABABTCAAAAQAPCQAA
AgArCAAAAwAaCQAABAAKCAAABQBTCAAABgAkCQAABwCECAAAAQAPCQAAAQAtCQAAAgA5CQAAAwBBCQAABABRCQAABQD/CAAABgArCAAABwBgCQAACABsCQAA
CQBwCQIACgA+AwAAAQB4CQAAAgCACQAAAQCECQIAAgCMCQAAAQAKCAAAAQAKCAAAAQAKCAAAAQAKCAAAAQCNCAAAAgCRCQAAAQAKCAAAAQCbCQAAAgCmCQAA
AwBsCQAABACrCQAABQC6CQAABgDACQAABwDZCQAAAQCgCAAAAQBJCAAAAQDsCQAAAgDzCQAAAQBJCAAAAQBJCAAAAgD6CQAAAwDsCQAAAQCNCAMACQBJAAMB
FQBRAAMBDwFZAAMBFQAJAAMBFQBhAGgKVQFhAHMKWQFhAH0KXgFpAAMBEAAxAAMBFQAJAJcKIgAxAKAKZwFxALYKeAEMAAMBhAEUAAMBFQAUAN0KlAEMAOUK
mgEMAPEKoAEUAPUKVQEUAPEKqAFhAP8KrgFhAA4LtwFhACcLvQGZAFILwwGhAIoLyAG5AFUB0wHBAAMBEADJANcLCwLRAOgLEALJAPoLFAJhABIMGALZAAMB
EADhADQMHgLpAFAMJALxAAMBFQD5AAMBNQIBAZ0M4gABAaIMOwLRALAMQQIJAVQNVQJhAGQNXwIxAAMBEAAxAKAKZQIhAQMB8gApAYUNdQIpAY4NewJhAJgN
gQIxAKAKhgIxAGgKVQFhAKYNkQJhABIMmALRAKsNngIBAQ4LOwIBAQMBDwExAQMBEADRANgNowIBAeUNEALRANgNlwDRAO4NqALRAPMNsQI5AQgOtwI5ARgO
FAJBAZcKvgLRACgOvABRAQMBDAMuABsAHAMuABMAEwPhABMBMAIBARMBMAIhARMBMAJBARMBMAJhARMBMAKjARMBMALAAxMBMALgAxMBMAIABBMBMAIgBBMB
MAJABBMBMAJgBBMBMAKABBMBMAKgBBMBMAIgBhMBMAIBAAYAAAAOAGMBbQHcAQACKQJLAmwCxAL6Av8CAwABAAAAngQXAQAApgQbAQAAuwQfAQAAxAQfAQIA
HgADAAEAHwADAAEAIQAFAAIAIAAFAAEAIwAHAAIAIgAHAAIAJAAJAAEAJQAJAK0LfQGOAUQBEQBbAQEARAEVAHYBAQBAARcAhwEBAEABGQCfAQEAQAEbALkB
AQBAAR0AyAEBAEABHwDbAQEAQAEhAOwBAQBAASMAAAIBAEABJQAQAgEAQAEnACMCAQBAASkAMAIBAAABKwA8AgEAQAEtAE4CAQBAAS8AWwIBAEABMQBrAgEA
QAEzAI0CAQAAATUApwIBAEQBNwDfAgEAQAE5AP0CAQBAATsAEwMBAKgpAABDAASAAAAAAAAAAAAAAAAAAAAAACkAAAAEAAAAAAAAAAAAAAABALYAAAAAAAQA
AAAAAAAAAAAAAAEAvwAAAAAABAADAAUAAwAGAAMABwADAAgAAwAJAAMACgADAAsAAwAMAAMADgANAE0ARgJNAIwCTQD1AgAAADxNb2R1bGU+AFJlbEFpT3du
ZWRKb2IuZGxsAFJlbEFpSm9iSnNvbgBSZWxBaU93bmVkSm9iAEJBU0lDX0xJTUlUAElPX0NPVU5URVJTAEVYVEVOREVEX0xJTUlUAEFDQ09VTlRJTkcAU1RB
UlRVUElORk8AU1RBUlRVUElORk9FWABQUk9DRVNTX0lORk9STUFUSU9OAEZJTEVUSU1FAENvbnRyb2xIYW5kbGVyUm91dGluZQBtc2NvcmxpYgBTeXN0ZW0A
T2JqZWN0AElEaXNwb3NhYmxlAFZhbHVlVHlwZQBNdWx0aWNhc3REZWxlZ2F0ZQB0ZXh0AHBvc2l0aW9uAC5jdG9yAFNwYWNlAFRha2UARXhwZWN0AFN0cmlu
Z1ZhbHVlAFZhbHVlAFN5c3RlbS5Db2xsZWN0aW9ucy5HZW5lcmljAERpY3Rpb25hcnlgMgBQYXJzZQBNb3ZlRmlsZUV4VwBQdWJsaXNoUmVjZWlwdABDcmVh
dGVKb2JPYmplY3RXAFNldEluZm9ybWF0aW9uSm9iT2JqZWN0AFF1ZXJ5SW5mb3JtYXRpb25Kb2JPYmplY3QASXNQcm9jZXNzSW5Kb2IAVGVybWluYXRlSm9i
T2JqZWN0AFRlcm1pbmF0ZVByb2Nlc3MAV2FpdEZvclNpbmdsZU9iamVjdABHZXRQcm9jZXNzVGltZXMAR2V0RXhpdENvZGVQcm9jZXNzAFJlc3VtZVRocmVh
ZABDbG9zZUhhbmRsZQBHZXRDdXJyZW50UHJvY2VzcwBHZXRTdGRIYW5kbGUARHVwbGljYXRlSGFuZGxlAEluaXRpYWxpemVQcm9jVGhyZWFkQXR0cmlidXRl
TGlzdABVcGRhdGVQcm9jVGhyZWFkQXR0cmlidXRlAERlbGV0ZVByb2NUaHJlYWRBdHRyaWJ1dGVMaXN0AFN5c3RlbS5UZXh0AFN0cmluZ0J1aWxkZXIAQ3Jl
YXRlUHJvY2Vzc1cAQ29udHJvbEhhbmRsZXIAU2V0Q29uc29sZUN0cmxIYW5kbGVyAEdldENvbnNvbGVNb2RlAGNvbnRyb2xIYW5kbGVySW5zdGFsbGVkAGpv
YgBwcm9jZXNzAGdldF9Sb290UGlkAHNldF9Sb290UGlkAGdldF9Sb290Q3JlYXRpb25JZGVudGl0eQBzZXRfUm9vdENyZWF0aW9uSWRlbnRpdHkAZ2V0X0Fz
c2lnbmVkAHNldF9Bc3NpZ25lZABnZXRfQ29tbWFuZFN0YXJ0ZWQAc2V0X0NvbW1hbmRTdGFydGVkAENoZWNrAFF1b3RlAFN0YXJ0AEFjdGl2ZVByb2Nlc3Nl
cwBSb290RXhpdGVkAFdhaXRGb3JDaGFuZ2UAUm9vdEV4aXRDb2RlAFN0b3AARGlzcG9zZQA8Um9vdFBpZD5rX19CYWNraW5nRmllbGQAPFJvb3RDcmVhdGlv
bklkZW50aXR5PmtfX0JhY2tpbmdGaWVsZAA8QXNzaWduZWQ+a19fQmFja2luZ0ZpZWxkADxDb21tYW5kU3RhcnRlZD5rX19CYWNraW5nRmllbGQAUm9vdFBp
ZABSb290Q3JlYXRpb25JZGVudGl0eQBBc3NpZ25lZABDb21tYW5kU3RhcnRlZABQZXJQcm9jZXNzVXNlclRpbWVMaW1pdABQZXJKb2JVc2VyVGltZUxpbWl0
AExpbWl0RmxhZ3MATWluaW11bVdvcmtpbmdTZXRTaXplAE1heGltdW1Xb3JraW5nU2V0U2l6ZQBBY3RpdmVQcm9jZXNzTGltaXQAQWZmaW5pdHkAUHJpb3Jp
dHlDbGFzcwBTY2hlZHVsaW5nQ2xhc3MAUmVhZE9wZXJhdGlvbkNvdW50AFdyaXRlT3BlcmF0aW9uQ291bnQAT3RoZXJPcGVyYXRpb25Db3VudABSZWFkVHJh
bnNmZXJDb3VudABXcml0ZVRyYW5zZmVyQ291bnQAT3RoZXJUcmFuc2ZlckNvdW50AEJhc2ljTGltaXRJbmZvcm1hdGlvbgBJb0luZm8AUHJvY2Vzc01lbW9y
eUxpbWl0AEpvYk1lbW9yeUxpbWl0AFBlYWtQcm9jZXNzTWVtb3J5VXNlZABQZWFrSm9iTWVtb3J5VXNlZABUb3RhbFVzZXJUaW1lAFRvdGFsS2VybmVsVGlt
ZQBUaGlzUGVyaW9kVG90YWxVc2VyVGltZQBUaGlzUGVyaW9kVG90YWxLZXJuZWxUaW1lAFRvdGFsUGFnZUZhdWx0Q291bnQAVG90YWxQcm9jZXNzZXMAVG90
YWxUZXJtaW5hdGVkUHJvY2Vzc2VzAGNiAGxwUmVzZXJ2ZWQAbHBEZXNrdG9wAGxwVGl0bGUAZHdYAGR3WQBkd1hTaXplAGR3WVNpemUAZHdYQ291bnRDaGFy
cwBkd1lDb3VudENoYXJzAGR3RmlsbEF0dHJpYnV0ZQBkd0ZsYWdzAHdTaG93V2luZG93AGNiUmVzZXJ2ZWQyAGxwUmVzZXJ2ZWQyAGhTdGRJbnB1dABoU3Rk
T3V0cHV0AGhTdGRFcnJvcgBTdGFydHVwSW5mbwBscEF0dHJpYnV0ZUxpc3QAaFByb2Nlc3MAaFRocmVhZABkd1Byb2Nlc3NJZABkd1RocmVhZElkAExvdwBI
aWdoAEludm9rZQBJQXN5bmNSZXN1bHQAQXN5bmNDYWxsYmFjawBCZWdpbkludm9rZQBFbmRJbnZva2UAdmFsdWUAZGVwdGgAZXhpc3RpbmcAZGVzdGluYXRp
b24AZmxhZ3MAdGVtcG9yYXJ5AHNlY3VyaXR5AG5hbWUAa2luZABpbmZvAHNpemUAU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzAE91dEF0dHJpYnV0
ZQByZXR1cm5lZAByZXN1bHQAY29kZQBoYW5kbGUAbWlsbGlzZWNvbmRzAGNyZWF0aW9uAGV4aXQAa2VybmVsAHVzZXIAdGhyZWFkAHNvdXJjZVByb2Nlc3MA
c291cmNlAHRhcmdldFByb2Nlc3MAdGFyZ2V0AGFjY2VzcwBpbmhlcml0AG9wdGlvbnMAbGlzdABjb3VudABhdHRyaWJ1dGUAcHJldmlvdXMAYXBwbGljYXRp
b24AY29tbWFuZABwcm9jZXNzU2VjdXJpdHkAdGhyZWFkU2VjdXJpdHkAZW52aXJvbm1lbnQAY3dkAHN0YXJ0dXAAaGFuZGxlcgBhZGQAY29uc29sZQBtb2Rl
AG9wZXJhdGlvbgBleGVjdXRhYmxlAGFyZ3MAcmF3Q29tbWFuZExpbmUAYXJndjAAd2luZG93c1ZlcmJhdGltQXJndW1lbnRzAGVudmlyb25tZW50RW50cmll
cwBvYmplY3QAbWV0aG9kAGNhbGxiYWNrAFN5c3RlbS5SdW50aW1lLkNvbXBpbGVyU2VydmljZXMAQ29tcGlsYXRpb25SZWxheGF0aW9uc0F0dHJpYnV0ZQBS
dW50aW1lQ29tcGF0aWJpbGl0eUF0dHJpYnV0ZQBTdHJpbmcAZ2V0X0xlbmd0aABnZXRfQ2hhcnMASW5kZXhPZgBBcmd1bWVudEV4Y2VwdGlvbgBUb1N0cmlu
ZwBBcHBlbmQAU3RyaW5nQ29tcGFyZXIAZ2V0X09yZGluYWwASUVxdWFsaXR5Q29tcGFyZXJgMQBMaXN0YDEAVG9BcnJheQBDb250YWluc0tleQBBZGQAZ2V0
X0NvdW50AENvbXBhcmVPcmRpbmFsAG9wX0VxdWFsaXR5AEJvb2xlYW4AQ2hhcgBTdWJzdHJpbmcAU3lzdGVtLkdsb2JhbGl6YXRpb24AQ3VsdHVyZUluZm8A
Z2V0X0ludmFyaWFudEN1bHR1cmUASW50MzIATnVtYmVyU3R5bGVzAElGb3JtYXRQcm92aWRlcgBUcnlQYXJzZQBEb3VibGUARGxsSW1wb3J0QXR0cmlidXRl
AGtlcm5lbDMyLmRsbABTeXN0ZW0uRGlhZ25vc3RpY3MAU3RvcHdhdGNoAFN0YXJ0TmV3AE1hcnNoYWwAR2V0TGFzdFdpbjMyRXJyb3IAZ2V0X0VsYXBzZWRN
aWxsaXNlY29uZHMAQ29uY2F0AFN5c3RlbS5JTwBJT0V4Y2VwdGlvbgBNYXRoAE1pbgBTeXN0ZW0uVGhyZWFkaW5nAFRocmVhZABTbGVlcABDb21waWxlckdl
bmVyYXRlZEF0dHJpYnV0ZQBTeXN0ZW0uQ29tcG9uZW50TW9kZWwAV2luMzJFeGNlcHRpb24ASW50UHRyAFplcm8Ab3BfSW5lcXVhbGl0eQBTaXplT2YAPFBy
aXZhdGVJbXBsZW1lbnRhdGlvbkRldGFpbHM+ezQyQjkwMTk1LTczQjEtNDc3Qy04QzdFLUFCOEREM0NCNDUyQn0AX19TdGF0aWNBcnJheUluaXRUeXBlU2l6
ZT02ACQkbWV0aG9kMHg2MDAwMDI4LTEAUnVudGltZUhlbHBlcnMAQXJyYXkAUnVudGltZUZpZWxkSGFuZGxlAEluaXRpYWxpemVBcnJheQBJbmRleE9mQW55
AFVURjhFbmNvZGluZwBFbmNvZGluZwBHZXRCeXRlcwBHZXRTdHJpbmcASXNOdWxsT3JFbXB0eQBKb2luAFN0cmluZ1RvSEdsb2JhbFVuaQBJbnZhbGlkT3Bl
cmF0aW9uRXhjZXB0aW9uAEFsbG9jSEdsb2JhbABnZXRfU2l6ZQBDb3B5AFdyaXRlSW50UHRyAERhdGVUaW1lAEZyb21GaWxlVGltZVV0YwBnZXRfVGlja3MA
SW50NjQARnJlZUhHbG9iYWwAQXJndW1lbnRPdXRPZlJhbmdlRXhjZXB0aW9uAC5jY3RvcgA8LmNjdG9yPmJfXzAAQ1MkPD45X19DYWNoZWRBbm9ueW1vdXNN
ZXRob2REZWxlZ2F0ZTEAU3RydWN0TGF5b3V0QXR0cmlidXRlAExheW91dEtpbmQAAAkgAAkADQAKAAAxVAByAHUAbgBjAGEAdABlAGQAIABvAHcAbgBlAGQA
LQBqAG8AYgAgAEoAUwBPAE4AATlJAG4AdgBhAGwAaQBkACAAbwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAdABvAGsAZQBuAAE7SQBuAHYAYQBsAGkA
ZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAHMAdAByAGkAbgBnAAE7SQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8A
TgAgAGUAcwBjAGEAcABlAAE1TwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAaQBzACAAdABvAG8AIABkAGUAZQBwAAE/RAB1AHAAbABpAGMAYQB0AGUA
IABvAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABtAGUAbQBiAGUAcgABQ08AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAGEAcgByAGEAeQAgAGkA
cwAgAHQAbwBvACAAbABhAHIAZwBlAAFBSQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAHMAZQBwAGEAcgBhAHQAbwByAAEJ
dAByAHUAZQAAC2YAYQBsAHMAZQAACW4AdQBsAGwAADtJAG4AdgBhAGwAaQBkACAAbwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAbgB1AG0AYgBlAHIA
ATdPAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABpAHMAIAB0AG8AbwAgAGwAYQByAGcAZQABRUUAeABwAGUAYwB0AGUAZAAgAG8AbgBlACAAbwB3AG4A
ZQBkAC0AagBvAGIAIABKAFMATwBOACAAbwBiAGoAZQBjAHQAAUdBAHQAbwBtAGkAYwAgAHIAZQBjAGUAaQBwAHQAIABwAHUAYgBsAGkAYwBhAHQAaQBvAG4A
IABmAGEAaQBsAGUAZAA6ACAAACFDAHIAZQBhAHQAZQBKAG8AYgBPAGIAagBlAGMAdABXAAArUwBlAHQAQwBvAG4AcwBvAGwAZQBDAHQAcgBsAEgAYQBuAGQA
bABlAHIAAC9TAGUAdABJAG4AZgBvAHIAbQBhAHQAaQBvAG4ASgBvAGIATwBiAGoAZQBjAHQAACFJAG4AdgBhAGwAaQBkACAAYQByAGcAdQBtAGUAbgB0AAAD
IgAAAyAAADlJAG4AdgBhAGwAaQBkACAAVwBpAG4AZABvAHcAcwAgAGMAbwBtAG0AYQBuAGQAIABsAGkAbgBlAAADAAABBQAAAAABP1QAYQByAGcAZQB0ACAA
ZQBuAHYAaQByAG8AbgBtAGUAbgB0ACAAaQBzACAAdABvAG8AIABsAGEAcgBnAGUAAEdWAGEAbABpAGQAIABzAHQAYQBuAGQAYQByAGQAIABoAGEAbgBkAGwA
ZQBzACAAYQByAGUAIAByAGUAcQB1AGkAcgBlAGQAAC1EAHUAcABsAGkAYwBhAHQAZQBIAGEAbgBkAGwAZQAoAHMAdABkAGkAbwApAAAnQQB0AHQAcgBpAGIA
dQB0AGUAIABsAGkAcwB0ACAAcwBpAHoAZQAAQ0kAbgBpAHQAaQBhAGwAaQB6AGUAUAByAG8AYwBUAGgAcgBlAGEAZABBAHQAdAByAGkAYgB1AHQAZQBMAGkA
cwB0AABFVQBwAGQAYQB0AGUAUAByAG8AYwBUAGgAcgBlAGEAZABBAHQAdAByAGkAYgB1AHQAZQAoAGgAYQBuAGQAbABlAHMAKQAAR1UAcABkAGEAdABlAFAA
cgBvAGMAVABoAHIAZQBhAGQAQQB0AHQAcgBpAGIAdQB0AGUAKABqAG8AYgAgAGwAaQBzAHQAKQAASUMAcgBlAGEAdABlAFAAcgBvAGMAZQBzAHMAVwAoAHMA
dQBzAHAAZQBuAGQAZQBkACwAIABvAHcAbgBlAGQAIABqAG8AYgApAAANdwBpAG4AMwAyADoAAB1JAHMAUAByAG8AYwBlAHMAcwBJAG4ASgBvAGIAAE9DAHIA
ZQBhAHQAZQBkACAAcAByAG8AYwBlAHMAcwAgAGkAcwAgAG4AbwB0ACAAaQBuACAAaQB0AHMAIABvAHcAbgBlAGQAIABqAG8AYgAAGVIAZQBzAHUAbQBlAFQA
aAByAGUAYQBkAABDVQBuAGUAeABwAGUAYwB0AGUAZAAgAHMAdQBzAHAAZQBuAGQAZQBkACAAdABoAHIAZQBhAGQAIABzAHQAYQB0AGUAADNRAHUAZQByAHkA
SQBuAGYAbwByAG0AYQB0AGkAbwBuAEoAbwBiAE8AYgBqAGUAYwB0AAAnVwBhAGkAdABGAG8AcgBTAGkAbgBnAGwAZQBPAGIAagBlAGMAdAAAJUcAZQB0AEUA
eABpAHQAQwBvAGQAZQBQAHIAbwBjAGUAcwBzAAAlVABlAHIAbQBpAG4AYQB0AGUASgBvAGIATwBiAGoAZQBjAHQAAEVUAGUAcgBtAGkAbgBhAHQAZQBQAHIA
bwBjAGUAcwBzACgAdQBuAHMAdABhAHIAdABlAGQAIAB0AGEAcgBnAGUAdAApAAAAlQG5QrFzfEeMfquN08tFKwAIt3pcVhk04IkCBg4CBggEIAEBDgMgAAED
IAADBCABAQMDIAAOBCABHAgJAAEVEhUCDhwOBgADAg4OCQUAAgEODgUAAhgYDgkABAIYCBARGAkKAAUCGAgQERwJGAcAAwIYGBACBQACAhgJBQACCRgJEAAF
AhgQESwQESwQESwQESwGAAICGBAJBAABCRgEAAECGAMAABgEAAEYCAsABwIYGBgQGAkCCQgABAIYCAkQGAoABwIYCRgYGBgYBAABARgSAAoCDhIZGBgCCRgO
EBEkEBEoAwYSMAYAAgISMAICBgICBhgDIAAJBCABAQkDIAACBCABAQIFAAIBAg4EAAEODgwgBwEOHQ4ODg4CHQ4EIAEBCAIGCQMoAAkDKAAOAygAAgIGCgIG
GQIGCwMGERADBhEUAgYGAwYRIAUgAgEcGAQgAQIJCCADEh0JEiEcBSABAhIdAyAACAQgAQMIBCABCAMDBwEIBSABEhkDCgcHEhkDCAgDCAMEAAASOQYVEhUC
DhwJIAEBFRI9ARMABRUSQQEcBSAAHRMABSABAhMAByACARMAEwEFIAEBEwAIAAUIDggOCAgFAAICDg4FIAIOCAgEAAASTQoABAIOEVUSWRAICAADDQ4RVRJZ
IwcUAxUSFQIOHBUSQQEcAw4cAw4IAwgOCBwdDh0OCB0DHQMICgcCEggVEhUCDhwEAAASZQMAAAgDIAAKBQACDhwcBQACCgoKBAABAQgGBwMSZQgKBAEAAAAF
IAIBCA4FAAICGBgEEAEACAQKAREYBQcCCREYAwYROAkAAgESgIkRgI0FIAEIHQMGIAISGQMICAcFEhkIAw4IBSABHQUOBSABDh0FBAABAg4FIAESGQ4ECgER
JAYAAg4OHQ4FAAIODg4EAAEYDgQAARgYCAAEAR0YCBgIBQACARgYBgABEYCdCgUgAQ4SWTAHIBKAkQgIEhkOESQdGBgYGBgCDhgIGBgRKBEsESwRLBEsCgIJ
GB0OCBGAnQodGAgECgERHAQHAREcAwcBCQMAAAEEAAECCQYgAQERgK0IAQAIAAAAAAAeAQABAFQCFldyYXBOb25FeGNlcHRpb25UaHJvd3MBAHxYAAAAAAAA
AAAAAJ5YAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQWAAAAAAAAAAAAAAAAAAAAAAAAAAAX0NvckRsbE1haW4AbXNjb3JlZS5kbGwAAAAAAP8lACAAEAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABABAAAAAYAACAAAAAAAAA
AAAAAAAAAAABAAEAAAAwAACAAAAAAAAAAAAAAAAAAAABAAAAAABIAAAAWGAAAFwCAAAAAAAAAAAAAFwCNAAAAFYAUwBfAFYARQBSAFMASQBPAE4AXwBJAE4A
RgBPAAAAAAC9BO/+AAABAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAQAAAACAAAAAAAAAAAAAAAAAAAARAAAAAEAVgBhAHIARgBpAGwAZQBJAG4AZgBvAAAA
AAAkAAQAAABUAHIAYQBuAHMAbABhAHQAaQBvAG4AAAAAAAAAsAS8AQAAAQBTAHQAcgBpAG4AZwBGAGkAbABlAEkAbgBmAG8AAACYAQAAAQAwADAAMAAwADAA
NABiADAAAAAsAAIAAQBGAGkAbABlAEQAZQBzAGMAcgBpAHAAdABpAG8AbgAAAAAAIAAAADAACAABAEYAaQBsAGUAVgBlAHIAcwBpAG8AbgAAAAAAMAAuADAA
LgAwAC4AMAAAAEQAEgABAEkAbgB0AGUAcgBuAGEAbABOAGEAbQBlAAAAUgBlAGwAQQBpAE8AdwBuAGUAZABKAG8AYgAuAGQAbABsAAAAKAACAAEATABlAGcA
YQBsAEMAbwBwAHkAcgBpAGcAaAB0AAAAIAAAAEwAEgABAE8AcgBpAGcAaQBuAGEAbABGAGkAbABlAG4AYQBtAGUAAABSAGUAbABBAGkATwB3AG4AZQBkAEoA
bwBiAC4AZABsAGwAAAA0AAgAAQBQAHIAbwBkAHUAYwB0AFYAZQByAHMAaQBvAG4AAAAwAC4AMAAuADAALgAwAAAAOAAIAAEAQQBzAHMAZQBtAGIAbAB5ACAA
VgBlAHIAcwBpAG8AbgAAADAALgAwAC4AMAAuADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAABQAAAMAAAAsDgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
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
    $publishReceipt.Invoke($null, @($temporary, $ReceiptPath))
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
    $publishReceipt = $nativeImplementation.Type.GetMethod('PublishReceipt')
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
