import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';

const windowRef = new EventTarget();
const marker = { dataset: { unsavedChanges: 'false' } };
globalThis.window = windowRef;
globalThis.location = new URL('http://127.0.0.1/dashboard#home');
globalThis.history = {
  replaceState(_state, _title, url) {
    globalThis.location.href = new URL(url, globalThis.location.href).href;
  }
};
globalThis.document = {
  activeElement: null,
  querySelector() { return marker.dataset.unsavedChanges === 'true' ? marker : null; },
  querySelectorAll() { return marker.dataset.unsavedChanges === 'true' ? [marker] : []; },
  getElementById() { return null; }
};

const router = await import('../src/ui/router.js');
const overlays = await import('../src/ui/overlay-store.js');
router.initRouter();
const initialSnapshot = router.getRouteSnapshot();
assert.equal(initialSnapshot.key, 'home');
assert.equal(router.getRouteSnapshot(), initialSnapshot, 'external-store snapshots must be referentially stable until a committed route changes');

marker.dataset.unsavedChanges = 'true';
dispatchTraversal('#activity?status=failed');
assert.equal(router.getRouteSnapshot().key, 'home', 'an unapproved browser traversal must not change rendered route state');
assert.ok(overlays.getOverlaySnapshot().modal, 'a dirty page must show the discard confirmation');
overlays.getOverlaySnapshot().modal.content.onCancel();
await yieldTurn();
assert.equal(router.getRouteSnapshot().key, 'home');
assert.equal(globalThis.location.hash, '#home', 'cancelling a traversal must restore the committed URL');

dispatchTraversal('#tasks?workspace=app');
assert.equal(router.getRouteSnapshot().key, 'home');
dispatchTraversal('#code?task=work-2&file=src%2Fmain.ts');
assert.equal(router.getRouteSnapshot().key, 'home', 'rapid navigation must remain behind the unresolved guard');
assert.equal(router.replaceRouteParams({ task: 'unapproved' }).get('task'), null, 'parameter helpers must read the committed route while a guard is pending');
overlays.getOverlaySnapshot().modal.content.onConfirm();
await yieldTurn();
assert.equal(router.getRouteSnapshot().key, 'code?task=work-2&file=src%2Fmain.ts', 'confirmation must commit the latest competing destination');
assert.equal(globalThis.location.hash, '#code?task=work-2&file=src%2Fmain.ts');
assert.equal(router.getRouteParams().get('task'), 'work-2');
assert.equal(router.getWorkspaceFilter(), '', 'committed route helpers must reflect the confirmed target');

console.log('Dashboard route authority keeps rendering and route helpers on the last approved hash until guards resolve.');

function dispatchTraversal(hash) {
  globalThis.location.hash = hash;
  windowRef.dispatchEvent(new Event('popstate'));
  windowRef.dispatchEvent(new Event('hashchange'));
}
