import * as path from "node:path";
import * as connection from "./connectionProfile.js";
import { readConfig } from "./config.js";
import { readJsonFile, writeJsonAtomic } from './durableState.ts';

function onboardingPath() {
  return path.join(connection.stateDir(), "onboarding.json");
}

function readOnboardingState() {
  return readJsonFile(onboardingPath(), {
    backup: true,
    fallback: null,
    mode: 0o600,
    validate: value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  });
}

function writeOnboardingState(state) {
  writeJsonAtomic(onboardingPath(), state, { backup: true, mode: 0o600, spacing: 2 });
  return state;
}

function inferExistingSetup() {
  try {
    const config = readConfig({ allowMissing: true });
    const workspaceCount = Object.keys(config.workspaces || {}).length;
    if (workspaceCount === 0) return null;
    return writeOnboardingState({
      completed: true,
      skipped: false,
      migrated: true,
      workspaceCount,
      updatedAt: new Date().toISOString()
    });
  } catch {
    return null;
  }
}

function getOnboardingStatus() {
  const state = readOnboardingState() || inferExistingSetup();
  const completed = state?.completed === true;
  const skipped = state?.skipped === true;
  return {
    completed,
    skipped,
    migrated: state?.migrated === true,
    source: String(state?.source || ''),
    handoffPending: state?.handoffPending === true,
    needsOnboarding: !completed && !skipped
  };
}

export { getOnboardingStatus, readOnboardingState, writeOnboardingState };
