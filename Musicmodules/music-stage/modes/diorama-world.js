(function (global) {
    'use strict';
    const { clamp, seededRandom } = global.MusicStageRuntime;
    const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
    // A pole stands between the train and whatever it looks at. Each one goes
    // on the side away from the next roadside screen, so it never crosses a lyric.
    const poleSide = (track, address, fallback = -1) => {
        const encounters = track?.encounters || [];
        let lo = 0, hi = encounters.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (encounters[mid].address - 10 < address) lo = mid + 1;
            else hi = mid;
        }
        const next = encounters[lo];
        return next && next.address - address < 140 ? -next.side : fallback;
    };
    // Whether something `lateral` metres off the track at `address` comes
    // between the train and a lyric screen on that side while the screen is
    // being read. Screens are 16 m wide; the camera reads from startDistance
    // to endDistance.
    const inSight = (track, address, lateral, side, margin = 3) => {
        for (const screen of track?.encounters || []) {
            if (screen.side !== side || Math.abs(screen.address - address) > 160) continue;
            const k = lateral / screen.lateral;
            const first = (address - k * (screen.address + 9)) / (1 - k);
            const last = (address - k * (screen.address - 9)) / (1 - k);
            if (first - margin <= screen.endDistance + 2 && last + margin >= screen.startDistance - 2) return true;
        }
        return false;
    };
    // Anything lower than the sight line to a screen's bottom row is harmless.
    const SIGHT_FLOOR = 2.35;
    const POLE_OFFSET = 3.4, LAMP_OFFSET = 2.55, LAMP_Y = 5.8, CONTACT_Y = 5.72;
    const create = (T, scene) => {
        const root = new T.Group();
        scene.add(root);
        const geometries = new Set(), materials = new Set();
        const geometry = g => { geometries.add(g); return g; };
        const material = m => { materials.add(m); return m; };
        const box = geometry(new T.BoxGeometry(1, 1, 1));
        const steel = material(new T.MeshStandardMaterial({ color: '#626b76', metalness: 0.8, roughness: 0.28 }));
        const timber = material(new T.MeshStandardMaterial({ color: '#292d32', roughness: 0.95 }));
        const concrete = material(new T.MeshStandardMaterial({ color: '#444852', roughness: 0.8 }));
        const lampMaterial = material(new T.MeshBasicMaterial({ color: '#ffd994' }));
        const coldLampMaterial = material(new T.MeshBasicMaterial({ color: '#9fe6d6' }));
        // Several boxes fused into one shape, so a profile still costs one instance.
        const fused = parts => {
            const positions = [], normals = [], indices = [];
            for (const [sx, sy, sz, x, y, z] of parts) {
                const part = new T.BoxGeometry(sx, sy, sz).translate(x, y, z);
                const base = positions.length / 3;
                positions.push(...part.attributes.position.array);
                normals.push(...part.attributes.normal.array);
                for (const index of part.index.array) indices.push(index + base);
                part.dispose();
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
            shape.setIndex(indices);
            return geometry(shape);
        };
        const instances = (mat, count, shape = box) => {
            const mesh = new T.InstancedMesh(shape, mat, count);
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.frustumCulled = false;
            mesh.count = 0;
            root.add(mesh);
            return mesh;
        };
        // Flat-bottom rail: head, web and foot. Sleepers carry their tie plates.
        const rails = instances(steel, 320, fused([
            [0.07, 0.05, 1, 0, 0.055, 0], [0.024, 0.09, 1, 0, 0, 0], [0.15, 0.024, 1, 0, -0.055, 0]]));
        const sleepers = instances(timber, 400, fused([
            [2.4, 0.16, 0.24, 0, 0, 0], [0.34, 0.03, 0.2, -0.7175, 0.09, 0], [0.34, 0.03, 0.2, 0.7175, 0.09, 0]]));
        // Tapered octagonal column: catenary masts, lamp posts, signals.
        const masts = instances(steel, 72, geometry(new T.CylinderGeometry(0.065, 0.115, 1, 8)));
        // Everything else is drawn from one pool per material, whatever it
        // depicts, so richer scenery does not cost more draw calls.
        const steelParts = instances(steel, 720);
        const concreteParts = instances(concrete, 320);
        const timberParts = instances(timber, 240);
        const glowParts = instances(lampMaterial, 128);
        const coldGlowParts = instances(coldLampMaterial, 64);
        const sceneryPools = [masts, steelParts, concreteParts, timberParts, glowParts, coldGlowParts];
        Object.entries({ rails, sleepers, masts, steelParts, concreteParts, timberParts, glowParts, coldGlowParts })
            .forEach(([name, mesh]) => { mesh.name = name; });
        let stationTypes = [];
        const wirePositions = new Float32Array(40 * 20 * 6);
        const wireGeometry = geometry(new T.BufferGeometry());
        wireGeometry.setAttribute('position', new T.BufferAttribute(wirePositions, 3).setUsage(T.DynamicDrawUsage));
        const wireMaterial = material(new T.LineBasicMaterial({ color: '#60717d', transparent: true,
            opacity: 0.42, depthWrite: false }));
        const wires = new T.LineSegments(wireGeometry, wireMaterial);
        wires.frustumCulled = false;
        root.add(wires);
        const ridgePositions = [];
        for (let i = 0; i < 192; i++) {
            const a = i / 192 * Math.PI * 2, b = (i + 1) / 192 * Math.PI * 2;
            const elevation = angle => 4 + 9 * Math.pow(0.5 + 0.5 * Math.sin(angle * 7 + 1), 3)
                + 3 * Math.sin(angle * 19);
            const ax = Math.cos(a) * 650, az = Math.sin(a) * 650;
            const bx = Math.cos(b) * 650, bz = Math.sin(b) * 650;
            ridgePositions.push(ax, -2, az, bx, -2, bz, ax, elevation(a), az,
                bx, -2, bz, bx, elevation(b), bz, ax, elevation(a), az);
        }
        const ridgeGeometry = geometry(new T.BufferGeometry());
        ridgeGeometry.setAttribute('position', new T.Float32BufferAttribute(ridgePositions, 3));
        const ridgeMaterial = material(new T.MeshBasicMaterial({ color: '#1c2935', side: T.DoubleSide, fog: false }));
        const ridge = new T.Mesh(ridgeGeometry, ridgeMaterial);
        root.add(ridge);
        const dummy = new T.Object3D();
        const scratch = new T.Color(), white = new T.Color('#ffffff');
        // Local axes: x across the track, y up, z along it. Roll leans a part
        // across the track, pitch tips it along the track.
        const place = (mesh, index, track, s, lateral, y, sx, sy, sz, roll = 0, pitch = 0) => {
            const f = track.at(s);
            dummy.position.set(f.position.x + f.right.x * lateral, y, f.position.z + f.right.z * lateral);
            dummy.rotation.set(pitch, -f.yaw, roll, 'YXZ');
            dummy.scale.set(sx, sy, sz);
            dummy.updateMatrix();
            mesh.setMatrixAt(index, dummy.matrix);
        };
        const hemisphere = new T.HemisphereLight('#819ab6', '#14191e', 0.65);
        const moonLight = new T.DirectionalLight('#b1cee9', 1.5);
        moonLight.position.set(-70, 100, -140);
        root.add(hemisphere, moonLight);
        const lights = Array.from({ length: 2 }, () => {
            const light = new T.PointLight('#ffd28c', 22, 22, 2);
            root.add(light);
            return light;
        });
        // The train itself is never seen; its headlight on the rails ahead is.
        const headlight = new T.PointLight('#ffe9c4', 0, 16, 2);
        root.add(headlight);
        const skyMat = material(new T.ShaderMaterial({
            side: T.BackSide, depthWrite: false,
            uniforms: {
                night: { value: new T.Color('#080f20') },
                horizon: { value: new T.Color('#415266') },
                cold: { value: new T.Color('#8bbfc8') },
                open: { value: 0 },
                // Fixed celestial moon direction, identical to the moon mesh offset.
                moonDir: { value: new T.Vector3(-210, 300, -420).normalize() },
                moonTint: { value: new T.Color('#cbdde8') },
                glowTint: { value: new T.Color('#415266') },
                moonGlow: { value: 1 },
                horizonGlow: { value: 1 },
                accent: { value: 0 },
                auroraActive: { value: 1.0 },
                auroraTime: { value: 0.0 },
                auroraRhythm: { value: 0.0 },
                auroraHeading: { value: 0.0 },
                auroraGreen: { value: new T.Color('#22f09d') },
                auroraViolet: { value: new T.Color('#9d4edd') }
            },
            vertexShader: `varying vec3 ray;
                void main(){ray=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 ray;uniform vec3 night,horizon,cold;uniform float open;
                uniform vec3 moonDir,moonTint,glowTint;uniform float moonGlow,horizonGlow,accent;
                uniform float auroraActive, auroraTime, auroraRhythm, auroraHeading;
                uniform vec3 auroraGreen, auroraViolet;
                float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                    mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                    mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
                void main(){
                    vec3 d=normalize(ray);
                    float h=pow(max(d.y,0.0),0.45);
                    vec3 c=mix(horizon,night,clamp(h*1.7,0.0,1.0));
                    float band=exp(-pow(dot(d,normalize(vec3(0.35,0.8,0.48)))-0.18,2.0)*90.0);
                    float cloud=noise(d*12.0)*0.6+noise(d*33.0)*0.3+noise(d*91.0)*0.1;
                    c+=cold*band*pow(cloud,3.0)*(0.12+open*0.22);
                    // Moonlight scattering: a tight corona plus a wide, faint veil.
                    float md=max(dot(d,moonDir),0.0);
                    float corona=pow(md,220.0)*0.55+pow(md,48.0)*0.16+pow(md,7.0)*0.05;
                    c+=moonTint*corona*moonGlow*(0.85+cloud*0.3)*(1.0+accent*0.4);
                    // Residual light pooled at the horizon (distant towns, last dusk).
                    float rim=exp(-abs(d.y)*16.0)*(0.6+0.4*noise(vec3(d.xz*4.0,1.0)));
                    c+=glowTint*rim*horizonGlow*(0.1+open*0.08);
                    // Angular curtains share the same coordinates as their visibility mask.
                    // Fixed celestial heading, calibrated once to the opening shot, not a HUD.
                    if (auroraActive > 0.001 && d.y > 0.02) {
                        float angle = atan(d.x, -d.z) - auroraHeading;
                        float u = atan(sin(angle), cos(angle));
                        float elevation = asin(clamp(d.y, -1.0, 1.0));
                        float sector = smoothstep(-0.85, -0.48, u)
                                     * (1.0 - smoothstep(0.16, 0.48, u));
                        float drift = auroraTime * 0.065;
                        vec3 emission = vec3(0.0);
                        for (int layer = 0; layer < 3; layer++) {
                            float k = float(layer);
                            float fold = sin(u * 8.0 + drift + k * 1.7)
                                       + 0.35 * sin(u * 19.0 - drift * 0.7 + k);
                            float base = 0.13 + k * 0.045 + fold * 0.025;
                            float altitude = elevation - base;
                            float height = 0.17 + 0.045 * sin(u * 6.0 + k + drift * 0.4);
                            float v = max(0.0, altitude) / height;
                            float filament = noise(vec3(u * 95.0 + fold * 1.4,
                                drift * 0.4 + k * 5.0, v * 0.18));
                            float fine = pow(0.5 + 0.5 * sin(u * 310.0 + fold * 6.0
                                + drift * 1.2 + v * 0.7), 6.0);
                            float veil = smoothstep(-0.012, 0.015, altitude)
                                * exp(-v * 2.7) * (0.22 + filament * 0.65 + fine * 0.28);
                            float hem = exp(-pow(altitude / 0.012, 2.0)) * 0.22;
                            vec3 spectral = mix(auroraGreen, auroraViolet,
                                smoothstep(0.25, 1.1, v));
                            emission += spectral * (veil + hem) / (1.0 + k * 0.65);
                        }
                        c += emission * sector * auroraActive
                            * (0.75 + auroraRhythm * 0.2 + accent * 0.55);
                    }
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const sky = new T.Mesh(geometry(new T.SphereGeometry(850, 32, 20)), skyMat);
        sky.renderOrder = -100;
        root.add(sky);
        const random = seededRandom('last-train-fixed-sky');
        const positions = [], colors = [], sizes = [], phases = [];
        // Lights of towns on the far shore come first in the buffer, so every
        // quality level keeps them. They sit in front of the ridge, low enough
        // to lay their own reflections on the water.
        const shore = seededRandom('last-train-far-shore');
        for (let town = 0; town < 7; town++) {
            const bearing = shore() * Math.PI * 2, spread = 0.05 + shore() * 0.09;
            for (let i = 0, count = 18 + Math.floor(shore() * 30); i < count; i++) {
                const angle = bearing + (shore() + shore() - 1) * spread;
                const radius = 600 + shore() * 30, tall = shore() > 0.93;
                positions.push(Math.cos(angle) * radius, tall ? 9 + shore() * 9 : 0.8 + shore() * shore() * 5,
                    Math.sin(angle) * radius);
                const brightness = 0.45 + shore() * 0.55, warm = shore();
                colors.push(brightness, brightness * (0.7 + warm * 0.2), brightness * (0.34 + warm * 0.4));
                sizes.push(1.5 + shore() * 1.5);
                phases.push(shore());
            }
        }
        const townLights = positions.length / 3;
        for (let i = 0; i < 8000; i++) {
            const y = random(), angle = random() * Math.PI * 2;
            const r = Math.sqrt(1 - y * y);
            positions.push(Math.cos(angle) * r * 780, y * 780, Math.sin(angle) * r * 780);
            const magnitude = Math.pow(random(), 5);
            const brightness = 0.25 + magnitude * 0.75;
            // Stellar temperature: most white-blue, a few warm giants.
            const warm = random() > 0.9 ? 1 : 0;
            colors.push(brightness * (0.86 + warm * 0.14), brightness * (0.93 - warm * 0.05),
                brightness * (1 - warm * 0.22));
            sizes.push(1.1 + magnitude * 2.8);
            phases.push(random());
        }
        const starGeo = geometry(new T.BufferGeometry());
        starGeo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        starGeo.setAttribute('starColor', new T.Float32BufferAttribute(colors, 3));
        starGeo.setAttribute('starSize', new T.Float32BufferAttribute(sizes, 1));
        starGeo.setAttribute('phase', new T.Float32BufferAttribute(phases, 1));
        // Soft round stars; twinkle is a pure function of the playback clock.
        const starMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: {
                time: { value: 0 }, opacity: { value: 0.8 }, twinkle: { value: 1 }, accent: { value: 0 },
                pixelRatio: { value: 1 }, tint: { value: new T.Color('#ffffff') }
            },
            vertexShader: `attribute vec3 starColor;attribute float starSize,phase;
                uniform float time,opacity,twinkle,pixelRatio,accent;
                varying vec3 vColor;varying float vAlpha;
                void main(){
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
                    float tw=0.5+0.5*sin(time*(0.6+phase*2.1)+phase*43.0);
                    float slow=0.5+0.5*sin(time*0.23+phase*17.0);
                    vColor=starColor*mix(1.0,0.5+0.5*tw*slow+0.25,twinkle);
                    // Chapter accent: stars surge in as a chorus opens.
                    vAlpha=opacity*(1.0+accent*0.45);
                    gl_PointSize=starSize*pixelRatio*(0.9+0.25*tw*twinkle);
                }`,
            fragmentShader: `uniform vec3 tint;varying vec3 vColor;varying float vAlpha;
                void main(){
                    vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);
                    if(r>1.0)discard;
                    float core=exp(-r*7.0);float halo=exp(-r*2.4)*0.32;
                    float a=(core+halo)*vAlpha;
                    gl_FragColor=vec4(vColor*tint*(core*1.25+halo),a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        starMat.opacity = 0.8;
        const stars = new T.Points(starGeo, starMat);
        root.add(stars);
        // A gibbous moon with maria, a few ray craters and limb darkening. It
        // travels with the camera, so the viewing direction is a constant.
        const moonMat = material(new T.ShaderMaterial({
            uniforms: { color: { value: new T.Color('#cbdde8') },
                toViewer: { value: new T.Vector3(210, -300, 420).normalize() },
                sun: { value: new T.Vector3(210, -300, 420).normalize()
                    .add(new T.Vector3(0.62, 0.34, -0.2)).normalize() } },
            vertexShader: `varying vec3 surface;
                void main(){surface=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 surface;uniform vec3 color,toViewer,sun;
                float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                    mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                    mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
                float crater(vec3 p,vec3 at,float size){
                    float d=distance(p,normalize(at))/size;
                    return smoothstep(1.0,0.75,d)*-0.16+exp(-pow((d-1.0)*5.0,2.0))*0.2
                        +exp(-d*0.9)*0.12*step(1.0,d);}
                void main(){
                    vec3 p=normalize(surface);
                    float seas=smoothstep(0.46,0.66,noise(p*2.1+3.7)*0.62+noise(p*4.6)*0.38);
                    float albedo=0.96-seas*0.34+(noise(p*11.0)-0.5)*0.14+(noise(p*27.0)-0.5)*0.07;
                    albedo+=crater(p,vec3(0.25,-0.55,0.8),0.12)+crater(p,vec3(-0.2,0.1,0.95),0.08)
                        +crater(p,vec3(0.55,0.2,0.75),0.06)+crater(p,vec3(-0.5,-0.4,0.7),0.1)
                        +crater(p,vec3(0.1,0.6,0.7),0.07);
                    float limb=0.66+0.34*pow(max(dot(p,toViewer),0.0),0.55);
                    float lit=smoothstep(-0.12,0.26,dot(p,sun));
                    gl_FragColor=vec4(color*albedo*limb*mix(0.05,1.0,lit),1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const moonColor = moonMat.uniforms.color.value;
        const moon = new T.Mesh(geometry(new T.SphereGeometry(20, 32, 24)), moonMat);
        root.add(moon);
        const target = new T.WebGLRenderTarget(512, 320, { depthBuffer: true });
        const mirror = new T.PerspectiveCamera();
        const textureMatrix = new T.Matrix4();
        const waterMat = material(new T.ShaderMaterial({
            depthWrite: true, transparent: false,
            uniforms: { reflection: { value: target.texture }, textureMatrix: { value: textureMatrix },
                time: { value: 0 }, strength: { value: 1 }, tint: { value: new T.Color('#10212d') },
                energy: { value: 0 },
                moonDir: { value: new T.Vector3(-210, 300, -420).normalize() },
                moonTint: { value: new T.Color('#cbdde8') }, glitter: { value: 1 },
                fogTint: { value: new T.Color('#415266') }, fogDensity: { value: 0.008 },
                lampTint: { value: new T.Color('#ffd28c') },
                lampPos: { value: Array.from({ length: 4 }, () => new T.Vector3()) },
                lampPower: { value: new Float32Array(4) } },
            vertexShader: `uniform mat4 textureMatrix;varying vec4 reflected;varying vec3 world;
                void main(){vec4 p=modelMatrix*vec4(position,1.0);world=p.xyz;reflected=textureMatrix*p;
                    gl_Position=projectionMatrix*viewMatrix*p;}`,
            fragmentShader: `uniform sampler2D reflection;uniform float time,strength,energy,glitter,fogDensity;
                uniform vec3 tint,moonDir,moonTint,fogTint,lampTint;
                uniform vec3 lampPos[4];uniform float lampPower[4];
                varying vec4 reflected;varying vec3 world;
                float h21(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
                void main(){
                    vec3 toCam=cameraPosition-world;float dist=length(toCam);vec3 v=toCam/max(dist,0.001);
                    // Analytic ripple normal: two swells and fine chop, damped with distance.
                    float damp=1.0/(1.0+dist*0.02);
                    vec2 g=vec2(0.0);
                    g+=vec2(0.65,0.0)*cos(world.z*0.65+world.x*0.12+time*0.45)*0.05;
                    g+=vec2(0.0,0.48)*-sin(world.x*0.48-time*0.32)*0.05;
                    g+=vec2(1.9,1.3)*cos(world.x*1.9+world.z*1.3+time*1.1)*0.018;
                    g+=vec2(-1.4,2.3)*cos(-world.x*1.4+world.z*2.3-time*0.9)*0.014;
                    g*=damp*(1.0+energy*0.6);
                    vec3 n=normalize(vec3(-g.x,1.0,-g.y));
                    vec2 uv=reflected.xy/max(reflected.w,0.001)+n.xz*(0.018+energy*0.008);
                    float valid=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0)*step(0.0,reflected.w);
                    vec3 r=texture2D(reflection,clamp(uv,0.001,0.999)).rgb;
                    // Schlick Fresnel for water (F0 ~ 0.02), lifted so the mirror reads at night.
                    float cosT=clamp(dot(n,v),0.0,1.0);
                    float f=0.1+0.9*(0.02+0.98*pow(1.0-cosT,5.0));
                    f=max(f,0.12+0.75*pow(1.0-abs(v.y),3.0));
                    vec3 c=mix(tint,r,clamp(f*strength*valid,0.0,0.94));
                    // Broken moon path: tight specular lobe sparked by a flickering facet grid.
                    vec3 refl=reflect(-v,n);
                    float lobe=pow(max(dot(refl,moonDir),0.0),260.0);
                    float wide=pow(max(dot(refl,moonDir),0.0),28.0)*0.08;
                    vec2 cell=floor(world.xz*vec2(2.2,1.1));
                    float spark=step(0.72,h21(cell+floor(time*3.0+h21(cell)*7.0)));
                    c+=moonTint*(lobe*(0.6+spark*2.4)+wide)*glitter*strength;
                    // Vertical lamp streaks along the camera-lamp bearing.
                    for(int i=0;i<4;i++){
                        if(lampPower[i]<=0.0)continue;
                        vec2 cam=cameraPosition.xz;vec2 L=lampPos[i].xz-cam;float ld=length(L);
                        if(ld<0.5)continue;
                        vec2 dir=L/ld;vec2 rel=world.xz-cam;
                        float along=dot(rel,dir);float across=abs(rel.x*dir.y-rel.y*dir.x);
                        float width=0.18+ld*0.012;
                        float band=exp(-across*across/(width*width))
                            *smoothstep(ld*0.35,ld*0.8,along)*(1.0-smoothstep(ld*0.98,ld*1.08,along));
                        float shimmer=0.55+0.45*sin(along*5.0-time*2.2+n.x*20.0);
                        c+=lampTint*band*shimmer*lampPower[i]*0.55*strength;
                    }
                    // Match scene FogExp2 so the far plane melts into the horizon.
                    float fog=1.0-exp(-fogDensity*fogDensity*dist*dist);
                    c=mix(c,fogTint,clamp(fog,0.0,1.0));
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const water = new T.Mesh(geometry(new T.PlaneGeometry(1800, 1800)), waterMat);
        water.rotation.x = -Math.PI / 2;
        root.add(water);
        // Additive lamp halos: one soft point per lit lamp, reflected by the mirror pass too.
        const haloPositions = new Float32Array(48 * 3);
        const haloGeometry = geometry(new T.BufferGeometry());
        haloGeometry.setAttribute('position', new T.BufferAttribute(haloPositions, 3).setUsage(T.DynamicDrawUsage));
        haloGeometry.setDrawRange(0, 0);
        const haloMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { color: { value: new T.Color('#ffd28c') }, intensity: { value: 1 },
                size: { value: 1.6 }, pixelRatio: { value: 1 } },
            vertexShader: `uniform float size,pixelRatio;varying float vFade;
                void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
                    float d=max(1.0,-mv.z);
                    gl_PointSize=clamp(size*pixelRatio*300.0/d,2.0,180.0);
                    vFade=1.0-smoothstep(70.0,150.0,d);}`,
            fragmentShader: `uniform vec3 color;uniform float intensity;varying float vFade;
                void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);
                    if(r>1.0)discard;
                    float core=exp(-r*22.0);float glow=exp(-r*4.5)*0.32;
                    float a=(core+glow)*intensity*vFade;
                    gl_FragColor=vec4(color*a,a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const halos = new T.Points(haloGeometry, haloMat);
        halos.frustumCulled = false;
        root.add(halos);
        // Cabin window foreground (layer 1: viewer only, never mirrored).
        const cabin = new T.Group();
        cabin.renderOrder = 1000;
        const panel = geometry(new T.PlaneGeometry(1, 1));
        const frameMat = material(new T.MeshBasicMaterial({ color: '#07090c', transparent: true,
            depthTest: false, depthWrite: false, fog: false }));
        const rimMat = material(new T.MeshBasicMaterial({ color: '#ffd28c', transparent: true,
            depthTest: false, depthWrite: false, fog: false, blending: T.AdditiveBlending }));
        const sheenMat = material(new T.ShaderMaterial({
            transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { color: { value: new T.Color('#ffd28c') }, opacity: { value: 0 } },
            vertexShader: `varying vec2 vUv;void main(){vUv=uv;
                gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            // Faint reflection of the lit carriage in the glass, pooled at the sill.
            fragmentShader: `uniform vec3 color;uniform float opacity;varying vec2 vUv;
                void main(){float a=(pow(1.0-vUv.y,3.0)*0.8+pow(abs(vUv.x-0.5)*2.0,4.0)*0.3)*opacity;
                    gl_FragColor=vec4(color*a,a);}`
        }));
        const cabinPart = mat => {
            const mesh = new T.Mesh(panel, mat);
            mesh.layers.set(1);
            mesh.renderOrder = 1000 + (mat === frameMat ? 2 : mat === rimMat ? 3 : 1);
            mesh.frustumCulled = false;
            cabin.add(mesh);
            return mesh;
        };
        const sheen = cabinPart(sheenMat);
        const pillars = [cabinPart(frameMat), cabinPart(frameMat)];
        const header = cabinPart(frameMat), sill = cabinPart(frameMat);
        const rims = [cabinPart(rimMat), cabinPart(rimMat)];
        root.add(cabin);
        let cabinWeight = 0;
        const updateCabin = (camera, pose, track, aspect, config) => {
            const tuning = config.modes?.diorama || {};
            const f = track.at(pose.distance);
            const delta = Math.abs(Math.atan2(Math.sin(pose.yaw - f.yaw), Math.cos(pose.yaw - f.yaw)));
            const gaze = smooth((delta - 0.22) / 0.4);
            const inside = 1 - smooth((pose.state.openness - 0.45) / 0.3);
            cabinWeight = tuning.cabinFrame === false ? 0
                : gaze * inside * (1 - clamp(pose.finale ?? 0)) * (1 - clamp(pose.eventFocus?.weight ?? 0));
            cabin.visible = cabinWeight > 0.002;
            if (!cabin.visible) return;
            cabin.position.copy(camera.position);
            cabin.quaternion.copy(camera.quaternion);
            const z = -0.5;
            const h = Math.tan(camera.fov * Math.PI / 360) * -z, w = h * Math.max(0.35, aspect);
            // Slide in from beyond the frame edges; the reading centre stays clear.
            const pw = Math.min(w * 0.12, h * 0.16), bh = h * 0.1;
            const e = smooth(cabinWeight);
            pillars.forEach((mesh, i) => {
                const s = i ? 1 : -1;
                mesh.scale.set(pw, h * 2.4, 1);
                mesh.position.set(s * (w + pw / 2 - pw * e), 0, z);
                rims[i].scale.set(pw * 0.06, h * 2.2, 1);
                rims[i].position.set(s * (w - pw * e + pw * 0.03), 0, z);
            });
            header.scale.set(w * 2.4, bh, 1);
            header.position.set(0, h + bh / 2 - bh * e, z);
            sill.scale.set(w * 2.4, bh * 1.3, 1);
            sill.position.set(0, -h - bh * 0.65 + bh * 1.3 * e, z);
            sheen.scale.set(w * 2, h * 2, 1);
            sheen.position.set(0, 0, z);
            frameMat.opacity = e;
            rimMat.opacity = e * 0.35;
            rimMat.color.copy(haloMat.uniforms.color.value);
            sheenMat.uniforms.color.value.copy(haloMat.uniforms.color.value);
            sheenMat.uniforms.opacity.value = e * (palBase?.light ? 0.03 : 0.07);
        };
        let dead = false, reflectionEnabled = true, liveStations = 0, quality = 'standard';
        let trackKey = '', sceneryKey = '', instanceTrack = null, lightAnchors = [], instanceRebuilds = 0;
        let stationInstances = 0;
        let auroraTrack = null;
        let baseStarOpacity = 0.8;
        // Palette-derived baselines; chapter warmth modulates around them each frame.
        let palBase = null, liveWarmth = 0.5, liveAccent = 0, haloBase = 1;
        const updateLights = (track, s, saving, audio) => {
            lightAnchors.sort((a, b) => Math.abs(a.address - s) - Math.abs(b.address - s));
            for (let i = 0; i < lights.length; i++) {
                const anchor = lightAnchors[i];
                const f = track.at(anchor?.address ?? s);
                const side = anchor?.side ?? -1;
                lights[i].position.set(f.position.x + f.right.x * LAMP_OFFSET * side, (anchor?.y ?? LAMP_Y) - 0.2,
                    f.position.z + f.right.z * LAMP_OFFSET * side);
                lights[i].intensity = anchor && !saving ? 24 * (1 + clamp(audio.impact) * 0.12) : 0;
            }
            // Water streaks only for lamps still ahead of the camera.
            const ahead = lightAnchors.filter(a => a.address > s + 2);
            for (let i = 0; i < 4; i++) {
                const anchor = ahead[i];
                const power = anchor ? Math.exp(-(anchor.address - s) / 70) : 0;
                if (anchor) {
                    const f = track.at(anchor.address);
                    waterMat.uniforms.lampPos.value[i].set(f.position.x + f.right.x * LAMP_OFFSET * anchor.side, anchor.y,
                        f.position.z + f.right.z * LAMP_OFFSET * anchor.side);
                }
                waterMat.uniforms.lampPower.value[i] = saving ? 0 : power;
            }
        };
        const setPalette = (palette = {}) => {
            const light = Boolean(palette.light);
            const background = new T.Color(palette.background || '#171a1d');
            const surface = new T.Color(palette.surface || palette.background || '#20252a');
            const deep = new T.Color(palette.deep || palette.background || '#171a1d');
            const ink = new T.Color(palette.ink || '#f2f0e9');
            const muted = new T.Color(palette.muted || '#a7afb1');
            const secondary = new T.Color(palette.secondary || '#76bfae');
            const tertiary = new T.Color(palette.tertiary || palette.secondary || '#76bfae');
            const emission = new T.Color(palette.emission || palette.accent || '#f2a900');
            const structure = new T.Color(palette.material || palette.surface || '#2a3035');
            const border = new T.Color(palette.border || palette.muted || '#3b4449');
            // Separate substrate, atmospheric fill and luminous accents.
            skyMat.uniforms.night.value.copy(deep).lerp(tertiary, light ? 0.025 : 0.045)
                .multiplyScalar(light ? 0.85 : 0.42);
            skyMat.uniforms.horizon.value.copy(background).lerp(muted, light ? 0.08 : 0.2)
                .lerp(tertiary, light ? 0.035 : 0.06);
            skyMat.uniforms.cold.value.copy(tertiary);
            // Theme-native spectral pair; keep luminance bounded, retaining hue.
            const luminous = color => {
                const hsl = color.getHSL({});
                return color.setHSL(hsl.h, clamp(hsl.s, 0.25, 0.88), clamp(hsl.l, 0.42, 0.66));
            };
            skyMat.uniforms.auroraGreen.value.copy(luminous(secondary.clone()));
            skyMat.uniforms.auroraViolet.value.copy(luminous(emission.clone().lerp(tertiary, 0.12)));
            waterMat.uniforms.tint.value.copy(deep).lerp(secondary, light ? 0.04 : 0.025)
                .multiplyScalar(light ? 0.78 : 0.48);
            scene.fog = new T.FogExp2(skyMat.uniforms.horizon.value, 0.008);
            waterMat.uniforms.fogTint.value.copy(skyMat.uniforms.horizon.value);
            waterMat.uniforms.moonTint.value.copy(light ? surface : ink).lerp(emission, 0.08);
            waterMat.uniforms.glitter.value = light ? 0.25 : 1;
            waterMat.uniforms.lampTint.value.copy(emission);
            steel.color.copy(structure).lerp(muted, light ? 0.3 : 0.5);
            concrete.color.copy(surface).lerp(border, light ? 0.2 : 0.45);
            timber.color.copy(deep).lerp(structure, 0.55).lerp(emission, 0.025);
            hemisphere.color.copy(light ? surface : muted).lerp(tertiary, 0.12);
            hemisphere.groundColor.copy(deep);
            hemisphere.intensity = light ? 1.8 : 0.65;
            moonLight.color.copy(light ? surface : ink).lerp(tertiary, 0.12);
            moonColor.copy(light ? surface : ink).lerp(emission, 0.08);
            lampMaterial.color.copy(emission);
            coldLampMaterial.color.copy(luminous(secondary.clone()));
            lights.forEach(l => l.color.copy(emission));
            starMat.uniforms.tint.value.copy(light ? surface : ink).lerp(tertiary, 0.08);
            baseStarOpacity = light ? 0.15 : 0.8;
            starMat.opacity = baseStarOpacity;
            starMat.uniforms.opacity.value = baseStarOpacity;
            skyMat.uniforms.moonTint.value.copy(moonColor);
            skyMat.uniforms.moonGlow.value = light ? 0.3 : 1;
            skyMat.uniforms.glowTint.value.copy(emission).lerp(tertiary, 0.5);
            skyMat.uniforms.horizonGlow.value = light ? 0.35 : 1;
            ridgeMaterial.color.copy(skyMat.uniforms.horizon.value).lerp(deep, 0.35)
                .multiplyScalar(light ? 0.8 : 0.55);
            wireMaterial.color.copy(border).lerp(secondary, 0.25);
            haloBase = light ? 0.35 : 1;
            frameMat.color.copy(deep).lerp(structure, 0.35).multiplyScalar(light ? 0.55 : 0.4);
            haloMat.uniforms.color.value.copy(emission);
            palBase = {
                light,
                horizon: skyMat.uniforms.horizon.value.clone(),
                night: skyMat.uniforms.night.value.clone(),
                hemi: hemisphere.color.clone(), hemiIntensity: hemisphere.intensity,
                lamp: emission.clone(), warm: emission.clone(), cold: tertiary.clone()
            };
        };
        // Warmth 0..1 → bias -1 (cold, open chorus) .. +1 (warm, tightening pre-chorus).
        // Everything is re-derived from the palette baseline, so no state accumulates.
        const applyWarmth = (warmth, openness, energy) => {
            if (!palBase) return;
            liveWarmth = warmth;
            const bias = (clamp(warmth) - 0.5) * 2;
            const toward = bias > 0 ? palBase.warm : palBase.cold;
            const amount = Math.abs(bias);
            const k = palBase.light ? 0.5 : 1;
            scratch.copy(palBase.horizon).lerp(toward, amount * 0.12 * k);
            skyMat.uniforms.horizon.value.copy(scratch);
            waterMat.uniforms.fogTint.value.copy(scratch);
            if (scene.fog) {
                scene.fog.color.copy(scratch);
                // Warm passages close in; open chapters and loud passages thin the haze.
                scene.fog.density = 0.008 * (1 + Math.max(0, bias) * 0.18)
                    * (1 - clamp(openness) * 0.18) * (1 - clamp(energy) * 0.06);
                waterMat.uniforms.fogDensity.value = scene.fog.density;
            }
            skyMat.uniforms.night.value.copy(palBase.night).lerp(palBase.cold, Math.max(0, -bias) * 0.05 * k);
            hemisphere.color.copy(palBase.hemi).lerp(toward, amount * 0.16 * k);
            hemisphere.intensity = palBase.hemiIntensity * (1 + Math.max(0, -bias) * 0.12);
            // Warm chapters deepen lamps toward amber, cold ones bleach them slightly.
            scratch.copy(palBase.lamp).lerp(white, Math.max(0, -bias) * 0.22);
            lights.forEach(l => l.color.copy(scratch));
            waterMat.uniforms.lampTint.value.copy(scratch);
            haloMat.uniforms.color.value.copy(scratch);
            lampMaterial.color.copy(scratch).multiplyScalar(1 + Math.max(0, bias) * 0.15);
        };
        const update = (timeline, track, pose, time, config, audio = {}) => {
            if (dead) return;
            const tuning = config.modes?.diorama || {};
            quality = config.quality || 'standard';
            const saving = quality === 'energy-saving';
            const s = pose.distance;
            sky.position.set(pose.position.x, 0, pose.position.z);
            stars.position.copy(sky.position);
            ridge.position.copy(sky.position);
            moon.position.set(sky.position.x - 210, 300, sky.position.z - 420);
            water.position.set(pose.position.x, 0, pose.position.z);
            stars.visible = tuning.showParticles !== false;
            starMat.opacity = baseStarOpacity * (1 - clamp(pose.finale ?? 0));
            starMat.uniforms.opacity.value = starMat.opacity;
            starMat.uniforms.time.value = time;
            starGeo.setDrawRange(0, townLights + (saving ? 1500 : quality === 'ultimate' ? 8000 : 4000));
            skyMat.uniforms.open.value = pose.state.openness;
            const auroraEnabled = tuning.aurora !== false;
            skyMat.uniforms.auroraActive.value = auroraEnabled ? 1.0 : 0.0;
            if (auroraTrack !== track) {
                const opening = global.MusicStageDioramaCamera.pose(timeline, track, 0, tuning);
                skyMat.uniforms.auroraHeading.value = opening.yaw - 0.34;
                auroraTrack = track;
            }
            const motion = clamp(tuning.motionAmount ?? 1, 0, 2) * clamp(config.animationIntensity ?? 1, 0, 2);
            skyMat.uniforms.auroraTime.value = time * motion;
            starMat.uniforms.twinkle.value = clamp(motion);
            // A phrase-length beat envelope, not the fast onset impulse (which flickers).
            const beats = timeline.beats || [];
            const index = global.MusicStageDioramaDirector.upperBound(beats, time) - 1;
            const next = beats[index + 1] ?? ((beats[index] ?? 0) + 0.9);
            const phase = Math.max(0, index) + clamp((time - (beats[index] ?? 0))
                / Math.max(0.08, next - (beats[index] ?? 0)));
            const gain = clamp(tuning.audioReactivity ?? 1, 0, 2);
            skyMat.uniforms.auroraRhythm.value = time === 0 || motion === 0 ? 0
                : (0.5 - 0.5 * Math.cos(phase * Math.PI / 8)) * gain;
            waterMat.uniforms.time.value = time;
            waterMat.uniforms.energy.value = clamp(audio.energy);
            // Analytic chapter swell (seek-exact) plus frozen-on-pause audio response.
            const accent = motion ? (timeline.accentAt?.(time) ?? 0) : 0;
            liveAccent = accent;
            skyMat.uniforms.accent.value = accent;
            starMat.uniforms.accent.value = accent;
            applyWarmth(pose.state.warmth ?? 0.5, pose.state.openness, audio.energy);
            haloMat.uniforms.intensity.value = haloBase * (1 + clamp(audio.impact) * 0.35 + accent * 0.25);
            reflectionEnabled = tuning.waterReflection !== false && (tuning.waterStrength ?? 1) > 0;
            waterMat.uniforms.strength.value = reflectionEnabled ? clamp(tuning.waterStrength ?? 1, 0, 2) : 0;
            const spacing = 16 / clamp(tuning.stationIntensity ?? 1, 0.5, 2);
            headlight.color.copy(palBase?.lamp || white).lerp(white, 0.45);
            headlight.intensity = saving ? 0 : 3 * (palBase?.light ? 0.4 : 1);
            const ahead = track.at(s + 8);
            headlight.position.set(ahead.position.x, 0.7, ahead.position.z);
            // The permanent way slides forward in long strides; scenery is laid
            // out again only when a new pole or station comes into range.
            const nextTrackKey = [Math.floor(s / 12), quality].join(':');
            const nextSceneryKey = [Math.floor(s / spacing), Math.floor(s / 110), quality,
                tuning.narrativeStations, tuning.stationIntensity, tuning.cameraSpeed].join(':');
            if (instanceTrack !== track || nextTrackKey !== trackKey) {
                trackKey = nextTrackKey;
                const stride = Math.floor(s / 12) * 12;
                rails.count = (saving ? 90 : 160) * 2;
                for (let i = 0; i < rails.count / 2; i++) {
                    for (let side = 0; side < 2; side++) {
                        place(rails, i * 2 + side, track, stride - 30 + i * 2, (side ? 1 : -1) * 0.7175,
                            0.335, 1, 1, 2.04);
                    }
                }
                sleepers.count = saving ? 200 : 400;
                for (let i = 0; i < sleepers.count; i++) place(sleepers, i, track, stride - 24 + i * 0.75, 0, 0.18, 1, 1, 1);
                rails.instanceMatrix.needsUpdate = sleepers.instanceMatrix.needsUpdate = true;
            }
            if (instanceTrack === track && nextSceneryKey === sceneryKey) {
                updateLights(track, s, saving, audio);
                return;
            }
            instanceTrack = track; sceneryKey = nextSceneryKey; instanceRebuilds++;
            const enabled = tuning.narrativeStations !== false && (tuning.stationIntensity ?? 1) > 0;
            sceneryPools.forEach(mesh => { mesh.count = 0; });
            const part = (mesh, address, lateral, y, sx, sy, sz, roll = 0, pitch = 0) => {
                if (mesh.count >= mesh.instanceMatrix.count) return;
                place(mesh, mesh.count++, track, address, lateral, y, sx, sy, sz, roll, pitch);
            };
            // A straight member between two points of the cross-section at one address.
            const span = (mesh, address, l0, y0, l1, y1, thick, depth = thick) => part(mesh, address,
                (l0 + l1) / 2, (y0 + y1) / 2, Math.hypot(l1 - l0, y1 - y0), thick, depth, Math.atan2(y1 - y0, l1 - l0));
            const rawPart = part, rawSpan = span;
            const speed = tuning.cameraSpeed ?? 1;
            // When the train reaches an address along the line.
            const timeAt = address => {
                let lo = 0, hi = timeline.duration;
                for (let j = 0; j < 18; j++) {
                    const mid = (lo + hi) * 0.5;
                    if (timeline.distanceAt(mid, speed) < address) lo = mid;
                    else hi = mid;
                }
                return (lo + hi) * 0.5;
            };
            const stateAt = address => timeline.sample(timeAt(address));
            // With no screen ahead the camera may still be turned to a line on the
            // sky: a pole then takes the side the camera faces away from as it
            // comes up to and passes that pole.
            const awayFromGaze = address => {
                for (const lead of [0, 16, 32]) {
                    const view = global.MusicStageDioramaCamera.pose(timeline, track, timeAt(address - lead), tuning);
                    const heading = track.at(address - lead).yaw;
                    const turn = Math.atan2(Math.sin(view.yaw - heading), Math.cos(view.yaw - heading));
                    if (Math.abs(turn) > 0.08) return turn > 0 ? -1 : 1;
                }
                return -1;
            };
            // Stations are laid out first: poles and props keep out of them.
            const stations = [];
            const stationStart = Math.floor(s / 110) - 1;
            for (let i = 0; i < 4 && enabled; i++) {
                const id = stationStart + i;
                if (id < 0) continue;
                const address = id * 110 + 38;
                // Prefer the side where fewer of its bays stand in a screen's sight line.
                const exposure = side => [-11, -5.5, 0, 5.5, 11].filter(bay =>
                    inSight(track, address + bay, 7, side)).length;
                const preferred = id % 2 ? 1 : -1;
                stations.push({ id, address, open: stateAt(address).density < 0.4,
                    side: exposure(-preferred) < exposure(preferred) ? -preferred : preferred });
            }
            const atStation = (address, side, margin) => stations.some(station =>
                station.side === side && Math.abs(station.address - address) < 14 + margin);

            // --- Catenary masts, lamp posts and the overhead line ---
            let haloCount = 0, wireVertex = 0;
            lightAnchors = [];
            const poleStart = Math.floor(s / spacing) - 3;
            const polePlan = [];
            for (let i = 0; i <= (enabled ? (saving ? 16 : 32) : -1); i++) {
                const id = poleStart + i;
                const address = id * spacing;
                const state = stateAt(address);
                const present = state.density >= 0.4 || id % 4 === 0;
                // The line is electrified wherever the train rides low; over open
                // water the camera climbs above bare lamp posts instead.
                let side = poleSide(track, address, awayFromGaze(address));
                if (inSight(track, address, POLE_OFFSET, side)) side = -side;
                const clear = !inSight(track, address, POLE_OFFSET, side);
                // A high camera also sees the masts ahead of it, so the wire only
                // starts a few spans after the train has come down.
                polePlan.push({ id, address, present: present && clear, side,
                    wired: present && clear && state.density >= 0.4 && !saving
                        && [0, 24, 48, 72].every(back => stateAt(address - back).height < 4.2) });
            }
            const wire = (a0, l0, y0, a1, l1, y1) => {
                if (wireVertex + 6 > wirePositions.length) return;
                for (const [address, lateral, y] of [[a0, l0, y0], [a1, l1, y1]]) {
                    const f = track.at(address);
                    wirePositions[wireVertex++] = f.position.x + f.right.x * lateral;
                    wirePositions[wireVertex++] = y;
                    wirePositions[wireVertex++] = f.position.z + f.right.z * lateral;
                }
            };
            polePlan.slice(0, -1).forEach((pole, index) => {
                if (!pole.present) return;
                const { id, address, side } = pole;
                const L = value => side * value;
                const stagger = id % 2 ? 0.18 : -0.18;
                part(concreteParts, address, L(POLE_OFFSET), 0.3, 0.6, 0.6, 0.6);
                if (pole.wired) {
                    part(masts, address, L(POLE_OFFSET), 4.3, 1, 7.4, 1);
                    // Cantilever: top tube, tie rod, bracket tube and steady arm.
                    span(steelParts, address, L(POLE_OFFSET), 7.25, L(0.2), 7.0, 0.07);
                    span(steelParts, address, L(POLE_OFFSET), 7.85, L(1.4), 7.13, 0.03);
                    span(steelParts, address, L(POLE_OFFSET), 6.25, L(0.6), 6.95, 0.07);
                    span(steelParts, address, L(1.9), 6.6, stagger, CONTACT_Y + 0.05, 0.04);
                    for (const y of [7.22, 6.3]) part(concreteParts, address, L(POLE_OFFSET - 0.42), y, 0.34, 0.15, 0.15);
                    part(steelParts, address, L(POLE_OFFSET), 7.93, 0.5, 0.05, 0.05);
                } else part(masts, address, L(POLE_OFFSET), 2.55, 0.85, 3.9, 0.85);
                // Over open water the camera flies at 5 to 7 m and the line is
                // written on the sky: bare posts stay below that eye line.
                const lampY = pole.wired ? LAMP_Y : 4.2;
                if (id % 7 !== 3) {
                    // Luminaire: bracket, hooded housing and the lit diffuser below it.
                    span(steelParts, address, L(POLE_OFFSET), lampY + 0.02, L(LAMP_OFFSET - 0.2), lampY + 0.2, 0.05);
                    part(steelParts, address, L(LAMP_OFFSET), lampY + 0.17, 0.82, 0.09, 0.3);
                    part(glowParts, address, L(LAMP_OFFSET), lampY + 0.105, 0.66, 0.04, 0.2);
                    const hf = track.at(address);
                    haloPositions[haloCount * 3] = hf.position.x + hf.right.x * L(LAMP_OFFSET);
                    haloPositions[haloCount * 3 + 1] = lampY;
                    haloPositions[haloCount * 3 + 2] = hf.position.z + hf.right.z * L(LAMP_OFFSET);
                    haloCount++;
                    lightAnchors.push({ address, side, y: lampY, distance: Math.abs(address - s) });
                }
                // A block signal on every eleventh pole, its lamp in the cold palette colour.
                if (id % 11 === 5 && !saving && !atStation(address, side, 2) && !inSight(track, address, 2.3, side)) {
                    part(masts, address + 1.2, L(2.3), 1.9, 0.7, 3.8, 0.7);
                    part(steelParts, address + 1.2, L(2.3), 3.55, 0.36, 1.0, 0.16);
                    part(steelParts, address + 1.08, L(2.3), 3.86, 0.3, 0.04, 0.22);
                    part(coldGlowParts, address + 1.1, L(2.3), 3.72, 0.15, 0.15, 0.03);
                    part(steelParts, address + 1.08, L(2.3), 3.5, 0.3, 0.04, 0.22);
                    part(glowParts, address + 1.1, L(2.3), 3.36, 0.11, 0.11, 0.03);
                }
                const next = polePlan[index + 1];
                if (!pole.wired || !next.wired) return;
                const nextStagger = next.id % 2 ? 0.18 : -0.18;
                for (let segment = 0; segment < 8; segment++) {
                    const u0 = segment / 8, u1 = (segment + 1) / 8;
                    const sag = u => 7.0 - Math.sin(u * Math.PI) * 0.72;
                    const lateral = u => L(0.2) + (next.side * 0.2 - L(0.2)) * u;
                    wire(address + u0 * spacing, lateral(u0), sag(u0), address + u1 * spacing, lateral(u1), sag(u1));
                    // Feeder along the mast tops.
                    const feeder = u => L(POLE_OFFSET) + (next.side - side) * POLE_OFFSET * u;
                    const droop = u => 7.95 - Math.sin(u * Math.PI) * 0.3;
                    if (side === next.side) wire(address + u0 * spacing, feeder(u0), droop(u0),
                        address + u1 * spacing, feeder(u1), droop(u1));
                    // Droppers hang the level contact wire from the sagging messenger.
                    if (segment % 2 === 1) wire(address + u1 * spacing, lateral(u1), sag(u1), address + u1 * spacing,
                        stagger + (nextStagger - stagger) * u1, CONTACT_Y);
                }
                for (let half = 0; half < 2; half++) wire(address + half * spacing / 2,
                    stagger + (nextStagger - stagger) * half / 2, CONTACT_Y, address + (half + 1) * spacing / 2,
                    stagger + (nextStagger - stagger) * (half + 1) / 2, CONTACT_Y);
            });
            wireGeometry.setDrawRange(0, wireVertex / 3);
            wireGeometry.attributes.position.needsUpdate = true;
            wires.visible = enabled;
            haloGeometry.setDrawRange(0, haloCount);
            haloGeometry.attributes.position.needsUpdate = true;
            halos.visible = enabled && !saving;
            lightAnchors.sort((a, b) => a.distance - b.distance);

            // --- Stations ---
            liveStations = 0;
            stationTypes = [];
            const motifNames = ['sheltered-platform', 'door-gallery', 'water-stairs', 'window-arcade'];
            const beforeStations = sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0);
            for (const { id, address, open, side } of stations) {
                // The steps belong to open water; lit stations rotate through the other three.
                const type = open ? 2 : [0, 1, 3][id % 3];
                const lateral = value => side * value;
                // Whatever would stand between the train and a line being sung is
                // left out, bay by bay: the station keeps an opening there.
                const clear = (at, offset, top) => top < SIGHT_FLOOR || !inSight(track, at, Math.abs(offset), side);
                const part = (mesh, at, offset, y, sx, sy, sz, roll = 0, pitch = 0) => {
                    const pieces = y + sy / 2 < SIGHT_FLOOR ? 1 : Math.max(1, Math.round(sz / 5.5));
                    for (let i = 0; i < pieces; i++) {
                        const z = at - sz / 2 + (i + 0.5) * sz / pieces;
                        if (clear(z, offset, y + sy / 2)) rawPart(mesh, z, offset, y, sx, sy, sz / pieces, roll, pitch);
                    }
                };
                const span = (mesh, at, l0, y0, l1, y1, thick, depth = thick) => {
                    const pieces = Math.max(1, Math.round(depth / 5.5));
                    for (let i = 0; i < pieces; i++) {
                        const z = at - depth / 2 + (i + 0.5) * depth / pieces;
                        if (clear(z, (l0 + l1) / 2, Math.max(y0, y1))) rawSpan(mesh, z, l0, y0, l1, y1, thick, depth / pieces);
                    }
                };
                // All objects remain below/away from the lyric viewing zone:
                // lyric signs stand at +/-18m; shelters stay within +/-10m and
                // take the side with no screen nearby.
                part(concreteParts, address, lateral(6.5), 0.55, 5, 1.1, 28);
                part(concreteParts, address, lateral(4.2), 1.13, 0.7, 0.08, 28.2);
                part(glowParts, address, lateral(3.84), 1.12, 0.045, 0.035, 28);
                part(concreteParts, address, lateral(8.8), 1.25, 0.18, 0.3, 28);
                // Steps run down into the shallows at both ends.
                for (let step = 0; step < 4; step++) {
                    const height = 1.1 - (step + 1) * 0.22;
                    for (const end of [-1, 1]) part(concreteParts, address + end * (14.45 + step * 0.9),
                        lateral(6.5), height / 2, 5, height, 0.9);
                }
                if (!saving && !open) {
                    // A station name board with nothing written on it.
                    for (const post of [-1.35, 1.35])
                        part(steelParts, address + 9.5 + post, lateral(8.45), 2.2, 0.08, 2.2, 0.08);
                    part(timberParts, address + 9.5, lateral(8.45), 2.75, 0.07, 0.85, 3.1);
                    part(concreteParts, address + 9.5, lateral(8.4), 2.48, 0.05, 0.12, 3.1);
                    part(glowParts, address + 9.5, lateral(8.4), 3.21, 0.05, 0.04, 3.1);
                }
                if (type === 0) {
                    // Butterfly canopy on a single row of Y columns: two roof
                    // planes fold down to a valley gutter over the column line.
                    span(steelParts, address, lateral(4.1), 5.62, lateral(7), 5.16, 0.1, 26);
                    span(steelParts, address, lateral(7), 5.16, lateral(9.5), 5.5, 0.1, 26);
                    part(steelParts, address, lateral(7), 5.02, 0.32, 0.24, 26);
                    part(steelParts, address, lateral(4.12), 5.56, 0.07, 0.24, 26.1);
                    part(steelParts, address, lateral(9.48), 5.44, 0.07, 0.22, 26.1);
                    for (let bay = 0; bay < 5; bay++) {
                        const z = address - 11 + bay * 5.5;
                        part(steelParts, z, lateral(7), 3.0, 0.22, 3.8, 0.22);
                        part(concreteParts, z, lateral(7), 1.2, 0.42, 0.2, 0.42);
                        span(steelParts, z, lateral(7), 4.15, lateral(4.9), 5.38, 0.1);
                        span(steelParts, z, lateral(7), 4.15, lateral(9.0), 5.33, 0.1);
                        if ((id + bay) % 7 !== 3) part(glowParts, z + 2.75, lateral(5.5), 5.3, 0.1, 0.04, 2.3);
                    }
                    if (!saving) {
                        // Hanging platform sign and a back rail.
                        for (const hanger of [-0.8, 0.8])
                            part(steelParts, address - 2.75, lateral(5.6 + hanger), 4.9, 0.03, 0.75, 0.03);
                        part(timberParts, address - 2.75, lateral(5.6), 4.3, 2.1, 0.5, 0.09);
                        part(glowParts, address - 2.75, lateral(5.6), 4.02, 2.1, 0.03, 0.1);
                        for (const y of [1.65, 2.15]) part(steelParts, address, lateral(9.15), y, 0.05, 0.05, 26);
                        for (let post = 0; post <= 8; post++)
                            part(steelParts, address - 13 + post * 3.25, lateral(9.15), 1.65, 0.06, 1.1, 0.06);
                    }
                } else if (type === 1) {
                    // Receding doorways: grounded counterparts of old memory
                    // frames. A missing lintel on return creates an absence.
                    part(concreteParts, address, lateral(6.8), 1.2, 3.6, 0.2, 24.5);
                    for (let bay = 0; bay < 6; bay++) {
                        const z = address - 11 + bay * 4.4;
                        for (const edge of [-1, 1]) {
                            part(concreteParts, z, lateral(6.8 + edge * 1.5), 2.9, 0.3, 3.4, 0.42);
                            part(concreteParts, z, lateral(6.8 + edge * 1.5), 1.42, 0.44, 0.24, 0.56);
                        }
                        if ((id + bay) % 6 !== 4) {
                            part(concreteParts, z, lateral(6.8), 4.72, 3.9, 0.3, 0.5);
                            part(steelParts, z, lateral(6.8), 4.93, 4.2, 0.07, 0.62);
                            part(glowParts, z, lateral(6.8), 4.54, 2.5, 0.04, 0.08);
                        }
                        part(glowParts, z, lateral(8.1), 3.0, 0.04, 2.6, 0.06);
                    }
                } else if (type === 2) {
                    // Broad steps descend toward the water, not into the sky.
                    // In open acts they replace dense station silhouettes.
                    for (let step = 0; step < 7; step++) {
                        const height = 1.05 - step * 0.14;
                        part(concreteParts, address, lateral(9.2 + step * 0.65),
                            height * 0.5, 0.7, height, 13 - step * 0.65);
                    }
                    for (const z of [-10, 10]) {
                        part(masts, address + z, lateral(10), 2.5, 0.75, 3.0, 0.75);
                        part(steelParts, address + z, lateral(10), 4.42, 0.56, 0.06, 0.56);
                        part(glowParts, address + z, lateral(10), 4.2, 0.34, 0.38, 0.34);
                    }
                    if (!saving) {
                        // A gate standing alone in the shallows beyond the steps.
                        for (const z of [-3.1, 3.1]) {
                            part(timberParts, address + z, lateral(15.5), 2.9, 0.42, 6.4, 0.42, 0, z > 0 ? 0.045 : -0.045);
                            part(concreteParts, address + z, lateral(15.5), 0.25, 0.7, 0.5, 0.7);
                        }
                        part(timberParts, address, lateral(15.5), 6.25, 0.5, 0.4, 8.6);
                        part(timberParts, address, lateral(15.5), 6.52, 0.72, 0.14, 9.5);
                        part(timberParts, address, lateral(15.5), 5.3, 0.3, 0.3, 7.2);
                        part(timberParts, address, lateral(15.5), 5.78, 0.26, 0.66, 0.3);
                        part(coldGlowParts, address, lateral(15.5), 4.75, 0.22, 0.3, 0.22);
                    }
                } else {
                    // Window arcade and low walls leave actual openings for
                    // water and the far horizon. Missing panes are intentional.
                    part(concreteParts, address, lateral(8.8), 1.6, 0.34, 1, 25);
                    part(concreteParts, address, lateral(8.8), 2.14, 0.48, 0.08, 25.2);
                    part(steelParts, address, lateral(8.8), 4.62, 0.3, 0.16, 25);
                    for (let bay = 0; bay < 7; bay++) {
                        const z = address - 12 + bay * 4;
                        part(steelParts, z, lateral(8.8), 3.38, 0.18, 2.4, 0.18);
                        if (bay < 6 && (id + bay) % 5 !== 2) {
                            part(steelParts, z + 2, lateral(8.8), 3.38, 0.05, 2.32, 0.05);
                            part(steelParts, z + 2, lateral(8.8), 3.5, 0.05, 0.05, 3.8);
                            part(glowParts, z + 2, lateral(8.72), 4.5, 0.04, 0.03, 2.8);
                        }
                    }
                }
                for (let seat = 0; seat < (saving ? 1 : 3); seat++) {
                    if ((id + seat) % 4 === 2) continue;
                    const z = address - 7 + seat * 7 + (type === 0 ? 2.75 : 0);
                    const back = type === 0 ? 8.2 : 7.25;
                    part(timberParts, z, lateral(back - 0.25), 1.58, 0.5, 0.07, 1.8);
                    part(timberParts, z, lateral(back), 1.95, 0.07, 0.5, 1.8, side * -0.12);
                    for (const leg of [-0.75, 0.75])
                        part(steelParts, z + leg, lateral(back - 0.22), 1.33, 0.46, 0.46, 0.05);
                }
                stationTypes.push(motifNames[type]);
                liveStations++;
            }
            stationInstances = sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0) - beforeStations;

            // --- Remains of old piers: weathered posts standing in the shallows ---
            for (let cell = Math.floor((s - 60) / 34); cell <= Math.floor((s + 240) / 34) && enabled && !saving; cell++) {
                if (cell < 0) continue;
                const random = seededRandom(`mooring:${cell}`);
                if (random() > 0.62) continue;
                const address = cell * 34 + random() * 18;
                // Only where no screen stands within reading distance on that side.
                const side = poleSide(track, address);
                const count = 3 + Math.floor(random() * 5), outward = random() > 0.45;
                const reach = 8.5 + random() * 5, lantern = random() > 0.5;
                if (atStation(address, side, 12)) continue;
                for (let post = 0; post < count; post++) {
                    const height = 0.9 + random() * 1.7;
                    const at = address + (outward ? (random() - 0.5) * 0.5 : post * 1.9);
                    const lateral = side * (reach + (outward ? post * 1.7 : (random() - 0.5) * 0.5));
                    const lean = [(random() - 0.5) * 0.2, (random() - 0.5) * 0.16];
                    const tall = height + (lantern && post === count - 1 ? 0.35 : 0);
                    if (tall > SIGHT_FLOOR && inSight(track, at, Math.abs(lateral), side)) continue;
                    part(timberParts, at, lateral, height / 2 - 0.3, 0.22, height + 0.6, 0.22, lean[0], lean[1]);
                    if (lantern && post === count - 1) {
                        part(steelParts, at, lateral, height + 0.06, 0.2, 0.05, 0.2);
                        part(coldGlowParts, at, lateral, height + 0.2, 0.13, 0.22, 0.13);
                    }
                }
            }
            updateLights(track, s, saving, audio);
            sceneryPools.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
        };
        const renderReflection = (renderer, camera) => {
            if (dead || !reflectionEnabled) return;
            camera.updateMatrixWorld();
            mirror.position.copy(camera.position);
            mirror.position.y *= -1;
            const direction = camera.getWorldDirection(new T.Vector3());
            direction.y *= -1;
            mirror.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
            mirror.up.y *= -1;
            mirror.lookAt(direction.add(mirror.position));
            mirror.near = camera.near;
            mirror.far = camera.far;
            mirror.projectionMatrix.copy(camera.projectionMatrix);
            mirror.updateMatrixWorld();
            textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
                .multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
            const plane = new T.Plane(new T.Vector3(0, 1, 0), 0).applyMatrix4(mirror.matrixWorldInverse);
            const clip = new T.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
            const e = mirror.projectionMatrix.elements;
            const q = new T.Vector4((Math.sign(clip.x) + e[8]) / e[0],
                (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
            const dot = clip.dot(q);
            if (Math.abs(dot) < 0.00001) return;
            clip.multiplyScalar(2 / dot);
            e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.001; e[14] = clip.w;
            mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
            mirror.layers.enable(2);
            const size = renderer.getSize(new T.Vector2());
            const width = quality === 'ultimate' ? 1024 : quality === 'energy-saving' ? 256 : 512;
            const height = Math.max(1, Math.round(width * size.y / Math.max(1, size.x)));
            if (target.width !== width || target.height !== height) target.setSize(width, height);
            const oldTarget = renderer.getRenderTarget(), oldAutoClear = renderer.autoClear;
            const oldXr = renderer.xr.enabled;
            water.visible = false;
            try {
                renderer.xr.enabled = false;
                renderer.autoClear = true;
                renderer.setRenderTarget(target);
                renderer.clear();
                renderer.render(scene, mirror);
            } finally {
                renderer.setRenderTarget(oldTarget);
                renderer.autoClear = oldAutoClear;
                renderer.xr.enabled = oldXr;
                water.visible = true;
            }
        };
        setPalette();
        return {
            update, setPalette, renderReflection, updateCabin,
            setPixelRatio(ratio) {
                starMat.uniforms.pixelRatio.value = Math.max(0.5, ratio || 1);
                haloMat.uniforms.pixelRatio.value = Math.max(0.5, ratio || 1);
            },
            snapshot: () => ({ liveStations, stationTypes, waterVisible: water.visible, reflectionEnabled,
                warmth: liveWarmth, accent: liveAccent, fogDensity: scene.fog?.density ?? 0,
                lampHalos: halos.visible ? haloGeometry.drawRange.count : 0,
                cabinWeight: cabin.visible ? cabinWeight : 0,
                auroraVisible: Boolean(skyMat.uniforms.auroraActive.value > 0.5),
                starOpacity: starMat.opacity, moonRadius: 20,
                instanceRebuilds, reflectionSize: [target.width, target.height],
                architecturalInstances: stationInstances,
                worldInstances: rails.count + sleepers.count
                    + sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0) }),
            destroy() {
                if (dead) return;
                dead = true;
                scene.remove(root);
                root.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
                geometries.forEach(g => g.dispose());
                materials.forEach(m => m.dispose());
                target.dispose();
            }
        };
    };
    global.MusicStageDioramaWorld = Object.freeze({ create, poleSide, inSight });
})(window);