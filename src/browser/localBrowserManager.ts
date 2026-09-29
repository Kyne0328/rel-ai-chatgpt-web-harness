import type { AutomationContext, AutomationWorkspace } from '../computer/automationAttribution.ts';
import { browserRuntime } from './browserRuntime.ts';

type LocalBrowserWorkspace = AutomationWorkspace & Readonly<{
  path?: string;
  sourcePaths?: readonly string[];
}>;

type LocalBrowserArgs = Readonly<Record<string, unknown> & {
  action?: unknown;
}>;

type LocalBrowserContext = AutomationContext & Readonly<Record<string, unknown> & {
  signal?: AbortSignal;
}>;

async function runLocalBrowserAction(
  workspace: LocalBrowserWorkspace,
  _config: unknown,
  args: LocalBrowserArgs = {},
  context: LocalBrowserContext = {}
): Promise<Record<string, unknown>> {
  const action = String(args.action || '').trim();
  const options = context.signal ? { signal: context.signal } : {};
  switch (action) {
    case 'status': return browserRuntime.status(workspace, args, context);
    case 'start': return browserRuntime.start(workspace, args, context, options);
    case 'tabs': return browserRuntime.listTabs(workspace, args, context);
    case 'open_tab': return browserRuntime.openTab(workspace, args, context, options);
    case 'close_tab': return browserRuntime.closeTab(workspace, args, context);
    case 'navigate': return browserRuntime.navigate(workspace, args, context, options);
    case 'snapshot': return browserRuntime.snapshot(workspace, args, context, options);
    case 'interact': return browserRuntime.interact(workspace, args, context, options);
    case 'screenshot': return browserRuntime.screenshot(workspace, args, context, options);
    case 'upload': return browserRuntime.upload(workspace, args, context, options);
    case 'download': return browserRuntime.download(workspace, args, context, options);
    case 'handoff': return browserRuntime.handoff(workspace, args, context);
    case 'resume': return browserRuntime.resume(workspace, args, context);
    case 'clear_profile': return browserRuntime.clearProfile(workspace, args, context);
    case 'stop': return browserRuntime.stop(workspace, args, context);
    default: throw new Error(`Unsupported local browser action '${action || '(missing)'}.`);
  }
}

export { runLocalBrowserAction };
