// NativeAOT entry point for the existing RelAiOwnedJob native owner.
// The request, target environment, streams, control and completion proof protocol
// are shared with windows-process-job.ps1. No PowerShell host is needed here.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;

public static class RelAiJobController {
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFileExW(string existing, string destination, uint flags);
    const int JsonLimit = 1048576;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    static Dictionary<string, object> receipt;
    static RelAiOwnedJob owner;
    static string receiptPath, controlPath, nonce;
    static long mainEntered;
    static bool profile;
    static void Mark(string stage) {
        if (profile) receipt["profile_" + stage] = (DateTime.UtcNow.Ticks - mainEntered).ToString(CultureInfo.InvariantCulture);
    }
    static object Get(Dictionary<string, object> map, string key) {
        object value; return map.TryGetValue(key, out value) ? value : null;
    }
    static Dictionary<string, object> ReadJson(byte[] bytes) {
        if (bytes.Length > JsonLimit) throw new ArgumentException("Owned-job JSON is too large");
        return RelAiJobJson.Parse(new UTF8Encoding(false, true).GetString(bytes));
    }
    static Dictionary<string, object> Read(string file) {
        using (FileStream stream = File.OpenRead(file)) {
            long length = stream.Length;
            if (length > JsonLimit) throw new ArgumentException("Owned-job JSON is too large");
            byte[] bytes = new byte[(int)length + 1];
            int count = 0, read;
            while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) > 0) count += read;
            if (count != length) throw new ArgumentException("Owned-job JSON changed during read");
            Array.Resize(ref bytes, count);
            return ReadJson(bytes);
        }
    }
    static void JsonString(StringBuilder output, string value) {
        output.Append('"');
        foreach (char c in value) {
            if (c == '"' || c == '\\') output.Append('\\').Append(c);
            else if (c < 32 || Char.IsSurrogate(c)) output.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else output.Append(c);
        }
        output.Append('"');
    }
    static byte[] ReceiptJson() {
        StringBuilder output = new StringBuilder("{");
        bool first = true;
        foreach (KeyValuePair<string, object> item in receipt) {
            if (!first) output.Append(',');
            first = false; JsonString(output, item.Key); output.Append(':');
            if (item.Value == null) output.Append("null");
            else if (item.Value is string) JsonString(output, (string)item.Value);
            else if (item.Value is bool) output.Append((bool)item.Value ? "true" : "false");
            else if (item.Value is int || item.Value is uint) output.Append(Convert.ToString(item.Value, CultureInfo.InvariantCulture));
            else throw new InvalidOperationException("Invalid native receipt value type");
        }
        return Utf8.GetBytes(output.Append('}').ToString());
    }
    static bool Protocol(Dictionary<string, object> value) {
        object version = Get(value, "protocol");
        return version is int && (int)version == 1;
    }
    static bool ValidNonce(string value) {
        if (value == null || value.Length < 32 || value.Length > 128) return false;
        foreach (char c in value) if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') && !(c >= 'A' && c <= 'F')) return false;
        return true;
    }
    static void WriteReceipt() {
        receipt["sequence"] = (int)receipt["sequence"] + 1;
        receipt["updatedAt"] = DateTime.UtcNow.ToString("o");
        string temporary = receiptPath + "." + GetCurrentProcessId() + ".tmp";
        File.WriteAllBytes(temporary, ReceiptJson());
        // Same-directory atomic rename, including replacement. ReplaceFile's
        // destination metadata/stream merging is unnecessary for private receipts.
        if (!MoveFileExW(temporary, receiptPath, 1))
            throw new IOException("Atomic receipt publication failed: " + Marshal.GetLastWin32Error());
    }
    static void UpdateFacts() {
        receipt["commandStarted"] = owner.CommandStarted;
        receipt["rootPid"] = owner.RootPid;
        receipt["rootCreationIdentity"] = owner.RootCreationIdentity;
        receipt["activeProcesses"] = owner.ActiveProcesses();
        bool exited = owner.RootExited();
        receipt["rootExited"] = exited;
        if (exited) receipt["rootExitCode"] = owner.RootExitCode();
    }
    static string ReadStopReason() {
        Dictionary<string, object> control = Read(controlPath);
        if (!Protocol(control) || !String.Equals(Get(control, "nonce") as string, nonce, StringComparison.Ordinal)
            || !String.Equals(Get(control, "action") as string, "stop", StringComparison.Ordinal))
            throw new ArgumentException("Invalid owned-job control request");
        string reason = Get(control, "reason") as string;
        return reason == "cancel" || reason == "timeout" || reason == "stop" ? reason : "stop";
    }
    static string[] EnvironmentEntries(Dictionary<string, object> request) {
        string transportKey = "REL_AI_JOB_ENV_" + nonce;
        if (!String.Equals(Get(request, "environmentTransportKey") as string, transportKey, StringComparison.Ordinal))
            throw new ArgumentException("Invalid private environment transport key");
        string payload = Environment.GetEnvironmentVariable(transportKey, EnvironmentVariableTarget.Process);
        if (String.IsNullOrEmpty(payload) || payload.Length > 24000)
            throw new ArgumentException("Missing or oversized private target environment payload");
        Dictionary<string, object> transport;
        Environment.SetEnvironmentVariable(transportKey, null, EnvironmentVariableTarget.Process);
        try { transport = RelAiJobJson.Parse(payload); }
        catch { throw new ArgumentException("Invalid private target environment payload"); }
        if (transport == null || !Protocol(transport)
            || !String.Equals(Get(transport, "nonce") as string, nonce, StringComparison.Ordinal)
            || !(Get(transport, "entries") is object[]))
            throw new ArgumentException("Invalid private target environment payload");
        Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        List<string> entries = new List<string>();
        foreach (object item in (object[])transport["entries"]) {
            object[] entry = item as object[];
            if (entry == null || entry.Length != 2 || !(entry[0] is string) || !(entry[1] is string))
                throw new ArgumentException("Invalid or duplicate target environment entry");
            string key = (string)entry[0], value = (string)entry[1];
            if (key.Length == 0 || key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0 || seen.ContainsKey(key))
                throw new ArgumentException("Invalid or duplicate target environment entry");
            seen.Add(key, true);
            entries.Add(key + "=" + value);
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        return entries.ToArray();
    }
    static Dictionary<string, string> Arguments(string[] args) {
        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (args.Length != 6) throw new ArgumentException("Expected request, receipt and control paths");
        for (int i = 0; i < args.Length; i += 2) {
            if ((args[i] != "-RequestPath" && args[i] != "-ReceiptPath" && args[i] != "-ControlPath")
                || values.ContainsKey(args[i]) || !Path.IsPathRooted(args[i + 1]))
                throw new ArgumentException("Invalid controller argument");
            values.Add(args[i], args[i + 1]);
        }
        if (values.Count != 3) throw new ArgumentException("Incomplete controller arguments");
        return values;
    }
    public static int Main(string[] args) {
        mainEntered = DateTime.UtcNow.Ticks;
        profile = Environment.GetEnvironmentVariable("REL_AI_JOB_PROFILE") == "1";
        return Run(args);
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Run(string[] args) {
        int exitCode = 125;
        try {
            Dictionary<string, string> paths = Arguments(args);
            receiptPath = paths["-ReceiptPath"]; controlPath = paths["-ControlPath"];
            Dictionary<string, object> request = Read(paths["-RequestPath"]);
            nonce = Get(request, "nonce") as string;
            if (!Protocol(request) || !ValidNonce(nonce))
                throw new ArgumentException("Invalid owned-job protocol or nonce");
            receipt = new Dictionary<string, object> {
                {"protocol", 1}, {"nonce", nonce}, {"helperPid", (int)GetCurrentProcessId()}, {"sequence", 0},
                {"rootPid", null}, {"rootCreationIdentity", null}, {"rootExitCode", null}, {"rootExited", false},
                {"activeProcesses", null}, {"commandStarted", false}, {"startupFailedBeforeCommand", false},
                {"jobComplete", false}, {"cleanupConfirmed", false}, {"final", false},
                {"stopReason", null}, {"error", null}, {"updatedAt", null}, {"nativeImplementation", "executable"}
            };
            if (profile) receipt["profile_mainEntered"] = mainEntered.ToString(CultureInfo.InvariantCulture);
            Mark("requestRead");
            string executable = Get(request, "executable") as string;
            if (executable == null || !Path.IsPathRooted(executable) || executable.IndexOf('\0') >= 0 || !File.Exists(executable))
                throw new ArgumentException("An existing absolute native executable is required");
            string cwd = Get(request, "cwd") as string;
            if (cwd == null || !Path.IsPathRooted(cwd) || !Directory.Exists(cwd))
                throw new ArgumentException("An existing absolute working directory is required");
            object[] requestedArgs = Get(request, "args") as object[];
            if (requestedArgs == null) throw new ArgumentException("args must be an array of strings");
            string[] targetArgs = new string[requestedArgs.Length];
            for (int i = 0; i < requestedArgs.Length; i++) {
                if (!(requestedArgs[i] is string)) throw new ArgumentException("args must contain only strings");
                targetArgs[i] = (string)requestedArgs[i];
            }
            object raw = Get(request, "rawCommandLine");
            if (raw != null && (!(raw is string) || !String.Equals(Path.GetFileName(executable), "cmd.exe", StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("rawCommandLine is restricted to the prepared cmd.exe shell path");
            owner = new RelAiOwnedJob();
            Mark("jobCreated");
            WriteReceipt(); // The private metadata destination must work before caller code.
            Mark("initialReceiptWritten");
            if (File.Exists(controlPath)) {
                receipt["stopReason"] = ReadStopReason();
                throw new InvalidOperationException("Owned job stopped before command startup");
            }
            string[] environment = EnvironmentEntries(request);
            Mark("environmentParsed");
            object argv0 = Get(request, "argv0"), verbatim = Get(request, "windowsVerbatimArguments");
            if (argv0 != null && !(argv0 is string)) throw new ArgumentException("argv0 must be a string");
            if (verbatim != null && !(verbatim is bool)) throw new ArgumentException("windowsVerbatimArguments must be a boolean");
            owner.Start(executable, targetArgs, cwd, raw as string, argv0 as string, verbatim != null && (bool)verbatim, environment);
            Mark("targetStarted");
            UpdateFacts(); WriteReceipt();
            bool lastRootExited = (bool)receipt["rootExited"];
            uint lastActive = (uint)receipt["activeProcesses"];
            DateTime? stopDeadline = null;
            while (true) {
                UpdateFacts();
                if ((uint)receipt["activeProcesses"] == 0 && (bool)receipt["rootExited"]) {
                    receipt["jobComplete"] = true; receipt["cleanupConfirmed"] = true; receipt["final"] = true;
                    Mark("complete");
                    WriteReceipt();
                    exitCode = (int)Math.Min((long)(uint)receipt["rootExitCode"], Int32.MaxValue);
                    break;
                }
                if (receipt["stopReason"] == null && File.Exists(controlPath)) {
                    receipt["stopReason"] = ReadStopReason();
                    owner.Stop(); stopDeadline = DateTime.UtcNow.AddSeconds(10); WriteReceipt();
                }
                if (stopDeadline.HasValue && DateTime.UtcNow > stopDeadline.Value)
                    throw new InvalidOperationException("Owned job termination was not confirmed within 10 seconds");
                if (lastRootExited != (bool)receipt["rootExited"] || lastActive != (uint)receipt["activeProcesses"]) {
                    WriteReceipt(); lastRootExited = (bool)receipt["rootExited"]; lastActive = (uint)receipt["activeProcesses"];
                }
                owner.WaitForChange(25);
            }
        } catch (Exception error) {
            string failure = error.Message;
            if (receipt != null) {
                if (owner != null) {
                    receipt["commandStarted"] = owner.CommandStarted; receipt["rootPid"] = owner.RootPid;
                    try {
                        owner.Stop();
                        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
                        do {
                            UpdateFacts();
                            if ((uint)receipt["activeProcesses"] == 0 && (owner.RootPid == 0 || (bool)receipt["rootExited"])) {
                                receipt["jobComplete"] = true; receipt["cleanupConfirmed"] = true; break;
                            }
                            Thread.Sleep(25);
                        } while (DateTime.UtcNow < deadline);
                    } catch (Exception cleanup) { failure += "; cleanup: " + cleanup.Message; }
                } else {
                    receipt["activeProcesses"] = 0; receipt["jobComplete"] = true; receipt["cleanupConfirmed"] = true;
                }
                receipt["startupFailedBeforeCommand"] = !(bool)receipt["commandStarted"];
                receipt["error"] = failure; receipt["final"] = true;
                try { WriteReceipt(); } catch { }
            }
            // Target stdout/stderr never carry control messages.
        } finally { if (owner != null) owner.Dispose(); }
        return exitCode;
    }
}
