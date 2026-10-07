import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = source => source.replace(/\r\n/g, '\n');

// Integrity and source-freshness checking only. These files are trusted shipped
// application code, not a writable runtime executable cache or a same-user sandbox.
// Hash-then-spawn does not make path reopening race-free against package replacement.
export function verifyWindowsProcessJobArtifacts({ helperSource, hostSource, manifest, executableBytes, projectSource }) {
  assert.equal(typeof helperSource, 'string', 'Missing native PowerShell source.');
  assert.equal(typeof hostSource, 'string', 'Missing native controller source.');
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Missing native executable provenance.');
  assert.ok(Buffer.isBuffer(executableBytes), 'Missing native executable bytes.');
  const native = helperSource.match(/\$native = @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  const block = helperSource.match(/# BEGIN VERIFIED NATIVE ASSEMBLY\r?\n([\s\S]*?)\r?\n# END VERIFIED NATIVE ASSEMBLY/)?.[1];
  assert.notEqual(native, undefined, 'Missing native owner source.');
  assert.ok(block, 'Missing embedded native assembly.');
  const sourceSha256 = digest(canonical(native));
  const hostSourceSha256 = digest(canonical(hostSource));
  const pinnedSource = block.match(/\$nativeSourceSha256 = '([a-f0-9]{64})'/)?.[1];
  const pinnedBinary = block.match(/\$nativeAssemblySha256 = '([a-f0-9]{64})'/)?.[1];
  const encoded = block.match(/\$nativeAssemblyBase64 = @'\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n'@/)?.[1].replace(/\s/g, '');
  assert.equal(pinnedSource, sourceSha256, 'Embedded native owner source is stale.');
  assert.ok(encoded && encoded.length <= 256 * 1024, 'Missing or oversized embedded assembly.');
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(bytes.toString('base64'), encoded, 'Embedded assembly is not canonical Base64.');
  assert.equal(digest(bytes), pinnedBinary, 'Embedded assembly digest mismatch.');
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ', 'Embedded assembly is not a PE image.');
  assert.equal(manifest.protocol, 1, 'Unknown native executable provenance protocol.');
  assert.ok(['clr4-anycpu', 'nativeaot-win-x64'].includes(manifest.runtime), 'Unknown native executable runtime.');
  if (manifest.runtime === 'nativeaot-win-x64') {
    assert.equal(typeof projectSource, 'string', 'Missing native AOT build configuration.');
    assert.equal(manifest.projectSourceSha256, digest(canonical(projectSource)), 'Native AOT build configuration is stale.');
  }
  assert.equal(manifest.nativeSourceSha256, sourceSha256, 'Native executable owner source is stale.');
  assert.equal(manifest.hostSourceSha256, hostSourceSha256, 'Native executable controller source is stale.');
  assert.ok(Number.isSafeInteger(manifest.binaryBytes) && manifest.binaryBytes > 0 && manifest.binaryBytes <= 4 * 1024 * 1024,
    'Invalid native executable size.');
  assert.equal(executableBytes.length, manifest.binaryBytes, 'Native executable size mismatch.');
  assert.equal(digest(executableBytes), manifest.binarySha256, 'Native executable digest mismatch.');
  assert.equal(executableBytes.subarray(0, 2).toString(), 'MZ', 'Native executable is not a PE image.');
  return Object.freeze({
    fallback: Object.freeze({ sourceSha256, assemblySha256: pinnedBinary, assemblyBytes: bytes.length }),
    companion: Object.freeze({ nativeSourceSha256: sourceSha256, hostSourceSha256, runtime: manifest.runtime,
      binarySha256: manifest.binarySha256, binaryBytes: executableBytes.length })
  });
}

function readBounded(file, limit) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= limit, 'Native artifact is not a bounded regular file.');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    assert.equal(count, stat.size, 'Native artifact changed size during its bounded read.');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

export function readWindowsProcessJobArtifacts(srcDirectory) {
  // Runtime callers supply only their fixed package directory. Never accept an
  // executable path from the manifest or create a per-user executable cache.
  const executable = path.join(srcDirectory, 'windows-process-job-host.exe');
  const proof = verifyWindowsProcessJobArtifacts({
    helperSource: readBounded(path.join(srcDirectory, 'windows-process-job.ps1'), 256 * 1024).toString('utf8'),
    hostSource: readBounded(path.join(srcDirectory, 'windows-process-job-host.cs'), 256 * 1024).toString('utf8'),
    manifest: JSON.parse(readBounded(path.join(srcDirectory, 'windows-process-job-host.manifest.json'), 16 * 1024).toString('utf8')),
    executableBytes: readBounded(executable, 4 * 1024 * 1024),
    projectSource: readBounded(path.join(srcDirectory, 'windows-process-job-host.csproj'), 16 * 1024).toString('utf8')
  });
  return Object.freeze({ executable, proof });
}
