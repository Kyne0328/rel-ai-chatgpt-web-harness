import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWindowsProcessJobArtifacts, verifyWindowsProcessJobArtifacts } from '../src/windowsProcessJobArtifacts.js';

// Maintain the source-pinned companion and the PowerShell fallback assembly.
// Runtime selects the companion only when all shipped artifacts match.
// --check establishes digest integrity and source staleness, not reproducible-build
// equivalence. Framework csc may vary PE timestamps/MVIDs on each --write rebuild.
// --write requires .NET SDK 10.0.401 and the Windows native C++ toolchain, and
// prints compiler/runtime/reference provenance for a Windows rebuild receipt.
const helper = fileURLToPath(new URL('../src/windows-process-job.ps1', import.meta.url));
const hostPath = fileURLToPath(new URL('../src/windows-process-job-host.cs', import.meta.url));
const projectPath = fileURLToPath(new URL('../src/windows-process-job-host.csproj', import.meta.url));
const executablePath = fileURLToPath(new URL('../src/windows-process-job-host.exe', import.meta.url));
const manifestPath = fileURLToPath(new URL('../src/windows-process-job-host.manifest.json', import.meta.url));
const hostSource = fs.readFileSync(hostPath, 'utf8');
const canonicalHost = hostSource.replace(/\r\n/g, '\n');
const projectSource = fs.readFileSync(projectPath, 'utf8');
const projectSourceSha256 = digestProject(projectSource);
function digestProject(value) { return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex'); }
const mode = process.argv[2] || '--check';
assert.ok(process.argv.length <= 3 && ['--check', '--write'].includes(mode),
  'Usage: node scripts/generate-windows-process-job-native.mjs [--check|--write]');
const source = fs.readFileSync(helper, 'utf8');
const nativeMatch = source.match(/\$native = @'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nativeMatch, 'Cannot locate the native C# source.');
const native = nativeMatch[1].replace(/\r\n/g, '\n');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = digest(native);
const hostSourceSha256 = digest(canonicalHost);
const blockPattern = /# BEGIN VERIFIED NATIVE ASSEMBLY\r?\n[\s\S]*?\r?\n# END VERIFIED NATIVE ASSEMBLY/;
const block = source.match(blockPattern)?.[0];
assert.ok(block, 'Cannot locate the generated assembly block.');
if (mode === '--check') {
  console.log(JSON.stringify({ status: 'verified', ...readWindowsProcessJobArtifacts(path.dirname(helper)).proof }));
} else {
  assert.equal(process.platform, 'win32', 'Regenerate on Windows with PowerShell 5, the .NET Framework compiler, .NET SDK 10.0.401, and native C++ tools.');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const root = fs.mkdtempSync(path.join(process.env.REL_AI_EPHEMERAL_DIR || os.tmpdir(), 'relai-native-generator-'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const assembly = path.join(root, 'RelAiOwnedJob.dll');
    const companion = path.join(root, 'windows-process-job-host.exe');
    const nativeFile = path.join(root, 'native.cs');
    const hostFile = path.join(root, 'host.cs');
    const script = path.join(root, 'generate.ps1');
    fs.writeFileSync(nativeFile, native, 'utf8');
    fs.writeFileSync(hostFile, canonicalHost, 'utf8');
    fs.writeFileSync(script, "$ErrorActionPreference = 'Stop'\n"
      + '$nativePath = ' + quote(nativeFile) + '\n$hostPath = ' + quote(hostFile)
      + '\n$libraryPath = ' + quote(assembly) + '\n$executablePath = ' + quote(companion) + '\n'
      + "\n$provider = New-Object Microsoft.CSharp.CSharpCodeProvider\ntry {\n    foreach ($kind in @('library', 'executable')) {\n        $parameters = New-Object System.CodeDom.Compiler.CompilerParameters\n        $parameters.GenerateExecutable = $kind -eq 'executable'\n        $parameters.GenerateInMemory = $false\n        $parameters.CompilerOptions = '/optimize+ /platform:anycpu'\n        $parameters.OutputAssembly = if ($kind -eq 'library') { $libraryPath } else { $executablePath }\n        foreach ($name in @('System.dll', 'System.Core.dll', 'System.Xml.dll', 'System.Runtime.Serialization.dll')) { [void]$parameters.ReferencedAssemblies.Add($name) }\n        $files = if ($kind -eq 'library') { [string[]]@($nativePath) } else { [string[]]@($nativePath, $hostPath) }\n        $result = $provider.CompileAssemblyFromFile($parameters, [string[]]$files)\n        if ($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object { $_.ToString() }) -join '; ') }\n    }\n} finally { $provider.Dispose() }\n$compiler = [IO.Path]::Combine([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(), 'csc.exe')\n$serialization = [Reflection.Assembly]::Load('System.Runtime.Serialization, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')\n$sha = [Security.Cryptography.SHA256]::Create()\ntry {\n    $compilerHash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($compiler)))).Replace('-', '').ToLowerInvariant()\n    $references = @([object].Assembly, [ComponentModel.Win32Exception].Assembly, [Linq.Enumerable].Assembly, [Xml.XmlReader].Assembly, $serialization | ForEach-Object {\n        @{ identity = $_.FullName; version = [Diagnostics.FileVersionInfo]::GetVersionInfo($_.Location).FileVersion; sha256 = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($_.Location)))).Replace('-', '').ToLowerInvariant() }\n    })\n} finally { $sha.Dispose() }\n@{ powershell = $PSVersionTable.PSVersion.ToString(); clr = [Environment]::Version.ToString(); compilerPath = $compiler; compilerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).FileVersion; compilerSha256 = $compilerHash; compilerOptions = '/optimize+ /platform:anycpu'; references = $references } | ConvertTo-Json -Compress -Depth 4\n", 'utf8');
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || 'Native compilation failed.');
    // Publish the identical owner/controller as native machine code; the fallback
    // remains the CLR4 library above. No managed runtime installation at launch.
    fs.writeFileSync(path.join(root, 'host.csproj'), projectSource);
    const sdk = '10.0.401';
    fs.writeFileSync(path.join(root, 'global.json'), JSON.stringify({ sdk: { version: sdk, rollForward: 'disable' } }));
    const publishArgs = ['publish', 'host.csproj', '-c', 'Release', '-r', 'win-x64', '-o', 'published'];
    // An explicit local package feed is useful for offline build machines. NuGet
    // still validates packages; this never affects runtime artifact selection.
    if (process.env.REL_AI_NATIVE_NUGET_SOURCE) publishArgs.push('--source', process.env.REL_AI_NATIVE_NUGET_SOURCE);
    const published = spawnSync('dotnet', publishArgs, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
    assert.equal(published.error, undefined, published.error?.message);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const packageRoot = process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
    const runtimePackage = path.join(packageRoot, 'microsoft.netcore.app.runtime.nativeaot.win-x64', '10.0.12');
    const runtimeNotices = ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'].map(name => ({ name, bytes: fs.readFileSync(path.join(runtimePackage, name)) }));
    const bytes = fs.readFileSync(assembly), companionBytes = fs.readFileSync(path.join(root, 'published', 'windows-process-job-host.exe'));
    const encoded = bytes.toString('base64').match(/.{1,120}/g).join('\n');
    const generated = [
      '# BEGIN VERIFIED NATIVE ASSEMBLY',
      '# Generated only from the C# above: node scripts/generate-windows-process-job-native.mjs --write',
      '# The trusted script pins both hashes; runtime never trusts external cache metadata.',
      "$nativeSourceSha256 = '" + sourceSha256 + "'",
      "$nativeAssemblySha256 = '" + digest(bytes) + "'",
      "$nativeAssemblyBase64 = @'",
      encoded,
      "'@",
      '# END VERIFIED NATIVE ASSEMBLY'
    ].join('\n');
    const manifest = {
      protocol: 1, runtime: 'nativeaot-win-x64', nativeSourceSha256: sourceSha256, hostSourceSha256, projectSourceSha256,
      binarySha256: digest(companionBytes), binaryBytes: companionBytes.length,
      provenance: { fallback: JSON.parse(result.stdout.trim()), companion: { sdk, runtime: '10.0.12', runtimeIdentifier: 'win-x64', projectSourceSha256 } }
    };
    const generatedHelper = source.replace(blockPattern, generated);
    const proof = verifyWindowsProcessJobArtifacts({ helperSource: generatedHelper, hostSource, manifest, executableBytes: companionBytes, projectSource });
    // These are fixed first-party application-code artifacts, not a per-user
    // executable cache. A digest check does not defeat hostile package replacement.
    // A partial/interrupted publication fails --check and runtime selection.
    assert.equal(fs.readFileSync(helper, 'utf8'), source, 'Helper changed while compiling; retry after reviewing it.');
    assert.equal(fs.readFileSync(hostPath, 'utf8'), hostSource, 'Controller changed while compiling; retry after reviewing it.');
    assert.equal(fs.readFileSync(projectPath, 'utf8'), projectSource, 'Build configuration changed while compiling; retry after reviewing it.');
    fs.writeFileSync(executablePath, companionBytes);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.writeFileSync(helper, generatedHelper, 'utf8');
    const noticeDirectory = path.join(path.dirname(helper), 'windows-process-job-licenses');
    fs.mkdirSync(noticeDirectory, { recursive: true });
    for (const { name, bytes: noticeBytes } of runtimeNotices) fs.writeFileSync(path.join(noticeDirectory, name), noticeBytes);
    console.log(JSON.stringify({ status: 'regenerated', ...proof, provenance: manifest.provenance }));
  } finally {
    // Only this invocation's unique temporary fixture is eligible for cleanup.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
