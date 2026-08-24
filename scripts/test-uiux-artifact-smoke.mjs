import assert from 'node:assert/strict';
import { createSettingsUiService } from '../modules/uiux/generated/adapters/settings.js';
import { createUiScope } from '../modules/uiux/generated/runtime/scope.js';
import { createUiServiceRegistry } from '../modules/uiux/generated/runtime/service-registry.js';

const lifecycleModule = await import('../modules/ui-system/lifecycle-scope.js');
const { LifecycleScope } = lifecycleModule.default || lifecycleModule;

let state = { userName: 'artifact-user', density: 'comfortable' };
const external = new Set();
const service = createSettingsUiService({
    get: () => state,
    save: async patch => {
        state = { ...state, ...patch };
        return { success: true };
    },
    subscribe: listener => {
        external.add(listener);
        return () => external.delete(listener);
    },
});
const revisions = [];
const release = service.state.subscribe((_value, snapshot) => revisions.push(snapshot.revision));
assert.equal(service.state.getSnapshot().value.userName, 'artifact-user');
assert.deepEqual(await service.save.execute({ userName: 'artifact-next' }), { success: true });
assert.equal(service.state.get().userName, 'artifact-next');
external.forEach(listener => listener({ density: 'compact' }));
assert.equal(service.state.get().userName, 'artifact-next');
assert.equal(service.state.get().density, 'compact');
await service.dispose();
release();
assert.equal(external.size, 0);
assert.deepEqual(revisions, [0, 1, 2]);

const owner = createUiScope(new LifecycleScope('artifact-registry'));
const registry = createUiServiceRegistry(owner);
let serviceDisposed = false;
const installed = registry.install({
    id: 'artifact-service',
    provide: () => ({ dispose: () => { serviceDisposed = true; } }),
});
assert.equal(registry.get('artifact-service'), installed);
await registry.release('artifact-service');
assert.equal(registry.get('artifact-service'), undefined);
assert.equal(serviceDisposed, true);
await registry.dispose();
await owner.dispose('artifact-smoke-complete');
console.log('UIUX generated artifact smoke passed (SettingsUiService + scoped registry contracts).');
