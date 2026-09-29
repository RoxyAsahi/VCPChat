const puppeteer = require('puppeteer');
const path = require('path');

const rootDir = '/Users/asahi/Documents/Codex/vcpchat-exp-schema';
const artifactDir = '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('LOG:', msg.text()));
  page.on('pageerror', err => console.log('ERR:', err));
  
  // Load main.html via file://
  const fileUrl = 'file://' + path.join(rootDir, 'main.html');
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // Inspect 3D visual state in main.html
  const status = await page.evaluate(() => {
    const canvas = document.getElementById('vcpDitherVisualCanvas');
    return {
      hasCanvas: !!canvas,
      canvasW: canvas?.width,
      canvasH: canvas?.height,
      hasVisual: !!window.vcpDitherVisualInstance,
    };
  });
  console.log('Status in main.html:', status);

  await page.screenshot({ path: path.join(artifactDir, 'inspect_main_screenshot.png') });
  await browser.close();
})();
