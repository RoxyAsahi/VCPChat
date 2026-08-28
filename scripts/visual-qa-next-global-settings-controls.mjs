/* Real Electron Visual Forensics fixture for Global Settings controls. */
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
const theme = process.env.VCPCHAT_VISUAL_QA_THEME || 'light';
const output = path.resolve(process.env.VCPCHAT_GLOBAL_SETTINGS_QA_OUTPUT
  || path.join(root, 'reports/visual-forensics-qa/global-settings-controls', theme));
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const timeout = 90_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = url => new Promise((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject));
const port = await new Promise((resolve, reject) => { const server = http.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-global-settings-qa-'));
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
  uiMode: 'next', currentThemeMode: theme, enableDistributedServer: false,
  vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'global-settings-qa',
}), 'utf8');
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], {
  cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
  stdio: ['ignore', 'ignore', 'pipe'], detached: true,
});
let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); });
let browser;
const evidence = { generatedAt: new Date().toISOString(), source: 'VCP production Global Settings controls', theme, viewports, captures: [], gate: { pass: true, failures: [] } };

async function terminate() {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5_000)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

async function waitForMainRenderer(deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const page = (await browser.pages()).find(candidate => !candidate.isClosed() && candidate.url().includes('main.html'));
      if (page) return page;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`main renderer missing after ${timeout}ms${lastError ? `: ${lastError.message}` : ''}`);
}

