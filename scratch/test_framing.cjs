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
  <title>Nova Framing Test</title>
  <link rel="stylesheet" href="styles/ui-next.css">
  <script src="vendor/three.min.js"></script>
  <style>
    body { margin: 0; padding: 0; background: #090c15; width: 800px; height: 600px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .vcp-dither-visual-host { width: 700px; height: 480px; position: relative; }
    .vcp-dither-visual-canvas { width: 100%; height: 400px; display: block; }
  </style>
</head>
<body class="next-ui-empty-state-active" data-vcp-theme="dark">
  <main class="main-content next-ui-empty-state-active" data-chat-empty="true">
    <section id="nextUiEmptyState">
      <div id="vcpDitherVisualHost" class="vcp-dither-visual-host">
        <canvas id="vcpDitherVisualCanvas" class="vcp-dither-visual-canvas"></canvas>
        <div class="vcp-dither-hud">
          <button type="button" class="vcp-dither-pill is-active" data-subject="nova">✦ NOVA</button>
          <div class="vcp-dither-hud-divider"></div>
          <button type="button" class="vcp-dither-pill is-active" data-method="glow">✧ Glow</button>
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

server.listen(9005, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.goto('http://localhost:9005/', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.visualReady === true, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 600));

    // Test different scales & positions
    // Try scale 0.70, position Y = -17.5
    await page.evaluate(() => {
      const THREE = window.THREE;
      const visual = window.visual;
      const novaGroup = visual.models.get('nova');
      const root = novaGroup.children.find(c => c.name === 'NovaCustomized3D');
      const keqing = root.children[0];
      
      root.scale.set(0.68, 0.68, 0.68);
      keqing.position.set(0, -17.4, 0);

      // Add a beauty ring light directly in front of the face
      if (!visual.beautyLight) {
        visual.beautyLight = new THREE.DirectionalLight(0xfff6ea, 1.8);
        visual.beautyLight.position.set(0, 0.5, 4.0);
        visual.scene.add(visual.beautyLight);
      }
      visual.setMethod('glow');
    });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(artifactDir, 'keqing_bust_glow.png') });

    await page.evaluate(() => {
      window.visual.setMethod('bayer');
    });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(artifactDir, 'keqing_bust_bayer.png') });

    await page.evaluate(() => {
      window.visual.setMethod('halftone');
    });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(artifactDir, 'keqing_bust_halftone.png') });

    await page.evaluate(() => {
      window.visual.setMethod('ascii');
    });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(artifactDir, 'keqing_bust_ascii.png') });

    await browser.close();
    console.log('DONE CAPTURING BUST PREVIEWS');
  } catch (e) {
    console.error(e);
  } finally {
    server.close();
  }
});
