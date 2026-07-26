'use strict';

const DistributedServer = require('../VCPDistributedServer/VCPDistributedServer.js');

const mainServerUrl = process.env.VCP_SERVER_URL;
const vcpKey = process.env.VCP_API_KEY;
if (!mainServerUrl || !vcpKey) throw new Error('VCP_SERVER_URL and VCP_API_KEY are required');

const server = new DistributedServer({
    mainServerUrl: mainServerUrl.replace(/\/v1\/chat\/completions\/?$/, ''),
    vcpKey,
    serverName: 'VCPAgentLiveLongTaskVerification',
    port: 0,
});

server.initialize().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});

async function stop() {
    await server.stop().catch(() => {});
    process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
