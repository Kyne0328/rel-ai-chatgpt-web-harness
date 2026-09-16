import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { Icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';

const h = React.createElement;
const EXTENSIONS_REPOSITORY_URL = 'https://github.com/Kyne0328/rel-ai-extensions';
const EXTENSION_SCHEMA_URL = `${EXTENSIONS_REPOSITORY_URL}/blob/main/schema/relai-extension.schema.json`;
const TABS = Object.freeze([
  ['installed', 'Installed'],
  ['discover', 'Discover'],
  ['developer', 'Developer']
]);

function createExtensionsRoute() {
  return function ExtensionsRoute() {
    const [activeTab, setActiveTab] = useState('installed');
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    const load = async ({ refresh = false } = {}) => {
      const result = await fetchJson(`/api/extensions${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      if (!result?.ok) {
        setError(result?.error || 'Extensions could not be loaded.');
        return;
      }
      setData(result);
      setError('');
    };

    useEffect(() => { void load(); }, []);

    const catalogById = useMemo(() => new Map((data?.catalog || []).map(entry => [entry.id, entry])), [data?.catalog]);
    const runInstall = async (entry, action = 'install') => {
      if (!entry?.id || busy) return;
      const permissions = permissionSummary(entry.permissions);
      const confirmed = await confirmAction({
        title: action === 'update' ? `Update ${entry.name}` : `Install ${entry.name}`,
        message: `${action === 'update' ? 'Update' : 'Install'} this extension from the Rel.AI extension catalog?`,
        detail: permissions.length
          ? `Declared access: ${permissions}. Rel.AI's existing authorization rules still control every local action.`
          : `This extension declares no additional access. Rel.AI's existing authorization rules still control every local action.`,
        confirmLabel: action === 'update' ? 'Update extension' : 'Install extension'
      });
      if (!confirmed) return;
      setBusy(`${action}:${entry.id}`);
      const result = await postJson('/api/extensions', { action, id: entry.id, confirmPermissions: true }, { cache: 'no-store', timeout: 30000 });
      setBusy('');
      if (!result?.ok) {
        toast(result?.error || `Could not ${action} the extension.`, { variant: 'error' });
        return;
      }
      toast(action === 'update' ? `${entry.name} updated.` : `${entry.name} installed.`, { variant: 'success' });
      await load();
    };
    const runRemove = async extension => {
      if (!extension?.id || busy) return;
      const confirmed = await confirmAction({
        title: `Remove ${extension.name}`,
        message: 'Remove this extension from Rel.AI?',
        detail: 'The extension package is removed from Rel.AI local data. Project files are not changed.',
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
      await load();
    };

    return h('div', { className: 'section extensions-page', 'data-extensions-react': '' },
      h('div', { className: 'section-head' },
        h('div', null,
          h('h2', null, 'Extend Rel.AI without replacing ChatGPT'),
          h('p', null, 'Extensions add developer workflows and external tools while ChatGPT remains the conversation and reasoning host.')
        ),
        h('div', { className: 'section-head-actions' },
          activeTab === 'discover' ? h('button', {
            className: 'secondary compact-button', type: 'button', disabled: busy === 'refresh',
            onClick: async () => {
              setBusy('refresh');
              await load({ refresh: true });
              setBusy('');
            }
          }, busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog') : null,
          h(ExternalLink, { href: EXTENSIONS_REPOSITORY_URL, label: 'Extension repository' })
        )
      ),
      h(ExtensionTabs, { activeTab, setActiveTab }),
      error ? h('div', { className: 'connection-notice bad', role: 'alert' },
        h('strong', null, 'Extensions could not be loaded'),
        h('p', null, error),
        h('button', { className: 'secondary compact-button', type: 'button', onClick: () => void load() }, 'Try again')
      ) : null,
      !data && !error ? h('div', { className: 'settings-loading', role: 'status' }, 'Loading extensions…') : null,
      data && activeTab === 'installed' ? h(InstalledPanel, { data, catalogById, busy, runInstall, runRemove }) : null,
      data && activeTab === 'discover' ? h(DiscoverPanel, { data, busy, runInstall }) : null,
      activeTab === 'developer' ? h(DeveloperPanel, { installRoot: data?.installRoot || '' }) : null
    );
  };
}

function ExtensionTabs({ activeTab, setActiveTab }) {
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
    }, label))
  );
}

