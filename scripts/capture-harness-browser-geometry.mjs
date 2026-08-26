import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.HARNESS_URL || 'http://127.0.0.1:4173';
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport });
try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const capture = await page.evaluate(() => {
        const input = document.querySelector('input[aria-label="API 密钥"]');
        if (!input) return { status: 'missing-input' };
        const style = getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        input.focus();
        const focused = getComputedStyle(input);
        return {
            status: 'captured',
            source: 'Harness production web entry',
            selector: 'input[aria-label="API 密钥"]',
            dom: { tag: input.tagName.toLowerCase(), class: input.className, type: input.type, ariaLabel: input.getAttribute('aria-label') },
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            computedStyle: {
                display: style.display, height: style.height, padding: style.padding,
                borderRadius: style.borderRadius, fontSize: style.fontSize,
                lineHeight: style.lineHeight, border: style.border,
                outline: focused.outline, outlineOffset: focused.outlineOffset,
            },
        };
    });
    const report = { generatedAt: new Date().toISOString(), url, viewport, ...capture };
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/harness-primitive-geometry.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await page.screenshot({ path: path.join(root, 'reports/harness-settings-production.png') });
    if (capture.status !== 'captured') process.exitCode = 2;
    console.log(`Harness browser geometry capture: ${capture.status}`);
} finally {
    await browser.close();
}
