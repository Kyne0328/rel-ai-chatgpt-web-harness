import * as fs from 'node:fs';
import * as path from 'node:path';

import { readConfig } from '../config.js';
import { callTool } from '../tools.js';

export interface WorkspacePreflightFinding {
  severity: 'error';
  code: string;
  message: string;
}

export interface WorkspacePathPreflight {
  ok: boolean;
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGit: boolean;
  findings: WorkspacePreflightFinding[];
}

export function resolveWorkspaceFolder(workspaceAlias: string): string {
  const config = readConfig();
  const workspace = config.workspaces?.[workspaceAlias];
  if (!workspace?.path) throw new Error(`Unknown workspace: ${workspaceAlias}`);
  return workspace.path;
}

export async function controlDashboardTask(action: 'stop' | 'cancel', workId: string, operationId = ''): Promise<Record<string, unknown>> {
  const taskId = String(workId || '').trim();
  if (!taskId) throw new Error('work_id is required');
  if (!['stop', 'cancel'].includes(action)) throw new Error('action must be stop or cancel');
  return callTool('relai_work', {
    action,
    work_id: taskId,
    ...(action === 'stop' && operationId ? { operationId: String(operationId).trim() } : {}),
    reason: action === 'cancel'
      ? 'Task cancelled from the Rel.AI dashboard.'
      : 'Running operation stopped from the Rel.AI dashboard.'
  }, { publicHttpOnly: false });
}

export async function runWorkspaceValidation(workspace: string): Promise<Record<string, unknown>> {
  let workId = '';
  try {
    const started = await callTool('relai_work', {
      action: 'begin',
      workspace,
      title: `Validate ${workspace}`,
      objective: 'Run the configured repository validation from the desktop dashboard.',
      bootstrap: 'none'
    }, { publicHttpOnly: false });
    workId = String(started.work_id || '');
    return await callTool('relai_validate', {
      action: 'checks',
      work_id: workId,
      complete: true,
      summary: `Dashboard validation completed for ${workspace}.`
    }, { publicHttpOnly: false });
  } catch (error) {
    if (workId) {
      try {
        await callTool('relai_work', {
          action: 'cancel',
          work_id: workId,
          reason: 'Dashboard validation could not complete.'
        }, { publicHttpOnly: false });
      } catch {}
    }
    throw error;
  }
}

export function workspacePathPreflight(rawPath: unknown): WorkspacePathPreflight {
  const target = path.resolve(String(rawPath || ''));
  const findings: WorkspacePreflightFinding[] = [];
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(target);
  } catch {
    findings.push({ severity: 'error', code: 'path_not_found', message: `Path does not exist: ${target}` });
  }
  const exists = Boolean(stat);
  const isDirectory = Boolean(stat?.isDirectory());
  const isGit = isDirectory && fs.existsSync(path.join(target, '.git'));
  if (exists && !isDirectory) findings.push({ severity: 'error', code: 'path_not_directory', message: `Path is not a directory: ${target}` });
  return { ok: findings.length === 0, path: target, exists, isDirectory, isGit, findings };
}
