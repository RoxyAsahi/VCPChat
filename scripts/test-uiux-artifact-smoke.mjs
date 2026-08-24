import assert from 'node:assert/strict';
import { createSettingsUiService } from '../modules/uiux/generated/adapters/settings.js';

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
console.log('UIUX generated artifact smoke passed (SettingsUiService runtime contract).');
