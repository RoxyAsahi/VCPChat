'use strict';

// Stable Main-process facade. Runtime lifecycle and protocol implementation
// remain private so consumers cannot couple to service internals.
module.exports = require('./runtimeManagerImplementation');
