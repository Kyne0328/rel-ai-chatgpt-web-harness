import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import {
  createUpdateInstallMarker,
  markUpdateInstallPhase,
  readUpdateInstallMarker,
  updateInstallLaunchGuard
} from '../electron/update-install-marker.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-update-marker-race-'));
const app = { getPath: name => { assert.equal(name, 'userData'); return directory; } };
const launchOptions = { platform: 'win32', packaged: true, argv: [], isProcessAlive: () => true };
const originalAsyncWrite = fs.promises.writeFile;
const originalSyncWrite = fs.writeFileSync;
const originalOpen = fs.open;
const originalOpenSync = fs.openSync;
const overwriteOptions = options => options && typeof options === 'object' ? { ...options, flag: 'w' } : options;
let releaseWrite = () => {};
try {
  await createUpdateInstallMarker(app, { targetVersion: '1.1.4' });
  let markWriteStarted;
  const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
  const writeBarrier = new Promise(resolve => { releaseWrite = resolve; });
  let intercepted = false;
  fs.promises.writeFile = async (file, data, options) => {
    if (!intercepted && path.dirname(String(file)) === directory) {
      intercepted = true;
      await originalAsyncWrite(file, '', options);
      markWriteStarted();
      await writeBarrier;
      return originalAsyncWrite(file, data, overwriteOptions(options));
    }
    return originalAsyncWrite(file, data, options);
  };
  fs.open = (file, ...args) => {
    const callback = args.pop();
    return originalOpen(file, ...args, (error, descriptor) => {
      if (!intercepted && !error && path.dirname(String(file)) === directory && String(args[0]).includes('w')) {
        intercepted = true;
        markWriteStarted();
        void writeBarrier.then(() => callback(error, descriptor));
      } else callback(error, descriptor);
    });
  };
  syncBuiltinESMExports();
  const phaseWrite = markUpdateInstallPhase(app, 'stopping');
  await writeStarted;
  const concurrentLaunch = updateInstallLaunchGuard(app, launchOptions);
  releaseWrite();
  await phaseWrite;
  fs.promises.writeFile = originalAsyncWrite;
  fs.open = originalOpen;
  syncBuiltinESMExports();
  assert.equal(concurrentLaunch.blocked, true, 'a reader during an asynchronous phase write must still see the prior complete install marker');
  assert.equal(readUpdateInstallMarker(app).phase, 'stopping');

  let duringSyncWrite;
  fs.writeFileSync = (file, data, options) => {
    if (path.dirname(String(file)) === directory) {
      originalSyncWrite(file, '', options);
      duringSyncWrite = updateInstallLaunchGuard(app, launchOptions);
      return originalSyncWrite(file, data, overwriteOptions(options));
    }
    return originalSyncWrite(file, data, options);
  };
  fs.openSync = (file, flags, ...args) => {
    const descriptor = originalOpenSync(file, flags, ...args);
    if (path.dirname(String(file)) === directory && String(flags).includes('w')) {
      duringSyncWrite = updateInstallLaunchGuard(app, launchOptions);
    }
    return descriptor;
  };
  syncBuiltinESMExports();
  const updatedLaunch = updateInstallLaunchGuard(app, { ...launchOptions, argv: ['--updated'] });
  fs.writeFileSync = originalSyncWrite;
  fs.openSync = originalOpenSync;
  syncBuiltinESMExports();
  assert.equal(updatedLaunch.reason, 'updated_launch');
  assert.equal(duringSyncWrite?.blocked, true, 'a concurrent reader during the synchronous updated-launch phase must not discard the install lock');
  assert.equal(readUpdateInstallMarker(app).phase, 'starting');
  console.log('Update marker readers never observe partially written phase state.');
} finally {
  releaseWrite();
  fs.promises.writeFile = originalAsyncWrite;
  fs.open = originalOpen;
  fs.writeFileSync = originalSyncWrite;
  fs.openSync = originalOpenSync;
  syncBuiltinESMExports();
  fs.rmSync(directory, { recursive: true, force: true });
}
