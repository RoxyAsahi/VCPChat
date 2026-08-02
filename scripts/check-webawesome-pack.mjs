// check-webawesome-pack — verifies the vendored Web Awesome runtime resolves
// inside the packaged app, not just in the repo.
//
// Usage:
//   node scripts/check-webawesome-pack.mjs              # validates repo vendor tree
//   node scripts/check-webawesome-pack.mjs --root <unpacked-app-resources>
//
// When --root points at a packaged layout (electron-builder's resources dir),
// the same file set must be present and every relative import inside the
// dist-cdn build must resolve on disk — so a missing chunk never reaches a
// shipped installer.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const packagedRoot = rootIndex !== -1 ? args[rootIndex + 1] : null;

const vendorBase = path.join(root, 'vendor', 'webawesome');
const failures = [];

function check(file, message) {
    failures.push(`${path.relative(root, file)}: ${message}`);
}

function isJsOrCss(file) {
    return /\.(js|css)$/i.test(file);
}

function relativeImports(sourceDir, source) {
    const imports = [];
    const patterns = [
        /(?:from\s+|import\s*\()['"](\.\.?\/[^'"\n]+)['"]/g,
        /@import\s+['"](\.\.?\/[^'"\n]+)['"]/g,
        /url\(\s*['"]?(\.\.?\/[^'")]+)['"]?\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) imports.push(match[1]);
    }
    return imports;
}

function validateTree(baseDir) {
    if (!fs.existsSync(baseDir)) {
        failures.push(`${path.relative(root, baseDir)}: Web Awesome vendor tree is missing from the packaged output`);
        return;
    }
    const expected = [
        'dist-cdn/components/button/button.js',
        'dist-cdn/components/input/input.js',
        'dist-cdn/components/select/select.js',
        'dist-cdn/components/dialog/dialog.js',
        'dist-cdn/components/tooltip/tooltip.js',
        'dist-cdn/components/option/option.js',
        'dist-cdn/styles/themes/default.css',
    ];
    for (const relative of expected) {
        const target = path.join(baseDir, relative);
        if (!fs.existsSync(target)) check(path.join(baseDir, relative), 'required file is missing from the packaged output');
    }
    if (failures.length > 10) return;

    // Every relative import inside the vendored dist-cdn must resolve locally.
    for (const entry of fs.readdirSync(baseDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !isJsOrCss(entry.name)) continue;
        const file = path.join(entry.parentPath, entry.name);
        const source = fs.readFileSync(file, 'utf8');
        for (const specifier of relativeImports(path.dirname(file), source)) {
            const resolved = path.resolve(path.dirname(file), specifier);
            if (!fs.existsSync(resolved)) check(file, `unresolved relative import "${specifier}"`);
        }
    }
}

const versionFile = packagedRoot ? path.join(packagedRoot, 'vendor', 'webawesome', 'package.json') : path.join(vendorBase, 'package.json');
if (fs.existsSync(versionFile)) {
    const version = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
    if (version !== '3.11.0') check(versionFile, `Web Awesome must remain pinned to 3.11.0, found ${version}`);
} else {
    failures.push(`${path.relative(root, versionFile)}: package.json missing`);
}

validateTree(packagedRoot ? path.join(packagedRoot, 'vendor', 'webawesome') : vendorBase);

if (failures.length) {
    console.error('Web Awesome packaging check failed:\n');
    [...new Set(failures)].slice(0, 40).forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
}

const mode = packagedRoot ? `packaged output at ${packagedRoot}` : 'repo vendor tree';
console.log(`Web Awesome packaging check passed (${mode}).`);
