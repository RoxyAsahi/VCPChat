function freezeState(value) {
    return Object.freeze({ ...(value || {}) });
}
export function createSettingsUiService(input) {
    if (!input || typeof input.get !== 'function' || typeof input.save !== 'function') {
        throw new TypeError('SettingsUiAdapter requires get() and save().');
    }
    let state = freezeState(input.get());
    let revision = 0;
    let source = 'initial';
    const listeners = new Set();
    const snapshot = () => Object.freeze({
        value: state,
        revision,
        source,
    });
    const publish = (next, nextSource) => {
        state = freezeState(next);
        revision += 1;
        source = nextSource;
        const nextSnapshot = snapshot();
        listeners.forEach(listener => listener(state, nextSnapshot));
        return nextSnapshot;
    };
    const externalRelease = input.subscribe?.(next => publish(next, 'settings-external')) || null;
    const service = {
        state: {
            get: () => state,
            getSnapshot: snapshot,
            subscribe(listener, options = {}) {
                listeners.add(listener);
                if (options.immediate !== false)
                    listener(state, snapshot());
                let active = true;
                return () => {
                    if (!active)
                        return;
                    active = false;
                    listeners.delete(listener);
                };
            },
        },
        save: {
            async execute(patch) {
                const result = await input.save(Object.freeze({ ...patch }));
                if (!result?.success)
                    return Object.freeze({ success: false, error: result?.error || '设置保存失败' });
                publish({ ...state, ...patch }, 'settings-save');
                return Object.freeze({ success: true });
            },
        },
    };
    // The adapter is itself a UI-owned resource when external settings updates
    // exist; callers should register this disposer with their UiScope.
    Object.defineProperty(service, 'dispose', {
        value: () => externalRelease?.(),
        enumerable: false,
    });
    return Object.freeze(service);
}
export const settingsUiDefinition = {
    id: 'settings-ui',
    provide: context => {
        const service = context.services.settings;
        if (!service || typeof service.save?.execute !== 'function') {
            throw new TypeError('SettingsUiDefinition requires a SettingsUiService.');
        }
        return service;
    },
};
