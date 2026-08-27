import assert from 'node:assert/strict';
import { createSettingsUiService } from '../modules/uiux/generated/adapters/settings.js';
import { createUiScope } from '../modules/uiux/generated/runtime/scope.js';
import { createUiServiceRegistry } from '../modules/uiux/generated/runtime/service-registry.js';
import { createRustAssistantUiService } from '../modules/uiux/generated/adapters/rust-assistant.js';
import { createForumConfigUiService } from '../modules/uiux/generated/adapters/forum-config.js';
import { createAssistantRuntimeUiService } from '../modules/uiux/generated/adapters/assistant-runtime.js';
import { mountSemanticIcon } from '../modules/uiux/generated/primitives/semantic-icon.js';

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

let rustState = { debugMode: false };
const rustService = createRustAssistantUiService({
    get: () => rustState,
    save: async patch => { rustState = { ...rustState, ...patch }; return { success: true }; },
});
await rustService.refresh.execute();
assert.equal(rustService.state.get().debugMode, false);
await rustService.save.execute({ debugMode: true });
assert.equal(rustService.state.get().debugMode, true);
await rustService.dispose();

let forumState = { username: 'artifact-admin' };
const forumService = createForumConfigUiService({
    get: () => forumState,
    save: async patch => { forumState = { ...forumState, ...patch }; return { success: true }; },
});
await forumService.refresh.execute();
assert.equal(forumService.state.get().username, 'artifact-admin');
await forumService.save.execute({ username: 'artifact-next' });
assert.equal(forumService.state.get().username, 'artifact-next');
await forumService.dispose();

const timedForumService = createForumConfigUiService({
    get: () => ({ username: 'artifact-timeout' }),
    timeoutMs: 5,
    save: () => new Promise(() => {}),
});
const timedForumResult = await timedForumService.save.execute({ username: 'hung' });
assert.equal(timedForumResult.success, false);
assert.match(timedForumResult.error || '', /timed out/);
await timedForumService.dispose();

const runtimeService = createAssistantRuntimeUiService({ get: async () => ({ mode: 'rust', active: true }) });
await runtimeService.refresh.execute();
assert.equal(runtimeService.state.get().mode, 'rust');
await runtimeService.dispose();
assert.equal(typeof mountSemanticIcon, 'function');
console.log('UIUX generated artifact smoke passed (Settings + Rust + Forum + Runtime adapters + scoped registry + semantic icon contracts).');
