import assert from 'node:assert/strict';

import { clipBrowserSurfaceBounds, releaseBrowserRouteControl } from '../src/ui/features/browser/react.js';

assert.deepEqual(
  clipBrowserSurfaceBounds(
    { left: 24, top: 80, right: 744, bottom: 560 },
    900,
    700
  ),
  { visible: true, x: 24, y: 80, width: 720, height: 480 },
  'a fully visible browser slot must preserve its dashboard bounds'
);

assert.deepEqual(
  clipBrowserSurfaceBounds(
    { left: 12, top: 250, right: 628, bottom: 610 },
    640,
    360
  ),
  { visible: true, x: 12, y: 250, width: 616, height: 110 },
  'a browser slot extending below a short viewport must be clipped to the visible height'
);

assert.deepEqual(
  clipBrowserSurfaceBounds(
    { left: -80, top: -120, right: 420, bottom: 300 },
    640,
    480
  ),
  { visible: true, x: 0, y: 0, width: 420, height: 300 },
  'scrolling the browser slot partly above or left of the viewport must not shift an oversized native view into the window'
);

assert.deepEqual(
  clipBrowserSurfaceBounds(
    { left: 100, top: 500, right: 500, bottom: 800 },
    640,
    480
  ),
  { visible: false },
  'an off-screen browser slot must detach the native browser view'
);

assert.deepEqual(
  clipBrowserSurfaceBounds(
    { left: 100, top: 100, right: 800, bottom: 700 },
    640,
    480
  ),
  { visible: true, x: 100, y: 100, width: 540, height: 380 },
  'right and bottom edges must stay inside the dashboard viewport'
);

const controlCalls = [];
assert.equal(await releaseBrowserRouteControl({ setControl: async owner => { controlCalls.push(owner); } }), true);
assert.deepEqual(controlCalls, ['ai'], 'leaving the Browser route must return any user-owned browser session to AI control');
assert.equal(await releaseBrowserRouteControl({}), false, 'route cleanup must stay harmless when the desktop browser bridge is unavailable');
assert.equal(await releaseBrowserRouteControl({ setControl: async () => { throw new Error('no active browser'); } }), false, 'route cleanup must not surface teardown races as user-visible failures');

console.log('Browser UI bounds stay inside the visible dashboard viewport and route cleanup releases user takeover.');
