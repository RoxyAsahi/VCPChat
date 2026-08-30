import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { Browser, Page } from '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.d.ts'
import { launchWebScaffold, type WebScaffold, WELCOME_NOTICE_COPY } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/scaffold.ts'
import { ZH_BROWSER_LOCALE } from '/Users/asahi/Documents/Codex/deepseek-harness/apps/web/tests/support.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness'
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`)
const { chromium } = harnessRequire('playwright') as { chromium: { launch(): Promise<Browser> } }
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }

describe('Harness production WelcomeNotice Button fixture', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    await mkdir(join(root, 'reports'), { recursive: true })
    scaffold = await launchWebScaffold({ remoteAuthority: 'remote.localhost', welcomeNoticePending: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport, locale: ZH_BROWSER_LOCALE })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('captures the pre-acknowledgement primary button from the real WelcomeNotice composition', async () => {
    const dialog = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await dialog.waitFor({ timeout: 15_000 })
    const button = dialog.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel, exact: true })
    await button.waitFor({ timeout: 15_000 })
    const evidence = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const dialogRect = element.closest('[role="dialog"]')?.getBoundingClientRect()
      const style = getComputedStyle(element)
      const properties = ['display', 'align-items', 'justify-content', 'gap', 'padding', 'border', 'border-width', 'border-style', 'border-color', 'border-radius', 'box-sizing', 'appearance', '-webkit-appearance', 'outline', 'font-size', 'line-height']
      const matchedRules: Array<{ selector: string; declarations: Record<string, string> }> = []
      for (const sheet of [...document.styleSheets]) {
        let rules: CSSRuleList
        try { rules = sheet.cssRules } catch { continue }
        for (const rule of [...rules]) {
          if (!(rule instanceof CSSStyleRule) || !element.matches(rule.selectorText)) continue
          const declarations = Object.fromEntries(properties
            .map(property => [property, rule.style.getPropertyValue(property)] as const)
            .filter(([, value]) => value))
          if (Object.keys(declarations).length) matchedRules.push({ selector: rule.selectorText, declarations })
        }
      }
      const inline = Object.fromEntries(properties
        .map(property => [property, element instanceof HTMLElement ? element.style.getPropertyValue(property) : ''] as const)
        .filter(([, value]) => value))
      return {
        source: 'Harness production WelcomeNotice',
        sourcePath: 'packages/client/ui-settings-models/src/client/WelcomeNotice.tsx',
        semanticFixture: 'settings-onboarding/welcome-notice/continue/primary-md/enabled',
        text: element.textContent?.trim(),
        dom: element.outerHTML,
        attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        dialogRect: dialogRect ? { x: dialogRect.x, y: dialogRect.y, width: dialogRect.width, height: dialogRect.height } : null,
        authored: { inline, matchedRules },
        style: {
          display: style.display, alignItems: style.alignItems, justifyContent: style.justifyContent, gap: style.gap, padding: style.padding,
          border: style.border, borderWidth: style.borderWidth, borderStyle: style.borderStyle, borderColor: style.borderColor, borderRadius: style.borderRadius, boxSizing: style.boxSizing, appearance: style.appearance, outline: style.outline, backgroundColor: style.backgroundColor,
          color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
          lineHeight: style.lineHeight, boxShadow: style.boxShadow, cursor: style.cursor, opacity: style.opacity,
        },
      }
    })
    await writeFile(join(root, 'reports', 'harness-button-welcome-production.json'), `${JSON.stringify({ viewport, ...evidence }, null, 2)}\n`)
    await button.screenshot({ path: join(root, 'reports', 'harness-button-welcome-production.png') })
  }, 60_000)
})
