/**
 * File: autonomyAdvice.ts
 * Purpose: P31.2 放权建议 — 用近 30 天的兑现率 / 失败率 / 改判率判断 L1–L3 是否该动。
 * 复盘卡和 /setup 的「信任累积」共用这一份口径，避免出现两套阈值：
 * 证据不足不放权；出现失败或高改判先收紧一级；一次只动一级。
 */
import dayjs from 'dayjs';
import { exceptionsApi, isAgentDecisionActor, type ExceptionItem } from './exceptions';
import { outcomesApi } from './outcomes';
import {
  getScenarioForAgent,
  scenarioDefinitions,
  scenariosApi,
} from './scenarioData';
import { storesApi } from './stores';
import type {
  AllMallId,
  AutonomyLevel,
  GoalOutcome,
  ScenarioKey,
  ScenarioState,
} from '../types/domain';

/**
 * 放权看比复盘更长的窗口：信任累积不能被一周的波动放大或收紧。
 * P31.4 再统一复盘窗口；这里先把口径写死为 30 天。
 */
export const AUTONOMY_ADVICE_WINDOW_DAYS = 30;
/** 放宽至少需要的已决策结果数：样本太少时宁可不放权。 */
export const AUTONOMY_MIN_DECIDED = 5;
/** 收紧所需的最小信号数：失败 / 改判是安全信号，门槛可以更低。 */
export const AUTONOMY_MIN_SIGNAL = 3;

export type AutonomyAdviceReason =
  | 'insufficient_sample'
  | 'loosen_strong'
  | 'tighten_failure'
  | 'tighten_override'
  | 'hold';

export interface AutonomyEvidence {
  /** 已有结果的决策动作数（已回写 + 失败） */
  decided: number;
  realized: number;
  failed: number;
  pending: number;
  /** 已回写动作的实际影响 / 预期影响 */
  fulfillmentRate?: number;
  /** 失败动作 / 已决策动作 */
  failureRate?: number;
  /** 人收尾的升级数（Agent 超时 / 规则收尾不计） */
  humanDecisions: number;
  /** 人改判数 / 人决策数 */
  overrideRate?: number;
}

export interface AutonomyAdvice {
  scenarioKey: ScenarioKey;
  current: AutonomyLevel;
  recommended: AutonomyLevel;
  direction: 'loosen' | 'keep' | 'tighten';
  reason: AutonomyAdviceReason;
  evidence: AutonomyEvidence;
}

const LEVELS: AutonomyLevel[] = ['L1', 'L2', 'L3'];

function stepLevel(level: AutonomyLevel, delta: number): AutonomyLevel {
  const index = Math.min(LEVELS.length - 1, Math.max(0, LEVELS.indexOf(level) + delta));
  return LEVELS[index];
}

/**
 * 纯规则：只输出「建议」，不写状态。放宽看兑现率，收紧看失败率与改判率；
 * 没有足够样本时维持当前等级，避免用一两单结果放大或收紧权限。
 */
export function recommendAutonomyLevel(
  current: AutonomyLevel,
  evidence: AutonomyEvidence,
): Pick<AutonomyAdvice, 'recommended' | 'direction' | 'reason'> {
  const { decided, failureRate, fulfillmentRate, humanDecisions, overrideRate } = evidence;

  if (humanDecisions >= AUTONOMY_MIN_SIGNAL && overrideRate !== undefined && overrideRate >= 50) {
    const recommended = stepLevel(current, -1);
    if (recommended === current) return { recommended, direction: 'keep', reason: 'hold' };
    return { recommended, direction: 'tighten', reason: 'tighten_override' };
  }

  if (decided >= AUTONOMY_MIN_SIGNAL && failureRate !== undefined && failureRate >= 25) {
    const recommended = stepLevel(current, -1);
    if (recommended === current) return { recommended, direction: 'keep', reason: 'hold' };
    return { recommended, direction: 'tighten', reason: 'tighten_failure' };
  }

  if (decided < AUTONOMY_MIN_DECIDED) {
    return { recommended: current, direction: 'keep', reason: 'insufficient_sample' };
  }

  const overrideOk = humanDecisions < AUTONOMY_MIN_SIGNAL || (overrideRate ?? 0) <= 20;
  if (fulfillmentRate !== undefined && fulfillmentRate >= 90 && (failureRate ?? 0) <= 10 && overrideOk) {
    const recommended = stepLevel(current, 1);
    return {
      recommended,
      direction: recommended === current ? 'keep' : 'loosen',
      reason: 'loosen_strong',
    };
  }

  return { recommended: current, direction: 'keep', reason: 'hold' };
}

