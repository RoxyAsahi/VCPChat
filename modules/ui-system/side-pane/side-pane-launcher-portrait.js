/* Side pane new tab page portrait header: the agent's portrait, its light-theme version and its
 * expression variants. Emotion frames pick the variant; a new image is decoded off screen first and
 * then cross-faded in on a second layer, so a switch never shows a blank or half-painted frame. */
'use strict';
import { resolvePortrait } from '../../emotion/portraitVariants.js';

// 交叉淡入的时长和样式里一致；换层后多等一会儿再把旧层的图清掉
const LAYER_RELEASE_MS = 400;

export function createLauncherPortrait({ view, scheduler = globalThis }) {
    const portrait = view?.querySelector?.('.side-pane-launcher-portrait') || null;
    const layers = portrait ? [...portrait.querySelectorAll('.side-pane-launcher-portrait-layer')] : [];
    // 老结构里没有分层时，整个立绘容器就是唯一一层（不做淡入淡出）
    if (portrait && !layers.length) layers.push(portrait);
    const doc = portrait?.ownerDocument || globalThis.document;
    const cleanups = [];
    let portraits = null;
    let frame = null;
    let active = 0;
    let shown = null;
    let swapToken = 0;
    let releaseTimer = null;
    let disposed = false;
    // 读不出来的图：之后挑图时跳过它，退到相近情绪或默认立绘
    const broken = new Set();

    const imagesOf = layer => ({
        dark: layer.querySelector('[data-portrait-theme="default"]'),
        light: layer.querySelector('[data-portrait-theme="light"]'),
    });

    function setImageSource(image, src) {
        if (!image) return;
        image.hidden = !src;
        if (!src) image.removeAttribute('src');
        else if (image.getAttribute('src') !== src) image.setAttribute('src', src);
    }

    function usablePortraits() {
        if (!portraits) return null;
        if (!broken.size) return portraits;
        const usable = Object.fromEntries(Object.entries(portraits).filter(([, url]) => !broken.has(url)));
        return usable.default ? usable : null;
    }

    // 深色和浅色主题各要哪张图；浅色挑出来和深色是同一张时只用一张
    function targetFor(current) {
        const look = { state: frame?.state || null, emotion: frame?.emotion || 'neutral' };
        const dark = resolvePortrait(current, { ...look, theme: 'dark' })?.url || '';
        const light = resolvePortrait(current, { ...look, theme: 'light' })?.url || '';
        return { dark, light: light && light !== dark ? light : '' };
    }

    function paint(layer, target) {
        const { dark, light } = imagesOf(layer);
        setImageSource(dark, target.dark);
        setImageSource(light, target.light);
        if (target.light) layer.dataset.portraitThemed = '';
        else delete layer.dataset.portraitThemed;
    }

    function markShown(target) {
        shown = target;
        if (!view) return;
        if (target) view.dataset.launcherPortrait = target.light ? 'themed' : 'single';
        else delete view.dataset.launcherPortrait;
        if (target && frame) view.dataset.launcherPortraitLook = frame.state || frame.emotion || 'neutral';
        else delete view.dataset.launcherPortraitLook;
    }

    function hide() {
        swapToken += 1;
        if (portrait) portrait.hidden = true;
        layers.forEach(layer => paint(layer, { dark: '', light: '' }));
        markShown(null);
    }

    function activate(index) {
        layers.forEach((layer, i) => {
            if (layer === portrait) return;
            if (i === index) layer.dataset.portraitActive = '';
            else delete layer.dataset.portraitActive;
        });
        active = index;
    }

    // 先在屏幕外把图解码好；不支持 decode 的环境直接当作已就绪
    function decode(url) {
        if (!url) return Promise.resolve();
        const image = doc?.createElement?.('img');
        if (!image || typeof image.decode !== 'function') return Promise.resolve();
        image.decoding = 'async';
        image.src = url;
        return image.decode().catch((error) => {
            broken.add(url);
            throw error;
        });
    }

    function apply({ animate }) {
        const current = usablePortraits();
        if (!current) { hide(); return; }
        const target = targetFor(current);
        if (portrait) portrait.hidden = false;
        if (shown && target.dark === shown.dark && target.light === shown.light) return;
        const token = ++swapToken;
        if (!animate || !shown || layers.length < 2) {
            if (releaseTimer) scheduler.clearTimeout(releaseTimer);
            releaseTimer = null;
            layers.forEach((layer, i) => { if (i !== active) paint(layer, { dark: '', light: '' }); });
            paint(layers[active], target);
            activate(active);
            markShown(target);
            return;
        }
        Promise.all([decode(target.dark), decode(target.light)]).then(() => {
            if (disposed || token !== swapToken) return;
            const next = (active + 1) % layers.length;
            const previous = active;
            paint(layers[next], target);
            activate(next);
            markShown(target);
            if (releaseTimer) scheduler.clearTimeout(releaseTimer);
            releaseTimer = scheduler.setTimeout(() => {
                releaseTimer = null;
                if (!disposed && active !== previous) paint(layers[previous], { dark: '', light: '' });
            }, LAYER_RELEASE_MS);
        }, () => {
            // 这张差分坏了：换下一个候选再试（broken 里已经记下它）
            if (!disposed && token === swapToken) apply({ animate });
        });
    }

    // 已经显示出来的图读失败：默认立绘坏了就整块退回圆头像，差分坏了就退到别的图
    layers.forEach((layer) => {
        for (const image of Object.values(imagesOf(layer))) {
            if (!image) continue;
            const onError = () => {
                const src = image.getAttribute('src');
                if (!src || !portraits) return;
                broken.add(src);
                shown = null;
                apply({ animate: false });
            };
            image.addEventListener('error', onError);
            cleanups.push(() => image.removeEventListener('error', onError));
        }
    });

    return Object.freeze({
        /** portraits 是 { default, light?, <情绪或状态>?, <键>-light? }，null 表示没有立绘 */
        render(next) {
            const value = typeof next?.default === 'string' && next.default ? next : null;
            const sameCharacter = Boolean(value && portraits && value.default === portraits.default);
            if (!sameCharacter) broken.clear();
            portraits = value;
            if (!value) { hide(); return; }
            // 立绘文件本身变了（换角色、新放进来或改了图）直接换上，不做淡入淡出
            apply({ animate: false });
        },
        /** frame 来自情绪源：{ state, emotion, intensity, source }；null 回到默认立绘 */
        setFrame(next) {
            frame = next && typeof next === 'object' ? next : null;
            if (portraits) apply({ animate: true });
        },
        get look() { return shown ? { ...shown } : null; },
        dispose() {
            disposed = true;
            swapToken += 1;
            if (releaseTimer) scheduler.clearTimeout(releaseTimer);
            releaseTimer = null;
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        },
    });
}
