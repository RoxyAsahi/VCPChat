const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = '/Users/asahi/Documents/Codex/vcpchat-exp-schema';
const artifactDir = '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828';

const testHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Nova 3D Visual Preview</title>
  <link rel="stylesheet" href="styles/ui-next.css">
  <script src="vendor/three.min.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #090c15;
      width: 800px;
      height: 600px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    #nextUiEmptyState {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .vcp-dither-visual-host {
      width: 700px;
      height: 480px;
      position: relative;
    }
    .vcp-dither-visual-canvas {
      width: 100%;
      height: 400px;
      display: block;
    }
  </style>
</head>
<body class="next-ui-empty-state-active" data-vcp-theme="dark">
  <main class="main-content next-ui-empty-state-active" data-chat-empty="true">
    <section id="nextUiEmptyState">
      <div id="vcpDitherVisualHost" class="vcp-dither-visual-host">
        <canvas id="vcpDitherVisualCanvas" class="vcp-dither-visual-canvas"></canvas>
        <div class="vcp-dither-hud">
          <div class="vcp-dither-hud-group" data-group="subject">
            <button type="button" class="vcp-dither-pill is-active" data-subject="nova">✦ NOVA</button>
            <button type="button" class="vcp-dither-pill" data-subject="vcpchat">◈ VCPCHAT</button>
            <button type="button" class="vcp-dither-pill" data-subject="kitty">🐾 KITTY</button>
          </div>
          <div class="vcp-dither-hud-divider"></div>
          <div class="vcp-dither-hud-group" data-group="method">
            <button type="button" class="vcp-dither-pill is-active" data-method="bayer">☷ Bayer</button>
            <button type="button" class="vcp-dither-pill" data-method="halftone">◉ Halftone</button>
            <button type="button" class="vcp-dither-pill" data-method="floyd">░ Floyd</button>
            <button type="button" class="vcp-dither-pill" data-method="ascii">▤ ASCII</button>
            <button type="button" class="vcp-dither-pill" data-method="glow">✧ Glow</button>
          </div>
        </div>
      </div>
    </section>
  </main>
  <script type="module">
    import { initVcpDitherVisual } from './modules/ui-system/vcp-dither-visual.js';
    const visual = initVcpDitherVisual();
    window.visual = visual;
    window.visualReady = false;

    const checkReady = () => {
      const novaModel = window.visual?.models?.get('nova');
      const hasCustomized = novaModel?.children?.some(c => c.name === 'NovaCustomized3D');
      if (hasCustomized) {
        window.visualReady = true;
      } else {
        setTimeout(checkReady, 50);
      }
    };
    checkReady();
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(testHtml);
  }
  const filePath = path.join(rootDir, reqPath);
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    return res.end('Not found: ' + reqPath);
  }
  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png'
  }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  fs.createReadStream(filePath).pipe(res);
});

server.listen(8999, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.goto('http://localhost:8999/', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.visualReady === true, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 600));

    // 1. Bayer mode
    await page.evaluate(() => {
      window.visual.setMethod('bayer');
      window.visual.currentRotationY = 0.22;
    });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'nova_final_bayer.png') });

    // 2. Halftone mode
    await page.evaluate(() => {
      window.visual.setMethod('halftone');
      window.visual.currentRotationY = -0.25;
    });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'nova_final_halftone.png') });

    // 3. Floyd-Steinberg mode
    await page.evaluate(() => {
      window.visual.setMethod('floyd');
      window.visual.currentRotationY = 0.05;
    });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'nova_final_floyd.png') });

    // 4. ASCII mode
    await page.evaluate(() => {
      window.visual.setMethod('ascii');
      window.visual.currentRotationY = 0.1;
    });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'nova_final_ascii.png') });

    // 5. Glow mode
    await page.evaluate(() => {
      window.visual.setMethod('glow');
      window.visual.currentRotationY = 0;
    });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'nova_final_glow.png') });

    await browser.close();
    console.log('ALL FINAL NOVA 3D SCREENSHOTS CAPTURED!');
  } catch (e) {
    console.error(e);
  } finally {
    server.close();
  }
});
