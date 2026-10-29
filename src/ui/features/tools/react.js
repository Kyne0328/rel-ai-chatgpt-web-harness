import React, { useEffect, useMemo, useState } from 'react';
import './styles.css';
import { Icon } from '../../components/icons.js';
import { fetchJson } from '../../api.js';
import { FilterChoice } from '../../components/filter-drawer.js';
import {
  TOOL_CAPABILITIES,
  TOOL_CAPABILITY_IDS,
  capabilityCount,
  capabilityLabel,
  orderToolsForCatalog,
  toolCapabilities,
  toolMatchesFilters,
  toolsFromPayload
} from './index.js';

const h = React.createElement;
const TOOL_CATALOG_CACHE_TTL_MS = 60 * 1000;

export function createToolsRoute() {
  return function ToolsRoute() {
    const [tools, setTools] = useState([]);
    const [loadState, setLoadState] = useState({ status: 'loading', error: '' });
    const [retryToken, setRetryToken] = useState(0);
    const [search, setSearch] = useState('');
    const [capability, setCapability] = useState('all');

    useEffect(() => {
      let active = true;
      setLoadState({ status: 'loading', error: '' });
      void fetchJson('/api/tools', { cacheTtlMs: TOOL_CATALOG_CACHE_TTL_MS }).then(result => {
        if (!active) return;
        const payload = toolsFromPayload(result);
        if (result?.ok === false || payload == null) {
          setTools([]);
          setLoadState({ status: 'error', error: String(result?.error || 'The tool catalog returned an unexpected response.') });
          return;
        }
        setTools(orderToolsForCatalog(payload));
        setLoadState({ status: 'ready', error: '' });
      });
      return () => { active = false; };
    }, [retryToken]);

    const visible = useMemo(
      () => tools.filter(tool => toolMatchesFilters(tool, { search, capability })),
      [tools, search, capability]
    );
    const summary = loadState.status === 'error'
      ? 'Tool catalog unavailable'
      : loadState.status === 'loading'
        ? 'Loading tool catalog…'
        : `${visible.length} of ${tools.length} tools shown`;

    return h('div', { className: 'settings-content system-content', 'data-tools-react': 'true' },
      h('div', { className: 'section tools-section' },
        h(ToolsFilterBar, {
          search,
          capability,
          summary,
          onSearch: setSearch,
          onCapabilityClear: () => setCapability('all'),
          onClearAll: () => { setSearch(''); setCapability('all'); },
          filterOptions: TOOL_CAPABILITIES.map(item => ({ value: item.id, label: item.label + " (" + capabilityCount(tools, item.id) + ")" })),
          onCapabilityChange: next => setCapability(TOOL_CAPABILITY_IDS.has(next) ? next : "all")
        }),
        h('div', { id: 'toolsBody', className: 'tools-grid' },
          loadState.status === 'loading'
            ? h('div', { className: 'skeleton-grid', role: 'status', 'aria-label': 'Loading tools' }, [0, 1, 2].map(i => h('div', { key: i, className: 'skeleton-block', 'aria-hidden': 'true' })))
            : loadState.status === 'error'
              ? h(EmptyState, {
                  iconName: 'warning',
                  title: 'Tool catalog unavailable',
                  description: loadState.error,
                  action: 'Retry',
                  onAction: () => setRetryToken(value => value + 1)
                })
              : visible.length
                ? visible.map(tool => h(ToolCard, { key: tool.name || tool.title || tool.displayName, tool }))
                : h(EmptyState, {
                    title: tools.length ? 'No matching tools' : 'No tools available',
                    description: tools.length ? 'Change the search or capability filter.' : 'Rel.AI did not report any ChatGPT tools.'
                  })
        )
      )
    );
  };
}

function ToolsFilterBar({ search, capability, summary, onSearch, onCapabilityClear, onClearAll, filterOptions, onCapabilityChange }) {
  const filters = capability === 'all' ? [] : [{ label: 'Capability', value: capabilityLabel(capability), onRemove: onCapabilityClear }];
  return h('div', { id: 'toolsToolbar' },
    h('section', { className: 'filter-bar', 'aria-label': 'List filters' },
      h('div', { className: 'filter-bar-controls' },
        h('label', { className: 'filter-search-control' },
          h('span', { className: 'sr-only' }, 'Search tools'),
          h('input', {
            type: 'search', className: 'filter-search-input', placeholder: 'Search tools', autoComplete: 'off', value: search,
            onChange: event => onSearch(event.target.value)
          })
        ),
        h(FilterChoice, { label: 'Tool capability filter', value: capability, options: filterOptions, onChange: onCapabilityChange })
      ),
      filters.length ? h('div', { className: 'filter-chip-list', 'aria-label': 'Active filters' },
        filters.map(filter => h('button', {
          key: filter.label,
          type: 'button', className: 'secondary filter-chip',
          'aria-label': `Remove ${filter.label} filter: ${filter.value}`,
          onClick: filter.onRemove
        }, h('span', null, `${filter.label}: ${filter.value} `), h(Icon, { name: 'close', size: 14 })))
      ) : null,
      h('div', { className: 'filter-bar-footer' },
        h('span', { className: 'filter-summary', role: 'status', 'aria-live': 'polite' }, summary),
        h('button', {
          type: 'button', className: 'secondary filter-clear-button', hidden: !(search || filters.length), onClick: onClearAll
        }, 'Clear all')
      )
    )
  );
}

function ToolCard({ tool }) {
  const capabilities = toolCapabilities(tool);
  return h('article', { className: `tool-card ${capabilities.map(item => `capability-${item}`).join(' ')}` },
    h('div', { className: 'tool-card-head' },
      h('span', { className: 'tool-capability' }, capabilities.map(capabilityLabel).join(' · '))
    ),
    h('div', { className: 'tool-card-title' }, h('h3', null, tool.title || tool.displayName || tool.name || 'Tool')),
    h('p', null, tool.description || 'No description provided.')
  );
}

function EmptyState({ iconName = 'info', title, description, action = '', onAction }) {
  return h('div', { className: 'empty-state' },
    h('span', { className: 'empty-state-icon', 'aria-hidden': 'true' }, h(Icon, { name: iconName, size: 28 })),
    h('strong', { className: 'empty-state-title' }, title),
    h('p', { className: 'empty-state-copy' }, description),
    action ? h('button', { type: 'button', className: 'secondary', onClick: onAction }, action) : null
  );
}
