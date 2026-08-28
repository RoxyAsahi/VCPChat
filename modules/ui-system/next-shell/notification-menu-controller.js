/* Next notification quick-actions menu. The commands remain shared business
 * commands; this controller owns only the transient menu presentation. */
(function installNotificationMenuController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createNotificationMenuControllerApi() {
    'use strict';

    class NotificationMenuController {
        constructor(options = {}) {
            this.window = options.window || globalThis.window;
            this.document = options.document || this.window.document;
            this.commands = options.commands || (() => this.window.MainChatCommands);
            this.filterManager = options.filterManager || this.window.filterManager;
            this.showToast = options.showToast || (() => {});
            // Optional generated Button presentation capability. The menu
            // controller remains the sole command/focus owner when the
            // artifact is unavailable.
            this.buttonApi = options.buttonApi || null;
            this.escapeDispatcher = options.escapeDispatcher || null;
            this.scope = null;
            this.abortController = null;
            this.escapeDisposer = null;
            this.filterDisposer = null;
            this.generatedButtonScope = null;
            this.generatedButtonsMounted = false;
            this.elements = null;
            this.mounted = false;
        }

        mount(scope = null) {
            if (this.mounted) return true;
            const byId = id => this.document.getElementById(id);
            const elements = {
                trigger: byId('nextUiNotificationMenuBtn'),
                menu: byId('nextUiNotificationMenu'),
                forum: byId('nextUiNotificationForum'),
                memo: byId('nextUiNotificationMemo'),
                log: byId('nextUiNotificationLog'),
                observer: byId('nextUiNotificationObserver'),
                filter: byId('nextUiNotificationFilterToggle'),
                filterState: byId('nextUiNotificationFilterState'),
                settings: byId('nextUiNotificationSettings'),
                clear: byId('nextUiNotificationClear'),
            };
            if (!elements.trigger || !elements.menu || !elements.forum || !elements.memo
                || !elements.filter || !elements.filterState || !elements.clear) return false;
            this.mounted = true;
            this.scope = scope;
            this.elements = elements;
            if (!scope) {
                const AbortControllerConstructor = this.window.AbortController || AbortController;
                this.abortController = new AbortControllerConstructor();
            }
            const listen = (target, type, handler, options = {}) => {
                if (!target) return () => {};
                if (scope) return scope.listen(target, type, handler, options, `notification-menu:${type}`);
                target.addEventListener(type, handler, { ...options, signal: this.abortController.signal });
                return () => target.removeEventListener(type, handler, options);
            };

            listen(elements.trigger, 'click', () => {
                if (elements.menu.hidden) this.open();
                else this.close({ restoreFocus: true });
            });
            listen(elements.forum, 'click', () => void this.runAction(() => this.commands()?.openForum?.()));
            listen(elements.memo, 'click', () => void this.runAction(() => this.commands()?.openMemo?.()));
            listen(elements.log, 'click', () => void this.runAction(() => this.commands()?.openLog?.()));
            listen(elements.observer, 'click', () => void this.runAction(() => this.commands()?.openRagObserver?.()));
            listen(elements.filter, 'click', () => void this.runAction(() => this.commands()?.toggleNotificationFilter?.()));
            listen(elements.filter, 'contextmenu', event => {
                event.preventDefault();
                void this.runAction(() => this.commands()?.openNotificationFilterSettings?.(), { restoreFocus: false });
            });
            listen(elements.settings, 'click', () => void this.runAction(
                () => this.commands()?.openNotificationFilterSettings?.(),
                { restoreFocus: false }
            ));
            listen(elements.clear, 'click', () => void this.runAction(() => this.commands()?.clearNotifications?.()));
            listen(this.document, 'pointerdown', event => {
                if (!elements.menu.hidden
                    && !elements.menu.contains(event.target)
                    && !elements.trigger.contains(event.target)) this.close();
            });
            listen(this.document, 'next-ui-overlay-changed', event => {
                if (event.detail?.active !== true || elements.menu.hidden) return;
                this.close({ restoreFocus: elements.menu.contains(this.document.activeElement) });
            });
            listen(elements.menu, 'keydown', event => this.handleKeydown(event));
            if (this.escapeDispatcher) {
                this.escapeDisposer = this.escapeDispatcher.register({
                    priority: 40,
                    isActive: () => !elements.menu.hidden,
                    close: () => {
                        this.close({ restoreFocus: true });
                        return true;
                    },
                });
            } else {
                listen(this.document, 'keydown', event => {
                    if (event.key !== 'Escape' || elements.menu.hidden) return;
                    event.preventDefault();
                    event.stopPropagation();
                    this.close({ restoreFocus: true });
                }, { capture: true });
            }
            const subscribe = this.filterManager?.subscribe;
            if (typeof subscribe === 'function') {
                this.filterDisposer = subscribe.call(this.filterManager, state => this.syncFilterState(state));
            } else {
                listen(this.window, 'notification-filter-changed', event => this.syncFilterState(event.detail));
                this.syncFilterState();
            }
            if (scope) scope.own(() => this.dispose(), 'notification-menu-controller', 'controller');
            this.mountGeneratedMenuButtons();
            listen(this.window, 'vcp-uiux-ready', () => this.mountGeneratedMenuButtons());
            this.syncFilterState();
            return true;
        }

        mountGeneratedMenuButtons() {
            if (!this.mounted || this.generatedButtonsMounted || !this.scope) return false;
            const api = this.buttonApi || this.window.VCPUIUX;
            if (typeof api?.mountButton !== 'function' || typeof this.scope.child !== 'function') return false;
            // Keep menuitemcheckbox and destructive action styling under
            // their existing contracts; only neutral action items are
            // eligible for the shared Harness Button geometry.
            const buttons = [
                this.elements?.forum,
                this.elements?.memo,
                this.elements?.log,
                this.elements?.observer,
                this.elements?.settings,
            ].filter(button => button instanceof this.window.HTMLButtonElement);
            if (buttons.length !== 5) return false;
            const buttonScope = this.scope.child('next:notification-menu-buttons');
            try {
                for (const button of buttons) api.mountButton(button, { variant: 'ghost', size: 'md' }, buttonScope);
            } catch (error) {
                void buttonScope.dispose('notification-menu-button-adoption-failed').catch(releaseError => {
                    console.warn('[NextUI] Failed to roll back notification Button presentation:', releaseError);
                });
                console.warn('[NextUI] Generated notification Button presentation unavailable; native menu remains active:', error);
                return false;
            }
            this.generatedButtonScope = buttonScope;
            this.generatedButtonsMounted = true;
            return true;
        }

        syncFilterState(state = null) {
            if (!this.mounted || !this.elements) return;
            let enabled = typeof state?.enabled === 'boolean' ? state.enabled : false;
            if (typeof state?.enabled !== 'boolean') {
                // filterManager is created before its settings reference is
                // hydrated. Its query API can therefore throw during the
                // initial Next mount; treat that window as the disabled state
                // and let the later state-channel publication correct it.
                try { enabled = this.filterManager?.isFilterEnabled?.() === true; } catch { enabled = false; }
            }
            this.elements.filter.setAttribute('aria-checked', String(enabled));
            this.elements.filterState.textContent = enabled ? '开启' : '关闭';
        }

        open() {
            if (!this.mounted) return;
            this.syncFilterState();
            this.elements.menu.hidden = false;
            this.elements.trigger.setAttribute('aria-expanded', 'true');
            this.elements.forum.focus();
        }

        close({ restoreFocus = false } = {}) {
            if (!this.mounted || this.elements.menu.hidden) return;
            this.elements.menu.hidden = true;
            this.elements.trigger.setAttribute('aria-expanded', 'false');
            if (restoreFocus) this.elements.trigger.focus();
        }

        async runAction(action, { restoreFocus = true } = {}) {
            if (!this.mounted) return;
            try {
                return await action?.();
            } catch (error) {
                console.warn('[Notifications] Menu action failed:', error);
                this.showToast(`通知操作失败：${error?.message || error}`, 'error');
                return { success: false, error: error?.message || String(error) };
            } finally {
                this.syncFilterState();
                this.close({ restoreFocus });
            }
        }

        handleKeydown(event) {
            if (!this.mounted) return;
            if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                && this.document.activeElement === this.elements.filter) {
                event.preventDefault();
                this.elements.filter.dispatchEvent(new this.window.MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                }));
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const menuItems = [...this.elements.menu.querySelectorAll('[role^="menuitem"]')];
            const currentIndex = menuItems.indexOf(this.document.activeElement);
            if (!menuItems.length) return;
            let nextIndex = currentIndex;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = menuItems.length - 1;
            if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % menuItems.length;
            if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
            event.preventDefault();
            menuItems[nextIndex]?.focus();
        }

        dispose() {
            if (!this.mounted) return;
            const focusedInside = this.elements.menu.contains(this.document.activeElement);
            this.close({ restoreFocus: focusedInside });
            this.mounted = false;
            this.abortController?.abort();
            this.escapeDisposer?.();
            this.filterDisposer?.();
            // Parent scope owns the generated child scope; avoid a second
            // release chain when disposal is initiated by that parent.
            this.generatedButtonScope = null;
            this.generatedButtonsMounted = false;
            this.abortController = null;
            this.escapeDisposer = null;
            this.filterDisposer = null;
            this.elements = null;
            this.scope = null;
        }
    }

    return { NotificationMenuController };
});
