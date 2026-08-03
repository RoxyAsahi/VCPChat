import assert from 'node:assert/strict';
import { createRendererLifecycleScope } from '../modules/ui-system/agent-renderer-lifecycle.js';

const cleared = [];
const listeners = new Map();
const host = {
    clearTimeout: (id) => cleared.push(['timeout', id]),
    clearInterval: (id) => cleared.push(['interval', id]),
    cancelAnimationFrame: (id) => cleared.push(['raf', id]),
};
const target = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
};
const scope = createRendererLifecycleScope(host);
scope.listen(target, 'click', () => {});
scope.trackTimeout(1);
scope.trackInterval(2);
scope.trackAnimationFrame(3);
assert.equal(listeners.size, 1);
scope.dispose();
scope.dispose();
assert.equal(listeners.size, 0);
assert.deepEqual(cleared.sort((left, right) => left[1] - right[1]), [
    ['timeout', 1], ['interval', 2], ['raf', 3],
]);
assert.equal(scope.disposed, true);
console.log('Agent Renderer lifecycle scope tests passed.');
