import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { fetchJson, invalidateCache, postJson, requestDashboardRefresh } from '../../api.js';
import { markUnsaved } from '../../interaction-safety.js';
import { getWorkspaceFilter, navigate, routeHref, setWorkspaceFilter } from '../../router.js';
import { timeAgo } from '../../utils.js';
import { workSessionStateView } from '../../task-identity.js';
import { deriveWorkspaceAlias, isValidWorkspaceAlias, normalizeWorkspacePath } from '../../workspace-input.js';
import {
  branchSummary,
  duplicateWorkspaceForPath,
  folderDisplayName,
  hasDuplicateSourcePaths,
  normalizeSourcePaths,
  parseSourcePaths,
  sourcePathsFromWorkspace,
  workspaceConflict
} from './model.js';

const h = React.createElement;

export function ProjectFormModal({ configuredWorkspaces = [], mode = 'add', onClose, opener = null, workspace = null }) {
  const isEdit = mode === 'edit';
  const originalAlias = String(workspace?.alias || '').trim();
  const initialPaths = useMemo(() => sourcePathsFromWorkspace(workspace), [workspace]);
  const initialAlias = String(workspace?.alias || '');
  const initialPathsText = initialPaths.join('\n');
  const isDesktop = document.documentElement.dataset.surface === 'desktop';
  const [alias, setAlias] = useState(initialAlias);
  const [pathsText, setPathsText] = useState(initialPathsText);
  const [manualMode, setManualMode] = useState(!isDesktop);
  const [busy, setBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState('');
  const [pathInfos, setPathInfos] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState('');
  const [confirmState, setConfirmState] = useState('');
  const [forgetLocalData, setForgetLocalData] = useState(true);
  const [pendingNavigation, setPendingNavigation] = useState('');
  const formRef = useRef(null);
  const aliasRef = useRef(null);
  const pathsRef = useRef(null);
  const emptySourceRef = useRef(null);
  const aliasEdited = useRef(Boolean(isEdit || initialAlias.trim()));
  const paths = useMemo(() => parseSourcePaths(pathsText), [pathsText]);
  const dirty = alias !== initialAlias || pathsText !== initialPathsText;

  useEffect(() => {
    const form = formRef.current;
    if (!form) return undefined;
    markUnsaved(form, dirty);
    return () => markUnsaved(form, false);
  }, [dirty]);
  useEffect(() => {
    if (aliasEdited.current) return;
    setAlias(deriveWorkspaceAlias(paths[0] || ''));
  }, [paths]);
  useEffect(() => {
    let active = true;
    const current = [...paths];
    if (!current.length) {
      setPathInfos([]);
      return () => { active = false; };
    }
    const timer = window.setTimeout(async () => {
      const infos = await Promise.all(current.map(path => fetchJson(`/api/workspace/preflight?path=${encodeURIComponent(path)}`, { cache: 'no-store' }).catch(() => null)));
      if (active) setPathInfos(infos);
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [paths]);

  const aliasError = !alias.trim()
    ? (submitted ? 'Enter a project name.' : '')
    : !isValidWorkspaceAlias(alias.trim())
      ? 'Project names may use only 1–80 letters, numbers, dots, underscores, and dashes.'
      : '';
  const sourceError = !paths.length
    ? (submitted ? 'Choose at least one source folder.' : '')
    : hasDuplicateSourcePaths(paths)
      ? 'Each source folder can be added only once.'
      : '';
  const conflict = workspaceConflict(configuredWorkspaces, { alias, paths, originalAlias });
  const pathStatus = projectPathStatus(paths, pathInfos);
  const clearDirty = () => { if (formRef.current) markUnsaved(formRef.current, false); };
  const finishClose = () => { clearDirty(); onClose?.(); };
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmState('discard');
    else onClose?.();
  };
  const requestNavigate = href => {
    if (!href) return;
    if (dirty) {
      setPendingNavigation(href);
      setConfirmState('navigate');
      return;
    }
    onClose?.();
    location.hash = href;
  };
  const resolveConfirmation = accepted => {
    const state = confirmState;
    setConfirmState('');
    if (!accepted) { setPendingNavigation(''); return; }
    if (state === 'delete') {
      void deleteProject(originalAlias, { forgetLocalData, setBusy, onSuccess: finishClose });
      return;
    }
    clearDirty();
    onClose?.();
    if (state === 'navigate' && pendingNavigation) location.hash = pendingNavigation;
    setPendingNavigation('');
  };

  const setSourcePaths = values => setPathsText(normalizeSourcePaths(values).join('\n'));
  const browse = async replaceIndex => {
    const key = Number.isInteger(replaceIndex) ? `replace-${replaceIndex}` : 'add';
    setPickerBusy(key);
    const result = await postJson('/api/pick-folder', {}, { timeout: 0 });
    setPickerBusy('');
    if (result?.unsupported) {
      setManualMode(true);
      toast('Folder browsing is unavailable here — enter one folder path per line instead.', { variant: 'info' });
      queueMicrotask(() => pathsRef.current?.focus());
      return;
    }
    if (result?.canceled) return;
    if (!result?.ok || !result.path) {
      if (result?.error) toast(`Could not open folder picker: ${result.error}`, { variant: 'error' });
      return;
    }
    const candidate = String(result.path).trim();
    const candidateKey = normalizeWorkspacePath(candidate);
    const duplicate = paths.some((value, index) => index !== replaceIndex && normalizeWorkspacePath(value) === candidateKey);
    if (duplicate) {
      toast('That source folder is already attached to this project.', { variant: 'info' });
      return;
    }
    const next = [...paths];
    if (Number.isInteger(replaceIndex) && replaceIndex >= 0 && replaceIndex < next.length) next[replaceIndex] = candidate;
    else next.push(candidate);
    setSourcePaths(next);
  };

  const submit = async event => {
    event.preventDefault();
    setSubmitted(true);
    setServerError('');
    if (!paths.length || hasDuplicateSourcePaths(paths)) {
      (manualMode ? pathsRef.current : emptySourceRef.current)?.focus();
      return;
    }
    if (!alias.trim() || !isValidWorkspaceAlias(alias.trim())) { aliasRef.current?.focus(); return; }
    if (conflict) return;
    const cleanAlias = alias.trim();
    setBusy(true);
    const result = await postJson('/api/workspaces', {
      action: 'upsert',
      mode: isEdit ? 'update' : 'create',
      originalAlias: isEdit ? originalAlias : cleanAlias,
      alias: cleanAlias,
      path: paths[0],
      sourcePaths: paths,
      enforceUniquePath: true
    });
    setBusy(false);
    if (!result?.ok) {
      const message = result?.error || 'unknown error';
      setServerError(message);
      toast(`Could not save project: ${message}`, { variant: 'error' });
      return;
    }
    clearDirty();
    invalidateCache();
    requestDashboardRefresh();
    toast(`${isEdit ? 'Project updated' : 'Project added'}: ${cleanAlias}`, { variant: 'success' });
    onClose?.();
    if (!isEdit && configuredWorkspaces.length === 0) navigate('home');
    else if (getWorkspaceFilter() === originalAlias && originalAlias !== cleanAlias) setWorkspaceFilter(cleanAlias);
    else if (isEdit) navigate('workspaces', { workspace: cleanAlias, focus: '1' });
  };

  const confirmation = confirmState === 'delete'
    ? deleteConfirmation(originalAlias, { forgetLocalData, setForgetLocalData })
    : confirmState
      ? { title: 'Discard changes?', message: 'Discard the unsaved changes in this dialog?', detail: 'Your changes will not be saved.', confirmLabel: 'Discard changes', danger: true }
      : null;

  return h(ProjectModal, {
    title: isEdit ? 'Edit project' : 'Create project',
    opener,
    onDismiss: requestClose,
    initialFocus: () => (isEdit || initialPaths.length ? aliasRef.current : manualMode ? pathsRef.current : emptySourceRef.current),
    confirmation,
    onResolveConfirmation: resolveConfirmation
  }, h('form', { className: 'ws-form ws-project-form', ref: formRef, onSubmit: submit, 'aria-busy': busy ? 'true' : undefined },
    h('section', { className: 'ws-project-name-section' },
      h('label', { className: 'ws-form-label', htmlFor: 'workspaceAliasInput' }, 'Project name'),
      h('div', { className: 'ws-project-name-field' },
        h(Icon, { name: 'folder', className: 'ws-folder-icon', size: 16 }),
        h('input', {
          id: 'workspaceAliasInput', name: 'alias', type: 'text', value: alias, placeholder: 'Project name', autoComplete: 'off', ref: aliasRef,
          'aria-describedby': 'workspaceAliasHelp workspaceAliasError workspaceConflictError', 'aria-invalid': Boolean(aliasError),
          onChange: event => { aliasEdited.current = Boolean(event.target.value.trim()); setAlias(event.target.value); setServerError(''); }
        })
      ),
      h('div', { className: 'ws-form-help', id: 'workspaceAliasHelp' }, 'This is the project name ChatGPT uses when selecting a folder.'),
      aliasError ? h('div', { className: 'ws-form-conflict', id: 'workspaceAliasError', role: 'alert' }, aliasError) : null,
      conflict || serverError ? h('div', { className: 'ws-form-conflict', id: 'workspaceConflictError', role: 'alert', tabIndex: -1 }, conflict || serverError) : null
    ),
    h(SourceFolders, { paths, pathsText, setPathsText, setSourcePaths, manualMode, pickerBusy, browse, sourceError, pathStatus, pathsRef, emptySourceRef }),
    isEdit ? h(ProjectDetails, { workspace, alias: originalAlias, onNavigate: requestNavigate }) : null,
    h('footer', { className: 'modal-footer' },
      isEdit ? h('div', { className: 'modal-danger-zone' },
        h('button', { type: 'button', className: 'secondary danger', disabled: busy, onClick: () => setConfirmState('delete') }, 'Delete project from Rel.AI'),
        h('span', null, 'Removes Rel.AI access. Files stay on your computer.')
      ) : h('span'),
      h('div', { className: 'modal-actions' },
        h('button', { type: 'button', className: 'secondary', disabled: busy, onClick: requestClose }, 'Cancel'),
        h('button', { type: 'submit', className: 'primary', disabled: busy || Boolean(conflict) }, busy ? 'Saving project…' : isEdit ? 'Save' : 'Create project')
      )
    )
  ));
}

export function RepairProjectModal(props) {
  if (!props.workspace?.alias) return null;
  return h(RepairProjectModalContent, props);
}

function RepairProjectModalContent({ configuredWorkspaces = [], onClose, opener = null, workspace }) {
  const initialPath = String(workspace.path || '');
  const isDesktop = document.documentElement.dataset.surface === 'desktop';
  const [path, setPath] = useState(initialPath);
  const [manualMode, setManualMode] = useState(!isDesktop);
  const [pathInfo, setPathInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [serverError, setServerError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const formRef = useRef(null);
  const pathRef = useRef(null);
  const browseRef = useRef(null);
  const dirty = path !== initialPath;
  const duplicate = duplicateWorkspaceForPath(configuredWorkspaces, path, workspace.alias);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return undefined;
    markUnsaved(form, dirty);
    return () => markUnsaved(form, false);
  }, [dirty]);
  useEffect(() => {
    let active = true;
    const clean = path.trim();
    if (!clean) { setPathInfo(null); return () => { active = false; }; }
    const timer = window.setTimeout(async () => {
      const result = await fetchJson(`/api/workspace/preflight?path=${encodeURIComponent(clean)}`, { cache: 'no-store' }).catch(() => null);
      if (active) setPathInfo(result);
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [path]);

  const clearDirty = () => { if (formRef.current) markUnsaved(formRef.current, false); };
  const requestClose = () => dirty ? setConfirmDiscard(true) : onClose?.();
  const browse = async () => {
    setPickerBusy(true);
    const result = await postJson('/api/pick-folder', {}, { timeout: 0 });
    setPickerBusy(false);
    if (result?.unsupported) {
      setManualMode(true);
      toast('Folder browsing is unavailable here — enter the folder path instead.', { variant: 'info' });
      queueMicrotask(() => pathRef.current?.focus());
      return;
    }
    if (result?.ok && result.path) setPath(String(result.path));
    else if (result?.error && !result?.canceled) toast(`Could not open folder picker: ${result.error}`, { variant: 'error' });
  };
  const onRepairDrop = async event => {
    if (typeof window.relaiDesktop?.getPathForFile !== 'function') return;
    event.preventDefault();
    setDropActive(false);
    const dropped = await resolveDroppedFolders(event.dataTransfer);
    if (!dropped.length) return;
    setPath(dropped[0]);
    if (dropped.length > 1) toast('Using the first dropped folder for this repair.', { variant: 'info' });
  };
  const submit = async event => {
    event.preventDefault();
    const clean = path.trim();
    if (!clean) { toast('Choose the replacement source folder.', { variant: 'error' }); (manualMode ? pathRef.current : browseRef.current)?.focus(); return; }
    if (duplicate) return;
    setBusy(true);
    setServerError('');
    const result = await postJson('/api/workspaces', {
      action: 'upsert', mode: 'update', originalAlias: workspace.alias, alias: workspace.alias, path: clean, enforceUniquePath: true
    });
    setBusy(false);
    if (!result?.ok) {
      const message = result?.error || 'unknown error';
      setServerError(message);
      toast(`Could not repair project: ${message}`, { variant: 'error' });
      return;
    }
    clearDirty();
    invalidateCache();
    requestDashboardRefresh();
    toast(`Project folder repaired: ${workspace.alias}`, { variant: 'success' });
    onClose?.();
    navigate('workspaces', { workspace: workspace.alias, focus: '1' });
  };
  const status = repairPathStatus(pathInfo);
  const conflict = duplicate ? `This folder is already configured as project '${duplicate.alias}'.` : serverError;
  return h(ProjectModal, {
    title: 'Repair project', opener, onDismiss: requestClose,
    initialFocus: () => manualMode ? pathRef.current : browseRef.current,
    confirmation: confirmDiscard ? { title: 'Discard changes?', message: 'Discard the replacement folder change?', detail: 'The current project location will stay unchanged.', confirmLabel: 'Discard changes', danger: true } : null,
    onResolveConfirmation: accepted => { setConfirmDiscard(false); if (accepted) { clearDirty(); onClose?.(); } }
  }, h('form', { className: 'ws-form workspace-repair-form', ref: formRef, onSubmit: submit, 'aria-busy': busy ? 'true' : undefined },
    h('p', { className: 'workspace-repair-copy' }, 'Rel.AI will keep the project name, check history, and Git safety settings. Only the source-folder location will change.'),
    h('div', { className: 'workspace-repair-identity' }, h('span', null, 'Project'), h('strong', null, workspace.alias), h('small', null, workspace.path || 'No source folder configured')),
    h('section', { className: 'ws-source-section', 'aria-labelledby': 'workspaceRepairSourceHeading' },
      h('h3', { className: 'ws-source-heading', id: 'workspaceRepairSourceHeading' }, 'Replacement source folder'),
      h('div', {
        className: `ws-source-folder-box${dropActive ? ' is-drop-active' : ''}`,
        onDragEnter: event => { if (typeof window.relaiDesktop?.getPathForFile === 'function') { event.preventDefault(); setDropActive(true); } },
        onDragOver: event => { if (typeof window.relaiDesktop?.getPathForFile === 'function') { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } },
        onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropActive(false); },
        onDrop: event => { void onRepairDrop(event); }
      },
        !manualMode ? h('div', { className: 'ws-source-folder-row' },
          h(Icon, { name: 'folder', className: 'ws-folder-icon', size: 16 }),
          h('span', { className: 'ws-source-folder-copy' }, h('strong', null, folderDisplayName(path) || 'Choose a folder'), h('small', null, path)),
          h('button', { type: 'button', className: 'ws-source-folder-change', disabled: pickerBusy || busy, ref: browseRef, onClick: () => { void browse(); } }, pickerBusy ? 'Opening…' : 'Change')
        ) : h('div', { className: 'ws-source-manual ws-source-manual-only' },
          h('label', { htmlFor: 'workspaceRepairPathInput' }, 'Folder path'),
          h('input', { className: 'ws-form-path', id: 'workspaceRepairPathInput', name: 'path', value: path, placeholder: 'Absolute path to the project', autoComplete: 'off', ref: pathRef, 'aria-invalid': Boolean(conflict), 'aria-describedby': 'workspaceRepairStatus workspaceRepairConflict', onChange: event => { setPath(event.target.value); setServerError(''); } }),
          h('span', { className: 'ws-form-help' }, 'Enter the absolute path to the replacement source folder.')
        )
      ),
      h('div', { className: `ws-form-status${status.tone ? ` ${status.tone}` : ''}`, id: 'workspaceRepairStatus', 'aria-live': 'polite' }, status.text),
      conflict ? h('div', { className: 'ws-form-conflict', id: 'workspaceRepairConflict', role: 'alert' }, conflict) : null
    ),
    h('footer', { className: 'modal-footer' }, h('span'), h('div', { className: 'modal-actions' },
      h('button', { type: 'button', className: 'secondary', disabled: busy, onClick: requestClose }, 'Cancel'),
      h('button', { type: 'submit', className: 'primary', disabled: busy || !path.trim() || Boolean(duplicate) }, busy ? 'Saving source folder…' : 'Save')
    ))
  ));
}

export function DeleteProjectModal({ alias = '', onClose, opener = null }) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);
  const descriptor = deleteConfirmation(alias);
  return h(ProjectModal, { title: descriptor.title, opener, onDismiss: onClose, size: 'compact', showClose: false, initialFocus: () => cancelRef.current },
    h('div', { className: 'confirm-dialog', 'aria-busy': busy ? 'true' : undefined },
      h('div', { className: 'confirm-dialog-copy' }, h('strong', null, descriptor.message), h('span', null, descriptor.detail)),
      h('div', { className: 'modal-actions' },
        h('button', { type: 'button', className: 'secondary', disabled: busy, ref: cancelRef, onClick: onClose }, 'Cancel'),
        h('button', { type: 'button', className: 'danger', disabled: busy, onClick: () => { void deleteProject(alias, { setBusy, onSuccess: onClose }); } }, busy ? 'Deleting…' : descriptor.confirmLabel)
      )
    )
  );
}

function SourceFolders({ browse, emptySourceRef, manualMode, pathStatus, paths, pathsRef, pathsText, pickerBusy, setPathsText, setSourcePaths, sourceError }) {
  const [dropActive, setDropActive] = useState(false);
  const canDropFolders = typeof window.relaiDesktop?.getPathForFile === 'function';
  const onDrop = async event => {
    if (!canDropFolders) return;
    event.preventDefault();
    setDropActive(false);
    const dropped = await resolveDroppedFolders(event.dataTransfer);
    if (!dropped.length) return;
    const next = normalizeSourcePaths([...paths, ...dropped]);
    const added = next.length - paths.length;
    setSourcePaths(next);
    if (added < dropped.length) toast('Duplicate source folders were skipped.', { variant: 'info' });
  };
  return h('section', { className: 'ws-source-section', 'aria-labelledby': 'wsSourceFolderHeading' },
    h('h3', { className: 'ws-source-heading', id: 'wsSourceFolderHeading' }, 'Source folders'),
    h('div', {
      className: `ws-source-folder-box${dropActive ? ' is-drop-active' : ''}`,
      onDragEnter: event => { if (canDropFolders) { event.preventDefault(); setDropActive(true); } },
      onDragOver: event => { if (canDropFolders) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } },
      onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropActive(false); },
      onDrop: event => { void onDrop(event); }
    },
      !manualMode ? h(React.Fragment, null,
        paths.length ? h('ul', { className: 'ws-source-folder-list' }, paths.map((value, index) => h('li', { className: 'ws-source-folder-row', key: `${normalizeWorkspacePath(value)}-${index}` },
          h(Icon, { name: 'folder', className: 'ws-folder-icon', size: 16 }),
          h('span', { className: 'ws-source-folder-copy' }, h('span', { className: 'ws-source-folder-title' }, h('strong', null, folderDisplayName(value)), index === 0 ? h('small', { className: 'ws-source-primary' }, 'Primary') : null), h('small', null, value)),
          h('span', { className: 'ws-source-folder-actions' },
            h('button', { type: 'button', className: 'ws-source-folder-change', disabled: Boolean(pickerBusy), 'aria-label': `Change source folder ${value}`, onClick: () => { void browse(index); } }, pickerBusy === `replace-${index}` ? 'Opening…' : 'Change'),
            h('button', { type: 'button', className: 'ws-source-folder-remove', disabled: Boolean(pickerBusy), 'aria-label': `Remove source folder ${value}`, onClick: () => setSourcePaths(paths.filter((_, itemIndex) => itemIndex !== index)) }, 'Remove')
          )
        ))) : null,
        paths.length ? h('button', { type: 'button', className: 'ws-source-folder-add', disabled: Boolean(pickerBusy), onClick: () => { void browse(); } }, pickerBusy === 'add' ? 'Opening folder picker…' : '+ Add source folder')
          : h('button', { type: 'button', className: 'ws-source-folder-empty', disabled: Boolean(pickerBusy), ref: emptySourceRef, 'aria-describedby': 'workspaceSourceError', 'aria-invalid': Boolean(sourceError), onClick: () => { void browse(); } }, h(Icon, { name: 'folder', className: 'ws-folder-icon', size: 16 }), h('span', null, pickerBusy === 'add' ? 'Opening folder picker…' : 'Choose a source folder'))
      ) : h('div', { className: 'ws-source-manual ws-source-manual-only' },
        h('label', { htmlFor: 'workspacePathsInput' }, 'Folder paths'),
        h('textarea', { className: 'ws-form-path', id: 'workspacePathsInput', name: 'paths', rows: 4, value: pathsText, placeholder: 'One absolute folder path per line', autoComplete: 'off', ref: pathsRef, 'aria-describedby': 'workspacePathsHelp workspaceSourceError', 'aria-invalid': Boolean(sourceError), onChange: event => setPathsText(event.target.value) }),
        h('span', { className: 'ws-form-help', id: 'workspacePathsHelp' }, 'Enter one absolute source-folder path per line.')
      ),
      canDropFolders ? h('div', { className: 'ws-source-drop-hint', 'aria-hidden': 'true' }, h(Icon, { name: 'folder', size: 14 }), 'Drop folders here') : null
    ),
    h('div', { className: 'ws-form-help' }, 'The first folder is the primary project folder. Rel.AI uses it for file and command actions. Git actions are available for Git repositories.'),
    sourceError ? h('div', { className: 'ws-form-conflict', id: 'workspaceSourceError', role: 'alert' }, sourceError) : null,
    h('div', { className: `ws-form-status${pathStatus.tone ? ` ${pathStatus.tone}` : ''}`, 'aria-live': 'polite' }, pathStatus.text)
  );
}

async function resolveDroppedFolders(dataTransfer) {
  const getPathForFile = window.relaiDesktop?.getPathForFile;
  if (typeof getPathForFile !== 'function') return [];
  const candidates = [...new Set([...dataTransfer.files]
    .map(file => String(getPathForFile(file) || '').trim())
    .filter(Boolean))];
  if (!candidates.length) return [];
  const checked = await Promise.all(candidates.map(async candidate => {
    const result = await fetchJson(`/api/workspace/preflight?path=${encodeURIComponent(candidate)}`, { cache: 'no-store' }).catch(() => null);
    return result?.ok && result?.isDirectory ? String(result.path || candidate) : '';
  }));
  const valid = checked.filter(Boolean);
  if (valid.length < candidates.length) toast('Only local folders can be added. Files or unavailable paths were skipped.', { variant: 'info' });
  return valid;
}

function ProjectDetails({ alias, onNavigate, workspace }) {
  const operational = workspace?.operational || {};
  const validation = operational.lastValidation
    ? relativeOperationalValue(operational.lastValidation.status, operational.lastValidation.completedAt)
    : 'Not run yet';
  const activity = operational.lastTask
    ? relativeOperationalValue(
        workSessionStateView(operational.lastTask).label.toLowerCase(),
        operational.lastTask.completedAt || operational.lastTask.startedAt
      )
    : 'No task history';
  const rows = operational.isGit
    ? [['Branch', branchSummary(operational)], ['File changes', operational.dirty ? `${Number(operational.changedFileCount || 0)} changed · ${Number(operational.sessionChangedFileCount || 0)} from current session` : 'Clean'], ['Last checks', validation], ['Last activity', activity]]
    : [['Git', 'Not initialized'], ['Last checks', validation], ['Last activity', activity]];
  const tasksHref = routeHref('tasks', { workspace: alias });
  const activityHref = routeHref('activity', { workspace: alias });
  return h('section', { className: 'ws-project-details-section', 'aria-labelledby': 'wsProjectDetailsHeading' },
    h('h3', { className: 'ws-source-heading', id: 'wsProjectDetailsHeading' }, 'Project details'),
    h('div', { className: 'ws-project-details-box' },
      h('div', { className: 'workspace-operational' }, rows.map(([label, value]) => h('div', { key: label }, h('span', null, label), h('strong', typeof value === 'string' ? { title: value } : null, value)))),
      h('div', { className: 'workspace-secondary-actions' },
        h('a', { className: 'buttonlike secondary', href: tasksHref, onClick: event => { event.preventDefault(); onNavigate(tasksHref); } }, 'View tasks'),
        h('a', { className: 'buttonlike secondary', href: activityHref, onClick: event => { event.preventDefault(); onNavigate(activityHref); } }, 'View activity')
      )
    )
  );
}

function relativeOperationalValue(label, timestamp) {
  const relative = timeAgo(timestamp) || '—';
  return h(React.Fragment, null,
    `${label} · `,
    h('span', timestamp ? { 'data-clock-relative': timestamp } : null, relative)
  );
}

function ProjectModal({ children, confirmation = null, initialFocus, onDismiss, onResolveConfirmation, opener, showClose = true, size = 'standard', title }) {
  const confirmCancelRef = useRef(null);
  return h(Dialog.Root, {
    open: true,
    onOpenChange: next => {
      if (next) return;
      if (confirmation) onResolveConfirmation?.(false);
      else onDismiss?.();
    }
  }, h(Dialog.Portal, null,
    h(Dialog.Overlay, { asChild: true },
      h('div', { id: '__relai-modal-backdrop', className: 'overlay-backdrop modal-backdrop' },
        h(Dialog.Content, {
          asChild: true,
          onOpenAutoFocus: event => {
            event.preventDefault();
            queueMicrotask(() => {
              const target = initialFocus?.();
              if (target instanceof HTMLElement) target.focus({ preventScroll: true });
            });
          },
          onEscapeKeyDown: event => {
            if (confirmation) event.preventDefault();
          },
          onPointerDownOutside: event => {
            if (confirmation) event.preventDefault();
          },
          onCloseAutoFocus: event => {
            event.preventDefault();
            if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
            else document.getElementById('pageTitle')?.focus({ preventScroll: true });
          }
        }, h('div', { className: `modal-panel modal-${size}` },
          h('header', { className: 'modal-head', inert: confirmation ? true : undefined },
            h(Dialog.Title, { asChild: true }, h('h2', { className: 'modal-title' }, title)),
            showClose ? h('button', { type: 'button', className: 'modal-close', 'aria-label': `Close ${title}`, onClick: onDismiss }, h(Icon, { name: 'close', size: 16 })) : null
          ),
          h('div', { className: 'modal-body', inert: confirmation ? true : undefined }, children),
          confirmation ? h(AlertDialog.Root, { open: true },
            h('div', { className: 'modal-inline-confirm-layer' },
              h(AlertDialog.Content, {
                asChild: true,
                onOpenAutoFocus: event => {
                  event.preventDefault();
                  queueMicrotask(() => confirmCancelRef.current?.focus({ preventScroll: true }));
                },
                onEscapeKeyDown: event => {
                  event.preventDefault();
                  onResolveConfirmation?.(false);
                }
              }, h('section', { className: 'modal-inline-confirm-card' },
                h(AlertDialog.Title, { asChild: true }, h('h3', { className: 'modal-inline-confirm-title' }, confirmation.title)),
                h(AlertDialog.Description, { asChild: true },
                  h('div', { className: 'confirm-dialog-copy' },
                    h('strong', null, confirmation.message),
                    confirmation.detail ? h('span', null, confirmation.detail) : null,
                    confirmation.control || null
                  )
                ),
                h('div', { className: 'modal-actions' },
                  h(AlertDialog.Cancel, { asChild: true }, h('button', { type: 'button', className: 'secondary', ref: confirmCancelRef, onClick: () => onResolveConfirmation?.(false) }, 'Cancel')),
                  h(AlertDialog.Action, { asChild: true }, h('button', { type: 'button', className: confirmation.danger ? 'danger' : 'primary', onClick: () => onResolveConfirmation?.(true) }, confirmation.confirmLabel || 'Continue'))
                )
              ))
            )
          ) : null
        ))
      )
    )
  ));
}

function projectPathStatus(paths, infos) {
  if (!paths.length || !infos.length) return { text: '', tone: '' };
  if (paths.length === 1) return genericPathStatus(infos[0], false);
  const gitCount = infos.filter(info => info?.isGit).length;
  const directoryCount = infos.filter(info => info?.exists && info?.isDirectory).length;
  const unavailableCount = paths.length - directoryCount;
  const nonGitCount = Math.max(0, directoryCount - gitCount);
  const parts = [`${paths.length} source folders selected`];
  if (gitCount) parts.push(`${gitCount} Git ${gitCount === 1 ? 'project' : 'projects'}`);
  if (nonGitCount) parts.push(`${nonGitCount} non-Git ${nonGitCount === 1 ? 'folder' : 'folders'}`);
  if (unavailableCount) parts.push(`${unavailableCount} not available yet`);
  return { text: parts.join(' · '), tone: unavailableCount || nonGitCount ? 'warn' : 'success' };
}
function repairPathStatus(info) { return genericPathStatus(info, true); }
function genericPathStatus(info, repair) {
  if (!info) return { text: '', tone: '' };
  const errorFinding = (info.findings || []).find(finding => finding.severity === 'error');
  if (info.isGit) return { text: repair ? 'Git project found. Your project settings will be kept.' : 'Git project found. Rel.AI will find available checks automatically.', tone: 'success' };
  if (info.exists && info.isDirectory) return { text: repair ? 'This folder is not using Git, but you can still use it.' : 'This folder is not using Git, but you can still add it.', tone: 'warn' };
  if (errorFinding) return { text: repair ? errorFinding.message : `${errorFinding.message} You can save this folder before cloning the project.`, tone: repair ? 'error' : 'warn' };
  return repair ? { text: 'The selected folder could not be verified.', tone: 'warn' } : { text: '', tone: '' };
}
function deleteConfirmation(alias, { forgetLocalData, setForgetLocalData }) {
  return {
    title: 'Delete project from Rel.AI?',
    message: `'${alias}' will be removed from Rel.AI.`,
    detail: forgetLocalData
      ? 'Rel.AI will also remove this project’s stored task history, analytics, safety state, and cached project data. Source folders and files stay on your computer.'
      : 'Rel.AI will keep this project’s historical task activity and analytics. Cached project indexing is still removed. Source folders and files stay on your computer.',
    control: h('label', { className: 'toggle-control' },
      h('input', {
        type: 'checkbox',
        checked: forgetLocalData,
        onChange: event => setForgetLocalData(event.currentTarget.checked)
      }),
      h('span', null, 'Forget stored activity for this project')
    ),
    confirmLabel: 'Delete from Rel.AI',
    danger: true
  };
}
async function deleteProject(alias, { forgetLocalData = true, onSuccess, setBusy }) {
  setBusy?.(true);
  const result = await postJson('/api/workspaces', { action: 'delete', alias, confirmDelete: true, forgetLocalData });
  setBusy?.(false);
  if (!result?.ok) { toast(`Could not delete project from Rel.AI: ${result?.error || 'unknown error'}`, { variant: 'error' }); return false; }
  toast(`Project deleted from Rel.AI: ${alias}`, { variant: 'success' });
  onSuccess?.();
  if (getWorkspaceFilter() === alias) setWorkspaceFilter('');
  else requestDashboardRefresh();
  return true;
}
