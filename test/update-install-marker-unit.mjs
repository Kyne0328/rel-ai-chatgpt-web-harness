import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STALE_UPDATE_MARKER_MS,
  clearUpdateInstallMarker,
  createUpdateInstallMarker,
  readUpdateInstallMarker,
  updateInstallLaunchGuard,
  updateInstallMarkerPath
} from '../electron/update-install-marker.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-update-marker-'));
const app = { getPath: name => {
  assert.equal(name, 'userData');
  return root;
} };

try {
  assert.equal(readUpdateInstallMarker(app), null);
  assert.equal(updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: [] }).blocked, false);

  const created = await createUpdateInstallMarker(app, { targetVersion: 'v1.1.0' });
  assert.equal(created.targetVersion, '1.1.0');
  assert.equal(fs.existsSync(updateInstallMarkerPath(app)), true);

  const blocked = updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: [] });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'update_in_progress');
  assert.equal(blocked.marker.targetVersion, '1.1.0');

  const nonWindows = updateInstallLaunchGuard(app, { platform: 'linux', packaged: true, argv: [] });
  assert.equal(nonWindows.blocked, false);
  assert.equal(fs.existsSync(updateInstallMarkerPath(app)), true, 'non-Windows startup must not consume a Windows update marker');

  const updatedLaunch = updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: ['--updated'] });
  assert.equal(updatedLaunch.blocked, false);
  assert.equal(updatedLaunch.reason, 'updated_launch');
  assert.equal(fs.existsSync(updateInstallMarkerPath(app)), false, 'the installer-launched replacement app must clear the marker');

  await createUpdateInstallMarker(app, { targetVersion: '1.1.1' });
  const marker = readUpdateInstallMarker(app);
  const staleNow = Date.parse(marker.startedAt) + STALE_UPDATE_MARKER_MS + 1;
  const stale = updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: [], nowMs: staleNow });
  assert.equal(stale.blocked, false);
  assert.equal(stale.reason, 'stale_marker');
  assert.equal(fs.existsSync(updateInstallMarkerPath(app)), false, 'a stale marker must not permanently lock users out of Rel.AI');

  fs.writeFileSync(updateInstallMarkerPath(app), '{not-json', 'utf8');
  assert.equal(readUpdateInstallMarker(app), null);
  assert.equal(fs.existsSync(updateInstallMarkerPath(app)), false, 'corrupt update state must fail open after being discarded');

  await createUpdateInstallMarker(app, { targetVersion: '1.1.2' });
  assert.equal(await clearUpdateInstallMarker(app), true);
  assert.equal(await clearUpdateInstallMarker(app), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Windows update-install marker guard tests passed.');