try {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); } }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = await waitForMainRenderer(deadline);
  await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: Math.max(1, deadline - Date.now()) });

  for (const [width, height] of viewports) {
    const name = `${width}x${height}`;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluate(() => { if (!document.getElementById('globalSettingsModal')?.classList.contains('active')) window.uiHelperFunctions?.openModal?.('globalSettingsModal'); });
    await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active')
      && document.getElementById('globalSettingsForm'), { timeout });
    await sleep(160);
    const rootBefore = await page.$('#globalSettingsModal');
    await page.evaluate(() => document.querySelector('.vcp-harness-settings-nav-cell[data-section="appearance-settings"]')?.click());
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal #section-appearance-settings.active'), { timeout });
    const state = await page.evaluate(() => {
      const modal = document.getElementById('globalSettingsModal');
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const visible = selector => [...modal.querySelectorAll(selector)].filter(node => {
        const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      });
      const describe = node => {
        const s = getComputedStyle(node);
        return { id: node.id || null, className: node.className || '', rect: box(node), display: s.display,
          height: s.height, minHeight: s.minHeight, padding: s.padding, gap: s.gap,
          border: s.border, borderRadius: s.borderRadius, color: s.color,
          backgroundColor: s.backgroundColor, outline: s.outline, boxShadow: s.boxShadow };
      };
      const controls = [
        ...visible('.vcp-uiux-input-wrap'), ...visible('.vcp-harness-select-trigger'),
        ...visible('.vcp-uiux-range'), ...visible('.vcp-uiux-toggle'),
        ...visible('.vcp-uiux-choice-option'), ...visible('.vcp-harness-general-item'),
      ];
      const panel = document.querySelector('#globalSettingsModal .vcp-harness-settings-panel');
      const content = document.querySelector('#globalSettingsModal .vcp-harness-settings-options');
      return {
        modal: describe(modal), panel: panel && describe(panel), content: content && describe(content),
        controls: controls.map(describe), overflow: { modal: modal.scrollWidth > modal.clientWidth, content: content ? content.scrollWidth > content.clientWidth : false },
        primitiveCounts: {
          input: visible('.vcp-uiux-input-wrap').length,
          select: visible('.vcp-harness-select-trigger').length,
          range: visible('.vcp-uiux-range').length,
          toggle: visible('.vcp-uiux-toggle').length,
          choice: visible('.vcp-uiux-choice-option').length,
        },
      };
    });
    assert.ok(state.primitiveCounts.input > 0, `${name}: no visible Input primitive`);
    assert.ok(state.primitiveCounts.select > 0, `${name}: no visible Select trigger`);
    assert.ok(state.primitiveCounts.range > 0, `${name}: no visible Range primitive`);
    assert.ok(state.primitiveCounts.toggle > 0, `${name}: no visible Toggle primitive`);
    assert.ok(state.primitiveCounts.choice > 0, `${name}: no visible Choice option`);
    assert.equal(state.overflow.modal, false, `${name}: Settings modal has horizontal overflow`);
    assert.equal(state.overflow.content, false, `${name}: Settings content has horizontal overflow`);

    const openedSelect = await page.$eval('#appearanceDensity', node => {
      const trigger = node.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger');
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.click();
      return true;
    });
    assert.equal(openedSelect, true, `${name}: appearance Density trigger missing`);
    await page.waitForFunction(() => Boolean(document.querySelector('.vcp-harness-menu-list:not([hidden])')), { timeout });
    const menu = await page.evaluate(() => {
      const node = document.querySelector('.vcp-harness-menu-list:not([hidden])');
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { rect: box(node), position: s.position, zIndex: s.zIndex, borderRadius: s.borderRadius,
        inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2,
        topmost: node.contains(hit), itemCount: node.querySelectorAll('[role="menuitem"]').length };
    });
    assert.ok(menu.inViewport && menu.topmost, `${name}: Select portal is clipped or occluded: ${JSON.stringify(menu)}`);
    assert.ok(menu.itemCount >= 3, `${name}: Select option count drifted`);
    await page.hover('.vcp-harness-menu-list:not([hidden]) [role="menuitem"]');
    await page.$eval('.vcp-harness-menu-list:not([hidden]) [role="menuitem"]', node => node.focus());
    const interaction = await page.evaluate(() => {
      const input = document.getElementById('homeVisualTagline');
      const inputWrap = input?.closest('.vcp-uiux-input-wrap');
      const selectItem = document.querySelector('.vcp-harness-menu-list:not([hidden]) [role="menuitem"]');
      const selectFocused = document.activeElement === selectItem;
      input?.focus();
      const range = document.getElementById('appearanceSidebarRowHeight');
      const output = document.getElementById('appearanceSidebarRowHeightValue');
      const rangeWrap = range?.closest('.vcp-uiux-range');
      const toggle = document.getElementById('showHomeVisualBrand');
      const toggleWrap = toggle?.closest('.vcp-uiux-toggle');
      const choice = document.getElementById('appearanceSidebarRadius');
      const choiceWrap = choice?.closest('.vcp-harness-select');
      const size = node => node ? { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height } : null;
      const inputStyle = input && getComputedStyle(input); const wrapStyle = inputWrap && getComputedStyle(inputWrap);
      const rangeBefore = { value: range?.value || null, output: output?.value || output?.textContent || null, size: size(rangeWrap) };
      if (range instanceof HTMLInputElement) {
        range.value = String(Math.min(Number(range.max), Number(range.value) + Number(range.step || 1)));
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const rangeAfter = { value: range?.value || null, output: output?.value || output?.textContent || null, size: size(rangeWrap) };
      if (range instanceof HTMLInputElement && rangeBefore.value !== null) {
        range.value = rangeBefore.value;
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const toggleBefore = toggle instanceof HTMLInputElement ? toggle.checked : null;
      toggle?.click();
      const toggleAfter = toggle instanceof HTMLInputElement ? toggle.checked : null;
      if (toggleBefore !== null && toggleAfter !== toggleBefore) toggle?.click();
      const choiceBefore = choice instanceof HTMLSelectElement ? choice.value : null;
      if (choice instanceof HTMLSelectElement) choice.value = 'square';
      choice?.dispatchEvent(new Event('change', { bubbles: true }));
      const choiceAfter = choice instanceof HTMLSelectElement ? choice.value : null;
      return {
        input: { available: Boolean(input && inputWrap), focusWithin: Boolean(inputWrap?.matches(':focus-within')),
          innerBorderWidth: inputStyle?.borderWidth || null, innerBoxShadow: inputStyle?.boxShadow || null,
          innerOutlineStyle: inputStyle?.outlineStyle || null, wrapperBorderColor: wrapStyle?.borderColor || null },
        select: { hovered: Boolean(selectItem?.matches(':hover')), focused: selectFocused,
          backgroundColor: selectItem ? getComputedStyle(selectItem).backgroundColor : null,
          outline: selectItem ? getComputedStyle(selectItem).outline : null },
        range: { before: rangeBefore, after: rangeAfter, geometryStable: JSON.stringify(rangeBefore.size) === JSON.stringify(rangeAfter.size) },
        toggle: { available: Boolean(toggle && toggleWrap), before: toggleBefore, after: toggleAfter, size: size(toggleWrap) },
        choice: { available: Boolean(choice && choiceWrap), before: choiceBefore, after: choiceAfter, size: size(choiceWrap), selectedBackground: choiceWrap ? getComputedStyle(choiceWrap).backgroundColor : null },
      };
    });
    assert.deepEqual(interaction.input, {
      available: true, focusWithin: true, innerBorderWidth: '0px', innerBoxShadow: 'none', innerOutlineStyle: 'none',
      wrapperBorderColor: interaction.input.wrapperBorderColor,
    }, `${name}: Input focus cascade regressed: ${JSON.stringify(interaction.input)}`);
    assert.ok(interaction.select.hovered && interaction.select.focused, `${name}: Select hover/focus state missing: ${JSON.stringify(interaction.select)}`);
    assert.equal(interaction.range.geometryStable, true, `${name}: Range value changes layout: ${JSON.stringify(interaction.range)}`);
    assert.notEqual(interaction.range.before.output, interaction.range.after.output, `${name}: Range output failed to project`);
    assert.equal(interaction.toggle.available, true, `${name}: Toggle primitive missing`);
    assert.notEqual(interaction.toggle.before, interaction.toggle.after, `${name}: Toggle did not change native state`);
    assert.deepEqual({ available: interaction.choice.available, after: interaction.choice.after }, { available: true, after: 'square' }, `${name}: radius Select did not update native source`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vcp-harness-menu-list:not([hidden])'), { timeout });

    const scroll = await page.evaluate(() => {
      const content = document.querySelector('#globalSettingsModal .vcp-harness-settings-options');
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      if (!content) return null;
      content.scrollTop = Math.max(0, content.scrollHeight - content.clientHeight);
      const r = content.getBoundingClientRect();
      return { scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight,
        overflowX: content.scrollWidth > content.clientWidth, rect: box(content), bottomInsideViewport: r.bottom <= innerHeight + 2 };
    });
    assert.ok(scroll && scroll.scrollTop >= 0 && !scroll.overflowX, `${name}: Settings scroll geometry regressed: ${JSON.stringify(scroll)}`);
    await page.screenshot({ path: path.join(output, `${name}-${theme}.png`), fullPage: false });

    await page.evaluate(() => window.uiHelperFunctions?.closeModal?.('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
    await page.evaluate(() => window.uiHelperFunctions?.openModal?.('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
    const rootAfter = await page.$('#globalSettingsModal');
    const reopen = await page.evaluate(() => ({ active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
      bodyStyle: document.body.getAttribute('style') || '', bodyClasses: [...document.body.classList],
      activeSection: document.querySelector('#globalSettingsModal .settings-section.active')?.id || null }));
    assert.equal(reopen.active, true, `${name}: Settings did not reopen`);
    evidence.captures.push({ viewport: { width, height, deviceScaleFactor: 1 }, state, menu, interaction, scroll, reopen,
      rootIdentityChanged: Boolean(rootBefore && rootAfter && rootBefore !== rootAfter) });
    await page.evaluate(() => window.uiHelperFunctions?.closeModal?.('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout });
  }
} catch (error) {
  evidence.gate.pass = false; evidence.gate.failures.push(error?.stack || String(error)); process.exitCode = 2;
} finally {
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  try { browser?.disconnect(); } catch {}
  await terminate();
  await fs.rm(appData, { recursive: true, force: true });
}
console.log(JSON.stringify({ output, theme, pass: evidence.gate.pass, captures: evidence.captures.length }, null, 2));
