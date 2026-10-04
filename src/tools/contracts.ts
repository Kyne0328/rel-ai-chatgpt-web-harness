export const AUTHORIZATION_CAPABILITY = Object.freeze({
  REPOSITORY_READ: 'repository:read',
  REPOSITORY_WRITE: 'repository:write',
  COMMAND_EXECUTE: 'command:execute',
  PROCESS_MANAGE: 'process:manage',
  COMPUTER_CONTROL: 'computer:control',
  GIT_PUBLISH: 'git:publish'
} as const);

export const TASK_SCOPE = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  NONE: 'none'
} as const);

export const EXECUTION_CLASS = Object.freeze({
  BOUNDED_SYNCHRONOUS: 'bounded_synchronous',
  BACKGROUND_FALLBACK_ELIGIBLE: 'background_fallback_eligible',
  PERSISTENT_PROCESS: 'persistent_process',
  ALWAYS_IMMEDIATE: 'always_immediate'
} as const);

export const CONCURRENCY_SCOPE = Object.freeze({
  TASK: 'task',
  MUTATION: 'mutation',
  WORKSPACE: 'workspace'
} as const);

export const FAILURE_OPERATION = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  RESTORE: 'restore',
  COMMIT: 'commit',
  REVIEW: 'review'
} as const);
