import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

if (process.platform !== 'win32') {
  console.log('Dashboard visual regression is Windows-only; skipped on this platform.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-dashboard-visual-'));
const actualPath = path.join(temp, 'actual.png');
const diffPath = path.join(temp, 'diff.png');
const baselinePath = path.join(root, 'test', 'fixtures', 'visual-baselines', 'windows-dashboard-layout.png');
const updateBaseline = process.env.REL_AI_UPDATE_VISUAL_BASELINES === '1';
let passed = false;

try {
  const child = spawn(process.execPath, [path.join(root, 'test', 'electron-custom-chrome-browser.mjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RELAI_CHROME_PLATFORM: 'win32',
      RELAI_VISUAL_SCREENSHOT_PATH: actualPath,
      RELAI_VISUAL_FIXED_WINDOW: '1'
    }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, `Dashboard visual probe failed. stdout=${stdout} stderr=${stderr}`);
  assert.equal(fs.existsSync(actualPath), true, 'Dashboard visual probe did not write a screenshot.');

  if (updateBaseline) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.copyFileSync(actualPath, baselinePath);
    console.log(`Updated dashboard visual baseline: ${baselinePath}`);
    passed = true;
    process.exitCode = 0;
  } else {
    assert.equal(fs.existsSync(baselinePath), true, `Missing dashboard visual baseline: ${baselinePath}. Run with REL_AI_UPDATE_VISUAL_BASELINES=1 to create it intentionally.`);
    const [actual, baseline] = await Promise.all([decodePng(actualPath), decodePng(baselinePath)]);
    assert.equal(actual.info.width, baseline.info.width, 'Visual baseline width changed.');
    assert.equal(actual.info.height, baseline.info.height, 'Visual baseline height changed.');
    const diff = Buffer.alloc(actual.data.length);
    const differentPixels = pixelmatch(actual.data, baseline.data, diff, actual.info.width, actual.info.height, {
      threshold: 0.1,
      includeAA: false
    });
    const ratio = differentPixels / (actual.info.width * actual.info.height);
    if (ratio > 0.003) {
      await sharp(diff, { raw: { width: actual.info.width, height: actual.info.height, channels: 4 } }).png().toFile(diffPath);
      throw new Error(`Dashboard visual regression changed ${(ratio * 100).toFixed(3)}% of pixels (budget 0.300%). Diff: ${diffPath}`);
    }
    console.log(`Dashboard visual regression passed (${differentPixels} changed pixels, ${(ratio * 100).toFixed(3)}%).`);
    passed = true;
  }
} finally {
  if (passed) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  else console.error(`Visual-regression artifacts retained at ${temp}`);
}

async function decodePng(file) {
  return await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
