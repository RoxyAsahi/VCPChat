const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const port = 9151;
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script type="importmap">
{
  "imports": {
    "three": "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/"
  }
}
</script>
</head>
<body style="margin:0; background:#202430;">
<canvas id="c" width="800" height="600"></canvas>
<script type="module">
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
renderer.setSize(800, 600);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 800 / 600, 0.1, 100);
camera.position.set(0, 0, 1.6);

const ambient = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambient);

// Helper to flip an image vertically on a canvas so its pixels are natively in glTF orientation
async function createFlippedTexture(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => {
      const cvs = document.createElement('canvas');
      cvs.width = img.width;
      cvs.height = img.height;
      const ctx = cvs.getContext('2d');
      // Flip vertically!
      ctx.translate(0, cvs.height);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0);
      const canvasTex = new THREE.CanvasTexture(cvs);
      canvasTex.colorSpace = THREE.SRGBColorSpace;
      // In GLTFExporter, if flipY is false, GLTFExporter writes canvas as-is!
      canvasTex.flipY = false;
      resolve(canvasTex);
    };
  });
}

const faceTex = await createFlippedTexture('/scratch/zzz_belle/Belle_Face_D.png');
const body1Tex = await createFlippedTexture('/scratch/zzz_belle/Belle_Body_Map1_D.png');
const body2Tex = await createFlippedTexture('/scratch/zzz_belle/Belle_Body_Map2_D.png');

const loader = new FBXLoader();
loader.load('/scratch/zzz_belle/belle.fbx', (fbx) => {
  fbx.rotation.x = -Math.PI / 2;
  fbx.traverse(c => {
    if (c.isMesh) {
      const n = (c.name || '').toLowerCase();
      let tex = body1Tex;
      if (n.includes('face')) tex = faceTex;
      else if (n.includes('body_2') || n.includes('body2')) tex = body2Tex;
      
      c.material = new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.2
      });
    }
  });

  fbx.position.set(0, -1.35, 0);
  scene.add(fbx);
  renderer.render(scene, camera);
  window.fbxRendered = true;

  // Export to GLB
  const exporter = new GLTFExporter();
  exporter.parse(fbx, (glb) => {
    window.exportedGlb = glb;
    window.doneExport = true;
  }, { binary: true });
});
</script>
</body>
</html>`);
    return;
  }
  const cleanPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  const filePath = path.join(process.cwd(), cleanPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.js': 'application/javascript', '.png': 'image/png', '.fbx': 'application/octet-stream' };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(port, async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:' + port);
  await page.waitForFunction(() => window.fbxRendered && window.doneExport, { timeout: 25000 });
  await page.screenshot({ path: 'scratch/test_flipped_canvas.png' });
  console.log('Saved scratch/test_flipped_canvas.png');

  const glbBase64 = await page.evaluate(() => {
    const bytes = new Uint8Array(window.exportedGlb);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });
  const glbBuffer = Buffer.from(glbBase64, 'base64');
  fs.writeFileSync('assets/nova_model.glb', glbBuffer);
  console.log('WROTE NEW assets/nova_model.glb:', glbBuffer.length, 'bytes');

  await browser.close();
  server.close();
});