function InstalledPanel({ data, catalogById, busy, runInstall, runRemove }) {
  const installed = data.installed || [];
  return h('section', { id: 'extensions-panel-installed', role: 'tabpanel', 'aria-labelledby': 'extensions-tab-installed', tabIndex: 0 },
    installed.length ? h('div', { className: 'extensions-list' }, installed.map(extension => {
      const catalog = catalogById.get(extension.id);
      return h(ExtensionCard, { key: extension.id, extension, status: extension.ready ? 'Ready' : extension.status === 'invalid' ? 'Invalid' : 'Needs setup', tone: extension.ready ? 'ok' : 'warn' },
        extension.error ? h('p', { className: 'extension-warning' }, extension.error) : null,
        h(PermissionList, { permissions: extension.permissions }),
        h('div', { className: 'extension-card-actions' },
          catalog?.updateAvailable ? h('button', { className: 'primary compact-button', type: 'button', disabled: Boolean(busy), onClick: () => void runInstall(catalog, 'update') }, busy === `update:${extension.id}` ? 'Updating…' : `Update to v${catalog.version}`) : null,
          h('button', { className: 'secondary compact-button danger', type: 'button', disabled: Boolean(busy), onClick: () => void runRemove(extension) }, busy === `remove:${extension.id}` ? 'Removing…' : 'Remove')
        )
      );
    })) : h(EmptyExtensions, { title: 'No extensions installed', copy: 'Open Discover to install extensions from the canonical Rel.AI catalog.' })
  );
}

function DiscoverPanel({ data, busy, runInstall }) {
  const catalog = data.catalog || [];
  return h('section', { id: 'extensions-panel-discover', role: 'tabpanel', 'aria-labelledby': 'extensions-tab-discover', tabIndex: 0 },
    data.catalogError ? h('div', { className: 'connection-notice warn', role: 'status' }, h('strong', null, 'Catalog unavailable'), h('p', null, data.catalogError)) : null,
    catalog.length ? h('div', { className: 'extensions-list' }, catalog.map(extension => h(ExtensionCard, {
      key: extension.id,
      extension,
      status: extension.installed ? (extension.updateAvailable ? 'Update available' : 'Installed') : extension.kind === 'cli' ? 'CLI adapter' : 'Skill',
      tone: extension.updateAvailable ? 'warn' : extension.installed ? 'ok' : ''
    },
      h(PermissionList, { permissions: extension.permissions }),
      h('div', { className: 'extension-card-actions' },
        extension.installed && !extension.updateAvailable
          ? h('span', { className: 'muted' }, `Installed v${extension.installedVersion}`)
          : h('button', {
              className: 'primary compact-button', type: 'button', disabled: Boolean(busy),
              onClick: () => void runInstall(extension, extension.installed ? 'update' : 'install')
            }, busy === `${extension.installed ? 'update' : 'install'}:${extension.id}` ? 'Working…' : extension.installed ? `Update to v${extension.version}` : 'Review & install')
      )
    ))) : h(EmptyExtensions, {
      title: data.catalogError ? 'Catalog could not be loaded' : 'No published extensions yet',
      copy: data.catalogError ? 'Refresh the catalog or open the repository to inspect it directly.' : 'Published extensions will appear here after they are added to the canonical catalog.'
    })
  );
}

