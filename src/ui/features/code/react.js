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

export function TaskDiffViewer({
  taskId,
  initialFilePath = '',
  mode = 'embedded',
  onSelectFile = null,
  bridge = null,
  active = true,
  changeRevision = null,
  fullScreenHref = ''
}) {
  const activeBridge = bridge || (window.relaiDesktop?.codeWorkspace || HTTP_CODE_BRIDGE);
  return h(ChangesDesktop, {
    key: taskId,
    bridge: activeBridge,
    selectedTaskId: taskId,
    requestedFilePath: initialFilePath,
    mode,
    onSelectFile,
    active,
    changeRevision,
    fullScreenHref,
    tasks: []
  });
}

function ChangesRoute({ data = {} }) {
  const bridge = window.relaiDesktop?.codeWorkspace || HTTP_CODE_BRIDGE;
  const tasks = useMemo(() => codeTasks(data), [data]);

  const routeTask = useRouteTaskId(tasks);
  if (!routeTask.selectedTaskId) return h(EmptyChangesState);
  return h(ChangesDesktop, {
    key: routeTask.selectedTaskId,
    bridge,
    tasks,
    mode: 'standalone',
    ...routeTask
  });
}

function ChangesDesktop({
  bridge,
  tasks = [],
  selectedTaskId,
  requestedFilePath,
  selectTask = null,
  returnContext = null,
  mode = 'standalone',
  onSelectFile = null,
  active = true,
  changeRevision = null,
  fullScreenHref = ''
}) {
  const selectedTask = (tasks || []).find(task => task.id === selectedTaskId) || null;
  const [workspace, setWorkspace] = useState(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [diffFile, setDiffFile] = useState(null);
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());
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
  const onSelectFileRef = useRef(onSelectFile);
  const requestedPathRef = useRef(requestedFilePath);
  const activeRef = useRef(active);
  const editorViewStates = useRef(new Map());

  taskIdRef.current = selectedTaskId;
  filePathRef.current = filePath;
  onSelectFileRef.current = onSelectFile;
  requestedPathRef.current = requestedFilePath;
  activeRef.current = active;

  const loadDiff = useCallback(async (requestedTask, path) => {
    const normalizedTaskId = String(requestedTask || '').trim();
    const normalizedPath = String(path || '').trim();
    if (!normalizedTaskId || !normalizedPath || !activeRef.current) return false;
    const request = ++diffRequestRef.current;
    pendingDiffPathRef.current = normalizedPath;
    if (normalizedPath !== filePathRef.current) {
      setDiffFile(null);
      setViewerMessage('Loading file diff…');
      setViewerTone('');
    }
    try {
      const file = await bridge.diff(normalizedTaskId, normalizedPath);
      if (file?.ok === false) throw new Error(file.error || 'The file diff could not be loaded.');
      if (taskId(file) !== normalizedTaskId || file?.path !== normalizedPath) throw new Error('The returned diff did not match the requested task and file. Try again.');
      if (request !== diffRequestRef.current || taskIdRef.current !== normalizedTaskId || !activeRef.current) return false;
      if (mode === 'standalone') {
        if (currentRoutePath() !== 'code' || readRequestedTaskId() !== normalizedTaskId) return false;
        if (readRequestedFilePath() && readRequestedFilePath() !== normalizedPath) return false;
      }
      filePathRef.current = normalizedPath;
      setFilePath(normalizedPath);
      if (mode === 'standalone') {
        replaceRouteParams({ task: normalizedTaskId, file: normalizedPath });
      } else {
        onSelectFileRef.current?.(normalizedPath);
      }
      setDiffFile(file);
      setViewerMessage('');
      setViewerTone('');
      return true;
    } catch (error) {
      if (request !== diffRequestRef.current || taskIdRef.current !== normalizedTaskId || !activeRef.current) return false;
      if (mode === 'standalone') {
        if (currentRoutePath() !== 'code' || readRequestedTaskId() !== normalizedTaskId) return false;
        if (readRequestedFilePath() && readRequestedFilePath() !== normalizedPath) return false;
      }
      setDiffFile(null);
      setViewerMessage(messageFor(error));
      setViewerTone('error');
      return false;
    } finally {
      if (request === diffRequestRef.current) pendingDiffPathRef.current = '';
    }
  }, [bridge, mode]);

  const showUnavailableFile = useCallback(path => {
    diffRequestRef.current += 1;
    filePathRef.current = '';
    pendingDiffPathRef.current = '';
    setFilePath('');
    setDiffFile(null);
    setViewerMessage(`The requested file “${path}” is not available for this task. Choose a changed file or refresh to try again.`);
    setViewerTone('error');
  }, []);

  const refreshWorkspace = useCallback(async (requestedTask, { refreshCurrent = true } = {}) => {
    const normalizedTaskId = String(requestedTask || '').trim();
    if (!normalizedTaskId || !activeRef.current) return;
    const request = ++workspaceRequestRef.current;
    setWorkspaceLoading(true);
    try {
      const nextWorkspace = await bridge.get(normalizedTaskId);
      if (nextWorkspace?.ok === false) throw new Error(nextWorkspace.error || 'Task changes could not be loaded.');
      if (taskId(nextWorkspace) !== normalizedTaskId) throw new Error('The returned changes did not match the requested task. Try again.');
      if (request !== workspaceRequestRef.current || taskIdRef.current !== normalizedTaskId || !activeRef.current) return;
      setWorkspace(nextWorkspace);
      setWorkspaceError('');

      const changedFiles = changedTextFiles(nextWorkspace);
      const currentPath = filePathRef.current;
      const requestedPath = mode === 'standalone' ? readRequestedFilePath() : requestedPathRef.current;
      const currentStillExists = Boolean(currentPath && changedFiles.includes(currentPath));
      if (requestedPath && !changedFiles.includes(requestedPath)) {
        showUnavailableFile(requestedPath);
        return;
      }
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
      if (nextPath !== currentPath || refreshCurrent) await loadDiff(normalizedTaskId, nextPath, nextWorkspace);
    } catch (error) {
      if (request !== workspaceRequestRef.current || taskIdRef.current !== normalizedTaskId) return;
      diffRequestRef.current += 1;
      setWorkspace(null);
      setWorkspaceError(messageFor(error));
      setDiffFile(null);
      setViewerMessage(messageFor(error));
      setViewerTone('error');
    } finally {
      if (request === workspaceRequestRef.current && taskIdRef.current === normalizedTaskId) setWorkspaceLoading(false);
    }
  }, [bridge, loadDiff, showUnavailableFile, mode]);

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
    setCollapsedFolders(new Set());
  }, [selectedTaskId]);

  useEffect(() => () => {
    workspaceRequestRef.current += 1;
    diffRequestRef.current += 1;
  }, []);

  useEffect(() => {
    // Refresh the selected diff when that task's authoritative snapshot changes.
    // A global task revision also includes unrelated tasks and is not a file revision.
    if (active) void refreshWorkspace(selectedTaskId, { refreshCurrent: true });
    return () => {
      workspaceRequestRef.current += 1;
      diffRequestRef.current += 1;
    };
  }, [active, refreshWorkspace, selectedTaskId, selectedTask?.changeRevision, changeRevision]);

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
    if (!active || !workspace || !requestedFilePath) return;
    if (!changedFiles.includes(requestedFilePath)) {
      showUnavailableFile(requestedFilePath);
      return;
    }
    if (requestedFilePath === filePathRef.current || requestedFilePath === pendingDiffPathRef.current) return;
    void loadDiff(selectedTaskId, requestedFilePath, workspace);
  }, [active, changedFiles, loadDiff, requestedFilePath, selectedTaskId, showUnavailableFile, workspace]);
  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return changedFiles.filter(file => !normalized || file.toLowerCase().includes(normalized));
  }, [changedFiles, query]);
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const meta = workspaceMeta(workspace, workspaceError);
  const viewState = workspace?.historyMode === 'unavailable' ? 'Current files only' : 'Read-only diff';
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
    if (mode === 'standalone') {
      replaceRouteParams({ file: path });
    } else if (typeof onSelectFile === 'function') {
      onSelectFile(path);
    }
    void loadDiff(selectedTaskId, path, workspace);
  };

  const toggleFolder = useCallback(path => {
    if (!path) return;
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const isEmbedded = mode === 'embedded';
  return h('div', { className: isEmbedded ? 'task-diff-viewer' : 'section code-page', 'data-code-react': isEmbedded ? undefined : '' },
    isEmbedded
      ? h('div', { className: 'task-diff-embedded-toolbar' },
          h('div', { className: 'code-workspace-meta', 'data-code-meta': '' }, meta),
          h('div', { className: 'code-toolbar-actions' },
            h('a', {
              className: 'buttonlike secondary compact-button',
              'data-code-fullscreen-link': '',
              href: fullScreenHref || routeHref('code', { task: selectedTaskId, ...(filePath ? { file: filePath } : {}) })
            }, h(Icon, { name: 'externalLink', size: 14 }), h('span', null, 'Open changes full screen')),
            h('button', {
              className: 'secondary compact-button',
              type: 'button',
              'data-code-refresh': '',
              disabled: workspaceLoading,
              onClick: () => { void refreshWorkspace(selectedTaskId, { refreshCurrent: true }); }
            }, workspaceLoading ? 'Loading…' : workspaceError ? 'Retry' : 'Refresh')
          )
        )
      : h('div', { className: 'feature-toolbar code-toolbar' },
          h('div', { className: 'code-task-control' },
            h('label', { htmlFor: 'codeTaskSelect' }, 'Task'),
            h('select', {
              id: 'codeTaskSelect',
              'data-code-task': '',
              value: selectedTaskId,
              onChange: event => selectTask?.(event.target.value)
            },
              !selectedTask ? h('option', { value: selectedTaskId }, `Requested task · ${selectedTaskId}`) : null,
              tasks.map(task => h('option', { key: task.id, value: task.id }, task.label))
            )
          ),
          h('div', { className: 'code-toolbar-actions' },
            h('a', {
              className: 'buttonlike secondary',
              'data-code-task-link': '',
              href: routeHref('tasks', {
                workspace: returnContext ? returnContext.workspace : selectedTask?.workspace || workspace?.workspace,
                task: selectedTaskId,
                search: returnContext?.search,
                taskStatus: returnContext?.taskStatus
              })
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
              disabled: workspaceLoading,
              onClick: () => { void refreshWorkspace(selectedTaskId, { refreshCurrent: true }); }
            }, workspaceLoading ? 'Loading…' : workspaceError ? 'Retry' : 'Refresh')
          )
        ),
    isEmbedded ? null : h('div', { className: 'code-workspace-meta', 'data-code-meta': '' }, meta),
    workspaceError ? h('p', { className: 'connection-notice bad', role: 'alert', 'data-code-task-error': '' },
      `Changes for task ${selectedTaskId} could not be loaded. ${workspaceError} Use Retry to try again, or return to the task.`
    ) : null,
    h('div', { className: ['code-workbench', isEmbedded ? 'code-workbench-embedded' : ''].filter(Boolean).join(' ') },
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
            ? h('ul', { className: 'code-file-tree' }, ...renderFileTree(fileTree, { workspace, filePath, openFile, collapsedFolders, toggleFolder, filtering: Boolean(query.trim()) }))
            : h('div', { className: 'code-file-empty' }, query ? 'No matching changed files.' : (workspaceError ? 'Task changes are unavailable.' : 'No task-owned changes to review.'))
        )
      ),
      h('section', { className: 'code-editor-pane', 'aria-label': 'Task diff viewer' },
        h('div', { className: 'code-editor-toolbar' },
          h('div', { className: 'code-file-heading mono', 'data-code-file-heading': '' }, requestedFilePath || filePath || 'No file selected'),
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
        active ? h(DiffViewer, { file: diffFile, message: viewerMessage, tone: viewerTone, layout: diffLayout, viewStates: editorViewStates }) : null
      )
    )
  );
}

