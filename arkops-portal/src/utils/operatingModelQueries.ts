import type { QueryClient } from '@tanstack/react-query';

/**
 * P50：目标与护栏是所有账户级推导的唯一输入。
 * 单店卡、账户目标、账户护栏、预算池、工作台巡检原先各写一份刷新清单，各自漏项，
 * 导致改完单店目标后同页的预算池/账户护栏还停在旧值。清单统一收在这里，
 * 任何一处改动目标或护栏后都调用它，谁也不用再手写加法。
 */
const OPERATING_MODEL_QUERY_KEYS = [
  'storeGoal',
  'goalPeriod',
  'goalPace',
  'guardHealth',
  'guardChanges',
  'guardImpact',
  'portfolio',
  'budgetPool',
  'budgetRevert',
  'accountGoal',
  'accountGoalSuggestion',
  'accountGoalReview',
  'accountAllocation',
  'accountGuards',
  'accountGuardPreview',
  'crossStoreArbitration',
  'dashboard',
  'operatingCycle',
  'exceptions',
  'approvals',
  'audit-logs',
] as const;

export function invalidateOperatingModelQueries(queryClient: QueryClient) {
  OPERATING_MODEL_QUERY_KEYS.forEach((key) => {
    queryClient.invalidateQueries({ queryKey: [key] });
  });
}
