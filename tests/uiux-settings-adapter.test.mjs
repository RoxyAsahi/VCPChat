import assert from 'node:assert/strict';
import test from 'node:test';

const { createSettingsUiService } = await import('../modules/uiux/adapters/settings.ts');

test('typed SettingsUiService publishes only committed patches and releases external updates', async () => {
    let state = { currentThemeMode: 'light', density: 'comfortable' };
    let fail = true;
    const external = new Set();
    const service = createSettingsUiService({
        get: () => state,
        save: async patch => {
            if (fail) return { success: false, error: 'denied' };
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
    assert.deepEqual(revisions, [0]);
    const denied = await service.save.execute({ density: 'compact' });
    assert.deepEqual(denied, { success: false, error: 'denied' });
    assert.equal(service.state.get().density, 'comfortable');
    assert.deepEqual(revisions, [0]);
    fail = false;
    const saved = await service.save.execute({ density: 'compact' });
    assert.deepEqual(saved, { success: true });
    assert.equal(service.state.get().density, 'compact');
    assert.deepEqual(revisions, [0, 1]);
    external.forEach(listener => listener({ currentThemeMode: 'dark', density: 'compact' }));
    assert.equal(service.state.get().currentThemeMode, 'dark');
    assert.deepEqual(revisions, [0, 1, 2]);
    release();
    await service.dispose?.();
    assert.equal(external.size, 0);
});
