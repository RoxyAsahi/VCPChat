import assert from 'node:assert/strict';
import { createRendererLifecycleScope } from '../modules/ui-system/agent-workbench-lifecycle.js';
import { createWorkbenchLifecycle } from '../modules/ui-system/agent-workbench-lifecycle.js';
import { createAgentRendererSession } from '../modules/ui-system/agent-presentation/fork/agent-renderer-session.js';

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

let nextHandle = 10;
const callbacks = new Map();
const cancelled = [];
const workbenchHost = {
    setTimeout(callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
    clearTimeout(handle) { callbacks.delete(handle); cancelled.push(handle); },
    setInterval(callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
    clearInterval(handle) { callbacks.delete(handle); cancelled.push(handle); },
    requestAnimationFrame(callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
    cancelAnimationFrame(handle) { callbacks.delete(handle); cancelled.push(handle); },
};
const workbench = createWorkbenchLifecycle(workbenchHost);
const replaced = workbench.timeout('search', () => {}, 10);
const active = workbench.timeout('search', () => {}, 10);
assert.equal(callbacks.has(replaced), false, 'replacing a named timer must cancel the old handle');
assert.equal(callbacks.has(active), true);
const frame = workbench.frame('render', () => {});
callbacks.get(frame)();
callbacks.delete(frame);
workbench.dispose();
assert.equal(callbacks.size, 0, 'dispose must clear every remaining named resource');
assert.equal(workbench.timeout('late', () => {}, 0), null, 'disposed scope must reject new timers');
assert.ok(cancelled.includes(replaced));

const rendererCallbacks = new Map();
let rendererHandle = 100;
const rendererCancelled = [];
const rendererHost = {
    setTimeout(callback) { const handle = rendererHandle++; rendererCallbacks.set(handle, callback); return handle; },
    clearTimeout(handle) { rendererCallbacks.delete(handle); rendererCancelled.push(handle); },
    requestAnimationFrame(callback) { const handle = rendererHandle++; rendererCallbacks.set(handle, callback); return handle; },
    cancelAnimationFrame(handle) { rendererCallbacks.delete(handle); rendererCancelled.push(handle); },
};
const rendererSession = createAgentRendererSession({}, rendererHost);
let oldGenerationRan = false;
const oldFrame = rendererSession.frame(() => { oldGenerationRan = true; });
rendererSession.update({ chatMessagesDiv: target });
assert.equal(rendererCallbacks.has(oldFrame), true);
rendererCallbacks.get(oldFrame)();
assert.equal(oldGenerationRan, false, 'a callback scheduled by an old render generation must not run');
let disposedRan = false;
const disposedFrame = rendererSession.frame(() => { disposedRan = true; });
const disposedWait = rendererSession.waitFrame();
rendererSession.dispose();
assert.equal(rendererCallbacks.has(disposedFrame), false, 'disposing a render Session must cancel pending frames');
assert.equal(disposedRan, false);
assert.ok(rendererCancelled.includes(disposedFrame));
assert.equal(await disposedWait, false, 'disposing a render Session must settle pending waits');
console.log('Agent Renderer lifecycle scope tests passed.');
