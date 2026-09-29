const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const port = 9127;
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
<body>
<script type="module">
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

window.THREE = THREE;

async function run() {
  const loader = new FBXLoader();
  const texLoader = new THREE.TextureLoader();

  // Load diffuse textures with default flipY=true
  const faceTex = await texLoader.loadAsync('/scratch/zzz_belle/Belle_Face_D.png');
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.flipY = true;

  const body1Tex = await texLoader.loadAsync('/scratch/zzz_belle/Belle_Body_Map1_D.png');
  body1Tex.colorSpace = THREE.SRGBColorSpace;
  body1Tex.flipY = true;

  const body2Tex = await texLoader.loadAsync('/scratch/zzz_belle/Belle_Body_Map2_D.png');
  body2Tex.colorSpace = THREE.SRGBColorSpace;
  body2Tex.flipY = true;

  loader.load('/scratch/zzz_belle/belle.fbx', (fbx) => {
    // Correct orientation: FBX is +Z up, rotate -90 deg X
    fbx.rotation.x = -Math.PI / 2;
    fbx.updateMatrixWorld(true);

    fbx.traverse((child) => {
      if (child.isMesh) {
        const nameLower = (child.name || '').toLowerCase();
        let targetTex = body1Tex;

        if (nameLower.includes('face')) {
          targetTex = faceTex;
        } else if (nameLower.includes('body_1') || nameLower.includes('body1')) {
          targetTex = body1Tex;
        } else if (nameLower.includes('body_2') || nameLower.includes('body2')) {
          targetTex = body2Tex;
        }

        console.log('Mapping mesh:', child.name, '->', targetTex === faceTex ? 'Face' : (targetTex === body1Tex ? 'Body1' : 'Body2'));

        child.material = new THREE.MeshBasicMaterial({
          map: targetTex,
          side: THREE.DoubleSide,
          transparent: true,
          alphaTest: 0.2,
          depthWrite: true
        });
      }
    });

    const exporter = new GLTFExporter();
    exporter.parse(fbx, (gltf) => {
      window.exportedGlb = gltf;
      window.statusDone = true;
    }, (err) => {
      window.statusError = String(err);
    }, { binary: true });
  }, null, (err) => {
    window.statusError = String(err);
  });
}

run().catch(e => {
  window.statusError = String(e);
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
      '.fbx': 'application/octet-stream',
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
    page.on('console', msg => console.log('[PAGE]', msg.text()));
    page.on('pageerror', err => console.log('[PAGE ERR]', err));

    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.statusDone || window.statusError, { timeout: 30000 });

    const isError = await page.evaluate(() => window.statusError);
    if (isError) throw new Error(isError);

    const glbBase64 = await page.evaluate(() => {
      const bytes = new Uint8Array(window.exportedGlb);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    });

    const glbBuffer = Buffer.from(glbBase64, 'base64');
    const outPath = path.join(__dirname, 'zzz_belle', 'belle.glb');
    fs.writeFileSync(outPath, glbBuffer);
    console.log(`SUCCESS! Wrote ${glbBuffer.length} bytes to ${outPath}`);

    // Also write directly to assets/nova_model.glb
    const assetPath = path.join(__dirname, '..', 'assets', 'nova_model.glb');
    fs.writeFileSync(assetPath, glbBuffer);
    console.log(`SUCCESS! Updated ${assetPath}`);

    await browser.close();
  } catch (err) {
    console.error('Failed:', err);
  } finally {
    server.close();
  }
});
