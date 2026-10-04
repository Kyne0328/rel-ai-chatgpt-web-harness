import React, { useEffect, useMemo, useState } from 'react';
import './styles.css';
import * as Dialog from '@radix-ui/react-dialog';
import { fetchJson, invalidateCache, postJson } from '../../api.js';
import { copyText } from '../../clipboard.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { Icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';

const h = React.createElement;
import { EXTENSION_SCHEMA_URL, PERMISSION_METADATA, TABS, TEMPLATES } from './metadata.js';
const EXTENSIONS_REPOSITORY_URL = 'https://github.com/Kyne0328/rel-ai-extensions';
const EXTENSIONS_LOAD_TIMEOUT_MS = 30 * 1000;
const EXTENSIONS_CACHE_TTL_MS = 15 * 1000;

function createExtensionsRoute() {
  return function ExtensionsRoute() {
    const [activeTab, setActiveTab] = useState('installed');
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [inspectedExtension, setInspectedExtension] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterKind, setFilterKind] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');

    const load = async ({ refresh = false } = {}) => {
      const url = `/api/extensions${refresh ? '?refresh=1' : ''}`;
      const result = await fetchJson(url, refresh
        ? { cache: 'no-store', timeout: EXTENSIONS_LOAD_TIMEOUT_MS }
        : { cacheTtlMs: EXTENSIONS_CACHE_TTL_MS, timeout: EXTENSIONS_LOAD_TIMEOUT_MS });
      if (!result?.ok) {
        setError(result?.error || 'Extensions could not be loaded.');
        return null;
      }
      setData(result);
      setError('');
      return result;
    };

    useEffect(() => { void load(); }, []);

    const refreshCatalog = async () => {
      if (busy) return;
      setBusy('refresh');
      try {
        const result = await load({ refresh: true });
        if (result?.catalogError) toast(result.catalogError, { variant: 'error' });
        else if (result) toast('Extension catalog refreshed.', { variant: 'info' });
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Extensions could not be loaded.');
      } finally {
        setBusy('');
      }
    };

    const catalogById = useMemo(() => new Map((data?.catalog || []).map(entry => [entry.id, entry])), [data?.catalog]);
    const installedById = useMemo(() => new Map((data?.installed || []).map(entry => [entry.id, entry])), [data?.installed]);

    const stats = useMemo(() => {
      const installed = data?.installed || [];
      const catalog = data?.catalog || [];
      const readyCount = installed.filter(item => item.ready).length;
      const updatesCount = catalog.filter(item => item.updateAvailable).length;
      return {
        installedCount: installed.length,
        readyCount,
        needsSetupCount: installed.length - readyCount,
        updatesCount,
        catalogCount: catalog.length,
        sourcesCount: data?.sources?.length || 0
      };
    }, [data?.installed, data?.catalog, data?.sources?.length]);

    const runInstall = async (entry, action = 'install') => {
      if (!entry?.id || busy) return;
      const permissions = permissionSummary(entry.permissions);
      const cliSetup = entry.autoInstall
        ? ' If a required command is missing and the manifest includes a managed artifact for this computer, Rel.AI downloads and verifies that tool. Otherwise, the extension installs as Setup needed until the command is available.'
        : entry.kind === 'cli'
          ? ' This extension requires its command to be available on your system PATH.'
          : '';
      const confirmed = await confirmAction({
        title: action === 'update' ? `Update ${entry.name}` : `Install ${entry.name}`,
        message: `${action === 'update' ? 'Update' : 'Install'} this extension from the Rel.AI extension catalog?`,
        detail: permissions.length
          ? `This extension requests these permissions: ${permissions}. Rel.AI still applies its normal authorization rules and permission prompts to local actions.${cliSetup}`
          : `This extension requests no additional permissions. Rel.AI still applies its normal authorization rules to local actions.${cliSetup}`,
        confirmLabel: action === 'update' ? 'Update extension' : 'Install extension'
      });
      if (!confirmed) return;
      setBusy(`${action}:${entry.id}`);
      const result = await postJson('/api/extensions', { action, id: entry.id, sourceId: entry.sourceId || '', confirmPermissions: true }, { cache: 'no-store', timeout: 15 * 60 * 1000 });
      setBusy('');
      if (!result?.ok) {
        toast(result?.error || `Could not ${action} the extension.`, { variant: 'error' });
        return;
      }
      if (result.extension?.ready === false) {
        const missing = Array.isArray(result.extension.missingCommands) ? result.extension.missingCommands : [];
        const detail = missing.length
          ? ` Missing required command${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`
          : result.extension.error ? ` ${result.extension.error}` : '';
        toast(`${entry.name} ${action === 'update' ? 'updated' : 'installed'}, but setup is still needed.${detail}`, { variant: 'warn' });
      } else {
        toast(action === 'update' ? `${entry.name} updated.` : `${entry.name} installed successfully.`, { variant: 'success' });
      }
      invalidateCache('/api/extensions');
      await load();
      if (inspectedExtension?.id === entry.id) {
        setInspectedExtension(null);
      }
    };

    const runAddSource = async url => {
      if (busy) return { ok: false, error: 'Another extension action is still running.' };
      setBusy('add-source');
      try {
        const result = await postJson('/api/extensions', { action: 'add_source', url }, { cache: 'no-store', timeout: 60 * 1000 });
        if (!result?.ok) {
          toast(result?.error || 'Could not add the extension source.', { variant: 'error' });
          return result || { ok: false, error: 'Could not add the extension source.' };
        }
        const count = Number(result.source?.extensionCount || 0);
        toast(`Extension source added${count ? ` with ${count} extension${count === 1 ? '' : 's'}` : ''}.`, { variant: 'success' });
        invalidateCache('/api/extensions');
        await load({ refresh: true });
        return result;
      } finally {
        setBusy('');
      }
    };

    const runRemoveSource = async source => {
      if (!source?.id || source.official || busy) return null;
      const installedCount = Number(source.installedCount || 0);
      const confirmed = await confirmAction({
        title: `Remove ${source.name}`,
        message: 'Remove this extension source from Rel.AI?',
        detail: installedCount
          ? `${installedCount} installed extension${installedCount === 1 ? '' : 's'} from this source will stay installed. Update discovery for them stops until you add the source again.`
          : 'Installed extensions are not removed when you remove a source.',
        confirmLabel: 'Remove source',
        danger: true
      });
      if (!confirmed) return null;
      setBusy(`remove-source:${source.id}`);
      try {
        const result = await postJson('/api/extensions', { action: 'remove_source', sourceId: source.id, confirmRemoveSource: true }, { cache: 'no-store' });
        if (!result?.ok) {
          toast(result?.error || 'Could not remove the extension source.', { variant: 'error' });
          return result;
        }
        const retained = Array.isArray(result.installedExtensions) ? result.installedExtensions.length : 0;
        toast(retained ? `Source removed. ${retained} installed extension${retained === 1 ? '' : 's'} kept.` : 'Extension source removed.', { variant: 'success' });
        invalidateCache('/api/extensions');
        await load({ refresh: true });
        return result;
      } finally {
        setBusy('');
      }
    };

    const runRemove = async extension => {
      if (!extension?.id || busy) return;
      const confirmed = await confirmAction({
        title: `Remove ${extension.name}`,
        message: 'Remove this extension from Rel.AI?',
        detail: 'Rel.AI removes the extension package and its managed tools from local storage. Rel.AI does not change your project files or settings.',
        confirmLabel: 'Remove extension',
        danger: true
      });
      if (!confirmed) return;
      setBusy(`remove:${extension.id}`);
      const result = await postJson('/api/extensions', { action: 'remove', id: extension.id, confirmRemove: true }, { cache: 'no-store' });
      setBusy('');
      if (!result?.ok) {
        toast(result?.error || 'Could not remove the extension.', { variant: 'error' });
        return;
      }
      toast(`${extension.name} removed.`, { variant: 'success' });
      invalidateCache('/api/extensions');
      await load();
      if (inspectedExtension?.id === extension.id) {
        setInspectedExtension(null);
      }
    };

    return h('div', { className: 'section extensions-page', 'data-extensions-react': '' },
      h('div', { className: 'section-head' },
        h('div', { className: 'extensions-header-copy' },
          h('h2', null, 'Extensions'),
          h('p', null, 'Extensions add reusable skills and local tools to ChatGPT.')
        ),
        h('div', { className: 'section-head-actions' },
          h('button', {
            className: 'secondary compact-button',
            type: 'button',
            disabled: Boolean(busy),
            onClick: () => { void refreshCatalog(); }
          }, h(Icon, { name: 'refresh', size: 14, className: busy === 'refresh' ? 'animate-spin' : '' }), busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog')
        )
      ),

      data && stats.needsSetupCount > 0 ? h('div', { className: 'connection-notice warn extensions-status-notice', role: 'status' },
        h('strong', null, `${stats.needsSetupCount} installed ${stats.needsSetupCount === 1 ? 'extension needs' : 'extensions need'} setup`),
        h('button', { className: 'secondary compact-button', type: 'button', onClick: () => { setActiveTab('installed'); setFilterStatus('needs_setup'); setSearchQuery(''); setFilterKind('all'); } }, 'Show setup needed')
      ) : null,

      h('div', { className: 'extensions-tabs-row' },
        h(ExtensionTabs, { activeTab, setActiveTab, stats }),
        (activeTab === 'installed' || activeTab === 'discover') && data ? h(ExtensionsFilterToolbar, {
          activeTab,
          searchQuery,
          setSearchQuery,
          filterKind,
          setFilterKind,
          filterStatus,
          setFilterStatus,
          installedCount: data?.installed?.length || 0,
          catalogCount: data?.catalog?.length || 0
        }) : null
      ),

      error ? h('div', { className: 'connection-notice bad', role: 'alert' },
        h('strong', null, 'Extensions could not be loaded'),
        h('p', null, error),
        h('button', { className: 'secondary compact-button', type: 'button', onClick: () => void load() }, 'Try again')
      ) : null,

      !data && !error ? h(ExtensionsLoadingSkeleton) : null,

      data && activeTab === 'installed' ? h(InstalledPanel, {
        data,
        catalogById,
        busy,
        runInstall,
        runRemove,
        searchQuery,
        filterKind,
        filterStatus,
        onInspect: setInspectedExtension,
        onClearFilters: () => { setSearchQuery(''); setFilterKind('all'); setFilterStatus('all'); },
        onGoToDiscover: () => { setActiveTab('discover'); setSearchQuery(''); setFilterKind('all'); setFilterStatus('all'); }
      }) : null,

      data && activeTab === 'discover' ? h(DiscoverPanel, {
        data,
        busy,
        runInstall,
        onRefresh: refreshCatalog,
        searchQuery,
        filterKind,
        filterStatus,
        onInspect: setInspectedExtension,
        onClearFilters: () => { setSearchQuery(''); setFilterKind('all'); setFilterStatus('all'); }
      }) : null,

      data && activeTab === 'sources' ? h(SourcesPanel, {
        data,
        busy,
        onAddSource: runAddSource,
        onRemoveSource: runRemoveSource
      }) : null,

      activeTab === 'developer' ? h(DeveloperPanel, { installRoot: data?.installRoot || '' }) : null,

      inspectedExtension ? h(ExtensionInspectorDialog, {
        extension: inspectedExtension,
        catalogEntry: catalogById.get(inspectedExtension.id),
        installedEntry: installedById.get(inspectedExtension.id),
        busy,
        onClose: () => setInspectedExtension(null),
        onInstall: runInstall,
        onRemove: runRemove
      }) : null
    );
  };
}

