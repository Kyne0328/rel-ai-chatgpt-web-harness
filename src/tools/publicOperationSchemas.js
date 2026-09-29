function publicExecInputSchema(inputSchema) {
  const properties = inputSchema.properties || {};
  const describe = (name, description) => ({ ...properties[name], description });
  return {
    ...inputSchema,
    description: 'Two execution forms are available: direct executable + argv, and shell command. Direct execution avoids shell parsing.',
    properties: {
      ...properties,
      command: describe('command', 'Shell command form for syntax that requires a shell. Multiline scripts or structured text can be supplied through input.'),
      executable: describe('executable', 'Executable launched directly with shell:false.'),
      argv: describe('argv', 'Arguments passed without shell parsing; keep each logical argument separate.'),
      input: describe('input', 'Literal stdin for multiline scripts or structured text; preserves quote-sensitive content.'),
      cwd: describe('cwd', 'Optional workspace-relative working directory.'),
      env: describe('env', 'Optional environment variables supplied directly to the child process.'),
      timeoutMs: describe('timeoutMs', 'Maximum operation runtime in milliseconds.'),
      maxOutputBytes: describe('maxOutputBytes', 'Maximum captured stdout/stderr bytes before output is truncated.')
    }
  };
}

function publicProcessInputSchema(inputSchema) {
  const properties = inputSchema.properties || {};
  const describe = (name, description) => ({ ...properties[name], description });
  return {
    ...inputSchema,
    properties: {
      ...properties,
      command: describe('command', 'Shell command string for process start when shell syntax is required.'),
      executable: describe('executable', 'Executable launched directly with shell:false for process start.'),
      argv: describe('argv', 'Literal arguments passed directly to executable without shell parsing.'),
      input: describe('input', 'For direct start, optional initial UTF-8 stdin written without closing the persistent stdin stream; PTY starts write the same input to the terminal. For write, UTF-8 input is sent to the running process or PTY.'),
      pty: describe('pty', 'For start, allocate a real pseudo-terminal. Only valid with kind:interactive.'),
      columns: describe('columns', 'For PTY start or write, terminal width from 1 to 1000 columns.'),
      rows: describe('rows', 'For PTY start or write, terminal height from 1 to 1000 rows.')
    }
  };
}

function publicEditInputSchema(inputSchema, maxBatchEdits) {
  const properties = inputSchema.properties || {};
  const describe = (name, description) => ({ ...properties[name], description });
  return {
    ...inputSchema,
    description: 'One primary edit form is accepted per call. Rel.AI validates the selected form before touching the workspace.',
    properties: {
      ...properties,
      workspace: describe('workspace', 'Configured project for this edit. Omit it only when direct filesystem access is enabled or a valid work_id already identifies a project.'),
      root: describe('root', 'Absolute local directory for direct-filesystem edits when workspace is omitted. Relative edit paths are resolved inside this root.'),
      semantic: describe('semantic', 'Language-server-authoritative rename at an exact file position. Rel.AI validates and applies the proposed WorkspaceEdit.'),
      symbolEdit: describe('symbolEdit', 'Indexed structural symbol edit. Supports replace, insert_before, and insert_after; pass path or a qualified symbol when the name is ambiguous.'),
      path: describe('path', 'Target path. Use a project-relative path with workspace, or an absolute path / root-relative path when direct filesystem access is enabled.'),
      oldText: describe('oldText', 'Exact non-empty current text to replace. Pair with newText.'),
      newText: describe('newText', 'Replacement text paired with oldText. An empty string deletes the matched text.'),
      occurrence: describe('occurrence', 'One-based occurrence to replace when oldText is not unique.'),
      replacements: describe('replacements', 'Several exact oldText/newText replacements in one file.'),
      content: describe('content', 'Complete replacement content as text for one file. Large complete-file text writes are staged internally when needed.'),
      file: describe('file', 'Native ChatGPT file reference to stream into path without overwrite.'),
      expectedSha256: describe('expectedSha256', 'Optional stale-write guard for direct, batch, symbol, and environment edits.'),
      updateText: describe('updateText', 'Git unified diff or structured OpenAI patch text for patch-shaped changes. One logical patch can contain repository-wide changes when transport capacity permits.'),
      envAction: describe('envAction', 'Secret-safe environment operation: list, set, remove, or compare.'),
      key: describe('key', 'Environment key used by envAction set or remove.'),
      value: describe('value', 'Environment value used by envAction set. Values are never returned.'),
      templatePath: describe('templatePath', 'Public environment template used by envAction compare.'),
      edits: describe('edits', `Atomic structured batch of up to ${maxBatchEdits} file edits.`),
      runChecks: describe('runChecks', 'Run detected validation checks after a successful edit.'),
      level: describe('level', 'Validation level used when runChecks is true.'),
      returnDiff: describe('returnDiff', 'Return a bounded diff after a successful edit.'),
      dryRun: describe('dryRun', 'Validate and preview the edit without changing files.'),
      stage: properties.stage,
      writeId: properties.writeId
    }
  };
}

export { publicEditInputSchema, publicExecInputSchema, publicProcessInputSchema };
