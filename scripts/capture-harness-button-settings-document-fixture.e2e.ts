import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { Browser, Page } from '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.d.ts'
import { launchWebScaffold, type WebScaffold } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/scaffold.ts'
import { ZH_BROWSER_LOCALE } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/support.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness'
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`)
const { chromium } = harnessRequire('playwright') as { chromium: { launch(): Promise<Browser> } }
const viewport = { width: 1680, height: 1000, deviceScaleFactor: 1 }

describe('Harness SettingsDocumentAction Button fixture', () => {
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
  afterAll(async () => { await browser?.close(); await scaffold?.close() })
  it('captures the enabled outline/sm action', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 15_000 })
    const button = dialog.getByRole('button', { name: '打开配置文件', exact: true })
    await button.waitFor({ timeout: 15_000 })
    const evidence = await button.evaluate(element => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element)
      return { source: 'Harness production SettingsDocumentAction', sourcePath: 'packages/client/ui-settings-general/src/client/SettingsDocumentAction.tsx', semanticFixture: 'settings-general/document-action/open-document/outline-sm/enabled', text: element.textContent?.trim(), dom: element.outerHTML, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: { display: style.display, alignItems: style.alignItems, gap: style.gap, padding: style.padding, borderWidth: style.borderWidth, borderRadius: style.borderRadius, backgroundColor: style.backgroundColor, color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, boxShadow: style.boxShadow, cursor: style.cursor, opacity: style.opacity } }
    })
    await writeFile(join(root, 'reports/harness-button-settings-document-production.json'), `${JSON.stringify({ viewport, ...evidence }, null, 2)}\n`)
    await button.screenshot({ path: join(root, 'reports/harness-button-settings-document-production.png') })
  }, 60_000)
})
