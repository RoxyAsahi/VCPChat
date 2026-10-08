// modules/services/agentPortraitImages.js
// 侧栏首页立绘的显示用图：原图很大时（几千像素的插画、相机照片）在缓存目录里生成一张够显示用的缩小图，
// 渲染进程只解码缩小图，切换助手时不会因为解码几十 MB 的位图卡住界面、占掉上百 MB 内存。
// 小图、动图和读不出来的文件原样返回（读不出来的交给界面退回圆头像）。
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// 立绘顶部铺满侧栏宽度、高 248px：宽 1600 够 800px 宽的侧栏在 2 倍缩放下用，高至少 600 给横图留够
const DISPLAY_WIDTH = 1600;
const DISPLAY_HEIGHT = 600;
const pending = new Map();
// 已确认不用缩小的原图（按路径、修改时间和大小记），免得每次都读一遍图片头
const keepOriginal = new Set();

function cacheKey(filePath, stat) {
    const hash = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 20);
    return { prefix: `${hash}-`, name: `${hash}-${Math.round(stat.mtimeMs)}-${stat.size}.webp` };
}

async function createDisplayImage(filePath, target, prefix) {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    if (!meta.width || !meta.height || (meta.pages || 1) > 1) return null;
    const scale = Math.max(DISPLAY_WIDTH / meta.width, DISPLAY_HEIGHT / meta.height);
    if (scale >= 1) return null;
    await fs.ensureDir(path.dirname(target));
    const temp = `${target}.${process.pid}.tmp`;
    await sharp(filePath)
        .rotate()
        .resize(Math.round(meta.width * scale), Math.round(meta.height * scale))
        .webp({ quality: 88, alphaQuality: 100 })
        .toFile(temp);
    await fs.move(temp, target, { overwrite: true });
    // 同一张原图换过以后，旧的缩小图就没用了
    const dir = path.dirname(target);
    const stale = (await fs.readdir(dir).catch(() => [])).filter(name => name.startsWith(prefix) && name !== path.basename(target));
    await Promise.all(stale.map(name => fs.remove(path.join(dir, name)).catch(() => {})));
    return target;
}

/** 返回该显示的文件路径：需要缩小时是缓存里的缩小图，否则就是原图 */
async function resolvePortraitDisplayPath(filePath, stat, cacheDir) {
    if (!cacheDir) return filePath;
    const { prefix, name } = cacheKey(filePath, stat);
    const target = path.join(cacheDir, name);
    if (keepOriginal.has(name)) return filePath;
    if (await fs.pathExists(target)) return target;
    if (!pending.has(target)) {
        const job = createDisplayImage(filePath, target, prefix)
            .then((result) => {
                if (!result) keepOriginal.add(name);
                return result;
            })
            .catch((error) => {
                console.warn('[AgentPortrait] Failed to prepare display image:', filePath, error?.message || error);
                keepOriginal.add(name);
                return null;
            })
            .finally(() => pending.delete(target));
        pending.set(target, job);
    }
    return (await pending.get(target)) || filePath;
}

module.exports = { resolvePortraitDisplayPath, DISPLAY_WIDTH, DISPLAY_HEIGHT };
