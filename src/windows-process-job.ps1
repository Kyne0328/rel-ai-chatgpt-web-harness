# Native Windows ownership for Rel.AI-created processes only. Protocol 1.
# This is a lifetime boundary, not a sandbox for hostile same-user code.
# Target environment travels only in a nonce-bound inherited JSON payload, limited to
# 24000 UTF-16 characters. Oversize/invalid requests fail before user code; no fallback.
# Finite jobs wait for every newly owned descendant, including detached daemons.
# Managed persistent jobs retain their controller/job for the declared lifetime.
# Pre-existing shared services and externally broker-created processes are not enrolled.
# Existing parent-job restrictions are respected; assignment failure never resumes the target.
param(
    [string]$RequestPath,
    [string]$ReceiptPath,
    [string]$ControlPath,
    [string]$InspectJob
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
using System.IO;
using System.Threading;
using Microsoft.Win32.SafeHandles;

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
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr security, uint size);
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
    IntPtr outputWrite, errorWrite;
    Thread outputReader, errorReader;
    string outputError;
    long outputBytes, errorBytes;
    const long OutputLimit = 64L * 1024 * 1024;
    public long OutputBytes { get { return Interlocked.Read(ref outputBytes); } }
    public long ErrorBytes { get { return Interlocked.Read(ref errorBytes); } }
    public string OutputError { get { return outputError; } }
    public uint RootPid { get; private set; }
    public string RootCreationIdentity { get; private set; }
    public bool Assigned { get; private set; }
    public bool CommandStarted { get; private set; }
    static void Check(bool result, string operation) {
        if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    public RelAiOwnedJob() {
        Initialize(null);
    }
    public RelAiOwnedJob(string name) {
        if (name == null || !System.Text.RegularExpressions.Regex.IsMatch(name, @"^Local\\RelAiJob-[a-f0-9]{64}$"))
            throw new ArgumentException("Invalid private job name");
        Initialize(name);
    }
    void Initialize(string name) {
        job = CreateJobObjectW(IntPtr.Zero, name); // Non-inheritable; target only inherits stdio.
        int createdError = Marshal.GetLastWin32Error();
        Check(job != IntPtr.Zero, "CreateJobObjectW");
        try {
            if (name != null && createdError == 183) throw new InvalidOperationException("Owned job name already exists");
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
    // Inspection never creates a job or signals a PID. A missing *previously
    // witnessed* kill-on-close job means its kernel lifetime has ended.
    public static int Inspect(string name) {
        if (name == null || !System.Text.RegularExpressions.Regex.IsMatch(name, @"^Local\\RelAiJob-[a-f0-9]{64}$"))
            throw new ArgumentException("Invalid private job name");
        IntPtr observed = OpenJobObjectW(4, false, name); // JOB_OBJECT_QUERY only.
        if (observed == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return -1;
            throw new Win32Exception(error, "OpenJobObjectW");
        }
        try {
            ACCOUNTING info;
            Check(QueryInformationJobObject(observed, 1, out info, (uint)Marshal.SizeOf<ACCOUNTING>(), IntPtr.Zero), "QueryInformationJobObject");
            return checked((int)info.ActiveProcesses);
        } finally { CloseHandle(observed); }
    }
    public void DurableOutput(string directory) {
        if (outputReader != null || errorReader != null) throw new InvalidOperationException("Output already initialized");
        outputReader = Capture(Path.Combine(directory, "stdout.log"), false, out outputWrite);
        errorReader = Capture(Path.Combine(directory, "stderr.log"), true, out errorWrite);
    }
    Thread Capture(string file, bool error, out IntPtr write) {
        // Open storage before caller code. Pipes belong to this controller,
        // not Electron, so a desktop crash cannot sever the target's output.
        FileStream target = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read | FileShare.Delete);
        IntPtr read;
        try { Check(CreatePipe(out read, out write, IntPtr.Zero, 65536), "CreatePipe(durable output)"); }
        catch { target.Dispose(); throw; }
        Thread reader = new Thread(delegate() {
            try {
                using (target)
                using (FileStream source = new FileStream(new SafeFileHandle(read, true), FileAccess.Read)) {
                    byte[] buffer = new byte[65536];
                    long total = 0; int count;
                    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
                        int retain = (int)Math.Max(0, Math.Min((long)count, OutputLimit - total));
                        if (retain > 0) { target.Write(buffer, 0, retain); target.Flush(); }
                        total += count;
                        if (error) Interlocked.Exchange(ref errorBytes, total); else Interlocked.Exchange(ref outputBytes, total);
                    }
                }
            } catch (Exception failure) { outputError = failure.Message; }
        });
        reader.IsBackground = true; reader.Start();
        return reader;
    }
    public void FinishOutput() {
        if (outputWrite != IntPtr.Zero) { CloseHandle(outputWrite); outputWrite = IntPtr.Zero; }
        if (errorWrite != IntPtr.Zero) { CloseHandle(errorWrite); errorWrite = IntPtr.Zero; }
        if (outputReader != null && !outputReader.Join(2000)) outputError = "Durable stdout did not finish draining";
        if (errorReader != null && !errorReader.Join(2000)) outputError = "Durable stderr did not finish draining";
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
    public void Start(string executable, string[] args, string cwd, string rawCommandLine, string argv0, bool windowsVerbatimArguments, string[] environmentEntries, bool hideConsole) {
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
                IntPtr source = i == 1 && outputWrite != IntPtr.Zero ? outputWrite
                    : i == 2 && errorWrite != IntPtr.Zero ? errorWrite : GetStdHandle(-10 - i);
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
            // Hiding the controller does not hide a console allocated by its
            // target after detachment. Non-PTY callers explicitly suppress it;
            // PTY targets retain their inherited console and Ctrl+C semantics.
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00000004 | 0x00080000 | 0x00000400 | (hideConsole ? 0x08000000u : 0u), environment, cwd, ref startup, out created),
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
        FinishOutput();
        if (controlHandlerInstalled) { SetConsoleCtrlHandler(ControlHandler, false); controlHandlerInstalled = false; }
    }
}
'@
# BEGIN VERIFIED NATIVE ASSEMBLY
# Generated only from the C# above: node scripts/generate-windows-process-job-native.mjs --write
# The trusted script pins both hashes; runtime never trusts external cache metadata.
$nativeSourceSha256 = '8f80d8024f587a99f91bdaa715af55dc47f50d71688d1f5e6651cb42c63c6563'
$nativeAssemblySha256 = '0d83146cf565ce0e3b6b2d0c977dcaa641be3bca06210da8312767c2dcac1cc0'
$nativeAssemblyBase64 = @'
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
AQAAAAIAAAAXAAAAAQAAAAEAAAACAAAACwAAAAMAAAAAAAoAAQAAAAAABgDGAL8ABgDNAL8ABgDZAL8ABgDjAL8ABgBIAS0BBgD3AusCBgCUA4MDBgDyCL8A
BgD/CL8ABgCVCXYJBgBoC0gLBgCIC0gLBgCmC78ABgDKC78ABgDsC78ABgAHDC0BBgAbDC0BBgBfDL8ABgBnDL8ABgCLDHYMBgCsDL8ABgCyDHYMBgC/DL8A
BgDYDL8ABgDfDHYJCgASDf8MBgAlDXYJBgBoDV4NBgB0Db8ABgCDDYMDBgCUDUgLCgDFDa8NCgDzDdQNBgABDr8ABgAbDr8ABgA8Dl4NBgBcDl4NBgCbDn8O
BgCqDl4NBgC1Dr8ABgC+Dl4NBgDaDr8ABgDwDl4NBgD5Dl4NBgADD4MDBgCaD0gLBgCpD78ABgCvD78ABgDdD+sCBgDqD+sCBgBOEL8ABgBxEL8ABgCDEL8A
BgDaEHYJBgDwEHYJAAAAAAEAAAAAAAEAAQABARAAHAAAAAUAAQABAAEBEAApAAAABQADAAgACwEQADcAAAANABQAPQALARAAQwAAAA0AHQA9AAsBEABPAAAA
DQAjAD0ACwEQAF4AAAANACkAPQALAREAaQAAAA0AMQA9AAsBEAB1AAAADQBDAD0ACwEQAIMAAAANAEUAPQALARAAlwAAAA0ASQA9AAMBAACgAAAAEQBLAD0A
AwEQAEkOAAAFAEsAQQAAAAAAJQ8AAAUATwBDABMBAABqDwAADQBQAEMAIQD1AAoAAQD6AA0AUYBbATUAMQAUA/EAAQBIA/wAAQBgA/8AAQBkA/8AAQBsA/8A
AQB4A/8AAQCbAwIBAQCoAwIBAQC0AwoAAQDAAzUAAQDMAzUAAQAbBUgBAQA0BQoAAQBaBfwAAQB0BfwAEQCzEPEABgDsBTUABgAEBjUABgAYBkgBBgAjBlsB
BgA5BlsBBgBPBkgBBgBiBlsBBgBrBkgBBgB5BkgBBgCJBl4BBgCcBl4BBgCwBl4BBgDEBl4BBgDWBl4BBgDpBl4BBgD8BmEBBgASB2UBBgAZB1sBBgAsB1sB
BgA7B1sBBgBRB1sBBgBjBzUABgBxBzUABgCBBzUABgCZBzUABgCzB0gBBgDHB0gBBgDYBEgBBgDWB0gBBgDvB0gBBgDyBwoABgD9BwoABgAHCAoABgAPCEgB
BgATCEgBBgAXCEgBBgAfCEgBBgAnCEgBBgA1CEgBBgBDCEgBBgBTCEgBBgBbCGkBBgBnCGkBBgBzCP8ABgB/CP8ABgCJCP8ABgCUCP8ABgCeCGwBBgCqCP8A
BgC6CP8ABgDDCP8ABgDLCEgBBgDXCEgBBgDiCEgBBgDmCEgBBgAkCpwCBgBxCf8ABgBnDqECBgDOCvwAEwGGD/4CUCAAAAAAgRgDARAAAQBgIAAAAACBAAkB
FQACALAgAAAAAIEADwEZAAIA9yAAAAAAgQAUAR0AAgAQIQAAAACBABsBIgADALgiAAAAAIEAJwEmAAMAkCcAAAAAlgBVASsABAAAAAAAgACRIGcBQQAFAPAn
AAAAAJYAcwFIAAgAAAAAAIAAkSCCAU4ACgAAAAAAgACRIJMBVAAMAAAAAACAAJEgogFbAA8AAAAAAIAAkSCtAWUAEwAAAAAAgACRIMUBbwAXAAAAAACAAJEg
3wF6ABwAAAAAAIAAkSDuAYIAHwAAAAAAgACRIAECggAhAAAAAACAAJEgEgKIACMAAAAAAIAAkSAmAo4AJQAAAAAAgACRIDYCnwAqAAAAAACAAJEgSQKmACwA
AAAAAIAAkSBWAqsALQAAAAAAgACRIGICsAAuAAAAAACAAJEgdAK0AC4AAAAAAIAAkSCBArkALwAAAAAAgACRIJECxQA2AAAAAACAAJEgswLOADoAAAAAAIAA
kSDNAtkAQQAAAAAAgACRIAUD3gBCAAAAAACAAJEgIwP1AEwAAAAAAIAAkSA5A58ATgB9KAAAAACGCNcDBgFQAIooAAAAAIYI5wMGAVAAlygAAAAAhgj2AyIA
UACfKAAAAACGCAYECgFQAKcoAAAAAIEIEgQOAVAAsCgAAAAAhggeBCIAUQC4KAAAAACBCDcEEABRAMEoAAAAAIYIUAQTAVIAySgAAAAAgQhdBBcBUgDSKAAA
AACGCGoEEwFTANooAAAAAIEIfQQXAVMA4ygAAAAAkQCQBBwBVAD0KAAAAACGGAMBFQBWAAMpAAAAAIYYAwEQAFYAMCkAAAAAgQCWBBAAVwAUKgAAAACWAKEE
IgFYAKwqAAAAAIYAqQQQAFkAKCwAAAAAgQC3BCcBWgC4LAAAAACGAL8EFQBdAHAtAAAAAJYAzAQwAV0AQC4AAAAAhgDSBDUBXgD0MwAAAACGANgECgFmACw0
AAAAAIYA6AQTAWYAcjQAAAAAhgDzBEMBZgCkNAAAAACGAAEFCgFnAMw0AAAAAIYADgUVAGcALDUAAAAA5gETBRUAZwC3NQAAAACRGJ8QpQNnAKw1AAAAAJEA
phCpA2cAAAAAAAMAhhgDAXABaAAAAAAAAwDGAesIdgFqAAAAAAADAMYBDQl7AWsAAAAAAAMAxgEZCYQBbgAQKwAAAACGGAMBFQBvABgrAAAAAIYAcQ4VAG8A
AAABACMJAAABACMJAAABACkJAAABAPUAAAABAC8JAAACADgJAAADAEQJAAABAEoJAAACADgJAAABAFQJAAACAF0JAAABAGIJAAACAGkJAAADAF0JAgABAHEJ
AgACAKIJAAADAFQJAAAEAKgJAAABAGADAAACAK0JAAADALIJAAAEAKgJAAABAGADAAACAK0JAgADALIJAAAEAKgJAAAFALcJAAABAGQDAAACAGADAgADAMAJ
AAABAGADAAACAMcJAAABAGQDAAACAMcJAAABAMwJAAACANMJAAABAGQDAgACAOAJAgADAOkJAgAEAO4JAgAFAPUJAAABAGQDAgACAMcJAAABAPoJAAABAMwJ
AAABAK0JAAABAAEKAAACAA8KAAADABYKAgAEACQKAAAFAGIJAAAGAGkJAAAHACsKAAABADMKAAACADgKAAADAEQJAAAEAKgJAAABADMKAAACAEQJAAADAD4K
AAAEACMJAAAFAKgJAAAGAEgKAAAHALcJAAABADMKAAABAFEKAAACAF0KAAADAGUKAAAEAHUKAAAFAGkJAAAGAEQJAAAHAIQKAAAIAJAKAAAJAJQKAgAKAGQD
AAABAJwKAAACAKQKAAABAKgKAgACALAKAAABACMJAAABACMJAAABACMJAAABACMJAAABAMAJAAACALUKAAABAF0JAAABAF0JAAABAF0JAAABAL8KAAABAMkK
AAACAM4KAgADAKIJAAABACMJAAABANQKAAACAN8KAAADAJAKAAAEAOQKAAAFAPMKAAAGAPkKAAAHABILAAAIACULAAABANMJAAABAK0JAAABADELAAACADgL
AAABAK0JAAABAK0JAAACAD8LAAADADELAAABAMAJAwAJAFEAAwEVAFkAAwFDAWEAAwEVAAkAAwEVAGkArQuKAWkAuAuOAWkAwguTAXEAAwEQADEAAwEVAAkA
3AsiADEA5QucAXkA+wutAQwAAwG5ARQAAwEVABQAIgzJAQwAKgzPAQwANgzVARQAOgyKARQANgzdAWkARAzjAWkAUwzsAWkAbAzyAaEAlwz4AakAzwz9AcEA
VQEIAskAAwEQANEAHA1AAtkALQ1FAtEAPw0GAWkAVw1JAuEAAwEQAOkAeQ1PAjkAfQ1VAvEAjw1hAvkAAwEVAAEBAwFsAgkB+Q3sAREBCA7/ABEBDQ5yAhkB
AwEQANkANQ54AhEBUwxyAiEBQQ6WAjEBAwGlAikBAwGrAukAug5PAkkBxQ61AkkByw4VAPEA0Q69AkkBjw3EAhEAEwUVAFEB5A4iACkBAwHdAkkBEwUVAGkB
AwFwATkAAwHrAjkADw8XATkA0gQVADkAIA/5AnEBwg8CA2kA0g8MAzEAAwEQADEA5QsSA4kBAwEXAZEB8w8iA5EB/A8oA2kABhAuAzEA5QszAzEArQuKAWkA
IA8+A2kAVw2WAtkAFBBFAxEBAwFDAdkAJxBKAxEBNBBFAtkAJxC0ANkAPRBPA9kAQhBYA5kBVxBeA5kBZxAGAaEB3AtlA9kAdxDZALEBAwGuAwoADAA4AC4A
EwC1Ay4AGwC+A6MBGwFnAsMBGwFnAuEBGwFnAgECGwFnAiECGwFnAkECGwFnAmECGwFnAmAEGwFnAoAEGwFnAqAEGwFnAsAEGwFnAuAEGwFnAgAFGwFnAiAF
GwFnAkAFGwFnAoAHGwFnAgEABgAAAA8AmAGiARECNQJaAoICjgLMAvICGQNrA5wDoQMDAAEAAACUBUsBAACgBUsBAACrBU8BAAC3BVMBAAC/BU8BAADUBVcB
AADdBVcBAgAgAAMAAgAhAAUAAgAiAAcAAgAjAAkAAQAkAAkAAgAlAAsAAQAmAAsAAQAoAA0AAgAnAA0AAgApAA8AAQAqAA8A8gyyAcMBRAERAGcBAQBEARUA
ggEBAEQBFwCTAQEAQAEZAKIBAQBAARsArQEBAEABHQDFAQEAQAEfAN8BAQBAASEA7gEBAEABIwABAgEAQAElABICAQBAAScAJgIBAEABKQA2AgEAQAErAEkC
AQBAAS0AVgIBAAABLwBiAgEAQAExAHQCAQBAATMAgQIBAEABNQCRAgEAQAE3ALMCAQAAATkAzQIBAEQBOwAFAwEAQAE9ACMDAQBAAT8AOQMBAGgtAABPAASA
AAAAAAAAAAAAAAAAAAAAACkAAAAEAAAAAAAAAAAAAAABALYAAAAAAAQAAAAAAAAAAAAAAAEAvwAAAAAABAADAAUAAwAGAAMABwADAAgAAwAJAAMACgADAAsA
AwAMAAMADQADAA8ADgBTAH0CUwCJAlMAOQMAAAAAADxNb2R1bGU+AFJlbEFpT3duZWRKb2IuZGxsAFJlbEFpSm9iSnNvbgBSZWxBaU93bmVkSm9iAEJBU0lD
X0xJTUlUAElPX0NPVU5URVJTAEVYVEVOREVEX0xJTUlUAEFDQ09VTlRJTkcAU1RBUlRVUElORk8AU1RBUlRVUElORk9FWABQUk9DRVNTX0lORk9STUFUSU9O
AEZJTEVUSU1FAENvbnRyb2xIYW5kbGVyUm91dGluZQBtc2NvcmxpYgBTeXN0ZW0AT2JqZWN0AElEaXNwb3NhYmxlAFZhbHVlVHlwZQBNdWx0aWNhc3REZWxl
Z2F0ZQB0ZXh0AHBvc2l0aW9uAC5jdG9yAFNwYWNlAFRha2UARXhwZWN0AFN0cmluZ1ZhbHVlAFZhbHVlAFN5c3RlbS5Db2xsZWN0aW9ucy5HZW5lcmljAERp
Y3Rpb25hcnlgMgBQYXJzZQBPdXRwdXRMaW1pdABNb3ZlRmlsZUV4VwBQdWJsaXNoUmVjZWlwdABDcmVhdGVKb2JPYmplY3RXAE9wZW5Kb2JPYmplY3RXAENy
ZWF0ZVBpcGUAU2V0SW5mb3JtYXRpb25Kb2JPYmplY3QAUXVlcnlJbmZvcm1hdGlvbkpvYk9iamVjdABJc1Byb2Nlc3NJbkpvYgBUZXJtaW5hdGVKb2JPYmpl
Y3QAVGVybWluYXRlUHJvY2VzcwBXYWl0Rm9yU2luZ2xlT2JqZWN0AEdldFByb2Nlc3NUaW1lcwBHZXRFeGl0Q29kZVByb2Nlc3MAUmVzdW1lVGhyZWFkAENs
b3NlSGFuZGxlAEdldEN1cnJlbnRQcm9jZXNzAEdldFN0ZEhhbmRsZQBEdXBsaWNhdGVIYW5kbGUASW5pdGlhbGl6ZVByb2NUaHJlYWRBdHRyaWJ1dGVMaXN0
AFVwZGF0ZVByb2NUaHJlYWRBdHRyaWJ1dGUARGVsZXRlUHJvY1RocmVhZEF0dHJpYnV0ZUxpc3QAU3lzdGVtLlRleHQAU3RyaW5nQnVpbGRlcgBDcmVhdGVQ
cm9jZXNzVwBDb250cm9sSGFuZGxlcgBTZXRDb25zb2xlQ3RybEhhbmRsZXIAR2V0Q29uc29sZU1vZGUAY29udHJvbEhhbmRsZXJJbnN0YWxsZWQAam9iAHBy
b2Nlc3MAb3V0cHV0V3JpdGUAZXJyb3JXcml0ZQBTeXN0ZW0uVGhyZWFkaW5nAFRocmVhZABvdXRwdXRSZWFkZXIAZXJyb3JSZWFkZXIAb3V0cHV0RXJyb3IA
b3V0cHV0Qnl0ZXMAZXJyb3JCeXRlcwBnZXRfT3V0cHV0Qnl0ZXMAZ2V0X0Vycm9yQnl0ZXMAZ2V0X091dHB1dEVycm9yAGdldF9Sb290UGlkAHNldF9Sb290
UGlkAGdldF9Sb290Q3JlYXRpb25JZGVudGl0eQBzZXRfUm9vdENyZWF0aW9uSWRlbnRpdHkAZ2V0X0Fzc2lnbmVkAHNldF9Bc3NpZ25lZABnZXRfQ29tbWFu
ZFN0YXJ0ZWQAc2V0X0NvbW1hbmRTdGFydGVkAENoZWNrAEluaXRpYWxpemUASW5zcGVjdABEdXJhYmxlT3V0cHV0AENhcHR1cmUARmluaXNoT3V0cHV0AFF1
b3RlAFN0YXJ0AEFjdGl2ZVByb2Nlc3NlcwBSb290RXhpdGVkAFdhaXRGb3JDaGFuZ2UAUm9vdEV4aXRDb2RlAFN0b3AARGlzcG9zZQA8Um9vdFBpZD5rX19C
YWNraW5nRmllbGQAPFJvb3RDcmVhdGlvbklkZW50aXR5PmtfX0JhY2tpbmdGaWVsZAA8QXNzaWduZWQ+a19fQmFja2luZ0ZpZWxkADxDb21tYW5kU3RhcnRl
ZD5rX19CYWNraW5nRmllbGQAT3V0cHV0Qnl0ZXMARXJyb3JCeXRlcwBPdXRwdXRFcnJvcgBSb290UGlkAFJvb3RDcmVhdGlvbklkZW50aXR5AEFzc2lnbmVk
AENvbW1hbmRTdGFydGVkAFBlclByb2Nlc3NVc2VyVGltZUxpbWl0AFBlckpvYlVzZXJUaW1lTGltaXQATGltaXRGbGFncwBNaW5pbXVtV29ya2luZ1NldFNp
emUATWF4aW11bVdvcmtpbmdTZXRTaXplAEFjdGl2ZVByb2Nlc3NMaW1pdABBZmZpbml0eQBQcmlvcml0eUNsYXNzAFNjaGVkdWxpbmdDbGFzcwBSZWFkT3Bl
cmF0aW9uQ291bnQAV3JpdGVPcGVyYXRpb25Db3VudABPdGhlck9wZXJhdGlvbkNvdW50AFJlYWRUcmFuc2ZlckNvdW50AFdyaXRlVHJhbnNmZXJDb3VudABP
dGhlclRyYW5zZmVyQ291bnQAQmFzaWNMaW1pdEluZm9ybWF0aW9uAElvSW5mbwBQcm9jZXNzTWVtb3J5TGltaXQASm9iTWVtb3J5TGltaXQAUGVha1Byb2Nl
c3NNZW1vcnlVc2VkAFBlYWtKb2JNZW1vcnlVc2VkAFRvdGFsVXNlclRpbWUAVG90YWxLZXJuZWxUaW1lAFRoaXNQZXJpb2RUb3RhbFVzZXJUaW1lAFRoaXNQ
ZXJpb2RUb3RhbEtlcm5lbFRpbWUAVG90YWxQYWdlRmF1bHRDb3VudABUb3RhbFByb2Nlc3NlcwBUb3RhbFRlcm1pbmF0ZWRQcm9jZXNzZXMAY2IAbHBSZXNl
cnZlZABscERlc2t0b3AAbHBUaXRsZQBkd1gAZHdZAGR3WFNpemUAZHdZU2l6ZQBkd1hDb3VudENoYXJzAGR3WUNvdW50Q2hhcnMAZHdGaWxsQXR0cmlidXRl
AGR3RmxhZ3MAd1Nob3dXaW5kb3cAY2JSZXNlcnZlZDIAbHBSZXNlcnZlZDIAaFN0ZElucHV0AGhTdGRPdXRwdXQAaFN0ZEVycm9yAFN0YXJ0dXBJbmZvAGxw
QXR0cmlidXRlTGlzdABoUHJvY2VzcwBoVGhyZWFkAGR3UHJvY2Vzc0lkAGR3VGhyZWFkSWQATG93AEhpZ2gASW52b2tlAElBc3luY1Jlc3VsdABBc3luY0Nh
bGxiYWNrAEJlZ2luSW52b2tlAEVuZEludm9rZQB2YWx1ZQBkZXB0aABleGlzdGluZwBkZXN0aW5hdGlvbgBmbGFncwB0ZW1wb3JhcnkAc2VjdXJpdHkAbmFt
ZQBhY2Nlc3MAaW5oZXJpdAByZWFkAFN5c3RlbS5SdW50aW1lLkludGVyb3BTZXJ2aWNlcwBPdXRBdHRyaWJ1dGUAd3JpdGUAc2l6ZQBraW5kAGluZm8AcmV0
dXJuZWQAcmVzdWx0AGNvZGUAaGFuZGxlAG1pbGxpc2Vjb25kcwBjcmVhdGlvbgBleGl0AGtlcm5lbAB1c2VyAHRocmVhZABzb3VyY2VQcm9jZXNzAHNvdXJj
ZQB0YXJnZXRQcm9jZXNzAHRhcmdldABvcHRpb25zAGxpc3QAY291bnQAYXR0cmlidXRlAHByZXZpb3VzAGFwcGxpY2F0aW9uAGNvbW1hbmQAcHJvY2Vzc1Nl
Y3VyaXR5AHRocmVhZFNlY3VyaXR5AGVudmlyb25tZW50AGN3ZABzdGFydHVwAGhhbmRsZXIAYWRkAGNvbnNvbGUAbW9kZQBvcGVyYXRpb24AZGlyZWN0b3J5
AGZpbGUAZXJyb3IAZXhlY3V0YWJsZQBhcmdzAHJhd0NvbW1hbmRMaW5lAGFyZ3YwAHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cwBlbnZpcm9ubWVudEVudHJp
ZXMAaGlkZUNvbnNvbGUAb2JqZWN0AG1ldGhvZABjYWxsYmFjawBTeXN0ZW0uUnVudGltZS5Db21waWxlclNlcnZpY2VzAENvbXBpbGF0aW9uUmVsYXhhdGlv
bnNBdHRyaWJ1dGUAUnVudGltZUNvbXBhdGliaWxpdHlBdHRyaWJ1dGUAU3RyaW5nAGdldF9MZW5ndGgAZ2V0X0NoYXJzAEluZGV4T2YAQXJndW1lbnRFeGNl
cHRpb24AVG9TdHJpbmcAQXBwZW5kAFN0cmluZ0NvbXBhcmVyAGdldF9PcmRpbmFsAElFcXVhbGl0eUNvbXBhcmVyYDEATGlzdGAxAFRvQXJyYXkAQ29udGFp
bnNLZXkAQWRkAGdldF9Db3VudABDb21wYXJlT3JkaW5hbABvcF9FcXVhbGl0eQBCb29sZWFuAENoYXIAU3Vic3RyaW5nAFN5c3RlbS5HbG9iYWxpemF0aW9u
AEN1bHR1cmVJbmZvAGdldF9JbnZhcmlhbnRDdWx0dXJlAEludDMyAE51bWJlclN0eWxlcwBJRm9ybWF0UHJvdmlkZXIAVHJ5UGFyc2UARG91YmxlAERsbElt
cG9ydEF0dHJpYnV0ZQBrZXJuZWwzMi5kbGwAU3lzdGVtLkRpYWdub3N0aWNzAFN0b3B3YXRjaABTdGFydE5ldwBNYXJzaGFsAEdldExhc3RXaW4zMkVycm9y
AGdldF9FbGFwc2VkTWlsbGlzZWNvbmRzAENvbmNhdABTeXN0ZW0uSU8ASU9FeGNlcHRpb24ATWF0aABNaW4AU2xlZXAASW50ZXJsb2NrZWQAUmVhZABDb21w
aWxlckdlbmVyYXRlZEF0dHJpYnV0ZQBTeXN0ZW0uQ29tcG9uZW50TW9kZWwAV2luMzJFeGNlcHRpb24AU3lzdGVtLlRleHQuUmVndWxhckV4cHJlc3Npb25z
AFJlZ2V4AElzTWF0Y2gASW50UHRyAFplcm8Ab3BfSW5lcXVhbGl0eQBJbnZhbGlkT3BlcmF0aW9uRXhjZXB0aW9uAFNpemVPZgBQYXRoAENvbWJpbmUAPD5j
X19EaXNwbGF5Q2xhc3MxAEZpbGVTdHJlYW0APD40X190aGlzADxDYXB0dXJlPmJfXzAATWljcm9zb2Z0LldpbjMyLlNhZmVIYW5kbGVzAFNhZmVGaWxlSGFu
ZGxlAEZpbGVBY2Nlc3MAQnl0ZQBNYXgAU3RyZWFtAFdyaXRlAEZsdXNoAEV4Y2hhbmdlAEV4Y2VwdGlvbgBnZXRfTWVzc2FnZQBGaWxlTW9kZQBGaWxlU2hh
cmUAVGhyZWFkU3RhcnQAc2V0X0lzQmFja2dyb3VuZABKb2luADxQcml2YXRlSW1wbGVtZW50YXRpb25EZXRhaWxzPns2NEI2Q0I1NS0zQzEzLTRBMUMtQUZE
MS1ENkNFMzI2ODZFNjh9AF9fU3RhdGljQXJyYXlJbml0VHlwZVNpemU9NgAkJG1ldGhvZDB4NjAwMDAzMy0xAFJ1bnRpbWVIZWxwZXJzAEFycmF5AFJ1bnRp
bWVGaWVsZEhhbmRsZQBJbml0aWFsaXplQXJyYXkASW5kZXhPZkFueQBVVEY4RW5jb2RpbmcARW5jb2RpbmcAR2V0Qnl0ZXMAR2V0U3RyaW5nAElzTnVsbE9y
RW1wdHkAU3RyaW5nVG9IR2xvYmFsVW5pAEFsbG9jSEdsb2JhbABnZXRfU2l6ZQBDb3B5AFdyaXRlSW50UHRyAERhdGVUaW1lAEZyb21GaWxlVGltZVV0YwBn
ZXRfVGlja3MASW50NjQARnJlZUhHbG9iYWwAQXJndW1lbnRPdXRPZlJhbmdlRXhjZXB0aW9uAC5jY3RvcgA8LmNjdG9yPmJfXzMAQ1MkPD45X19DYWNoZWRB
bm9ueW1vdXNNZXRob2REZWxlZ2F0ZTQAU3RydWN0TGF5b3V0QXR0cmlidXRlAExheW91dEtpbmQAAAAJIAAJAA0ACgAAMVQAcgB1AG4AYwBhAHQAZQBkACAA
bwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOAAE5SQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAHQAbwBrAGUAbgABO0kA
bgB2AGEAbABpAGQAIABvAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABzAHQAcgBpAG4AZwABO0kAbgB2AGEAbABpAGQAIABvAHcAbgBlAGQALQBqAG8A
YgAgAEoAUwBPAE4AIABlAHMAYwBhAHAAZQABNU8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAGkAcwAgAHQAbwBvACAAZABlAGUAcAABP0QAdQBwAGwA
aQBjAGEAdABlACAAbwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAbQBlAG0AYgBlAHIAAUNPAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABhAHIA
cgBhAHkAIABpAHMAIAB0AG8AbwAgAGwAYQByAGcAZQABQUkAbgB2AGEAbABpAGQAIABvAHcAbgBlAGQALQBqAG8AYgAgAEoAUwBPAE4AIABzAGUAcABhAHIA
YQB0AG8AcgABCXQAcgB1AGUAAAtmAGEAbABzAGUAAAluAHUAbABsAAA7SQBuAHYAYQBsAGkAZAAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAG4A
dQBtAGIAZQByAAE3TwB3AG4AZQBkAC0AagBvAGIAIABKAFMATwBOACAAaQBzACAAdABvAG8AIABsAGEAcgBnAGUAAUVFAHgAcABlAGMAdABlAGQAIABvAG4A
ZQAgAG8AdwBuAGUAZAAtAGoAbwBiACAASgBTAE8ATgAgAG8AYgBqAGUAYwB0AAFHQQB0AG8AbQBpAGMAIAByAGUAYwBlAGkAcAB0ACAAcAB1AGIAbABpAGMA
YQB0AGkAbwBuACAAZgBhAGkAbABlAGQAOgAgAAA9XgBMAG8AYwBhAGwAXABcAFIAZQBsAEEAaQBKAG8AYgAtAFsAYQAtAGYAMAAtADkAXQB7ADYANAB9ACQA
ATFJAG4AdgBhAGwAaQBkACAAcAByAGkAdgBhAHQAZQAgAGoAbwBiACAAbgBhAG0AZQAAIUMAcgBlAGEAdABlAEoAbwBiAE8AYgBqAGUAYwB0AFcAADtPAHcA
bgBlAGQAIABqAG8AYgAgAG4AYQBtAGUAIABhAGwAcgBlAGEAZAB5ACAAZQB4AGkAcwB0AHMAACtTAGUAdABDAG8AbgBzAG8AbABlAEMAdAByAGwASABhAG4A
ZABsAGUAcgAAL1MAZQB0AEkAbgBmAG8AcgBtAGEAdABpAG8AbgBKAG8AYgBPAGIAagBlAGMAdAAAHU8AcABlAG4ASgBvAGIATwBiAGoAZQBjAHQAVwAAM1EA
dQBlAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4ASgBvAGIATwBiAGoAZQBjAHQAADVPAHUAdABwAHUAdAAgAGEAbAByAGUAYQBkAHkAIABpAG4AaQB0AGkA
YQBsAGkAegBlAGQAABVzAHQAZABvAHUAdAAuAGwAbwBnAAAVcwB0AGQAZQByAHIALgBsAG8AZwAANUMAcgBlAGEAdABlAFAAaQBwAGUAKABkAHUAcgBhAGIA
bABlACAAbwB1AHQAcAB1AHQAKQAATUQAdQByAGEAYgBsAGUAIABzAHQAZABvAHUAdAAgAGQAaQBkACAAbgBvAHQAIABmAGkAbgBpAHMAaAAgAGQAcgBhAGkA
bgBpAG4AZwAATUQAdQByAGEAYgBsAGUAIABzAHQAZABlAHIAcgAgAGQAaQBkACAAbgBvAHQAIABmAGkAbgBpAHMAaAAgAGQAcgBhAGkAbgBpAG4AZwAAIUkA
bgB2AGEAbABpAGQAIABhAHIAZwB1AG0AZQBuAHQAAAMiAAADIAAAOUkAbgB2AGEAbABpAGQAIABXAGkAbgBkAG8AdwBzACAAYwBvAG0AbQBhAG4AZAAgAGwA
aQBuAGUAAAMAAAEFAAAAAAE/VABhAHIAZwBlAHQAIABlAG4AdgBpAHIAbwBuAG0AZQBuAHQAIABpAHMAIAB0AG8AbwAgAGwAYQByAGcAZQAAR1YAYQBsAGkA
ZAAgAHMAdABhAG4AZABhAHIAZAAgAGgAYQBuAGQAbABlAHMAIABhAHIAZQAgAHIAZQBxAHUAaQByAGUAZAAALUQAdQBwAGwAaQBjAGEAdABlAEgAYQBuAGQA
bABlACgAcwB0AGQAaQBvACkAACdBAHQAdAByAGkAYgB1AHQAZQAgAGwAaQBzAHQAIABzAGkAegBlAABDSQBuAGkAdABpAGEAbABpAHoAZQBQAHIAbwBjAFQA
aAByAGUAYQBkAEEAdAB0AHIAaQBiAHUAdABlAEwAaQBzAHQAAEVVAHAAZABhAHQAZQBQAHIAbwBjAFQAaAByAGUAYQBkAEEAdAB0AHIAaQBiAHUAdABlACgA
aABhAG4AZABsAGUAcwApAABHVQBwAGQAYQB0AGUAUAByAG8AYwBUAGgAcgBlAGEAZABBAHQAdAByAGkAYgB1AHQAZQAoAGoAbwBiACAAbABpAHMAdAApAABJ
QwByAGUAYQB0AGUAUAByAG8AYwBlAHMAcwBXACgAcwB1AHMAcABlAG4AZABlAGQALAAgAG8AdwBuAGUAZAAgAGoAbwBiACkAAA13AGkAbgAzADIAOgAAHUkA
cwBQAHIAbwBjAGUAcwBzAEkAbgBKAG8AYgAAT0MAcgBlAGEAdABlAGQAIABwAHIAbwBjAGUAcwBzACAAaQBzACAAbgBvAHQAIABpAG4AIABpAHQAcwAgAG8A
dwBuAGUAZAAgAGoAbwBiAAAZUgBlAHMAdQBtAGUAVABoAHIAZQBhAGQAAENVAG4AZQB4AHAAZQBjAHQAZQBkACAAcwB1AHMAcABlAG4AZABlAGQAIAB0AGgA
cgBlAGEAZAAgAHMAdABhAHQAZQAAJ1cAYQBpAHQARgBvAHIAUwBpAG4AZwBsAGUATwBiAGoAZQBjAHQAACVHAGUAdABFAHgAaQB0AEMAbwBkAGUAUAByAG8A
YwBlAHMAcwAAJVQAZQByAG0AaQBuAGEAdABlAEoAbwBiAE8AYgBqAGUAYwB0AABFVABlAHIAbQBpAG4AYQB0AGUAUAByAG8AYwBlAHMAcwAoAHUAbgBzAHQA
YQByAHQAZQBkACAAdABhAHIAZwBlAHQAKQAAAAAAVcu2ZBM8HEqv0dbOMmhuaAAIt3pcVhk04IkCBg4CBggEIAEBDgMgAAEDIAADBCABAQMDIAAOBCABHAgJ
AAEVEhUCDhwOAgYKCAAAAAQAAAAABgADAg4OCQUAAgEODgUAAhgYDgYAAxgJAg4JAAQCEBgQGBgJCQAEAhgIEBEYCQoABQIYCBARHAkYBwADAhgYEAIFAAIC
GAkFAAIJGAkQAAUCGBARLBARLBARLBARLAYAAgIYEAkEAAEJGAQAAQIYAwAAGAQAARgICwAHAhgYGBAYCQIJCAAEAhgICRAYCgAHAhgJGBgYGBgEAAEBGBIA
CgIOEhkYGAIJGA4QESQQESgDBhIwBgACAhIwAgIGAgIGGAMGEh0DIAAKAyAACQQgAQEJAyAAAgQgAQECBQACAQIOBAABCA4IIAMSHQ4CEBgEAAEODg0gCAEO
HQ4ODg4CHQ4CBCABAQgCBgkDKAAKAygADgMoAAkDKAACAgYZAgYLAwYREAMGERQCBgYDBhEgBSACARwYBCABAgkIIAMSIQkSJRwFIAECEiEDIAAIBCABAwgE
IAEIAwMHAQgFIAESGQMKBwcSGQMICAMIAwQAABI9BhUSFQIOHAkgAQEVEkEBEwAFFRJFARwFIAAdEwAFIAECEwAHIAIBEwATAQUgAQETAAgABQgOCA4ICAUA
AgIODgUgAg4ICAQAABJRCgAEAg4RWRJdEAgIAAMNDhFZEl0jBxQDFRIVAg4cFRJFARwDDhwDDggDCA4IHB0OHQ4IHQMdAwgKBwISCBUSFQIOHAQAABJpAwAA
CAUAAg4cHAUAAgoKCgQAAQEIBgcDEmkICgUAAQoQCgQBAAAABSACAQgOBQACAhgYBBABAAgECgERGAYHAwgJERgECgERHAcHBBgIERwIBQACDg4OBAYSgJUD
BhIMBSACARgCCSACARKAmRGAnQcgAwEdBQgIBgACChAKCgcgAwgdBQgIEAcHEoCVHQUKCAgSgKkSgJUNIAQBDhGArRGAnRGAsQYgAQESgLUGBwISHRI0BCAB
AggDBhE8CQACARKAvRGAwQUgAQgdAwYgAhIZAwgIBwUSGQgDDggFIAEdBQ4FIAEOHQUEAAECDgUgARIZDgQKAREkBgACDg4dDgQAARgOBAABGBgIAAQBHRgI
GAgFAAIBGBgGAAERgM0KBSABDhJdMAcgEoDFCAgSGQ4RJB0YGBgYGAIOGAgYGBEoESwRLBEsESwKAgkYHQ4IEYDNCh0YCAQHAREcAwcBCQMAAAEEAAECCQYg
AQERgN0IAQAIAAAAAAAeAQABAFQCFldyYXBOb25FeGNlcHRpb25UaHJvd3MBAAAA9GMAAAAAAAAAAAAADmQAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABk
AAAAAAAAAAAAAAAAX0NvckRsbE1haW4AbXNjb3JlZS5kbGwAAAAAAP8lACAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABABAA
AAAYAACAAAAAAAAAAAAAAAAAAAABAAEAAAAwAACAAAAAAAAAAAAAAAAAAAABAAAAAABIAAAAWIAAAFwCAAAAAAAAAAAAAFwCNAAAAFYAUwBfAFYARQBSAFMA
SQBPAE4AXwBJAE4ARgBPAAAAAAC9BO/+AAABAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAQAAAACAAAAAAAAAAAAAAAAAAAARAAAAAEAVgBhAHIARgBpAGwA
ZQBJAG4AZgBvAAAAAAAkAAQAAABUAHIAYQBuAHMAbABhAHQAaQBvAG4AAAAAAAAAsAS8AQAAAQBTAHQAcgBpAG4AZwBGAGkAbABlAEkAbgBmAG8AAACYAQAA
AQAwADAAMAAwADAANABiADAAAAAsAAIAAQBGAGkAbABlAEQAZQBzAGMAcgBpAHAAdABpAG8AbgAAAAAAIAAAADAACAABAEYAaQBsAGUAVgBlAHIAcwBpAG8A
bgAAAAAAMAAuADAALgAwAC4AMAAAAEQAEgABAEkAbgB0AGUAcgBuAGEAbABOAGEAbQBlAAAAUgBlAGwAQQBpAE8AdwBuAGUAZABKAG8AYgAuAGQAbABsAAAA
KAACAAEATABlAGcAYQBsAEMAbwBwAHkAcgBpAGcAaAB0AAAAIAAAAEwAEgABAE8AcgBpAGcAaQBuAGEAbABGAGkAbABlAG4AYQBtAGUAAABSAGUAbABBAGkA
TwB3AG4AZQBkAEoAbwBiAC4AZABsAGwAAAA0AAgAAQBQAHIAbwBkAHUAYwB0AFYAZQByAHMAaQBvAG4AAAAwAC4AMAAuADAALgAwAAAAOAAIAAEAQQBzAHMA
ZQBtAGIAbAB5ACAAVgBlAHIAcwBpAG8AbgAAADAALgAwAC4AMAAuADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAABgAAAMAAAAIDQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
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
    if ($null -ne $owner -and $receipt.final) {
        $owner.FinishOutput()
        $receipt.stdoutBytes = $owner.OutputBytes.ToString([Globalization.CultureInfo]::InvariantCulture)
        $receipt.stderrBytes = $owner.ErrorBytes.ToString([Globalization.CultureInfo]::InvariantCulture)
        $receipt.outputError = $owner.OutputError
    }
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
    if ($InspectJob) {
        $count = $nativeImplementation.Type.GetMethod('Inspect').Invoke($null, @($InspectJob))
        [Console]::Out.Write(([ordered]@{ protocol = 1; jobName = $InspectJob; activeProcesses = $count } | ConvertTo-Json -Compress))
        exit 0
    }
    if (-not $RequestPath -or -not $ReceiptPath -or -not $ControlPath) { throw 'Expected request, receipt and control paths' }
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
        jobName = $null; killOnClose = $false
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
    if ($null -ne $request.jobName) {
        if ($request.jobName -cne ('Local\RelAiJob-' + $request.nonce)) { throw 'Invalid owned-job name binding' }
        $owner = [Activator]::CreateInstance($nativeImplementation.Type, [object[]]@($request.jobName))
        $receipt.jobName = $request.jobName
        $receipt.killOnClose = $true
    } else { $owner = [Activator]::CreateInstance($nativeImplementation.Type) }
    if ($request.durableOutput -eq $true) { $owner.DurableOutput([IO.Path]::GetDirectoryName($RequestPath)) }
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
    if ($null -ne $request.consoleMode -and ($request.consoleMode -isnot [string] -or $request.consoleMode -cnotin @('hidden', 'inherit'))) {
        throw 'consoleMode must be hidden or inherit'
    }
    # Missing mode retains protocol-1 compatibility with existing PTY requests.
    $owner.Start($request.executable, [string[]]$request.args, $request.cwd, $rawCommandLine, [string]$argv0, [bool]$request.windowsVerbatimArguments, $environmentEntries.ToArray(), ($request.consoleMode -ceq 'hidden'))
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