function ExtensionTabs({ activeTab, setActiveTab, stats }) {
  const onKeyDown = event => {
    const ids = TABS.map(([id]) => id);
    const current = ids.indexOf(activeTab);
    let next = null;
    if (event.key === 'ArrowLeft') next = (current - 1 + ids.length) % ids.length;
    else if (event.key === 'ArrowRight') next = (current + 1) % ids.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ids.length - 1;
    if (next === null) return;
    event.preventDefault();
    setActiveTab(ids[next]);
    event.currentTarget.querySelector(`[data-extension-tab="${ids[next]}"]`)?.focus({ preventScroll: true });
  };

  const getBadge = id => {
    if (id === 'installed' && stats) {
      return h('span', { className: 'extensions-tab-badge' }, stats.installedCount);
    }
    if (id === 'discover' && stats) {
      return stats.updatesCount
        ? h('span', { className: 'extensions-tab-badge highlight', title: `${stats.updatesCount} update(s) available` }, `${stats.catalogCount} (${stats.updatesCount} updates)`)
        : h('span', { className: 'extensions-tab-badge' }, stats.catalogCount);
    }
    if (id === 'sources' && stats) {
      return h('span', { className: 'extensions-tab-badge' }, stats.sourcesCount);
    }
    return null;
  };

  return h('div', { className: 'extensions-tabs', role: 'tablist', 'aria-label': 'Extensions sections', onKeyDown },
    ...TABS.map(([id, label]) => h('button', {
      key: id,
      type: 'button',
      role: 'tab',
      className: `extensions-tab${activeTab === id ? ' is-active' : ''}`,
      id: `extensions-tab-${id}`,
      'aria-selected': activeTab === id ? 'true' : 'false',
      'aria-controls': `extensions-panel-${id}`,
      tabIndex: activeTab === id ? 0 : -1,
      'data-extension-tab': id,
      onClick: () => setActiveTab(id)
    },
      h('span', null, label),
      getBadge(id)
    ))
  );
}

