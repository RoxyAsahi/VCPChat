import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.d.ts'
import { launchWebScaffold, type WebScaffold } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/scaffold.ts'
import { ZH_BROWSER_LOCALE } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/support.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const harnessRequire = createRequire('/Users/asahi/Documents/Codex/deepseek-harness/apps/web/package.json')
const { chromium } = harnessRequire('playwright') as { chromium: { launch(): Promise<Browser> } }
// Plugin Settings is hidden by the narrow navigation at 800px, so this
// production consumer uses the explicitly recorded wide-fixture exception.
const viewport = { width: 1680, height: 1000, deviceScaleFactor: 1 }
const fieldLabel = '命令超时（毫秒）'
const invalidCopy = '请填数字；留空表示使用默认值。'

interface NodeEvidence {
  tag: string
  class: string
  rect: { x: number, y: number, width: number, height: number }
  style: Record<string, string>
}

function openPlugins(page: Page) {
  return (async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await expect.poll(() => dialog.getByRole('button', { name: '插件', exact: true }).getAttribute('aria-current'))
      .toBe('true')
    await dialog.getByText('终端', { exact: true }).click()
    return dialog
  })()
}

async function capture(page: Page, state: 'description' | 'error') {
  const input = page.getByLabel(fieldLabel)
  await input.waitFor({ timeout: 10_000 })
  if (state === 'error') {
    await input.fill('soon')
    await page.getByText(invalidCopy, { exact: true }).waitFor({ timeout: 10_000 })
  }
  const field = input.locator('xpath=..')
  const evidence = await field.evaluate((root, currentState) => {
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height }
    }
    const style = (node: Element) => {
      const value = getComputedStyle(node)
      return {
        display: value.display,
        padding: value.padding,
        gap: value.gap,
        height: value.height,
        borderRadius: value.borderRadius,
        fontSize: value.fontSize,
        fontWeight: value.fontWeight,
        lineHeight: value.lineHeight,
        color: value.color,
        backgroundColor: value.backgroundColor,
        borderColor: value.borderColor,
      }
    }
    const head = root.querySelector(':scope > div')
    const label = root.querySelector('label')
    const control = root.querySelector('input')
    const message = root.querySelector('p')
    if (!head || !label || !control || !message) throw new Error('Harness ValueField contract is incomplete')
    const node = (element: Element): NodeEvidence => ({
      tag: element.tagName.toLowerCase(), class: element.className, rect: rect(element), style: style(element),
    })
    return {
      source: 'Harness production web plugin-config E2E',
      viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
      state: currentState,
      dom: root.outerHTML,
      rect: rect(root),
      root: node(root), head: node(head), label: node(label), input: node(control), message: node(message),
    }
  }, state)
  await writeFile(join(root, 'reports', `harness-field-${state}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  await field.screenshot({ path: join(root, 'reports', `harness-field-${state}.png`) })
}

describe('Harness production Field browser fixture', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    await mkdir(join(root, 'reports'), { recursive: true })
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport, locale: ZH_BROWSER_LOCALE })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('captures normal and invalid terminal timeout fields from the real Settings surface', async () => {
    await openPlugins(page)
    await capture(page, 'description')
    await capture(page, 'error')
  }, 60_000)
})
