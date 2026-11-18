(function (global) {
    'use strict';
    /*
     * The diorama's lens. The scene is drawn into a floating-point target, the
     * light above a threshold is spread through a chain of ever smaller
     * buffers and added back, and the result is graded, vignetted and grained.
     * The glow is what makes a lamp a light instead of a yellow box.
     */
    const LEVELS = 4;
    const create = (T) => {
        const target = new T.WebGLRenderTarget(1, 1, {
            type: T.HalfFloatType, depthBuffer: true,
            // The scene is drawn into this target, so the canvas's own antialiasing never applies.
            samples: 4
        });
        const chain = Array.from({ length: LEVELS }, () => new T.WebGLRenderTarget(1, 1, {
            type: T.HalfFloatType, depthBuffer: false,
            minFilter: T.LinearFilter, magFilter: T.LinearFilter
        }));
        const scene = new T.Scene();
        const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const geometry = new T.PlaneGeometry(2, 2);
        const vertexShader = `varying vec2 uvScreen;
            void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;
        const pass = (fragmentShader, uniforms, extra = {}) => new T.ShaderMaterial({
            depthTest: false, depthWrite: false, vertexShader, fragmentShader, uniforms, ...extra
        });
        // First step down: keep only what is brighter than the threshold, with a soft knee.
        const prefilter = pass(`uniform sampler2D image;uniform vec2 texel;uniform float threshold;
            varying vec2 uvScreen;
            vec3 tap(vec2 o){vec3 c=min(texture2D(image,uvScreen+o*texel).rgb,vec3(24.0));
                float l=max(c.r,max(c.g,c.b));
                float soft=clamp(l-threshold+0.35,0.0,0.7);soft=soft*soft/1.4;
                return c*max(soft,l-threshold)/max(l,0.0001);}
            void main(){
                gl_FragColor=vec4((tap(vec2(-1.0,-1.0))+tap(vec2(1.0,-1.0))
                    +tap(vec2(-1.0,1.0))+tap(vec2(1.0,1.0)))*0.25,1.0);
            }`, { image: { value: null }, texel: { value: new T.Vector2() }, threshold: { value: 0.82 } });
        const down = pass(`uniform sampler2D image;uniform vec2 texel;varying vec2 uvScreen;
            void main(){
                vec3 c=texture2D(image,uvScreen).rgb*4.0;
                c+=texture2D(image,uvScreen+texel*vec2(-1.0,-1.0)).rgb;
                c+=texture2D(image,uvScreen+texel*vec2(1.0,-1.0)).rgb;
                c+=texture2D(image,uvScreen+texel*vec2(-1.0,1.0)).rgb;
                c+=texture2D(image,uvScreen+texel*vec2(1.0,1.0)).rgb;
                gl_FragColor=vec4(c*0.125,1.0);
            }`, { image: { value: null }, texel: { value: new T.Vector2() } });
        // Each step up is added onto the sharper level below it.
        const up = pass(`uniform sampler2D image;uniform vec2 texel;uniform float weight;varying vec2 uvScreen;
            void main(){
                vec3 c=texture2D(image,uvScreen+texel*vec2(-2.0,0.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(2.0,0.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(0.0,-2.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(0.0,2.0)).rgb;
                c+=(texture2D(image,uvScreen+texel*vec2(-1.0,-1.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(1.0,-1.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(-1.0,1.0)).rgb
                    +texture2D(image,uvScreen+texel*vec2(1.0,1.0)).rgb)*2.0;
                gl_FragColor=vec4(c/12.0*weight,1.0);
            }`, { image: { value: null }, texel: { value: new T.Vector2() }, weight: { value: 1 } },
        { blending: T.AdditiveBlending, transparent: true });
        const material = pass(`uniform sampler2D image,glowMap;
            uniform float time,grain,vignette,bloom;varying vec2 uvScreen;
            void main(){
                vec3 color=texture2D(image,uvScreen).rgb;
                color+=texture2D(glowMap,uvScreen).rgb*bloom;
                vec2 p=uvScreen*2.0-1.0;
                color*=1.0-vignette*smoothstep(0.2,1.7,dot(p,p))*0.6;
                gl_FragColor=vec4(color,1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
                float n=fract(sin(dot(gl_FragCoord.xy+floor(time*24.0),
                    vec2(12.9898,78.233)))*43758.5453)-0.5;
                gl_FragColor.rgb=clamp(gl_FragColor.rgb+n*grain*0.08,0.0,1.0);
            }`, {
            image: { value: target.texture }, glowMap: { value: chain[0].texture },
            time: { value: 0 }, grain: { value: 0.08 }, vignette: { value: 0.22 }, bloom: { value: 0.6 }
        });
        const quad = new T.Mesh(geometry, material);
        scene.add(quad);
        const draw = (renderer, shader, source, destination, texelOf) => {
            shader.uniforms.image.value = source.texture;
            shader.uniforms.texel.value.set(1 / texelOf.width, 1 / texelOf.height);
            quad.material = shader;
            renderer.setRenderTarget(destination);
            renderer.render(scene, camera);
        };
        let dead = false;
        return {
            // The diorama's own settings unless another mode passes its own.
            render(renderer, world, worldCamera, time, config, lens) {
                if (dead) return;
                const tuning = lens || config.modes?.diorama || {};
                if (tuning.postProcess === false || config.quality === 'energy-saving') {
                    renderer.render(world, worldCamera);
                    return;
                }
                const size = renderer.getDrawingBufferSize(new T.Vector2());
                if (target.width !== size.x || target.height !== size.y) {
                    target.setSize(size.x, size.y);
                    chain.forEach((level, index) => level.setSize(
                        Math.max(2, Math.round(size.x / 2 ** (index + 1))),
                        Math.max(2, Math.round(size.y / 2 ** (index + 1)))));
                }
                material.uniforms.time.value = time;
                material.uniforms.grain.value = tuning.grain ?? 0.08;
                material.uniforms.vignette.value = tuning.vignette ?? 0.22;
                material.uniforms.bloom.value = (tuning.glow ?? 1) * 0.6;
                prefilter.uniforms.threshold.value = tuning.threshold ?? 0.82;
                const previous = renderer.getRenderTarget();
                const autoClear = renderer.autoClear;
                try {
                    renderer.setRenderTarget(target);
                    renderer.clear();
                    renderer.render(world, worldCamera);
                    draw(renderer, prefilter, target, chain[0], target);
                    for (let i = 1; i < LEVELS; i += 1) draw(renderer, down, chain[i - 1], chain[i], chain[i - 1]);
                    // The wide levels carry more: a lamp has a small hot core and a broad veil.
                    renderer.autoClear = false;
                    for (let i = LEVELS - 1; i > 0; i -= 1) {
                        up.uniforms.weight.value = 1.15;
                        draw(renderer, up, chain[i], chain[i - 1], chain[i]);
                    }
                    renderer.autoClear = autoClear;
                    quad.material = material;
                    renderer.setRenderTarget(previous);
                    renderer.render(scene, camera);
                } finally {
                    renderer.autoClear = autoClear;
                    quad.material = material;
                    renderer.setRenderTarget(previous);
                }
            },
            destroy() {
                if (dead) return;
                dead = true;
                target.dispose();
                chain.forEach((level) => level.dispose());
                geometry.dispose();
                [material, prefilter, down, up].forEach((shader) => shader.dispose());
            }
        };
    };
    global.MusicStageDioramaOptics = Object.freeze({ create });
})(window);
