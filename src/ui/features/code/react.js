import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import './styles.css';
import { fetchJson } from '../../api.js';
import { toast } from '../../components/toast.js';
import { Icon } from '../../components/icons.js';
import { currentRoutePath, getRouteParams, getRouteSnapshot, replaceRouteParams, routeHref, subscribeRoute } from '../../router.js';
import { classifyTaskChangedFiles } from '../../../taskSemanticProgress.js';

const h = React.createElement;
const CODE_STORE_KEYS = Object.freeze(['tasks', 'live']);
const HTTP_CODE_BRIDGE = Object.freeze({
  get: taskId => requestCodeJson(`/api/tasks/files?task=${encodeURIComponent(taskId)}`),
  diff: (taskId, path) => requestCodeJson(`/api/tasks/diff?task=${encodeURIComponent(taskId)}&file=${encodeURIComponent(path)}`)
});
let monacoPromise = null;

export function createCodeRoute(useDashboardSlices) {
  return function CodeRoute() {
    const data = useDashboardSlices(CODE_STORE_KEYS);
    return h(ChangesRoute, { data });
  };
}

function ChangesRoute({ data = {} }) {
  const bridge = window.relaiDesktop?.codeWorkspace || HTTP_CODE_BRIDGE;
  const tasks = useMemo(() => codeTasks(data), [data]);

  if (!tasks.length) return h(EmptyChangesState);
  return h(ChangesDesktop, {
    bridge,
    taskRevision: Number(data.live?.revisions?.task || 0),
    taskSource: data.tasks,
    tasks
  });
}

