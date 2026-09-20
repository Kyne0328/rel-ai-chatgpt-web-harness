import { OPERATION_IDS as OP } from './tools/operationIds.js';
import {
  ANALYTICS_TASK_INTENTS,
  ANALYTICS_USE_CASES,
  WORKFLOW_INTENTS,
  analyticsTaskIntentLabel,
  analyticsUseCaseLabel,
  analyticsUseCaseShortLabel,
  isPrimaryAnalyticsUseCase,
  normalizeAnalyticsTaskIntent,
  normalizeAnalyticsUseCase,
  type AnalyticsTaskIntent,
  type AnalyticsUseCase
} from './contracts/analyticsTaxonomy.ts';

const OPERATION_USE_CASE: Readonly<Record<string, AnalyticsUseCase>> = Object.freeze({
  [OP.SNAPSHOT]: 'explore',
  [OP.READ]: 'explore',
  [OP.SEARCH_TEXT]: 'explore',
  [OP.SEARCH_SEMANTIC]: 'explore',
  [OP.INSPECT]: 'explore',
  [OP.EDIT]: 'edit',
  [OP.EXEC]: 'execute',
  [OP.PROCESS_START]: 'execute',
  [OP.PROCESS_READ]: 'execute',
  [OP.PROCESS_WRITE]: 'execute',
  [OP.PROCESS_STOP]: 'execute',
  [OP.PROCESS_LIST]: 'execute',
  [OP.VALIDATE_CHECKS]: 'validate',
  [OP.VALIDATE_DIAGNOSTICS]: 'validate',
  [OP.VALIDATE_HTTP]: 'validate',
  [OP.UI]: 'browser',
  [OP.BROWSER]: 'browser',
  [OP.DESKTOP]: 'desktop',
  [OP.COMPUTER]: 'desktop',
  [OP.CHANGES_DIFF]: 'review_recover',
  [OP.CHANGES_CHECKPOINT]: 'review_recover',
  [OP.CHANGES_REPLAY]: 'review_recover',
  [OP.CHANGES_RESTORE]: 'review_recover',
  [OP.CHANGES_RESET]: 'review_recover',
  [OP.CHANGES_TIDY_PLAN]: 'review_recover',
  [OP.CHANGES_TIDY_RUN]: 'review_recover',
  [OP.PUBLISH_COMMIT]: 'publish',
  [OP.PUBLISH_PUSH]: 'publish',
  [OP.PUBLISH_DRAFT_PR]: 'publish',
  [OP.WORK_BEGIN]: 'work_session',
  [OP.WORK_CONTEXT]: 'work_session',
  [OP.WORK_PLAN]: 'work_session',
  [OP.WORK_STATUS]: 'work_session',
  [OP.WORK_STOP]: 'work_session',
  [OP.WORK_FINISH]: 'work_session',
  [OP.WORK_CANCEL]: 'work_session'
});

function analyticsUseCaseForOperation(value: unknown): AnalyticsUseCase {
  return OPERATION_USE_CASE[String(value || '').trim()] || 'other';
}

export {
  ANALYTICS_TASK_INTENTS,
  ANALYTICS_USE_CASES,
  WORKFLOW_INTENTS,
  analyticsTaskIntentLabel,
  analyticsUseCaseForOperation,
  analyticsUseCaseLabel,
  analyticsUseCaseShortLabel,
  isPrimaryAnalyticsUseCase,
  normalizeAnalyticsTaskIntent,
  normalizeAnalyticsUseCase
};
export type { AnalyticsTaskIntent, AnalyticsUseCase };