function DeveloperPanel({ installRoot }) {
  return h('section', { id: 'extensions-panel-developer', role: 'tabpanel', 'aria-labelledby': 'extensions-tab-developer', tabIndex: 0, className: 'extensions-developer' },
    h('div', { className: 'layout-grid' },
      h(DeveloperCard, { title: 'Extension manifest' },
        h('p', { className: 'muted' }, 'Each package uses relai-extension.json with an id, semantic version, Rel.AI compatibility range, publisher, declared permissions, requirements, entrypoints, and SHA-256 hashes for every installed file.'),
        h(ExternalLink, { href: EXTENSION_SCHEMA_URL, label: 'Manifest schema' })
      ),
      h(DeveloperCard, { title: 'Supported adapters' },
        h('p', { className: 'muted' }, 'Skill extensions add reusable ChatGPT instructions. CLI extensions pair a skill with an existing local command and use Rel.AI’s current execution tools instead of introducing a new model or agent runtime.')
      )
    ),
    h(DeveloperCard, { title: 'Security and execution model' },
      h('ul', { className: 'extensions-guidelines' },
        h('li', null, 'ChatGPT Web remains the reasoning and conversation host.'),
        h('li', null, 'Catalog permissions are declarations shown before installation; Rel.AI’s existing authorization policy still enforces local actions.'),
        h('li', null, 'Files are downloaded only from the catalog-selected manifest, verified by SHA-256, and installed outside project folders.'),
        h('li', null, 'Extensions are not imported as arbitrary code into the Rel.AI service process.')
      ),
      installRoot ? h('div', { className: 'extension-install-root' }, h('span', null, 'Local extension folder'), h('code', null, installRoot)) : null
    ),
    h(DeveloperCard, { title: 'Publish an extension' },
      h('ol', { className: 'extensions-guidelines' },
        h('li', null, 'Create SKILL.md and relai-extension.json in your repository.'),
        h('li', null, 'Hash every packaged file and list the hashes in the manifest.'),
        h('li', null, 'Add one catalog entry in rel-ai-extensions that points to the HTTPS manifest URL.'),
        h('li', null, 'Keep requested permissions limited to what the extension actually needs.')
      ),
      h(ExternalLink, { href: EXTENSIONS_REPOSITORY_URL, label: 'Publishing repository' })
    )
  );
}

function ExtensionCard({ extension, status, tone = '', children }) {
  return h('article', { className: 'card extension-card' },
    h('div', { className: 'card-head extension-card-head' },
      h('div', null, h('h3', null, extension.name || extension.id), h('span', { className: 'extension-id' }, extension.id)),
      h('span', { className: `status-pill ${tone}`.trim() }, status)
    ),
    h('div', { className: 'card-body extension-card-body' },
      h('p', null, extension.description || 'No description provided.'),
      h('div', { className: 'extension-meta' },
        extension.version ? h('span', null, `v${extension.version}`) : null,
        extension.kind ? h('span', null, extension.kind === 'cli' ? 'CLI' : 'Skill') : null,
        extension.publisher ? h('span', null, typeof extension.publisher === 'string' ? extension.publisher : extension.publisher.name) : null
      ),
      children
    )
  );
}

function PermissionList({ permissions = [] }) {
  const values = Array.isArray(permissions) ? permissions : [];
  return h('div', { className: 'extension-permissions', 'aria-label': 'Declared extension access' },
    h('span', { className: 'extension-permissions-label' }, 'Declared access'),
    values.length
      ? values.map(permission => h('code', { className: 'extension-permission', key: permission }, permission))
      : h('span', { className: 'muted' }, 'None')
  );
}

function DeveloperCard({ title, children }) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('h3', null, title)),
    h('div', { className: 'card-body detail-stack' }, children)
  );
}

function EmptyExtensions({ title, copy }) {
  return h('div', { className: 'card' }, h('div', { className: 'empty-state' },
    h('div', { className: 'empty-state-icon', 'aria-hidden': 'true' }, h(Icon, { name: 'extensions', size: 24 })),
    h('strong', { className: 'empty-state-title' }, title),
    h('p', { className: 'empty-state-copy' }, copy)
  ));
}

function ExternalLink({ href, label }) {
  return h('a', { className: 'buttonlike secondary compact-button', href, target: '_blank', rel: 'noopener noreferrer' }, label, h(Icon, { name: 'externalLink', size: 14 }));
}

function permissionSummary(permissions = []) {
  return (Array.isArray(permissions) ? permissions : []).join(', ');
}

export { EXTENSIONS_REPOSITORY_URL, createExtensionsRoute };