function ChangesDesktop({ bridge, taskRevision, taskSource, tasks }) {
  const { selectedTaskId, requestedFilePath, selectTask } = useRouteTaskId(tasks);
  const selectedTask = tasks.find(task => task.id === selectedTaskId) || null;
  const [workspace, setWorkspace] = useState(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const [filePath, setFilePath] = useState('');
  const [diffFile, setDiffFile] = useState(null);
  const [viewerMessage, setViewerMessage] = useState('Loading task changes…');
  const [viewerTone, setViewerTone] = useState('');
  const [query, setQuery] = useState('');
  const [editors, setEditors] = useState(null);
  const [editorLoadFailed, setEditorLoadFailed] = useState(false);
  const [editorId, setEditorId] = useState('');
  const [openingIde, setOpeningIde] = useState(false);
  const [diffLayout, setDiffLayout] = useState('side-by-side');
  const workspaceRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const taskIdRef = useRef(selectedTaskId);
  const filePathRef = useRef(filePath);
  const pendingDiffPathRef = useRef('');

  taskIdRef.current = selectedTaskId;
  filePathRef.current = filePath;

  const loadDiff = useCallback(async (taskId, path) => {
    const normalizedTaskId = String(taskId || '').trim();
    const normalizedPath = String(path || '').trim();
    if (!normalizedTaskId || !normalizedPath) return false;
    const request = ++diffRequestRef.current;
    pendingDiffPathRef.current = normalizedPath;
    try {
      const file = await bridge.diff(normalizedTaskId, normalizedPath);
      if (request !== diffRequestRef.current || taskIdRef.current !== normalizedTaskId) return false;
      if (currentRoutePath() !== 'code' || readRequestedTaskId() !== normalizedTaskId) return false;
      if (readRequestedFilePath() && readRequestedFilePath() !== normalizedPath) return false;
      filePathRef.current = normalizedPath;
      setFilePath(normalizedPath);
      replaceRouteParams({ task: normalizedTaskId, file: normalizedPath });
      setDiffFile(file);
      setViewerMessage('');
      setViewerTone('');
      return true;
    } catch (error) {
      if (request !== diffRequestRef.current || taskIdRef.current !== normalizedTaskId) return false;
      setDiffFile(null);
      setViewerMessage(messageFor(error));
      setViewerTone('error');
      return false;
    } finally {
      if (request === diffRequestRef.current) pendingDiffPathRef.current = '';
    }
  }, [bridge]);

  const refreshWorkspace = useCallback(async (taskId, { refreshCurrent = false } = {}) => {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) return;
    const request = ++workspaceRequestRef.current;
    try {
      const nextWorkspace = await bridge.get(normalizedTaskId);
      if (request !== workspaceRequestRef.current || taskIdRef.current !== normalizedTaskId) return;
      setWorkspace(nextWorkspace);
      setWorkspaceError('');

      const changedFiles = changedTextFiles(nextWorkspace);
      const currentPath = filePathRef.current;
      const requestedPath = readRequestedFilePath();
      const currentStillExists = Boolean(currentPath && changedFiles.includes(currentPath));
      if (currentPath && !currentStillExists) {
        diffRequestRef.current += 1;
        filePathRef.current = '';
        setFilePath('');
        setDiffFile(null);
        setViewerMessage(emptyViewerMessage(nextWorkspace));
        setViewerTone('');
      }

      const nextPath = changedFiles.includes(requestedPath)
        ? requestedPath
        : (currentStillExists ? currentPath : (changedFiles[0] || ''));
      if (!nextPath) {
        diffRequestRef.current += 1;
        filePathRef.current = '';
        setFilePath('');
        setDiffFile(null);
        setViewerMessage(emptyViewerMessage(nextWorkspace));
        setViewerTone('');
        return;
      }
      if (requestedPath && !changedFiles.includes(requestedPath)) replaceRouteParams({ file: nextPath });
      if (nextPath !== currentPath || refreshCurrent) await loadDiff(normalizedTaskId, nextPath);
    } catch (error) {
      if (request !== workspaceRequestRef.current || taskIdRef.current !== normalizedTaskId) return;
      diffRequestRef.current += 1;
      setWorkspace(null);
      setWorkspaceError(messageFor(error));
      setDiffFile(null);
      setViewerMessage(messageFor(error));
      setViewerTone('error');
    }
  }, [bridge, loadDiff]);

  useEffect(() => {
    workspaceRequestRef.current += 1;
    diffRequestRef.current += 1;
    filePathRef.current = '';
    setWorkspace(null);
    setWorkspaceError('');
    setFilePath('');
    setDiffFile(null);
    setViewerMessage('Loading task changes…');
    setViewerTone('');
  }, [selectedTaskId]);

  useEffect(() => () => {
    workspaceRequestRef.current += 1;
    diffRequestRef.current += 1;
  }, []);

  useEffect(() => {
    void refreshWorkspace(selectedTaskId);
  }, [refreshWorkspace, selectedTaskId, taskRevision, taskSource]);

  const canOpenIde = typeof bridge.editors === 'function' && typeof bridge.openIde === 'function';

  useEffect(() => {
    let active = true;
    setEditors(null);
    setEditorLoadFailed(false);
    setEditorId('');
    if (!canOpenIde) {
      setEditors([]);
      return () => { active = false; };
    }
    Promise.resolve(bridge.editors()).then(result => {
      if (!active) return;
      const available = Array.isArray(result?.editors) ? result.editors : [];
      setEditors(available);
      setEditorId(String(available[0]?.id || ''));
    }).catch(() => {
      if (!active) return;
      setEditors([]);
      setEditorLoadFailed(true);
    });
    return () => { active = false; };
  }, [bridge, canOpenIde]);

  const changedFiles = useMemo(() => changedTextFiles(workspace), [workspace]);
  useEffect(() => {
    if (!requestedFilePath || !changedFiles.includes(requestedFilePath)) return;
    if (requestedFilePath === filePathRef.current || requestedFilePath === pendingDiffPathRef.current) return;
    void loadDiff(selectedTaskId, requestedFilePath);
  }, [changedFiles, loadDiff, requestedFilePath, selectedTaskId]);
  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return changedFiles.filter(file => !normalized || file.toLowerCase().includes(normalized));
  }, [changedFiles, query]);
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const meta = workspaceMeta(workspace, workspaceError);
  const viewState = workspace?.historyMode === 'unavailable' ? 'Recorded files only' : 'Read-only diff';
  const ideDisabled = openingIde || !editorId || !editors?.length;

  const openIde = async () => {
    if (ideDisabled || !selectedTaskId) return;
    setOpeningIde(true);
    try {
      const result = await bridge.openIde(selectedTaskId, editorId);
      toast(`Opened this project in ${result?.editor?.label || 'the selected application'}.`, { variant: 'success' });
    } catch (error) {
      toast(messageFor(error), { variant: 'error' });
    } finally {
      setOpeningIde(false);
    }
  };

  const openFile = path => {
    if (!path || path === filePathRef.current) return;
    replaceRouteParams({ file: path });
    void loadDiff(selectedTaskId, path);
  };

  return h('div', { className: 'section code-page', 'data-code-react': '' },
    h('div', { className: 'feature-toolbar code-toolbar' },
      h('div', { className: 'code-task-control' },
        h('label', { htmlFor: 'codeTaskSelect' }, 'Task'),
        h('select', {
          id: 'codeTaskSelect',
          'data-code-task': '',
          value: selectedTaskId,
          onChange: event => selectTask(event.target.value)
        }, tasks.map(task => h('option', { key: task.id, value: task.id }, task.label)))
      ),
      h('div', { className: 'code-toolbar-actions' },
        h('a', {
          className: 'buttonlike secondary',
          'data-code-task-link': '',
          href: routeHref('tasks', { workspace: selectedTask?.workspace, task: selectedTaskId })
        }, h(Icon, { name: 'chevronLeft' }), h('span', null, 'Task')),
        canOpenIde ? h(React.Fragment, null,
          h('select', {
            'data-code-ide': '',
            'aria-label': 'Application for project',
            value: editorId,
            onChange: event => setEditorId(event.target.value)
          }, editorLoadFailed
            ? h('option', { value: '' }, 'IDE unavailable')
            : editors == null
              ? h('option', { value: '' }, 'Loading applications…')
              : editors.map(editor => h('option', { key: editor.id, value: editor.id }, editor.label))),
          h('button', {
            className: 'secondary',
            type: 'button',
            'data-code-open-ide': '',
            disabled: ideDisabled,
            onClick: () => { void openIde(); }
          }, h(Icon, { name: 'externalLink' }), h('span', null, openingIde ? 'Opening…' : 'IDE'))
        ) : null,
        h('button', {
          className: 'secondary',
          type: 'button',
          'data-code-refresh': '',
          onClick: () => { void refreshWorkspace(selectedTaskId, { refreshCurrent: true }); }
        }, 'Refresh')
      )
    ),
    h('div', { className: 'code-workspace-meta', 'data-code-meta': '' }, meta),
    h('div', { className: 'code-workbench' },
      h('aside', { className: 'code-explorer', 'aria-label': 'Changed task files' },
        h('div', { className: 'code-explorer-head' },
          h('strong', null, 'Changed files'),
          h('input', {
            type: 'search',
            'data-code-search': '',
            placeholder: 'Filter changed files',
            'aria-label': 'Filter changed task files',
            value: query,
            onChange: event => setQuery(event.target.value)
          })
        ),
        h('div', { className: 'code-file-list', 'data-code-files': '' },
          visibleFiles.length
            ? h('ul', { className: 'code-file-tree' }, ...renderFileTree(fileTree, { workspace, filePath, openFile }))
            : h('div', { className: 'code-file-empty' }, query ? 'No matching changed files.' : (workspaceError ? 'Task changes are unavailable.' : 'No task-owned changes to review.'))
        )
      ),
      h('section', { className: 'code-editor-pane', 'aria-label': 'Task diff viewer' },
        h('div', { className: 'code-editor-toolbar' },
          h('div', { className: 'code-file-heading mono', 'data-code-file-heading': '' }, filePath || 'No file selected'),
          h('div', { className: 'code-view-controls' },
            h('span', { className: 'code-keyboard-hint' }, h('kbd', null, 'Ctrl+M'), ' changes whether Tab moves focus'),
            h('div', { className: 'code-diff-layout', role: 'group', 'aria-label': 'Diff layout' },
              h('button', {
                className: `secondary compact-button code-layout-button${diffLayout === 'side-by-side' ? ' active' : ''}`,
                type: 'button',
                'aria-pressed': diffLayout === 'side-by-side',
                onClick: () => setDiffLayout('side-by-side')
              }, 'Side by side'),
              h('button', {
                className: `secondary compact-button code-layout-button${diffLayout === 'unified' ? ' active' : ''}`,
                type: 'button',
                'aria-pressed': diffLayout === 'unified',
                onClick: () => setDiffLayout('unified')
              }, 'Unified')
            ),
            h('span', { className: 'code-view-state', 'data-code-view-state': '' }, viewState)
          )
        ),
        h(DiffViewer, { file: diffFile, message: viewerMessage, tone: viewerTone, layout: diffLayout })
      )
    )
  );
}