function DiffViewer({ file, message, tone, layout, viewStates }) {
  if (!file) {
    return h('div', {
      className: `code-editor-host code-editor-message${tone ? ` ${tone}` : ''}`,
      'data-code-editor': '',
      role: tone === 'error' ? 'alert' : 'status'
    }, message || 'Choose a changed file to review its diff.');
  }
  if (file.historyMode === 'unavailable') {
    return h('section', { className: 'code-editor-host code-historical-fallback', 'data-code-editor': '' },
      h('p', { role: 'status' }, 'Original task diff unavailable. This is the current file, not its historical version.'),
      file.exists ? h('pre', { tabIndex: 0 }, h('code', null, file.content))
        : h('p', null, 'This file no longer exists in the project.'));
  }
  return h(MonacoDiffViewer, { file, layout, viewStates });
}

const MonacoDiffViewer = memo(function MonacoDiffViewer({ file, layout, viewStates }) {
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
    const savedViews = viewStates?.current;

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
        fontFamily: '"Geist Mono Variable", "Cascadia Code", "SFMono-Regular", Consolas, monospace',
        fontLigatures: true
      });
      editorRef.current = editor;
      cleanupResize = bindEditorResize(editor, hostRef.current);
      cleanupTheme = bindEditorTheme(monaco);
      applyDiffModels(monaco, editor, modelsRef, fileRef.current);
      const saved = savedViews?.get(fileRef.current?.path);
      if (saved) editor.restoreViewState(saved);
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
      const path = fileRef.current?.path;
      const saved = editorRef.current?.saveViewState?.();
      if (path && saved) savedViews?.set(path, saved);
      clearDiffModels(editorRef.current, modelsRef);
      try { editorRef.current?.dispose?.(); } catch {}
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, [viewStates]);

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
  const fileKey = file ? [file.work_id || '', file.path || '', file.historyMode || '', file.commitHead || ''].join('\u0000') : '';
  const language = file?.language || 'plaintext';
  if (file && modelsRef.fileKey === fileKey && modelsRef.current.length === 2) {
    const viewState = editor.saveViewState?.();
    const contents = [file.baseContent || '', file.content || ''];
    modelsRef.current.forEach((model, index) => {
      if (model.getValue() !== contents[index]) model.setValue(contents[index]);
      if (model.getLanguageId?.() !== language) monaco.editor.setModelLanguage?.(model, language);
    });
    if (viewState) editor.restoreViewState?.(viewState);
    return;
  }
  clearDiffModels(editor, modelsRef);
  if (!file) return;
  modelsRef.fileKey = fileKey;
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
  modelsRef.fileKey = '';
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
  // Explicit identity is authoritative even when the retained task is absent
  // from the bounded dashboard summary. Only an unscoped visit gets a default.
  const selectedTaskId = requestedTaskId || taskIds[0] || '';

  useEffect(() => {
    if (!selectedTaskId || requestedTaskId) return;
    replaceRouteParams({ task: selectedTaskId, file: null });
  }, [requestedTaskId, selectedTaskId]);

  const selectTask = taskId => {
    const next = String(taskId || '').trim();
    if (!taskIds.includes(next) || next === selectedTaskId) return;
    replaceRouteParams({ task: next, file: null });
  };

  const returnContext = params.get('from') === 'tasks' ? {
    workspace: params.get('workspace') || '',
    search: params.get('search') || '',
    taskStatus: params.get('taskStatus') || ''
  } : null;
  return { selectedTaskId, requestedFilePath, selectTask, returnContext };
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
      workspace: String(task.workspace || ''),
      changeRevision: String(task.changeRevision ?? JSON.stringify(task))
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
      const wasCollapsed = context.collapsedFolders instanceof Set
        ? context.collapsedFolders.has(path)
        : Boolean(context.collapsedFolders?.[path]);
      const isCollapsed = !context.filtering && wasCollapsed;
      const toggle = () => { if (!context.filtering) context.toggleFolder?.(path); };
      const onKeyDown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      };
      return h('li', { className: 'code-tree-folder', key: `folder:${path}` },
        h('div', {
          className: 'code-tree-folder-label',
          title: path,
          role: 'button',
          tabIndex: 0,
          'aria-expanded': !isCollapsed,
          'aria-disabled': context.filtering || undefined,
          onClick: toggle,
          onKeyDown
        },
          h(Icon, { name: isCollapsed ? 'chevronRight' : 'chevronDown', size: 13 }),
          h('span', null, name)
        ),
        !isCollapsed ? h('ul', null, ...renderFileTree(child, context, path)) : null
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