function ExtensionsFilterToolbar({
  activeTab,
  searchQuery,
  setSearchQuery,
  filterKind,
  setFilterKind,
  filterStatus,
  setFilterStatus,
  installedCount = 0,
  catalogCount = 0
}) {
  const isInstalled = activeTab === 'installed';
  const totalCount = isInstalled ? installedCount : catalogCount;
  const hasFilter = filterKind !== 'all' || filterStatus !== 'all' || Boolean(searchQuery.trim());

  return h('div', { className: 'extensions-filter-toolbar flex-1' },
    h('div', { className: 'extensions-filter-top' },
      h('div', { className: 'extensions-search-box' },
        h(Icon, { name: 'search', size: 15, className: 'extensions-search-icon' }),
        h('input', {
          type: 'search',
          className: 'extensions-search-input',
          placeholder: isInstalled ? 'Search installed extensions by name, command, or publisher…' : 'Search catalog by name, command, or skill…',
          value: searchQuery,
          onChange: e => setSearchQuery(e.target.value)
        }),
        searchQuery ? h('button', {
          type: 'button',
          className: 'extensions-search-clear',
          'aria-label': 'Clear search',
          onClick: () => setSearchQuery('')
        }, h(Icon, { name: 'close', size: 14 })) : null
      ),
      h('div', { className: 'extensions-filter-pills' },
        h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterKind === 'all' ? ' is-active' : ''}`,
          onClick: () => setFilterKind('all')
        }, 'All types'),
        h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterKind === 'skill' ? ' is-active' : ''}`,
          onClick: () => setFilterKind(filterKind === 'skill' ? 'all' : 'skill')
        }, h(Icon, { name: 'puzzle', size: 12 }), ' Skills'),
        h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterKind === 'cli' ? ' is-active' : ''}`,
          onClick: () => setFilterKind(filterKind === 'cli' ? 'all' : 'cli')
        }, h(Icon, { name: 'processes', size: 12 }), ' CLI tools'),
        isInstalled ? h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterStatus === 'updates' ? ' is-active' : ''}`,
          onClick: () => setFilterStatus(filterStatus === 'updates' ? 'all' : 'updates')
        }, h(Icon, { name: 'download', size: 12 }), ' Updates') : null,
        isInstalled ? h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterStatus === 'needs_setup' ? ' is-active' : ''}`,
          onClick: () => setFilterStatus(filterStatus === 'needs_setup' ? 'all' : 'needs_setup')
        }, h(Icon, { name: 'warning', size: 12 }), ' Setup needed') : null,
        !isInstalled ? h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterStatus === 'updates' ? ' is-active' : ''}`,
          onClick: () => setFilterStatus(filterStatus === 'updates' ? 'all' : 'updates')
        }, h(Icon, { name: 'download', size: 12 }), ' Updates') : null,
        !isInstalled ? h('button', {
          type: 'button',
          className: `extensions-filter-pill${filterStatus === 'installed' ? ' is-active' : ''}`,
          onClick: () => setFilterStatus(filterStatus === 'installed' ? 'all' : 'installed')
        }, 'Installed') : null
      )
    ),
    hasFilter ? h('div', { className: 'extensions-filter-summary' },
      h('span', null, `Filtering ${isInstalled ? 'installed' : 'catalog'} extensions (${totalCount} total)`),
      h('button', {
        type: 'button',
        className: 'extensions-filter-reset',
        onClick: () => { setSearchQuery(''); setFilterKind('all'); setFilterStatus('all'); }
      }, 'Reset filters')
    ) : null
  );
}

function matchesSearch(text, query) {
  if (!query) return true;
  return String(text || '').toLowerCase().includes(query.toLowerCase().trim());
}

function InstalledPanel({
  data,
  catalogById,
  busy,
  runInstall,
  runRemove,
  searchQuery,
  filterKind,
  filterStatus,
  onInspect,
  onClearFilters,
  onGoToDiscover
}) {
  const installed = useMemo(() => data.installed || [], [data.installed]);

  const filtered = useMemo(() => {
    return installed.filter(ext => {
      if (filterKind !== 'all' && ext.kind !== filterKind) return false;
      const catalog = catalogById.get(ext.id);
      if (filterStatus === 'updates' && !catalog?.updateAvailable) return false;
      if (filterStatus === 'needs_setup' && ext.ready) return false;
      if (filterStatus === 'ready' && !ext.ready) return false;

      if (!searchQuery.trim()) return true;
      const terms = [
        ext.id,
        ext.name,
        ext.description,
        typeof ext.publisher === 'string' ? ext.publisher : ext.publisher?.name,
        ext.entrypoints?.command,
        ...(ext.requires?.commands || []),
        ...(ext.permissions || [])
      ].filter(Boolean).join(' ');
      return matchesSearch(terms, searchQuery);
    });
  }, [installed, filterKind, filterStatus, searchQuery, catalogById]);

  const hasFilterActive = filterKind !== 'all' || filterStatus !== 'all' || Boolean(searchQuery.trim());

  return h('section', { id: 'extensions-panel-installed', role: 'tabpanel', 'aria-labelledby': 'extensions-tab-installed', tabIndex: 0 },
    installed.length === 0
      ? h(EmptyExtensionsState, {
          icon: 'package',
          title: 'No extensions installed yet',
          copy: 'Extensions add reusable instructions, CLI commands, and local developer tools to ChatGPT.',
          actionLabel: 'Discover extensions',
          onAction: onGoToDiscover
        })
      : filtered.length === 0
        ? h(EmptyExtensionsState, {
            icon: 'search',
            title: 'No matching installed extensions',
            copy: `No extensions matched your filter criteria (${searchQuery ? `"${searchQuery}"` : 'active filters'}).`,
            actionLabel: 'Clear filters',
            onAction: onClearFilters
          })
        : h('div', { className: 'flex flex-col gap-3' },
            hasFilterActive ? h('div', { className: 'flex items-center justify-between text-xs text-zinc-400 px-1' },
              h('span', null, `Showing ${filtered.length} of ${installed.length} installed extensions`),
              h('button', {
                type: 'button',
                className: 'extensions-filter-reset',
                onClick: onClearFilters
              }, 'Clear filters')
            ) : null,
            h('div', { className: 'extensions-list-grid' },
              filtered.map(extension => {
                const catalog = catalogById.get(extension.id);
                return h(ExtensionProCard, {
                  key: extension.id,
                  extension,
                  catalog,
                  isInstalledTab: true,
                  busy,
                  onInspect: () => onInspect(extension),
                  onInstall: (cat, act) => runInstall(cat, act),
                  onRemove: () => runRemove(extension)
                });
              })
            )
          )
  );
}

