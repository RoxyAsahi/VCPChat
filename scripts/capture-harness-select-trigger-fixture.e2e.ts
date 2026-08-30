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

async function captureClosedTrigger(page: Page) {
  const trigger = page.getByRole('button', { name: 'Standard mode', exact: true })
  await trigger.waitFor({ timeout: 10_000 })
  const evidence = await trigger.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      source: 'Harness production web agent-preset seat',
      semanticFixture: 'agent-preset-selection/ready/Standard mode/closed-trigger',
      state: 'closed-ready-trigger',
      text: element.textContent?.trim(),
      dom: element.outerHTML,
      attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: {
        display: style.display,
        alignItems: style.alignItems,
        gap: style.gap,
        width: style.width,
        minHeight: style.minHeight,
        padding: style.padding,
        borderWidth: style.borderWidth,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        boxShadow: style.boxShadow,
        cursor: style.cursor,
        opacity: style.opacity,
      },
    }
  })
  await writeFile(join(root, 'reports', 'harness-select-trigger-closed.json'), `${JSON.stringify({ viewport, ...evidence }, null, 2)}\n`)
  await trigger.screenshot({ path: join(root, 'reports', 'harness-select-trigger-closed.png') })
}

describe('Harness production Agent Preset Select trigger fixture', () => {
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
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('captures the ready closed trigger from the production new-session surface', async () => {
    await captureClosedTrigger(page)
  }, 60_000)
})
