import { getToolActivity, updateCurrentToolActivity } from '../toolActivity.js';
import { normalizeTaskPlan } from '../taskObservability.js';

function applyTaskProgressPatch(taskId, patch = {}, update = updateCurrentToolActivity) {
  const id = String(taskId || '').trim();
  if (!id || !patch || typeof patch !== 'object' || Array.isArray(patch)) return null;

  const currentTask = getToolActivity().tasks.find(task => String(task.id || task.taskId || '') === id) || null;
  const currentPlan = currentTask?.plan || { revision: 0, steps: [] };
  const currentRevision = Math.max(0, Number(currentPlan.revision || 0));

  const hasSteps = Array.isArray(patch.steps);
  const hasStep = Boolean(patch.step && typeof patch.step === 'object' && !Array.isArray(patch.step));
  if (hasSteps === hasStep) throw new Error('taskProgress requires exactly one of steps or step.');

  let candidate;
  if (hasSteps) {
    candidate = normalizeTaskPlan({ revision: currentRevision, steps: patch.steps }) || { revision: currentRevision, steps: [] };
  } else if (patch.step && typeof patch.step === 'object') {
    const stepId = String(patch.step.id || '').trim();
    const index = currentPlan.steps.findIndex(step => String(step?.id || '') === stepId);
    if (index < 0) throw new Error(`taskProgress references unknown plan step '${stepId}'. Send taskProgress.steps once to establish the ordered plan first.`);
    const steps = currentPlan.steps.map((step, stepIndex) => stepIndex === index
      ? { ...step, status: patch.step.status, ...(patch.step.detail !== undefined ? { detail: patch.step.detail } : {}) }
      : step);
    candidate = normalizeTaskPlan({ revision: currentRevision, steps }) || { revision: currentRevision, steps: [] };
  } else {
    return null;
  }

  const changed = JSON.stringify(currentPlan.steps || []) !== JSON.stringify(candidate.steps || []);
  const plan = changed ? { ...candidate, revision: currentRevision + 1 } : currentPlan;
  if (changed) update?.({ plan });

  const resolved = plan.steps.filter(step => ['completed', 'skipped'].includes(String(step?.status || ''))).length;
  const active = plan.steps.find(step => String(step?.status || '') === 'in_progress') || null;
  return {
    changed,
    revision: Math.max(0, Number(plan.revision || 0)),
    resolved,
    total: plan.steps.length,
    ...(active ? { activeStepId: String(active.id || '') } : {}),
    plan
  };
}

export { applyTaskProgressPatch };