function DiscoverPanel({
  data,
  busy,
  runInstall,
  onRefresh,
  searchQuery,
  filterKind,
  filterStatus,
  onInspect,
  onClearFilters
}) {
  const catalog = useMemo(() => data.catalog || [], [data.catalog]);

  const filtered = useMemo(() => {
    return catalog.filter(ext => {
      if (filterKind !== 'all' && ext.kind !== filterKind) return false;
      if (filterStatus === 'updates' && !ext.updateAvailable) return false;
      if (filterStatus === 'installed' && !ext.installed) return false;
      if (filterStatus === 'not_installed' && ext.installed) return false;
      if (filterStatus === 'autoinstall' && !ext.autoInstall) return false;

      if (!searchQuery.trim()) return true;
      const terms = [
        ext.id,
        ext.name,
        ext.description,
        typeof ext.publisher === 'string' ? ext.publisher : ext.publisher?.name,
        ...(ext.permissions || [])
      ].filter(Boolean).join(' ');
      return matchesSearch(terms, searchQuery);
    });
  }, [catalog, filterKind, filterStatus, searchQuery]);

  const hasFilterActive = filterKind !== 'all' || filterStatus !== 'all' || Boolean(searchQuery.trim());

  return h('section', { id: 'extensions-panel-discover', role: 'tabpanel', 'aria-labelledby': 'extensions-tab-discover', tabIndex: 0 },
    data.catalogError ? h('div', { className: 'connection-notice warn mb-4', role: 'status' },
      h('strong', null, 'Catalog is unavailable'),
      h('p', null, data.catalogError)
    ) : null,

    catalog.length === 0
      ? h(EmptyExtensionsState, {
          icon: 'sparkles',
          title: data.catalogError ? 'Catalog is unavailable' : 'No published extensions yet',
          copy: data.catalogError
            ? 'Refresh the catalog or open the catalog repository to view published extensions.'
            : 'Published extensions appear here after they are added to the Rel.AI extension catalog.',
          actionLabel: 'Refresh catalog',
          onAction: () => { void onRefresh(); }
        })
      : filtered.length === 0
        ? h(EmptyExtensionsState, {
            icon: 'search',
            title: 'No matching catalog extensions',
            copy: `No extensions matched your filter criteria (${searchQuery ? `"${searchQuery}"` : 'active filters'}).`,
            actionLabel: 'Clear filters',
            onAction: onClearFilters
          })
        : h('div', { className: 'flex flex-col gap-3' },
            hasFilterActive ? h('div', { className: 'flex items-center justify-between text-xs text-zinc-400 px-1' },
              h('span', null, `Showing ${filtered.length} of ${catalog.length} catalog extensions`),
              h('button', {
                type: 'button',
                className: 'extensions-filter-reset',
                onClick: onClearFilters
              }, 'Clear filters')
            ) : null,
            h('div', { className: 'extensions-list-grid' },
              filtered.map(extension => h(ExtensionProCard, {
                key: extension.id,
                extension,
                catalog: extension,
                isInstalledTab: false,
                busy,
                onInspect: () => onInspect(extension),
                onInstall: (cat, act) => runInstall(cat, act)
              }))
            )
          )
  );
}

function ExtensionProCard({
  extension,
  catalog,
  isInstalledTab,
  busy,
  onInspect,
  onInstall,
  onRemove
}) {
  const isInstalled = isInstalledTab || extension.installed === true;
  const isReady = extension.ready ?? isInstalled;
  const hasUpdate = Boolean(catalog?.updateAvailable);
  const isSkill = extension.kind === 'skill';
  const isBusy = busy === `install:${extension.id}` || busy === `update:${extension.id}` || busy === `remove:${extension.id}`;

  const getCardStatus = () => {
    if (!isInstalledTab) {
      if (hasUpdate) return { text: `Update available (v${catalog?.version || extension.version})`, tone: 'warn', icon: 'download' };
      if (isInstalled) return { text: `Installed v${extension.installedVersion || extension.version}`, tone: 'info', icon: 'check' };
      return { text: isSkill ? 'Skill' : 'CLI tool', tone: 'neutral', icon: isSkill ? 'puzzle' : 'processes' };
    }
    if (hasUpdate) return { text: `Update to v${catalog?.version || extension.version}`, tone: 'warn', icon: 'download' };
    if (extension.sourceAvailable === false && !extension.localDevelopment) return { text: 'Source unavailable', tone: 'warn', icon: 'warning' };
    if (extension.status === 'invalid') return { text: 'Invalid package', tone: 'bad', icon: 'warning' };
    if (!isReady) return { text: 'Setup needed', tone: 'warn', icon: 'warning' };
    return { text: 'Ready', tone: 'ok', icon: 'check' };
  };
  const { text: statusText, tone: statusTone, icon: statusIcon } = getCardStatus();

  const publisherName = typeof extension.publisher === 'string'
    ? extension.publisher
    : extension.publisher?.name || 'Community';
  const publisherUrl = typeof extension.publisher === 'object' ? extension.publisher?.url : null;
  const errorCopy = extensionErrorCopy(extension.error);

  return h('article', {
    className: `extension-pro-card kind-${extension.kind || 'skill'}`,
    'data-extension-id': extension.id
  },
    h('div', { className: 'extension-card-kind-accent' }),
    h('div', { className: 'extension-card-inner' },
      h('div', { className: 'extension-card-header' },
        h('div', { className: 'extension-card-identity' },
          h('div', { className: 'extension-card-icon-box' },
            h(Icon, { name: isSkill ? 'puzzle' : 'processes', size: 22 })
          ),
          h('div', { className: 'extension-title-block' },
            h('div', { className: 'extension-title-row' },
              h('h3', { className: 'extension-title-text' }, extension.name || extension.id),
              extension.version ? h('span', { className: 'extension-version-tag' }, `v${extension.version}`) : null
            ),
            h('code', { className: 'extension-id-badge' }, extension.id)
          )
        ),
        h('span', { className: `extension-status-chip ${statusTone}` },
          h(Icon, { name: statusIcon, size: 12 }),
          statusText
        )
      ),

      h('p', { className: 'extension-card-desc' },
        extension.description || 'Extension for Rel.AI and ChatGPT.'
      ),

      h('div', { className: 'extension-tags-row' },
        h('span', { className: 'extension-type-pill' },
          h(Icon, { name: isSkill ? 'puzzle' : 'terminal', size: 11 }),
          isSkill ? 'Skill' : 'CLI tool'
        ),
        extension.autoInstall ? h('span', { className: 'extension-auto-install-pill' },
          h(Icon, { name: 'sparkles', size: 11 }),
          'Managed tool'
        ) : null,
        extension.entrypoints?.command ? h('span', { className: 'extension-type-pill' },
          h(Icon, { name: 'processes', size: 11 }),
          `Command: ${extension.entrypoints.command}`
        ) : null,
        h('span', { className: 'extension-publisher-pill' },
          'Publisher: ',
          publisherUrl
            ? h('a', { href: publisherUrl, target: '_blank', rel: 'noopener noreferrer', className: 'hover:underline text-inherit' }, publisherName)
            : h('strong', null, publisherName)
        )
      ),

      extension.error ? h('div', { className: 'extension-alert-box' },
        h(Icon, { name: 'warning', size: 15, className: 'shrink-0 mt-0.5' }),
        h('div', { className: 'flex flex-col gap-1' },
          h('span', null, errorCopy.message),
          errorCopy.detail ? h('code', { className: 'text-[10px] break-all' }, errorCopy.detail) : null
        )
      ) : null,

      isInstalledTab && extension.sourceAvailable === false && !extension.localDevelopment ? h('div', { className: 'extension-alert-box' },
        h(Icon, { name: 'warning', size: 15, className: 'shrink-0 mt-0.5' }),
        h('span', null, 'This extension stays installed, but its source is no longer active. Add the source again to discover updates.')
      ) : null,

      h(PermissionBadgesList, { permissions: extension.permissions }),

      h('div', { className: 'extension-card-footer' },
        h('div', { className: 'extension-footer-actions-left' },
          h('button', {
            type: 'button',
            className: 'secondary compact-button',
            onClick: onInspect
          }, h(Icon, { name: 'info', size: 13 }), 'Details')
        ),
        h('div', { className: 'extension-footer-actions-right' },
          hasUpdate ? h('button', {
            type: 'button',
            className: 'primary compact-button',
            disabled: Boolean(busy) || isBusy,
            onClick: () => onInstall(catalog, 'update')
          },
            h(Icon, { name: 'download', size: 13 }),
            busy === `update:${extension.id}` ? 'Updating…' : `Update v${catalog.version}`
          ) : null,

          !isInstalledTab && !isInstalled ? h('button', {
            type: 'button',
            className: 'primary compact-button',
            disabled: Boolean(busy) || isBusy,
            onClick: () => onInstall(extension, 'install')
          },
            h(Icon, { name: 'add', size: 13 }),
            busy === `install:${extension.id}` ? 'Installing…' : 'Install'
          ) : null,

          isInstalledTab && onRemove ? h('button', {
            type: 'button',
            className: 'secondary compact-button danger',
            disabled: Boolean(busy) || isBusy,
            onClick: onRemove
          },
            h(Icon, { name: 'trash', size: 13 }),
            busy === `remove:${extension.id}` ? 'Removing…' : 'Remove'
          ) : null,

          extension.repository ? h('a', {
            href: extension.repository,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'buttonlike secondary compact-button p-2',
            title: 'Open repository in browser',
            'aria-label': `${extension.name} repository`
          }, h(Icon, { name: 'externalLink', size: 13 })) : null
        )
      )
    )
  );
}

