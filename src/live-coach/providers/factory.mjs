import { join } from 'node:path';
import { PlanModelProvider } from './model.mjs';
import { DeepSeekModelProvider } from './deepseek.mjs';
import { PaidModelBudget } from './paid-model-budget.mjs';
import { currentPlanOnlyConfirmation } from '../config.mjs';

/** Explicit provider selection only; never tries another backend after failure. */
export function createModelProvider(config, { auth, budget, fetchImpl } = {}) {
  if (config.modelProvider === 'deepseek') return new DeepSeekModelProvider({ apiKey: config.deepseekKey, model: config.modelId,
    budget: new PaidModelBudget({ filePath: join(config.directory, 'usage-deepseek.json'), grant: config.deepseekGrant }), ...(fetchImpl ? { fetchImpl } : {}) });
  if (config.modelProvider !== 'siwc') throw new Error('invalid_model_provider');
  return new PlanModelProvider({ auth, budget, model: config.modelId, siwc_plan_only_confirmed: config.siwcPlanOnlyConfirmed,
    planOnlyCheck: () => currentPlanOnlyConfirmation(config.directory, config.siwcPlanOnlyRevision), ...(fetchImpl ? { fetchImpl } : {}) });
}
