import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LifecycleScope, diagnostics } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/runtime/scope.ts');
const { mountField } = await import('../modules/uiux/primitives/field.ts');
const { mountButton } = await import('../modules/uiux/primitives/button.ts');
const { mountPill } = await import('../modules/uiux/primitives/pill.ts');
const { mountConnectionBanner } = await import('../modules/uiux/primitives/connection-banner.ts');
const { mountOnboardingSurface } = await import('../modules/uiux/primitives/onboarding-surface.ts');

test('Harness OnboardingSurface owns body portal and app-root inert lifetime', async () => {
    const dom = new JSDOM('<!doctype html><div id="root"><main><span id="content">step</span></main></div>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('onboarding-surface-test'));
        const content = document.getElementById('content'); const appRoot = document.getElementById('root');
        const controller = mountOnboardingSurface({ content, appRoot, open: true }, scope);
        assert.equal(controller.open, true); assert.equal(appRoot.inert, true); assert.equal(controller.stage.contains(content), true);
        controller.setOpen(false); assert.equal(appRoot.inert, false); assert.equal(document.querySelector('#root #content'), content);
        controller.setOpen(true); assert.equal(appRoot.inert, true); await scope.dispose('onboarding-complete');
        assert.equal(appRoot.inert, false); assert.equal(document.querySelector('#root #content'), content); assert.equal(document.querySelector('.vcp-harness-onboarding-overlay'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness ConnectionBanner owns reconnecting projection and restores host on dispose', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"><span>original</span></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('connection-banner-test'));
        const host = document.getElementById('host');
        const controller = mountConnectionBanner(host, { reconnecting: true, label: 'Retrying' }, scope);
        assert.equal(host.querySelector('[role=status]')?.textContent, 'Retrying');
        controller.setLabel('Reconnecting');
        assert.equal(host.querySelector('[role=status]')?.textContent, 'Reconnecting');
        controller.setReconnecting(false);
        assert.equal(host.querySelector('[role=status]'), null);
        controller.setReconnecting(true);
        await scope.dispose('connection-banner-complete');
        assert.equal(host.textContent, 'original');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});
const { mountSelect } = await import('../modules/uiux/primitives/select.ts');
const { mountInput } = await import('../modules/uiux/primitives/input.ts');
const { mountDiffBlock } = await import('../modules/uiux/primitives/diff-block.ts');
const { mountMenu } = await import('../modules/uiux/primitives/menu.ts');
const { mountModal } = await import('../modules/uiux/primitives/modal.ts');
const { mountTooltip } = await import('../modules/uiux/primitives/tooltip.ts');
const { mountHoverCard } = await import('../modules/uiux/primitives/hover-card.ts');
const { mountDisclosureRow } = await import('../modules/uiux/primitives/disclosure-row.ts');
const { mountStateDot } = await import('../modules/uiux/primitives/state-dot.ts');
const { mountToast, TOAST_HOLD_MS, TOAST_FADE_MS } = await import('../modules/uiux/primitives/toast.ts');
// RiskConfirmation is the first composed primitive; source-plane Node cannot
// resolve its emitted .js sibling imports, so exercise its checked-in artifact.
const { mountRiskConfirmation } = await import('../modules/uiux/generated/primitives/risk-confirmation.js');
const { mountAgentPresetSeat } = await import('../modules/uiux/generated/primitives/agent-preset-seat.js');
const { mountAgentPresetRow } = await import('../modules/uiux/generated/primitives/agent-preset-row.js');
const { mountLanguageRow } = await import('../modules/uiux/generated/primitives/language-row.js');
const { mountAgentModelPicker } = await import('../modules/uiux/generated/primitives/agent-model-picker.js');
const { createPopupSelectController, mountPopupSelectView } = await import('../modules/uiux/generated/primitives/popup-select.js');
const { mountDirectoryBrowser } = await import('../modules/uiux/generated/primitives/directory-browser.js');
const { mountSemanticIcon } = await import('../modules/uiux/primitives/semantic-icon.ts');
const { mountChoice } = await import('../modules/uiux/primitives/choice.ts');
const { mountRange } = await import('../modules/uiux/primitives/range.ts');
const { mountToggle } = await import('../modules/uiux/primitives/toggle.ts');
const { mountColorPair } = await import('../modules/uiux/primitives/color-pair.ts');

test('Harness LanguageRow composes a locale selector and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"><span>original</span></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('language-row-test'));
        const host = document.getElementById('host'); const picked = [];
        const controller = mountLanguageRow(host, { activeId: 'en', options: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }, { id: 'de', label: 'Deutsch', disabled: true }], onSelect: id => picked.push(id) }, scope);
        assert.equal(controller.trigger.textContent, 'English');
        assert.equal(controller.root.className, 'vcp-harness-language-row');
        assert.equal(controller.trigger.getAttribute('aria-haspopup'), 'menu');
        controller.setOpen(true);
        assert.equal(controller.menu.open, true);
        assert.equal(controller.menu.list.querySelector('[role="menuitem"][data-selected="true"]')?.textContent, 'English');
        controller.menu.list.querySelector('[role="menuitem"][data-selected="false"]')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.deepEqual(picked, ['zh']);
        controller.setActive('missing');
        assert.equal(controller.trigger.textContent, 'missing');
        await controller.setOptions([{ id: 'fr', label: 'Français' }]);
        assert.equal(controller.menu.list.querySelectorAll('[role="menuitem"]').length, 1);
        await scope.dispose('language-row-complete');
        assert.equal(host.textContent, 'original');
        assert.equal(document.querySelector('.vcp-harness-language-row'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness LanguageRow serializes concurrent option replacement by generation', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"><span>original</span></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('language-row-concurrency-test'));
        const host = document.getElementById('host');
        const controller = mountLanguageRow(host, {
            activeId: 'latest',
            options: [{ id: 'initial', label: 'Initial' }],
            onSelect: () => {},
        }, scope);

        const stale = controller.setOptions([{ id: 'stale', label: 'Stale' }]);
        const latest = controller.setOptions([{ id: 'latest', label: 'Latest' }]);
        await Promise.all([stale, latest]);

        assert.deepEqual(
            [...controller.menu.list.querySelectorAll('[role="menuitem"]')].map(node => node.textContent),
            ['Latest'],
            'the newest options must be the only published menu',
        );
        assert.equal(
            scope.snapshot().resources.filter(resource => resource.label === 'child:harness-language-row-menu').length,
            1,
            'stale rebuilds must not leak an owned menu scope',
        );

        await scope.dispose('language-row-concurrency-complete');
        assert.equal(diagnostics.find('harness-language-row-menu').length, 0);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness LanguageRow cancels queued rebuilds when disposed', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"><span>original</span></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('language-row-dispose-race-test'));
        const host = document.getElementById('host');
        const controller = mountLanguageRow(host, {
            options: [{ id: 'initial', label: 'Initial' }],
            onSelect: () => {},
        }, scope);

        const pending = controller.setOptions([{ id: 'late', label: 'Late' }]);
        const disposing = scope.dispose('language-row-dispose-race');
        await Promise.all([pending, disposing]);

        assert.equal(host.textContent, 'original');
        assert.equal(host.querySelector('.vcp-harness-language-row'), null);
        assert.equal(diagnostics.find('harness-language-row-menu').length, 0);
        assert.equal(diagnostics.find('harness-language-row').length, 0);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness AgentModelPicker maps provider metadata and retracts its popup owner', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('agent-model-picker-test'));
        const host = document.getElementById('host'); const selected = [];
        let loads = 0;
        const controller = mountAgentModelPicker(host, {
            selectedId: 'gpt',
            selectedEffort: 'balanced',
            efforts: [{ id: 'balanced', label: 'Balanced', description: 'Provider default' }, { id: 'deep', label: 'Deep', description: 'More reasoning' }],
            onEffortSelect: option => { selected.push(`effort:${option.id}`); },
            options: async signal => {
                assert.equal(signal.aborted, false);
                loads += 1;
                return [
                    { id: 'gpt', label: 'GPT', provider: 'OpenAI', favorite: true },
                    { id: 'local', label: 'Local', provider: 'Ollama' },
                    { id: 'blocked', label: 'Blocked', provider: 'Remote', disabled: true },
                ];
            },
            onSelect: option => { selected.push(option.id); },
        }, scope);
        assert.equal(controller.trigger.getAttribute('aria-haspopup'), 'menu');
        assert.ok(controller.trigger.getAttribute('aria-controls')?.startsWith('vcp-harness-agent-model-picker-menu-'));
        assert.equal(controller.trigger.querySelector('.vcp-harness-agent-model-picker-trigger-label')?.textContent, 'Select model');
        assert.ok(controller.trigger.querySelector('.vcp-harness-agent-model-picker-trigger-icon'));
        assert.ok(document.getElementById('vcp-harness-uiux-agent-model-picker'));
        controller.open();
        assert.equal(controller.root.querySelector('.vcp-harness-popup-select-card')?.getAttribute('aria-busy'), 'true');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(loads, 1);
        assert.equal(controller.popup.getSnapshot().open, true);
        assert.equal(controller.root.querySelector('.vcp-harness-popup-select-card')?.getAttribute('aria-busy'), null);
        assert.equal(controller.root.querySelector('.vcp-harness-popup-select-card')?.getAttribute('role'), 'menu');
        assert.equal(controller.root.querySelector('.vcp-harness-popup-select-card')?.id, controller.trigger.getAttribute('aria-controls'));
        assert.equal(controller.root.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden, false);
        controller.setPane('model');
        assert.equal(controller.root.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden, true);
        assert.equal(controller.root.querySelector('.vcp-harness-popup-select-search')?.hidden, false);
        controller.setPane('effort');
        assert.equal(controller.root.querySelector('.vcp-harness-agent-model-picker-effort-list')?.hidden, false);
        controller.root.querySelector('.vcp-harness-popup-select-card')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(controller.root.querySelector('.vcp-harness-agent-model-picker-effort-list')?.hidden, true);
        assert.equal(controller.root.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden, false);
        controller.setPane('model');
        controller.root.querySelector('.vcp-harness-popup-select-card')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(controller.popup.getSnapshot().open, true);
        controller.root.querySelector('.vcp-harness-agent-model-picker-option:last-child')?.click();
        assert.deepEqual(selected, ['effort:deep']);
        assert.match(controller.popup.getSnapshot().options[0].detail, /OpenAI/);
        assert.match(controller.popup.getSnapshot().options[0].detail, /Favorite/);
        assert.equal(controller.popup.getSnapshot().options[2].disabled, true);
        controller.popup.setSearch('local');
        await controller.popup.select(0);
        assert.deepEqual(selected, ['effort:deep', 'local']);
        assert.equal(controller.popup.getSnapshot().open, false);
        controller.refresh();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(loads, 2);
        controller.close();
        await controller.dispose();
        assert.equal(host.querySelector('.vcp-harness-agent-model-picker'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness AgentModelPicker drops late effort settlements after close and reopen', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('agent-model-picker-late-effort-test'));
        const host = document.getElementById('host');
        let resolveEffort;
        const effortSettled = new Promise(resolve => { resolveEffort = resolve; });
        const controller = mountAgentModelPicker(host, {
            efforts: [{ id: 'high', label: 'High' }, { id: 'max', label: 'Max' }],
            options: async () => [],
            onSelect: () => {},
            onEffortSelect: async () => effortSettled,
        }, scope);
        controller.open();
        controller.setPane('effort');
        const selected = controller.root.querySelector('.vcp-harness-agent-model-picker-option');
        assert.ok(selected);
        selected.click();
        controller.close();
        controller.open();
        controller.setPane('effort');
        resolveEffort();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(controller.root.querySelector('.vcp-harness-agent-model-picker-effort-list')?.hidden, false,
            'a late effort result must not switch a reopened picker back to root');
        await controller.dispose();
        await scope.dispose('agent-model-picker-late-effort-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness AgentModelPicker projects loading, load failure and retry through one popup owner', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('agent-model-picker-load-retry-test'));
        const host = document.getElementById('host');
        let calls = 0;
        const controller = mountAgentModelPicker(host, {
            harnessEquivalent: true,
            searchEnabled: false,
            options: async () => {
                calls += 1;
                if (calls === 1) throw new Error('catalog unavailable');
                return [{ id: 'ready', label: 'Ready', provider: 'DeepSeek' }];
            },
            onSelect: () => {},
        }, scope);
        controller.open();
        controller.setPane('model');
        const card = controller.root.querySelector('.vcp-harness-popup-select-card');
        assert.equal(card?.getAttribute('aria-busy'), 'true', 'the model pane announces its pending directory load');
        assert.match(card?.querySelector('.vcp-harness-popup-select-status')?.textContent || '', /Loading options/);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(controller.popup.getSnapshot().status, 'failed');
        assert.equal(card?.getAttribute('aria-busy'), null, 'a failed load must settle busy state');
        assert.match(card?.querySelector('[role="alert"]')?.textContent || '', /catalog unavailable/);
        card?.querySelector('.vcp-harness-popup-select-retry')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.equal(controller.popup.getSnapshot().status, 'pending', 'Retry reuses the one popup controller, rather than mounting a second owner');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(calls, 2);
        assert.equal(controller.popup.getSnapshot().status, 'ready');
        assert.equal(card?.querySelectorAll('[role="menuitemradio"]').length, 1);
        await controller.dispose();
        await scope.dispose('agent-model-picker-load-retry-complete');
        assert.equal(host.querySelector('.vcp-harness-agent-model-picker'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Pill preserves static and native interactive semantics and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><main><span id="static">Static</span><button id="interactive">Active</button></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('pill-test'));
        const staticHost = document.getElementById('static');
        const interactiveHost = document.getElementById('interactive');
        let clicks = 0;
        mountPill(staticHost, { active: true }, scope);
        mountPill(interactiveHost, { interactive: true, onClick: () => { clicks += 1; } }, scope);
        assert.equal(staticHost.className, 'vcp-harness-pill pill active');
        assert.equal(interactiveHost.className, 'vcp-harness-pill pill interactive');
        assert.equal(interactiveHost.type, 'button');
        interactiveHost.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.equal(clicks, 1);
        await scope.dispose('pill-complete');
        assert.equal(staticHost.className, '');
        assert.equal(interactiveHost.className, '');
        assert.equal(interactiveHost.getAttribute('type'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('Harness PopupSelect Candidate keeps command wiring injected, owns focus and retracts its overlay', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div><button id="return-focus">Composer stand-in</button></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('popup-select-test'));
        const host = document.getElementById('host');
        const focusTarget = document.getElementById('return-focus');
        const consumed = [];
        const selected = [];
        let focused = 0;
        const popup = createPopupSelectController({
            options: async () => [
                { id: 'balanced', label: 'Balanced', detail: 'General purpose', active: true },
                { id: 'careful', label: 'Careful', detail: 'Requires acknowledgement', confirmation: { title: 'Confirm change', description: 'Candidate-only action.', acknowledgeLabel: 'I understand', cancelLabel: 'Cancel', confirmLabel: 'Apply' } },
            ],
            onSelect: async (option, context) => { selected.push([option.id, context]); },
        }, {
            consume: segment => { consumed.push(segment); return true; },
            focusComposer: () => { focused += 1; focusTarget.focus(); },
        });
        const view = mountPopupSelectView(host, { popup, overlayAria: '/{command} picker' }, scope);

        popup.open('model', { request: 1 }, { via: 'enter', token: '/model' });
        await delay(0);
        assert.equal(view.card.parentElement, host);
        assert.equal(view.card.getAttribute('aria-label'), '/model picker');
        assert.equal(view.search, document.activeElement);
        assert.equal(view.card.querySelectorAll('[role=option]').length, 2);
        view.search.value = 'care';
        view.search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.equal(view.card.querySelectorAll('[role=option]').length, 1);
        view.card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.equal(popup.getSnapshot().confirming?.id, 'careful');
        assert.equal(view.card.style.display, 'none');
        assert.equal(document.querySelector('[role=dialog]') instanceof dom.window.HTMLElement, true);
        popup.acknowledge(true);
        await popup.confirm();
        assert.deepEqual(selected, [['careful', { request: 1 }]]);
        assert.deepEqual(consumed, [{ via: 'enter', token: '/model' }]);
        assert.equal(focused, 1);
        assert.equal(document.activeElement, focusTarget);
        assert.equal(view.card.isConnected, false);

        popup.open('model', { request: 2 }, { via: 'menu', span: { opaque: true } });
        await delay(0);
        popup.dismiss({ focusComposer: true });
        assert.equal(popup.getSnapshot().open, false);
        assert.equal(view.card.isConnected, false);
        assert.equal(focused, 2);
        await view.dispose();
        await scope.dispose('popup-select-complete');
        assert.equal(document.querySelector('.vcp-harness-popup-select-card'), null);
        assert.equal(document.querySelector('[role=dialog]'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness PopupSelect parity mode can omit the search control without changing option loading', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('popup-select-parity-test'));
        const host = document.getElementById('host');
        const popup = createPopupSelectController({
            options: async () => [{ id: 'acme-think', label: 'Acme Think', active: true }],
            onSelect: async () => {},
        }, { consume: () => true, focusComposer: () => {} });
        const view = mountPopupSelectView(host, { popup, searchEnabled: false }, scope);
        popup.open('model', {}, { via: 'menu', span: {} });
        await delay(0);
        assert.equal(view.search.hidden, true);
        assert.equal(view.card.querySelectorAll('[role=option]').length, 1);
        await view.dispose();
        await scope.dispose('popup-select-parity-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness PopupSelect parity mode preserves provider groups and menuitemradio semantics', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('popup-select-grouped-test'));
        const host = document.getElementById('host');
        const popup = createPopupSelectController({
            options: async () => [
                { id: 'deepseek', label: 'DeepSeek-V4-Flash', group: 'DeepSeek' },
                { id: 'acme', label: 'Acme Think', group: 'Acme Gateway', active: true },
            ],
            onSelect: async () => {},
        }, { consume: () => true, focusComposer: () => {} });
        const view = mountPopupSelectView(host, { popup, searchEnabled: false, grouped: true, optionRole: 'menuitemradio' }, scope);
        popup.open('model', {}, { via: 'menu', span: {} });
        await delay(0);
        assert.equal(view.card.querySelectorAll('section[role=group]').length, 2);
        assert.equal(view.card.querySelectorAll('button[role=menuitemradio]').length, 2);
        assert.equal(view.card.querySelectorAll('[role=option]').length, 0);
        assert.equal(view.card.querySelector('button[aria-checked="true"]')?.textContent?.includes('Acme Think'), true);
        assert.equal(view.card.querySelectorAll('button[role=menuitemradio] .vcp-harness-popup-select-option-check').length, 2,
            'Harness ModelSelect retains a trailing check slot on both selected and unselected rows');
        assert.equal(view.card.querySelector('button[aria-checked="false"] .vcp-harness-popup-select-option-check')?.childElementCount, 0,
            'only the selected Harness row paints the check glyph');
        const check = view.card.querySelector('button[aria-checked="true"] .vcp-harness-popup-select-option-check > svg');
        assert.equal(check?.getAttribute('width'), '16', 'ModelSelect parity uses the Harness 16px check SVG, not the generic icon host');
        assert.equal(check?.getAttribute('viewBox'), '0 0 16 16');
        await view.dispose();
        await scope.dispose('popup-select-grouped-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness PopupSelect parity skips disabled rows and hands keyboard focus to the active menuitemradio', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const selected = [];
        const scope = createUiScope(new LifecycleScope('popup-select-keyboard-owner-test'));
        const host = document.getElementById('host');
        const popup = createPopupSelectController({
            options: async () => [
                { id: 'blocked', label: 'Blocked', group: 'DeepSeek', disabled: true },
                { id: 'available', label: 'Available', group: 'DeepSeek' },
            ],
            onSelect: async option => { selected.push(option.id); },
        }, { consume: () => true, focusComposer: () => {} });
        const view = mountPopupSelectView(host, { popup, searchEnabled: false, grouped: true, optionRole: 'menuitemradio' }, scope);
        popup.open('model', {}, { via: 'menu', span: {} });
        await delay(0);
        const blocked = view.card.querySelector('[data-option-id="blocked"]');
        assert.equal(blocked?.getAttribute('aria-disabled'), 'true');
        assert.equal(blocked?.disabled, true, 'Harness parity rows expose native disabled state');
        await popup.select(0);
        assert.deepEqual(selected, [], 'Enter/controller selection cannot invoke a disabled row');
        view.card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        const available = view.card.querySelector('[data-option-id="available"]');
        assert.equal(popup.getSnapshot().active, 1, 'keyboard navigation skips disabled rows');
        assert.equal(document.activeElement, available, 'menuitemradio owns focus after keyboard navigation');
        const stylesheet = document.getElementById('vcp-harness-uiux-popup-select')?.textContent || '';
        assert.match(stylesheet, /\.vcp-harness-popup-select-option:focus-visible/, 'Harness parity keeps the source focus-visible material state');
        await view.dispose();
        await scope.dispose('popup-select-keyboard-owner-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness DirectoryBrowser foundation aborts stale listings and retracts on close', async () => {
    const dom = new JSDOM('<!doctype html><main></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('directory-browser-test'));
        const pending = [];
        const opened = [];
        const closed = [];
        const created = [];
        const browser = mountDirectoryBrowser({
            open: true,
            listDirectory: (path, signal) => new Promise((resolve, reject) => {
                pending.push({ path, signal, resolve, reject });
                signal?.addEventListener('abort', () => reject(new dom.window.DOMException('Aborted', 'AbortError')));
            }),
            createDirectory: async (path, name) => { created.push({ path, name }); return `${path}/${name}`; },
            onOpen: path => opened.push(path),
            onClose: () => closed.push(true),
        }, scope);
        assert.equal(pending.length, 1);
        pending.shift().resolve({ path: '/home', crumbs: [{ name: 'Home', path: '/home' }], entries: [{ name: 'projects', path: '/home/projects' }, { name: '.hidden', path: '/home/.hidden', hidden: true }] });
        await delay(0);
        assert.equal(document.querySelector('.vcp-directory-browser-status')?.hidden, true, 'fast initial listing must not flash a loading status');
        assert.equal(document.querySelectorAll('.vcp-directory-browser-row').length, 1);
        document.querySelector('.vcp-directory-browser-path-edit').click();
        const previewInput = document.querySelector('.vcp-directory-browser-path-input');
        previewInput.value = '/home/pro';
        previewInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.deepEqual([...document.querySelectorAll('.vcp-directory-browser-row-name')].map(node => node.textContent), ['projects'], 'matching final path segment must prefix-filter the active pane');
        previewInput.value = '/home/no-match';
        previewInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.deepEqual([...document.querySelectorAll('.vcp-directory-browser-row-name')].map(node => node.textContent), ['projects'], 'unmatched draft must preserve the readable pane');
        previewInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(document.querySelector('.vcp-directory-browser-path-input'), null);
        document.querySelector('.vcp-directory-browser-hidden').click();
        assert.equal(document.querySelectorAll('.vcp-directory-browser-row').length, 2);
        document.querySelector('.vcp-directory-browser-row').click();
        assert.equal(pending.length, 1);
        const child = pending.shift();
        await delay(320);
        assert.equal(document.querySelector('.vcp-directory-browser-status')?.textContent, 'Loading…');
        browser.setOpen(false);
        assert.equal(child.signal.aborted, true);
        assert.equal(browser.open, false);
        assert.equal(document.querySelector('.vcp-directory-browser'), null);
        child.resolve({ path: '/home/projects', entries: [{ name: 'late', path: '/home/projects/late' }] });
        await delay(0);
        assert.equal(document.querySelector('.vcp-directory-browser'), null);
        browser.setOpen(true);
        assert.equal(pending.length, 1);
        pending.shift().resolve({ path: '/home', entries: [{ name: 'projects', path: '/home/projects' }] });
        await delay(0);
        assert.equal(document.querySelector('.vcp-directory-browser-status')?.hidden, true);
        const editPath = document.querySelector('.vcp-directory-browser-path-edit');
        assert.ok(editPath);
        editPath.click();
        const pathInput = document.querySelector('.vcp-directory-browser-path-input');
        assert.equal(pathInput?.getAttribute('aria-label'), 'Folder path');
        assert.equal(pathInput?.value, '/home/');
        pathInput.value = '/home/projects/';
        pathInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await delay(260);
        assert.equal(pending.length, 1);
        assert.equal(pending[0].path, '/home/projects/');
        pending.shift().resolve({ path: '/home/projects', crumbs: [{ name: 'Home', path: '/home' }, { name: 'projects', path: '/home/projects' }], entries: [{ name: 'vcpchat', path: '/home/projects/vcpchat' }] });
        await delay(0);
        assert.equal(pending.length, 1, 'non-root path landing must request its parent leg');
        assert.equal(pending[0].path, '/home');
        await delay(220);
        assert.equal(document.querySelectorAll('.vcp-directory-browser-column').length, 1, 'a slow parent leg must settle the target single-pane first');
        pending.shift().resolve({ path: '/home', entries: [{ name: 'projects', path: '/home/projects' }] });
        await delay(0);
        assert.equal(document.querySelectorAll('.vcp-directory-browser-column').length, 2);
        assert.equal(document.querySelector('.vcp-directory-browser-row[aria-current="true"]')?.textContent, 'folder-openprojects');
        assert.ok(document.querySelector('.vcp-directory-browser-path-input'), 'draft preview must keep the editor mounted');
        pathInput.value = '/home/projects';
        pathInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        pathInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.equal(pending.length, 1);
        assert.equal(pending[0].path, '/home/projects');
        pending.shift().resolve({ path: '/home/projects', entries: [] });
        await delay(0);
        assert.equal(document.querySelector('.vcp-directory-browser-path-input'), null);
        document.querySelector('.vcp-directory-browser-path-edit').click();
        assert.ok(document.querySelector('.vcp-directory-browser-path-input'));
        document.querySelector('.vcp-directory-browser-path-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(document.querySelector('.vcp-directory-browser-path-input'), null);
        const newFolder = [...document.querySelectorAll('.vcp-directory-browser-footer button')].find(button => button.textContent === 'New folder');
        newFolder?.click();
        assert.ok(document.querySelector('.vcp-directory-browser-create-dialog'));
        assert.equal(document.querySelector('.vcp-directory-browser[role="dialog"]')?.isConnected, true);
        const folderInput = document.querySelector('.vcp-directory-browser-create-input');
        folderInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(document.querySelector('.vcp-directory-browser-create-dialog'), null);
        assert.equal(browser.open, true);
        newFolder?.click();
        const activeFolderInput = document.querySelector('.vcp-directory-browser-create-input');
        activeFolderInput.value = 'labs';
        activeFolderInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        [...document.querySelectorAll('.vcp-directory-browser-create-actions button')].find(button => button.textContent === 'Create')?.click();
        await delay(0);
        assert.deepEqual(created, [{ path: '/home/projects', name: 'labs' }]);
        assert.equal(pending.length, 1);
        pending.shift().resolve({ path: '/home/projects', entries: [{ name: 'labs', path: '/home/projects/labs' }] });
        await delay(0);
        assert.equal(document.querySelector('.vcp-directory-browser-create-dialog'), null);
        assert.equal(document.querySelector('.vcp-directory-browser-row[aria-current="true"]')?.textContent, 'folder-openlabs');
        const openButton = document.querySelector('.vcp-directory-browser-footer button:last-of-type');
        assert.equal(openButton?.disabled, false);
        openButton?.click();
        assert.deepEqual(opened, ['/home/projects/labs']);
        [...document.querySelectorAll('.vcp-directory-browser-footer button')].find(button => button.textContent === 'Cancel')?.click();
        assert.equal(closed.length, 1);
        await browser.dispose();
        await scope.dispose('directory-browser-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Toast owns body portal, anchor placement, lifetime and timer cancellation', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="anchor"></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('toast-test'));
        const anchor = document.getElementById('anchor');
        let rect = { left: 100, width: 400 };
        anchor.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, top: 0, bottom: 0, height: 0, x: rect.left, y: 0, toJSON() {} });
        const icon = document.createElement('svg');
        icon.dataset.testid = 'warning';
        let done = 0;
        const toast = mountToast({ text: 'Model unavailable', icon, anchor, onDone: () => { done += 1; } }, scope);
        assert.equal(toast.root.parentElement, document.body);
        assert.equal(toast.root.getAttribute('role'), 'alert');
        assert.equal(toast.root.textContent, 'Model unavailable');
        assert.equal(toast.root.querySelector('.vcp-harness-toast-icon')?.getAttribute('aria-hidden'), 'true');
        assert.equal(toast.root.style.left, '300px');
        rect = { left: 200, width: 400 };
        window.dispatchEvent(new dom.window.Event('resize'));
        assert.equal(toast.root.style.left, '400px');
        await delay(TOAST_HOLD_MS + TOAST_FADE_MS - 10);
        assert.equal(done, 0);
        await delay(20);
        assert.equal(done, 1);
        await toast.dispose();
        assert.equal(document.querySelector('.vcp-harness-toast'), null);

        let lateDone = 0;
        const plain = mountToast({ text: 'Plain', onDone: () => { lateDone += 1; } }, scope);
        assert.equal(plain.root.querySelector('[aria-hidden]'), null);
        assert.equal(plain.root.style.left, '');
        await plain.dispose();
        await delay(TOAST_HOLD_MS + TOAST_FADE_MS + 10);
        assert.equal(lateDone, 0, 'dispose must cancel the completion timer');
        await scope.dispose('toast-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness StateDot renders solid halos and the phased ongoing pixel matrix', async () => {
    const dom = new JSDOM('<!doctype html><main><span id="host"><em id="legacy">legacy</em></span></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('state-dot-test'));
        const host = document.getElementById('host');
        const dot = mountStateDot(host, { state: 'done', size: 12, className: 'row-dot' }, scope);
        assert.equal(dot.element.tagName, 'SPAN');
        assert.equal(dot.element.dataset.state, 'done');
        assert.equal(dot.element.getAttribute('aria-hidden'), 'true');
        assert.equal(dot.element.style.width, '12px');
        assert.equal(dot.element.style.height, '12px');
        assert.equal(dot.element.classList.contains('row-dot'), true);
        dot.setState('ongoing');
        assert.equal(dot.element.tagName.toLowerCase(), 'svg');
        assert.equal(dot.element.dataset.state, 'ongoing');
        assert.equal(dot.element.getAttribute('width'), '12');
        assert.equal(dot.element.getAttribute('height'), '12');
        assert.equal(dot.element.getAttribute('shape-rendering'), 'crispEdges');
        const cells = [...dot.element.querySelectorAll('rect')];
        assert.equal(cells.length, 8);
        assert.equal(new Set(cells.map(cell => cell.style.animationDelay)).size, 8);
        assert.deepEqual(cells.map(cell => cell.style.animationDelay), ['-1000ms', '-875ms', '-750ms', '-625ms', '-500ms', '-375ms', '-250ms', '-125ms']);
        dot.setSize(10);
        assert.equal(dot.element.getAttribute('width'), '10');
        dot.setState('error');
        assert.equal(dot.element.tagName, 'SPAN');
        assert.equal(dot.element.dataset.state, 'error');
        assert.throws(() => dot.setState('paused'), /Unknown StateDot state/);
        assert.throws(() => dot.setSize(0), /positive finite/);
        await dot.dispose();
        assert.equal(host.firstElementChild.id, 'legacy');
        await scope.dispose('state-dot-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness DisclosureRow preserves controlled row-click and leading-button contracts', async () => {
    const dom = new JSDOM('<!doctype html><main><section id="row"><span id="icon">I</span><span id="summary"> · command</span><div id="body">Result</div></section><section id="button-row"><span id="icon-2">J</span><span id="summary-2"> · phase</span><div id="body-2">Members</div></section></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('disclosure-test'));
        const host = document.getElementById('row');
        const body = document.getElementById('body');
        const summary = document.getElementById('summary');
        let rowToggles = 0;
        let rowDisclosure;
        rowDisclosure = mountDisclosureRow(host, {
            icon: document.getElementById('icon'),
            title: 'Terminal',
            open: false,
            expandable: true,
            expandOnRowClick: true,
            keepContentWhenOpen: true,
            collapsedContent: document.getElementById('summary'),
            children: document.getElementById('body'),
            className: 'tool-root',
            rowClassName: 'tool-row',
            leadingClassName: 'tool-leading',
            chevronClassName: 'tool-chevron',
            titleClassName: 'tool-title',
            onToggle: () => { rowToggles += 1; rowDisclosure.setOpen(!rowDisclosure.open); },
        }, scope);
        assert.equal(rowDisclosure.root.classList.contains('tool-root'), true);
        assert.equal(rowDisclosure.row.getAttribute('role'), 'button');
        assert.equal(rowDisclosure.row.tabIndex, 0);
        assert.equal(rowDisclosure.row.getAttribute('aria-expanded'), 'false');
        assert.equal(rowDisclosure.leading.tagName, 'SPAN');
        assert.ok(rowDisclosure.leading.querySelector('.vcp-harness-disclosure-icon-idle > #icon'));
        assert.ok(rowDisclosure.leading.querySelector('.vcp-harness-disclosure-chevron-hover.tool-chevron'));
        assert.equal(body.parentNode.nodeType, 11, 'closed body must remain owned but unrendered');
        rowDisclosure.row.click();
        assert.equal(rowToggles, 1);
        assert.equal(rowDisclosure.open, true);
        assert.equal(rowDisclosure.root.dataset.open, 'true');
        assert.equal(rowDisclosure.row.getAttribute('aria-expanded'), 'true');
        assert.ok(rowDisclosure.leading.querySelector('.vcp-harness-disclosure-chevron.tool-chevron'));
        assert.equal(summary.parentElement, rowDisclosure.row, 'keepContentWhenOpen keeps summary inline');
        assert.equal(body.parentElement, rowDisclosure.root);
        const keyEvent = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        rowDisclosure.row.dispatchEvent(keyEvent);
        assert.equal(keyEvent.defaultPrevented, true);
        assert.equal(rowToggles, 2);
        assert.equal(rowDisclosure.open, false);
        rowDisclosure.setTitle('Terminal complete');
        assert.equal(rowDisclosure.row.querySelector('.vcp-harness-disclosure-title')?.textContent, 'Terminal complete');

        const buttonHost = document.getElementById('button-row');
        const summary2 = document.getElementById('summary-2');
        let buttonToggles = 0;
        let buttonDisclosure;
        buttonDisclosure = mountDisclosureRow(buttonHost, {
            icon: document.getElementById('icon-2'),
            title: 'Phase',
            open: false,
            expandable: true,
            collapsedContent: document.getElementById('summary-2'),
            children: document.getElementById('body-2'),
            onToggle: () => { buttonToggles += 1; buttonDisclosure.setOpen(!buttonDisclosure.open); },
        }, scope);
        assert.equal(buttonDisclosure.row.getAttribute('role'), null);
        assert.equal(buttonDisclosure.leading.tagName, 'BUTTON');
        assert.equal(buttonDisclosure.leading.getAttribute('aria-expanded'), 'false');
        buttonDisclosure.row.click();
        assert.equal(buttonToggles, 0, 'non-row mode ignores row activation');
        buttonDisclosure.leading.click();
        assert.equal(buttonToggles, 1);
        assert.equal(buttonDisclosure.leading.getAttribute('aria-expanded'), 'true');
        assert.equal(summary2.parentNode.nodeType, 11, 'default open state hides collapsed summary');
        buttonDisclosure.setExpandable(false);
        assert.equal(buttonDisclosure.row.getAttribute('role'), null);
        assert.equal(buttonDisclosure.leading.tagName, 'SPAN');
        assert.equal(buttonDisclosure.open, true, 'non-expandable can remain forced open for active workflow phases');
        await buttonDisclosure.dispose();
        await rowDisclosure.dispose();
        assert.deepEqual([...host.children].map(node => node.id), ['icon', 'summary', 'body']);
        assert.deepEqual([...buttonHost.children].map(node => node.id), ['icon-2', 'summary-2', 'body-2']);
        await scope.dispose('disclosure-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Tooltip keeps the anchor DOM and owns hover/focus/delay/disabled effects', async () => {
    const dom = new JSDOM('<!doctype html><main><button id="anchor">Details</button><span id="after">After</span></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('tooltip-test'));
        const anchor = document.getElementById('anchor');
        anchor.getBoundingClientRect = () => ({ left: 40, right: 140, top: 30, bottom: 64, width: 100, height: 34, x: 40, y: 30, toJSON() {} });
        let labelReads = 0;
        const tooltip = mountTooltip(anchor, { label: () => { labelReads += 1; return 'Open workspace'; }, side: 'bottom', delayMs: 15, maxWidth: 360 }, scope);
        assert.equal(anchor.parentElement.tagName, 'MAIN', 'Tooltip must not add an anchor wrapper');
        anchor.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
        await delay(10);
        assert.equal(tooltip.open, false);
        await delay(10);
        assert.equal(tooltip.bubble?.getAttribute('role'), 'tooltip');
        assert.equal(tooltip.bubble?.dataset.side, 'bottom');
        assert.equal(tooltip.bubble?.parentElement, document.body, 'Tooltip bubble must be owned by the body portal');
        assert.notEqual(tooltip.bubble?.parentElement, anchor.parentElement, 'Tooltip bubble must not remain inside the scrolling anchor parent');
        assert.equal(tooltip.bubble?.style.left, '90px');
        assert.equal(tooltip.bubble?.style.top, '72px');
        assert.equal(tooltip.bubble?.style.maxWidth, '360px');
        assert.equal(labelReads, 1, 'lazy label must resolve only while visible');
        anchor.dispatchEvent(new dom.window.FocusEvent('focus'));
        anchor.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
        assert.equal(tooltip.open, false, 'Harness mouseleave hides even while focus is still set');
        anchor.dispatchEvent(new dom.window.FocusEvent('blur'));
        anchor.dispatchEvent(new dom.window.FocusEvent('focus'));
        assert.equal(tooltip.open, true, 'keyboard focus is immediate');
        tooltip.setDisabled(true);
        assert.equal(tooltip.open, false);
        anchor.dispatchEvent(new dom.window.FocusEvent('focus'));
        assert.equal(tooltip.open, false);
        await tooltip.dispose();
        assert.deepEqual([...document.querySelector('main').children].map(node => node.id), ['anchor', 'after']);
        await scope.dispose('tooltip-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness HoverCard owns dwell, portal, grace, copy feedback and teardown', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="anchor">Workspace path</div><section id="source"><div id="content">/full/path</div><span id="after">After</span></section></main>', { pretendToBeVisual: true });
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
    const writes = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { writes.push(text); } } });
    try {
        const scope = createUiScope(new LifecycleScope('hover-card-test'));
        const anchor = document.getElementById('anchor');
        const content = document.getElementById('content');
        const hover = mountHoverCard(anchor, { content, openDelayMs: 15, copyText: '/full/path', copyLabel: 'Copy path', copiedLabel: 'Copied' }, scope);
        hover.root.getBoundingClientRect = () => ({ left: 40, right: 200, top: 60, bottom: 94, width: 160, height: 34, x: 40, y: 60, toJSON() {} });
        hover.root.dispatchEvent(new dom.window.Event('pointerenter'));
        await delay(10);
        assert.equal(hover.open, false);
        await delay(10);
        assert.equal(hover.card?.parentElement, document.body);
        assert.equal(hover.card?.style.left, '208px');
        assert.equal(hover.card?.style.top, '60px');
        assert.equal(hover.card?.getAttribute('role'), 'button');
        assert.equal(hover.card?.getAttribute('aria-label'), 'Copy path: /full/path');
        hover.root.dispatchEvent(new dom.window.Event('pointerleave'));
        await delay(100);
        hover.card?.dispatchEvent(new dom.window.Event('pointerenter'));
        await delay(120);
        assert.equal(hover.open, true, 'pointer reaching the card inside grace keeps it open');
        hover.root.getBoundingClientRect = () => ({ left: 80, right: 300, top: 90, bottom: 124, width: 220, height: 34, x: 80, y: 90, toJSON() {} });
        window.dispatchEvent(new dom.window.Event('scroll'));
        assert.equal(hover.card?.style.left, '308px');
        assert.equal(hover.card?.style.top, '90px');
        hover.card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await delay(0);
        assert.deepEqual(writes, ['/full/path']);
        assert.equal(hover.root.querySelector('[role="status"]')?.textContent, 'Copied');
        assert.equal(hover.card?.querySelector('.vcp-harness-hover-card-copied')?.textContent, 'Copied');
        hover.card?.dispatchEvent(new dom.window.Event('pointerleave'));
        await delay(210);
        assert.equal(hover.open, false);
        assert.deepEqual([...document.getElementById('source').children].map(node => node.id), ['content', 'after']);
        hover.root.dispatchEvent(new dom.window.Event('pointerenter'));
        await delay(20);
        hover.setDisabled(true);
        assert.equal(hover.open, false);
        await hover.dispose();
        assert.equal(anchor.parentElement.tagName, 'MAIN');
        assert.deepEqual([...document.querySelector('main').children].map(node => node.id), ['anchor', 'source']);
        await scope.dispose('hover-card-complete');
    } finally {
        globalThis.document = previousDocument; globalThis.window = previousWindow;
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else Reflect.deleteProperty(globalThis, 'navigator');
        dom.window.close();
    }
});

test('Harness Modal portals controlled standard/headless DOM and restores owned nodes', async () => {
    const dom = new JSDOM('<!doctype html><main><button id="trigger">Open</button><section id="source"><div id="body">Body</div><button id="cancel">Cancel</button><span id="after">After</span></section></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('modal-test'));
        const trigger = document.getElementById('trigger');
        const body = document.getElementById('body');
        const cancel = document.getElementById('cancel');
        let closes = 0;
        let modal;
        modal = mountModal({
            title: 'Create workspace',
            closeLabel: 'Close dialog',
            description: 'Choose a workspace.',
            className: 'workspace-dialog constrained-dialog',
            contentClassName: 'scrolling-content',
            body,
            footer: cancel,
            onClose: () => { closes += 1; modal.setOpen(false); },
        }, scope);
        assert.equal(body.parentElement.id, 'source', 'closed modal must not retain canonical nodes');
        trigger.focus();
        modal.setOpen(true);
        assert.equal(modal.root.parentElement, document.body);
        assert.equal(modal.dialog.getAttribute('role'), 'dialog');
        assert.equal(modal.dialog.getAttribute('aria-modal'), 'true');
        assert.equal(modal.dialog.getAttribute('aria-label'), 'Create workspace');
        assert.equal(modal.dialog.classList.contains('workspace-dialog'), true);
        assert.equal(modal.dialog.classList.contains('constrained-dialog'), true);
        assert.equal(modal.root.querySelector('.vcp-harness-modal-content')?.classList.contains('scrolling-content'), true);
        assert.equal(modal.root.querySelector('.vcp-harness-modal-mask')?.getAttribute('aria-hidden'), 'true');
        assert.equal(modal.root.querySelector('.vcp-harness-modal-title')?.textContent, 'Create workspace');
        assert.equal(modal.root.querySelector('.vcp-harness-modal-description')?.textContent, 'Choose a workspace.');
        assert.equal(body.parentElement.className, 'vcp-harness-modal-body');
        assert.equal(cancel.parentElement.className, 'vcp-harness-modal-footer');
        assert.equal(document.activeElement, trigger, 'Harness Modal does not invent focus ownership');
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(modal.open, false);
        assert.equal(closes, 1);
        assert.deepEqual([...document.getElementById('source').children].map(node => node.id), ['body', 'cancel', 'after']);
        modal.setOpen(true);
        modal.root.querySelector('.vcp-harness-modal-mask').click();
        assert.equal(closes, 2);
        modal.setOpen(true);
        modal.root.querySelector('.vcp-harness-modal-close').click();
        assert.equal(closes, 3);
        await modal.dispose();
        assert.equal(document.querySelector('.vcp-harness-modal-root'), null);

        const headlessBody = document.createElement('article');
        headlessBody.textContent = 'Custom frame';
        let headless;
        headless = mountModal({ title: 'Custom frame', body: headlessBody, headless: true, onClose: () => headless.setOpen(false) }, scope);
        headless.setOpen(true);
        assert.equal(headless.dialog.firstElementChild, headlessBody);
        assert.equal(headless.dialog.querySelector('.vcp-harness-modal-header'), null);
        assert.equal(headless.dialog.querySelector('.vcp-harness-modal-footer'), null);
        headless.setOpen(false);
        assert.equal(headlessBody.parentNode, null);
        await headless.dispose();
        await scope.dispose('modal-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness RiskConfirmation gates confirm behind a controlled acknowledgement and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><main><span id="before"></span><span id="after"></span></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('risk-confirmation-test'));
        const events = [];
        let risk;
        risk = mountRiskConfirmation({
            title: 'Allow external command?', description: 'This may access files.', acknowledgeLabel: 'I understand.',
            cancelLabel: 'Cancel', confirmLabel: 'Allow command', acknowledged: false,
            onAcknowledgedChange: value => { events.push(`ack:${value}`); risk.setAcknowledged(value); },
            onCancel: () => { events.push('cancel'); risk.setOpen(false); }, onConfirm: () => { events.push('confirm'); risk.setOpen(false); },
        }, scope);
        assert.equal(risk.open, false);
        risk.setOpen(true);
        assert.equal(risk.modal.root.parentElement, document.body);
        assert.equal(risk.modal.dialog.classList.contains('vcp-harness-risk-confirmation'), true);
        assert.equal(risk.modal.root.querySelector('.vcp-harness-risk-warning-icon')?.getAttribute('aria-hidden'), 'true');
        assert.equal(risk.acknowledgement.type, 'checkbox');
        assert.equal(risk.confirmButton.disabled, true);
        assert.equal(document.activeElement, risk.acknowledgement);
        risk.confirmButton.click();
        assert.deepEqual(events, []);
        risk.acknowledgement.checked = true;
        risk.acknowledgement.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        assert.deepEqual(events, ['ack:true']);
        assert.equal(risk.confirmButton.disabled, false);
        risk.confirmButton.click();
        assert.deepEqual(events, ['ack:true', 'confirm']);
        assert.equal(risk.open, false);
        risk.setOpen(true); risk.setDisabled(true);
        assert.equal(risk.acknowledgement.disabled, true);
        assert.equal(risk.confirmButton.disabled, true);
        risk.modal.root.querySelector('.vcp-harness-modal-mask').click();
        assert.deepEqual(events, ['ack:true', 'confirm', 'cancel']);
        risk.setOpen(true);
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.deepEqual(events, ['ack:true', 'confirm', 'cancel', 'cancel']);
        await risk.dispose();
        assert.equal(document.querySelector('.vcp-harness-modal-root'), null);
        await scope.dispose('risk-confirmation-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness AgentPresetSeat stages picks over a portal menu and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><main><button id="seat" class="legacy-seat">Legacy</button></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('agent-preset-seat-test'));
        const seatButton = document.getElementById('seat');
        const events = [];
        const options = [
            { id: 'standard', name: 'Standard mode', description: 'Full coding agent.' },
            { id: 'minimal', name: 'Minimal mode', description: 'Two-tool agent.' },
            { id: 'bare', description: undefined },
        ];
        const seat = mountAgentPresetSeat(seatButton, {
            options,
            selectedId: 'standard',
            // Owner-controlled: the staged choice lives with the caller, so the
            // callback projects it back (no second durable state inside).
            onSelect: id => { events.push(id); seat.setSelected(id); },
            onClose: () => events.push('close'),
        }, scope);
        // Closed chip geometry contract (AgentPresetSeat.module.css): 28px pill,
        // 16px icon, 14px chevron, aria-haspopup/expanded, staged preset label.
        assert.equal(seatButton.className.includes('vcp-agent-preset-seat'), true);
        assert.equal(seatButton.getAttribute('aria-haspopup'), 'menu');
        assert.equal(seatButton.getAttribute('aria-expanded'), 'false');
        assert.equal(seatButton.getAttribute('title'), 'Agent preset for the session you are about to start');
        assert.equal(seatButton.textContent.includes('Standard mode'), true);
        assert.equal(seat.button.querySelector('.vcp-agent-preset-seat-icon')?.getAttribute('aria-hidden'), 'true');
        assert.equal(seat.button.querySelector('.vcp-agent-preset-seat-chevron')?.getAttribute('aria-hidden'), 'true');
        assert.equal(seat.menu?.open, false);

        seat.setOpen(true);
        assert.equal(seat.open, true);
        assert.equal(seatButton.getAttribute('aria-expanded'), 'true');
        const portalList = document.body.querySelector('.vcp-harness-menu-list[role="menu"]');
        assert.ok(portalList, 'expected body-portal menu');
        const labels = [...portalList.querySelectorAll('.vcp-harness-menu-item-label')];
        assert.equal(labels.length, 3);
        assert.ok(labels[0].querySelector('.vcp-agent-preset-seat-item-name')?.textContent === 'Standard mode');
        assert.ok(labels[0].querySelector('.vcp-agent-preset-seat-item-desc')?.textContent === 'Full coding agent.');
        // Harness renders `noDescription` copy when a preset publishes none; the
        // bare option still falls back to its id for the name.
        assert.ok(labels[2].querySelector('.vcp-agent-preset-seat-item-name')?.textContent === 'bare');
        assert.ok(labels[2].querySelector('.vcp-agent-preset-seat-item-desc')?.textContent === 'No description');
        assert.equal(portalList.querySelector('[data-selected="true"] .vcp-agent-preset-seat-item-name')?.textContent, 'Standard mode');

        // Picking reports the pick; Menu.onClose only fires for outside/Escape,
        // so no 'close' event lands here (Harness contract).
        portalList.querySelectorAll('[role="menuitem"]')[1].click();
        assert.deepEqual(events, ['minimal']);
        assert.equal(seat.selectedLabel(), 'Minimal mode');

        // Busy disables the trigger without touching the staged choice.
        seat.setBusy(true);
        assert.equal(seatButton.disabled, true);
        seat.setBusy(false);
        assert.equal(seatButton.disabled, false);

        // Error surfaces through the title (Harness: title={state.error ?? t('seatHint')}).
        seat.setError('Could not stage the preset. Try again.');
        assert.equal(seatButton.getAttribute('title'), 'Could not stage the preset. Try again.');

        // Roster swap keeps the menu contract and drops a removed selection.
        await seat.setOptions([{ id: 'code', name: 'Code mode' }]);
        assert.equal(seat.selectedLabel(), '');
        seat.setSelected('code');
        assert.equal(seat.selectedLabel(), 'Code mode');

        await seat.dispose();
        assert.equal(seatButton.className, 'legacy-seat');
        assert.equal(seatButton.textContent, 'Legacy');
        assert.equal(seatButton.hasAttribute('title'), false);
        assert.equal(document.body.querySelector('.vcp-harness-menu-list'), null);
        await scope.dispose('agent-preset-seat-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness AgentPresetRow composes the 36px PresetMenu pill with the trust suffix and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="host"><span class="legacy-child">legacy</span></div></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('agent-preset-row-test'));
        const host = document.getElementById('host');
        const events = [];
        // Harness presets: trust==='user' options get `· <userTrust>` appended
        // by PresetMenu; built-in ones render bare.
        const options = [
            { id: 'standard', name: 'Standard mode', trust: 'system' },
            { id: 'draft', name: 'Research draft', trust: 'user' },
            { id: 'minimal', description: 'Two-tool agent.' },
        ];
        const row = mountAgentPresetRow(host, {
            options,
            currentValue: 'standard',
            onSelect: id => { events.push(id); row.setCurrent(id); },
            onClose: () => events.push('close'),
        }, scope);
        // Row contract (AgentPresetRow.module.css): text column over pill inside
        // a bordered flex row; the host's original children come back on dispose.
        assert.equal(document.querySelector('.vcp-agent-preset-row') instanceof dom.window.HTMLDivElement, true);
        assert.ok(document.querySelector('.vcp-agent-preset-row-title')?.textContent === 'Agent preset');
        assert.ok(document.querySelector('.vcp-agent-preset-row-desc')?.textContent === 'Applies to sessions you start from now on. Running sessions keep the preset they began with.');
        assert.equal(document.querySelector('.vcp-agent-preset-row-desc')?.getAttribute('role'), null);
        const trigger = document.querySelector('.vcp-agent-preset-selector');
        assert.ok(trigger === row.trigger);
        assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.ok(row.root.textContent.includes('Standard mode'));

        row.setOpen(true);
        assert.equal(row.open, true);
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        const portalList = document.body.querySelector('.vcp-harness-menu-list[role="menu"]');
        assert.ok(portalList, 'expected align-end body-portal menu');
        assert.equal(portalList.classList.contains('vcp-harness-menu-align-end'), true);
        const labels = [...portalList.querySelectorAll('.vcp-harness-menu-item-label')];
        assert.deepEqual(labels.map(node => node.textContent), [
            'Standard mode',
            'Research draft · Custom',
            'minimal',
        ]);
        assert.equal(portalList.querySelector('[data-selected="true"] .vcp-harness-menu-item-label')?.textContent, 'Standard mode');

        // Picking closes the menu (PresetMenu: onOpenChange(false) then select)
        // and reports the pick to the caller, who owns the projection.
        portalList.querySelectorAll('[role="menuitem"]')[1].click();
        assert.deepEqual(events, ['draft']);
        assert.equal(row.selectedLabel(), 'Research draft');
        assert.equal(row.open, false);

        // Disabled rule mirrors AgentPresetRow.tsx: busy || !writable || none.
        row.setBusy(true);
        assert.equal(trigger.disabled, true);
        row.setBusy(false);
        row.setWritable(false);
        assert.equal(trigger.disabled, true);
        row.setWritable(true);
        await row.setOptions([]);
        assert.equal(trigger.disabled, true);
        // Loading copy wins while the current value is empty (label fallback chain).
        row.setCurrent('');
        assert.ok(trigger.textContent.startsWith('Loading presets…'));
        await row.setOptions(options);
        row.setCurrent('unknown-id');
        assert.ok(row.trigger.textContent.includes('unknown-id'));

        // Errors replace the description and surface through role="alert".
        row.setError('Could not load presets. Try again.');
        const desc = document.querySelector('.vcp-agent-preset-row-desc');
        assert.ok(desc?.textContent === 'Could not load presets. Try again.');
        assert.equal(desc?.getAttribute('role'), 'alert');
        row.setError(null);
        assert.equal(desc?.getAttribute('role'), null);

        await row.dispose();
        assert.equal(host.querySelector('.vcp-agent-preset-row'), null);
        assert.ok(host.querySelector('.legacy-child'), 'expected original children restored');
        assert.equal(document.body.querySelector('.vcp-harness-menu-list'), null);
        await scope.dispose('agent-preset-row-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness semantic icon slots preserve one VCP icon owner and retract cleanly', async () => {
    const dom = new JSDOM('<!doctype html><main><span id="host" class="legacy"><em id="legacy">legacy</em></span></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window; const previousIcons = globalThis.VCPIcons;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    const refreshed = [];
    globalThis.VCPIcons = { refresh(root) { refreshed.push(root); } };
    try {
        const scope = createUiScope(new LifecycleScope('semantic-icon-test'));
        const host = document.getElementById('host');
        const icon = mountSemanticIcon(host, { name: 'warning', size: 18 }, scope);
        assert.equal(icon.root.getAttribute('aria-hidden'), 'true');
        assert.equal(icon.root.style.getPropertyValue('--vcp-harness-icon-size'), '18px');
        assert.equal(icon.root.querySelector('.vcp-ui-icon')?.textContent, 'warning');
        assert.equal(refreshed.length, 1);
        icon.setName('chevron-down');
        assert.equal(icon.root.querySelector('.vcp-ui-icon')?.textContent, 'chevron_down');
        icon.setSize(14);
        assert.equal(icon.root.style.getPropertyValue('--vcp-harness-icon-size'), '14px');
        assert.throws(() => icon.setName('unknown'), /Unknown Harness semantic icon/);
        await icon.dispose();
        assert.equal(host.className, 'legacy');
        assert.equal(host.firstElementChild.id, 'legacy');
        await scope.dispose('semantic-icon-complete');
    } finally {
        globalThis.document = previousDocument; globalThis.window = previousWindow;
        if (previousIcons === undefined) Reflect.deleteProperty(globalThis, 'VCPIcons'); else globalThis.VCPIcons = previousIcons;
        dom.window.close();
    }
});

test('Harness Menu owns open effects, composite entries, portal placement and teardown', async () => {
    const dom = new JSDOM('<!doctype html><main><button id="trigger" aria-expanded="legacy">Options</button><button id="outside">Outside</button></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('menu-test'));
        const trigger = document.getElementById('trigger');
        const selected = [];
        let closes = 0;
        const menu = mountMenu(trigger, {
            portal: true,
            dense: true,
            align: 'end',
            selectedIds: ['workspace', 'updated'],
            items: [
                { type: 'label', id: 'group', text: 'Group by' },
                { id: 'workspace', label: 'Workspace' },
                { id: 'flat', label: 'Flat', disabled: true },
                { type: 'separator', id: 'separator' },
                { id: 'updated', label: 'Updated' },
                { id: 'danger', label: 'Remove', danger: true },
                { id: 'layout', label: 'Layout', submenu: [{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }] },
            ],
            footer: [{ id: 'settings', label: 'Settings' }],
            onSelect: id => selected.push(id),
            onClose: () => { closes += 1; },
        }, scope);
        trigger.getBoundingClientRect = () => ({ left: 900, right: 1020, top: 700, bottom: 740, width: 120, height: 40, x: 900, y: 700, toJSON() {} });
        Object.defineProperties(menu.list, { offsetWidth: { value: 218 }, offsetHeight: { value: 300 } });
        menu.setOpen(true);
        window.dispatchEvent(new dom.window.Event('resize'));
        assert.equal(menu.list.getAttribute('role'), 'menu');
        assert.equal(menu.list.style.left, '794px');
        assert.equal(menu.list.style.top, '456px');
        assert.equal(menu.list.querySelector('.vcp-harness-menu-label')?.textContent, 'Group by');
        assert.ok(menu.list.querySelector('[role="separator"]'));
        assert.ok(menu.list.querySelector('.vcp-harness-menu-footer'));
        assert.equal(menu.list.querySelector('[role="menuitem"]:disabled')?.textContent, 'Flat');
        assert.equal(menu.list.querySelector('.vcp-harness-menu-item-danger')?.textContent, 'Remove');
        assert.equal(menu.list.querySelectorAll('.vcp-harness-menu-item-check').length, 2);
        const layout = [...menu.list.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Layout');
        layout.focus();
        assert.equal(layout.getAttribute('aria-expanded'), 'true');
        assert.equal(menu.list.querySelector('.vcp-harness-submenu[role="menu"]')?.children.length, 2);
        menu.list.querySelector('.vcp-harness-submenu [role="menuitem"]').click();
        assert.deepEqual(selected, ['list']);
        menu.setSelected('danger');
        assert.equal(menu.list.querySelectorAll('.vcp-harness-menu-item-check').length, 1);
        document.getElementById('outside').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
        assert.equal(menu.open, false);
        assert.equal(closes, 1);
        menu.setOpen(true);
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(menu.open, false);
        assert.equal(closes, 2);
        await menu.dispose();
        assert.equal(trigger.parentElement.tagName, 'MAIN');
        assert.equal(trigger.getAttribute('aria-haspopup'), null);
        assert.equal(trigger.getAttribute('aria-expanded'), 'legacy');
        await scope.dispose('menu-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Menu accepts Node labels matching the ReactNode source contract', async () => {
    const dom = new JSDOM('<!doctype html><main><button id="trigger">Preset</button></main>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('menu-node-label-test'));
        const trigger = document.getElementById('trigger');
        const picked = [];
        // Harness AgentPresetSeat renders `label` as a span with name over
        // description; the Menu atom contract is ReactNode, not string-only.
        const seatItem = document.createElement('span');
        seatItem.className = 'vcp-agent-preset-seat-item';
        const name = document.createElement('span'); name.className = 'vcp-agent-preset-seat-item-name'; name.textContent = 'Standard mode';
        const desc = document.createElement('span'); desc.className = 'vcp-agent-preset-seat-item-desc'; desc.textContent = 'Full toolset';
        seatItem.append(name, desc);
        const menu = mountMenu(trigger, {
            items: [
                { id: 'standard', label: seatItem },
                { id: 'minimal', label: 'Minimal mode' },
            ],
            selectedId: 'standard',
            onSelect: id => picked.push(id),
        }, scope);
        menu.setOpen(true);
        const labelNode = menu.list.querySelector('.vcp-harness-menu-item-label');
        assert.ok(labelNode?.querySelector('.vcp-agent-preset-seat-item .vcp-agent-preset-seat-item-name'));
        assert.equal(labelNode.textContent, 'Standard modeFull toolset');
        menu.list.querySelectorAll('[role="menuitem"]')[1].click();
        assert.deepEqual(picked, ['minimal']);
        await menu.dispose();
        await scope.dispose('menu-node-label-complete');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Button preserves native semantics and retracts candidate styling', async () => {
    const dom = new JSDOM('<!doctype html><button id="action" class="existing">Run</button>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('button-test'));
        const button = document.getElementById('action');
        const icon = document.createElement('span'); icon.textContent = '+';
        const release = mountButton(button, { variant: 'primary', size: 'sm', icon }, scope);
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.classList.contains('primary'), true);
        assert.equal(button.classList.contains('sm'), true);
        assert.equal(button.style.getPropertyValue('display'), 'inline-flex');
        assert.equal(button.style.getPropertyPriority('display'), 'important');
        assert.equal(button.style.getPropertyValue('height'), '28px');
        assert.equal(button.style.getPropertyPriority('height'), 'important');
        assert.equal(button.querySelector(':scope > .icon')?.textContent, '+');
        await release?.(); await scope.dispose('button-complete');
        assert.equal(button.getAttribute('class'), 'existing');
        assert.equal(button.style.getPropertyValue('display'), '');
        assert.equal(button.style.getPropertyValue('height'), '');
        assert.equal(button.querySelector('.icon'), null);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness-compatible Field and Select keep Light DOM contract and dispose cleanly', async () => {
    const dom = new JSDOM('<!doctype html><form><div id="field"><select id="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div></form>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('primitive-test'));
        const fieldRoot = document.getElementById('field');
        const select = document.getElementById('density');
        const fieldRelease = mountField(fieldRoot, { label: 'Density', description: 'Controls UI density.', control: select }, scope);
        const selectRelease = mountSelect(select, { label: 'Density' }, scope);
        assert.equal(fieldRoot.querySelector('.vcp-harness-field-head > .vcp-harness-field-label')?.htmlFor, 'density');
        assert.equal(select.getAttribute('aria-describedby'), null);
        assert.equal(fieldRoot.querySelector('p.vcp-harness-field-description')?.textContent, 'Controls UI density.');
        assert.equal(fieldRoot.querySelector('.vcp-harness-select-trigger')?.textContent, 'Comfortable');
        assert.equal(fieldRoot.querySelector('[role="menu"]'), null);
        const trigger = fieldRoot.querySelector('.vcp-harness-select-trigger');
        trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.equal(fieldRoot.querySelector('[role="menu"]')?.children.length, 1);
        assert.equal(fieldRoot.querySelector('[role="menu"] > .vcp-harness-menu-viewport')?.children.length, 2);
        assert.equal(fieldRoot.querySelector('.vcp-harness-menu-item-wrap > [role="menuitem"]')?.textContent, 'Comfortable');
        assert.ok(fieldRoot.querySelector('[role="menuitem"][data-selected="true"] .vcp-harness-menu-item-check'));
        assert.equal(fieldRoot.querySelector('[role="menuitem"]:not([data-selected="true"]) .vcp-harness-menu-item-check'), null);
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        await selectRelease?.();
        await fieldRelease?.();
        await scope.dispose('test-complete');
        assert.equal(fieldRoot.querySelector('.vcp-harness-field'), null);
        assert.equal(document.querySelector('.vcp-harness-select-trigger'), null);
        assert.equal(document.getElementById('density')?.tabIndex, 0);
        assert.equal(select.getAttribute('aria-describedby'), null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Input keeps native control and restores DOM on dispose', async () => {
    const dom = new JSDOM('<!doctype html><label id="field"><span>Tagline</span><input id="tagline" value="Hello"></label>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('input-test'));
        const input = document.getElementById('tagline');
        const release = mountInput(input, {}, scope);
        assert.equal(input.parentElement.classList.contains('vcp-uiux-input-wrap'), true);
        assert.equal(input.parentElement.classList.contains('wrap'), true);
        assert.equal(input.classList.contains('input'), true);
        assert.equal(input.value, 'Hello');
        assert.equal(input.parentElement.getAttribute('role'), null);
        await release?.();
        assert.equal(input.parentElement.id, 'field');
        await scope.dispose('input-complete');
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Choice decorates native radios and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><div id="choices"><label><input type="radio" name="r" value="a">A</label><label><input type="radio" name="r" value="b">B</label></div>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('choice-test')); const root = document.getElementById('choices');
        const release = mountChoice(root, scope);
        assert.equal(root.classList.contains('vcp-uiux-choice'), true);
        root.querySelector('input[value="b"]').click();
        assert.equal(root.dataset.value, 'b');
        await release?.(); await scope.dispose('choice-complete');
        assert.equal(root.classList.contains('vcp-uiux-choice'), false);
        assert.equal(root.querySelector('label').classList.contains('vcp-uiux-choice-option'), false);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Range keeps native value, output sync, and teardown', async () => {
    const dom = new JSDOM('<!doctype html><label id="field"><output id="out"></output><input id="range" type="range" value="32"><span id="after"></span></label>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('range-test')); const input = document.getElementById('range'); const output = document.getElementById('out');
        const release = mountRange(input, { output }, scope);
        assert.equal(input.parentElement.className, 'vcp-uiux-range'); assert.equal(output.textContent, '32px');
        input.value = '40'; input.dispatchEvent(new dom.window.Event('input')); assert.equal(output.textContent, '40px');
        await release?.(); await scope.dispose('range-complete'); assert.equal(input.parentElement.id, 'field'); assert.equal(output.parentElement.id, 'field');
        assert.deepEqual([...document.getElementById('field').children].map(node => node.id), ['out', 'range', 'after']);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Toggle keeps native checkbox and retires legacy slider', async () => {
    const dom = new JSDOM('<!doctype html><label class="switch" id="toggle"><input type="checkbox"><span class="slider"></span></label>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('toggle-test')); const input = document.querySelector('input'); const slider = document.querySelector('.slider');
        const release = mountToggle(input, scope);
        assert.equal(input.parentElement.className, 'vcp-uiux-toggle'); assert.equal(slider.style.display, 'none');
        await release?.(); await scope.dispose('toggle-complete');
        assert.equal(input.parentElement.id, 'toggle'); assert.equal(slider.style.display, '');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness ColorPair synchronizes source and mirror with invalid rollback', async () => {
    const dom = new JSDOM('<!doctype html><div id="pair"><input id="color" type="color" value="#3d5a80"><input id="text" type="text" value="#3d5a80"></div>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window; globalThis.document = dom.window.document; globalThis.window = dom.window;
    try { const scope = createUiScope(new LifecycleScope('color-pair')); const color = document.getElementById('color'); const text = document.getElementById('text'); const release = mountColorPair(color, text, scope); assert.equal(text.value, '#3d5a80'); text.value = '#112233'; text.dispatchEvent(new dom.window.Event('change')); assert.equal(color.value, '#112233'); text.value = 'invalid'; text.dispatchEvent(new dom.window.Event('change')); assert.equal(text.value, '#112233'); await release?.(); await scope.dispose('color-pair-complete'); assert.equal(color.parentElement.id, 'pair'); } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Select interaction sequence matches keyboard and ownership contract', async () => {
    const dom = new JSDOM('<!doctype html><main><select id="mode" tabindex="3" aria-hidden="false"><option>One</option><option>Two</option><option>Three</option></select><button id="outside">Outside</button></main>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('select-sequence'));
        const select = document.getElementById('mode');
        const outside = document.getElementById('outside');
        const release = mountSelect(select, { label: 'Mode', portal: true }, scope);
        const trigger = document.querySelector('.vcp-harness-select-trigger');
        let anchor = { left: 900, bottom: 800, width: 120 };
        trigger.getBoundingClientRect = () => ({ ...anchor, top: anchor.bottom - 40, right: anchor.left + anchor.width, height: 40, x: anchor.left, y: anchor.bottom - 40, toJSON() {} });
        trigger.focus();
        trigger.click();
        const menu = document.getElementById('mode-menu');
        Object.defineProperties(menu, { offsetWidth: { value: 220 }, offsetHeight: { value: 180 } });
        window.dispatchEvent(new dom.window.Event('resize'));
        assert.equal(menu.style.left, '792px');
        assert.equal(menu.style.top, '576px');
        anchor = { left: 24, bottom: 84, width: 160 };
        window.dispatchEvent(new dom.window.Event('scroll'));
        assert.equal(menu.style.left, '24px');
        assert.equal(menu.style.top, '88px');
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(document.activeElement, trigger);
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        assert.equal(document.activeElement, trigger);
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        assert.equal(document.activeElement, trigger);
        items[2].click();
        assert.equal(select.value, 'Three');
        assert.equal(trigger.textContent, 'Three');
        assert.equal(document.activeElement, trigger);
        trigger.click();
        outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        trigger.click();
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(document.activeElement, trigger);
        await release?.();
        await scope.dispose('sequence-complete');
        assert.equal(select.getAttribute('tabindex'), '3');
        assert.equal(select.getAttribute('aria-hidden'), 'false');
        assert.equal(document.querySelector('.vcp-harness-select'), null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Select external snapshot sync is presentation-only and owner-bound', async () => {
    const dom = new JSDOM('<!doctype html><select id="density"><option>Comfortable</option><option>Compact</option></select>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('select-sync'));
        const select = document.getElementById('density');
        let changes = 0;
        select.addEventListener('change', () => { changes += 1; });
        const release = mountSelect(select, { label: 'Density' }, scope);
        select.value = 'Compact';
        select.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
        const trigger = document.querySelector('.vcp-harness-select-trigger');
        assert.equal(trigger.textContent, 'Compact');
        assert.equal(changes, 0);
        await release?.();
        select.value = 'Comfortable';
        select.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
        assert.equal(document.querySelector('.vcp-harness-select-trigger'), null);
        assert.equal(changes, 0);
        await scope.dispose('sync-complete');
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Input/Field/Select expose stable error, disabled and selected state contracts', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="field"><select id="mode"><option value="a">Alpha</option><option value="b" selected>Beta</option></select></div><input id="name" disabled></main>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('primitive-state-contract'));
        const fieldRoot = document.getElementById('field');
        const select = document.getElementById('mode');
        const input = document.getElementById('name');
        const fieldRelease = mountField(fieldRoot, { label: 'Mode', description: 'Choose a mode.', error: 'Mode is unavailable.', control: select }, scope);
        const selectRelease = mountSelect(select, { label: 'Mode' }, scope);
        const inputRelease = mountInput(input, {}, scope);
        const trigger = fieldRoot.querySelector('.vcp-harness-select-trigger');
        assert.equal(select.getAttribute('aria-invalid'), 'true');
        assert.equal(select.getAttribute('aria-describedby'), null);
        assert.equal(trigger.textContent, 'Beta');
        trigger.click();
        assert.equal(fieldRoot.querySelector('[role="menuitem"][data-selected="true"]')?.textContent, 'Beta');
        select.disabled = true;
        trigger.click();
        assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'disabled select must not open');
        assert.equal(input.disabled, true);
        await inputRelease?.();
        await selectRelease?.();
        await fieldRelease?.();
        await scope.dispose('state-contract-complete');
        assert.equal(select.getAttribute('aria-invalid'), null);
        assert.equal(select.getAttribute('aria-describedby'), null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness DiffBlock stays lab-only, collapses, copies and restores its host', async () => {
    const dom = new JSDOM('<!doctype html><div id="host"><span>original</span></div>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('diff-block'));
        const host = document.getElementById('host'); let copied = '';
        const diff = mountDiffBlock(host, { maxLines: 2, copy: value => { copied = value; }, diffs: [{ path: 'a.ts', oldText: 'one\ntwo', newText: 'three\nfour' }] }, scope);
        assert.equal(host.querySelector('[data-diff]'), diff.root);
        assert.ok(host.querySelector('.vcp-harness-diff-expand'));
        host.querySelector('.vcp-harness-diff-copy').click();
        assert.match(copied, /- one/); assert.match(copied, /\+ three/);
        diff.setExpanded(true);
        assert.equal(host.querySelector('.vcp-harness-diff-expand'), null);
        await diff.dispose(); await scope.dispose('done');
        assert.equal(host.textContent, 'original');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});