function PermissionBadgesList({ permissions = [] }) {
  const values = Array.isArray(permissions) ? permissions : [];
  if (!values.length) {
    return h('div', { className: 'extension-permissions-box' },
      h('div', { className: 'extension-permissions-header' }, 'Declared permissions'),
      h('span', { className: 'text-[11px] text-zinc-400' }, 'No additional permissions')
    );
  }

  return h('div', { className: 'extension-permissions-box' },
    h('div', { className: 'extension-permissions-header' },
      h('span', null, 'Declared permissions'),
      h('span', { className: 'text-[10px] lowercase opacity-75' }, `${values.length} permission${values.length === 1 ? '' : 's'}`)
    ),
    h('div', { className: 'extension-permissions-chips' },
      values.map(permission => {
        const meta = PERMISSION_METADATA[permission] || {
          label: permission,
          shortLabel: permission,
          icon: 'shield',
          description: permission
        };
        return h('span', {
          key: permission,
          className: 'extension-permission-item',
          title: meta.description
        },
          h(Icon, { name: meta.icon, size: 11 }),
          meta.shortLabel
        );
      })
    )
  );
}

function ExtensionInspectorDialog({
  extension,
  catalogEntry,
  installedEntry,
  busy,
  onClose,
  onInstall,
  onRemove
}) {
  const isInstalled = Boolean(installedEntry?.version || extension.installedVersion || (extension.files && extension.ready !== undefined));
  const hasUpdate = Boolean(catalogEntry?.updateAvailable);
  const publisherName = typeof extension.publisher === 'string'
    ? extension.publisher
    : extension.publisher?.name || 'Community Publisher';
  const publisherUrl = typeof extension.publisher === 'object' ? extension.publisher?.url : null;
  const isSkill = extension.kind === 'skill';
  const errorCopy = extensionErrorCopy(extension.error);

  return h(Dialog.Root, { open: true, onOpenChange: open => { if (!open) onClose(); } },
    h(Dialog.Portal, null,
      h(Dialog.Overlay, { className: 'overlay-backdrop modal-backdrop' },
        h(Dialog.Content, { className: 'modal-panel modal-wide' },
          h('header', { className: 'modal-head' },
            h(Dialog.Title, { asChild: true },
              h('div', { className: 'flex items-center gap-2.5' },
                h(Icon, { name: isSkill ? 'puzzle' : 'processes', size: 18 }),
                h('h2', { className: 'modal-title' }, extension.name || extension.id)
              )
            ),
            h('button', {
              type: 'button',
              className: 'modal-close',
              'aria-label': 'Close dialog',
              onClick: onClose
            }, h(Icon, { name: 'close', size: 16 }))
          ),

          h('div', { className: 'modal-body' },
            h('div', { className: 'extension-modal-content' },
              h('div', { className: 'extension-modal-header' },
                h('div', { className: 'extension-modal-icon' },
                  h(Icon, { name: isSkill ? 'puzzle' : 'processes', size: 24 })
                ),
                h('div', { className: 'flex flex-col min-w-0 flex-1' },
                  h('div', { className: 'flex flex-wrap items-center gap-2' },
                    h('strong', { className: 'text-base font-bold' }, extension.name || extension.id),
                    extension.version ? h('span', { className: 'extension-version-tag' }, `v${extension.version}`) : null,
                    extension.autoInstall ? h('span', { className: 'extension-auto-install-pill' }, 'Managed tool') : null
                  ),
                  h('p', { className: 'mt-1 text-sm text-zinc-300' }, extension.description),
                  h('div', { className: 'flex flex-wrap items-center gap-3 mt-2 text-xs text-zinc-400' },
                    h('span', null, 'Publisher: ', publisherUrl
                      ? h('a', { href: publisherUrl, target: '_blank', rel: 'noopener noreferrer', className: 'text-zinc-200 underline' }, publisherName)
                      : h('strong', { className: 'text-zinc-200' }, publisherName)
                    ),
                    extension.repository ? h('a', {
                      href: extension.repository,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      className: 'extensions-source-repo-link'
                    }, h(Icon, { name: 'externalLink', size: 12 }), 'Source repository') : null
                  )
                )
              ),

              extension.error ? h('div', { className: 'extension-alert-box' },
                h(Icon, { name: 'warning', size: 16, className: 'shrink-0 mt-0.5' }),
                h('div', { className: 'flex flex-col gap-1' },
                  h('strong', { className: 'font-semibold' }, 'Action needed:'),
                  h('span', null, errorCopy.message),
                  errorCopy.detail ? h('code', { className: 'text-[10px] break-all' }, errorCopy.detail) : null
                )
              ) : null,

              h('div', { className: 'extension-modal-details-grid' },
                h('div', { className: 'extension-detail-cell' },
                  h('span', { className: 'extension-detail-cell-label' }, 'Extension ID'),
                  h('code', { className: 'extension-detail-cell-value' }, extension.id)
                ),
                h('div', { className: 'extension-detail-cell' },
                  h('span', { className: 'extension-detail-cell-label' }, 'Type'),
                  h('span', { className: 'extension-detail-cell-value' }, isSkill ? 'Skill' : 'CLI tool')
                ),
                h('div', { className: 'extension-detail-cell' },
                  h('span', { className: 'extension-detail-cell-label' }, 'Compatible Rel.AI versions'),
                  h('span', { className: 'extension-detail-cell-value' }, extension.compatibility?.relai || '>=1.0.0')
                ),
                extension.entrypoints?.skill ? h('div', { className: 'extension-detail-cell' },
                  h('span', { className: 'extension-detail-cell-label' }, 'Skill file'),
                  h('code', { className: 'extension-detail-cell-value' }, extension.entrypoints.skill)
                ) : null,
                extension.entrypoints?.command ? h('div', { className: 'extension-detail-cell' },
                  h('span', { className: 'extension-detail-cell-label' }, 'Command'),
                  h('code', { className: 'extension-detail-cell-value' }, extension.entrypoints.command)
                ) : null,
                h('div', { className: 'extension-detail-cell' },
                  h('span', { className: 'extension-detail-cell-label' }, 'Status'),
                  h('span', { className: 'extension-detail-cell-value flex items-center gap-1.5' },
                    h(Icon, { name: isInstalled ? (extension.ready ? 'check' : 'warning') : 'info', size: 14 }),
                    isInstalled ? (extension.ready ? 'Ready' : 'Setup needed') : 'Available in catalog'
                  )
                )
              ),

              h('div', { className: 'flex flex-col gap-2' },
                h('h4', { className: 'text-xs font-bold uppercase tracking-wider text-zinc-400' }, 'Declared permissions'),
                (extension.permissions || []).length ? h('div', { className: 'grid gap-2' },
                  extension.permissions.map(perm => {
                    const meta = PERMISSION_METADATA[perm] || {
                      label: perm,
                      category: 'System',
                      description: perm,
                      icon: 'shield'
                    };
                    return h('div', { key: perm, className: 'flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5' },
                      h('div', { className: 'p-1.5 rounded bg-zinc-800 text-zinc-300' }, h(Icon, { name: meta.icon, size: 14 })),
                      h('div', { className: 'flex flex-col min-w-0' },
                        h('div', { className: 'flex items-center gap-2' },
                          h('strong', { className: 'text-xs font-semibold text-zinc-200' }, meta.label),
                          h('span', { className: 'text-[10px] text-zinc-500 uppercase' }, meta.category)
                        ),
                        h('p', { className: 'text-xs text-zinc-400 mt-0.5' }, meta.description)
                      )
                    );
                  })
                ) : h('p', { className: 'text-xs text-zinc-400' }, 'This extension requests no additional permissions.')
              ),

              Array.isArray(extension.files) && extension.files.length ? h('div', { className: 'flex flex-col gap-1.5' },
                h('h4', { className: 'text-xs font-bold uppercase tracking-wider text-zinc-400' }, `Package files and SHA-256 checksums (${extension.files.length})`),
                h('div', { className: 'extension-files-table-wrapper' },
                  h('table', { className: 'extension-files-table' },
                    h('thead', null,
                      h('tr', null,
                        h('th', null, 'File path'),
                        h('th', null, 'SHA-256 checksum'),
                        h('th', null, 'Status')
                      )
                    ),
                    h('tbody', null,
                      extension.files.map(file => h('tr', { key: file.path },
                        h('td', null, file.path),
                        h('td', { className: 'text-zinc-500 font-mono text-[10px]' }, file.sha256 ? `${file.sha256.slice(0, 16)}…` : '—'),
                        h('td', null, h('span', { className: 'ok flex items-center gap-1 text-[11px]' }, h(Icon, { name: 'check', size: 11 }), 'Verified'))
                      ))
                    )
                  )
                )
              ) : null
            )
          ),

          h('footer', { className: 'modal-footer shrink-0 px-5 pb-5' },
            h('div', { className: 'modal-actions' },
              extension.repository ? h('a', {
                href: extension.repository,
                target: '_blank',
                rel: 'noopener noreferrer',
                className: 'buttonlike secondary'
              }, h(Icon, { name: 'externalLink', size: 14 }), 'Open on GitHub') : null
            ),
            h('div', { className: 'modal-actions' },
              h('button', {
                type: 'button',
                className: 'secondary',
                onClick: onClose
              }, 'Close'),

              hasUpdate ? h('button', {
                type: 'button',
                className: 'primary',
                disabled: Boolean(busy),
                onClick: () => onInstall(catalogEntry || extension, 'update')
              }, busy ? 'Updating…' : `Update to v${catalogEntry?.version}`) : null,

              !isInstalled ? h('button', {
                type: 'button',
                className: 'primary',
                disabled: Boolean(busy),
                onClick: () => onInstall(extension, 'install')
              }, busy ? 'Installing…' : 'Install extension') : null,

              isInstalled && onRemove ? h('button', {
                type: 'button',
                className: 'danger',
                disabled: Boolean(busy),
                onClick: () => onRemove(extension)
              }, busy ? 'Removing…' : 'Remove extension') : null
            )
          )
        )
      )
    )
  );
}

