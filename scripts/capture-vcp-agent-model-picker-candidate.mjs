import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeout = 45_000;
const captureMode = process.env.VCP_MODEL_PICKER_MODE === 'harness-equivalent' ? 'harness-equivalent' : 'vcp-enhanced';
// A state scenario is deliberately orthogonal to the visual fixture mode.
// `load-error-retry` records the real generated primitive's asynchronous
// catalog transition.  Harness has a source-level client test for this state,
// but no reproducible production-page failure injection yet, so this report
// must remain test-derived evidence rather than a production visual baseline.
const captureScenario = process.env.VCP_MODEL_PICKER_SCENARIO === 'load-error-retry'
    ? 'load-error-retry'
    : 'ready-selected';
const outputStem = captureMode === 'harness-equivalent'
    ? 'vcp-agent-model-picker-harness-equivalent'
    : 'vcp-agent-model-picker-candidate';
const scenarioOutputStem = captureScenario === 'ready-selected'
    ? outputStem
    : `${outputStem}-${captureScenario}`;
const sameEngineReferenceStem = captureScenario === 'ready-selected'
    ? 'harness-agent-model-picker-electron-reference'
    : `harness-agent-model-picker-electron-reference-${captureScenario}`;
const harnessModelSelectCssPath = '/Users/asahi/Documents/Codex/deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.module.css';
const harnessModelSelectCss = await fs.readFile(harnessModelSelectCssPath, 'utf8');
const harnessReferenceClasses = Object.freeze({
    root: 'vcp-harness-reference-model-root', menu: 'vcp-harness-reference-model-menu',
    groups: 'vcp-harness-reference-model-groups', group: 'vcp-harness-reference-model-group',
    groupTitle: 'vcp-harness-reference-model-group-title', option: 'vcp-harness-reference-model-option',
    optionCopy: 'vcp-harness-reference-model-option-copy', modelName: 'vcp-harness-reference-model-name',
    check: 'vcp-harness-reference-model-check', selected: 'vcp-harness-reference-model-selected',
});
const harnessModelSelectElectronCss = Object.entries(harnessReferenceClasses).reduce(
    (css, [source, target]) => css.replace(new RegExp(`\\.${source}\\b`, 'g'), `.${target}`),
    harnessModelSelectCss,
);
// ModelSelect relies on the Harness web shell's scoped form-control reset.
// Keep that production prerequisite in this Electron source reference; without
// it Chromium gives the source `<button>` Arial while the candidate correctly
// inherits the Harness system stack, turning a fixture omission into a false
// visual regression.
const harnessModelSelectElectronBaseCss = `.${harnessReferenceClasses.root}{font-family:var(--dsw-font-family)}.${harnessReferenceClasses.root} button{font-family:inherit}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = url => new Promise((resolve, reject) => {
    http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject);
});

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-agent-model-picker-'));
await fs.mkdir(path.join(appData, 'Agents', 'PickerProbe'), { recursive: true });
await fs.writeFile(path.join(appData, 'Agents', 'PickerProbe', 'config.json'), JSON.stringify({
    name: 'Picker Probe', model: 'picker-probe', promptMode: 'original',
    originalSystemPrompt: 'Picker probe', systemPrompt: 'Picker probe', stripRegexes: [],
}), 'utf8');
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', assistantAgent: 'PickerProbe', currentThemeMode: 'light',
    vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'picker-probe',
}), 'utf8');

let port = 0;
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', () => { port = probe.address().port; probe.close(resolve); }));
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(1_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.unref();
};
let browser;
try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
    assert.ok(page, `Agent Model Picker renderer missing: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
    const evidence = await page.evaluate(async ({ mode, scenario }) => {
        const host = document.createElement('div');
        // Candidate captures run in the same UI scope as production so the
        // existing Lucide icon adapter can resolve semantic icons synchronously.
        host.className = 'vcp-ui-scope';
        host.dataset.vcpCandidateAgentModelPicker = 'true';
        // Isolate the synthetic fixture from the real chat surface so the
        // primitive ROI measures its own pixels, not an unrelated stacking
        // context painted above a fixed host.
        // Keep the menu's right edge on a device pixel.  The Harness capture
        // uses an integer-origin clip; a fractional origin changes text and
        // rounded-corner rasterization even when computed geometry matches.
        host.style.cssText = 'position:fixed;left:480.3359375px;top:420px;z-index:2000;width:280px;height:140px;padding:16px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:candidate-agent-model-picker');
        const selected = [];
        const efforts = [];
        let loadAttempts = 0;
        let rejectFirstLoad = null;
        const picker = window.VCPUIUX.mountAgentModelPicker(host, {
            label: 'Agent model', selectedId: mode === 'harness-equivalent' ? 'acme-think' : 'gpt-4o', selectedEffort: mode === 'harness-equivalent' ? 'high' : 'balanced',
            searchEnabled: mode !== 'harness-equivalent',
            harnessEquivalent: mode === 'harness-equivalent',
            efforts: mode === 'harness-equivalent' ? [
                { id: 'off', label: 'Off' },
                { id: 'high', label: 'High' },
                { id: 'max', label: 'Max' },
            ] : [
                { id: 'balanced', label: 'Balanced', description: 'Provider default' },
                { id: 'deep', label: 'Deep reasoning', description: 'More reasoning effort' },
            ],
            options: async signal => {
                loadAttempts += 1;
                if (scenario === 'load-error-retry' && loadAttempts === 1) {
                    return await new Promise((resolve, reject) => {
                        rejectFirstLoad = () => reject(new Error('catalog unavailable'));
                        signal.addEventListener('abort', () => resolve([]), { once: true });
                    });
                }
                if (signal.aborted) return [];
                return mode === 'harness-equivalent' ? [
                    { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', provider: 'DeepSeek' },
                    { id: 'acme-think', label: 'Acme Think', provider: 'Acme Gateway' },
                ] : [
                    { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', favorite: true },
                    { id: 'claude-3-7', label: 'Claude 3.7 Sonnet', provider: 'Anthropic' },
                    { id: 'local-llama', label: 'Llama 3.3', provider: 'Local', disabled: true },
                ];
            },
            onSelect: option => selected.push(option.id),
            onEffortSelect: option => efforts.push(option.id),
        }, scope);
        picker.open();
        await new Promise(resolve => setTimeout(resolve, 0));
        const rootPane = {
            expanded: picker.trigger.getAttribute('aria-expanded'),
            triggerHeight: getComputedStyle(picker.trigger).height,
            cardPresent: Boolean(host.querySelector('.vcp-harness-popup-select-card')),
            modelRowVisible: host.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden === false,
            effortRowVisible: host.querySelectorAll('.vcp-harness-agent-model-picker-cell')[1]?.hidden === false,
        };
        const modelRow = host.querySelector('.vcp-harness-agent-model-picker-cell');
        modelRow?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        let loadErrorRetry = null;
        if (scenario === 'load-error-retry') {
            const card = host.querySelector('.vcp-harness-popup-select-card');
            const status = card?.querySelector('.vcp-harness-popup-select-status');
            const pending = {
                status: picker.popup.getSnapshot().status,
                ariaBusy: card?.getAttribute('aria-busy') ?? null,
                text: status?.textContent ?? '',
            };
            if (typeof rejectFirstLoad !== 'function') throw new Error('load-error-retry fixture did not start its first catalog load');
            rejectFirstLoad();
            await new Promise(resolve => setTimeout(resolve, 0));
            const alert = card?.querySelector('[role="alert"]');
            const retry = card?.querySelector('.vcp-harness-popup-select-retry');
            const failed = {
                status: picker.popup.getSnapshot().status,
                ariaBusy: card?.getAttribute('aria-busy') ?? null,
                alertRole: alert?.getAttribute('role') ?? null,
                alertText: alert?.textContent ?? '',
                retryVisible: retry instanceof HTMLElement && getComputedStyle(retry).display !== 'none',
                retryTag: retry?.tagName.toLowerCase() ?? null,
                retryClass: retry?.className ?? null,
                errorOuterHtml: alert?.outerHTML ?? '',
            };
            retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const retryPending = {
                status: picker.popup.getSnapshot().status,
                ariaBusy: card?.getAttribute('aria-busy') ?? null,
            };
            await new Promise(resolve => setTimeout(resolve, 0));
            loadErrorRetry = {
                evidenceKind: 'VCP Electron generated-artifact capture; Harness source-test-derived state reference only',
                harnessSource: 'packages/client/ui-model-selection/tests/model-select.client.spec.tsx: rejected catalog loads retain the in-menu Retry strip; rejected selections use Toast instead',
                pending,
                failed,
                retryPending,
                settled: {
                    status: picker.popup.getSnapshot().status,
                    optionCount: card?.querySelector('.vcp-harness-popup-select-viewport')?.querySelectorAll('[role="menuitemradio"]').length ?? 0,
                    ariaBusy: card?.getAttribute('aria-busy') ?? null,
                    loadAttempts,
                },
            };
        }
        const optionSelector = mode === 'harness-equivalent' ? '[role="menuitemradio"]' : '[role="option"]';
        const optionRoot = '.vcp-harness-popup-select-viewport';
        const selectedSelector = `${optionRoot} ${mode === 'harness-equivalent' ? `${optionSelector}[aria-checked="true"]` : `${optionSelector}[aria-selected="true"]`}`;
        const modelPane = {
            searchVisible: host.querySelector('.vcp-harness-popup-select-search')?.hidden === false,
            groupCount: host.querySelectorAll(`${optionRoot} section[role="group"]`).length,
            optionRole: host.querySelector(`${optionRoot} ${optionSelector}`) ? (mode === 'harness-equivalent' ? 'menuitemradio' : 'option') : null,
            optionCount: host.querySelectorAll(`${optionRoot} ${optionSelector}`).length,
            selectedOption: host.querySelector(selectedSelector)?.textContent?.trim() || null,
            disabledOptions: [...host.querySelectorAll(`${optionRoot} ${optionSelector}[aria-disabled="true"]`)].map(node => node.textContent?.trim() || null),
            optionRects: [...host.querySelectorAll(`${optionRoot} ${optionSelector}`)].map(node => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
            groupTitleRects: [...host.querySelectorAll(`${optionRoot} .vcp-harness-popup-select-group-title`)].map(node => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
            groupRects: [...host.querySelectorAll(`${optionRoot} section[role="group"]`)].map(node => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
            optionStyles: [...host.querySelectorAll(`${optionRoot} ${optionSelector}`)].slice(0, 2).map(node => {
                const style = getComputedStyle(node);
                return {
                    color: style.color,
                    backgroundColor: style.backgroundColor,
                    opacity: style.opacity,
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSize,
                    fontWeight: style.fontWeight,
                    lineHeight: style.lineHeight,
                    padding: style.padding,
                    gap: style.gap,
                    borderRadius: style.borderRadius,
                    boxSizing: style.boxSizing,
                };
            }),
            // Pixel parity has to be diagnosable at the glyph level.  Record
            // the actual semantic-token resolution of the two text layers and
            // the selected check, rather than inferring them from the parent
            // option's inherited style.
            textStyles: {
                groupTitles: [...host.querySelectorAll(`${optionRoot} .vcp-harness-popup-select-group-title`)].map(node => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, fontKerning: style.fontKerning, fontFeatureSettings: style.fontFeatureSettings, fontVariationSettings: style.fontVariationSettings, textRendering: style.textRendering, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
                }),
                modelNames: [...host.querySelectorAll(`${optionRoot} .vcp-harness-popup-select-option-label`)].map(node => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, fontKerning: style.fontKerning, fontFeatureSettings: style.fontFeatureSettings, fontVariationSettings: style.fontVariationSettings, textRendering: style.textRendering, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
                }),
                checks: [...host.querySelectorAll(`${optionRoot} .vcp-harness-popup-select-option-check`)].map(node => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, fontKerning: style.fontKerning, fontFeatureSettings: style.fontFeatureSettings, fontVariationSettings: style.fontVariationSettings, textRendering: style.textRendering, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
                }),
            },
            menuChildren: (() => {
                const menuNode = host.querySelector('.vcp-harness-popup-select-card');
                const viewport = menuNode?.querySelector('.vcp-harness-popup-select-viewport');
                const viewportStyle = viewport ? getComputedStyle(viewport) : null;
                const children = menuNode ? [...viewport?.children ?? []].map(node => {
                    const rect = node.getBoundingClientRect();
                    const style = getComputedStyle(node);
                    return {
                        tag: node.tagName.toLowerCase(),
                        className: node.className,
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                        marginTop: style.marginTop,
                        marginBottom: style.marginBottom,
                        padding: style.padding,
                        gap: style.gap,
                        boxSizing: style.boxSizing,
                    };
                }) : [];
                return {
                    viewport: viewport && viewportStyle ? {
                        rect: (() => { const rect = viewport.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
                        height: viewportStyle.height,
                        flex: viewportStyle.flex,
                        flexGrow: viewportStyle.flexGrow,
                        flexShrink: viewportStyle.flexShrink,
                        flexBasis: viewportStyle.flexBasis,
                        gap: viewportStyle.gap,
                        rowGap: viewportStyle.rowGap,
                        padding: viewportStyle.padding,
                        boxSizing: viewportStyle.boxSizing,
                        borderTop: viewportStyle.borderTopWidth,
                        borderBottom: viewportStyle.borderBottomWidth,
                        marginTop: viewportStyle.marginTop,
                        marginBottom: viewportStyle.marginBottom,
                        offsetHeight: viewport.offsetHeight,
                        clientHeight: viewport.clientHeight,
                        scrollHeight: viewport.scrollHeight,
                    } : null,
                    children,
                };
            })(),
        };
        const menu = host.querySelector('.vcp-harness-popup-select-card');
        const menuStyle = menu ? getComputedStyle(menu) : null;
        const menuStyleSnapshot = menuStyle ? {
            backgroundColor: menuStyle.backgroundColor,
            color: menuStyle.color,
            opacity: menuStyle.opacity,
            filter: menuStyle.filter,
            boxShadow: menuStyle.boxShadow,
            fontFamily: menuStyle.fontFamily,
            fontSize: menuStyle.fontSize,
            lineHeight: menuStyle.lineHeight,
            borderTopWidth: menuStyle.borderTopWidth,
            borderBottomWidth: menuStyle.borderBottomWidth,
        } : null;
        const menuRules = [...document.styleSheets].flatMap(sheet => {
            try { return [...sheet.cssRules]; } catch { return []; }
        }).filter(rule => rule.selectorText?.includes('.vcp-harness-popup-select-card'));
        const declaration = property => menuRules.map(rule => rule.style?.getPropertyValue(property)).find(Boolean) || null;
        const menuRect = menu?.getBoundingClientRect();
        const menuLayer = (() => {
            if (!menu || !menuRect) return null;
            const point = { x: menuRect.left + menuRect.width / 2, y: menuRect.top + menuRect.height / 2 };
            const topmost = document.elementFromPoint(point.x, point.y);
            const chain = [];
            let node = menu;
            while (node instanceof Element && chain.length < 8) {
                const style = getComputedStyle(node);
                chain.push({
                    tag: node.tagName.toLowerCase(),
                    id: node.id,
                    className: typeof node.className === 'string' ? node.className : '',
                    position: style.position,
                    zIndex: style.zIndex,
                    opacity: style.opacity,
                    transform: style.transform,
                });
                node = node.parentElement;
            }
            return {
                samplePoint: point,
                topmost: topmost ? {
                    tag: topmost.tagName.toLowerCase(),
                    id: topmost.id,
                    className: typeof topmost.className === 'string' ? topmost.className : '',
                } : null,
                menuContainsTopmost: topmost ? menu.contains(topmost) : false,
                ancestorChain: chain,
            };
        })();
        const modelMenuChildren = menu ? [...menu.children].map(node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
                tag: node.tagName.toLowerCase(),
                className: node.className,
                hidden: node.hidden,
                display: style.display,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
        }) : [];
        const modelViewportMetrics = (() => {
            const viewport = menu?.querySelector('.vcp-harness-popup-select-viewport');
            if (!viewport) return null;
            const style = getComputedStyle(viewport);
            const rect = viewport.getBoundingClientRect();
            return {
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                display: style.display,
                boxSizing: style.boxSizing,
                padding: style.padding,
                margin: style.margin,
                gap: style.gap,
                minHeight: style.minHeight,
                height: style.height,
                flex: style.flex,
                border: `${style.borderTopWidth} ${style.borderBottomWidth}`,
            };
        })();
        const compositingAncestors = (() => {
            const nodes = [];
            let node = menu;
            while (node && nodes.length < 8) {
                const style = getComputedStyle(node);
                nodes.push({
                    tag: node.tagName.toLowerCase(),
                    id: node.id,
                    className: node.className,
                    opacity: style.opacity,
                    backgroundColor: style.backgroundColor,
                    backgroundImage: style.backgroundImage,
                    mixBlendMode: style.mixBlendMode,
                    isolation: style.isolation,
                    filter: style.filter,
                    transform: style.transform,
                    position: style.position,
                });
                node = node.parentElement;
            }
            return nodes;
        })();
        const search = host.querySelector('.vcp-harness-popup-select-search');
        const card = host.querySelector('.vcp-harness-popup-select-card');
        if (search) search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        else card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const keyboardNavigation = {
            activeOption: host.querySelector(selectedSelector)?.textContent?.trim() || null,
            focusedOption: document.activeElement?.getAttribute?.('data-option-id') || null,
        };
        card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const modelEscape = {
            returnedToRoot: host.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden === false,
            searchHidden: host.querySelector('.vcp-harness-popup-select-search')?.hidden === true,
        };
        picker.setPane('effort');
        await new Promise(resolve => setTimeout(resolve, 0));
        const effortPane = {
            optionCount: host.querySelectorAll('.vcp-harness-agent-model-picker-option').length,
            selected: host.querySelector('.vcp-harness-agent-model-picker-option[aria-checked="true"]')?.textContent?.trim() || null,
        };
        card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const effortEscape = {
            returnedToRoot: host.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden === false,
            effortHidden: host.querySelector('.vcp-harness-agent-model-picker-effort-list')?.hidden === true,
        };
        const menuChildren = menu ? [...menu.children].map(node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
                tag: node.tagName.toLowerCase(),
                className: node.className,
                hidden: node.hidden,
                display: style.display,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
        }) : [];
        picker.close();
        await new Promise(resolve => setTimeout(resolve, 0));
        const focusRestored = document.activeElement === picker.trigger;
        const triggerStyle = getComputedStyle(picker.trigger);
        const screenshot = {
            source: mode === 'harness-equivalent'
                ? 'VCP generated AgentModelPicker Harness-equivalent Electron capture'
                : 'VCP generated AgentModelPicker Candidate Electron capture',
            fixtureMode: mode,
            provenance: 'deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx',
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
            scenario, rootPane, modelPane, keyboardNavigation, modelEscape, effortPane, effortEscape, focusRestored,
            loadErrorRetry,
            dom: host.querySelector('.vcp-harness-agent-model-picker')?.outerHTML || '',
            trigger: {
                tag: picker.trigger.tagName.toLowerCase(),
                role: picker.trigger.getAttribute('role'),
                ariaHaspopup: picker.trigger.getAttribute('aria-haspopup'),
                ariaExpanded: picker.trigger.getAttribute('aria-expanded'),
                ariaControls: picker.trigger.getAttribute('aria-controls'),
                height: triggerStyle.height,
                maxWidth: triggerStyle.maxWidth,
                borderRadius: triggerStyle.borderRadius,
                padding: triggerStyle.padding,
                gap: triggerStyle.gap,
                fontSize: triggerStyle.fontSize,
                lineHeight: triggerStyle.lineHeight,
            },
            menu: menuStyle ? {
                tag: menu.tagName.toLowerCase(),
                id: menu.id,
                role: menu.getAttribute('role'),
                ariaLabel: menu.getAttribute('aria-label'),
                ariaBusy: menu.getAttribute('aria-busy'),
                borderRadius: menuStyle.borderRadius,
                padding: menuStyle.padding,
                width: menuStyle.width,
                maxHeight: menuStyle.maxHeight,
                minWidth: menuStyle.minWidth,
                rect: menuRect ? {
                    x: menuRect.x, y: menuRect.y, width: menuRect.width, height: menuRect.height,
                } : null,
                cssContract: {
                    borderRadius: declaration('border-radius'),
                    padding: declaration('padding'),
                    width: declaration('width'),
                    maxHeight: declaration('max-height'),
                    minWidth: declaration('min-width'),
                },
                computed: menuStyleSnapshot,
                children: modelMenuChildren,
                viewportStyle: modelViewportMetrics,
                compositingAncestors,
                layer: menuLayer,
            } : null,
            selected, efforts,
            productionConsumer: false,
            status: mode === 'harness-equivalent' ? 'harness-equivalent-fixture-active' : 'candidate-interaction-active',
        };
        // Cleanup happens after the caller captures the semantic menu ROI.
        // Keeping the mounted surface alive here lets Puppeteer clip the same
        // open menu state used by the Harness production fixture.
        window.__vcpAgentModelPickerCleanup = async () => {
            await picker.dispose();
            await scope.dispose('candidate-agent-model-picker-complete');
            const disposed = host.querySelector('.vcp-harness-agent-model-picker') === null;
            host.remove();
            return disposed;
        };
        window.__vcpAgentModelPickerOpenModel = () => {
            picker.open();
            picker.setPane('model');
        };
        return screenshot;
    }, { mode: captureMode, scenario: captureScenario });
    assert.deepEqual(evidence.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.equal(evidence.rootPane.expanded, 'true');
    assert.equal(evidence.rootPane.cardPresent, true);
    assert.equal(evidence.rootPane.modelRowVisible, true);
    assert.equal(evidence.rootPane.effortRowVisible, true);
    assert.equal(evidence.modelPane.searchVisible, captureMode !== 'harness-equivalent');
    assert.equal(evidence.modelPane.optionCount, captureMode === 'harness-equivalent' ? 2 : 3);
    assert.equal(evidence.effortPane.optionCount, captureMode === 'harness-equivalent' ? 3 : 2);
    assert.equal(evidence.modelEscape.returnedToRoot, true);
    assert.equal(evidence.modelEscape.searchHidden, true);
    assert.equal(evidence.effortEscape.returnedToRoot, true);
    assert.equal(evidence.effortEscape.effortHidden, true);
    if (captureMode === 'harness-equivalent') assert.equal(evidence.keyboardNavigation.focusedOption, 'acme-think',
        'Harness parity keyboard navigation must move real DOM focus to the active model row');
    assert.equal(evidence.focusRestored, true);
    assert.equal(evidence.menu?.rect?.width > 0, true);
    if (captureScenario === 'load-error-retry') {
        assert.equal(evidence.loadErrorRetry?.pending.status, 'pending');
        assert.equal(evidence.loadErrorRetry?.pending.ariaBusy, 'true');
        assert.equal(evidence.loadErrorRetry?.failed.status, 'failed');
        assert.equal(evidence.loadErrorRetry?.failed.ariaBusy, null);
        assert.equal(evidence.loadErrorRetry?.failed.alertRole, 'alert');
        assert.match(evidence.loadErrorRetry?.failed.alertText ?? '', /catalog unavailable/);
        assert.equal(evidence.loadErrorRetry?.failed.retryVisible, true);
        assert.equal(evidence.loadErrorRetry?.retryPending.status, 'pending');
        assert.equal(evidence.loadErrorRetry?.settled.status, 'ready');
        assert.equal(evidence.loadErrorRetry?.settled.optionCount, captureMode === 'harness-equivalent' ? 2 : 3);
        assert.equal(evidence.loadErrorRetry?.settled.loadAttempts, 2);
    }
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'reports', `${scenarioOutputStem}-full.png`) });
    await page.evaluate(() => window.__vcpAgentModelPickerOpenModel?.());
    await page.waitForFunction(({ mode }) => {
        const root = document.querySelector('[data-vcp-candidate-agent-model-picker="true"]');
        const viewport = root?.querySelector('.vcp-harness-popup-select-viewport');
        const selector = mode === 'harness-equivalent' ? '[role="menuitemradio"]' : '[role="option"]';
        return viewport && viewport.hidden === false && viewport.querySelectorAll(selector).length > 0;
    }, { timeout }, { mode: captureMode });
    await page.screenshot({ path: path.join(root, 'reports', `${scenarioOutputStem}-open-full.png`) });
    const menuRect = await page.$eval('[data-vcp-candidate-agent-model-picker="true"] .vcp-harness-popup-select-card', element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    evidence.menuCaptureRect = menuRect;
    await page.screenshot({
        path: path.join(root, 'reports', `${scenarioOutputStem}.png`),
        clip: menuRect,
    });
    // Cross-engine pixels are useful as a coarse signal, but text raster and
    // compositor details are not a visual contract when Playwright Chromium
    // is compared with Electron.  Mount the *actual Harness ModelSelect CSS*
    // plus its captured ready-state Light DOM in this same Electron renderer.
    // It is intentionally labelled a static source reference (not a Harness
    // production consumer): its only purpose is to distinguish VCP DOM/CSS
    // drift from browser-engine raster variance without loosening the policy.
    const sameEngineReference = await page.evaluate(({ css, baseCss, classes, rect }) => {
        const style = document.createElement('style');
        style.dataset.vcpHarnessModelSelectElectronReference = 'true';
        style.textContent = `${baseCss}\n${css}`;
        const referenceRoot = document.createElement('div');
        referenceRoot.className = classes.root;
        referenceRoot.dataset.vcpHarnessModelSelectElectronReference = 'true';
        referenceRoot.innerHTML = `<div class="${classes.menu}" role="menu" aria-label="Model and reasoning effort" aria-busy="false">
            <div class="${classes.groups}">
                <section role="group" class="${classes.group}"><div class="${classes.groupTitle}">DeepSeek</div><button type="button" role="menuitemradio" aria-checked="false" class="${classes.option}"><span class="${classes.optionCopy}"><span class="${classes.modelName}">DeepSeek-V4-Flash</span></span><span class="${classes.check}"></span></button></section>
                <section role="group" class="${classes.group}"><div class="${classes.groupTitle}">Acme Gateway</div><button type="button" role="menuitemradio" aria-checked="true" class="${classes.option} ${classes.selected}"><span class="${classes.optionCopy}"><span class="${classes.modelName}">Acme Think</span></span><span class="${classes.check}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z" fill="currentColor"></path></svg></span></button></section>
            </div>
        </div>`;
        const menu = referenceRoot.querySelector(`.${classes.menu}`);
        menu.style.position = 'fixed';
        menu.style.left = `${rect.x}px`;
        menu.style.top = `${rect.y}px`;
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        menu.style.zIndex = '2001';
        // ModelSelect source CSS intentionally relies on the Harness theme
        // rather than carrying fallbacks.  Inject the values captured from
        // the same light production fixture so Electron evaluates source CSS
        // rather than inheriting unrelated VCP page colors.  This is an
        // explicit fixture context, never a new product Theme owner.
        const harnessTokens = {
            '--dsw-alias-border-inverted': 'rgba(0, 0, 0, 0)',
            '--dsw-alias-label-primary': 'rgb(15, 17, 21)',
            '--dsw-alias-label-tertiary': 'rgb(129, 133, 140)',
            '--dsw-specific-menu': 'rgb(255, 255, 255)',
            '--dsw-shadow-lv3': '0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)',
            '--dsw-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
        };
        for (const [name, value] of Object.entries(harnessTokens)) menu.style.setProperty(name, value);
        // Harness production resolves the 240px menu width as its content
        // box (4px padding + 1px border on both sides => 250px ROI).  VCP's
        // global reset is border-box, so pin this source-context invariant
        // rather than accidentally comparing two different box models.
        menu.style.boxSizing = 'content-box';
        document.head.append(style);
        document.body.append(referenceRoot);
        const menuRect = menu.getBoundingClientRect();
        const computed = getComputedStyle(menu);
        const textStyle = node => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, fontKerning: style.fontKerning, fontFeatureSettings: style.fontFeatureSettings, fontVariationSettings: style.fontVariationSettings, textRendering: style.textRendering, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        };
        window.__vcpHarnessModelSelectElectronReferenceCleanup = () => {
            referenceRoot.remove();
            style.remove();
        };
        return {
            source: 'Harness ModelSelect source DOM/CSS mounted in VCP Electron',
            sourcePath: 'packages/client/ui-model-selection/src/client/ModelSelect.tsx + ModelSelect.module.css',
            renderingEngine: 'VCP Electron renderer',
            referenceKind: 'same-engine-static-source-reference; not a Harness production consumer',
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
            productionConsumer: false,
            status: 'same-engine-source-reference-active',
            dom: menu.outerHTML,
            menu: { role: menu.getAttribute('role'), rect: { x: menuRect.x, y: menuRect.y, width: menuRect.width, height: menuRect.height }, width: computed.width, maxHeight: computed.maxHeight, padding: computed.padding, borderRadius: computed.borderRadius, border: computed.border, boxSizing: computed.boxSizing },
            modelPane: {
                groupCount: menu.querySelectorAll('section[role="group"]').length,
                options: [...menu.querySelectorAll('[role="menuitemradio"]')].map(node => ({ text: node.textContent?.trim() || '', ariaChecked: node.getAttribute('aria-checked') })),
                textStyles: {
                    groupTitles: [...menu.querySelectorAll(`.${classes.groupTitle}`)].map(textStyle),
                    modelNames: [...menu.querySelectorAll(`.${classes.modelName}`)].map(textStyle),
                    checks: [...menu.querySelectorAll(`.${classes.check}`)].map(textStyle),
                },
            },
            effortPane: { options: [{ text: 'Off' }, { text: 'High' }, { text: 'Max' }] },
            interaction: { searchVisible: false },
        };
    }, { css: harnessModelSelectElectronCss, baseCss: harnessModelSelectElectronBaseCss, classes: harnessReferenceClasses, rect: menuRect });
    assert.deepEqual(sameEngineReference.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.equal(sameEngineReference.modelPane.groupCount, 2);
    assert.equal(sameEngineReference.modelPane.options.length, 2);
    assert.deepEqual(sameEngineReference.effortPane.options.map(option => option.text), ['Off', 'High', 'Max']);
    if (captureScenario === 'ready-selected') {
        assert.equal(sameEngineReference.menu.rect.width, menuRect.width,
            `same-engine Harness source reference must match the candidate ROI width: ${JSON.stringify(sameEngineReference.menu)}`);
        assert.equal(sameEngineReference.menu.rect.height, menuRect.height,
            `same-engine Harness source reference must match the candidate ROI height: ${JSON.stringify(sameEngineReference.menu)}`);
    } else {
        // The load/retry journey retains the real primitive's transient
        // status/error layout in its transition.  Its source reference is
        // intentionally retained only as provenance and is never a pixel
        // baseline until an actual Harness failure fixture is available.
        sameEngineReference.comparison = 'not-evaluated: load-error-retry lacks a Harness production visual fixture';
    }
    await page.screenshot({
        path: path.join(root, 'reports', `${sameEngineReferenceStem}.png`),
        clip: sameEngineReference.menu.rect,
    });
    await page.evaluate(() => window.__vcpHarnessModelSelectElectronReferenceCleanup?.());
    await fs.writeFile(path.join(root, 'reports', `${sameEngineReferenceStem}.json`), `${JSON.stringify(sameEngineReference, null, 2)}\n`, 'utf8');
    evidence.disposed = await page.evaluate(() => window.__vcpAgentModelPickerCleanup?.() ?? false);
    assert.equal(evidence.disposed, true);
    await fs.writeFile(path.join(root, 'reports', `${scenarioOutputStem}.json`), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(evidence, null, 2));
} finally {
    // Disconnect without waiting for DevTools target shutdown; Electron is
    // explicitly terminated below and lingering inspector handles must not
    // keep this standalone capture alive.
    browser?.disconnect?.();
    await stopChild();
}
// Puppeteer can retain an inspector/socket handle after the browser target
// closes; this standalone evidence command must terminate once cleanup is
// complete so automation runs do not remain alive indefinitely.
process.exit(0);
