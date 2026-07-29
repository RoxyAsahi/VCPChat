import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function requireLiveRustEnvironment() {
    if (process.env.VCP_AGENT_LIVE !== '1') {
        throw new Error('Real Rust Agent validation is opt-in. Set VCP_AGENT_LIVE=1 before running this command.');
    }
    const settingsPath = process.env.VCP_AGENT_SETTINGS_PATH || path.join(root, 'AppData', 'settings.json');
    let settings = {};
    try {
        settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch {
        throw new Error(`Live Rust Agent validation requires readable shared settings: ${settingsPath}`);
    }
    const configuredServerUrl = String(process.env.VCP_SERVER_URL || settings.vcpServerUrl || '').trim();
    const apiKey = String(process.env.VCP_API_KEY || settings.vcpApiKey || '').trim();
    if (!configuredServerUrl || !apiKey) throw new Error('Live Rust Agent validation requires a VCP Server URL and API Key.');
    let serverUrl;
    let modelsUrl;
    try {
        const configured = new URL(configuredServerUrl);
        configured.pathname = '/';
        configured.search = '';
        configured.hash = '';
        serverUrl = configured.toString().replace(/\/$/, '');
        modelsUrl = new URL('/v1/models', configured);
    } catch {
        throw new Error('Live Rust Agent validation requires a valid HTTP(S) VCP Server URL.');
    }
    const response = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
    }).catch((error) => { throw new Error(`Cannot reach VCPToolBox for live validation: ${error.message}`); });
    if (!response.ok) throw new Error(`VCPToolBox live validation preflight failed: HTTP ${response.status}`);
    return { serverUrl, apiKey, settingsPath };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    await requireLiveRustEnvironment();
    console.log('Live Rust Agent preflight passed.');
}