function SourcesPanel({ data, busy, onAddSource, onRemoveSource }) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceError, setSourceError] = useState('');
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const adding = busy === 'add-source';

  const onSubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setSourceError('');
    try {
      const result = await onAddSource(sourceUrl.trim());
      if (!result?.ok) {
        setSourceError(result?.error || 'Could not add the extension source.');
        return;
      }
      setSourceUrl('');
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : 'Could not add the extension source.');
    }
  };

  return h('section', {
    id: 'extensions-panel-sources',
    role: 'tabpanel',
    'aria-labelledby': 'extensions-tab-sources',
    tabIndex: 0,
    className: 'extensions-sources-panel'
  },
    h('div', { className: 'extensions-source-add-card' },
      h('div', { className: 'extensions-source-add-copy' },
        h('h3', null, 'Add an extension source'),
        h('p', null, 'Add a developer repository once to discover every extension they publish. Adding a source does not install or run its extensions.')
      ),
      h('form', { action: '/api/extensions', method: 'post', className: 'extensions-source-form', onSubmit },
        h('label', { htmlFor: 'extension-source-url' }, 'Repository URL'),
        h('div', { className: 'extensions-source-form-row' },
          h('input', {
            id: 'extension-source-url',
            name: 'url',
            type: 'url',
            required: true,
            value: sourceUrl,
            placeholder: 'https://github.com/developer/my-relai-extensions',
            'aria-describedby': sourceError ? 'extension-source-help extension-source-error' : 'extension-source-help',
            'aria-invalid': sourceError ? 'true' : undefined,
            onChange: event => {
              setSourceUrl(event.target.value);
              if (sourceError) setSourceError('');
            }
          }),
          h('button', { type: 'submit', className: 'primary', disabled: adding }, adding ? 'Adding…' : 'Add source')
        ),
        h('p', { id: 'extension-source-help', className: 'extensions-source-help' },
          'GitHub repository URLs use publisher-catalog.json from the main branch. For another host, paste the direct HTTPS publisher-catalog.json URL.'
        ),
        sourceError ? h('p', { id: 'extension-source-error', className: 'extensions-source-error', role: 'alert', 'aria-live': 'polite' }, sourceError) : null
      )
    ),

    h('div', { className: 'extensions-source-list' },
      sources.map(source => h('article', { key: source.id, className: `extensions-source-card${source.error ? ' has-error' : ''}` },
        h('div', { className: 'extensions-source-card-main' },
          h('div', { className: 'extensions-source-card-heading' },
            h('div', { className: 'extensions-source-title-row' },
              h('h3', null, source.name || 'Extension source'),
              h('span', { className: source.official ? 'extensions-source-badge official' : 'extensions-source-badge' }, source.official ? 'Built in' : 'Added')
            ),
            h('p', null, source.official
              ? 'The official Rel.AI catalog is always available and cannot be removed.'
              : `${Number(source.extensionCount || 0)} extension${Number(source.extensionCount || 0) === 1 ? '' : 's'} available from this source.`)
          ),
          h('div', { className: 'extensions-source-meta' },
            source.repositoryUrl ? h(ExternalLink, { href: source.repositoryUrl, label: 'Open repository' }) : null,
            h('code', null, source.catalogUrl)
          ),
          source.error ? h('div', { className: 'extension-alert-box danger', role: 'status' }, source.error) : null
        ),
        h('div', { className: 'extensions-source-card-actions' },
          h('span', { className: `extensions-source-status ${source.status === 'ready' ? 'ok' : 'bad'}` }, source.status === 'ready' ? 'Available' : 'Needs attention'),
          Number(source.installedCount || 0) > 0 ? h('span', { className: 'extensions-source-installed-count' }, `${source.installedCount} installed`) : null,
          !source.official ? h('button', {
            type: 'button',
            className: 'danger compact-button',
            disabled: Boolean(busy),
            onClick: () => { void onRemoveSource(source); }
          }, busy === `remove-source:${source.id}` ? 'Removing…' : 'Remove source') : null
        )
      ))
    )
  );
}

