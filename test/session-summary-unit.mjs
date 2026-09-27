import assert from 'node:assert/strict';

import { sessionSummary } from '../src/ui/features/sessions/index.js';

assert.equal(sessionSummary([
  { status: 'running' },
  { status: 'waiting' },
  { status: 'waiting_for_approval' },
  { status: 'blocked' },
  { status: 'validation_failed' },
  { status: 'inactive' },
  { status: 'completed' },
  { status: 'cancelled' },
  { status: 'failed' }
]), '1 active · 1 waiting · 3 need attention · 1 inactive · 1 completed · 1 cancelled · 1 failed');

assert.equal(sessionSummary([
  { status: 'running', endedAt: new Date().toISOString() },
  { status: 'cancelled', endReason: 'explicit_cancellation', cancellationInitiator: 'user' }
]), '1 active · 0 waiting · 0 completed · 1 cancelled', 'running tasks must remain active and explicit cancellations must remain separate');

assert.equal(sessionSummary([
  { status: 'inactive' },
  { status: 'cancelled' },
  { status: 'failed' }
]), '0 active · 0 waiting · 1 inactive · 0 completed · 1 cancelled · 1 failed', 'inactive, cancelled, and failed tasks must never inflate the waiting count');

console.log('Task summary status buckets passed.');
