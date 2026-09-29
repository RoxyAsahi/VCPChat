const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const port = 9128;
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body { margin: 0; background: #202430; overflow: hidden; }
canvas { width: 100vw; height: 100vh; display: block; }
</style>
<script type="importmap">
{
  "imports": {
    "three": "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/"
  }
}
</script>
</head>
<body>
<canvas id="c"></canvas>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(2);
renderer.setSize(800, 600);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 800 / 600, 0.1, 100);
camera.position.set(0, 0, 3.2);

const ambient = new THREE.AmbientLight(0xffffff, 1.0);
scene.add(ambient);

const loader = new GLTFLoader();
loader.load('/scratch/zzz_belle/belle.glb', (gltf) => {
  const model = gltf.scene;

  // Compute bounding box
  const bbox = new THREE.Box3().setFromObject(model);
  const size = bbox.getSize(new THREE.Vector3());
  console.log('SIZE:', size);

  // Bust portrait framing: focus on head and upper jacket
  const targetScale = 2.4 / Math.max(size.y, 1);
  model.scale.set(targetScale, targetScale, targetScale);

  // Face height is around bbox.max.y - size.y * 0.13
  const faceY = (bbox.max.y - size.y * 0.14) * targetScale;
  model.position.set(0, -faceY, 0);

  // Face camera directly
  model.rotation.set(0, 0, 0);

  scene.add(model);
  renderer.render(scene, camera);
  window.renderReady = true;
}, null, (e) => {
  window.renderError = String(e);
});
</script>
</body>
</html>`);
    return;
  }

  const cleanPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  const filePath = path.join(__dirname, '..', cleanPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.js': 'application/javascript',
      '.png': 'image/png',
      '.glb': 'model/gltf-binary',
      '.html': 'text/html',
      '.css': 'text/css'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(port, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.renderReady || window.renderError, { timeout: 15000 });

    const isError = await page.evaluate(() => window.renderError);
    if (isError) throw new Error(isError);

    await new Promise(r => setTimeout(r, 400));
    const outPng = '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828/test_belle_render.png';
    await page.screenshot({ path: outPng });
    console.log('SCREENSHOT SAVED TO:', outPng);

    await browser.close();
  } catch (err) {
    console.error('Render failed:', err);
  } finally {
    server.close();
  }
});
