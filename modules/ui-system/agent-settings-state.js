import { createWorkbenchLifecycle } from './agent-workbench-lifecycle.js';
import { normalizeDiagnosticError } from './agent-config-diagnostics.js';

const DEFAULT_DELAY_MS = 500;

function cleanKey(value) {
    return String(value || '').trim();
}

export function profileSettingsTarget(profileId) {
    const id = cleanKey(profileId);
    return id ? `profile:${id}` : 'profile:unselected';
}

export function sessionSettingsTarget(sessionId) {
    const id = cleanKey(sessionId);
    return id ? `session:${id}` : 'session:unselected';
}

export function createAgentSettingsState({ delayMs = DEFAULT_DELAY_MS, lifecycle: injectedLifecycle } = {}) {
    const lifecycle = injectedLifecycle || createWorkbenchLifecycle(globalThis);
    const ownsLifecycle = !injectedLifecycle;
    const entries = new Map();
    const timerName = (targetKey, field) => `agent-settings:${cleanKey(targetKey)}:${cleanKey(field)}`;

    function entry(targetKey) {
        const key = cleanKey(targetKey);
        if (!key) throw new Error('Agent settings target is required');
        if (!entries.has(key)) {
            entries.set(key, {
                drafts: new Map(),
                statuses: new Map(),
                timers: new Map(),
                queue: Promise.resolve(),
            });
        }
        return entries.get(key);
    }

    function setDraft(targetKey, field, value) {
        const target = entry(targetKey);
        target.drafts.set(field, value);
        target.statuses.set(field, { state: 'dirty', message: '有修改尚未保存' });
        return value;
    }

    function value(targetKey, field, fallback) {
        const target = entries.get(cleanKey(targetKey));
        return target?.drafts.has(field) ? target.drafts.get(field) : fallback;
    }

    function status(targetKey, fields = []) {
        const target = entries.get(cleanKey(targetKey));
        if (!target) return { state: 'idle', message: '修改后自动保存' };
        const selected = (fields.length ? fields : [...target.statuses.keys()])
            .map((field) => target.statuses.get(field))
            .filter(Boolean);
        return selected.at(-1) || { state: 'idle', message: '修改后自动保存' };
    }

    function enqueue(targetKey, patch, save, successMessage = '已自动保存') {
        const target = entry(targetKey);
        const fields = Object.keys(patch || {});
        for (const field of fields) {
            setDraft(targetKey, field, patch[field]);
            target.statuses.set(field, { state: 'saving', message: '正在自动保存…' });
        }
        const operation = target.queue.then(async () => {
            const result = await save();
            for (const field of fields) {
                if (Object.is(target.drafts.get(field), patch[field])) target.drafts.delete(field);
                target.statuses.set(field, { state: 'saved', message: successMessage });
            }
            return result;
        }).catch((error) => {
            const conflict = error?.code === 'SESSION_CONFIG_CONFLICT'
                || error?.code === 'PROFILE_CONFIG_CONFLICT';
            for (const field of fields) {
                target.statuses.set(field, {
                    state: conflict ? 'conflict' : 'error',
                    message: error?.message || String(error),
                    error: normalizeDiagnosticError(error, conflict
                        ? 'SESSION_CONFIG_CONFLICT' : 'SETTINGS_SAVE_ERROR'),
                });
            }
            throw error;
        });
        target.queue = operation.catch(() => {});
        return operation;
    }

    function schedule(targetKey, field, callback) {
        const target = entry(targetKey);
        const name = timerName(targetKey, field);
        lifecycle.clear(name);
        lifecycle.timeout(name, () => {
            target.timers.delete(field);
            callback();
        }, delayMs);
        target.timers.set(field, name);
    }

    function clear(targetKey) {
        const key = cleanKey(targetKey);
        const target = entries.get(key);
        if (!target) return;
        for (const name of target.timers.values()) lifecycle.clear(name);
        entries.delete(key);
    }

    function dispose() {
        for (const key of [...entries.keys()]) clear(key);
        if (ownsLifecycle) lifecycle.dispose();
    }

    return { setDraft, value, status, enqueue, schedule, clear, dispose };
}
