import type {
    UiCommand,
    UiDisposer,
    UiReadable,
    UiServiceDefinition,
    UiSnapshot,
} from '../contracts.js';

export type SettingsState = Readonly<Record<string, unknown>>;
export type SettingsPatch = Readonly<Record<string, unknown>>;

export interface SettingsSaveResult {
    readonly success: boolean;
    readonly error?: string;
}

export interface SettingsUiService {
    readonly state: UiReadable<SettingsState>;
    readonly save: UiCommand<SettingsPatch, SettingsSaveResult>;
    readonly dispose?: UiDisposer;
}

export interface SettingsUiAdapterInput {
    readonly get: () => SettingsState;
    readonly save: (patch: SettingsPatch) => Promise<SettingsSaveResult> | SettingsSaveResult;
    readonly subscribe?: (listener: (state: SettingsState) => void) => UiDisposer;
}

function freezeState(value: SettingsState): SettingsState {
    return Object.freeze({ ...(value || {}) });
}

export function createSettingsUiService(input: SettingsUiAdapterInput): SettingsUiService {
    if (!input || typeof input.get !== 'function' || typeof input.save !== 'function') {
        throw new TypeError('SettingsUiAdapter requires get() and save().');
    }
    let state = freezeState(input.get());
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let saveGeneration = 0;
    const listeners = new Set<(value: SettingsState, snapshot: UiSnapshot<SettingsState>) => void>();
    const snapshot = (): UiSnapshot<SettingsState> => Object.freeze({
        value: state,
        revision,
        source,
    });
    const publish = (next: SettingsState, nextSource: string) => {
        if (disposed) return snapshot();
        state = freezeState(next);
        revision += 1;
        source = nextSource;
        const nextSnapshot = snapshot();
        listeners.forEach(listener => listener(state, nextSnapshot));
        return nextSnapshot;
    };
    const externalRelease = input.subscribe?.(next => publish(next, 'settings-external')) || null;
    const service: SettingsUiService = {
        state: {
            get: () => state,
            getSnapshot: snapshot,
            subscribe(listener, options = {}) {
                if (disposed) return () => {};
                listeners.add(listener);
                if (options.immediate !== false) listener(state, snapshot());
                let active = true;
                return () => {
                    if (!active) return;
                    active = false;
                    listeners.delete(listener);
                };
            },
        },
        save: {
            async execute(patch) {
                if (disposed) return Object.freeze({ success: false, error: '设置服务已销毁' });
                const generation = ++saveGeneration;
                const result = await input.save(Object.freeze({ ...patch }));
                if (!result?.success) return Object.freeze({ success: false, error: result?.error || '设置保存失败' });
                // A newer save owns publication rights. The older IPC result
                // may still settle, but must not roll the UI snapshot back.
                if (disposed || generation !== saveGeneration) return Object.freeze({ success: true });
                publish({ ...state, ...patch }, 'settings-save');
                return Object.freeze({ success: true });
            },
        },
    };
    // The adapter is itself a UI-owned resource when external settings updates
    // exist; callers should register this disposer with their UiScope.
    Object.defineProperty(service, 'dispose', {
        value: () => {
            if (disposed) return;
            disposed = true;
            saveGeneration += 1;
            listeners.clear();
            return externalRelease?.();
        },
        enumerable: false,
    });
    return Object.freeze(service);
}

export const settingsUiDefinition: UiServiceDefinition<SettingsUiService> = {
    id: 'settings-ui',
    provide: context => {
        const service = context.services.settings;
        if (!service || typeof (service as SettingsUiService).save?.execute !== 'function') {
            throw new TypeError('SettingsUiDefinition requires a SettingsUiService.');
        }
        return service as SettingsUiService;
    },
};
