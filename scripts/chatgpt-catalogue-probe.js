/* global document, location, alert */
// Paste the entire file into DevTools Console while signed in at https://chatgpt.com.
// For phones, use the generated chatgpt-catalogue-bookmarklet.txt as a bookmark URL.
// This diagnostic makes only same-origin GET requests. It never prints or stores the access token.
(async () => {
  const expectedOrigin = 'https://chatgpt.com';
  if (location.origin !== expectedOrigin) {
    alert('Open https://chatgpt.com and sign in before running this test.');
    return;
  }

  const report = ['ChatGPT catalogue test (read-only)', new Date().toISOString(), ''];
  const show = () => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000a;display:flex;align-items:center;justify-content:center;padding:16px;';
    const panel = document.createElement('section');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'ChatGPT catalogue test results');
    panel.style.cssText = 'background:#202123;color:#fff;border:1px solid #666;border-radius:12px;padding:18px;width:min(660px,100%);max-height:90dvh;overflow:auto;font:14px/1.5 system-ui,sans-serif;box-sizing:border-box;';
    const heading = document.createElement('strong');
    heading.textContent = 'ChatGPT catalogue test results';
    const pre = document.createElement('pre');
    pre.textContent = report.join('\n');
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font:13px/1.6 ui-monospace,monospace;margin:16px 0;';
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const copy = document.createElement('button');
    copy.textContent = 'Copy report';
    const close = document.createElement('button');
    close.textContent = 'Close';
    for (const button of [copy, close]) {
      button.style.cssText = 'padding:10px 14px;border:1px solid #888;border-radius:8px;background:#444;color:white;cursor:pointer;font:inherit;';
    }
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(report.join('\n'));
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Select and copy the text above';
      }
    });
    close.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.remove();
    });
    buttons.append(copy, close);
    panel.append(heading, pre, buttons);
    overlay.append(panel);
    document.body.append(overlay);
    close.focus();
  };

  async function getJson(path, token) {
    try {
      const response = await fetch(path, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: 'Bearer ' + token } : {})
        }
      });
      if (!response.ok) return { status: response.status };
      try {
        return { status: response.status, data: await response.json() };
      } catch {
        return { status: response.status, error: 'Not a JSON response' };
      }
    } catch {
      return { status: 'network or browser error' };
    }
  }

  function listChats(items) {
    if (!Array.isArray(items)) return ['  Unexpected response shape (no items array)'];
    if (!items.length) return ['  No chats returned'];
    return items.slice(0, 5).map((chat, index) => {
      const title = String(chat?.title || chat?.conversation?.title || '(untitled)');
      const id = String(chat?.id || chat?.conversation?.id || '(no ID)');
      return '  ' + (index + 1) + '. ' + title + ' [' + id + ']';
    });
  }

  try {
    const auth = await getJson('/api/auth/session');
    const token = auth.data?.accessToken;
    const authenticated = Boolean(auth.data?.user && typeof token === 'string' && token);
    report.push('Session: HTTP ' + auth.status + (authenticated ? ' (access token present)' : ' (no usable access token)'));
    if (!authenticated) {
      report.push('Stop: this browser session cannot authenticate the catalogue requests.');
      return;
    }

    const ordinary = await getJson('/backend-api/conversations?offset=0&limit=20&order=updated&is_archived=false', token);
    report.push('', 'Conversation catalogue: HTTP ' + ordinary.status);
    if (ordinary.error) report.push('  ' + ordinary.error);
    if (ordinary.data) {
      report.push('  Total: ' + (ordinary.data.total ?? 'unknown'));
      report.push(...listChats(ordinary.data.items));
      report.push('  Note: this catalogue may also include Project chats.');
    }

    const sidebar = await getJson('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5', token);
    report.push('', 'Projects sidebar: HTTP ' + sidebar.status);
    if (sidebar.error) report.push('  ' + sidebar.error);
    if (!Array.isArray(sidebar.data?.items)) {
      report.push('  No usable project list returned.');
      return;
    }

    const projectId = /^g-p-[0-9a-f]{32}$/i;
    const projects = sidebar.data.items.map(item => {
      const record = item?.gizmo || item;
      return {
        id: String(record?.gizmo?.id || record?.id || ''),
        name: String(record?.gizmo?.display?.name || record?.gizmo?.name || record?.name || record?.title || '(unnamed project)'),
        previews: item?.conversations?.items
      };
    }).filter(project => projectId.test(project.id));
    report.push('  Projects on first page: ' + projects.length);
    if (sidebar.data.cursor) report.push('  Additional Projects pages exist (not scanned).');
    const project = projects.find(item => Array.isArray(item.previews) && item.previews.length >= 5) || projects[0];
    if (!project) {
      report.push('  No valid Project IDs found on this page.');
      return;
    }

    report.push('  Selected Project: ' + project.name + ' [' + project.id + ']');
    const projectChats = await getJson('/backend-api/gizmos/' + project.id + '/conversations?cursor=0', token);
    report.push('', 'Project conversation catalogue: HTTP ' + projectChats.status);
    if (projectChats.error) report.push('  ' + projectChats.error);
    if (projectChats.data) report.push(...listChats(projectChats.data.items));
    if (!projectChats.data && Array.isArray(project.previews)) {
      report.push('  Sidebar preview (not proof the catalogue endpoint worked):');
      report.push(...listChats(project.previews));
    }
  } finally {
    show();
  }
})();