function DeveloperPanel({ installRoot }) {
  const [selectedTemplate, setSelectedTemplate] = useState('skill');
  const [copiedTemplate, setCopiedTemplate] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  const currentTemplate = TEMPLATES[selectedTemplate] || TEMPLATES.skill;

  const onCopyTemplate = async () => {
    try {
      await copyText(currentTemplate.code);
      setCopiedTemplate(true);
      toast('Manifest template copied to clipboard.', { variant: 'info' });
      setTimeout(() => setCopiedTemplate(false), 2000);
    } catch {
      toast('Could not copy template.', { variant: 'error' });
    }
  };

  const onCopyPath = async () => {
    if (!installRoot) return;
    try {
      await copyText(installRoot);
      setCopiedPath(true);
      toast('Extension storage folder copied to clipboard.', { variant: 'info' });
      setTimeout(() => setCopiedPath(false), 2000);
    } catch {
      toast('Could not copy path.', { variant: 'error' });
    }
  };

  return h('section', {
    id: 'extensions-panel-developer',
    role: 'tabpanel',
    'aria-labelledby': 'extensions-tab-developer',
    tabIndex: 0,
    className: 'extensions-developer-grid'
  },
    h('div', { className: 'card p-5 flex flex-col gap-4' },
      h('div', null,
        h('h3', { className: 'text-base font-bold text-zinc-100' }, 'How extensions work'),
        h('p', { className: 'text-xs text-zinc-400 mt-0.5' }, 'Rel.AI extensions add reusable instructions and local tools to ChatGPT.')
      ),
      h('div', { className: 'developer-flow-steps' },
        h('div', { className: 'developer-step-card' },
          h('div', { className: 'flex items-center gap-2' },
            h('span', { className: 'developer-step-number' }, '1'),
            h('span', { className: 'developer-step-title' }, 'Publisher repository')
          ),
          h('p', { className: 'developer-step-desc' },
            'Keep your Rel.AI extensions in one repository under extensions/<name>. You can install and version each package independently.'
          )
        ),
        h('div', { className: 'developer-step-card' },
          h('div', { className: 'flex items-center gap-2' },
            h('span', { className: 'developer-step-number' }, '2'),
            h('span', { className: 'developer-step-title' }, 'Update metadata and checksums')
          ),
          h('p', { className: 'developer-step-desc' },
            'Run relai-extension sync to update package checksums, publisher metadata, and publisher-catalog.json.'
          )
        ),
        h('div', { className: 'developer-step-card' },
          h('div', { className: 'flex items-center gap-2' },
            h('span', { className: 'developer-step-number' }, '3'),
            h('span', { className: 'developer-step-title' }, 'Publish and share the repository')
          ),
          h('p', { className: 'developer-step-desc' },
            'Push the publisher repository over HTTPS. Users can add its repository URL in Sources; Rel.AI discovers publisher-catalog.json and verifies extension checksums before installation.'
          )
        ),
        h('div', { className: 'developer-step-card' },
          h('div', { className: 'flex items-center gap-2' },
            h('span', { className: 'developer-step-number' }, '4'),
            h('span', { className: 'developer-step-title' }, 'Run with Rel.AI authorization')
          ),
          h('p', { className: 'developer-step-desc' },
            'ChatGPT handles the conversation. Rel.AI applies its authorization rules to each local command.'
          )
        )
      )
    ),

    h('div', { className: 'developer-interactive-block' },
      h('div', { className: 'flex flex-wrap items-center justify-between gap-3' },
        h('div', null,
          h('h3', { className: 'text-base font-bold text-zinc-100' }, 'Manifest templates'),
          h('p', { className: 'text-xs text-zinc-400 mt-0.5' }, currentTemplate.description)
        ),
        h('div', { className: 'developer-template-selector' },
          Object.entries(TEMPLATES).map(([key, tpl]) => h('button', {
            key,
            type: 'button',
            className: `developer-template-button${selectedTemplate === key ? ' is-active' : ''}`,
            onClick: () => setSelectedTemplate(key)
          }, tpl.label))
        )
      ),

      h('div', { className: 'developer-code-snippet' },
        h('div', { className: 'developer-code-header' },
          h('span', null, currentTemplate.filename),
          h('button', {
            type: 'button',
            className: 'developer-copy-code-btn',
            onClick: onCopyTemplate
          },
            h(Icon, { name: copiedTemplate ? 'check' : 'copy', size: 12, className: copiedTemplate ? 'ok' : '' }),
            copiedTemplate ? 'Copied' : 'Copy template'
          )
        ),
        h('pre', null, h('code', null, currentTemplate.code))
      )
    ),

    h('div', { className: 'layout-grid' },
      h('div', { className: 'card p-4 flex flex-col gap-3' },
        h('h3', { className: 'text-sm font-bold text-zinc-100' }, 'Publisher repository workflow'),
        h('ol', { className: 'extensions-guidelines list-decimal pl-4 text-xs text-zinc-300 flex flex-col gap-2' },
          h('li', null, 'Initialize one repository with ', h('code', null, 'relai-extension init'), '. Use a globally unique publisher namespace.'),
          h('li', null, 'Add packages with ', h('code', null, 'relai-extension create <name>'), ' under ', h('code', null, 'extensions/<name>'), '. One repository can contain many extensions.'),
          h('li', null, 'Run ', h('code', null, 'relai-extension sync'), ' to update file checksums and ', h('code', null, 'publisher-catalog.json'), '. Run ', h('code', null, 'relai-extension validate'), ' before you publish.'),
          h('li', null, 'Share the publisher repository URL so users can add it under Sources. Submission to the official Rel.AI catalog is optional and only needed for built-in discovery.')
        ),
        h('div', { className: 'flex flex-wrap gap-2 pt-2' },
          h(ExternalLink, { href: EXTENSION_SCHEMA_URL, label: 'Manifest schema' }),
          h(ExternalLink, { href: EXTENSIONS_REPOSITORY_URL, label: 'Catalog repository' })
        )
      ),

      installRoot ? h('div', { className: 'card p-4 flex flex-col justify-between gap-3' },
        h('div', { className: 'flex flex-col gap-1' },
          h('h3', { className: 'text-sm font-bold text-zinc-100' }, 'Extension storage folder'),
          h('p', { className: 'text-xs text-zinc-400' }, 'Rel.AI stores installed extension packages here. Create packages in a publisher repository. Let Rel.AI manage this folder:')
        ),
        h('div', { className: 'developer-path-banner' },
          h('code', { className: 'text-xs font-mono break-all' }, installRoot),
          h('button', {
            type: 'button',
            className: 'secondary compact-button',
            onClick: onCopyPath
          },
            h(Icon, { name: copiedPath ? 'check' : 'copy', size: 12 }),
            copiedPath ? 'Copied' : 'Copy folder path'
          )
        )
      ) : null
    )
  );
}

