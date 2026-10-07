// Runs the everyday behavior and safety regression suite. Release-only workflow,
// packaging-policy, browser, and implementation-shape checks remain available through
// named npm scripts or direct `node test/<file>` runs instead of blocking every change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVERYDAY_TEST_FILES } from './everyday-manifest.js';
import { runTestProcess } from './helpers/run-test-process.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');

const infrastructureFiles = new Set([
  'check-js.mjs',
  'run-tests.mjs',
  'run-repository-intelligence-tests.mjs'
]);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflowDir = path.join(root, '.github', 'workflows');
const workflowSources = fs.readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/i.test(name))
  .map(name => fs.readFileSync(path.join(workflowDir, name), 'utf8'));
const reachableScriptCommands = collectReachableScriptCommands(packageJson.scripts || {}, workflowSources);
const gateSources = [...workflowSources, ...reachableScriptCommands].join('\n');
const repositoryRunner = fs.readFileSync(path.join(testDir, 'run-repository-intelligence-tests.mjs'), 'utf8');
const repositoryPattern = /^(?:repository-|intelligence-).+\.mjs$/;

function collectReachableScriptCommands(scripts, workflowSources) {
  const pending = [];
  const seen = new Set();
  const commands = [];
  const enqueueReferences = source => {
    for (const match of String(source || '').matchAll(/\bnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g)) {
      if (typeof scripts[match[1]] === 'string' && !seen.has(match[1])) pending.push(match[1]);
    }
  };
  for (const source of workflowSources) enqueueReferences(source);
  while (pending.length) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const command = String(scripts[name] || '');
    if (!command) continue;
    commands.push(command);
    enqueueReferences(command);
  }
  return commands;
}

const eligibleFiles = fs.readdirSync(testDir)
  .filter(name => {
    if (!name.endsWith('.mjs') || infrastructureFiles.has(name)) return false;
    if (repositoryPattern.test(name) || repositoryRunner.includes(`'${name}'`) || repositoryRunner.includes(`"${name}"`)) return false;
    return !gateSources.includes(`test/${name}`);
  })
  .sort((left, right) => left.localeCompare(right));
const manifestFiles = [...EVERYDAY_TEST_FILES];
const manifestSet = new Set(manifestFiles);
if (manifestSet.size !== manifestFiles.length) {
  throw new Error('test/everyday-manifest.js contains duplicate entries.');
}
const missingFiles = manifestFiles.filter(name => !fs.existsSync(path.join(testDir, name)));
if (missingFiles.length) {
  throw new Error(`Everyday test manifest references missing files: ${missingFiles.join(', ')}`);
}
const eligibleSet = new Set(eligibleFiles);
const staleEntries = manifestFiles.filter(name => !eligibleSet.has(name));
if (staleEntries.length) {
  throw new Error(`Everyday test manifest contains files owned by another gate or runner: ${staleEntries.join(', ')}`);
}
const unclassifiedFiles = eligibleFiles.filter(name => !manifestSet.has(name));
if (unclassifiedFiles.length) {
  throw new Error(
    `Unclassified everyday test files: ${unclassifiedFiles.join(', ')}. ` +
    'Add the behavior to an existing suite-*-unit.mjs file, or explicitly register a standalone isolation test in everyday-manifest.js.'
  );
}
const files = manifestFiles.slice().sort((left, right) => left.localeCompare(right));

const serialFiles = new Set([
  'http-auth-smoke.mjs',
  'http-smoke.mjs',
  'smoke.mjs',
  'process-manager-unit.mjs',
  'multi-chat-mcp-integration.mjs',
  'work-finish-queue-timeout-unit.mjs',
  'workspace-recovery-unit.mjs',
  'workflow-process-reuse-unit.mjs',
  'process-pty-unit.mjs',
  'suite-config-io-unit.mjs',
  'suite-release-build-unit.mjs',
  'suite-runtime-core-unit.mjs'
]);
const parallelEntries = files
  .map((name, index) => ({ name, index }))
  .filter(({ name }) => !serialFiles.has(name));
const serialEntries = files
  .map((name, index) => ({ name, index }))
  .filter(({ name }) => serialFiles.has(name));
const requestedJobs = Number.parseInt(process.env.REL_AI_TEST_JOBS || '', 10);
const availableJobs = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
const jobCount = Math.min(parallelEntries.length, Number.isFinite(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.min(4, availableJobs));
const suiteStarted = Date.now();
const results = new Array(files.length);
let nextIndex = 0;
let cleanupUncertain = false;

await Promise.all(Array.from({ length: jobCount }, async () => {
  while (!cleanupUncertain) {
    const queueIndex = nextIndex;
    nextIndex += 1;
    if (queueIndex >= parallelEntries.length) return;
    await runEntry(parallelEntries[queueIndex]);
  }
}));
for (const entry of serialEntries) {
  if (cleanupUncertain) break;
  await runEntry(entry);
}
for (const [index, name] of files.entries()) {
  if (!results[index]) results[index] = { name, durationMs: 0, exitCode: null,
    error: new Error('Not run because a previous test has unconfirmed process-tree cleanup.') };
}

async function runEntry({ name, index }) {
  const started = Date.now();
  console.log(`RUN ${name}`);
  const result = await runTest(name);
  const durationMs = Date.now() - started;
  results[index] = { name, durationMs, ...result };
  if (result.terminationUncertain) cleanupUncertain = true;
  const seconds = (durationMs / 1000).toFixed(1);
  if (result.exitCode === 0) {
    console.log(`PASS ${name} (${seconds}s)`);
  } else {
    console.error(`FAIL ${name} (${seconds}s)`);
    if (result.error) console.error(result.error.message);
    if (result.stdoutTruncated || result.stderrTruncated) console.error('Test output exceeded the retained 1 MiB per-stream tail; earlier output was omitted.');
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
  }
}

const failures = results.filter(result => result.exitCode !== 0);

function runTest(name) {
  return runTestProcess(process.execPath, [path.join(testDir, name)], { cwd: root });
}

const suiteSeconds = ((Date.now() - suiteStarted) / 1000).toFixed(1);
const slowest = [...results]
  .sort((left, right) => right.durationMs - left.durationMs)
  .slice(0, Math.min(5, results.length))
  .map(result => `${result.name} ${(result.durationMs / 1000).toFixed(1)}s`)
  .join(', ');
console.log(`\n${files.length - failures.length}/${files.length} everyday test executables passed in ${suiteSeconds}s with ${jobCount} worker${jobCount === 1 ? '' : 's'}.`);
if (slowest) console.log(`Slowest: ${slowest}`);
if (failures.length) {
  console.error(`Failed: ${failures.map(result => result.name).join(', ')}`);
  process.exit(1);
}
