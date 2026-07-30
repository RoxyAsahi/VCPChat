import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { rustSourceRevision } from './rust-source-revision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = path.join(root, 'docs', 'agent-runtime', 'current');
const contractPath = path.join(current, 'product-readiness-contract.json');
const verdictPath = path.join(current, 'product-readiness-verdict.json');
const requirePass = process.argv.includes('--require-pass');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const contract = readJson(contractPath);
const verdict = readJson(verdictPath);
if (contract.schema !== 'vcp.agent.product_readiness_contract.v1') {
  throw new Error(`unsupported readiness contract schema: ${contract.schema}`);
}
if (verdict.schema !== 'vcp.agent.product_readiness_verdict.v1') {
  throw new Error(`unsupported readiness verdict schema: ${verdict.schema}`);
}
if (verdict.contractVersion !== contract.version) {
  throw new Error('readiness verdict does not target the current contract version');
}

const gates = new Map(contract.gates.map((gate) => [gate.gateId, gate]));
const results = new Map(verdict.gateResults.map((result) => [result.gateId, result]));
if (gates.size !== contract.gates.length || results.size !== verdict.gateResults.length) {
  throw new Error('readiness gate IDs must be unique');
}
for (const gate of contract.gates) {
  const result = results.get(gate.gateId);
  if (!result) throw new Error(`missing readiness result for ${gate.gateId}`);
  if (!['pass', 'fail', 'pending', 'blocked'].includes(result.status)) {
    throw new Error(`invalid readiness status for ${gate.gateId}: ${result.status}`);
  }
  if (result.status === 'pass' && (!Array.isArray(result.evidence) || result.evidence.length === 0)) {
    throw new Error(`passing gate ${gate.gateId} must include evidence`);
  }
}
for (const gateId of results.keys()) {
  if (!gates.has(gateId)) throw new Error(`verdict contains unknown gate ${gateId}`);
}

const currentRevision = rustSourceRevision(root);
const blockingResults = contract.gates
  .filter((gate) => gate.blocking)
  .map((gate) => results.get(gate.gateId));
const allBlockingPass = blockingResults.every((result) => result.status === 'pass');
const expectedVerdict = allBlockingPass ? 'READY' : 'NOT_READY';
if (verdict.overallVerdict !== expectedVerdict) {
  throw new Error(`overallVerdict must be ${expectedVerdict}`);
}
if (requirePass) {
  if (!allBlockingPass) throw new Error('blocking readiness gates are not all pass');
  if (verdict.rustSourceRevision !== currentRevision) {
    throw new Error(`readiness revision drift: verdict=${verdict.rustSourceRevision} current=${currentRevision}`);
  }
}

console.log(JSON.stringify({
  contractVersion: contract.version,
  overallVerdict: verdict.overallVerdict,
  rustSourceRevision: currentRevision,
  blockingGates: blockingResults.map(({ gateId, status }) => ({ gateId, status })),
}, null, 2));