function EmptyExtensionsState({ icon, title, copy, actionLabel, onAction }) {
  return h('div', { className: 'card p-8' },
    h('div', { className: 'empty-state text-center' },
      h('div', { className: 'empty-state-icon mx-auto mb-2 text-zinc-400' },
        h(Icon, { name: icon, size: 32 })
      ),
      h('strong', { className: 'empty-state-title block text-base font-bold text-zinc-100' }, title),
      h('p', { className: 'empty-state-copy mx-auto text-sm text-zinc-400 max-w-md mt-1' }, copy),
      actionLabel ? h('div', { className: 'empty-state-action mt-4' },
        h('button', { type: 'button', className: 'primary compact-button', onClick: onAction }, actionLabel)
      ) : null
    )
  );
}

function ExtensionsLoadingSkeleton() {
  return h('div', { className: 'extensions-list-grid' },
    [1, 2, 3, 4].map(idx => h('div', { key: idx, className: 'extension-skeleton-card' },
      h('div', { className: 'flex items-center gap-3' },
        h('div', { className: 'skeleton-shimmer h-11 w-11 rounded-xl' }),
        h('div', { className: 'flex flex-col gap-1.5 flex-1' },
          h('div', { className: 'skeleton-shimmer h-4 w-32 rounded' }),
          h('div', { className: 'skeleton-shimmer h-3 w-20 rounded' })
        )
      ),
      h('div', { className: 'skeleton-shimmer h-12 w-full rounded mt-2' }),
      h('div', { className: 'skeleton-shimmer h-6 w-48 rounded mt-2' })
    ))
  );
}

function ExternalLink({ href, label }) {
  return h('a', {
    className: 'buttonlike secondary compact-button flex items-center gap-1.5',
    href,
    target: '_blank',
    rel: 'noopener noreferrer'
  }, label, h(Icon, { name: 'externalLink', size: 13 }));
}

function permissionSummary(permissions = []) {
  return (Array.isArray(permissions) ? permissions : []).map(p => PERMISSION_METADATA[p]?.label || p).join(', ');
}

function extensionErrorCopy(value) {
  const text = String(value || '').trim();
  const hasSchemaDetail = /(?:^|\s)(?:manifest|version|compatibility(?:\.[\w-]+)?|entrypoints(?:\.[\w-]+)?|requires(?:\.[\w-]+)?|permissions|install(?:\.[\w-]+)?|files(?:\.\d+)?(?:\.[\w-]+)?):/i.test(text);
  if (!hasSchemaDetail) return { message: text, detail: '' };
  return { message: 'The extension package is invalid.', detail: text };
}

export { EXTENSIONS_REPOSITORY_URL, TEMPLATES, createExtensionsRoute };
