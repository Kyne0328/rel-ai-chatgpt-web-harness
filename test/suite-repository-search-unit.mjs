// Consolidated repository search coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly collect-symlink-containment-unit.mjs
async function case_collect_symlink_containment_unit() {
  // collectTextFiles no longer runs a realpathSync per file (it dominated the snapshot
  // and code-index walks). Containment now rests on the walk refusing every symbolic
  // link before it descends, so pin that behavior directly: a symlinked file and a
  // symlinked directory that both point outside the workspace must be skipped, and the
  // walk must not leak the outside content into the file list.
    const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:assert/strict");
    const assert = __m3.default;
  
    const __m4 = await import("../src/safety.js");
    const { collectTextFiles } = __m4;
  
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-collect-link-'));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  
  fs.writeFileSync(path.join(workspace, 'app.js'), 'const inside = 1;\n');
  fs.writeFileSync(path.join(outside, 'secret.js'), 'const outside = 1;\n');
  fs.writeFileSync(path.join(outside, 'nested', 'deep.js'), 'const deep = 1;\n');
  
  function trySymlink(target, linkPath, type) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (error) {
      // Windows refuses symlink creation without Developer Mode or elevation.
      if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) return false;
      throw error;
    }
  }
  
  try {
    const linkedFile = trySymlink(path.join(outside, 'secret.js'), path.join(workspace, 'linked.js'), 'file');
    const linkedDir = trySymlink(outside, path.join(workspace, 'linked-dir'), 'junction');
  
    if (!linkedFile && !linkedDir) {
      console.log('Symlink containment unit test skipped (no symlink privilege on this host).');
    } else {
      const result = collectTextFiles(workspace, {});
      assert.deepEqual(result.files, ['app.js'], 'only real in-workspace files are collected');
  
      for (const [created, name] of [[linkedFile, 'linked.js'], [linkedDir, 'linked-dir']]) {
        if (!created) continue;
        const skipped = result.skipped.find((item) => item.path === name);
        assert.equal(skipped?.reason, 'symlink skipped', `${name} must be reported as a skipped symlink`);
      }
  
      assert.ok(
        !result.files.some((file) => file.includes('secret') || file.includes('deep')),
        'content behind a symlink must never enter the file list'
      );
      console.log('Symlink containment unit test passed.');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
await case_collect_symlink_containment_unit();

// Formerly collect-text-extension-unit.mjs
async function case_collect_text_extension_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:assert/strict");
    const assert = __m3.default;
  
    const __m4 = await import("../src/safety.js");
    const { collectTextFiles } = __m4;
  
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-collect-ext-'));
  fs.writeFileSync(path.join(tmp, 'app.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'plain text\n');
  // Unknown extension + binary content → must still be sniffed and skipped.
  fs.writeFileSync(path.join(tmp, 'blob.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  // No extension + text content → sniffed and included.
  fs.writeFileSync(path.join(tmp, 'Procfile'), 'web: node server.js\n');
  // Known text extension with an embedded null byte → trusted by extension, included.
  fs.writeFileSync(path.join(tmp, 'weird.js'), Buffer.concat([Buffer.from('const b = "'), Buffer.from([0x00]), Buffer.from('";\n')]));
  const expandedTextExtensions = ['.hcl', '.tf', '.tfvars', '.psm1', '.psd1', '.markdown', '.mdx', '.dockerfile', '.graphql', '.gql', '.proto', '.r', '.asm', '.s', '.gd', '.nix', '.hs', '.lhs', '.jl', '.clj', '.cljs', '.cljc', '.edn', '.groovy', '.pl', '.pm', '.t'];
  for (const [index, extension] of expandedTextExtensions.entries()) {
    fs.writeFileSync(path.join(tmp, `known-${index}${extension}`), Buffer.from([0x41, 0x00, 0x42]));
  }
  
  try {
    const result = collectTextFiles(tmp, {});
    assert.deepEqual(result.files.sort(), ['Procfile', 'app.js', ...expandedTextExtensions.map((extension, index) => `known-${index}${extension}`), 'notes.txt', 'weird.js'].sort());
    const skippedBinary = result.skipped.find((item) => item.path === 'blob.dat');
    assert.equal(skippedBinary?.reason, 'binary-looking file');
    console.log('Extension-first collection unit test passed.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await case_collect_text_extension_unit();

// Formerly query-batch-unit.mjs
async function case_query_batch_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/bridge/queryBatch.js");
    const { runQueryBatch } = __m1;
  
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(new Error('cancel before batch'));
  await assert.rejects(
    () => runQueryBatch(['a', 'b', 'c'], async term => ({ term }), { signal: alreadyCancelled.signal }),
    /cancel before batch/,
    'an already-cancelled query batch must reject instead of returning an empty successful result'
  );
  
  const cancelledDuringBatch = new AbortController();
  let calls = 0;
  await assert.rejects(
    () => runQueryBatch(['first', 'second', 'third'], async term => {
      calls += 1;
      if (term === 'first') cancelledDuringBatch.abort(new Error('cancel during batch'));
      return { term };
    }, { signal: cancelledDuringBatch.signal, maxConcurrency: 1 }),
    /cancel during batch/
  );
  assert.equal(calls, 1, 'cancellation must stop scheduling unsatisfied queries');
  
  console.log('Query batches reject cancellation instead of reporting partial work as success.');
}
await case_query_batch_unit();

// Formerly search-context-unit.mjs
async function case_search_context_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:crypto");
    const crypto = __m3.default;
  
    const __m4 = await import("node:assert/strict");
    const assert = __m4.default;
  
    const __m5 = await import("node:child_process");
    const { spawnSync } = __m5;
  
    const __m6 = await import("../src/bridge/search.js");
    const { relaiSearch } = __m6;
  
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-search-context-'));
  const wsRoot = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
  
  const alphaText = [
    'const first = true;',
    'function alphaThing() {',
    '  alphaThing();',
    '  const middle = 1;',
    '  alphaThing();',
    '  return middle;',
    '}',
    'const gap = true;',
    'const gap2 = true;',
    'function later() {',
    '  alphaThing();',
    '}',
    ''
  ].join('\n');
  const betaText = 'export const beta = alphaThing();\n';
  const namedText = 'export const alphaThingFile = alphaThing();\n';
  const hugeText = `hugeMarker ${'x'.repeat(3000)}\n`;
  const moderateText = Array.from({ length: 25 }, (_, index) => `moderateMarker ${index}`).join('\n') + '\n';
  const broadText = Array.from({ length: 110 }, (_, index) => `broadMarker ${index}`).join('\n') + '\n';
  fs.writeFileSync(path.join(wsRoot, 'src', 'alpha.js'), alphaText);
  fs.writeFileSync(path.join(wsRoot, 'src', 'beta.js'), betaText);
  fs.writeFileSync(path.join(wsRoot, 'src', 'alphaThing.js'), namedText);
  fs.writeFileSync(path.join(wsRoot, 'src', 'huge.js'), hugeText);
  fs.writeFileSync(path.join(wsRoot, 'src', 'moderate.js'), moderateText);
  fs.writeFileSync(path.join(wsRoot, 'src', 'broad.js'), broadText);
  const init = spawnSync('git', ['init'], { cwd: wsRoot, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  
  const workspace = { alias: 'repo', path: wsRoot };
  
  try {
    const automatic = await relaiSearch(workspace, {}, { pattern: 'alphaThing', fixed: true });
    assert.equal(automatic.mode, 'auto');
    assert.equal(automatic.effectiveMode, 'context');
    assert.equal(automatic.autoTier, 'focused');
    assert.equal(automatic.selectionStrategy, 'path-and-match-density');
    assert.equal(automatic.contextBefore, 3);
    assert.equal(automatic.contextAfter, 5);
    assert.equal(automatic.maxFiles, 20);
    assert.equal(automatic.maxRangesPerFile, 20);
    assert.equal(automatic.maxRangeLines, 80);
    assert.equal(automatic.maxBytes, 96 * 1024);
    assert.equal(automatic.files[0].path, 'src/alphaThing.js', 'auto mode should prioritize a path that directly matches the query');
    assert.match(automatic.next, /Adaptive context is included/);
  
    const compact = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'compact'
    });
    assert.equal(compact.mode, undefined, 'explicit compact searches must preserve the existing response shape');
    assert.equal(compact.files, undefined);
    assert.ok(compact.matches.length >= 6);
  
    const contextual = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'context',
      contextBefore: 1,
      contextAfter: 1,
      maxFiles: 10,
      maxRangesPerFile: 10,
      maxRangeLines: 20,
      maxBytes: 20000
    });
    assert.equal(contextual.mode, 'context');
    assert.equal(contextual.effectiveMode, undefined);
    assert.equal(contextual.groupByFile, true);
    assert.equal(contextual.mergeOverlaps, true);
    assert.ok(Array.isArray(contextual.files));
    const alpha = contextual.files.find(file => file.path === 'src/alpha.js');
    assert.ok(alpha, 'context result must include alpha.js');
    assert.equal(alpha.sha256, crypto.createHash('sha256').update(Buffer.from(alphaText)).digest('hex'));
    assert.equal(alpha.matchCount, 4);
    assert.equal(alpha.ranges.length, 2, 'overlapping and adjacent ranges should merge');
    assert.deepEqual(alpha.ranges[0].matchLines, [2, 3, 5]);
    assert.equal(alpha.ranges[0].startLine, 1);
    assert.equal(alpha.ranges[0].endLine, 6);
    assert.match(alpha.ranges[0].content, /const first = true;/);
    assert.match(alpha.ranges[0].content, /return middle/);
    assert.match(contextual.next, /Context is included/);
  
    const moderate = await relaiSearch(workspace, {}, { pattern: 'moderateMarker', fixed: true });
    assert.equal(moderate.mode, 'auto');
    assert.equal(moderate.autoTier, 'moderate');
    assert.equal(moderate.maxFiles, 10);
    assert.equal(moderate.maxRangesPerFile, 8);
    assert.equal(moderate.maxRangeLines, 80);
    assert.equal(moderate.maxBytes, 96 * 1024);
  
    const broad = await relaiSearch(workspace, {}, { pattern: 'broadMarker', fixed: true });
    assert.equal(broad.mode, 'auto');
    assert.equal(broad.autoTier, 'broad');
    assert.equal(broad.maxFiles, 5);
    assert.equal(broad.maxRangesPerFile, 4);
    assert.equal(broad.maxRangeLines, 60);
    assert.equal(broad.maxBytes, 64 * 1024);
    assert.ok(broad.returnedRangeCount <= 4, 'broad auto mode should stay inside its range budget');
    assert.ok(broad.files[0].ranges.every(range => range.endLine - range.startLine + 1 <= 60));
  
    const empty = await relaiSearch(workspace, {}, { pattern: 'notPresentAnywhere', fixed: true });
    assert.equal(empty.mode, 'auto');
    assert.equal(empty.effectiveMode, 'compact');
    assert.equal(empty.autoTier, 'empty');
    assert.equal(empty.files, undefined);
  
    const unmerged = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'context',
      contextBefore: 1,
      contextAfter: 1,
      mergeOverlaps: false,
      maxBytes: 20000
    });
    const unmergedAlpha = unmerged.files.find(file => file.path === 'src/alpha.js');
    assert.equal(unmergedAlpha.ranges.length, 4, 'mergeOverlaps:false must retain separate windows');
  
    const flat = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'context',
      contextBefore: 0,
      contextAfter: 0,
      groupByFile: false,
      maxBytes: 20000
    });
    assert.equal(flat.files, undefined);
    assert.ok(Array.isArray(flat.contexts));
    assert.ok(flat.contexts.every(item => item.path && item.sha256 && Number.isInteger(item.startLine)));
  
    const rangeLimited = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'context',
      contextBefore: 0,
      contextAfter: 0,
      mergeOverlaps: false,
      maxRangesPerFile: 1,
      maxBytes: 20000
    });
    assert.equal(rangeLimited.contextTruncated, true);
    assert.ok(rangeLimited.omittedRanges >= 3);
  
    const fileLimited = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'context',
      maxFiles: 1,
      maxBytes: 20000
    });
    assert.equal(fileLimited.returnedFileCount, 1);
    assert.ok(fileLimited.omittedFiles >= 1);
    assert.equal(fileLimited.contextTruncated, true);
  
    const byteLimited = await relaiSearch(workspace, {}, {
      pattern: 'hugeMarker',
      fixed: true,
      mode: 'context',
      contextBefore: 0,
      contextAfter: 0,
      maxBytes: 1000
    });
    assert.equal(byteLimited.returnedBytes, 1000);
    assert.equal(byteLimited.contextTruncated, true);
    assert.equal(byteLimited.files[0].ranges[0].contentTruncated, true);
    assert.ok(Buffer.byteLength(byteLimited.files[0].ranges[0].content, 'utf8') <= 1000);
  
    const implicitContext = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      contextBefore: 2,
      contextAfter: 0,
      maxBytes: 20000
    });
    assert.equal(implicitContext.mode, 'context', 'context options without a mode should retain explicit context behavior');
  
    const explicitAuto = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'auto',
      maxFiles: 1,
      maxBytes: 20000
    });
    assert.equal(explicitAuto.mode, 'auto');
    assert.equal(explicitAuto.maxFiles, 1, 'explicit auto mode should accept caller limit overrides');
    assert.equal(explicitAuto.returnedFileCount, 1);
  
    const explicitCompact = await relaiSearch(workspace, {}, {
      pattern: 'alphaThing',
      fixed: true,
      mode: 'compact',
      contextBefore: 2
    });
    assert.equal(explicitCompact.mode, undefined, 'explicit compact mode must override contextual options');
    assert.equal(explicitCompact.files, undefined);
  
    await assert.rejects(
      () => relaiSearch(workspace, {}, { pattern: 'alphaThing', mode: 'expanded' }),
      /mode must be one of: auto, compact, context/
    );
  
    console.log('Adaptive context search unit test passed.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await case_search_context_unit();

// Formerly search-tool-unit.mjs
async function case_search_tool_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:assert/strict");
    const assert = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("../src/bridge/search.js");
    const { relaiSearch } = __m5;
  
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-search-'));
  const wsRoot = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'src', 'alpha.js'), 'function alphaThing() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(wsRoot, 'src', 'beta.js'), 'const beta = alphaThing();\nconst BETA = "ALPHATHING";\n');
  fs.writeFileSync(path.join(wsRoot, 'docs', 'notes.md'), 'alphaThing appears here too\n');
  fs.writeFileSync(path.join(wsRoot, '.env'), 'ALPHATHING_SECRET=1\n');
  const init = spawnSync('git', ['init'], { cwd: wsRoot, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  
  const config = {};
  const workspace = { alias: 'repo', path: wsRoot };
  
  try {
    // Untracked files are searched — no commit needed.
    const literal = await relaiSearch(workspace, config, { pattern: 'alphaThing(', fixed: true });
    assert.equal(literal.ok, true);
    const literalPaths = literal.matches.map((m) => m.path).sort();
    assert.deepEqual(literalPaths, ['src/alpha.js', 'src/beta.js']);
    const alphaMatch = literal.matches.find((m) => m.path === 'src/alpha.js');
    assert.equal(alphaMatch.line, 1);
    assert.match(alphaMatch.text, /function alphaThing/);
  
    // Extended regex is the default.
    const regex = await relaiSearch(workspace, config, { pattern: 'alpha(Thing|Nothing)' });
    assert.ok(regex.matches.some((m) => m.path === 'docs/notes.md'), 'regex should match docs/notes.md');
  
    // ignoreCase widens matches.
    const ci = await relaiSearch(workspace, config, { pattern: 'alphathing', ignoreCase: true });
    assert.ok(ci.matchCount >= 3, `case-insensitive should find at least 3 matches, got ${ci.matchCount}`);
  
    // Secret paths are filtered out of results.
    assert.equal(ci.matches.some((m) => m.path === '.env'), false, '.env must never appear in matches');
  
    // glob narrows the search.
    const scoped = await relaiSearch(workspace, config, { pattern: 'alphaThing', glob: 'src/*.js' });
    assert.deepEqual(scoped.matches.map((m) => m.path).sort(), ['src/alpha.js', 'src/beta.js']);
  
    // maxResults caps matches and stops after one additional visible match proves truncation.
    const capped = await relaiSearch(workspace, config, { pattern: 'alphaThing', ignoreCase: true, maxResults: 1 });
    assert.equal(capped.matches.length, 1);
    assert.equal(capped.truncated, true);
    assert.ok(capped.matchCount > 1);
  
    // Several independent patterns can fan out inside one public tool call.
    const batch = await relaiSearch(workspace, config, {
      queries: ['alphaThing', 'BETA', 'notPresentAnywhere'],
      fixed: true,
      maxResults: 12,
      mode: 'compact'
    });
    assert.equal(batch.ok, true);
    assert.deepEqual(batch.queries, ['alphaThing', 'BETA', 'notPresentAnywhere']);
    assert.equal(batch.queryCount, 3);
    assert.equal(batch.results.length, 3);
    assert.equal(batch.results[0].pattern, 'alphaThing');
    assert.ok(batch.uniqueFileCount >= 2);
    assert.ok(batch.matchCount >= 3);
    assert.equal(batch.results[2].matchCount, 0);
    assert.equal(batch.results.some(item => Object.hasOwn(item, 'workspace')), false, 'batch children should not repeat workspace metadata');
  
    // Batch result and context budgets are aggregate limits, not per-query multipliers.
    const aggregateCapped = await relaiSearch(workspace, config, {
      queries: ['alphaThing', 'BETA', 'appears here'],
      fixed: true,
      maxResults: 1,
      mode: 'compact'
    });
    assert.equal(aggregateCapped.resultCount, 1);
    assert.equal(aggregateCapped.results.reduce((sum, item) => sum + (item.matches?.length || 0), 0), 1);
  
    for (let index = 1; index <= 4; index += 1) {
      const padding = 'x'.repeat(350);
      fs.writeFileSync(path.join(wsRoot, 'docs', `budget-${index}.md`), `${padding}\nbudgetMarker${index}\n${padding}\n`);
    }
    const byteCapped = await relaiSearch(workspace, config, {
      queries: ['budgetMarker1', 'budgetMarker2', 'budgetMarker3', 'budgetMarker4'],
      fixed: true,
      maxResults: 4,
      maxBytes: 1000,
      mode: 'context',
      contextBefore: 1,
      contextAfter: 1
    });
    assert.ok(byteCapped.returnedBytes <= 1000, `batch context must honor the aggregate byte cap, got ${byteCapped.returnedBytes}`);
  
    const cancelledController = new AbortController();
    cancelledController.abort(new Error('cancelled search batch'));
    await assert.rejects(
      () => relaiSearch(workspace, config, { queries: ['alphaThing', 'BETA'], fixed: true }, { signal: cancelledController.signal }),
      /cancelled search batch/
    );
  
    // No matches is a valid empty result, not an error.
    const none = await relaiSearch(workspace, config, { pattern: 'zzz_does_not_exist_zzz' });
    assert.equal(none.ok, true);
    assert.deepEqual(none.matches, []);
    assert.equal(none.matchCount, 0);
  
    // Empty pattern refused.
    await assert.rejects(() => relaiSearch(workspace, config, { pattern: '   ' }), /non-empty pattern/);
  
    // Non-git workspaces use the safe filesystem fallback instead of losing search.
    const plainDir = path.join(tmp, 'plain');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'plain.txt'), 'plain search marker\n');
    const plainSearch = await relaiSearch({ alias: 'plain', path: plainDir }, config, {
      pattern: 'search marker', fixed: true, mode: 'compact'
    });
    assert.equal(plainSearch.ok, true);
    assert.equal(plainSearch.matchCount, 1);
    assert.equal(plainSearch.matches[0].path, 'plain.txt');
  
    // CRLF-terminated lines must not have trailing \r in matched text (Windows autocrlf regression).
    // Fixture has match on line 1 (not the last line) so whole-blob trim doesn't strip the CRLF before split logic runs.
    fs.writeFileSync(path.join(wsRoot, 'src', 'crlf.js'), 'function alphaThing() {\r\n  alphaThing();\r\n  return 1;\r\n}\r\n');
    const crlfResult = await relaiSearch(workspace, config, { pattern: 'alphaThing', glob: 'src/crlf.js' });
    assert.ok(crlfResult.matches.length > 0, 'should find match in CRLF file');
    const line1Match = crlfResult.matches.find(m => m.line === 1);
    assert.ok(line1Match, 'should find match on line 1');
    assert.ok(!line1Match.text.endsWith('\r'), `CRLF line 1 text should not end with \\r, got: ${JSON.stringify(line1Match.text)}`);
    assert.equal(line1Match.text, 'function alphaThing() {', 'line 1 text should match expected clean text');
  
    // Search output larger than the generic 1 MiB process cap must preserve the
    // earliest match without scanning the rest of a broad result set.
    const overflowDir = path.join(wsRoot, 'overflow');
    fs.mkdirSync(overflowDir, { recursive: true });
    const overflowLineCount = 12000;
    fs.writeFileSync(path.join(overflowDir, '000-early.txt'), 'overflowMarker early\n');
    fs.writeFileSync(
      path.join(overflowDir, 'zzz-large.txt'),
      (`overflowMarker ${'x'.repeat(96)}\n`).repeat(overflowLineCount)
    );
    const overflow = await relaiSearch(workspace, config, {
      pattern: 'overflowMarker',
      fixed: true,
      glob: 'overflow/*.txt',
      maxResults: 1
    });
    assert.equal(overflow.matches[0]?.path, 'overflow/000-early.txt', 'large search must retain the earliest match');
    assert.equal(overflow.matchCount, 2, 'large search must stop after one extra match proves truncation');
    assert.equal(overflow.truncated, true);
  
    console.log('Search tool unit test passed.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await case_search_tool_unit();
