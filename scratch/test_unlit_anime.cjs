const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = '/Users/asahi/Documents/Codex/vcpchat-exp-schema';
const artifactDir = '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828';

const testHtml = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #ffffff; display: flex; align-items: center; justify-content: center; height: 100vh; }
    canvas { width: 700px; height: 480px; display: block; }
  </style>
  <script src="vendor/three.min.js"></script>
</head>
<body>
  <canvas id="c" width="1400" height="960"></canvas>
  <script type="module">
    import { GLTFLoader } from "./vendor/GLTFLoader.js";
    const THREE = window.THREE;
    const canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(700, 480);
    renderer.setPixelRatio(2);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 700/480, 0.1, 100);
    camera.position.set(0, 0, 4.8);

    // Glowing Neon Ring
    const ringGeo = new THREE.RingGeometry(2.1, 2.18, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, 0, -0.6);
    scene.add(ring);

    const loader = new GLTFLoader();
    loader.load("assets/nova_model.glb", (gltf) => {
      const root = new THREE.Group();
      const model = gltf.scene;

      // Use clean, pristine MeshBasicMaterial with original textures
      model.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const newMats = mats.map((m) => {
            const isTransparent = m.transparent || (m.name && m.name.includes('表情'));
            return new THREE.MeshBasicMaterial({
              map: m.map,
              transparent: isTransparent,
              alphaTest: isTransparent ? 0.2 : 0.0,
              side: THREE.DoubleSide,
            });
          });
          child.material = Array.isArray(child.material) ? newMats : newMats[0];
        }
      });

      model.position.set(0, -17.4, 0);
      root.add(model);
      root.scale.set(0.68, 0.68, 0.68);
      scene.add(root);

      renderer.render(scene, camera);
      window.renderReady = true;
    });
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

server.listen(9015, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 480, deviceScaleFactor: 2 });
    await page.goto('http://localhost:9015/');
    await page.waitForFunction(() => window.renderReady, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'test_unlit_pristine.png') });
    console.log('SAVED test_unlit_pristine.png');
    await browser.close();
  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