function DiffViewer({ file, message, tone, layout }) {
  if (!file) {
    return h('div', {
      className: `code-editor-host code-editor-message${tone ? ` ${tone}` : ''}`,
      'data-code-editor': ''
    }, message || 'Choose a changed file to review its diff.');
  }
  return h(MonacoDiffViewer, { file, layout });
}

const MonacoDiffViewer = memo(function MonacoDiffViewer({ file, layout }) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelsRef = useRef([]);
  const fileRef = useRef(file);
  const layoutRef = useRef(layout);
  const [loadError, setLoadError] = useState('');

  fileRef.current = file;
  layoutRef.current = layout;

  useEffect(() => {
    let active = true;
    let cleanupResize = () => {};
    let cleanupTheme = () => {};

    void loadMonaco().then(monaco => {
      if (!active || !hostRef.current) return;
      monacoRef.current = monaco;
      const editor = monaco.editor.createDiffEditor(hostRef.current, {
        theme: currentMonacoTheme(),
        readOnly: true,
        originalEditable: false,
        automaticLayout: false,
        renderSideBySide: layoutRef.current !== 'unified',
        useInlineViewWhenSpaceIsLimited: true,
        renderIndicators: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
        fontLigatures: true
      });
      editorRef.current = editor;
      cleanupResize = bindEditorResize(editor, hostRef.current);
      cleanupTheme = bindEditorTheme(monaco);
      applyDiffModels(monaco, editor, modelsRef, fileRef.current);
    }).catch(error => {
      if (!active) return;
      const message = messageFor(error);
      setLoadError(message);
      toast(`Monaco could not start. Showing a read-only text diff fallback. ${message}`, { variant: 'warn' });
    });

    return () => {
      active = false;
      cleanupResize();
      cleanupTheme();
      clearDiffModels(editorRef.current, modelsRef);
      try { editorRef.current?.dispose?.(); } catch {}
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    applyDiffModels(monacoRef.current, editorRef.current, modelsRef, file);
  }, [file]);

  useEffect(() => {
    if (!editorRef.current) return;
    try {
      editorRef.current.updateOptions({ renderSideBySide: layout !== 'unified' });
      editorRef.current.layout();
    } catch {}
  }, [layout]);

  if (loadError) {
    return h('div', { className: 'code-editor-host', 'data-code-editor': '' }, h(DiffFallback, { file, layout }));
  }
  return h('div', {
    ref: hostRef,
    className: 'code-editor-host',
    'data-code-editor': '',
    'aria-label': 'Read-only file diff'
  });
});

