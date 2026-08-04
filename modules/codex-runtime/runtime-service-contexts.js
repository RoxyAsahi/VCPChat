'use strict';

function createRuntimeServiceContext(service, capabilities) {
    if (!service || typeof service !== 'string') throw new TypeError('Runtime service context requires a name');
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        throw new TypeError(`${service} capabilities must be an object`);
    }
    if (Object.prototype.hasOwnProperty.call(capabilities, 'manager')
        || Object.prototype.hasOwnProperty.call(capabilities, 'runtime')) {
        throw new TypeError(`${service} context cannot expose Runtime Manager authority`);
    }
    const authority = Object.freeze({ ...capabilities });
    const context = Object.create(authority);
    Object.defineProperties(context, {
        service: { value: service, enumerable: true },
        capabilityNames: { value: Object.freeze(Object.keys(authority)), enumerable: true },
    });
    return Object.freeze(context);
}

module.exports = { createRuntimeServiceContext };
