/**
 * File: outcomes.ts
 * Purpose: P3 归因回写 — 把提案执行效果记成 GoalOutcome 并写回店铺目标进度。
 *
 * 为什么需要这一层：P2 让方案能被执行，但执行完就断了 — 目标卡不会变化，
 * 下一轮诊断仍按旧进度算差距。本文件是“效果 → 目标”的唯一写入口：
 * 自动执行立即回写，审批路径待通过后回写，被拒绝则标记为未回写。
 */
import { mockDelay } from './client';
import { recordAuditLog } from './auditLogger';
import { registerMockState } from './mockPersistence';
import { operatingModelApi } from './operatingModel';
import dayjs from 'dayjs';
import type {
  AgentType,
  AllMallId,
  CycleProposal,
  GoalMetric,
  GoalOutcome,
  OutcomeStatus,
  ProposalAction,
} from '../types/domain';

/**
 * 模拟归因系数：真实环境应按平台回流数据（成交、退款、广告归因窗）计算。
 * 这里固定比例，保证演示中“实际效果”与“预期贡献”有可解释的差异。
 */
const ATTRIBUTION_RATIO = 0.88;

const outcomes = new Map<AllMallId, GoalOutcome[]>();
let nextOutcomeId = 1;

function listOf(storeId: AllMallId): GoalOutcome[] {
  let list = outcomes.get(storeId);
  if (!list) {
    list = [];
    outcomes.set(storeId, list);
  }
  return list;
}

/** 同步读取（供 orchestrator 在生成周期时过滤已执行动作）。 */
export function getOutcomes(storeId: AllMallId): GoalOutcome[] {
  return listOf(storeId).map((item) => ({ ...item }));
}

/** 经营周起点：周一 00:00（dayjs 默认周起点是周日，这里手动对齐）。 */
export function getWeekStart(reference = dayjs()): dayjs.Dayjs {
  const weekday = reference.day();
  const offset = weekday === 0 ? 6 : weekday - 1;
  return reference.startOf('day').subtract(offset, 'day');
}

const seededHistory = new Set<AllMallId>();

/**
 * P3.5：为多店铺视图补齐“上周”归因历史。
 * 这些记录只作为账本展示，不再计入目标进度，否则会造成重复回写。
 */
export function ensureHistory(storeId: AllMallId): void {
  if (seededHistory.has(storeId)) return;
  seededHistory.add(storeId);
  const list = listOf(storeId);
  if (list.length > 0) return;

  const weekStart = getWeekStart();
  const baseImpact = 1200 + (storeId % 4) * 700;
  const seeds: { targetLabel: string; action: 'increase_discount' | 'replenish_stock'; ratio: number }[] = [
    { targetLabel: 'SKU-B-110 · 夏季T恤', action: 'increase_discount', ratio: 1.4 },
    { targetLabel: 'SKU-D-401 · 冰感毛巾', action: 'replenish_stock', ratio: 0.7 },
  ];
  seeds.forEach((seed, index) => {
    const expectedImpact = Math.round(baseImpact * seed.ratio);
    list.push({
      id: nextOutcomeId++,
      storeId,
      cycleId: storeId * 10 + 9,
      proposalId: 0,
      agentType: seed.action === 'replenish_stock' ? 'inventory_alert' : 'promotion_campaign',
      action: seed.action,
      targetLabel: seed.targetLabel,
      metric: 'gmv',
      expectedImpact,
      actualImpact: Math.round(expectedImpact * ATTRIBUTION_RATIO),
      status: 'realized',
      recordedAt: weekStart.subtract(3 + index * 2, 'day').add(10, 'hour').toISOString(),
    });
  });
}

function recordAudit(outcome: GoalOutcome, action: string, summary: string) {
  recordAuditLog({
    actor: 'Orchestrator',
    action,
    entity: 'store',
    entityId: outcome.storeId,
    storeId: outcome.storeId,
    summary,
    category: 'agent_action',
    linkTo: `/dashboard?storeId=${outcome.storeId}`,
  });
}

/** 把效果计入目标进度 — 所有“已回写”都必须经过这里。 */
function realize(outcome: GoalOutcome) {
  outcome.status = 'realized';
  outcome.actualImpact = Math.round(outcome.expectedImpact * ATTRIBUTION_RATIO);
  operatingModelApi.addGoalProgress(
    outcome.storeId,
    outcome.actualImpact,
    `${outcome.targetLabel} · ${outcome.action}`,
  );
}

interface RecordInput {
  storeId: AllMallId;
  cycleId: AllMallId;
  proposal: CycleProposal;
  metric: GoalMetric;
  status: Extract<OutcomeStatus, 'projected' | 'realized' | 'lost'>;
  approvalId?: AllMallId;
  /** P6 自动执行回执：失败/超时不回写目标进度 */
  executionStatus?: 'succeeded' | 'failed' | 'timeout';
}