/** 决策类升级（预算 / 毛利 / 折扣上限）默认属于定价促销场景。 */
const DECISION_SCENARIO: Record<string, ScenarioKey> = {
  budget: 'pricing_promo',
  margin: 'pricing_promo',
  discount_cap: 'pricing_promo',
};

function evidenceOf(outcomes: GoalOutcome[], escalations: ExceptionItem[]): AutonomyEvidence {
  const realized = outcomes.filter((outcome) => outcome.status === 'realized');
  const failed = outcomes.filter((outcome) => outcome.status === 'lost');
  const pending = outcomes.filter((outcome) => outcome.status === 'projected');
  const expected = realized.reduce((total, outcome) => total + outcome.expectedImpact, 0);
  const actual = realized.reduce((total, outcome) => total + (outcome.actualImpact ?? 0), 0);
  const decided = realized.length + failed.length;

  const humanDecisions = escalations.filter(
    (item) =>
      item.resolved &&
      Boolean(item.decisionOutcome) &&
      Boolean(item.resolvedAt) &&
      !isAgentDecisionActor(item.resolvedBy),
  );
  const overrides = humanDecisions.filter((item) => item.decisionOutcome === 'override').length;

  return {
    decided,
    realized: realized.length,
    failed: failed.length,
    pending: pending.length,
    fulfillmentRate: expected > 0 ? Math.round((actual / expected) * 100) : undefined,
    failureRate: decided > 0 ? Math.round((failed.length / decided) * 100) : undefined,
    humanDecisions: humanDecisions.length,
    overrideRate:
      humanDecisions.length > 0 ? Math.round((overrides / humanDecisions.length) * 100) : undefined,
  };
}

/**
 * 把账本结果与升级记录按场景聚合，产出每个场景的放权建议。
 * 调用方可以传入已经过店铺 / 时间窗过滤的数据，保证和复盘卡的其他数字同一口径。
 */
export function buildAutonomyAdvice(
  outcomes: GoalOutcome[],
  escalations: ExceptionItem[],
  states: ScenarioState[],
): AutonomyAdvice[] {
  const grouped = new Map<ScenarioKey, { outcomes: GoalOutcome[]; escalations: ExceptionItem[] }>();
  for (const def of scenarioDefinitions) {
    grouped.set(def.key, { outcomes: [], escalations: [] });
  }

  for (const outcome of outcomes) {
    const key = getScenarioForAgent(outcome.agentType);
    if (key) grouped.get(key)?.outcomes.push(outcome);
  }

  for (const item of escalations) {
    const key = getScenarioForAgent(item.agentType) ?? (item.decisionKind ? DECISION_SCENARIO[item.decisionKind] : undefined);
    if (key) grouped.get(key)?.escalations.push(item);
  }

  return scenarioDefinitions.map((def) => {
    const bucket = grouped.get(def.key)!;
    const state = states.find((item) => item.key === def.key);
    const current = state?.autonomy ?? 'L1';
    const evidence = evidenceOf(bucket.outcomes, bucket.escalations);
    return {
      scenarioKey: def.key,
      current,
      evidence,
      ...recommendAutonomyLevel(current, evidence),
    };
  });
}

/**
 * /setup 的信任累积数据源：取全部店铺（或指定店铺）近 30 天的账本与升级，
 * 逐场景给出建议。只读，不改自主等级。
 */
export async function getAutonomyAdvice(storeIds?: AllMallId[]): Promise<AutonomyAdvice[]> {
  const [stores, states, exceptions] = await Promise.all([
    storesApi.list(),
    scenariosApi.list(),
    exceptionsApi.list(),
  ]);
  const scopedStores = storeIds?.length ? stores.filter((store) => storeIds.includes(store.id)) : stores;
  const allowedStoreIds = new Set(scopedStores.map((store) => store.id));
  const scopeStoreNames = new Set(scopedStores.map((store) => store.name));
  const since = dayjs().subtract(AUTONOMY_ADVICE_WINDOW_DAYS, 'day');

  const outcomeLists = await Promise.all(scopedStores.map((store) => outcomesApi.list(store.id)));
  const outcomes = outcomeLists
    .flat()
    .filter((outcome) => dayjs(outcome.recordedAt).isAfter(since));
  const escalations = exceptions.filter((item) => {
    const inScope =
      item.storeId !== undefined ? allowedStoreIds.has(item.storeId) : scopeStoreNames.has(item.storeName);
    return inScope && dayjs(item.createdAt).isAfter(since);
  });

  return buildAutonomyAdvice(outcomes, escalations, states);
}
