const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const port = 9139;
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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 800 / 600, 0.1, 100);
camera.position.set(0, 0, 1.8);

const loader = new GLTFLoader();
loader.load('/scratch/zzz_belle/belle.glb', (gltf) => {
  const model = gltf.scene;

  model.traverse(c => {
    if (c.isMesh) {
      c.material.transparent = true;
      c.material.alphaTest = 0.5;
      c.material.depthWrite = true;
      c.material.needsUpdate = true;
    }
  });

  // Center on head: head is at approx Y = 1.35
  model.position.set(0, -1.35, 0);
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
      '.html': 'text/html'
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

    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: 'scratch/test_belle_alpha.png' });
    console.log('Saved scratch/test_belle_alpha.png');

    await browser.close();
  } catch (err) {
    console.error('Render failed:', err);
  } finally {
    server.close();
  }
});
