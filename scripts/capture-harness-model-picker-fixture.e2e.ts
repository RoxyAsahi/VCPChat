import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.d.ts'
import { settingsNamespace } from '/Users/asahi/Documents/Codex/deepseek-harness/packages/settings/settings/src/index.ts'
import { launchWebScaffold, type WebScaffold } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/scaffold.ts'
import { connectFreshWorkspaceZh } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/support.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness'
const defaultModelOverlay = fileURLToPath(new URL('../../deepseek-harness/apps/web/tests/declared-reasoning.overlay.yml', import.meta.url))
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`)
const { chromium } = harnessRequire('playwright') as { chromium: { launch(): Promise<Browser> } }
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }

describe('Harness production ModelSelect fixture', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    await mkdir(join(root, 'reports'), { recursive: true })
    scaffold = await launchWebScaffold({ extraOverlayPath: defaultModelOverlay })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          reasoning: 'high',
          models: [{
            id: 'acme-think',
            name: 'Acme Think',
            reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
          }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport, locale: 'zh-CN' })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('captures the real ModelSelect root, model and effort panes', async () => {
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 15_000 })

    const rootPane = await menu.evaluate(element => ({
      dom: element.outerHTML,
      rect: (() => {
        const value = element.getBoundingClientRect()
        return { x: value.x, y: value.y, width: value.width, height: value.height }
      })(),
      modelRowVisible: [...element.querySelectorAll('[role="menuitem"]')]
        .some(node => !node.hasAttribute('hidden') && node.textContent?.includes('模型')),
      effortRowVisible: [...element.querySelectorAll('[role="menuitem"]')]
        .some(node => !node.hasAttribute('hidden') && node.textContent?.includes('推理等级')),
    }))

    const modelRow = menu.getByRole('menuitem', { name: /模型/ })
    await modelRow.click()
    const modelOption = menu.getByRole('menuitemradio', { name: 'Acme Think' })
    await modelOption.waitFor({ timeout: 15_000 })
    await modelOption.focus()
    const modelPane = await menu.evaluate(element => ({
      dom: element.outerHTML,
      groupCount: element.querySelectorAll('section[role="group"]').length,
      options: [...element.querySelectorAll('[role="menuitemradio"]')].map(node => ({
        text: node.textContent?.trim() || '',
        ariaChecked: node.getAttribute('aria-checked'),
        rect: (() => {
          const value = node.getBoundingClientRect()
          return { x: value.x, y: value.y, width: value.width, height: value.height }
        })(),
      })),
      groupTitles: [...element.querySelectorAll('[class*="group"]')]
        .filter(node => node.textContent?.trim())
        .map(node => node.textContent?.trim()),
    }))

    const triggerEvidence = await trigger.evaluate(element => {
      const value = getComputedStyle(element)
      const rectValue = element.getBoundingClientRect()
      return {
        dom: element.outerHTML,
        rect: { x: rectValue.x, y: rectValue.y, width: rectValue.width, height: rectValue.height },
        style: {
          display: value.display,
          width: value.width,
          height: value.height,
          maxHeight: value.maxHeight,
          padding: value.padding,
          gap: value.gap,
          borderRadius: value.borderRadius,
          fontFamily: value.fontFamily,
          fontSize: value.fontSize,
          fontWeight: value.fontWeight,
          lineHeight: value.lineHeight,
          color: value.color,
          backgroundColor: value.backgroundColor,
          boxShadow: value.boxShadow,
        },
        aria: {
          hasPopup: element.getAttribute('aria-haspopup'),
          expanded: element.getAttribute('aria-expanded'),
          controls: element.getAttribute('aria-controls'),
          label: element.getAttribute('aria-label'),
        },
      }
    })

    const menuEvidence = await menu.evaluate((element, triggerRect) => {
      const value = getComputedStyle(element)
      const rectValue = element.getBoundingClientRect()
      const readRect = (node: Element) => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return {
        dom: element.outerHTML,
        rect: readRect(element),
        role: element.getAttribute('role'),
        ariaLabel: element.getAttribute('aria-label'),
        style: {
          width: value.width,
          maxHeight: value.maxHeight,
          padding: value.padding,
          borderRadius: value.borderRadius,
          boxShadow: value.boxShadow,
          backgroundColor: value.backgroundColor,
        },
        cssContract: {
          width: value.width,
          maxHeight: value.maxHeight,
          padding: value.padding,
          borderRadius: value.borderRadius,
          offset: `${rectValue.y - (triggerRect.y + triggerRect.height)}px`,
        },
      }
    }, triggerEvidence.rect)
    await menu.screenshot({ path: join(root, 'reports', 'harness-agent-model-picker.png') })

    await page.keyboard.press('Escape')
    const menuAfterModelEscape = page.getByRole('menu')
    const escapePaneBack = await menuAfterModelEscape.count() > 0 ? await menuAfterModelEscape.evaluate(element => ({
      modelRowVisible: [...element.querySelectorAll('[role="menuitem"]')]
        .some(node => !node.hasAttribute('hidden') && node.textContent?.includes('模型')),
      modelOptionsVisible: [...element.querySelectorAll('[role="menuitemradio"]')]
        .some(node => !node.hasAttribute('hidden')),
    })) : { modelRowVisible: false, modelOptionsVisible: false }

    // The production implementation may retain its last drilled pane across
    // a close/reopen. Ensure a fresh root menu before capturing effort.
    if (await trigger.getAttribute('aria-expanded') === 'true') {
      await trigger.click()
      await expect.poll(() => trigger.getAttribute('aria-expanded')).toBe('false')
    }
    await trigger.click()
    await page.getByRole('menu').waitFor({ timeout: 15_000 })

    const reopenedMenu = page.getByRole('menu')
    const effortRow = reopenedMenu.getByRole('menuitem', { name: /推理等级/ })
    await effortRow.click()
    const effortOption = reopenedMenu.getByRole('menuitemradio').first()
    await effortOption.waitFor({ timeout: 15_000 })
    await effortOption.focus()
    const effortPane = await reopenedMenu.evaluate(element => ({
      dom: element.outerHTML,
      options: [...element.querySelectorAll('[role="menuitemradio"]')].map(node => ({
        text: node.textContent?.trim() || '',
        ariaChecked: node.getAttribute('aria-checked'),
        rect: (() => {
          const value = node.getBoundingClientRect()
          return { x: value.x, y: value.y, width: value.width, height: value.height }
        })(),
      })),
    }))
    await page.keyboard.press('Escape')
    const menuAfterEffortEscape = page.getByRole('menu')
    const effortEscape = await menuAfterEffortEscape.count() > 0 ? await menuAfterEffortEscape.evaluate(element => ({
      rootVisible: [...element.querySelectorAll('[role="menuitem"]')]
        .some(node => !node.hasAttribute('hidden') && node.textContent?.includes('模型')),
      effortOptionsVisible: [...element.querySelectorAll('[role="menuitemradio"]')]
        .some(node => !node.hasAttribute('hidden')),
    })) : { rootVisible: false, effortOptionsVisible: false }
    // After pane-back the focused option may have been removed. Restore
    // trigger ownership explicitly before exercising root-menu close.
    await trigger.focus()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(50)
    const closed = await trigger.getAttribute('aria-expanded') === 'false'
      && await page.getByRole('menu').count() === 0
    const focusRestore = await trigger.evaluate(element => document.activeElement === element)

    const missingEvidence = [
      ...(escapePaneBack.modelRowVisible && !escapePaneBack.modelOptionsVisible ? [] : ['escape-pane-back']),
      ...(closed ? [] : ['escape-close']),
      ...(focusRestore ? [] : ['focus-restore']),
    ]

    const evidence = {
      source: 'Harness production web ModelSelect',
      sourcePath: 'packages/client/ui-model-selection/src/client/ModelSelect.tsx',
      styleSource: 'packages/client/ui-model-selection/src/client/ModelSelect.module.css',
      semanticFixture: 'conversation.input.model/root-model-effort/ready',
      viewport,
      productionConsumer: false,
      status: 'harness-production-capture',
      dom: { root: rootPane.dom, trigger: triggerEvidence.dom, menu: modelPane.dom },
      trigger: triggerEvidence,
      menu: menuEvidence,
      rootPane,
      modelPane,
      effortPane,
      interaction: {
        rootPane: rootPane.modelRowVisible,
        modelPane: modelPane.options.length > 0,
        effortPane: effortPane.options.length > 0,
        searchVisible: false,
        loading: false,
        errorRetry: false,
        selecting: false,
        locked: false,
        escapePaneBack,
        escapeClose: closed,
        focusRestore,
        dispose: false,
      },
      missingEvidence,
      pixel: { roi: 'model-picker-menu', screenshot: 'harness-agent-model-picker.png' },
    }
    await writeFile(join(root, 'reports', 'harness-agent-model-picker.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  }, 60_000)
})
