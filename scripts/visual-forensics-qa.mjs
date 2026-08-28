/**
 * Real Electron visual-forensics scan for the active Next UI surfaces.
 * This intentionally records runtime evidence (pixels, geometry, computed
 * styles and DOM) instead of treating static CSS or unit tests as proof.
 */
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
  ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const timeout = 90_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = url => new Promise((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject));
const port = await new Promise((resolve, reject) => { const server = http.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const output = path.resolve(process.env.VCPCHAT_VISUAL_QA_OUTPUT || path.join(root, 'reports/visual-forensics-qa', new Date().toISOString().replaceAll(':', '-')));
await fs.mkdir(output, { recursive: true });
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-visual-qa-'));
await fs.mkdir(path.join(appData, 'Agents', 'VisualQA'), { recursive: true });
await fs.writeFile(path.join(appData, 'Agents', 'VisualQA', 'config.json'), JSON.stringify({ name: 'Visual QA', model: 'visual-qa', promptMode: 'original', originalSystemPrompt: 'Visual QA', systemPrompt: 'Visual QA', stripRegexes: [] }));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'visual-qa', assistantAgent: 'VisualQA', currentThemeMode: process.env.VCPCHAT_VISUAL_QA_THEME || 'light' }));
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let childClosed = false;
child.once('close', () => { childClosed = true; });
let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); });
let browser;
const evidence = { generatedAt: new Date().toISOString(), viewports, output, observations: [], gate: { pass: true, failures: [] } };
try {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); } }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
  assert.ok(page, `main renderer missing: ${stderr}`);
  await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
  // Exercise the shipped showcase entry when available. If the app is booted
  // in a minimal mode the main surface remains the useful fallback evidence.
  const showcaseButton = await page.$('#nextUiAddTabBtn');
  if (showcaseButton) {
    await showcaseButton.click().catch(() => {});
    await sleep(300);
    await page.evaluate(() => {
      if (document.querySelector('.vcp-ui-showcase-root')) return;
      const item = [...document.querySelectorAll('.next-ui-internal-app-item')].find(node => node.getAttribute('title') === 'UI 组件库');
      if (item) { item.click(); return; }
      window.topTabManager?.openInternalApp?.('ui-component-library');
    }).catch(() => {});
    await page.waitForSelector('.vcp-ui-showcase-root', { timeout: 15_000 }).catch(() => {});
  }
  const lifecycle = await page.evaluate(async () => {
    const before = document.querySelector('.vcp-ui-showcase-root');
    const beforeIdentity = before || null;
    await window.topTabManager?.closeView?.('app:ui-component-library');
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterClose = document.querySelector('.vcp-ui-showcase-root');
    const bodyAfterClose = { classes: [...document.body.classList], inlineStyle: document.body.getAttribute('style') || '' };
    await window.topTabManager?.openInternalApp?.('ui-component-library');
    await new Promise(resolve => setTimeout(resolve, 250));
    const afterReopen = document.querySelector('.vcp-ui-showcase-root');
    return {
      openedInitially: Boolean(before),
      removedOnClose: !afterClose,
      bodyAfterClose,
      reopened: Boolean(afterReopen),
      newRootIdentity: Boolean(afterReopen && beforeIdentity && afterReopen !== beforeIdentity),
    };
  }).catch(error => ({ error: error.message }));
  evidence.lifecycle = lifecycle;
  if (lifecycle.error || !lifecycle.openedInitially || !lifecycle.removedOnClose || !lifecycle.reopened) {
    evidence.gate.failures.push(`showcase lifecycle: ${JSON.stringify(lifecycle)}`);
  }
  await page.waitForSelector('.vcp-harness-primitive-lab', { timeout: 15_000 }).catch(() => {});
  const overlays = await page.evaluate(async () => {
    const lab = document.querySelector('.vcp-harness-primitive-lab');
    const byText = text => [...(lab?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === text);
    const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return { x: r.x, y: r.y, width: r.width, height: r.height, position: s.position, zIndex: s.zIndex, parent: node.parentElement === document.body ? 'body' : node.parentElement?.className || '' }; };
    const menuTrigger = byText('View options'); menuTrigger?.click(); await new Promise(resolve => setTimeout(resolve, 30));
    const menu = document.querySelector('.vcp-harness-menu-list[role="menu"]');
    const menuEvidence = { triggerExpanded: menuTrigger?.getAttribute('aria-expanded') || '', rect: rect(menu), itemCount: menu?.querySelectorAll('[role="menuitem"]').length || 0 };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const modalTrigger = byText('Open modal'); modalTrigger?.click(); await new Promise(resolve => setTimeout(resolve, 30));
    const modal = document.querySelector('.vcp-harness-modal-root [role="dialog"]');
    const modalEvidence = { open: Boolean(modal), rect: rect(modal), mask: Boolean(document.querySelector('.vcp-harness-modal-mask')), zIndex: modal ? getComputedStyle(modal).zIndex : '' };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const tooltipAnchor = byText('Hover for details'); tooltipAnchor?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 160));
    const tooltip = document.querySelector('.vcp-harness-tooltip-bubble');
    const tooltipEvidence = { open: Boolean(tooltip), rect: rect(tooltip), side: tooltip?.getAttribute('data-side') || '' };
    tooltipAnchor?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    return { menu: menuEvidence, modal: modalEvidence, tooltip: tooltipEvidence };
  }).catch(error => ({ error: error.message }));
  evidence.overlays = overlays;
  if (overlays.error || !overlays.menu?.rect || !overlays.modal?.open || !overlays.tooltip?.open) {
    evidence.gate.failures.push(`showcase overlays: ${JSON.stringify(overlays)}`);
  }
  const settingsContext = await page.evaluate(async () => {
    await window.uiHelperFunctions?.openModal?.('globalSettingsModal');
    await new Promise(resolve => setTimeout(resolve, 120));
    const modal = document.querySelector('#globalSettingsModal');
    const rows = [...(modal?.querySelectorAll('.vcp-settings-row, .form-group, .settings-section') || [])]
      .filter(node => node.getClientRects().length).slice(0, 24).map(node => {
        const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
        return { className: node.className, text: (node.textContent || '').trim().slice(0, 120), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, gap: s.gap, padding: s.padding, borderRadius: s.borderRadius, backgroundColor: s.backgroundColor };
      });
    const shell = modal?.querySelector('.vcp-ui-settings-shell, #globalSettingsForm');
    const shellStyle = shell ? (() => { const r = shell.getBoundingClientRect(); const s = getComputedStyle(shell); return { className: shell.className, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, gridTemplateColumns: s.gridTemplateColumns, gap: s.gap }; })() : null;
    const controls = [...(modal?.querySelectorAll('input, select, textarea, button, wa-input, wa-select') || [])]
      .filter(node => node.getClientRects().length).slice(0, 40).map(node => {
        const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
        return { tag: node.tagName.toLowerCase(), id: node.id, className: node.className, parentClass: node.parentElement?.className || '', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, color: s.color, backgroundColor: s.backgroundColor };
      });
    const sectionIds = ['user-identity', 'server-connection', 'appearance-settings', 'render-settings', 'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions'];
    const sections = [];
    for (const sectionId of sectionIds) {
      const tab = modal?.querySelector(`#vcpSettingsTab-${sectionId}`);
      tab?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const active = modal?.querySelector('.settings-section.active');
      const visibleControls = [...(active?.querySelectorAll('input, select, textarea, button, wa-input, wa-select') || [])].filter(node => node.getClientRects().length);
      sections.push({ sectionId, activeId: active?.id || '', visibleControls: visibleControls.length, rect: active ? (() => { const r = active.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null });
    }
    modal?.querySelector('#vcpSettingsTab-user-identity')?.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const describeContext = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      const ancestry = [];
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        ancestry.push({ tag: current.tagName.toLowerCase(), id: current.id || '', className: typeof current.className === 'string' ? current.className : '', role: current.getAttribute('role') || '' });
      }
      return { tag: node.tagName.toLowerCase(), id: node.id || '', className: typeof node.className === 'string' ? node.className : '', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, position: s.position, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius, padding: s.padding, fontSize: s.fontSize, lineHeight: s.lineHeight, ancestry };
    };
    const contextSample = {
      showcase: describeContext(document.querySelector('.vcp-harness-primitive-lab input, .vcp-harness-primitive-lab textarea, .vcp-harness-primitive-lab select')),
      settings: describeContext([...((modal?.querySelector('.settings-section.active') || modal)?.querySelectorAll('input, select, textarea, button, wa-input, wa-select') || [])].find(node => node.getClientRects().length)),
    };
    await window.uiHelperFunctions?.closeModal?.('globalSettingsModal');
    await new Promise(resolve => setTimeout(resolve, 80));
    const settingsCleanup = {
      active: Boolean(modal?.classList.contains('active')),
      visible: Boolean(modal?.getClientRects().length),
      visibleDialogCount: [...document.querySelectorAll('#globalSettingsModal [role="dialog"], #globalSettingsModal .vcp-harness-settings-shell')].filter(node => node.getClientRects().length).length,
      bodyClasses: [...document.body.classList],
      bodyInlineStyle: document.body.getAttribute('style') || '',
    };
    return { opened: Boolean(modal?.classList.contains('active') || modal), rowCount: rows.length, rows, controls, shell: shellStyle, sections, contextSample, settingsCleanup };
  }).catch(error => ({ error: error.message }));
  evidence.settingsContext = settingsContext;
  if (settingsContext.error || (settingsContext.rowCount === 0 && settingsContext.controls?.length === 0)) evidence.gate.failures.push(`settings context: ${JSON.stringify(settingsContext)}`);
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.enable').catch(() => {});
  await cdp.send('CSS.enable').catch(() => {});
  const selectorSpecificity = selector => {
    const normalized = selector.replace(/::[\w-]+/g, '').replace(/:where\([^)]*\)/g, '');
    const ids = (normalized.match(/#[\w-]+/g) || []).length;
    const classes = (normalized.match(/\.[\w-]+/g) || []).length;
    const attributes = (normalized.match(/\[[^\]]+\]/g) || []).length;
    const pseudos = (normalized.match(/:[\w-]+(?:\([^)]*\))?/g) || []).filter(value => !value.startsWith('::')).length;
    const elements = (normalized.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g, ' ').match(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g) || []).length;
    return [ids, classes + attributes + pseudos, elements];
  };
  const captureMatchedRules = async selector => {
    try {
      const { root: documentNode } = await cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector });
      if (!nodeId) return [];
      const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
      return [...(matched.matchedCSSRules || [])].slice(-40).map((entry, index) => { const ruleSelector = entry.rule?.selectorList?.text || ''; return { selector: ruleSelector, specificity: selectorSpecificity(ruleSelector), cascadeOrder: index, origin: entry.rule?.origin || '', styleSheetId: entry.rule?.styleSheetId || '', properties: (entry.rule?.style?.cssProperties || []).filter(property => ['color', 'background', 'background-color', 'padding', 'border-radius', 'z-index'].includes(property.name)).map(property => ({ name: property.name, value: property.value })) }; });
    } catch { return []; }
  };
  await page.evaluate(async () => {
    await window.uiHelperFunctions?.openModal?.('globalSettingsModal');
    await new Promise(resolve => setTimeout(resolve, 120));
  }).catch(() => {});
  evidence.settingsCascade = await captureMatchedRules('#globalSettingsModal #userName');
  await page.evaluate(() => window.uiHelperFunctions?.closeModal?.('globalSettingsModal')).catch(() => {});
  if (!evidence.settingsCascade.length) evidence.gate.failures.push('settings cascade provenance incomplete');
  const overlayCascade = {};
  await page.evaluate(() => document.querySelector('.vcp-harness-primitive-lab button')?.focus()).catch(() => {});
  await page.evaluate(async () => {
    const lab = document.querySelector('.vcp-harness-primitive-lab');
    const find = text => [...(lab?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === text);
    find('View options')?.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  }).catch(() => {});
  overlayCascade.menu = await captureMatchedRules('.vcp-harness-menu-list[role="menu"]');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
  await page.evaluate(async () => {
    const lab = document.querySelector('.vcp-harness-primitive-lab');
    [...(lab?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === 'Open modal')?.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  }).catch(() => {});
  overlayCascade.modal = await captureMatchedRules('.vcp-harness-modal-root [role="dialog"]');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
  await page.evaluate(async () => {
    const lab = document.querySelector('.vcp-harness-primitive-lab');
    const anchor = [...(lab?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === 'Hover for details');
    anchor?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 160));
  }).catch(() => {});
  overlayCascade.tooltip = await captureMatchedRules('.vcp-harness-tooltip-bubble');
  await page.evaluate(() => document.querySelector('.vcp-harness-primitive-lab button')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))).catch(() => {});
  evidence.overlays.cdpCascade = overlayCascade;
  if (!overlayCascade.menu.length || !overlayCascade.modal.length || !overlayCascade.tooltip.length) evidence.gate.failures.push(`overlay cascade provenance incomplete: ${JSON.stringify(Object.fromEntries(Object.entries(overlayCascade).map(([key, value]) => [key, value.length])))}`);
  for (const [width, height] of viewports) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const owner = document.querySelector('.vcp-ui-showcase-shell, .vcp-ui-page-shell-content');
      if (owner) owner.scrollTo(0, 0);
    });
    await sleep(250);
    const name = `${width}x${height}`;
    await page.screenshot({ path: path.join(output, `${name}-initial.png`), fullPage: true });
    const lab = '.vcp-harness-primitive-lab';
    await page.evaluate(async selector => {
      const root = document.querySelector(selector);
      const button = [...(root?.querySelectorAll('button') || [])].find(node => node.textContent.trim() === 'View options');
      button?.click();
      await new Promise(resolve => setTimeout(resolve, 40));
    }, lab).catch(() => {});
    await page.screenshot({ path: path.join(output, `${name}-menu.png`), fullPage: false });
    const menuViewport = await page.evaluate(() => {
      const node = document.querySelector('.vcp-harness-menu-list[role="menu"]');
      if (!node) return { open: false, rect: null };
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      const point = { x: Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)) };
      const topmost = document.elementFromPoint(point.x, point.y);
      return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: s.position, zIndex: s.zIndex, parent: node.parentElement === document.body ? 'body' : node.parentElement?.className || '', point, topmostInside: Boolean(topmost && node.contains(topmost)) };
    }).catch(() => ({ open: false, rect: null }));
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
    await page.evaluate(async selector => {
      const root = document.querySelector(selector);
      const button = [...(root?.querySelectorAll('button') || [])].find(node => node.textContent.trim() === 'Open modal');
      button?.click();
      await new Promise(resolve => setTimeout(resolve, 40));
    }, lab).catch(() => {});
    await page.screenshot({ path: path.join(output, `${name}-modal.png`), fullPage: false });
    const modalViewport = await page.evaluate(() => {
      const node = document.querySelector('.vcp-harness-modal-root [role="dialog"]');
      if (!node) return { open: false, rect: null };
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      const point = { x: Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)) };
      const topmost = document.elementFromPoint(point.x, point.y);
      return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: s.position, zIndex: s.zIndex, parent: node.parentElement?.className || '', mask: Boolean(document.querySelector('.vcp-harness-modal-mask')), point, topmostInside: Boolean(topmost && node.contains(topmost)) };
    }).catch(() => ({ open: false, rect: null }));
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
    const tooltipButtons = await page.$$(`${lab} button`);
    let tooltipTarget = null;
    for (const button of tooltipButtons) {
      if (await button.evaluate(node => node.textContent.trim() === 'Hover for details').catch(() => false)) { tooltipTarget = button; break; }
    }
    if (tooltipTarget) {
      await tooltipTarget.evaluate(element => {
        const previousDocumentScrollBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const owner = element.closest('.vcp-ui-showcase-shell, .vcp-ui-page-shell-content');
        if (owner) {
          const rect = element.getBoundingClientRect();
          const ownerRect = owner.getBoundingClientRect();
          const previousScrollBehavior = owner.style.scrollBehavior;
          owner.style.scrollBehavior = 'auto';
          owner.scrollTop += rect.top - ownerRect.top - (owner.clientHeight / 2);
          owner.style.scrollBehavior = previousScrollBehavior;
        }
        document.documentElement.style.scrollBehavior = previousDocumentScrollBehavior;
      }).catch(() => {});
      await sleep(80);
      await tooltipTarget.hover().catch(() => {});
      await sleep(160);
      await page.screenshot({ path: path.join(output, `${name}-tooltip.png`), fullPage: false });
      var tooltipViewport = await page.evaluate(() => {
        const node = document.querySelector('.vcp-harness-tooltip-bubble');
        if (!node) return { open: false, rect: null };
        const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
        const point = { x: Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)) };
        const topmost = document.elementFromPoint(point.x, point.y);
        const anchor = [...document.querySelectorAll('.vcp-harness-primitive-lab button')].find(button => button.textContent.trim() === 'Hover for details');
        const ar = anchor?.getBoundingClientRect();
        const ancestors = [];
        for (let current = anchor?.parentElement; current; current = current.parentElement) {
          const cs = getComputedStyle(current);
          if (/(auto|scroll|overlay)/.test(`${cs.overflow}${cs.overflowY}${cs.overflowX}`)) {
            const cr = current.getBoundingClientRect();
            ancestors.push({ tag: current.tagName.toLowerCase(), id: current.id || '', className: typeof current.className === 'string' ? current.className : '', rect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height }, scrollTop: current.scrollTop, scrollHeight: current.scrollHeight, clientHeight: current.clientHeight, overflow: cs.overflow, overflowY: cs.overflowY });
          }
        }
        const bodyStyle = getComputedStyle(document.body);
        const htmlStyle = getComputedStyle(document.documentElement);
        const topmostAncestry = [];
        for (let current = topmost; current && topmostAncestry.length < 8; current = current.parentElement) {
          topmostAncestry.push({ tag: current.tagName?.toLowerCase() || '', id: current.id || '', className: typeof current.className === 'string' ? current.className : '' });
        }
        return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, parent: node.parentElement?.className || '', side: node.getAttribute('data-side') || '', inline: { left: node.style.left, top: node.style.top, transform: node.style.transform }, point, topmost: topmost ? { tag: topmost.tagName?.toLowerCase() || '', id: topmost.id || '', className: typeof topmost.className === 'string' ? topmost.className : '' } : null, topmostAncestry, topmostInside: Boolean(topmost && node.contains(topmost)), anchor: ar ? { x: ar.x, y: ar.y, width: ar.width, height: ar.height } : null, scrollAncestors: ancestors, body: { transform: bodyStyle.transform, position: bodyStyle.position, top: bodyStyle.top, overflow: bodyStyle.overflow }, html: { transform: htmlStyle.transform, position: htmlStyle.position, overflow: htmlStyle.overflow } };
      }).catch(() => ({ open: false, rect: null }));
      await page.mouse.move(2, 2).catch(() => {});
    } else tooltipViewport = { open: false, rect: null };
    const overlayViewport = { menu: menuViewport, modal: modalViewport, tooltip: tooltipViewport };
    await page.evaluate(async () => {
      await window.uiHelperFunctions?.openModal?.('globalSettingsModal');
      await new Promise(resolve => setTimeout(resolve, 100));
    }).catch(() => {});
    await page.screenshot({ path: path.join(output, `${name}-settings.png`), fullPage: false });
    const settingsViewport = await page.evaluate(async () => {
      const modal = document.querySelector('#globalSettingsModal');
      const visible = [...(modal?.querySelectorAll('.vcp-settings-row, .form-group, input, select, textarea, button, wa-input, wa-select') || [])]
        .filter(node => node.getClientRects().length).slice(0, 50).map(node => {
          const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
          return { tag: node.tagName.toLowerCase(), id: node.id, className: node.className, parentClass: node.parentElement?.className || '', text: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 80), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius, padding: s.padding, fontSize: s.fontSize, lineHeight: s.lineHeight, disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true', invalid: node.getAttribute('aria-invalid') === 'true' || node.classList.contains('is-error'), busy: node.getAttribute('aria-busy') === 'true' || node.classList.contains('is-loading'), selected: node.getAttribute('aria-selected') === 'true' || node.classList.contains('is-selected') };
        });
      const sectionIds = ['user-identity', 'server-connection', 'appearance-settings', 'render-settings', 'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions'];
      const sections = sectionIds.map(sectionId => {
        const tab = modal?.querySelector(`#vcpSettingsTab-${sectionId}`);
        tab?.click();
        const active = modal?.querySelector('.settings-section.active');
        const controls = [...(active?.querySelectorAll('input, select, textarea, button, wa-input, wa-select') || [])].filter(node => node.getClientRects().length);
        const r = active?.getBoundingClientRect();
        return { sectionId, activeId: active?.id || '', visibleControls: controls.length, rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null };
      });
      const describeContext = node => {
        if (!node) return null;
        const r = node.getBoundingClientRect(); const s = getComputedStyle(node); const ancestry = [];
        let current = node;
        for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) ancestry.push({ tag: current.tagName.toLowerCase(), id: current.id || '', className: typeof current.className === 'string' ? current.className : '', role: current.getAttribute('role') || '' });
        return { tag: node.tagName.toLowerCase(), id: node.id || '', className: typeof node.className === 'string' ? node.className : '', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, position: s.position, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius, padding: s.padding, fontSize: s.fontSize, lineHeight: s.lineHeight, ancestry };
      };
      modal?.querySelector('#vcpSettingsTab-user-identity')?.click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const contextSample = { showcase: describeContext(document.querySelector('.vcp-harness-primitive-lab input, .vcp-harness-primitive-lab textarea, .vcp-harness-primitive-lab select')), settings: describeContext([...((modal?.querySelector('.settings-section.active') || modal)?.querySelectorAll('input, select, textarea, button, wa-input, wa-select') || [])].find(node => node.getClientRects().length)) };
      const modalRect = modal?.getBoundingClientRect();
      const modalStyle = modal ? getComputedStyle(modal) : null;
      const point = modalRect ? { x: Math.max(0, Math.min(innerWidth - 1, modalRect.x + modalRect.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, modalRect.y + modalRect.height / 2)) } : null;
      const topmost = point ? document.elementFromPoint(point.x, point.y) : null;
      const settingsOverlay = modalRect ? { rect: { x: modalRect.x, y: modalRect.y, width: modalRect.width, height: modalRect.height }, position: modalStyle?.position || '', zIndex: modalStyle?.zIndex || '', point, topmost: topmost ? { tag: topmost.tagName?.toLowerCase() || '', id: topmost.id || '', className: typeof topmost.className === 'string' ? topmost.className : '' } : null, topmostInside: Boolean(topmost && modal.contains(topmost)), inViewport: modalRect.x >= -2 && modalRect.y >= -2 && modalRect.right <= innerWidth + 2 && modalRect.bottom <= innerHeight + 2 } : null;
      return { active: Boolean(modal?.classList.contains('active') || modal), visible, activeSection: modal?.querySelector('.settings-section.active')?.id || '', sections, contextSample, settingsOverlay };
    }).catch(error => ({ error: error.message }));
    settingsViewport.cascade = await captureMatchedRules('#globalSettingsModal #userName');
    await page.evaluate(() => window.uiHelperFunctions?.closeModal?.('globalSettingsModal')).catch(() => {});
    await sleep(80);
    const stateTransitions = await page.evaluate(async () => {
      const find = (text, root = document) => [...root.querySelectorAll('button')].find(button => button.textContent.trim() === text);
      const loadingTrigger = find('模拟加载 1.2 秒');
      loadingTrigger?.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const loadingLayer = document.querySelector('.vcp-ui-loading-layer');
      const loadingStyle = loadingLayer ? getComputedStyle(loadingLayer) : null;
      const loading = { visible: Boolean(loadingLayer && !loadingLayer.hasAttribute('hidden')), label: loadingLayer?.querySelector('.vcp-ui-loading-label')?.textContent || '', className: loadingLayer?.className || '', display: loadingStyle?.display || '', position: loadingStyle?.position || '', zIndex: loadingStyle?.zIndex || '', backgroundColor: loadingStyle?.backgroundColor || '' };
      await new Promise(resolve => setTimeout(resolve, 1_250));
      loading.cleared = !loadingLayer || loadingLayer.hasAttribute('hidden');
      const boundary = document.querySelector('.vcp-ui-showcase-section[data-component="asyncboundary"]');
      const errorButton = find('error', boundary || document);
      errorButton?.click();
      await new Promise(resolve => setTimeout(resolve, 40));
      const alert = boundary?.querySelector('[role="alert"], .vcp-ui-alert');
      const alertStyle = alert ? getComputedStyle(alert) : null;
      const errorState = { status: boundary?.querySelector('.vcp-ui-async-boundary')?.dataset.status || '', alert: alert?.textContent?.trim().slice(0, 120) || '', className: alert?.className || '', color: alertStyle?.color || '', backgroundColor: alertStyle?.backgroundColor || '', borderRadius: alertStyle?.borderRadius || '' };
      const loadingButton = find('loading', boundary || document);
      loadingButton?.click();
      await new Promise(resolve => setTimeout(resolve, 40));
      const skeleton = boundary?.querySelector('.vcp-ui-skeleton, .vcp-ui-skeleton-line');
      const skeletonStyle = skeleton ? getComputedStyle(skeleton) : null;
      const asyncLoading = { status: boundary?.querySelector('.vcp-ui-async-boundary')?.dataset.status || '', skeleton: Boolean(skeleton), backgroundColor: skeletonStyle?.backgroundColor || '', animationName: skeletonStyle?.animationName || '' };
      find('idle', boundary || document)?.click();
      return { loading, errorState, asyncLoading, reset: boundary?.querySelector('.vcp-ui-async-boundary')?.dataset.status || '' };
    }).catch(error => ({ error: error.message }));
    const snapshotState = async (kind) => {
      const state = await page.evaluate(async kind => {
        const find = (text, root = document) => [...root.querySelectorAll('button')].find(button => button.textContent.trim() === text);
        const rect = node => node ? (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null;
        const boundary = document.querySelector('.vcp-ui-showcase-section[data-component="asyncboundary"]');
        if (kind === 'loading') {
          find('模拟加载 1.2 秒')?.click();
          await new Promise(resolve => setTimeout(resolve, 100));
          const layer = document.querySelector('.vcp-ui-loading-layer');
          const layerRect = rect(layer);
          return { visible: Boolean(layer && !layer.hasAttribute('hidden')), rect: layerRect, inViewport: Boolean(layerRect && layerRect.width > 0 && layerRect.height > 0 && layerRect.x + layerRect.width > 0 && layerRect.y + layerRect.height > 0 && layerRect.x < innerWidth && layerRect.y < innerHeight) };
        }
        find(kind === 'error' ? 'error' : 'loading', boundary || document)?.click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const root = boundary?.querySelector('.vcp-ui-async-boundary');
        const target = kind === 'error' ? boundary?.querySelector('[role="alert"], .vcp-ui-alert') : boundary?.querySelector('.vcp-ui-skeleton, .vcp-ui-skeleton-line');
        target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 50));
        const targetRect = rect(target);
        const inViewport = Boolean(targetRect && targetRect.width > 0 && targetRect.height > 0 && targetRect.x + targetRect.width > 0 && targetRect.y + targetRect.height > 0 && targetRect.x < innerWidth && targetRect.y < innerHeight);
        return { status: root?.dataset.status || '', visible: inViewport, rect: targetRect, inViewport };
      }, kind).catch(error => ({ error: error.message }));
      await page.screenshot({ path: path.join(output, `${name}-${kind}.png`), fullPage: false });
      return state;
    };
    stateTransitions.visual = {};
    stateTransitions.visual.loading = await snapshotState('loading');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1_250))).catch(() => {});
    stateTransitions.visual.error = await snapshotState('error');
    stateTransitions.visual.asyncLoading = await snapshotState('async-loading');
    await page.evaluate(() => {
      const boundary = document.querySelector('.vcp-ui-showcase-section[data-component="asyncboundary"]');
      [...(boundary?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === 'idle')?.click();
    }).catch(() => {});
    await page.screenshot({ path: path.join(output, `${name}-states.png`), fullPage: true });
    const initial = await page.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const owner = el.closest('.vcp-ui-showcase-root, .vcp-ui-page-shell, #main-content, #chat-container')?.className || 'document'; return { tag: el.tagName.toLowerCase(), id: el.id, className: el.className, owner, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, position: s.position, zIndex: s.zIndex, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius }; };
      const controls = [...document.querySelectorAll('button, input, select, textarea, [role="dialog"], [role="menu"], [role="tooltip"]')].filter(el => el.getClientRects().length).slice(0, 400);
      const rects = controls.map(visible);
      const overlapPairs = [];
      rects.forEach((a, i) => rects.forEach((b, j) => {
        if (i >= j || a.tag !== b.tag || a.owner !== b.owner) return false;
        const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
        if (contains(a.rect, b.rect) || contains(b.rect, a.rect)) return false;
        if (a.rect.x < b.rect.x + b.rect.width && a.rect.x + a.rect.width > b.rect.x && a.rect.y < b.rect.y + b.rect.height && a.rect.y + a.rect.height > b.rect.y && overlapPairs.length < 8) overlapPairs.push([a.className, b.className]);
      }));
      const overlap = overlapPairs.length > 0;
      const portals = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="tooltip"], [class*="portal"], [class*="overlay"]')].filter(el => el.getClientRects().length).map(visible);
      const stateCounts = {
        disabled: document.querySelectorAll(':disabled, .is-disabled, [aria-disabled="true"]').length,
        selected: document.querySelectorAll('.is-selected, [aria-selected="true"], [data-selected="true"], [aria-checked="true"]').length,
        error: document.querySelectorAll('.is-error, [aria-invalid="true"], [role="alert"]').length,
        loading: document.querySelectorAll('.is-loading, [aria-busy="true"], [data-loading="true"]').length,
      };
      const stateTarget = selector => {
        const candidates = [...document.querySelectorAll(selector)].filter(candidate => candidate.getClientRects().length);
        const element = candidates.find(candidate => {
          const r = candidate.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        }) || candidates[0];
        if (!element) return null;
        const r = element.getBoundingClientRect(); const s = getComputedStyle(element);
        return { tag: element.tagName.toLowerCase(), id: element.id || '', className: typeof element.className === 'string' ? element.className : '', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight, display: s.display, position: s.position, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius, padding: s.padding, outline: s.outline, boxShadow: s.boxShadow };
      };
      const stateTargets = {
        disabled: stateTarget(':disabled, .is-disabled, [aria-disabled="true"]'),
        selected: stateTarget('.is-selected, [aria-selected="true"], [data-selected="true"], [aria-checked="true"]'),
      };
      const focusTarget = [...document.querySelectorAll('button, input, select')].find(el => el.getClientRects().length && !el.disabled);
      focusTarget?.focus?.();
      const focused = document.activeElement && document.activeElement !== document.body ? visible(document.activeElement) : null;
      const cascade = element => {
        if (!element) return [];
        const matched = [];
        const visit = (rules, source) => [...rules].forEach(rule => {
          if (rule.cssRules) return visit(rule.cssRules, source);
          if (!rule.selectorText || !rule.style) return;
          try {
            if (element.matches(rule.selectorText)) matched.push({ selector: rule.selectorText, source, color: rule.style.color || '', background: rule.style.background || rule.style.backgroundColor || '', padding: rule.style.padding || '', borderRadius: rule.style.borderRadius || '', zIndex: rule.style.zIndex || '' });
          } catch {}
        });
        [...document.styleSheets].forEach(sheet => { try { visit(sheet.cssRules, sheet.href || 'inline'); } catch {} });
        return matched.slice(-40);
      };
      const tree = (node, depth = 0) => {
        if (!node || depth > 4) return null;
        return { tag: node.tagName?.toLowerCase() || '', id: node.id || '', className: typeof node.className === 'string' ? node.className : '', role: node.getAttribute?.('role') || '', children: [...(node.children || [])].slice(0, 80).map(child => tree(child, depth + 1)).filter(Boolean) };
      };
      const rootStyle = getComputedStyle(document.documentElement); const bodyStyle = getComputedStyle(document.body);
      const token = name => rootStyle.getPropertyValue(name).trim();
      const themeTokens = { accent: token('--vcp-ui-accent') || token('--vcp-ui-theme-accent'), accentHover: token('--vcp-ui-accent-hover') || token('--vcp-ui-theme-accent-hover'), surface: token('--vcp-ui-surface') || token('--vcp-ui-bg-primary'), inputBackground: token('--vcp-ui-bg-input') || token('--vcp-ui-theme-bg-input'), textPrimary: token('--vcp-ui-text-primary') || token('--vcp-ui-theme-text-primary'), textSecondary: token('--vcp-ui-text-secondary') || token('--vcp-ui-theme-text-secondary'), bodyBackground: bodyStyle.backgroundColor, bodyColor: bodyStyle.color };
      return { url: location.href, surface: document.querySelector('.vcp-ui-showcase-root') ? 'component-showcase' : 'main', uiMode: document.documentElement.dataset.uiMode || '', theme: document.documentElement.dataset.theme || document.documentElement.dataset.themeMode || '', bodyClass: document.body.className, themeTokens, scroll: { x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight }, controls: rects, portals, stateCounts, stateTargets, focused, cascade: cascade(focusTarget), dom: { bodyLength: document.body.innerHTML.length, classes: [...document.body.classList], inlineStyle: document.body.getAttribute('style') || '', rootTree: tree(document.querySelector('.vcp-ui-showcase-root')) }, overlap, overlapPairs };
    });
    initial.cdpCascade = await captureMatchedRules('#toggleSidebarModeBtn');
    const captureViewportState = async (state, selector) => {
      const selected = await page.evaluate(({ selector }) => {
        const candidates = [...document.querySelectorAll(selector)].filter(candidate => candidate.getClientRects().length);
        const element = candidates.find(candidate => {
          const r = candidate.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        }) || candidates[0];
        if (!element) return false;
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        return true;
      }, { selector }).catch(() => false);
      if (!selected) return null;
      await sleep(80);
      const evidence = await page.evaluate(({ selector }) => {
        const element = [...document.querySelectorAll(selector)].find(candidate => {
          if (!candidate.getClientRects().length) return false;
          const r = candidate.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        });
        if (!element) return null;
        const r = element.getBoundingClientRect(); const s = getComputedStyle(element);
        return { tag: element.tagName.toLowerCase(), id: element.id || '', className: typeof element.className === 'string' ? element.className : '', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: true, display: s.display, position: s.position, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius, padding: s.padding, outline: s.outline, boxShadow: s.boxShadow };
      }, { selector }).catch(() => null);
      await page.screenshot({ path: path.join(output, `${name}-${state}.png`), fullPage: false });
      return evidence;
    };
    initial.stateTargets.disabled = await captureViewportState('disabled', ':disabled, .is-disabled, [aria-disabled="true"]');
    initial.stateTargets.selected = await captureViewportState('selected', '.is-selected, [aria-selected="true"], [data-selected="true"], [aria-checked="true"]');
    const stateTarget = await page.$('.vcp-harness-primitive-lab button:not([disabled])');
    if (stateTarget) {
      await stateTarget.hover().catch(() => {});
      const box = await stateTarget.boundingBox().catch(() => null);
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await page.screenshot({ path: path.join(output, `${name}-hover.png`), fullPage: false });
      const hoverState = await stateTarget.evaluate(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { active: el.matches(':hover'), className: el.className, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight, backgroundColor: s.backgroundColor, color: s.color, outline: s.outline, boxShadow: s.boxShadow }; }).catch(() => null);
      await stateTarget.focus().catch(() => {});
      // Establish real keyboard modality so :focus-visible rules are applied
      // in Electron, rather than treating programmatic focus as visual proof.
      await page.keyboard.press('Tab').catch(() => {});
      await page.keyboard.down('Shift').catch(() => {});
      await page.keyboard.press('Tab').catch(() => {});
      await page.keyboard.up('Shift').catch(() => {});
      await page.screenshot({ path: path.join(output, `${name}-focus.png`), fullPage: false });
      const focusState = await page.evaluate(() => { const el = document.activeElement; if (!el?.closest('.vcp-harness-primitive-lab')) return null; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { className: el.className, focusVisible: el.matches(':focus-visible'), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight, backgroundColor: s.backgroundColor, color: s.color, outline: s.outline, boxShadow: s.boxShadow }; });
      initial.interactionStates = { hover: hoverState, focus: focusState };
    } else {
      initial.interactionStates = { hover: null, focus: null };
    }
    await page.evaluate(() => {
      const owner = document.querySelector('.vcp-ui-showcase-shell, .vcp-ui-page-shell-content');
      if (owner) owner.scrollTo(0, owner.scrollHeight);
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await sleep(100);
    const scrolled = await page.evaluate(() => {
      const owner = document.querySelector('.vcp-ui-showcase-shell, .vcp-ui-page-shell-content');
      return { windowY: window.scrollY, owner: owner?.className || '', ownerY: owner?.scrollTop || 0, ownerScrollHeight: owner?.scrollHeight || 0, ownerViewport: owner?.clientHeight || 0, scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight };
    });
    await page.screenshot({ path: path.join(output, `${name}-scrolled.png`), fullPage: false });
    await page.setViewport({ width: Math.max(320, width - 240), height });
    await sleep(150);
    const resized = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1, overflowY: document.documentElement.scrollHeight > innerHeight + 1 }));
    const tooltipHandle = await (async () => {
      for (const button of await page.$$(`${lab} button`)) {
        if (await button.evaluate(node => node.textContent.trim() === 'Hover for details').catch(() => false)) return button;
      }
      return null;
    })();
    if (tooltipHandle) {
      await tooltipHandle.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })).catch(() => {});
      await sleep(80);
      await tooltipHandle.hover().catch(() => {});
      await sleep(160);
      resized.tooltip = await page.evaluate(() => {
        const node = document.querySelector('.vcp-harness-tooltip-bubble');
        const anchor = [...document.querySelectorAll('.vcp-harness-primitive-lab button')].find(button => button.textContent.trim() === 'Hover for details');
        if (!node || !anchor) return { open: false, rect: null };
        const r = node.getBoundingClientRect(); const ar = anchor.getBoundingClientRect(); const s = getComputedStyle(node);
        return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, anchor: { x: ar.x, y: ar.y, width: ar.width, height: ar.height }, position: s.position, parent: node.parentElement === document.body ? 'body' : node.parentElement?.className || '', inViewport: r.x >= -2 && r.y >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 };
      }).catch(() => ({ open: false, rect: null }));
      await page.screenshot({ path: path.join(output, `${name}-narrow-tooltip.png`), fullPage: false });
      await page.mouse.move(2, 2).catch(() => {});
    } else resized.tooltip = { open: false, rect: null };
    resized.menu = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('.vcp-harness-primitive-lab button')].find(node => node.textContent.trim() === 'View options');
      button?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      button?.click();
      await new Promise(resolve => setTimeout(resolve, 60));
      const node = document.querySelector('.vcp-harness-menu-list[role="menu"]');
      if (!node) return { open: false, rect: null };
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      const point = { x: Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)) };
      const topmost = document.elementFromPoint(point.x, point.y);
      return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: s.position, parent: node.parentElement === document.body ? 'body' : node.parentElement?.className || '', inViewport: r.x >= -2 && r.y >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2, topmostInside: Boolean(topmost && node.contains(topmost)) };
    }).catch(() => ({ open: false, rect: null }));
    await page.screenshot({ path: path.join(output, `${name}-narrow-menu.png`), fullPage: false });
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
    resized.modal = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('.vcp-harness-primitive-lab button')].find(node => node.textContent.trim() === 'Open modal');
      button?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      button?.click();
      await new Promise(resolve => setTimeout(resolve, 60));
      const node = document.querySelector('.vcp-harness-modal-root [role="dialog"]');
      if (!node) return { open: false, rect: null };
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      const point = { x: Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)) };
      const topmost = document.elementFromPoint(point.x, point.y);
      return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: s.position, parent: node.parentElement === document.body ? 'body' : node.parentElement?.className || '', inViewport: r.x >= -2 && r.y >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2, topmostInside: Boolean(topmost && node.contains(topmost)) };
    }).catch(() => ({ open: false, rect: null }));
    await page.screenshot({ path: path.join(output, `${name}-narrow-modal.png`), fullPage: false });
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
    await page.screenshot({ path: path.join(output, `${name}-narrow.png`), fullPage: false });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(150);
    const restored = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1, overflowY: document.documentElement.scrollHeight > innerHeight + 1 }));
    const restoredTooltipTarget = await (async () => {
      for (const button of await page.$$(`${lab} button`)) {
        if (await button.evaluate(node => node.textContent.trim() === 'Hover for details').catch(() => false)) return button;
      }
      return null;
    })();
    if (restoredTooltipTarget) {
      await restoredTooltipTarget.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })).catch(() => {});
      await sleep(80);
      await restoredTooltipTarget.hover().catch(() => {});
      await sleep(160);
      restored.tooltip = await page.evaluate(() => {
        const node = document.querySelector('.vcp-harness-tooltip-bubble');
        const anchor = [...document.querySelectorAll('.vcp-harness-primitive-lab button')].find(button => button.textContent.trim() === 'Hover for details');
        if (!node || !anchor) return { open: false, rect: null };
        const r = node.getBoundingClientRect(); const ar = anchor.getBoundingClientRect(); const s = getComputedStyle(node);
        return { open: node.getClientRects().length > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, anchor: { x: ar.x, y: ar.y, width: ar.width, height: ar.height }, position: s.position, parent: node.parentElement === document.body ? 'body' : node.parentElement?.className || '', inViewport: r.x >= -2 && r.y >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 };
      }).catch(() => ({ open: false, rect: null }));
      await page.screenshot({ path: path.join(output, `${name}-restored-tooltip.png`), fullPage: false });
      await page.mouse.move(2, 2).catch(() => {});
    } else restored.tooltip = { open: false, rect: null };
    await page.screenshot({ path: path.join(output, `${name}-restored.png`), fullPage: false });
    evidence.observations.push({ viewport: { width, height }, initial, overlayViewport, settingsViewport, stateTransitions, scrolled, resized, restored });
    if (initial.overlap) evidence.gate.failures.push(`${name}: visible control overlap`);
    if (resized.overflowX) evidence.gate.failures.push(`${name}: horizontal overflow after resize`);
    if (restored.width !== width || restored.height !== height || restored.overflowX) evidence.gate.failures.push(`${name}: wide viewport did not restore cleanly`);
  }
  for (const observation of evidence.observations) {
    const { width, height } = observation.viewport;
    const name = `${width}x${height}`;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const owner = document.querySelector('.vcp-ui-showcase-shell, .vcp-ui-page-shell-content');
      if (owner) owner.scrollTo(0, 0);
    }).catch(() => {});
    await sleep(150);
    const reopen = await page.evaluate(async () => {
      const before = document.querySelector('.vcp-ui-showcase-root');
      await window.topTabManager?.closeView?.('app:ui-component-library');
      await new Promise(resolve => setTimeout(resolve, 80));
      const afterClose = document.querySelector('.vcp-ui-showcase-root');
      const cleanup = { bodyClasses: [...document.body.classList], bodyInlineStyle: document.body.getAttribute('style') || '' };
      await window.topTabManager?.openInternalApp?.('ui-component-library');
      await new Promise(resolve => setTimeout(resolve, 400));
      const afterOpen = document.querySelector('.vcp-ui-showcase-root');
      return { openedBefore: Boolean(before), removedOnClose: !afterClose, reopened: Boolean(afterOpen), newRootIdentity: Boolean(before && afterOpen && before !== afterOpen), bodyAfterClose: cleanup };
    }).catch(error => ({ error: error.message }));
    await page.waitForSelector('.vcp-ui-showcase-root', { timeout: 15_000 }).catch(() => {});
    await page.screenshot({ path: path.join(output, `${name}-reopen.png`), fullPage: true });
    observation.reopen = reopen;
    if (reopen.error || !reopen.openedBefore || !reopen.removedOnClose || !reopen.reopened || !reopen.newRootIdentity) evidence.gate.failures.push(`${name}: viewport reopen lifecycle ${JSON.stringify(reopen)}`);
  }
  evidence.gate.pass = evidence.gate.failures.length === 0;
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, stderr: stderr || undefined }, null, 2));
  if (!evidence.gate.pass) process.exitCode = 2;
} catch (error) {
  evidence.gate.pass = false; evidence.gate.failures.push(error.message); await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(evidence, null, 2)); throw error;
} finally {
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2_000)]);
  // Electron forks GPU/renderer helpers. Kill the private process group so a
  // theme matrix cannot leak a renderer and block the next case on teardown.
  try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {}
  child.kill('SIGTERM');
  if (!childClosed && child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      sleep(2_000),
    ]);
  }
}
