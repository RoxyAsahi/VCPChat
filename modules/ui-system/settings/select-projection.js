// select-projection — the bridge-side Select projection over the generated
// primitive (single portal implementation). Owns the per-form option-change
// observer, the roving keyboard glue (thread A contract gap) and the
// projection registry; the native select stays the sole business node.
const primitiveSelectStates = new Map();
const selectObserverStates = new Map();

export function createSelectProjection({ ensurePresentationScope }) {
    function mountSelectKeyboardGlue(select, cleanups) {
        const trigger = select.parentElement?.querySelector(':scope > .vcp-harness-select-trigger');
        if (!trigger) return;
        const openMenuItems = () => {
            const menuId = trigger.getAttribute('aria-controls');
            const menu = menuId ? document.getElementById(menuId) : null;
            if (!menu || menu.hidden) return null;
            return [...menu.querySelectorAll('.vcp-harness-menu-item:not(:disabled)')];
        };
        const focusSelectedItem = () => {
            const items = openMenuItems();
            if (!items?.length) return;
            const selected = items.find(item => item.dataset.selected === 'true') || items[0];
            selected.focus();
        };
        const moveFocus = (items, current, next) => {
            const count = items.length;
            if (!count) return;
            items[((next % count) + count) % count].focus();
        };
        const onTriggerKey = event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            if (trigger.getAttribute('aria-expanded') !== 'true') {
                trigger.click();
                requestAnimationFrame(focusSelectedItem);
                return;
            }
            const items = openMenuItems();
            if (!items?.length) return;
            const current = Math.max(0, items.findIndex(item => item.dataset.selected === 'true'));
            moveFocus(items, current, event.key === 'ArrowDown' ? current + 1 : current - 1);
        };
        const onDocumentKey = event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const target = event.target;
            if (!(target instanceof Element) || !target.classList.contains('vcp-harness-menu-item')) return;
            const items = openMenuItems();
            if (!items?.length) return;
            const current = items.indexOf(target);
            let next = current;
            if (event.key === 'ArrowDown') next = current + 1;
            else if (event.key === 'ArrowUp') next = current - 1;
            else if (event.key === 'Home') next = 0;
            else next = items.length - 1;
            event.preventDefault();
            moveFocus(items, current, next);
        };
        // Programmatic business writes elsewhere publish global-settings-updated;
        // the primitive only re-syncs on change/vcp-uiux-sync, so mirror the event.
        const onGlobalUpdate = () => select.dispatchEvent(new Event('vcp-uiux-sync'));
        trigger.addEventListener('keydown', onTriggerKey);
        document.addEventListener('keydown', onDocumentKey, true);
        window.addEventListener('global-settings-updated', onGlobalUpdate);
        cleanups.push(() => {
            trigger.removeEventListener('keydown', onTriggerKey);
            document.removeEventListener('keydown', onDocumentKey, true);
            window.removeEventListener('global-settings-updated', onGlobalUpdate);
        });
    }

    function mountHarnessSelects(form) {
        const previousObserver = selectObserverStates.get(form);
        // A repeated refresh disconnects the live observer before remounting.
        // Drop the registry entry too so the arming block below always builds a
        // replacement; otherwise the stale entry makes the surface believe an
        // observer is still listening while none is.
        if (previousObserver) {
            previousObserver.disconnect();
            selectObserverStates.delete(form);
        }
        const api = window.VCPUIUX;
        const scope = ensurePresentationScope();
        // A null scope means the bridge is destroyed (or never presented):
        // arming the observer or tagging selects here would leave ambient
        // resources nothing will ever disconnect. The whole pass is a no-op.
        if (!scope) return;
        form.querySelectorAll('select').forEach(select => {
            // Typed primitives mount first and mark their native business node.
            if (select.dataset.vcpTypedPrimitiveMounted === 'true') return;
            if (select.multiple || select.disabled) return;
            if (select.closest('.vcp-harness-select')) return;
            if (select.options.length <= 1) {
                // A select with no real choices yet (e.g. #assistantAgent before
                // the agent list populates) stays a bare native control; tag it
                // so the surface can still give it the standard control look.
                select.classList.add('vcp-settings-bare-select');
                return;
            }
            const fieldLabel = select.id ? [...document.querySelectorAll('label[for]')].find(label => label.htmlFor === select.id) : null;
            const labelText = fieldLabel?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
            const release = api?.mountSelect && scope
                ? api.mountSelect(select, { label: labelText, portal: true }, scope)
                : null;
            if (!release) return; // No primitive runtime: leave the native select in place.
            select.classList.remove('vcp-settings-bare-select');
            select.dataset.vcpTypedPrimitiveMounted = 'true';
            scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, 'select-primitive-marker', 'ui-primitive');
            const cleanups = [];
            mountSelectKeyboardGlue(select, cleanups);
            const stateRelease = () => {
                cleanups.splice(0).forEach(cleanup => cleanup());
                release();
                delete select.dataset.vcpTypedPrimitiveMounted;
                primitiveSelectStates.delete(select);
            };
            scope.own(stateRelease, 'select-primitive', 'ui-primitive');
            primitiveSelectStates.set(select, { release: stateRelease });
        });
        if (window.MutationObserver && !selectObserverStates.has(form)) {
            const observer = new window.MutationObserver(mutations => {
                const relevant = mutations.some(record => {
                    if (record.type === 'attributes') return record.target.matches?.('select, option');
                    if (record.type !== 'childList') return false;
                    if (record.target.matches?.('select')) return true;
                    return [...record.addedNodes, ...record.removedNodes].some(node =>
                        node.nodeType === window.Node.ELEMENT_NODE &&
                        (node.matches?.('select, option') || node.querySelector?.('select, option'))
                    );
                });
                if (!relevant) return;
                if (form.dataset.vcpSelectRebuilding === 'true') return;
                clearTimeout(form.__vcpSelectRebuildTimer);
                form.__vcpSelectRebuildTimer = setTimeout(() => {
                    // The rebuild's own DOM churn (dispose restores the business
                    // node, the primitive re-inserts its wrap) is delivered back to
                    // this observer as a microtask; keep the guard raised until
                    // after that delivery so the projection cannot rebuild itself
                    // in a loop.
                    form.dataset.vcpSelectRebuilding = 'true';
                    // The generated primitive builds its menu once at mount and has
                    // no rebuild API (thread A contract): option-list changes must
                    // dispose and remount the projection.  Attribute-only changes
                    // (programmatic value/selected writes) re-sync the live
                    // projection through the primitive's vcp-uiux-sync hook.
                    if (mutations.some(record => record.type === 'childList')) {
                        teardownHarnessSelects();
                        // LifecycleScope releases settle their dispose in a
                        // microtask: the old projection must have fully restored
                        // the business DOM before the remount runs, otherwise the
                        // deferred disposer strips the freshly inserted wraps.
                        // The handle is tracked so a teardown landing between the
                        // two ticks cannot leave an orphan mount behind.
                        form.__vcpSelectMountTimer = setTimeout(() => mountHarnessSelects(form), 0);
                    } else {
                        form.querySelectorAll('select[data-vcp-typed-primitive-mounted="true"]').forEach(select => {
                            select.dispatchEvent(new Event('vcp-uiux-sync'));
                        });
                    }
                    setTimeout(() => { delete form.dataset.vcpSelectRebuilding; }, 0);
                }, 0);
            });
            observer.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value', 'selected'] });
            selectObserverStates.set(form, observer);
        }
    }

    function teardownHarnessSelects() {
        selectObserverStates.forEach((observer, form) => {
            observer.disconnect();
            clearTimeout(form.__vcpSelectRebuildTimer);
            delete form.__vcpSelectRebuildTimer;
            clearTimeout(form.__vcpSelectMountTimer);
            delete form.__vcpSelectMountTimer;
        });
        selectObserverStates.clear();
        [...primitiveSelectStates.keys()].forEach(select => {
            // stateRelease retracts the keyboard glue, runs the primitive disposer
            // (which restores the original business DOM) and clears the marker.
            // The LifecycleScope release is idempotent and unregisters itself, so
            // a later presentation-scope disposal will not double-dispose.
            primitiveSelectStates.get(select)?.release?.();
        });
    }

    return { mount: mountHarnessSelects, teardown: teardownHarnessSelects };
}
