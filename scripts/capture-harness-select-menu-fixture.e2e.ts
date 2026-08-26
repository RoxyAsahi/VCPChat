import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { Browser, Page } from '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.d.ts'
import { launchWebScaffold, type WebScaffold } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/scaffold.ts'
import { connectFreshWorkspace } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/support.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness'
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`)
const { chromium } = harnessRequire('playwright') as { chromium: { launch(): Promise<Browser> } }
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }
const interaction = process.env.VCP_SELECT_MENU_STATE === 'focus' ? 'focus' : process.env.VCP_SELECT_MENU_STATE === 'busy' ? 'busy' : 'hover'
const fixtureState = interaction === 'focus' ? 'open-selected-focus-menu' : interaction === 'busy' ? 'busy-trigger-disabled' : 'open-selected-hover-menu'
const outputStem = interaction === 'focus' ? 'harness-select-menu-focus' : interaction === 'busy' ? 'harness-select-trigger-busy' : 'harness-select-menu-open'

type DeferredAgentPresetSelect = {
  select(request: unknown): Promise<unknown>
}

let settleBusySelect: (() => Promise<void>) | undefined

async function captureOpenMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'Standard mode', exact: true })
  if (interaction === 'focus') {
    await trigger.focus()
    await page.keyboard.press('Enter')
  } else {
    await trigger.click()
  }
  const menu = page.getByRole('menu')
  await menu.waitFor({ timeout: 10_000 })
  const firstMenuItem = menu.getByRole('menuitem').first()
  const firstItemBox = await firstMenuItem.boundingBox()
  if (!firstItemBox) throw new Error('Harness Agent Preset fixture has no measurable first menu item')
  if (interaction !== 'focus') {
    await page.mouse.move(firstItemBox.x + 20, firstItemBox.y + 20)
    await page.waitForTimeout(50)
  }
  const focusOwner = await page.evaluate(async ({ trigger, firstMenuItem }) => {
    const active = document.activeElement as HTMLElement | null
    const describe = (kind: 'trigger' | 'menuitem' | 'other') => ({
      kind,
      tag: active?.tagName.toLowerCase() ?? null,
      role: active?.getAttribute('role') ?? null,
      ariaLabel: active?.getAttribute('aria-label') ?? null,
    })
    if (active === trigger) return describe('trigger')
    if (active === firstMenuItem) return describe('menuitem')
    return describe('other')
  }, { trigger: await trigger.elementHandle(), firstMenuItem: await firstMenuItem.elementHandle() })
  const evidence = await menu.evaluate((element, state) => {
    const rect = (node: Element) => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height } }
    const menuStyle = getComputedStyle(element)
    const item = (node: Element) => {
      const style = getComputedStyle(node)
      const name = node.querySelector('[class*=itemName]')
      const description = node.querySelector('[class*=itemDesc]')
      return {
        tag: node.tagName.toLowerCase(), class: node.className, role: node.getAttribute('role'), rect: rect(node),
        style: { display: style.display, minHeight: style.minHeight, padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor },
        nameStyle: name ? { fontFamily: getComputedStyle(name).fontFamily, fontWeight: getComputedStyle(name).fontWeight, fontSize: getComputedStyle(name).fontSize, lineHeight: getComputedStyle(name).lineHeight, color: getComputedStyle(name).color } : null,
        descriptionStyle: description ? { fontFamily: getComputedStyle(description).fontFamily, fontWeight: getComputedStyle(description).fontWeight, fontSize: getComputedStyle(description).fontSize, lineHeight: getComputedStyle(description).lineHeight, color: getComputedStyle(description).color } : null,
      }
    }
    return {
      source: 'Harness production web agent-preset seat', semanticFixture: `agent-preset-selection/ready/Standard mode/${state}`, state,
      dom: element.outerHTML, rect: rect(element),
      style: { padding: menuStyle.padding, borderRadius: menuStyle.borderRadius, minWidth: menuStyle.minWidth, boxShadow: menuStyle.boxShadow, backgroundColor: menuStyle.backgroundColor, borderColor: menuStyle.borderColor, fontFamily: menuStyle.fontFamily },
      items: [...element.querySelectorAll('[role="menuitem"]')].map(item),
    }
  }, fixtureState)
  await writeFile(join(root, 'reports', `${outputStem}.json`), `${JSON.stringify({ viewport, ...evidence, focusOwner }, null, 2)}\n`)
  await page.screenshot({ path: join(root, 'reports', `${outputStem}.png`) })
}

async function captureBusyTrigger(page: Page) {
  await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
  const menu = page.getByRole('menu')
  await menu.waitFor({ timeout: 10_000 })
  await menu.getByRole('menuitem', { name: /Minimal mode/ }).click()
  const trigger = page.getByRole('button', { name: 'Minimal mode', exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('button')]
    .some(button => button.textContent?.trim() === 'Minimal mode' && (button as HTMLButtonElement).disabled))
  const evidence = await trigger.evaluate((element, state) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      source: 'Harness production web agent-preset seat with delayed host select',
      semanticFixture: `agent-preset-selection/blank session/Minimal mode/${state}`,
      state,
      dom: element.outerHTML,
      disabled: (element as HTMLButtonElement).disabled,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: { padding: style.padding, gap: style.gap, border: style.border, borderRadius: style.borderRadius, opacity: style.opacity, cursor: style.cursor },
    }
  }, fixtureState)
  await writeFile(join(root, 'reports', `${outputStem}.json`), `${JSON.stringify({ viewport, ...evidence }, null, 2)}\n`)
  await page.screenshot({ path: join(root, 'reports', `${outputStem}.png`) })
}

describe('Harness production Agent Preset Select menu fixture', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    await mkdir(join(root, 'reports'), { recursive: true })
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: `${harnessRoot}/apps/cli/config/agent-presets`, trust: 'system' }], default: 'standard' },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    if (interaction === 'busy') {
      const api = scaffold.ctx.apiProxy.agentPresets as DeferredAgentPresetSelect
      const original = api.select.bind(api)
      api.select = request => new Promise((resolve, reject) => {
        settleBusySelect = async () => {
          try { resolve(await original(request)) } catch (error) { reject(error) }
        }
      })
    }
  }, 120_000)

  afterAll(async () => {
    await settleBusySelect?.()
    await browser?.close()
    await scaffold?.close()
  })

  it('captures the requested production Agent Preset state', async () => {
    if (interaction === 'busy') await captureBusyTrigger(page)
    else await captureOpenMenu(page)
  }, 60_000)
})