function DiffFallback({ file, layout }) {
  return h('div', { className: `code-diff-fallback${layout === 'unified' ? ' is-unified' : ''}` },
    h(FallbackColumn, { label: 'Before', content: file?.baseContent || '' }),
    h(FallbackColumn, { label: 'After', content: file?.content || '' })
  );
}

function FallbackColumn({ label, content }) {
  return h('section', { className: 'code-diff-column' },
    h('strong', null, label),
    h('pre', null, content)
  );
}

function applyDiffModels(monaco, editor, modelsRef, file) {
  clearDiffModels(editor, modelsRef);
  if (!file) return;
  const language = file.language || 'plaintext';
  const original = monaco.editor.createModel(file.baseContent || '', language);
  const modified = monaco.editor.createModel(file.content || '', language);
  modelsRef.current = [original, modified];
  editor.setModel({ original, modified });
}

function clearDiffModels(editor, modelsRef) {
  try { editor?.setModel?.(null); } catch {}
  for (const model of modelsRef.current || []) {
    try { model?.dispose?.(); } catch {}
  }
  modelsRef.current = [];
}

function bindEditorResize(editor, host) {
  const layout = () => {
    try { editor.layout(); } catch {}
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(layout);
    observer.observe(host);
    queueMicrotask(layout);
    return () => observer.disconnect();
  }
  window.addEventListener('resize', layout);
  queueMicrotask(layout);
  return () => window.removeEventListener('resize', layout);
}