interface RecordCrossStoreInput {
  storeId: AllMallId;
  cycleId: AllMallId;
  agentType: AgentType;
  action: ProposalAction;
  targetLabel: string;
  metric: GoalMetric;
  expectedImpact: number;
  status: Extract<OutcomeStatus, 'realized' | 'lost'>;
  executionStatus?: 'succeeded' | 'failed' | 'timeout';
}

export const outcomesApi = {
  list: (storeId: AllMallId) => mockDelay(getOutcomes(storeId)),

  /** 提案提交时记录效果：自动执行为 realized，进入审批为 projected。 */
  recordForProposal: (input: RecordInput): GoalOutcome => {
    const outcome: GoalOutcome = {
      id: nextOutcomeId++,
      storeId: input.storeId,
      cycleId: input.cycleId,
      proposalId: input.proposal.id,
      approvalId: input.approvalId,
      agentType: input.proposal.agentType,
      action: input.proposal.action,
      targetLabel: input.proposal.targetLabel,
      metric: input.metric,
      expectedImpact: input.proposal.expectedImpact,
      status: input.status,
      executionStatus: input.executionStatus,
      recordedAt: new Date().toISOString(),
    };
    if (outcome.status === 'realized') realize(outcome);
    listOf(input.storeId).push(outcome);
    return { ...outcome };
  },

  /** P7 跨店方案采纳：收益回写到受益店铺，失败/超时只记 lost。 */
  recordCrossStore: (input: RecordCrossStoreInput): GoalOutcome => {
    const outcome: GoalOutcome = {
      id: nextOutcomeId++,
      storeId: input.storeId,
      cycleId: input.cycleId,
      proposalId: 0,
      agentType: input.agentType,
      action: input.action,
      targetLabel: input.targetLabel,
      metric: input.metric,
      expectedImpact: input.expectedImpact,
      status: input.status,
      executionStatus: input.executionStatus,
      recordedAt: new Date().toISOString(),
    };
    if (outcome.status === 'realized') realize(outcome);
    listOf(input.storeId).push(outcome);
    return { ...outcome };
  },

  /**
   * S1 首启闭环：开店引导里的首个审批没有经营周期，先在这里挂账。
   * 审批通过后由 realizeByApproval 回写目标进度，拒绝则 discardByApproval 标记未回写，
   * 避免“批准完什么都没发生”的断链。
   */
  recordForApproval: (input: {
    storeId: AllMallId;
    approvalId: AllMallId;
    agentType: AgentType;
    action: ProposalAction;
    targetLabel: string;
    metric: GoalMetric;
    expectedImpact: number;
  }): GoalOutcome => {
    const outcome: GoalOutcome = {
      id: nextOutcomeId++,
      storeId: input.storeId,
      cycleId: 0,
      proposalId: 0,
      approvalId: input.approvalId,
      agentType: input.agentType,
      action: input.action,
      targetLabel: input.targetLabel,
      metric: input.metric,
      expectedImpact: input.expectedImpact,
      status: 'projected',
      recordedAt: new Date().toISOString(),
    };
    listOf(input.storeId).push(outcome);
    return { ...outcome };
  },

  /** 审批通过后回写（只有由经营周期产生的审批单才有对应记录）。 */
  realizeByApproval: (approvalId: AllMallId): GoalOutcome | undefined => {
    for (const list of outcomes.values()) {
      const outcome = list.find((item) => item.approvalId === approvalId);
      if (!outcome) continue;
      if (outcome.status === 'projected') realize(outcome);
      return { ...outcome };
    }
    return undefined;
  },

  /** 审批拒绝 → 标记为未回写，不污染目标进度。 */
  discardByApproval: (approvalId: AllMallId): GoalOutcome | undefined => {
    for (const list of outcomes.values()) {
      const outcome = list.find((item) => item.approvalId === approvalId);
      if (!outcome) continue;
      if (outcome.status === 'projected') {
        outcome.status = 'lost';
        recordAudit(outcome, '动作效果未回写', `${outcome.targetLabel} 审批未通过，效果未计入目标进度`);
      }
      return { ...outcome };
    }
    return undefined;
  },
};

/** 刷新持久化：归因回写结果与自增 id 必须保留，否则刷新后目标进度回退、id 重复。 */
registerMockState(
  'outcomes',
  () => ({
    outcomes: [...outcomes.entries()],
    nextOutcomeId,
    seededHistory: [...seededHistory],
  }),
  (value) => {
    const data = value as
      | { outcomes?: [AllMallId, GoalOutcome[]][]; nextOutcomeId?: number; seededHistory?: AllMallId[] }
      | null;
    if (!data) return;
    outcomes.clear();
    (data.outcomes ?? []).forEach(([storeId, list]) => outcomes.set(storeId, list));
    if (typeof data.nextOutcomeId === 'number') nextOutcomeId = data.nextOutcomeId;
    seededHistory.clear();
    (data.seededHistory ?? []).forEach((storeId) => seededHistory.add(storeId));
  },
);
