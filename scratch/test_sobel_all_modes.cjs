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

    const renderTarget = new THREE.WebGLRenderTarget(1400, 960);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 700/480, 0.1, 100);
    camera.position.set(0, 0, 4.8);

    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xfff8ee, 1.1);
    keyLight.position.set(2, 3, 3);
    scene.add(keyLight);

    const beautyLight = new THREE.DirectionalLight(0xfff0ea, 0.6);
    beautyLight.position.set(0, 0.5, 4.0);
    scene.add(beautyLight);

    const rimLight = new THREE.PointLight(0x00f0ff, 2.5, 10);
    rimLight.position.set(-2, 2, -1);
    scene.add(rimLight);

    // 4-step Anime Toon Ramp
    const rampCanvas = document.createElement('canvas');
    rampCanvas.width = 4;
    rampCanvas.height = 1;
    const rctx = rampCanvas.getContext('2d');
    rctx.fillStyle = '#a8a0be'; rctx.fillRect(0, 0, 1, 1);
    rctx.fillStyle = '#c8c2d8'; rctx.fillRect(1, 0, 1, 1);
    rctx.fillStyle = '#ece8f4'; rctx.fillRect(2, 0, 1, 1);
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

    // Post quad
    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postFrag = \`
      precision highp float;
      in vec2 vUv;
      out vec4 outColor;
      uniform sampler2D tDiffuse;
      uniform vec2 uResolution;
      uniform vec3 uAccentColor;
      uniform int uMethod; // 0: Bayer, 1: Halftone, 2: ASCII, 3: Cyber Glow
      uniform float uGridSize;
      uniform float uPixelSizeRatio;

      const mat4 THRESHOLDS = mat4(
        0.94118, 0.29412, 0.76471, 0.05882,
        0.47059, 0.70588, 0.23529, 0.52941,
        0.82353, 0.11765, 0.88235, 0.17647,
        0.35294, 0.58824, 0.41176, 0.64706
      );

      const float SCREEN_ANGLE = 0.70710678;
      const float CORNER_REACH = 1.41421356;

      vec3 toSrgb(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
      }

      float bayerThreshold(vec2 cellCoord) {
        ivec2 p = ivec2(mod(cellCoord, 4.0));
        return THRESHOLDS[p.x][p.y];
      }

      float halftoneThreshold(vec2 cellCoord) {
        vec2 screen = vec2(
          cellCoord.x * SCREEN_ANGLE - cellCoord.y * SCREEN_ANGLE,
          cellCoord.x * SCREEN_ANGLE + cellCoord.y * SCREEN_ANGLE
        );
        return clamp(length(fract(screen) - 0.5) * CORNER_REACH, 0.0, 1.0);
      }

      float asciiPattern(vec2 cellUv, float level) {
        vec2 p = abs(cellUv - 0.5);
        if (level < 0.12) return 0.0;
        if (level < 0.24) return step(length(p), 0.14);
        if (level < 0.36) return step(p.x, 0.10) * step(abs(p.y - 0.22), 0.10);
        if (level < 0.48) return step(p.y, 0.11) * step(p.x, 0.38);
        if (level < 0.60) return max(step(p.y, 0.09) * step(p.x, 0.34), step(p.x, 0.09) * step(p.y, 0.34));
        if (level < 0.72) {
          float diag = min(abs(cellUv.x - cellUv.y), abs(cellUv.x - (1.0 - cellUv.y)));
          return max(step(diag, 0.10), max(step(p.y, 0.08), step(p.x, 0.08)));
        }
        if (level < 0.85) {
          float bars = max(step(abs(p.x - 0.16), 0.08), step(abs(p.y - 0.16), 0.08));
          return max(bars, step(length(p), 0.28));
        }
        return max(step(length(p), 0.45), 1.0 - step(length(p), 0.49));
      }

      void main() {
        vec2 fragCoord = vUv * uResolution;
        vec2 step = 1.0 / uResolution;

        // Method 3: Cyber Glow with Stylized Anime NPR Outlines
        if (uMethod == 3) {
          vec4 center = texture(tDiffuse, vUv);
          if (center.a <= 0.001) {
            outColor = vec4(0.0);
            return;
          }

          // Sobel edge detection
          float lum[9];
          float alpha[9];
          int idx = 0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec4 s = texture(tDiffuse, vUv + vec2(float(x), float(y)) * step * 1.2);
              lum[idx] = dot(s.rgb, vec3(0.299, 0.587, 0.114));
              alpha[idx] = s.a;
              idx++;
            }
          }
          float gx = (lum[0] + 2.0*lum[3] + lum[6]) - (lum[2] + 2.0*lum[5] + lum[8]);
          float gy = (lum[0] + 2.0*lum[1] + lum[2]) - (lum[6] + 2.0*lum[7] + lum[8]);
          float edge = sqrt(gx*gx + gy*gy);

          float agx = (alpha[0] + 2.0*alpha[3] + alpha[6]) - (alpha[2] + 2.0*alpha[5] + alpha[8]);
          float agy = (alpha[0] + 2.0*alpha[1] + alpha[2]) - (alpha[6] + 2.0*alpha[7] + alpha[8]);
          float aEdge = sqrt(agx*agx + agy*agy);

          vec3 color = toSrgb(center.rgb);
          if (aEdge > 0.4 || edge > 0.18) {
            color = mix(color, vec3(0.10, 0.06, 0.14), 0.75);
          }
          float l = dot(color, vec3(0.299, 0.587, 0.114));
          color = mix(color, uAccentColor, pow(1.0 - clamp(l, 0.0, 1.0), 3.0) * 0.35);

          outColor = vec4(color * center.a, center.a);
          return;
        }

        // Methods 0, 1, 2: Dither modes
        float pixelSize = max(uGridSize * max(uPixelSizeRatio, 1.0), 1.0);
        vec2 pixelUv = (floor(fragCoord / pixelSize) + 0.5) * pixelSize / uResolution;
        vec4 tex = texture(tDiffuse, pixelUv);
        if (tex.a <= 0.01) {
          outColor = vec4(0.0);
          return;
        }

        vec3 color = toSrgb(tex.rgb);
        float level = dot(color, vec3(0.299, 0.587, 0.114));
        vec2 cellCoord = fragCoord / uGridSize;
        vec2 cellFract = fract(cellCoord);
        bool lit = false;

        if (uMethod == 0) {
          lit = level >= bayerThreshold(cellCoord);
        } else if (uMethod == 1) {
          lit = level >= halftoneThreshold(cellCoord);
        } else if (uMethod == 2) {
          lit = asciiPattern(cellFract, level) > 0.5;
        }

        vec3 finalColor = lit ? color : vec3(0.0);
        if (lit && level > 0.75) {
          finalColor = mix(finalColor, uAccentColor, 0.35);
        }
        outColor = vec4(finalColor * tex.a, tex.a);
      }
    \`;

    const postMat = new THREE.ShaderMaterial({
      vertexShader: \`
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      \`,
      fragmentShader: postFrag,
      uniforms: {
        tDiffuse: { value: renderTarget.texture },
        uResolution: { value: new THREE.Vector2(1400, 960) },
        uAccentColor: { value: new THREE.Color(0x00f0ff) },
        uMethod: { value: 3 },
        uGridSize: { value: 4.0 },
        uPixelSizeRatio: { value: 1.0 }
      },
      glslVersion: THREE.GLSL3
    });

    const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
    postScene.add(postQuad);

    window.setMethod = (m) => {
      postMat.uniforms.uMethod.value = m;
      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCamera);
    };

    const loader = new GLTFLoader();
    loader.load("assets/nova_model.glb", (gltf) => {
      const root = new THREE.Group();
      const model = gltf.scene;

      model.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const newMats = mats.map((m) => {
            const name = m.name || '';
            const isEye = name.includes('Mat_1_') || name.includes('Mat_2_');

            const toonMat = new THREE.MeshToonMaterial({
              map: m.map,
              gradientMap: toonRamp,
              transparent: m.transparent || false,
              alphaTest: m.alphaTest || 0.0,
              side: THREE.DoubleSide,
            });

            if (isEye) {
              toonMat.emissive = new THREE.Color(0x331144);
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

      window.setMethod(3); // Glow
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

server.listen(9011, async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 480, deviceScaleFactor: 2 });
    await page.goto('http://localhost:9011/');
    await page.waitForFunction(() => window.renderReady, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 400));

    // Glow
    await page.evaluate(() => window.setMethod(3));
    await page.screenshot({ path: path.join(artifactDir, 'npr_glow.png') });

    // Bayer
    await page.evaluate(() => window.setMethod(0));
    await page.screenshot({ path: path.join(artifactDir, 'npr_bayer.png') });

    // Halftone
    await page.evaluate(() => window.setMethod(1));
    await page.screenshot({ path: path.join(artifactDir, 'npr_halftone.png') });

    // ASCII
    await page.evaluate(() => window.setMethod(2));
    await page.screenshot({ path: path.join(artifactDir, 'npr_ascii.png') });

    console.log('ALL 4 NPR MODES CAPTURED');
    await browser.close();
  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
