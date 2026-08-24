/**
 * Narrow named-slot contract for presentation extensions. A slot receives a
 * read-only snapshot and an owned root; it cannot access business IPC or
 * arbitrary selectors. Registration returns a disposer and late owners fail.
 */
/**
 * Target-mode additive Slot registry. This is intentionally kept in the
 * existing chat contract while it gains a second production consumer; it is
 * not exported through window and does not duplicate SurfaceController.
 */
export function createSlotRegistry({ allowedSlots = ['header', 'message-tail', 'chat.composer.leading'] } = {}) {
    const definitions = new Map();
    let disposed = false;
    const allowed = new Set(allowedSlots);
    // The first target-mode slice only implements additive list semantics.
    // Other Harness cardinalities remain explicit future work rather than
    // accepting a shape whose runtime behavior would be misleading.
    const kinds = new Set(['list']);
    const scopes = new Set(['surface', 'root', 'session-maybe', 'session']);
    let sequence = 0;
    return {
        register(slot, id, mount, options = {}) {
            if (disposed) throw new Error('ChatSurfaceSlots is disposed');
            if (!allowed.has(slot)) throw new Error(`Unsupported chat surface slot: ${slot}`);
            if (!id || typeof mount !== 'function') throw new TypeError('slot id and mount function are required');
            if (options.kind !== undefined && !kinds.has(options.kind)) throw new Error(`Unsupported chat slot kind: ${options.kind}`);
            if (options.scope !== undefined && !scopes.has(options.scope)) throw new Error(`Unsupported chat slot scope: ${options.scope}`);
            if (options.owner !== undefined && options.owner !== null && typeof options.owner.own !== 'function') {
                throw new TypeError('chat slot owner must expose own()');
            }
            const key = `${slot}:${id}`;
            if (definitions.has(key)) throw new Error(`Duplicate chat surface contribution: ${key}`);
            const definition = Object.freeze({
                slot,
                id: String(id),
                mount,
                kind: options.kind || 'list',
                scope: options.scope || 'surface',
                priority: Number.isFinite(options.priority) ? Number(options.priority) : 0,
                inject: options.inject,
                owner: options.owner || null,
                sequence: sequence++,
            });
            definitions.set(key, definition);
            let active = true;
            const dispose = () => {
                if (!active) return false;
                active = false;
                if (definitions.get(key) === definition) definitions.delete(key);
                return true;
            };
            try {
                if (definition.owner) definition.owner.own(dispose, `chat-slot:${key}`, 'slot-registration');
            } catch (error) {
                dispose();
                throw error;
            }
            return dispose;
        },
        mount(slot, root, snapshot, options = {}) {
            if (disposed) return [];
            const owned = [];
            const matches = [...definitions.values()]
                .filter(definition => definition.slot === slot)
                .sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
            const leadingAnchor = slot.endsWith('.leading') ? root.firstChild : null;
            for (const definition of matches) {
                const child = root.ownerDocument.createElement('span');
                child.dataset.chatSlotOwner = definition.id;
                if (slot.endsWith('.leading') && leadingAnchor) root.insertBefore(child, leadingAnchor);
                else root.appendChild(child);
                const mountScope = options.scope?.child?.(`chat-slot:${definition.id}`) || null;
                try {
                    const unmount = definition.mount(
                        child,
                        Object.freeze({ ...snapshot }),
                        Object.freeze({ slot, id: definition.id, kind: definition.kind, scope: definition.scope, inject: definition.inject, owner: mountScope })
                    );
                    owned.push(() => {
                        const result = typeof unmount === 'function' ? unmount() : undefined;
                        if (!result || typeof result.then !== 'function') {
                            child.remove();
                            void mountScope?.dispose?.('chat-slot-unmounted');
                            return undefined;
                        }
                        return Promise.resolve(result).finally(() => {
                            child.remove();
                            return mountScope?.dispose?.('chat-slot-unmounted');
                        });
                    });
                } catch (error) {
                    child.remove();
                    void mountScope?.dispose?.('chat-slot-mount-failed');
                    owned.splice(0).reverse().forEach(dispose => dispose());
                    throw error;
                }
            }
            return owned;
        },
        describe() {
            return Object.freeze([...definitions.values()].sort((left, right) => left.priority - right.priority || left.sequence - right.sequence).map(definition => Object.freeze({
                slot: definition.slot,
                id: definition.id,
                kind: definition.kind,
                scope: definition.scope,
                priority: definition.priority,
                hasInject: definition.inject !== undefined,
            })));
        },
        diagnostics() {
            return Object.freeze({ disposed, registrations: definitions.size, slots: this.describe() });
        },
        dispose() { disposed = true; [...definitions.values()].reverse().forEach(definition => { definitions.delete(`${definition.slot}:${definition.id}`); }); }
    };
}

/** Backward-compatible chat registry factory. */
export function createChatSurfaceSlots() {
    return createSlotRegistry();
}
