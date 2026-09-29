const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const artifactDir = '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828';

const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #090c15; display: flex; align-items: center; justify-content: center; height: 100vh; }
    canvas { width: 600px; height: 600px; }
  </style>
  <script src="vendor/three.min.js"></script>
</head>
<body>
  <canvas id="c" width="600" height="600"></canvas>
  <script type="module">
    import { GLTFLoader } from "./vendor/GLTFLoader.js";
    const THREE = window.THREE;
    const canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(600, 600);
    renderer.setPixelRatio(2);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 3.5);

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444455, 1.2);
    scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xfff5ea, 1.5);
    dirLight.position.set(2, 4, 3);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x00f0ff, 0.6);
    fillLight.position.set(-2, 0, 2);
    scene.add(fillLight);

    const loader = new GLTFLoader();
    loader.load("scratch/test_keqing.glb", (gltf) => {
      const model = gltf.scene;

      // Bust framing:
      // Keqing bounds: Y from 0 to 21.2. Face at Y ~ 17.6, bust from ~14 to 20.
      // Let's center bust at (0, 0, 0) and scale to fit ~2.5 units
      // center Y at 17.0
      model.position.set(0, -17.0 * 0.35, 0);
      model.scale.set(0.35, 0.35, 0.35);

      scene.add(model);
      renderer.render(scene, camera);
      window.renderReady = true;
    });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/" || reqPath === "/index.html") {
    res.setHeader("Content-Type", "text/html");
    return res.end(html);
  }
  const filePath = path.join(process.cwd(), reqPath);
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    return res.end("Not found: " + reqPath);
  }
  const ext = path.extname(filePath);
  const mime = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".glb": "model/gltf-binary",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  fs.createReadStream(filePath).pipe(res);
});

server.listen(9002, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-webgl"]
    });
    const page = await browser.newPage();
    page.on("console", msg => console.log("PAGE:", msg.text()));
    page.on("pageerror", err => console.log("PAGE ERR:", err));
    await page.setViewport({ width: 600, height: 600, deviceScaleFactor: 2 });
    await page.goto("http://localhost:9002/");
    await page.waitForFunction(() => window.renderReady, { timeout: 10000 });
    await new Promise(r => setTimeout(r, 200));
    await page.screenshot({ path: path.join(artifactDir, 'keqing_preview_raw.png') });
    console.log("RENDER SAVED TO keqing_preview_raw.png");
    await browser.close();
  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
