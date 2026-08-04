'use strict';

const path = require('path');

const BRIDGE_WORKSPACE_RELATIVE = path.join('rust', 'toolbox-bridge');
const BRIDGE_MANIFEST_RELATIVE = path.join(BRIDGE_WORKSPACE_RELATIVE, 'Cargo.toml');
const BRIDGE_BINARY_NAME = process.platform === 'win32'
    ? 'vcp-toolbox-bridge.exe'
    : 'vcp-toolbox-bridge';
const BRIDGE_RELEASE_RELATIVE = path.join(
    BRIDGE_WORKSPACE_RELATIVE, 'target', 'release', BRIDGE_BINARY_NAME,
);

function developmentBridgePath(projectRoot) {
    return path.join(projectRoot, BRIDGE_RELEASE_RELATIVE);
}

function packagedBridgePath(resourcesPath) {
    return resourcesPath ? path.join(resourcesPath, BRIDGE_BINARY_NAME) : null;
}

module.exports = {
    BRIDGE_BINARY_NAME,
    BRIDGE_MANIFEST_RELATIVE,
    BRIDGE_RELEASE_RELATIVE,
    BRIDGE_WORKSPACE_RELATIVE,
    developmentBridgePath,
    packagedBridgePath,
};