function bindEditorTheme(monaco) {
  const apply = () => {
    try { monaco.editor.setTheme(currentMonacoTheme()); } catch {}
  };
  apply();
  if (typeof MutationObserver !== 'function') return () => {};
  const observer = new MutationObserver(records => {
    if (records.some(record => record.attributeName === 'data-theme')) apply();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function currentMonacoTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
}

function useRouteTaskId(tasks) {
  const route = useSyncExternalStore(subscribeRoute, getRouteSnapshot, getRouteSnapshot);
  const params = new URLSearchParams(route.search);
  const requestedTaskId = String(params.get('task') || '').trim();
  const requestedFilePath = String(params.get('file') || '').trim();
  const taskIds = useMemo(() => tasks.map(task => task.id), [tasks]);
  const selectedTaskId = taskIds.includes(requestedTaskId) ? requestedTaskId : (taskIds[0] || '');

  useEffect(() => {
    if (!selectedTaskId || requestedTaskId === selectedTaskId) return;
    replaceRouteParams({ task: selectedTaskId, file: null });
  }, [requestedTaskId, selectedTaskId]);

  const selectTask = taskId => {
    const next = String(taskId || '').trim();
    if (!taskIds.includes(next) || next === selectedTaskId) return;
    replaceRouteParams({ task: next, file: null });
  };

  return { selectedTaskId, requestedFilePath, selectTask };
}

function readRequestedTaskId() {
  return String(getRouteParams().get('task') || '').trim();
}

function readRequestedFilePath() {
  return String(getRouteParams().get('file') || '').trim();
}

function codeTasks(data = {}) {
  return (Array.isArray(data.tasks) ? data.tasks : [])
    .filter(task => classifyTaskChangedFiles(task?.changedFiles || []).productChangedFileCount > 0)
    .map(task => ({
      id: taskId(task),
      label: taskLabel(task),
      status: String(task.status || ''),
      workspace: String(task.workspace || '')
    }))
    .filter(task => task.id);
}

function taskId(task) {
  return String(task?.work_id || task?.taskId || task?.id || '').trim();
}

function taskLabel(task) {
  const title = String(task?.title || task?.objective || task?.summary || 'Untitled task').trim();
  const workspace = String(task?.workspace || '').trim();
  const status = String(task?.status || '').trim();
  return [title, workspace, status].filter(Boolean).join(' · ');
}

function buildFileTree(files = []) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const normalized = String(file || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) continue;
    const parts = normalized.split('/').filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ name: parts.at(-1), path: file });
  }
  return root;
}

function renderFileTree(node, context, prefix = '') {
  const folders = [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...folders.map(([name, child]) => {
      const path = prefix ? `${prefix}/${name}` : name;
      return h('li', { className: 'code-tree-folder', key: `folder:${path}` },
        h('div', { className: 'code-tree-folder-label', title: path },
          h(Icon, { name: 'chevronDown', size: 13 }),
          h('span', null, name)
        ),
        h('ul', null, ...renderFileTree(child, context, path))
      );
    }),
    ...files.map(file => {
      const status = changedFileStatus(context.workspace, file.path);
      const statsLabel = status.hasLineStats ? `, +${status.additions} -${status.deletions}` : '';
      const label = `${status.label}${statsLabel}: ${file.path}`;
      return h('li', { className: 'code-tree-file', key: file.path },
        h('button', {
          className: `code-file-row${file.path === context.filePath ? ' active' : ''}`,
          type: 'button',
          'data-code-file': file.path,
          title: label,
          'aria-label': label,
          onClick: () => context.openFile(file.path)
        },
          h('span', { className: `code-file-marker status-${status.tone}`, 'aria-hidden': 'true' }, status.code),
          h('span', { className: 'code-file-name' }, file.name),
          status.hasLineStats ? h('span', { className: 'code-file-stats', 'aria-hidden': 'true' },
            h('span', { className: 'additions' }, `+${status.additions}`),
            h('span', { className: 'deletions' }, `-${status.deletions}`)
          ) : null
        )
      );
    })
  ];
}

function changedTextFiles(workspace = {}) {
  return [...new Set((Array.isArray(workspace?.changedFiles) ? workspace.changedFiles : [])
    .map(file => String(file || '').trim())
    .filter(Boolean))];
}

