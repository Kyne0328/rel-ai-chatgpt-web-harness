import fs from 'node:fs';
import path from 'node:path';
import * as asar from '@electron/asar';
import { fileURLToPath } from 'node:url';
import { resolveCurrentUnpackedFromDist } from './current-unpacked.mjs';
import { electronPlatformSpec, normalizeElectronPlatform } from './electron-platform.mjs';
import { releaseArtifactNames } from './release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(input = process.argv.slice(2)) {
  const options = parseArguments(input);
  const report = buildPackageSizeReport(options);
  printReport(report);
  if (options.jsonPath) {
    const outputPath = path.resolve(root, options.jsonPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Package-size report written to ${path.relative(root, outputPath) || outputPath}.`);
  }
  if (report.violations.length) process.exitCode = 1;
  return report;
}

function parseArguments(input) {
  if (input.includes('--strict')) throw new Error('--strict was removed; ordinary package-size drift is advisory and structural/emergency guards are always enforced.');
  const valueAfter = (name, fallback = '') => {
    const index = input.indexOf(name);
    return index >= 0 ? String(input[index + 1] || fallback) : fallback;
  };
  return {
    distDir: valueAfter('--dir', 'dist'),
    platform: normalizeElectronPlatform(valueAfter('--platform', process.platform)),
    baselinePath: valueAfter('--baseline', ''),
    jsonPath: valueAfter('--json', '')
  };
}

function buildPackageSizeReport(options) {
  const distDir = path.resolve(root, options.distDir);
  const packageJson = readJson(path.join(root, 'package.json'));
  const version = String(packageJson.version || '').trim();
  const platform = normalizeElectronPlatform(options.platform || process.platform);
  const spec = electronPlatformSpec(platform);
  const unpackedDir = resolveCurrentUnpackedFromDist(distDir, { platform });
  const resourcesDir = path.join(unpackedDir, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  requireDirectory(unpackedDir, `Packaged ${spec.unpackedDirectory} directory`);
  requireDirectory(resourcesDir, 'Packaged resources directory');
  requireFile(asarPath, 'Packaged app.asar');

  const topLevelFiles = fs.readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(distDir, entry.name));
  const canonical = releaseArtifactNames(version);
  const artifactMetrics = platform === 'win32'
    ? windowsArtifactMetrics(topLevelFiles, canonical)
    : linuxArtifactMetrics(topLevelFiles, canonical);

  const localeDir = path.join(unpackedDir, 'locales');
  const localeFiles = listFiles(localeDir);
  const sourceCssFiles = listFiles(path.join(resourcesDir, 'src')).filter(file => file.toLowerCase().endsWith('.css'));
  const asar = inspectAsar(asarPath);
  const allUnpackedFiles = listFiles(unpackedDir);
  const metrics = {
    ...artifactMetrics,
    unpackedBytes: sumFileSizes(allUnpackedFiles),
    resourcesBytes: sumFileSizes(listFiles(resourcesDir)),
    appAsarBytes: fileSize(asarPath),
    packagedDependencyBytes: asar.nodeModulesBytes,
    webAutomationBytes: sumFileSizes(listFiles(path.join(resourcesDir, 'node_modules', 'playwright-core'))),
    localesBytes: sumFileSizes(localeFiles),
    tunnelClientBytes: fileSize(path.join(resourcesDir, 'bin', 'tunnel-client', spec.tunnelClientDirectory, spec.tunnelClientFile)),
    zoektBytes: sumFileSizes(listFiles(path.join(resourcesDir, 'bin', 'zoekt', platform))),
    treeSitterBytes: sumFileSizes(listFiles(path.join(resourcesDir, 'node_modules', 'web-tree-sitter')))
      + sumFileSizes(listFiles(path.join(resourcesDir, 'vendor', 'tree-sitter'))),
    dashboardCssBytes: fileSize(path.join(resourcesDir, 'public', 'dashboard.css'))
  };
  const content = {
    localeCount: localeFiles.length,
    locales: localeFiles.map(file => path.basename(file)).sort(),
    sourceCssCount: sourceCssFiles.length,
    sourceCssFiles: sourceCssFiles.map(file => relativeTo(resourcesDir, file)),
    asarSourceMapCount: asar.sourceMapCount,
    asarSourceMapBytes: asar.sourceMapBytes,
    largestFiles: allUnpackedFiles
      .map(file => ({ path: relativeTo(unpackedDir, file), bytes: fileSize(file) }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20)
  };

  const baseline = options.baselinePath ? readBaseline(path.resolve(root, options.baselinePath)) : null;
  if (baseline?.platform && normalizeElectronPlatform(baseline.platform) !== platform) {
    throw new Error(`Package-size baseline targets ${baseline.platform}, not ${platform}.`);
  }
  const comparison = compareMetrics(metrics, baseline);
  const warnings = [];
  const violations = [];
  if (content.localeCount !== 1 || content.locales[0] !== 'en-US.pak') {
    violations.push(`Expected only en-US.pak, found: ${content.locales.join(', ') || 'none'}.`);
  }
  // resources/src intentionally mirrors the complete runtime source tree. Source CSS is therefore
  // diagnostic size data, not a packaging violation; packaged-runtime-parity enforces exact-tree parity.
  if (content.asarSourceMapCount > 0) violations.push(`app.asar contains ${content.asarSourceMapCount} source map files.`);
  for (const item of comparison) {
    if (item.exceedsTolerance) warnings.push(`${item.metric} is ${item.deltaPercent.toFixed(2)}% above the measured baseline.`);
    if (item.exceedsBlockingGrowth) violations.push(`${item.metric} grew ${item.deltaPercent.toFixed(2)}%, above the ${baseline.blockingGrowthPercent}% emergency growth guard.`);
  }

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    version,
    platform,
    architecture: 'x64',
    buildHostPlatform: process.platform,
    buildHostArchitecture: process.arch,
    distDir: relativeTo(root, distDir),
    unpackedDir: relativeTo(root, unpackedDir),
    metrics,
    content,
    baseline: baseline ? {
      path: relativeTo(root, path.resolve(root, options.baselinePath)),
      capturedAt: baseline.capturedAt,
      policy: baseline.policy,
      tolerancePercent: baseline.tolerancePercent,
      blockingGrowthPercent: baseline.blockingGrowthPercent,
      blockingMetrics: baseline.blockingMetrics
    } : null,
    comparison,
    warnings,
    violations
  };
}

function inspectAsar(asarPath) {
  const entries = asar.listPackage(asarPath);
  let nodeModulesBytes = 0;
  let sourceMapBytes = 0;
  let sourceMapCount = 0;
  for (const entry of entries) {
    const archivePath = String(entry).replace(/^[/\\]+/, '');
    const normalized = archivePath.replaceAll('\\', '/');
    let stat;
    try {
      stat = asar.statFile(asarPath, archivePath, false);
    } catch {
      continue;
    }
    if (!Number.isFinite(stat?.size)) continue;
    if (normalized.startsWith('node_modules/')) nodeModulesBytes += stat.size;
    if (normalized.toLowerCase().endsWith('.map')) {
      sourceMapCount += 1;
      sourceMapBytes += stat.size;
    }
  }
  return { nodeModulesBytes, sourceMapCount, sourceMapBytes };
}

function readBaseline(file) {
  requireFile(file, 'Package-size baseline');
  const baseline = readJson(file);
  if (baseline.schemaVersion !== 2) throw new Error(`Unsupported package-size baseline schema: ${file}`);
  if (baseline.policy !== 'advisory') throw new Error(`Package-size baseline must declare an advisory policy: ${file}`);
  if (!Number.isFinite(baseline.tolerancePercent) || baseline.tolerancePercent < 0) {
    throw new Error(`Package-size baseline has an invalid advisory tolerance: ${file}`);
  }
  if (!Number.isFinite(baseline.blockingGrowthPercent) || baseline.blockingGrowthPercent <= baseline.tolerancePercent) {
    throw new Error(`Package-size baseline must declare a blockingGrowthPercent above its advisory tolerance: ${file}`);
  }
  if (!baseline.metrics || typeof baseline.metrics !== 'object') throw new Error(`Package-size baseline has no metrics object: ${file}`);
  if (!Array.isArray(baseline.blockingMetrics) || baseline.blockingMetrics.length === 0) {
    throw new Error(`Package-size baseline must declare aggregate blockingMetrics: ${file}`);
  }
  const unknownBlockingMetrics = baseline.blockingMetrics.filter(metric => !Object.hasOwn(baseline.metrics, metric));
  if (unknownBlockingMetrics.length > 0) {
    throw new Error(`Package-size baseline blockingMetrics are missing from metrics: ${unknownBlockingMetrics.join(', ')}.`);
  }
  return baseline;
}

function compareMetrics(metrics, baseline) {
  if (!baseline) return [];
  const threshold = Number(baseline.tolerancePercent || 0);
  const blockingThreshold = Number(baseline.blockingGrowthPercent || Number.POSITIVE_INFINITY);
  const blockingMetrics = new Set(Array.isArray(baseline.blockingMetrics) ? baseline.blockingMetrics : Object.keys(baseline.metrics || {}));
  return Object.entries(baseline.metrics).flatMap(([metric, baselineBytes]) => {
    const currentBytes = metrics[metric];
    if (!Number.isFinite(currentBytes) || !Number.isFinite(baselineBytes)) return [];
    const deltaBytes = currentBytes - baselineBytes;
    const deltaPercent = baselineBytes === 0 ? 0 : (deltaBytes / baselineBytes) * 100;
    return [{
      metric,
      baselineBytes,
      currentBytes,
      deltaBytes,
      deltaPercent,
      blocksRelease: blockingMetrics.has(metric),
      exceedsTolerance: deltaPercent > threshold,
      exceedsBlockingGrowth: blockingMetrics.has(metric) && deltaPercent > blockingThreshold
    }];
  });
}

function printReport(report) {
  console.log(`Electron package-size report for Rel.AI MCP ${report.version}`);
  for (const [metric, bytes] of Object.entries(report.metrics)) {
    console.log(`  ${metric.padEnd(26)} ${formatBytes(bytes)} (${bytes} bytes)`);
  }
  console.log(`  locales                    ${report.content.localeCount}: ${report.content.locales.join(', ') || 'none'}`);
  console.log(`  ASAR source maps           ${report.content.asarSourceMapCount}`);
  console.log(`  packaged source CSS        ${report.content.sourceCssCount}`);
  if (report.comparison.length) {
    console.log('Baseline comparison:');
    for (const item of report.comparison) {
      const sign = item.deltaBytes > 0 ? '+' : '';
      console.log(`  ${item.metric.padEnd(26)} ${sign}${formatBytes(item.deltaBytes)} (${sign}${item.deltaPercent.toFixed(2)}%)`);
    }
  }
  if (report.warnings.length) {
    console.warn('Package-size drift warnings:');
    for (const warning of report.warnings) console.warn(`  - ${warning}`);
  }
  if (report.violations.length) {
    console.error('Package-content or emergency-growth violations:');
    for (const violation of report.violations) console.error(`  - ${violation}`);
  } else {
    console.log('Package structure passed; ordinary size drift is informational.');
  }
}

function windowsArtifactMetrics(files, canonical) {
  const installerPath = findArtifact(files, canonical.installer);
  const portablePath = findArtifact(files, canonical.portable);
  requireFile(installerPath, 'NSIS installer');
  requireFile(portablePath, 'Portable executable');
  return {
    installerBytes: fileSize(installerPath),
    portableBytes: fileSize(portablePath)
  };
}

function linuxArtifactMetrics(files, canonical) {
  const appImagePath = findArtifact(files, canonical.linuxAppImage);
  const debPath = findArtifact(files, canonical.linuxDeb);
  requireFile(appImagePath, 'Linux AppImage');
  requireFile(debPath, 'Linux DEB package');
  return {
    appImageBytes: fileSize(appImagePath),
    debBytes: fileSize(debPath)
  };
}

function findArtifact(files, exactName) {
  return files.find(file => path.basename(file) === exactName) || '';
}

function listFiles(start) {
  if (!fs.existsSync(start)) return [];
  const files = [];
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function sumFileSizes(files) {
  return files.reduce((total, file) => total + fileSize(file), 0);
}

function fileSize(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.statSync(file).size : 0;
}

function requireFile(file, label) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is missing: ${file || '(not found)'}`);
}

function requireDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${label} is missing: ${dir}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function relativeTo(base, target) {
  return path.relative(base, target).replaceAll(path.sep, '/');
}

function formatBytes(bytes) {
  const absolute = Math.abs(Number(bytes || 0));
  const sign = Number(bytes) < 0 ? '-' : '';
  if (absolute >= 1024 ** 3) return `${sign}${(absolute / 1024 ** 3).toFixed(2)} GiB`;
  if (absolute >= 1024 ** 2) return `${sign}${(absolute / 1024 ** 2).toFixed(2)} MiB`;
  if (absolute >= 1024) return `${sign}${(absolute / 1024).toFixed(2)} KiB`;
  return `${sign}${absolute} B`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { buildPackageSizeReport, compareMetrics, main, parseArguments, readBaseline };
