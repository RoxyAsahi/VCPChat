import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODEX_VERSION = '0.146.0';
const CODEX_VERSION_LINE = '0.146';
const RELEASE_TAG = 'rust-v0.146.0';
const SOURCE_REVISION = 'e363b08c9175ac1cbe5893615dd2cb9ddf95043b';
const NPM_INTEGRITY = 'sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==';
const CHECK_ONLY = process.argv.includes('--check');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'codex-app-server', CODEX_VERSION);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `vcp-codex-schema-${CODEX_VERSION}-`));
const selectedJsonFiles = [
    'ClientNotification.json',
    'ClientRequest.json',
    'ServerNotification.json',
    'ServerRequest.json',
    'codex_app_server_protocol.schemas.json',
    'codex_app_server_protocol.v2.schemas.json',
];

function codexCommand() {
    const local = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');
    if (fs.existsSync(local)) return { command: local, prefix: [] };
    return {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        prefix: ['-y', `@openai/codex@${CODEX_VERSION}`],
    };
}

function runCodex(args) {
    const launch = codexCommand();
    const result = spawnSync(launch.command, [...launch.prefix, ...args], {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        shell: process.platform === 'win32' && launch.command.toLowerCase().endsWith('.cmd'),
    });
    if (result.status !== 0) {
        throw new Error(`Codex schema command failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
    }
    return String(result.stdout || '').trim();
}

function walkFiles(root) {
    const result = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile()) result.push(absolute);
        }
    };
    visit(root);
    return result.sort((left, right) => left.localeCompare(right));
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(content) {
    return Buffer.from(`${JSON.stringify(canonicalize(JSON.parse(content.toString('utf8'))), null, 2)}\n`);
}

function treeReceipt(root, { canonicalJsonFiles = false } = {}) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const files = walkFiles(root);
    for (const file of files) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        let content = fs.readFileSync(file);
        if (canonicalJsonFiles && path.extname(file).toLowerCase() === '.json') content = canonicalJson(content);
        bytes += content.length;
        hash.update(relative);
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
    }
    return { fileCount: files.length, bytes, sha256: hash.digest('hex') };
}

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function collectPropertyEnums(value, propertyName, result = new Set()) {
    if (!value || typeof value !== 'object') return result;
    const property = value.properties?.[propertyName];
    if (Array.isArray(property?.enum)) {
        for (const item of property.enum) result.add(item);
    }
    for (const child of Object.values(value)) collectPropertyEnums(child, propertyName, result);
    return result;
}

function readJson(root, relativePath) {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function methodInventory(root) {
    const collect = (file) => [...collectPropertyEnums(readJson(root, file), 'method')].sort();
    const itemSchema = readJson(root, 'v2/ItemStartedNotification.json');
    const items = [];
    for (const option of itemSchema.definitions?.ThreadItem?.oneOf || []) {
        for (const item of option.properties?.type?.enum || []) items.push(item);
    }
    return {
        clientNotifications: collect('ClientNotification.json'),
        clientRequests: collect('ClientRequest.json'),
        serverNotifications: collect('ServerNotification.json'),
        serverRequests: collect('ServerRequest.json'),
        threadItems: [...new Set(items)].sort(),
    };
}

function writeOrCheck(relativePath, content) {
    const target = path.join(fixtureRoot, relativePath);
    if (CHECK_ONLY) {
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
            throw new Error(`Codex schema fixture is stale: ${path.relative(projectRoot, target)}`);
        }
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

try {
    const reportedVersion = runCodex(['--version']);
    if (!reportedVersion.includes(CODEX_VERSION)) {
        throw new Error(`Expected Codex ${CODEX_VERSION}, received: ${reportedVersion || '(empty version output)'}`);
    }

    const generated = {};
    for (const mode of ['stable', 'experimental']) {
        const jsonRoot = path.join(tempRoot, mode, 'json');
        const typescriptRoot = path.join(tempRoot, mode, 'typescript');
        fs.mkdirSync(jsonRoot, { recursive: true });
        fs.mkdirSync(typescriptRoot, { recursive: true });
        const experimental = mode === 'experimental' ? ['--experimental'] : [];
        runCodex(['app-server', 'generate-json-schema', '--out', jsonRoot, ...experimental]);
        runCodex(['app-server', 'generate-ts', '--out', typescriptRoot, ...experimental]);

        const selected = {};
        for (const relativePath of selectedJsonFiles) {
            const content = canonicalJson(fs.readFileSync(path.join(jsonRoot, relativePath)));
            writeOrCheck(path.join(mode, relativePath), content);
            selected[relativePath] = { bytes: content.length, sha256: sha256(content) };
        }
        generated[mode] = {
            inventory: methodInventory(jsonRoot),
            jsonTree: treeReceipt(jsonRoot, { canonicalJsonFiles: true }),
            selectedJson: selected,
            typescriptTree: treeReceipt(typescriptRoot),
        };
    }

    const manifest = {
        schemaVersion: 1,
        protocol: 'codex-app-server-jsonl',
        codexVersion: CODEX_VERSION,
        codexVersionLine: CODEX_VERSION_LINE,
        releaseTag: RELEASE_TAG,
        sourceRevision: SOURCE_REVISION,
        npmPackage: '@openai/codex',
        npmIntegrity: NPM_INTEGRITY,
        generatedCommands: {
            stable: [
                `codex app-server generate-json-schema --out DIR`,
                `codex app-server generate-ts --out DIR`,
            ],
            experimental: [
                `codex app-server generate-json-schema --out DIR --experimental`,
                `codex app-server generate-ts --out DIR --experimental`,
            ],
        },
        generated,
    };
    writeOrCheck('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    console.log(`Codex App Server ${CODEX_VERSION} schema fixtures ${CHECK_ONLY ? 'match' : 'updated'}.`);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