function changedFileStatus(workspace = {}, file = '') {
  const raw = workspace?.changedFileStatuses?.[file];
  if (!raw || typeof raw !== 'object') return { code: 'M', label: 'Modified', tone: 'warning', hasLineStats: false, additions: 0, deletions: 0 };
  const code = String(raw.code || 'M').slice(0, 1).toUpperCase();
  const label = String(raw.label || 'Modified');
  const tone = ['info', 'success', 'warning', 'danger', 'neutral'].includes(raw.tone) ? raw.tone : 'neutral';
  const additions = Number(raw.additions);
  const deletions = Number(raw.deletions);
  const hasLineStats = Number.isFinite(additions) && Number.isFinite(deletions) && additions >= 0 && deletions >= 0;
  return { code, label, tone, hasLineStats, additions: hasLineStats ? additions : 0, deletions: hasLineStats ? deletions : 0 };
}

function workspaceMeta(workspace, error) {
  if (error) return 'Task changes unavailable';
  if (!workspace) return 'Loading task changes…';
  const parts = [workspace.workspace || 'Project'];
  if (workspace.status) parts.push(humanizeStatus(workspace.status));
  if (workspace.historyMode === 'committed') {
    const head = shortCommit(workspace.commitHead);
    parts.push(head ? `Committed changes · ${head}` : 'Committed changes');
    if (workspace.commitSource === 'inferred') parts.push('Recovered from Git history');
  } else if (workspace.historyMode === 'unavailable') {
    parts.push('Historical diff unavailable');
  } else {
    parts.push('Current task changes');
  }
  return parts.join(' · ');
}

function emptyViewerMessage(workspace = {}) {
  if (workspace?.historyMode === 'unavailable') return 'This task records changed files, but its historical Git diff cannot be identified safely.';
  const status = String(workspace?.status || '').toLowerCase();
  if (['completed', 'cancelled', 'failed'].includes(status)) return 'This task has no recorded file changes.';
  return 'No task-owned changes to review yet.';
}

function humanizeStatus(value) {
  const text = String(value || '').trim().replaceAll('_', ' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function shortCommit(value) {
  const text = String(value || '').trim();
  return /^[a-f0-9]{7,64}$/i.test(text) ? text.slice(0, 8) : '';
}

async function requestCodeJson(url) {
  const response = await fetchJson(url, { cache: 'no-store', timeout: 30_000, pauseTimeoutWhenHidden: false });
  if (response?.ok === false) throw new Error(String(response.error || 'The changes viewer request failed.'));
  return response;
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error || 'The changes viewer request failed.');
}

function EmptyChangesState() {
  return h('div', { className: 'section code-page', 'data-code-react': '' },
    h('div', { className: 'dashboard-state' },
      h('div', { className: 'dashboard-state-card' },
        h('h2', null, 'No task changes are available.'),
        h('p', null, 'Start a Rel.AI task, then return here to review what changed.'),
        h('div', { className: 'dashboard-state-actions' },
          h('a', { className: 'buttonlike primary', href: '#tasks' },
            h('span', null, 'Tasks'), h(Icon, { name: 'chevronRight' })
          )
        )
      )
    )
  );
}

function loadMonaco() {
  if (window.monaco?.editor) return Promise.resolve(window.monaco);
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    const start = () => {
      if (typeof window.require !== 'function') {
        reject(new Error('Monaco loader did not initialize.'));
        return;
      }
      window.MonacoEnvironment = {
        getWorkerUrl(_moduleId, label) {
          if (label === 'json') return '/vendor/monaco/language/json/json.worker.js';
          if (['css', 'scss', 'less'].includes(label)) return '/vendor/monaco/language/css/css.worker.js';
          if (['html', 'handlebars', 'razor'].includes(label)) return '/vendor/monaco/language/html/html.worker.js';
          if (['typescript', 'javascript'].includes(label)) return '/vendor/monaco/language/typescript/ts.worker.js';
          return '/vendor/monaco/editor/editor.worker.js';
        }
      };
      window.require.config({ paths: { vs: '/vendor/monaco' } });
      window.require([
        'vs/editor/editor.main',
        'vs/basic-languages/monaco.contribution'
      ], () => resolve(window.monaco), reject);
    };
    const existing = document.querySelector('script[data-monaco-loader]');
    if (existing) {
      if (typeof window.require === 'function') start();
      else existing.addEventListener('load', start, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = '/vendor/monaco/loader.js';
    script.dataset.monacoLoader = 'true';
    script.addEventListener('load', start, { once: true });
    script.addEventListener('error', () => reject(new Error('Monaco editor assets could not load.')), { once: true });
    document.head.appendChild(script);
  });
  return monacoPromise;
}
