import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.d.ts'
import { settingsNamespace } from '/Users/asahi/Documents/Codex/deepseek-harness/packages/settings/settings/src/index.ts'
import { launchWebScaffold, seedSession, type WebScaffold } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/scaffold.ts'
import { connectFreshWorkspaceZh } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/support.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness'
const defaultModelOverlay = fileURLToPath(new URL('../../deepseek-harness/apps/web/tests/declared-reasoning.overlay.yml', import.meta.url))
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`)
const { chromium } = harnessRequire('playwright') as { chromium: { launch(): Promise<Browser> } }
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }

// A minimal, parser-valid closed session whose durable transcript contains an
// image. The attachment reference is intentionally only a semantic admission
// marker: ModelSelect's Host guard inspects the message content and does not
// need to fetch the bytes for this journey.
const IMAGE_SESSION_ID = 'harness-model-picker-image-admission'
const IMAGE_SESSION_FIXTURE = [
  JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: 1784974100000, cwd: '{{cwd}}' }),
  JSON.stringify({ type: 'turn/start', seq: 0, time: 1784974100001, data: { turn: 1 } }),
  JSON.stringify({
    type: 'user/message', seq: 1, time: 1784974100002,
    data: {
      content: [
        { type: 'text', text: 'Image admission fixture' },
        { type: 'image', attachment: { attachmentId: 'sha256:fixture-model-picker-image', mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'fixture.png' } },
      ],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }),
  JSON.stringify({ type: 'session/title', seq: 2, time: 1784974100003, data: { title: 'Image admission fixture', messageSeqs: [1], source: { kind: 'fallback' } } }),
  JSON.stringify({ type: 'turn/end', seq: 3, time: 1784974100004, data: { turn: 1, reason: { kind: 'completed' } } }),
].join('\n') + '\n'

describe('Harness production ModelSelect fixture', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let durableImageEventCount = 0

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
          models: [
            {
              id: 'acme-think',
              name: 'Acme Think',
              input: ['text', 'image'],
              reasoningEfforts: { off: null, high: 'high', max: 'ultra' },
            },
            {
              id: 'acme-text-only',
              name: 'Acme Text Only',
              input: ['text'],
              reasoningEfforts: false,
            },
          ],
        },
      },
    })
    await seedSession(scaffold, IMAGE_SESSION_FIXTURE, IMAGE_SESSION_ID)
    const seeded = await scaffold.ctx.sessionPersistence.load(IMAGE_SESSION_ID)
    durableImageEventCount = seeded.events.filter(event => (
      event.type === 'user/message'
      && Array.isArray((event.data as { content?: unknown }).content)
      && (event.data as { content: { type?: unknown }[] }).content.some(block => block.type === 'image')
    )).length
    expect(durableImageEventCount).toBe(1)
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

    // Keyboard navigation is captured as a distinct, real production path.
    // Do not infer it from locator.focus(): Chromium intentionally gives the
    // two entry paths different :focus-visible semantics.
    const readKeyboardState = () => page.evaluate(() => {
      const menu = document.querySelector('[role="menu"]')
      const active = document.activeElement as HTMLElement | null
      return {
        triggerExpanded: document.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-expanded') ?? null,
        menuPresent: menu !== null,
        modelPaneOpen: menu?.querySelectorAll('[role="menuitemradio"]').length ?? 0,
        active: active ? {
          tag: active.tagName.toLowerCase(), role: active.getAttribute('role'),
          text: active.textContent?.trim() ?? '',
          focusVisible: active.matches(':focus-visible'),
        } : null,
      }
    })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(50)
    const keyboardRoot = await readKeyboardState()
    if (keyboardRoot.menuPresent) {
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(25)
    }
    const keyboardArrowDown = await readKeyboardState()
    if (keyboardArrowDown.menuPresent) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(50)
    }
    const keyboardPane = await readKeyboardState()
    // Return the fixture to its initial state before the pointer-driven DOM
    // / geometry capture. Escape has pane-back then close semantics.
    for (let attempt = 0; attempt < 2 && await trigger.getAttribute('aria-expanded') === 'true'; attempt += 1) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(25)
    }
    // Keyboard state is evidence, not cleanup authority: if it moved focus
    // outside the menu owner, use the public trigger interaction to restore
    // the known closed baseline for the independent pointer capture below.
    if (await trigger.getAttribute('aria-expanded') === 'true') {
      await trigger.click()
      await page.waitForTimeout(25)
    }
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')

    // Capture the tab-order path from a fresh root menu. The selected model
    // and effort row are not interchangeable targets, so the later VCP
    // keyboard harness must reproduce the path that actually opens the model
    // pane rather than only proving a generic option can be focused.
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(50)
    const keyboardModelRoot = await readKeyboardState()
    if (keyboardModelRoot.menuPresent) {
      await page.keyboard.press('Tab')
      await page.waitForTimeout(25)
    }
    const keyboardTab = await readKeyboardState()
    if (keyboardTab.menuPresent) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(50)
    }
    const keyboardModelPane = await readKeyboardState()
    if (keyboardModelPane.modelPaneOpen > 0) {
      await page.keyboard.press('Tab')
      await page.waitForTimeout(25)
    }
    const keyboardModelOption = await readKeyboardState()
    const keyboardModelOptionStyle = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element.getAttribute('role') !== 'menuitemradio') return null
      const style = getComputedStyle(element)
      return {
        pseudo: { focus: element.matches(':focus'), focusVisible: element.matches(':focus-visible') },
        computed: {
          backgroundColor: style.backgroundColor,
          color: style.color,
          outline: style.outline,
          outlineOffset: style.outlineOffset,
          boxShadow: style.boxShadow,
          borderColor: style.borderColor,
        },
      }
    })
    await page.getByRole('menu').screenshot({ path: join(root, 'reports', 'harness-agent-model-picker-keyboard-focus.png') })
    for (let attempt = 0; attempt < 2 && await trigger.getAttribute('aria-expanded') === 'true'; attempt += 1) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(25)
    }
    if (await trigger.getAttribute('aria-expanded') === 'true') {
      await trigger.click()
      await page.waitForTimeout(25)
    }
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')

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
    // Capture the real browser pseudo-classes independently.  Focus is not
    // inferred from an active item, and hover is not inferred from its class:
    // both are needed before VCP can claim a same-semantic visual comparison.
    await page.mouse.move(4, 4)
    await modelOption.focus()
    const focusedModelOption = await modelOption.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        pseudo: { hover: element.matches(':hover'), focus: element.matches(':focus'), focusVisible: element.matches(':focus-visible') },
        computed: { backgroundColor: style.backgroundColor, color: style.color, outline: style.outline, outlineOffset: style.outlineOffset, boxShadow: style.boxShadow, borderColor: style.borderColor },
      }
    })
    await menu.screenshot({ path: join(root, 'reports', 'harness-agent-model-picker-focus.png') })
    await modelOption.hover()
    const hoveredModelOption = await modelOption.evaluate(element => {
      const style = getComputedStyle(element)
      return {
        pseudo: { hover: element.matches(':hover'), focus: element.matches(':focus'), focusVisible: element.matches(':focus-visible') },
        computed: { backgroundColor: style.backgroundColor, color: style.color, outline: style.outline, outlineOffset: style.outlineOffset, boxShadow: style.boxShadow, borderColor: style.borderColor },
      }
    })
    await menu.screenshot({ path: join(root, 'reports', 'harness-agent-model-picker-hover.png') })
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
      // Keep text and check styles beside the geometry evidence.  A menu can
      // have matching boxes while anti-aliasing every glyph differently when
      // a semantic token or font weight drifts; the pixel gate must expose
      // that cause instead of treating it as an unexplained ROI mismatch.
      textStyles: {
        groupTitles: [...element.querySelectorAll('[class*="groupTitle"]')].map(node => {
          const style = getComputedStyle(node)
          return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing }
        }),
        modelNames: [...element.querySelectorAll('[class*="modelName"]')].map(node => {
          const style = getComputedStyle(node)
          return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing }
        }),
        checks: [...element.querySelectorAll('[class*="check"]')].map(node => {
          const style = getComputedStyle(node)
          return { color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight }
        }),
      },
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
          border: value.border,
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
      interactionStates: {
        focus: focusedModelOption,
        hover: hoveredModelOption,
      },
      keyboardNavigation: {
        effortPath: { root: keyboardRoot, arrowDown: keyboardArrowDown, pane: keyboardPane },
        modelPath: { root: keyboardModelRoot, tab: keyboardTab, pane: keyboardModelPane, option: keyboardModelOption, optionStyle: keyboardModelOptionStyle },
      },
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

  it('captures the production image-admission selection failure and Toast', async () => {
    // The primitive viewport deliberately starts with its sidebar closed. The
    // seed is selected through that real product control before any ModelSelect
    // interaction; it is not selected through a client-state override.
    await page.getByRole('button', { name: '打开侧边栏' }).click()
    // Cold seeds are deliberately not attached to the freshly connected
    // workspace, so the real sidebar places them under the expandable
    // Ungrouped tree branch.
    await page.getByRole('button', { name: '搜索会话' }).click()
    const search = page.getByPlaceholder('搜索会话…')
    await search.fill('Image admission fixture')
    const seededSession = page.getByText('Image admission fixture', { exact: true })
    await seededSession.waitFor({ timeout: 15_000 })
    await seededSession.click()

    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await expect.poll(() => trigger.textContent()).toContain('Acme Think')
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 15_000 })
    await menu.getByRole('menuitem', { name: /模型/ }).click()

    const visionOption = menu.getByRole('menuitemradio', { name: 'Acme Think' })
    const textOnlyOption = menu.getByRole('menuitemradio', { name: 'Acme Text Only' })
    await Promise.all([visionOption.waitFor({ timeout: 15_000 }), textOnlyOption.waitFor({ timeout: 15_000 })])
    const optionsBefore = await menu.getByRole('menuitemradio').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent?.trim() ?? '',
      ariaChecked: node.getAttribute('aria-checked'),
      ariaDisabled: node.getAttribute('aria-disabled'),
    })))
    expect(optionsBefore.map(option => option.text)).toEqual(expect.arrayContaining(['Acme Think', 'Acme Text Only']))

    // This is a real pointer selection. The failure must originate from the
    // Host's persisted-history image-admission check, not a synthetic stale
    // directory entry or an intercepted client RPC.
    await textOnlyOption.click()
    const toast = page.getByRole('alert')
    await toast.waitFor({ timeout: 15_000 })
    const toastEvidence = await toast.evaluate(element => ({
      text: element.textContent?.trim() ?? '',
      role: element.getAttribute('role'),
      dom: element.outerHTML,
      style: (() => {
        const value = getComputedStyle(element)
        return {
          color: value.color,
          backgroundColor: value.backgroundColor,
          borderRadius: value.borderRadius,
          boxShadow: value.boxShadow,
          fontFamily: value.fontFamily,
          fontSize: value.fontSize,
          lineHeight: value.lineHeight,
        }
      })(),
    }))
    const menuAfterFailure = await menu.evaluate(element => ({
      present: document.contains(element),
      options: [...element.querySelectorAll('[role="menuitemradio"]')].map(node => ({
        text: node.textContent?.trim() ?? '',
        ariaChecked: node.getAttribute('aria-checked'),
      })),
      retryVisible: [...element.querySelectorAll('button')].some(node => /retry|重试/i.test(node.textContent ?? '')),
    }))
    const triggerAfterFailure = await trigger.textContent()
    await page.screenshot({ path: join(root, 'reports', 'harness-agent-model-picker-selection-error-toast.png') })

    expect(toastEvidence.role).toBe('alert')
    expect(toastEvidence.text).toMatch(/does not accept image input|模型.*图像|image/i)
    expect(menuAfterFailure.present).toBe(true)
    expect(menuAfterFailure.retryVisible).toBe(false)
    expect(menuAfterFailure.options.find(option => option.text === 'Acme Think')?.ariaChecked).toBe('true')
    expect(menuAfterFailure.options.find(option => option.text === 'Acme Text Only')?.ariaChecked).not.toBe('true')
    expect(triggerAfterFailure).toContain('Acme Think')

    const evidence = {
      source: 'Harness production web ModelSelect',
      sourcePath: 'packages/client/ui-model-selection/src/client/ModelSelect.tsx',
      hostAdmissionPath: 'packages/host/apiproxy/src/api-proxy.ts',
      semanticFixture: 'model-select/image-history/text-only-selection-rejected',
      viewport,
      status: 'harness-production-selection-error-toast-capture',
      fixture: {
        sessionId: IMAGE_SESSION_ID,
        durableImageMessage: true,
        durableImageEventCount,
        configuredModels: [
          { id: 'acme-think', input: ['text', 'image'] },
          { id: 'acme-text-only', input: ['text'] },
        ],
      },
      interaction: {
        selection: 'normal-pointer-ui',
        optionsBefore,
        menuRemainedOpen: menuAfterFailure.present,
        retryVisible: menuAfterFailure.retryVisible,
        selectedModelUnchanged: menuAfterFailure.options.find(option => option.text === 'Acme Think')?.ariaChecked === 'true'
          && menuAfterFailure.options.find(option => option.text === 'Acme Text Only')?.ariaChecked !== 'true',
      },
      toast: toastEvidence,
      pixel: { screenshot: 'harness-agent-model-picker-selection-error-toast.png' },
      productionComparison: false,
      missingEvidence: ['same-semantic VCP selection-error Toast comparison', 'packaged artifact-only Electron smoke', 'Windows evidence'],
    }
    await writeFile(join(root, 'reports', 'harness-agent-model-picker-selection-error-toast.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  }, 60_000)
})
