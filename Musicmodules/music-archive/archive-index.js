/*
 * 曲库检索索引：标题、歌手、专辑的即时匹配，支持拼音全拼和首字母、平假名片假名互通；
 * 同时给出每首歌按首字母归入的分组（A–Z、あ行…、0–9、其他）和组内排序键。
 * 汉字转拼音由外部传入的 pinyin(char) 提供（音乐窗口里用已有依赖按需加载），
 * 没有时汉字只按原文匹配、分组归到「其他」。不碰 DOM，方便在 node 里测试。
 */
(function (global) {
    'use strict';

    const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    const norm = (s) => toHiragana(String(s || '').normalize('NFKC').toLowerCase()).trim();
    const stripExt = (t) => String(t || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '');
    const HAN = /[㐀-䶿一-鿿豈-﫿]/;
    const LATIN = /[a-z]/;
    const DIGIT = /[0-9]/;
    const LEADING_JUNK = /^[\s\p{P}\p{S}]+/u;

    const KANA_ROWS = [
        ['あ', 'ぁあぃいぅうぇえぉおゔ'], ['か', 'かがきぎくぐけげこごゕゖ'], ['さ', 'さざしじすずせぜそぞ'],
        ['た', 'ただちぢっつづてでとど'], ['な', 'なにぬねの'], ['は', 'はばぱひびぴふぶぷへべぺほぼぽ'],
        ['ま', 'まみむめも'], ['や', 'ゃやゅゆょよ'], ['ら', 'らりるれろ'], ['わ', 'ゎわゐゑをん']
    ];
    const KANA_ROW_OF = new Map();
    KANA_ROWS.forEach(([row, chars]) => { for (const c of chars) KANA_ROW_OF.set(c, row); });

    /* 分组顺序：A–Z、あ行…わ行、0–9、其他 */
    const GROUP_ORDER = [
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
        ...KANA_ROWS.map(([row]) => row),
        '0-9', '#'
    ];
    const GROUP_RANK = new Map(GROUP_ORDER.map((g, i) => [g, i]));
    const groupName = (g) => (KANA_ROW_OF.has(g) ? g + '行' : g === '0-9' ? '0–9' : g === '#' ? '其他' : g);
    const groupRef = (g) => (KANA_ROW_OF.has(g) ? 'INDEX ' + g : g === '#' ? 'INDEX OTHERS' : 'INDEX ' + g);

    /*
     * pinyin: (char) => 'zhan' | ''。返回 { py, ini }：
     * py  = 全拼串（汉字换成拼音，其他字母数字原样，去掉空白和符号），
     * ini = 首字母串（汉字取拼音首字母，拉丁词取词首，假名和数字原样）。
     */
    const romanize = (text, pinyin) => {
        const s = norm(text);
        let py = '';
        let ini = '';
        let wordStart = true;
        for (const c of s) {
            if (HAN.test(c)) {
                const p = pinyin ? String(pinyin(c) || '').normalize('NFD').toLowerCase().replace(/[^a-z]/g, '') : '';
                if (p) { py += p; ini += p[0]; } else { py += c; ini += c; }
                wordStart = true;
            } else if (LATIN.test(c) || DIGIT.test(c)) {
                py += c;
                if (wordStart) ini += c;
                wordStart = false;
            } else if (KANA_ROW_OF.has(c) || /[぀-ゟー]/.test(c)) {
                py += c; ini += c; wordStart = true;
            } else {
                if (!/\s|\p{P}|\p{S}/u.test(c)) { py += c; ini += c; }
                wordStart = true;
            }
        }
        return { py, ini };
    };

    const groupOf = (title, pinyin) => {
        const s = norm(stripExt(title)).replace(LEADING_JUNK, '');
        const c = [...s][0] || '';
        if (!c) return '#';
        if (LATIN.test(c)) return c.toUpperCase();
        if (DIGIT.test(c)) return '0-9';
        if (KANA_ROW_OF.has(c)) return KANA_ROW_OF.get(c);
        if (HAN.test(c) && pinyin) {
            const p = String(pinyin(c) || '').normalize('NFD').toLowerCase();
            if (/^[a-z]/.test(p)) return p[0].toUpperCase();
        }
        return '#';
    };

    // 组内排序：数字按数值比（Song 2 在 Song 10 前面）
    const COLLATE = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare
        : (a, b) => (a < b ? -1 : a > b ? 1 : 0);

    const FIELDS = [['title', 3], ['artist', 2], ['album', 1]];

    const createIndex = (tracks, { pinyin = null } = {}) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const entries = list.map((t) => {
            const e = { group: groupOf(t && t.title, pinyin) };
            for (const [f] of FIELDS) {
                const raw = f === 'title' ? stripExt(t && t.title) : (t && t[f]) || '';
                const r = romanize(raw, pinyin);
                e[f] = norm(raw);
                e[f + 'Py'] = r.py;
                e[f + 'Ini'] = r.ini;
            }
            e.sort = e.titlePy || e.title;
            return e;
        });

        /* 一个词在一个字段上的得分；0 表示不匹配 */
        const termScore = (e, f, w, term, ascii) => {
            const v = e[f];
            if (v.startsWith(term)) return 100 * w;
            if (v.includes(term)) return 60 * w;
            if (ascii) {
                const py = e[f + 'Py'], ini = e[f + 'Ini'];
                if (py.startsWith(term)) return 45 * w;
                if (ini.startsWith(term)) return 40 * w;
                if (py.includes(term)) return 30 * w;
                if (ini.includes(term)) return 22 * w;
            } else {
                const ini = e[f + 'Ini'];
                if (ini.includes(term)) return 20 * w;
            }
            return 0;
        };

        /*
         * kind: 'all' | 'artist' | 'album'；only: 限定在这些曲库下标里（「最近」按传入顺序）。
         * 多个词（空格分开）都要匹配上；返回按得分排好的曲库下标。
         */
        const query = (q, { kind = 'all', only = null, limit = Infinity } = {}) => {
            const terms = norm(q).split(/\s+/).filter(Boolean);
            const fields = kind === 'artist' ? [['artist', 2]] : kind === 'album' ? [['album', 1]] : FIELDS;
            const pool = only ? only : entries.map((_, i) => i);
            if (!terms.length) return only ? pool.slice(0, limit) : [];
            const hits = [];
            pool.forEach((i, order) => {
                const e = entries[i];
                if (!e) return;
                let total = 0;
                for (const term of terms) {
                    const ascii = /^[a-z0-9]+$/.test(term);
                    let best = 0;
                    for (const [f, w] of fields) best = Math.max(best, termScore(e, f, w, term, ascii));
                    if (!best) return;
                    total += best;
                }
                hits.push({ i, total, order });
            });
            hits.sort((a, b) => b.total - a.total || a.order - b.order);
            return hits.slice(0, limit).map((h) => h.i);
        };

        return {
            size: entries.length,
            group: (i) => (entries[i] ? entries[i].group : '#'),
            sortKey: (i) => (entries[i] ? entries[i].sort : ''),
            query
        };
    };

    const familyOf = (g) => (/^[A-Z]$/.test(g) ? 'latin' : KANA_ROW_OF.has(g) ? 'kana' : g);
    const mergedName = (a, b) => {
        if (a === b) return groupName(a);
        if (familyOf(a) === 'kana') return a + '–' + b + '行';
        return a + '–' + b;
    };

    /*
     * 按首字母分好的组，组内按排序键排；只返回有歌的组。
     * minSize > 1 时，同一类（拉丁字母、假名行）里歌太少的相邻组合并成「X–Z」这样的一列，免得一列只有一两张卡。
     * 返回的每列带 groups（包含的首字母），方便从首字母找到所在列。
     */
    const groupColumns = (index, indices, { minSize = 1 } = {}) => {
        const groups = new Map();
        for (const i of indices) {
            const g = index.group(i);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(i);
        }
        const ordered = [...groups.entries()].sort((a, b) => (GROUP_RANK.get(a[0]) ?? 999) - (GROUP_RANK.get(b[0]) ?? 999));
        const runs = [];
        for (const [g, items] of ordered) {
            const last = runs[runs.length - 1];
            if (last && familyOf(last.groups[0]) === familyOf(g) && last.items.length < minSize) {
                last.groups.push(g); last.items.push(...items);
            } else {
                runs.push({ groups: [g], items: [...items] });
            }
        }
        // 每一类最后一段还是太少，就并到同一类的前一段
        for (let k = runs.length - 1; k > 0; k--) {
            const cur = runs[k], prev = runs[k - 1];
            if (cur.items.length < minSize && familyOf(prev.groups[0]) === familyOf(cur.groups[0])) {
                prev.groups.push(...cur.groups); prev.items.push(...cur.items); runs.splice(k, 1);
            }
        }
        const byTitle = (a, b) => COLLATE(index.sortKey(a), index.sortKey(b)) || a - b;
        return runs.map(({ groups: gs, items }) => {
            const first = gs[0], lastG = gs[gs.length - 1];
            const single = gs.length === 1;
            return {
                id: 'letter:' + (single ? first : first + '-' + lastG),
                kind: 'letter',
                group: first,
                groups: gs,
                name: single ? groupName(first) : mergedName(first, lastG),
                ref: single ? groupRef(first) : 'INDEX ' + first + '–' + lastG,
                items: items.sort(byTitle)
            };
        });
    };

    /*
     * 目录列表的行：{ type: 'head', label, key } 或 { type: 'track', i, ctx }。
     * ctx 是这一行在阵列里对应的列 id（选中时相机跟到那一列）。
     * kind: all | artist | album | playlist | recent。有检索词时 all 按得分排成一组。
     * columnOfGroup(g)：首字母分组对应的列 id（阵列按首字母拆列时用），没有就用 'all'。
     */
    const listRows = ({ tracks, playlists = [], recent = [], index, kind = 'all', query = '', columnOfGroup = null }) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const q = String(query || '').trim();
        const rows = [];
        let count = 0;
        const head = (label, key, n) => rows.push({ type: 'head', label, key, n });
        const push = (i, ctx) => { rows.push({ type: 'track', i, ctx }); count++; };
        const allCtx = (i) => (columnOfGroup ? columnOfGroup(index.group(i)) : 'all');
        const byTitle = (a, b) => COLLATE(index.sortKey(a), index.sortKey(b)) || a - b;

        if (kind === 'recent') {
            const pool = recent.filter((i) => i >= 0 && i < list.length);
            const hits = q ? index.query(q, { only: pool }) : pool;
            if (hits.length) head('最近播放', 'recent', hits.length);
            hits.forEach((i) => push(i, 'recent'));
            return { rows, count };
        }
        if (kind === 'playlist') {
            const byPath = new Map();
            list.forEach((t, i) => { const k = String(t && t.path || '').replace(/\\/g, '/').toLowerCase(); if (k && !byPath.has(k)) byPath.set(k, i); });
            (playlists || []).forEach((pl, order) => {
                if (!pl) return;
                const items = (pl.tracks || []).map((p) => byPath.get(String(p || '').replace(/\\/g, '/').toLowerCase())).filter((i) => i !== undefined);
                const nameHit = q && norm(pl.name).includes(norm(q));
                const hits = !q || nameHit ? items : index.query(q, { only: items });
                if (!hits.length) return;
                const id = 'playlist:' + (pl.id ?? order);
                head(String(pl.name || '未命名歌单'), id, hits.length);
                hits.forEach((i) => push(i, id));
            });
            return { rows, count };
        }
        if (kind === 'artist' || kind === 'album') {
            const field = kind;
            const pool = q ? index.query(q, { kind: field }) : list.map((_, i) => i);
            const groups = new Map();
            for (const i of pool) {
                const name = String(list[i] && list[i][field] || '').trim() || (field === 'artist' ? '未知歌手' : '未知专辑');
                if (!groups.has(name)) groups.set(name, []);
                groups.get(name).push(i);
            }
            const sortName = (n) => romanize(n, null).py;
            [...groups.entries()]
                .sort((a, b) => (q ? 0 : sortName(a[0]).localeCompare(sortName(b[0]))))
                .forEach(([name, items]) => {
                    const ctx = field === 'album' ? 'album:' + name : null;
                    head(name, field + ':' + name, items.length);
                    (q ? items : items.sort(byTitle)).forEach((i) => push(i, ctx || allCtx(i)));
                });
            return { rows, count };
        }
        // all
        if (q) {
            const hits = index.query(q);
            if (hits.length) head('检索结果', 'search', hits.length);
            hits.forEach((i) => push(i, allCtx(i)));
            return { rows, count };
        }
        const groups = new Map();
        list.forEach((_, i) => {
            const g = index.group(i);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(i);
        });
        [...groups.entries()]
            .sort((a, b) => (GROUP_RANK.get(a[0]) ?? 999) - (GROUP_RANK.get(b[0]) ?? 999))
            .forEach(([g, items]) => {
                head(groupName(g), 'letter:' + g, items.length);
                items.sort(byTitle).forEach((i) => push(i, allCtx(i)));
            });
        return { rows, count };
    };

    const api = Object.freeze({ norm, toHiragana, romanize, groupOf, groupName, createIndex, groupColumns, listRows, GROUP_ORDER });
    if (typeof module === 'object' && module.exports) module.exports = api;
    global.MusicArchiveIndex = api;
})(typeof window !== 'undefined' ? window : globalThis);
