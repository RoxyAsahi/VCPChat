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
    body { margin: 0; background: #090c15; display: flex; align-items: center; justify-content: center; height: 100vh; }
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

    // 1. Anime Studio Lights
    const ambient = new THREE.AmbientLight(0xffffff, 1.4);
    scene.add(ambient);

    // Key Toon Light (casts crisp cel shadows)
    const keyLight = new THREE.DirectionalLight(0xfff7ea, 1.8);
    keyLight.position.set(2, 3, 3);
    scene.add(keyLight);

    // Front Beauty Light (luminous face)
    const beautyLight = new THREE.DirectionalLight(0xfff5f0, 1.5);
    beautyLight.position.set(0, 0.5, 4.0);
    scene.add(beautyLight);

    // Cyan Rim Light (subtle holographic edge)
    const rimLight = new THREE.PointLight(0x00f0ff, 3.0, 10);
    rimLight.position.set(-2, 2, -1);
    scene.add(rimLight);

    // Create 4-step Anime Toon Ramp Texture
    const rampCanvas = document.createElement('canvas');
    rampCanvas.width = 4;
    rampCanvas.height = 1;
    const rctx = rampCanvas.getContext('2d');
    rctx.fillStyle = '#9e96b8'; rctx.fillRect(0, 0, 1, 1);
    rctx.fillStyle = '#bfb8d4'; rctx.fillRect(1, 0, 1, 1);
    rctx.fillStyle = '#e8e4f2'; rctx.fillRect(2, 0, 1, 1);
    rctx.fillStyle = '#ffffff'; rctx.fillRect(3, 0, 1, 1);
    const toonRamp = new THREE.CanvasTexture(rampCanvas);
    toonRamp.minFilter = THREE.NearestFilter;
    toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.generateMipmaps = false;

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

      // Apply Anime NPR Cel-Shading to all meshes
      model.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const newMats = mats.map((m) => {
            const name = m.name || '';
            const isFace = name.includes('面') || name.includes('表情');
            const isEye = name.includes('Mat_1_') || name.includes('Mat_2_') || name.includes('Eye');
            const isHair = name.includes('髪');

            // Anime Toon Material
            const toonMat = new THREE.MeshToonMaterial({
              map: m.map,
              gradientMap: toonRamp,
              transparent: m.transparent || false,
              alphaTest: m.alphaTest || 0.0,
              side: THREE.DoubleSide,
            });

            if (isFace) {
              // Luminous anime skin: no dirty shadows
              toonMat.color.setHex(0xffffff);
            }
            if (isEye) {
              // Sparkling anime eyes: emissive boost
              toonMat.emissive = new THREE.Color(0x221133);
              toonMat.emissiveMap = m.map;
            }
            return toonMat;
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

server.listen(9009, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl']
    });
    const page = await browser.newPage();
    page.on('console', m => console.log('PAGE:', m.text()));
    page.on('pageerror', e => console.log('PAGE ERR:', e));
    await page.setViewport({ width: 700, height: 480, deviceScaleFactor: 2 });
    await page.goto('http://localhost:9009/');
    await page.waitForFunction(() => window.renderReady, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactDir, 'test_anime_npr.png') });
    console.log('SAVED test_anime_npr.png');
    await browser.close();
  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
