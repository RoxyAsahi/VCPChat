const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const port = 9140;
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
    if (c.isMesh && c.name === 'Belle_Body_2') {
      const geo = c.geometry;
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      
      // Filter out triangles with uv in bottom-left spotted area
      const newPos = [];
      const newUv = [];
      const count = pos.count;
      for (let i = 0; i < count; i += 3) {
        let isSpotted = false;
        for (let j = 0; j < 3; j++) {
          const u = uv.getX(i + j);
          const v = uv.getY(i + j);
          if (u < 0.25 && v < 0.2) {
            isSpotted = true;
            break;
          }
        }
        if (!isSpotted) {
          for (let j = 0; j < 3; j++) {
            newPos.push(pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j));
            newUv.push(uv.getX(i + j), uv.getY(i + j));
          }
        }
      }
      
      const newGeo = new THREE.BufferGeometry();
      newGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
      newGeo.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
      newGeo.computeVertexNormals();
      c.geometry = newGeo;
    }
  });

  // Center on head
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
    await page.screenshot({ path: 'scratch/test_no_spotted.png' });
    console.log('Saved scratch/test_no_spotted.png');

    await browser.close();
  } catch (err) {
    console.error('Render failed:', err);
  } finally {
    server.close();
  }
});
