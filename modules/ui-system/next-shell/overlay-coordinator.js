/*
 * OverlayCoordinator
 *
 * Owns the relationship between renderer overlays and native embedded views.
 * A renderer overlay acquires a lease before it becomes visible. The first
 * lease hides the native view; releasing the last lease reconciles the view
 * selected by AppTabHost. Modal visibility events are translated into the
 * same lease protocol so there is only one overlay authority.
 */
(function installOverlayCoordinator(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createOverlayCoordinatorApi() {
    'use strict';

    class OverlayCoordinator {
        constructor(options = {}) {
            this.document = options.document || globalThis.document;
            this.hideEmbeddedView = options.hideEmbeddedView || (() => Promise.resolve());
            this.reconcileEmbeddedView = options.reconcileEmbeddedView || (() => {});
            this.warn = options.warn || ((...args) => console.warn(...args));
            this.owners = new Set();
            this.modalOwners = new Map();
            this.scope = null;
            this.abortController = null;
            this.mounted = false;
            this.hidePromise = null;
        }

        get active() {
            return this.owners.size > 0;
        }

        mount(scope = null) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope;
            const handler = event => this.handleModalVisibilityChanged(event);
            if (scope) {
                scope.listen(this.document, 'modal-visibility-changed', handler, undefined, 'overlay:modal-visibility');
                scope.own(() => this.dispose(), 'overlay-coordinator', 'controller');
            } else {
                const AbortControllerConstructor = this.document.defaultView?.AbortController || AbortController;
                this.abortController = new AbortControllerConstructor();
                this.document.addEventListener('modal-visibility-changed', handler, { signal: this.abortController.signal });
            }
            this.reconcileVisibleModals();
        }

        dispatchState(active) {
            const CustomEventConstructor = this.document.defaultView?.CustomEvent || CustomEvent;
            this.document.dispatchEvent(new CustomEventConstructor('next-ui-overlay-changed', { detail: { active } }));
        }

        dispatchActivationFailure(detail = {}) {
            const CustomEventConstructor = this.document.defaultView?.CustomEvent || CustomEvent;
            this.document.dispatchEvent(new CustomEventConstructor('next-ui-overlay-activation-failed', {
                detail: Object.freeze({ ...detail, active: false }),
            }));
        }

        async acquire(owner = Symbol('next-ui-overlay')) {
            if (!this.mounted) throw new Error('OverlayCoordinator must be mounted before acquiring a lease.');
            const wasEmpty = this.owners.size === 0;
            this.owners.add(owner);
            if (wasEmpty) this.dispatchState(true);
            try {
                if (!this.hidePromise) {
                    this.hidePromise = Promise.resolve(this.hideEmbeddedView()).finally(() => {
                        this.hidePromise = null;
                    });
                }
                await this.hidePromise;
            } catch (error) {
                const removed = this.owners.delete(owner);
                if (removed && this.owners.size === 0) this.dispatchState(false);
                this.warn('[NextUI] Failed to hide embedded app for overlay:', error);
                throw error;
            } finally {
                // A lease can be released while hide IPC is still pending. A
                // late hide result must never become the final native state.
                if (!this.owners.has(owner)) this.reconcileEmbeddedView();
            }
            return owner;
        }

        release(owner) {
            if (!this.owners.delete(owner)) return false;
            if (this.owners.size === 0) this.dispatchState(false);
            this.reconcileEmbeddedView();
            return true;
        }

        handleModalVisibilityChanged(event) {
            const modalId = event.detail?.modalId;
            if (typeof modalId !== 'string' || !modalId) return;
            const detailRoot = event.detail?.root || null;
            // The legacy document contains many unrelated modal nodes. Only
            // the shared settings host (and explicitly marked Next surfaces)
            // participate in native-view shielding; otherwise mounting Next
            // could acquire a lease for a Classic/third-party modal.
            const nextOwned = modalId === 'globalSettingsModal'
                || detailRoot?.dataset?.nextOverlay === 'true'
                || event.detail?.surface === 'next';
            if (!nextOwned) return;
            const detailGeneration = event.detail?.generation;
            const current = this.modalOwners.get(modalId);
            if (event.detail?.active === true) {
                if (current && (!detailRoot || current.root === detailRoot)
                    && (detailGeneration === undefined || current.generation === detailGeneration)) return;
                const owner = Symbol(`modal-overlay:${modalId}`);
                this.modalOwners.set(modalId, {
                    owner, root: detailRoot, generation: detailGeneration,
                    previous: current?.owner || null,
                });
                void this.acquire(owner).catch(error => {
                    // A modal can close and reopen while the native hide IPC
                    // is pending. Only the still-current owner may publish a
                    // failure; a late rejection from an old generation must
                    // not close or poison the newly opened modal.
                    const current = this.modalOwners.get(modalId);
                    const isCurrent = this.mounted && current?.owner === owner;
                    if (!isCurrent) {
                        this.owners.delete(owner);
                        // The replacement generation never acquired its lease;
                        // return the previous generation's lease as well so a
                        // failed reopen cannot strand the native view hidden.
                        if (current?.previous) this.release(current.previous);
                        return;
                    }
                    const previous = current.previous;
                    this.modalOwners.delete(modalId);
                    if (previous) this.release(previous);
                    this.dispatchActivationFailure({
                        modalId,
                        root: detailRoot,
                        generation: detailGeneration,
                        error,
                    });
                    this.warn(`[NextUI] Failed to acquire overlay for modal ${modalId}:`, error);
                    return false;
                }).then(acquired => {
                    if (acquired === false) return;
                    // A replacement generation is committed only after its
                    // own hide lease has been acquired.  This avoids the
                    // release -> reconcile gap where the native view could
                    // briefly paint over the newly opened modal.
                    const latest = this.modalOwners.get(modalId);
                    if (latest?.owner === owner && current && current.owner !== owner) {
                        this.release(current.owner);
                        latest.previous = null;
                    }
                });
                return;
            }
            if (!current) return;
            if (detailRoot && current.root && detailRoot !== current.root) return;
            if (detailGeneration !== undefined && current.generation !== undefined
                && detailGeneration !== current.generation) return;
            this.modalOwners.delete(modalId);
            this.release(current.owner);
            if (current.previous) this.release(current.previous);
        }

    reconcileVisibleModals() {
            this.document.querySelectorAll('.modal.active[id]').forEach(modal => {
                if (modal.id !== 'globalSettingsModal' && modal.dataset.nextOverlay !== 'true') return;
                this.handleModalVisibilityChanged({ detail: { modalId: modal.id, active: true } });
            });
        }

        snapshot() {
            return Object.freeze({
                mounted: this.mounted,
                active: this.active,
                owners: Object.freeze([...this.owners].map(owner => typeof owner === 'symbol' ? owner.description || 'symbol' : String(owner))),
                modalIds: Object.freeze([...this.modalOwners.keys()]),
            });
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            this.abortController?.abort();
            this.abortController = null;
            this.scope = null;
            this.modalOwners.clear();
            const hadOwners = this.owners.size > 0;
            if (hadOwners) this.dispatchState(false);
            this.owners.clear();
            // Disposal is also a state transition for the native view. A
            // window can be destroyed while a modal lease is active; restore
            // the selected WebContentsView immediately instead of leaving it
            // hidden until a later unrelated tab change.
            if (hadOwners) this.reconcileEmbeddedView();
        }
    }

    return { OverlayCoordinator };
});
