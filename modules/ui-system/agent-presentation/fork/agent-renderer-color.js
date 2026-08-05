const avatarColorCache = new Map();

function rgbToHsl(red, green, blue) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const lightness = (maximum + minimum) / 2;
    if (maximum === minimum) return [0, 0, lightness * 100];
    const delta = maximum - minimum;
    const saturation = lightness > 0.5
        ? delta / (2 - maximum - minimum) : delta / (maximum + minimum);
    let hue;
    if (maximum === r) hue = (g - b) / delta + (g < b ? 6 : 0);
    else if (maximum === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    return [(hue / 6) * 360, saturation * 100, lightness * 100];
}

function hslToRgb(hue, saturation, lightness) {
    const s = saturation / 100;
    const l = lightness / 100;
    const chroma = (1 - Math.abs((2 * l) - 1)) * s;
    const middle = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const offset = l - (chroma / 2);
    let components = [0, 0, 0];
    if (hue < 60) components = [chroma, middle, 0];
    else if (hue < 120) components = [middle, chroma, 0];
    else if (hue < 180) components = [0, chroma, middle];
    else if (hue < 240) components = [0, middle, chroma];
    else if (hue < 300) components = [middle, 0, chroma];
    else components = [chroma, 0, middle];
    const [red, green, blue] = components.map((value) => Math.round((value + offset) * 255));
    return `rgb(${red},${green},${blue})`;
}

async function getDominantAvatarColor(imageUrl, environment = globalThis) {
    if (!imageUrl) return null;
    const cacheKey = String(imageUrl).split('?')[0];
    if (avatarColorCache.has(cacheKey)) return avatarColorCache.get(cacheKey);
    const ImageConstructor = environment.Image || environment.window?.Image;
    const documentRef = environment.document || environment.window?.document;
    if (typeof ImageConstructor !== 'function' || !documentRef?.createElement) {
        avatarColorCache.set(cacheKey, null);
        return null;
    }
    const color = await new Promise((resolve) => {
        const image = new ImageConstructor();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            try {
                const canvas = documentRef.createElement('canvas');
                canvas.width = 30;
                canvas.height = 30;
                const context = canvas.getContext?.('2d');
                if (!context) { resolve(null); return; }
                context.drawImage(image, 0, 0, 30, 30);
                const pixels = context.getImageData(0, 0, 30, 30).data;
                let bestHue = null;
                let bestSaturation = -1;
                let red = 0;
                let green = 0;
                let blue = 0;
                let count = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] < 128) continue;
                    const [hue, saturation, lightness] = rgbToHsl(
                        pixels[index], pixels[index + 1], pixels[index + 2],
                    );
                    if (saturation <= 20 || lightness < 30 || lightness > 80) continue;
                    if (saturation > bestSaturation) { bestHue = hue; bestSaturation = saturation; }
                    red += pixels[index];
                    green += pixels[index + 1];
                    blue += pixels[index + 2];
                    count += 1;
                }
                if (bestHue !== null) resolve(hslToRgb(bestHue, 75, 55));
                else if (count) {
                    const [hue, saturation, lightness] = rgbToHsl(red / count, green / count, blue / count);
                    resolve(hslToRgb(hue, saturation, Math.max(40, Math.min(70, lightness))));
                } else resolve(null);
            } catch (error) {
                console.warn('[AgentRenderer] Avatar color extraction failed:', error.message || error);
                resolve(null);
            }
        };
        image.onerror = () => resolve(null);
        image.src = imageUrl;
    });
    avatarColorCache.set(cacheKey, color);
    return color;
}

export { avatarColorCache, getDominantAvatarColor, hslToRgb, rgbToHsl };
