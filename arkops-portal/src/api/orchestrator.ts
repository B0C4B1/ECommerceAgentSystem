/**
 * File: orchestrator.ts
 * Purpose: P2 编排层 — 经营周期（Observe → Diagnose → Propose → Arbitrate → Execute）
 * 与跨 Agent 冲突仲裁。
 *
 * 为什么需要这一层：P1 解决了“单个动作要不要审批”，但多个 Agent 会同时对一个商品
 * 给出相反动作（提价 vs 折扣），或各自加预算导致超池。没有仲裁时，商家只会收到一堆
 * 互相矛盾的待办。本文件是唯一仲裁入口：先按店铺目标优先级，再按经营护栏，
 * 最后按预期贡献决定谁执行、谁被拦截/延后。
 */
import dayjs from 'dayjs';
import { mockDelay } from './client';
import { agentsApi } from './agents';
import { agentProfilesApi, AGENT_TYPE_DOMAIN, isSpecialized, SPECIALIZED_BOOST } from './agentProfiles';
import { approvalsApi, expireDueApprovals, type ApprovalCreateResult } from './approvals';
import { exceptionsApi, type ExceptionItem } from './exceptions';
import { inventoryApi } from './inventory';
import { stores } from './mockData';
import { registerMockState } from './mockPersistence';
import { AD_SPENT_RATIO, guardBlockKind, GUARD_TEMPLATE, operatingModelApi, resolveApprovalRequirement } from './operatingModel';
import { ensureHistory, getOutcomes, getWeekStart, outcomesApi } from './outcomes';
import type {
  AgentCollaboration,
  AgentType,
  AllMallId,
  ArbitrationDecision,
  ArbitrationReason,
  CollaborationKind,
  CollaborationStatus,
  ConflictResolution,
  ConflictType,
  CycleProposal,
  CycleTrigger,
  GoalMetric,
  GoalOutcome,
  GuardBlockKind,
  GuardExpiry,
  InventoryItem,
  OperatingCycle,
  OperatingPolicy,
  ProposalAction,
  StoreGoal,
  StoreGuards,
} from '../types/domain';

/** P30.1 超时默认的执行者标识：与“当前用户”区分，人在处理记录里能看出这条不是自己点的。 */
const AGENT_TIMEOUT_ACTOR = 'Agent（超时默认）';
/** P30.3 决策规则的执行者标识：结论来自人的规则，但这一条不是人当场点的。 */
const AGENT_RULE_ACTOR = 'Agent（决策规则）';

const cycles = new Map<AllMallId, OperatingCycle>();

/**
 * P8 裁决规则沉淀：方向冲突被人工改判后记住偏好，
 * 下一轮仲裁直接按该方向，不再把同一个选择题重复丢回给人。
 */
const directionPreferences = new Map<AllMallId, 'raise' | 'discount'>();

function cycleIdOf(storeId: AllMallId) {
  return storeId * 10 + 1;
}

function cloneCycle(cycle: OperatingCycle): OperatingCycle {
  return {
    ...cycle,
    diagnosis: { ...cycle.diagnosis },
    proposals: cycle.proposals.map((p) => ({ ...p })),
    conflicts: cycle.conflicts.map((c) => ({ ...c, loserProposalIds: [...c.loserProposalIds], detail: { ...c.detail } })),
    collaborations: (cycle.collaborations ?? []).map((c) => ({
      ...c,
      memberAgents: [...c.memberAgents],
      proposalIds: [...c.proposalIds],
      sequence: [...c.sequence],
    })),
    outcomes: cycle.outcomes.map((o) => ({ ...o })),
  };
}

/** 本轮候选提案 — 覆盖定价、促销、广告、库存四类动作，固定种子保证可复现。 */
function buildProposals(cycleId: AllMallId): CycleProposal[] {
  const base = { cycleId, status: 'pending' as const };
  return [
    {
      ...base,
      id: cycleId * 100 + 1,
      agentType: 'pricing_strategy',
      scenarioKey: 'pricing_promo',
      action: 'raise_price',
      targetLabel: 'SKU-A-102 · 轻羽防晒衣',
      before: '¥86',
      after: '¥92',
      expectedImpact: 3200,
      cost: 0,
      riskLevel: 'low',
    },
    {
      ...base,
      id: cycleId * 100 + 2,
      agentType: 'promotion_campaign',
      scenarioKey: 'pricing_promo',
      action: 'increase_discount',
      targetLabel: 'SKU-A-102 · 轻羽防晒衣',
      before: '无折扣',
      after: '满 199 减 15',
      expectedImpact: 1800,
      cost: 1200,
      riskLevel: 'medium',
      projectedGrossMargin: 24,
    },
    {
      ...base,
      id: cycleId * 100 + 3,
      agentType: 'ads_optimizer',
      scenarioKey: 'pricing_promo',
      action: 'increase_ad_budget',
      targetLabel: '店铺 · 全站推广',
      before: '日预算 ¥500',
      after: '日预算 ¥800',
      expectedImpact: 5200,
      cost: 9000,
      riskLevel: 'medium',
    },
    {
      ...base,
      id: cycleId * 100 + 4,
      agentType: 'inventory_alert',
      scenarioKey: 'inventory',
      action: 'replenish_stock',
      targetLabel: 'SKU-C-205 · 云感凉席',
      before: '库存 26 件',
      after: '补货 200 件',
      expectedImpact: 1200,
      cost: 0,
      riskLevel: 'low',
    },
    {
      ...base,
      id: cycleId * 100 + 5,
      agentType: 'promotion_campaign',
      scenarioKey: 'pricing_promo',
      action: 'clear_stock',
      targetLabel: 'SKU-E-318 · 冰丝坐垫（滞销）',
      before: '库存 480 件',
      after: '7 折清仓',
      expectedImpact: 4200,
      cost: 3600,
      riskLevel: 'medium',
      projectedGrossMargin: 16,
      discountPct: 30,
    },
  ];
}

/**
 * 冲突仲裁：目标优先级 > 经营护栏 > 预期贡献。
 * 直接在提案上写入 selected / blocked / deferred，并返回可解释的冲突记录。
 */
function arbitrate(
  proposals: CycleProposal[],
  goal: StoreGoal,
  policy: StoreGuards & { budgetPool: OperatingPolicy['budgetPool'] },
  cycleId: AllMallId,
  shortageCount: number,
  preferredDirection?: 'raise' | 'discount',
): ConflictResolution[] {
  const conflicts: ConflictResolution[] = [];
  const byAction = (...actions: CycleProposal['action'][]) => proposals.filter((p) => actions.includes(p.action));

  // 1) 方向冲突：同一目标既有提价又有折扣/清仓 → 按已沉淀偏好或目标优先级二选一
  const priceRaises = byAction('raise_price', 'cut_price');
  const discounts = byAction('increase_discount', 'clear_stock');
  for (const raiser of priceRaises) {
    const rival = discounts.find((d) => d.targetLabel === raiser.targetLabel);
    if (!rival) continue;
    const discountWins = preferredDirection
      ? preferredDirection === 'discount'
      : goal.priority === 'clearance';
    const winner = discountWins ? rival : raiser;
    const loser = discountWins ? raiser : rival;
    winner.status = 'selected';
    loser.status = 'blocked';
    conflicts.push({
      id: cycleId * 10 + conflicts.length + 1,
      type: 'direction',
      targetLabel: raiser.targetLabel,
      winnerProposalId: winner.id,
      loserProposalIds: [loser.id],
      basis: 'goal_priority',
      detail: { priority: goal.priority, preferredDirection },
    });
  }

  // 2) 毛利 / 折扣上限护栏：判定收口在 guardBlockKind，预演与仲裁共用，避免口径漂移。
  for (const proposal of discounts) {
    if (proposal.status === 'blocked') continue;
    const kind = guardBlockKind(proposal, goal.constraints, policy.budgetPool, goal.priority);
    if (kind === 'margin') {
      proposal.status = 'blocked';
      conflicts.push({
        id: cycleId * 10 + conflicts.length + 1,
        type: 'margin',
        targetLabel: proposal.targetLabel,
        loserProposalIds: [proposal.id],
        basis: 'guardrail',
        detail: {
          projectedMargin: proposal.projectedGrossMargin ?? 0,
          minMargin: goal.constraints.minGrossMargin,
        },
      });
    } else if (kind === 'discount_cap') {
      proposal.status = 'blocked';
      conflicts.push({
        id: cycleId * 10 + conflicts.length + 1,
        type: 'discount_cap',
        targetLabel: proposal.targetLabel,
        loserProposalIds: [proposal.id],
        basis: 'guardrail',
        detail: {
          discountPct: proposal.discountPct ?? 0,
          maxDiscountPct: goal.constraints.maxDiscountPct,
        },
      });
    }
  }

  // 3) 预算护栏：广告增量超过本月剩余预算 → 延后；月度上限取目标里的营销预算上限。
  const monthlyCap = Math.min(policy.budgetPool.adMonthly, goal.constraints.monthlyBudgetCap);
  const remainingBudget = Math.round(monthlyCap * (1 - AD_SPENT_RATIO));
  const adProposal = byAction('increase_ad_budget')[0];
  if (
    adProposal &&
    guardBlockKind(adProposal, goal.constraints, policy.budgetPool, goal.priority) === 'budget'
  ) {
    adProposal.status = 'deferred';
    conflicts.push({
      id: cycleId * 10 + conflicts.length + 1,
      type: 'budget',
      targetLabel: adProposal.targetLabel,
      loserProposalIds: [adProposal.id],
      basis: 'guardrail',
      detail: { remainingBudget, requiredBudget: adProposal.cost },
    });
  }

  // 4) 其余无冲突提案按预期贡献排序后进入待执行
  for (const proposal of proposals) {
    if (proposal.status === 'pending') proposal.status = 'selected';
  }

  // 5) 依赖门控：店铺仍有 SKU 低于安全库存，而补货动作没能进入执行 → 加投延后。
  //    否则广告会把缺货款卖爆，单个 Agent 看起来都对，合起来是负收益。
  const restockProposal = byAction('replenish_stock')[0];
  if (
    adProposal &&
    adProposal.status === 'selected' &&
    shortageCount > 0 &&
    restockProposal?.status !== 'selected'
  ) {
    adProposal.status = 'deferred';
    conflicts.push({
      id: cycleId * 10 + conflicts.length + 1,
      type: 'dependency',
      targetLabel: adProposal.targetLabel,
      winnerProposalId: restockProposal?.id,
      loserProposalIds: [adProposal.id],
      basis: 'guardrail',
      detail: { shortageCount },
    });
  }

  // 6) 重复计益：同一目标存在两条同向折扣动作时，只保留贡献更高的一条。
  const discountLike = proposals.filter(
    (proposal) =>
      proposal.status === 'selected' &&
      (proposal.action === 'increase_discount' || proposal.action === 'clear_stock'),
  );
  const discountByTarget = new Map<string, CycleProposal[]>();
  discountLike.forEach((proposal) => {
    discountByTarget.set(proposal.targetLabel, [
      ...(discountByTarget.get(proposal.targetLabel) ?? []),
      proposal,
    ]);
  });
  discountByTarget.forEach((bucket, targetLabel) => {
    if (bucket.length < 2) return;
    const [keep, ...duplicates] = [...bucket].sort((a, b) => b.expectedImpact - a.expectedImpact);
    duplicates.forEach((duplicate) => {
      duplicate.status = 'deferred';
      conflicts.push({
        id: cycleId * 10 + conflicts.length + 1,
        type: 'double_count',
        targetLabel,
        winnerProposalId: keep.id,
        loserProposalIds: [duplicate.id],
        basis: 'guardrail',
        detail: { duplicateImpact: duplicate.expectedImpact },
      });
    });
  });

  proposals.sort((a, b) => b.expectedImpact - a.expectedImpact);

  return conflicts;
}

/**
 * P5/P8 多 Agent 协同：把互补动作编成协同组。
 * 只做“有先后依赖、合起来收益更大”的组合，避免为了展示强行拼组：
 * - P8 三链：补货 → 提价 → 加投，先补货保供给、再提价抬客单、最后加投放量；
 * - 降级二链：补货 + 加投，或提价 + 加投。
 * 同一广告提案只进入一个协同组，避免跨组重复计益。
 */
function buildCollaborations(
  proposals: CycleProposal[],
  cycleId: AllMallId,
): AgentCollaboration[] {
  const byAction = (...actions: CycleProposal['action'][]) =>
    proposals.find((proposal) => actions.includes(proposal.action));
  const restock = byAction('replenish_stock');
  const ad = byAction('increase_ad_budget');
  const priceRaise = byAction('raise_price', 'cut_price');
  const groups: AgentCollaboration[] = [];

  const addGroup = (
    kind: CollaborationKind,
    leadAgent: CycleProposal['agentType'],
    members: CycleProposal[],
    sequence: CycleProposal[],
    factor: number,
  ) => {
    const executableCount = members.filter((member) => member.status === 'selected').length;
    const submittedCount = members.filter((member) => member.status === 'submitted').length;
    const status: CollaborationStatus =
      submittedCount === members.length
        ? 'done'
        : executableCount === members.length
          ? 'ready'
          : executableCount > 0 || submittedCount > 0
            ? 'partial'
            : 'blocked';
    const impactBase = members
      .filter((member) => member.status === 'selected' || member.status === 'submitted')
      .reduce((sum, member) => sum + member.expectedImpact, 0);
    const fullyFormed = status === 'ready' || status === 'done';
    groups.push({
      id: cycleId * 10 + 100 + groups.length,
      kind,
      leadAgent,
      memberAgents: members.map((member) => member.agentType),
      proposalIds: members.map((member) => member.id),
      sequence: sequence.map((member) => member.id),
      combinedImpact: Math.round(impactBase * (fullyFormed ? factor : 1)),
      factor,
      status,
      executableCount,
      memberCount: members.length,
    });
  };

  // P8：三链成立时优先展示完整编排，提价被方向仲裁拦下时退回二链。
  if (restock && priceRaise && ad && priceRaise.status !== 'blocked') {
    addGroup(
      'restock_price_ads',
      'inventory_alert',
      [restock, priceRaise, ad],
      [restock, priceRaise, ad],
      1.08,
    );
  } else if (restock && ad) {
    addGroup('restock_ads', 'inventory_alert', [restock, ad], [restock, ad], 1.06);
  } else if (priceRaise && ad) {
    addGroup('price_ads', 'pricing_strategy', [priceRaise, ad], [priceRaise, ad], 1.05);
  }

  return groups;
}

/** P3.5 多店铺经营概览行 — 把每个店铺的目标、周回写与周期状态汇总成一行。 */
export interface StorePortfolioRow {
  storeId: AllMallId;
  goal: StoreGoal;
  gapPct: number;
  /** 本周（周一 00:00 起）已回写效果 */
  attributedThisWeek: number;
  /** 上周已回写效果，用于环比 */
  attributedLastWeek: number;
  /** 本周已回写动作数 */
  realizedThisWeek: number;
  /** 待审批后回写数 */
  pendingCount: number;
  proposalCount: number;
  hasCycle: boolean;
}

/** P4 跨店冲突类型：共享预算争抢 / 同款跨店价格方向不一致 / 同款库存跨店失衡。 */
export type CrossStoreConflictType = 'budget' | 'price_direction' | 'inventory';

export interface CrossStoreConflict {
  id: string;
  type: CrossStoreConflictType;
  targetLabel: string;
  /** 仲裁胜出方：预算为获配店铺；库存为缺货、需要补给的店铺 */
  winnerStoreIds: AllMallId[];
  /** 被延后 / 需要让出库存的店铺 */
  loserStoreIds: AllMallId[];
  basis: 'goal_priority' | 'stock_guardrail';
  detail: {
    remainingBudget?: number;
    requestedBudget?: number;
    allocatedBudget?: number;
    skuCode?: string;
    shortageStock?: number;
    surplusStock?: number;
    safetyStock?: number;
    suggestedTransfer?: number;
    /** 价格方向冲突：参与提价 / 折扣的店铺，用于生成可采纳的统一价盘方案 */
    raiseStoreIds?: AllMallId[];
    discountStoreIds?: AllMallId[];
    /** 统一价盘方向：提价或折扣 */
    direction?: 'raise' | 'discount';
  };
}

export interface CrossStoreArbitration {
  sharedAdBudget: { available: number; requested: number; allocated: number };
  conflicts: CrossStoreConflict[];
  /** P7 跨店协同方案：每个冲突给出一个可采纳的决定，而不是只提示冲突 */
  plans: CrossStorePlan[];
}

// ===== P7 跨店协同与升级闭环 =====

export type CrossStorePlanKind = 'shared_budget' | 'price_align' | 'stock_transfer';
export type CrossStorePlanStatus = 'suggested' | 'accepted' | 'dismissed';

/**
 * 跨店协同方案：把账户级冲突收敛成一个“人只需要点头或拒绝”的决定。
 * 采纳后写回受益店铺的目标进度，并关闭收件箱里的对应升级项。
 */
export interface CrossStorePlan {
  id: string;
  kind: CrossStorePlanKind;
  /** 来源冲突 id */
  conflictId: string;
  targetLabel: string;
  /** 收益归属店铺：预算获配店 / 价格方向主导店 / 缺货补给店 */
  ownerStoreId: AllMallId;
  /** 配合店铺：预算延后店 / 价格跟随店 / 让出库存店 */
  partnerStoreIds: AllMallId[];
  leadAgent: AgentType;
  /** 采纳后按哪个动作回写收益 */
  action: ProposalAction;
  metric: GoalMetric;
  /** 预计回写到 owner 目标的贡献 */
  expectedImpact: number;
  cost: number;
  detail: CrossStoreConflict['detail'];
  status: CrossStorePlanStatus;
  acceptedAt?: string;
  /** P9 可追溯：谁采纳了该跨店方案 */
  acceptedBy?: string;
  executionStatus?: ExecutionStatus;
}

/** 账户级共享广告预算剩余（Mock）— 与单店预算分开，用于演示多店争抢。 */
const SHARED_AD_POOL_REMAINING = 12000;

interface CrossStoreEntry {
  storeId: AllMallId;
  goal: StoreGoal;
  proposals: CycleProposal[];
  gapPct: number;
}

/** 跨店方案的人为状态（采纳/忽略）；其余字段每次都从当前冲突重新推导。 */
const crossStorePlanStates = new Map<
  string,
  {
    status: CrossStorePlanStatus;
    acceptedAt?: string;
    acceptedBy?: string;
    executionStatus?: ExecutionStatus;
  }
>();

/** 稳定哈希：同一方案每次得到相同执行结果，避免刷新后成功/失败跳变。 */
function stableHash(value: string): number {
  let hash = 7;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100003;
  }
  return hash;
}

function simulateCrossStoreExecution(planId: string): ExecutionStatus {
  const seed = stableHash(planId) % 100;
  if (seed >= 96) return 'failed';
  if (seed >= 84) return 'timeout';
  return 'succeeded';
}

/**
 * 跨店冲突 → 可采纳方案。一个冲突只给一个决定，避免把选择题又丢回给人：
 * - 共享预算：按目标差距把预算给差距最大的店，其余店本轮延后；
 * - 价格方向：清库存店存在时统一走折扣，否则统一走提价；
 * - 共享库存：从富余店调拨到缺货店，补足安全库存 + 约 3 天销量。
 */
function buildCrossStorePlans(
  conflicts: CrossStoreConflict[],
  entries: CrossStoreEntry[],
): CrossStorePlan[] {
  const entryOf = (storeId: AllMallId) => entries.find((entry) => entry.storeId === storeId);
  const proposalsOf = (storeId: AllMallId) => entryOf(storeId)?.proposals ?? [];
  const plans: CrossStorePlan[] = [];

  conflicts.forEach((conflict) => {
    if (conflict.type === 'budget') {
      const ownerStoreId = conflict.winnerStoreIds[0];
      if (ownerStoreId === undefined) return;
      const ad = proposalsOf(ownerStoreId).find(
        (proposal) => proposal.action === 'increase_ad_budget',
      );
      plans.push({
        id: 'cross-plan-budget',
        kind: 'shared_budget',
        conflictId: conflict.id,
        targetLabel: conflict.targetLabel,
        ownerStoreId,
        partnerStoreIds: conflict.loserStoreIds,
        leadAgent: 'ads_optimizer',
        action: 'increase_ad_budget',
        metric: entryOf(ownerStoreId)?.goal.metric ?? 'gmv',
        expectedImpact: ad?.expectedImpact ?? 0,
        cost: conflict.detail.allocatedBudget ?? ad?.cost ?? 0,
        detail: conflict.detail,
        status: 'suggested',
      });
      return;
    }

    if (conflict.type === 'inventory') {
      const ownerStoreId = conflict.winnerStoreIds[0];
      const partnerStoreId = conflict.loserStoreIds[0];
      if (ownerStoreId === undefined || partnerStoreId === undefined) return;
      const transferQty = conflict.detail.suggestedTransfer ?? 0;
      plans.push({
        id: `cross-plan-stock-${conflict.detail.skuCode ?? conflict.targetLabel}`,
        kind: 'stock_transfer',
        conflictId: conflict.id,
        targetLabel: conflict.targetLabel,
        ownerStoreId,
        partnerStoreIds: [partnerStoreId],
        leadAgent: 'inventory_alert',
        action: 'replenish_stock',
        metric: entryOf(ownerStoreId)?.goal.metric ?? 'gmv',
        // 调拨本身不产生收入，按“避免断货损失的近似毛利”折算，UI 明示为预计回写。
        expectedImpact: Math.round(transferQty * 14),
        cost: 0,
        detail: conflict.detail,
        status: 'suggested',
      });
      return;
    }

    if (conflict.type === 'price_direction') {
      const raiseStoreIds = conflict.detail.raiseStoreIds ?? [];
      const discountStoreIds = conflict.detail.discountStoreIds ?? [];
      const discountWins = discountStoreIds.some(
        (storeId) => entryOf(storeId)?.goal.priority === 'clearance',
      );
      const ownerStoreId = (discountWins ? discountStoreIds : raiseStoreIds)[0];
      if (ownerStoreId === undefined) return;
      const action: ProposalAction = discountWins ? 'increase_discount' : 'raise_price';
      const proposal = proposalsOf(ownerStoreId).find((item) =>
        discountWins
          ? item.action === 'increase_discount' || item.action === 'clear_stock'
          : item.action === 'raise_price' || item.action === 'cut_price',
      );
      plans.push({
        id: `cross-plan-price-${conflict.targetLabel}`,
        kind: 'price_align',
        conflictId: conflict.id,
        targetLabel: conflict.targetLabel,
        ownerStoreId,
        partnerStoreIds: (discountWins ? raiseStoreIds : discountStoreIds).filter(
          (storeId) => storeId !== ownerStoreId,
        ),
        leadAgent: discountWins ? 'promotion_campaign' : 'pricing_strategy',
        action,
        metric: entryOf(ownerStoreId)?.goal.metric ?? 'gmv',
        expectedImpact: proposal?.expectedImpact ?? 0,
        cost: proposal?.cost ?? 0,
        detail: {
          ...conflict.detail,
          direction: discountWins ? 'discount' : 'raise',
        },
        status: 'suggested',
      });
    }
  });

  return plans;
}

function storeNameOf(storeId: AllMallId, storeNames: Record<number, string>): string {
  return storeNames[storeId] ?? `#${storeId}`;
}

/** 跨店方案 → 收件箱升级项：账户级冲突也必须有人拍板，不能只躺在工作台里。 */
function buildCrossStoreEscalation(
  plan: CrossStorePlan,
  storeNames: Record<number, string>,
): ExceptionItem {
  const owner = storeNameOf(plan.ownerStoreId, storeNames);
  const partners = plan.partnerStoreIds
    .map((storeId) => storeNameOf(storeId, storeNames))
    .join('、');
  const base = {
    id: `cross-esc-${plan.id}`,
    type: 'cross_store_escalation' as const,
    storeName: owner,
    agentType: plan.leadAgent,
    level: 'warning' as const,
    createdAt: new Date().toISOString(),
    resolved: false,
    ignored: false,
    // P30.4：跨店方案本身带着「采纳后预计回写多少」，直接作为影响金额，不再另算。
    impact: plan.expectedImpact > 0
      ? { amount: plan.expectedImpact, kind: 'gmv' as const, basis: '跨店方案采纳后预计回写的 GMV 贡献' }
      : undefined,
    linkTo: '/dashboard',
  };

  if (plan.kind === 'shared_budget') {
    return {
      ...base,
      title: `共享预算待拍板 · ${plan.targetLabel}`,
      summary: `账户共享广告预算可用 ¥${plan.detail.remainingBudget ?? 0}，共申请 ¥${plan.detail.requestedBudget ?? 0}；方案优先给「${owner}」，${partners} 本轮延后。`,
      detail: '共享预算池被多家店铺同时争抢，需要确认优先级。',
      suggestedAction: '在待办中心对该方案点击「采纳」或「忽略」；如需扩大共享预算池请调整账户预算。',
    };
  }
  if (plan.kind === 'stock_transfer') {
    return {
      ...base,
      title: `跨店可调拨 ${plan.detail.suggestedTransfer ?? 0} 件 · ${plan.targetLabel}`,
      summary: `「${owner}」仅剩 ${plan.detail.shortageStock ?? 0} 件（安全库存 ${plan.detail.safetyStock ?? 0}），「${partners}」尚有 ${plan.detail.surplusStock ?? 0} 件。`,
      detail: '同款库存跨店失衡，调拨比单独补货更快补足安全库存。',
      suggestedAction: '在待办中心采纳调拨建议，或忽略并确认走采购补货。',
    };
  }
  return {
    ...base,
    title: `跨店价格方向待统一 · ${plan.targetLabel}`,
    summary: `同款商品在不同店铺出现相反价格方向；方案以「${owner}」的方向为准，${partners} 本轮跟随。`,
    detail: '同款跨店价格互相打架会稀释活动效果，需要统一价盘或确认渠道差异。',
    suggestedAction: '在待办中心采纳统一方向，或忽略并确认各渠道允许独立定价。',
  };
}

// ===== P6 自主运转：自动触发 + 升级给人 =====

export interface AutoTriggerConfig {
  enabled: boolean;
  /** 定时触发间隔；到点且没有新事件时才按周期重新诊断 */
  cadenceHours: number;
  /** 自动执行低风险且策略允许自动通过的已选动作，人只处理升级项 */
  autoSubmitLowRisk: boolean;
}

export interface AutoTriggerResult {
  storeId: AllMallId;
  triggered: boolean;
  trigger?: CycleTrigger;
  reason?: 'cadence' | 'stock_alert';
  generatedAt?: string;
  /** 本轮自动提交的低风险动作数 */
  autoSubmitted?: number;
}

/**
 * P35.1 治理自巡检结果：Agent 在巡检里顺手把目标结算、节奏/护栏升级、
 * 超时默认都跑一遍，返回本轮真正发生的变化，供 UI 决定是否刷新。
 */
export interface GovernanceSweepResult {
  /** 本轮巡检覆盖的已连接店铺数。 */
  storeCount: number;
  /** 完成跨月结算的店铺数。 */
  settled: number;
  /** 节奏升级有新建或自动收口的店铺数。 */
  paceChanged: number;
  /** 护栏健康升级有新建或自动收口的店铺数。 */
  guardChanged: number;
  /** 按人的决策规则自动收尾的升级数。 */
  ruleApplied: number;
  /** 按超时默认收尾的升级数。 */
  expiredApplied: number;
  /** P47：临时护栏到期后由 Agent 恢复原值的条数。 */
  guardRestored: number;
  /** P47：到期时发现人已改过、仅清掉过期标记的条数。 */
  guardExpiryCleared: number;
  /** P55.1：护栏到期收回后，Agent 自行按收回边界重排方案的店铺数。 */
  cycleReplanned: number;
  /** P49：账户上期结算待办有新建或自动收口（0/1）。 */
  accountChanged: number;
  /** P51：超过审批时限后由 Agent 按策略收尾/升级的单数。 */
  approvalTimedOut: number;
  /** 是否有任何变化（false 时不打扰人）。 */
  changed: boolean;
}

export type ExecutionStatus = 'succeeded' | 'failed' | 'timeout';

/**
 * 调度真值：把「谁在驱动巡检」显式说出来。
 * - `demo`：浏览器页面内定时器，离开工作台即停（当前纯前端实现只有这一种）。
 * - `live`：后端调度器，页面关闭也继续（接入后端后才可为该值，不得在 Mock 中伪装）。
 */
export type SchedulerMode = 'demo' | 'live';

export interface SchedulerStatus {
  mode: SchedulerMode;
  /** 调度循环当前是否被页面挂载 */
  active: boolean;
  /** 是否真的在巡检：已挂载且心跳未过期 */
  online: boolean;
  lastPatrolAt?: string;
  nextPatrolAt?: string;
  stoppedAt?: string;
  intervalSeconds: number;
  checkedStoreCount: number;
}

const DEFAULT_AUTO_CONFIG: AutoTriggerConfig = {
  enabled: true,
  cadenceHours: 24,
  autoSubmitLowRisk: false,
};
const autoConfigs = new Map<AllMallId, AutoTriggerConfig>();
/** 上次事件触发时的缺货指纹：库存集合没变化就不重复生成周期。 */
const lastShortageFingerprint = new Map<AllMallId, string>();

/** 当前实现只有页面内定时器，因此调度方式恒为演示；接入后端后改这里。 */
const SCHEDULER_MODE: SchedulerMode = 'demo';
const PATROL_INTERVAL_MS = 60_000;
/** 心跳超过 3 个巡检周期视为离线（标签页被冻结/定时器被挂起）。 */
const SCHEDULER_STALE_MS = PATROL_INTERVAL_MS * 3;
const schedulerRuntime: {
  active: boolean;
  lastPatrolAt?: string;
  nextPatrolAt?: string;
  stoppedAt?: string;
  checkedStoreCount: number;
} = { active: false, checkedStoreCount: 0 };

/**
 * 执行结果模拟：真实环境由平台回执决定，这里用稳定种子保证演示可复现。
 * 同一店铺同一动作每次得到相同结果，避免刷新后“成功/失败”随机跳变。
 */
function simulateExecution(proposal: CycleProposal, storeId: AllMallId): ExecutionStatus {
  const seed = (proposal.id * 37 + storeId * 11) % 100;
  if (seed >= 95) return 'failed';
  if (seed >= 80) return 'timeout';
  return 'succeeded';
}

/** 周期生成批次标识 — 用于区分“同一周期被重新生成”前后的升级项。 */
function cycleGeneration(cycle: OperatingCycle): number {
  return cycle.generatedAt ? new Date(cycle.generatedAt).getTime() : 0;
}

/** 冲突 → 收件箱升级项：让被拦截/延后的动作主动找人，而不是等人翻抽屉。 */
function buildConflictEscalation(
  cycle: OperatingCycle,
  storeName: string,
  conflict: ConflictResolution,
): ExceptionItem | null {
  const loser = cycle.proposals.find((proposal) => conflict.loserProposalIds.includes(proposal.id));
  if (!loser) return null;

  // P30.1：护栏类冲突不再是“一段建议 + 去处理”，而是把可选结论和超时默认一起交给人。
  // 默认项永远是维持护栏——超时、误点都不会让 Agent 自行扩大权限。
  // P30.2：截止时间跟随该店铺配置的超时策略，新生成的决策与收件箱口径保持一致。
  const createdAt = new Date();
  const timeoutHours = exceptionsApi.getEscalationPolicy(cycle.storeId).timeoutHours;
  const decisionBase = {
    timeoutHours,
    deadline: new Date(createdAt.getTime() + timeoutHours * 60 * 60 * 1000).toISOString(),
    timeoutOptionId: 'uphold' as const,
  };
  const conflictRef = { storeId: cycle.storeId, conflictId: conflict.id };
  // P30.4：被拦动作的预计 GMV 贡献就是这条升级项的金额影响——
  // 人不用再逐条估算「先处理哪条」，排序读的就是这个数。
  const impact = loser.expectedImpact > 0
    ? {
        amount: loser.expectedImpact,
        kind: 'gmv' as const,
        basis: `被拦动作「${loser.targetLabel}」的预计 GMV 贡献`,
      }
    : undefined;

  const base = {
    // 升级项按“周期 + 生成批次 + 冲突”取 id：同一冲突在新一轮重新出现时仍会再次提醒，
    // 而上一轮已处理的条目不会被复活。
    id: `cycle-esc-${cycle.id}-${cycleGeneration(cycle)}-${conflict.id}`,
    type: 'cycle_escalation' as ExceptionItem['type'],
    storeId: cycle.storeId,
    storeName,
    agentType: loser.agentType,
    createdAt: createdAt.toISOString(),
    resolved: false,
    ignored: false,
    impact,
    linkTo: '/dashboard',
  };

  if (conflict.type === 'dependency') {
    return {
      ...base,
      level: 'critical',
      title: `补货未完成，加投已延后 · ${conflict.targetLabel}`,
      summary: `${conflict.detail.shortageCount ?? 0} 个 SKU 低于安全库存，广告加投被依赖门控延后。`,
      detail: '补货动作未进入执行时加投会放大断货，因此本轮只保留补货。',
      suggestedAction: '确认补货到货或调整安全库存后重新生成本轮方案。',
    };
  }
  if (conflict.type === 'budget') {
    return {
      ...base,
      type: 'decision_request',
      level: 'warning',
      title: `预算不足，加投已延后 · ${conflict.targetLabel}`,
      summary: `本月剩余广告预算 ¥${conflict.detail.remainingBudget ?? 0}，低于本次需要的 ¥${conflict.detail.requiredBudget ?? 0}。`,
      detail: '预算池护栏拦截了本轮加投。',
      suggestedAction: '提高广告月预算池，或等下一预算周期再执行。',
      conflictRef,
      decisionKind: 'budget',
      decision: {
        question: `「${conflict.targetLabel}」需要广告预算 ¥${conflict.detail.requiredBudget ?? 0}，本月剩余 ¥${conflict.detail.remainingBudget ?? 0}。本轮是否放行？`,
        options: [
          {
            id: 'uphold',
            label: '维持预算池',
            consequence: '本轮放弃该加投，剩余预算留给其他动作；可等下一预算周期再执行。',
            recommended: true,
          },
          {
            id: 'override',
            label: '放行一次',
            consequence: `占用本月剩余预算 ¥${conflict.detail.remainingBudget ?? 0} 中的 ¥${conflict.detail.requiredBudget ?? 0}，可能挤占本轮其他动作；仅本次生效。`,
          },
          {
            id: 'adjust_guard',
            label: '调预算池',
            consequence: '不改本轮结论，跳到经营总览上调广告月预算池后重新生成方案。',
          },
        ],
        ...decisionBase,
      },
    };
  }
  if (conflict.type === 'margin') {
    return {
      ...base,
      type: 'decision_request',
      level: 'warning',
      title: `毛利护栏拦截 · ${conflict.targetLabel}`,
      summary: `执行后预计毛利率 ${conflict.detail.projectedMargin ?? 0}%，低于下限 ${conflict.detail.minMargin ?? 0}%。`,
      detail: '折扣会击穿毛利下限。',
      suggestedAction: '缩小折扣力度，或把店铺目标切换为清库存。',
      conflictRef,
      decisionKind: 'margin',
      decision: {
        question: `「${conflict.targetLabel}」执行后毛利率将降到 ${conflict.detail.projectedMargin ?? 0}%，低于店铺护栏 ${conflict.detail.minMargin ?? 0}%。本轮是否放行？`,
        options: [
          {
            id: 'uphold',
            label: '维持护栏',
            consequence: '本轮放弃该动作，毛利率保持在护栏之上；方案保留，可缩小折扣力度后重新生成。',
            recommended: true,
          },
          {
            id: 'override',
            label: '放行一次',
            consequence: `该商品本轮按 ${conflict.detail.projectedMargin ?? 0}% 毛利执行（护栏 ${conflict.detail.minMargin ?? 0}%），仅本商品本次生效。`,
          },
          {
            id: 'adjust_guard',
            label: '先改护栏',
            consequence: '不改本轮结论，跳到经营总览调整毛利下限后重新生成方案。',
          },
        ],
        ...decisionBase,
      },
    };
  }
  if (conflict.type === 'discount_cap') {
    return {
      ...base,
      type: 'decision_request',
      level: 'warning',
      title: `折扣超过上限 · ${conflict.targetLabel}`,
      summary: `本次折扣 ${conflict.detail.discountPct ?? 0}%，超过店铺允许的 ${conflict.detail.maxDiscountPct ?? 0}%。`,
      detail: '折扣上限护栏拦截了该动作。',
      suggestedAction: '收窄折扣力度，或到目标卡上调折扣上限后重新生成方案。',
      conflictRef,
      decisionKind: 'discount_cap',
      decision: {
        question: `「${conflict.targetLabel}」本次折扣 ${conflict.detail.discountPct ?? 0}%，超过店铺上限 ${conflict.detail.maxDiscountPct ?? 0}%。本轮是否放行？`,
        options: [
          {
            id: 'uphold',
            label: '维持上限',
            consequence: '本轮放弃该折扣，折扣上限不变；可收窄力度后重新生成方案。',
            recommended: true,
          },
          {
            id: 'override',
            label: '放行一次',
            consequence: `该商品本轮按 ${conflict.detail.discountPct ?? 0}% 折扣执行（上限 ${conflict.detail.maxDiscountPct ?? 0}%），仅本次生效。`,
          },
          {
            id: 'adjust_guard',
            label: '先改上限',
            consequence: '不改本轮结论，跳到经营总览上调折扣上限后重新生成方案。',
          },
        ],
        ...decisionBase,
      },
    };
  }
  if (conflict.type === 'double_count') {
    return {
      ...base,
      level: 'info',
      title: `重复计益已合并 · ${conflict.targetLabel}`,
      summary: `同一目标有两条折扣动作，已排除重复计入的 ¥${conflict.detail.duplicateImpact ?? 0} 收益。`,
      detail: '仅保留预期贡献更高的一条折扣动作。',
      suggestedAction: '如需同时执行两条折扣，请合并为一个促销活动。',
    };
  }
  return {
    ...base,
    level: 'warning',
    title: `动作方向冲突 · ${conflict.targetLabel}`,
    summary: '提价与折扣同时命中同一商品，已按目标优先级二选一。',
    detail: '方向相反的动作不应同时执行。',
    suggestedAction: '确认本店当前目标是增长还是清库存。',
  };
}

async function escalateCycle(cycle: OperatingCycle, storeName: string): Promise<void> {
  // 重新诊断后仍存在的冲突继续提醒；已消失的冲突把旧升级项关掉，避免收件箱堆积过期项。
  const activeIds = new Set<string>();
  for (const conflict of cycle.conflicts) {
    const item = buildConflictEscalation(cycle, storeName, conflict);
    if (item) {
      activeIds.add(item.id);
      await exceptionsApi.upsertEscalation(item);
    }
  }
  const prefix = `cycle-esc-${cycle.id}-`;
  const stale = (await exceptionsApi.list())
    .filter(
      (item) =>
        item.id.startsWith(prefix) &&
        !item.resolved &&
        !item.ignored &&
        !activeIds.has(item.id),
    )
    .map((item) => item.id);
  if (stale.length > 0) await exceptionsApi.batchResolve(stale);
}

async function escalateExecutionFailure(
  cycle: OperatingCycle,
  storeName: string,
  proposal: CycleProposal,
  status: Exclude<ExecutionStatus, 'succeeded'>,
): Promise<void> {
  await exceptionsApi.upsertEscalation({
    // S3：带上生成批次，重复失败才会重新提醒；末尾仍保留提案 id 便于定位。
    id: `cycle-exec-${cycle.id}-${cycleGeneration(cycle)}-${proposal.id}`,
    type: 'cycle_escalation',
    storeId: cycle.storeId,
    storeName,
    agentType: proposal.agentType,
    level: status === 'failed' ? 'critical' : 'warning',
    title: `${status === 'failed' ? '执行失败' : '执行超时'} · ${proposal.targetLabel}`,
    summary: `${proposal.before} → ${proposal.after} 未拿到平台成功回执，本轮效果未计入目标进度。`,
    detail: 'Agent 已停止重试，避免重复扣预算或重复改价。',
    suggestedAction: '到对应平台确认动作是否生效；若未生效，请在重新生成方案后再次提交。',
    // P30.4：执行没拿到回执 = 这笔预计收益暂时没进目标进度，金额可量化。
    impact: proposal.expectedImpact > 0
      ? { amount: proposal.expectedImpact, kind: 'gmv' as const, basis: '执行未回写，本轮预计 GMV 贡献未计入' }
      : undefined,
    createdAt: new Date().toISOString(),
    resolved: false,
    ignored: false,
    linkTo: '/dashboard',
  });
}

const ARBITRATION_REASON_NOTE: Record<ArbitrationReason, string> = {
  goal_priority: '目标优先级',
  protect_margin: '保护毛利',
  protect_stock: '保护库存',
  platform_recommendation: '平台建议',
  manual: '人工判断',
};

/** P8 改判：把人的决定落到提案状态上，并把方向偏好沉淀给下一轮仲裁。 */
function applyConflictOverride(cycle: OperatingCycle, conflict: ConflictResolution): void {
  const winner = cycle.proposals.find((proposal) => proposal.id === conflict.winnerProposalId);
  const loser = cycle.proposals.find(
    (proposal) => proposal.id === conflict.loserProposalIds[0],
  );
  if (conflict.type === 'direction') {
    if (!winner || !loser) return;
    winner.status = 'blocked';
    loser.status = 'selected';
    conflict.winnerProposalId = loser.id;
    conflict.loserProposalIds = [winner.id];
    directionPreferences.set(
      cycle.storeId,
      loser.action === 'increase_discount' || loser.action === 'clear_stock' ? 'discount' : 'raise',
    );
    return;
  }
  // 其余冲突改判即放行被拦下的动作；已提交的动作不回滚。
  if (loser && loser.status !== 'submitted') loser.status = 'selected';
}

/**
 * P12 自动执行低风险动作：只提交“已选 + 低风险 + 策略允许自动通过”的提案。
 * 返回提交数量；单个失败不阻断其余动作，失败回执会单独升级到收件箱。
 */
async function submitSelectedLowRisk(storeId: AllMallId, storeName: string): Promise<number> {
  // P30.6 人工接管：Agent 只出方案，不再自动执行；提案仍在，由人逐条手动提交。
  if (exceptionsApi.isStoreTakenOver(storeId)) return 0;
  const cycle = cycles.get(storeId);
  if (!cycle) return 0;
  // 协同链有先后依赖（如先补货再加投）：前一步没提交成功时，后一步不能自动执行。
  const prerequisites = new Map<AllMallId, AllMallId[]>();
  (cycle.collaborations ?? []).forEach((group) => {
    group.sequence.forEach((proposalId, index) => {
      prerequisites.set(proposalId, group.sequence.slice(0, index));
    });
  });
  const byId = new Map(cycle.proposals.map((proposal) => [proposal.id, proposal]));
  const candidates = cycle.proposals.filter(
    (proposal) =>
      proposal.status === 'selected' &&
      proposal.riskLevel === 'low' &&
      resolveApprovalRequirement(storeId, proposal.agentType, proposal.riskLevel) === 'auto',
  );
  // 同一条链上的多个动作按链路顺序提交，不能因为收益高就先跑第二步。
  const sequenceRank = new Map<AllMallId, number>();
  (cycle.collaborations ?? []).forEach((group) => {
    group.sequence.forEach((proposalId, index) => sequenceRank.set(proposalId, index));
  });
  candidates.sort(
    (a, b) => (sequenceRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (sequenceRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  let submitted = 0;
  for (const proposal of candidates) {
    // 前一步没提交成功（需审批 / 被拦）时，链上的后续动作本轮不自动执行。
    const blockedBySequence = !(prerequisites.get(proposal.id) ?? []).every(
      (proposalId) => byId.get(proposalId)?.status === 'submitted',
    );
    if (blockedBySequence) continue;
    try {
      await orchestratorApi.submitProposal(storeId, storeName, proposal.id);
      submitted += 1;
    } catch {
      // 提交失败不阻断整轮自动执行。
    }
  }
  if (submitted > 0) {
    cycle.collaborations = buildCollaborations(cycle.proposals, cycle.id);
  }
  return submitted;
}

/** P29.4 预演里的一条受影响动作：只列因可编辑护栏而放开/多拦的提案。 */
export interface GuardImpactItem {
  proposalId: AllMallId;
  targetLabel: string;
  action: ProposalAction;
  reason: GuardBlockKind;
  expectedImpact: number;
  projectedGrossMargin?: number;
}

/** P29.4 护栏影响预演结果：过去 7 天的拦截次数 + 按本轮方案推演的 GMV / 毛利变化。 */
export interface GuardImpactPreview {
  storeId: AllMallId;
  windowDays: number;
  pastBlocks: { total: number; margin: number; discount: number; budget: number };
  hasCycle: boolean;
  unlocked: GuardImpactItem[];
  blocked: GuardImpactItem[];
  gmvDelta: number;
  grossProfitDelta: number;
}

/** P32.1 护栏体检结论：这条护栏现在对 Agent 是否真的构成约束。 */
export type GuardHealthVerdict = 'binding' | 'close' | 'idle' | 'no_data';

export type GuardHealthKey = 'minGrossMargin' | 'maxDiscountPct' | 'monthlyBudgetCap';

/**
 * P32.2 建议值的依据口径。人只需要认可或否掉一个数，不必自己反推该往哪调。
 * unlock/tighten 会给出具体建议值；其余都是「建议维持」的原因。
 */
export type GuardAdviceBasis =
  | 'unlock'
  | 'tighten'
  | 'hold_close'
  | 'hold_no_data'
  | 'hold_pool_bound'
  | 'hold_step_far'
  | 'hold_no_effect';

/** P32.2 单条护栏的 Agent 建议：值 + 依据 + 带入后按本轮方案预演的影响。 */
export interface GuardAdvice {
  basis: GuardAdviceBasis;
  /** 建议值；null 表示建议维持当前值。 */
  suggested: number | null;
  /** 相对当前值的变化量（与护栏单位一致），维持时为 0。 */
  delta: number;
  /** 本轮被这条护栏拦下、可能因此放开的动作数。 */
  blockedActions: number;
  /** 建议锚定的动作取值：毛利 / 折扣为动作的百分比，预算为这次加投需要的月度上限。 */
  anchor?: number;
  /** 预算护栏专用：真正的卡点是广告月预算池，不是人设的上限。 */
  poolLimit?: number;
  /** 按本轮方案预演：带入建议值后放开 / 多拦几条、GMV 与毛利怎么变。 */
  effect?: { unlocked: number; blocked: number; gmvDelta: number; grossProfitDelta: number };
}

/** P32.1 单条护栏的体检结果；数值与结论分开，文案在 UI 侧按 i18n 组装。 */
export interface GuardHealthItem {
  key: GuardHealthKey;
  current: number;
  /** 近 7 天因这条护栏被拦下的升级项数量（含已处理的历史）。 */
  blocks7d: number;
  /** P32.3 近 30 天拦截次数：判断「长期高频拦截」只看这个窗口，避免一次巡检波动就打扰人。 */
  blocks30d: number;
  /** 离生效最近的动作取值：毛利 / 折扣为百分比，预算为当前预算池总额。 */
  nearest: number | null;
  /** 余量：毛利 / 折扣为百分点，预算为「上限 − 预算池」的差额。 */
  headroom: number | null;
  verdict: GuardHealthVerdict;
  /** P32.2 建议值：与体检结论同源，不另算一套口径。 */
  advice: GuardAdvice;
  /** P47：这条护栏是否处于临时生效期；到期后 Agent 会恢复原值。 */
  expiry?: GuardExpiry;
}

/** P32.1 护栏体检：让人看清哪条护栏在约束 Agent、哪条仍是平台模板值。 */
export interface GuardHealth {
  storeId: AllMallId;
  windowDays: number;
  /** 该店从未改过护栏：毛利 / 折扣 / 预算仍是平台模板值，未被人确认。 */
  unconfirmed: boolean;
  lastChangeAt?: string;
  items: GuardHealthItem[];
  /** 系统底线不可编辑，也不属于「人划的护栏」，单独列出避免混淆。 */
  systemFloors: { maxPriceChangePct: number; autoRefundCap: number };
}

/**
 * P37.1 账户护栏：人不必逐店重复设同一组值。
 * 这张视图只回答两件事——哪些店还是模板值、哪些护栏正在拦动作。
 */
export interface AccountGuardRow {
  storeId: AllMallId;
  storeName: string;
  guards: StoreGoal['constraints'];
  /** true = 从未被人改过 / 确认过，属于可下发范围。 */
  unconfirmed: boolean;
  /** 近 7 天被三条可编辑护栏拦下的升级项数量之和。 */
  blocks7d: number;
}

export interface AccountGuardSuggestion {
  constraints: StoreGoal['constraints'];
  /** human_consensus = 取自已人工设定店铺的一致值；template = 尚无人工设定，取平台模板值。 */
  basis: Record<GuardHealthKey, 'human_consensus' | 'template'>;
  /** 支持该值的店铺数，用来向人说明「这个数不是 Agent 猜的」。 */
  support: Record<GuardHealthKey, number>;
}

export interface AccountGuardView {
  rows: AccountGuardRow[];
  suggestion: AccountGuardSuggestion;
  /** 仍是平台模板值的店铺数，也就是本次可下发的范围。 */
  pendingCount: number;
}

/** P37.1 按草案值下发前的影响预演：只统计可下发的店铺，不把已有自设的店算进来。 */
export interface AccountGuardPreview {
  storeCount: number;
  changedCount: number;
  confirmOnlyCount: number;
  unlocked: number;
  blocked: number;
  gmvDelta: number;
  grossProfitDelta: number;
  /** 没有本轮方案的店铺不进预演，界面要显式说明覆盖了几家。 */
  withCycleCount: number;
}

const ACCOUNT_GUARD_KEYS: GuardHealthKey[] = ['minGrossMargin', 'maxDiscountPct', 'monthlyBudgetCap'];

/**
 * P37.1 Agent 的账户护栏取值：只采信人已经设定过的店铺，
 * 同值最多的那一档作为账户值；一家都没设过就退回平台模板值，不编造「共识」。
 */
function buildAccountGuardSuggestion(rows: AccountGuardRow[]): AccountGuardSuggestion {
  const constraints: StoreGoal['constraints'] = { ...GUARD_TEMPLATE };
  const basis = {} as AccountGuardSuggestion['basis'];
  const support = {} as AccountGuardSuggestion['support'];
  const humanSet = rows.filter((row) => !row.unconfirmed);
  ACCOUNT_GUARD_KEYS.forEach((key) => {
    const counts = new Map<number, number>();
    humanSet.forEach((row) => counts.set(row.guards[key], (counts.get(row.guards[key]) ?? 0) + 1));
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      constraints[key] = best[0];
      basis[key] = 'human_consensus';
      support[key] = best[1];
      return;
    }
    basis[key] = 'template';
    support[key] = 0;
  });
  return { constraints, basis, support };
}

/** P32.3 护栏体检进待办：同一店铺同一条护栏只保留一条未处理提醒。 */
const GUARD_HEALTH_ESCALATION_PREFIX = 'guard-health-';
/** 店铺运行超过 30 天、护栏仍是模板值 → 请人确认。 */
const GUARD_HEALTH_STALE_DAYS = 30;
/** 同一条护栏 30 天内拦下 3 次及以上 → 视为长期高频，请人校准。 */
const GUARD_HEALTH_HIGH_FREQUENCY = 3;

/** 与 operatingModel 的护栏标签保持一致，用来从审计流水判断「这条护栏被人改过」。 */
const GUARD_HEALTH_LABELS: Record<GuardHealthKey, string> = {
  minGrossMargin: '毛利率下限',
  maxDiscountPct: '折扣上限',
  monthlyBudgetCap: '月度预算上限',
};

/** 护栏拦截升级项的标题前缀，体检与进待办共用同一套归因口径。 */
const GUARD_HEALTH_BLOCK_PREFIX: Record<GuardHealthKey, string> = {
  minGrossMargin: '毛利护栏拦截',
  maxDiscountPct: '折扣超过上限',
  monthlyBudgetCap: '预算不足',
};

const GUARD_HEALTH_BASIS_TEXT: Record<GuardAdviceBasis, string> = {
  unlock: '放开后按本轮方案能多执行',
  tighten: '收紧后能挡住当前方案里最贴边的动作',
  hold_close: '已接近边界，暂不建议动',
  hold_no_data: '本轮没有动作贴近这条线，缺少调参依据',
  hold_pool_bound: '真正的卡点是广告月预算池，改这条上限没有效果',
  hold_step_far: '与当前值相差过大，一次调到位风险高',
  hold_no_effect: '已预演放开后仍会被其他护栏拦住',
};

/** P36.1：从升级项 id（guard-health-{storeId}-{key}-{suffix}）反解护栏 key，只认体检产出的三条。 */
function guardHealthKeyOf(storeId: AllMallId, exceptionId: string): GuardHealthKey | undefined {
  const prefix = `${GUARD_HEALTH_ESCALATION_PREFIX}${storeId}-`;
  if (!exceptionId.startsWith(prefix)) return undefined;
  const rest = exceptionId.slice(prefix.length);
  return (Object.keys(GUARD_HEALTH_LABELS) as GuardHealthKey[]).find((key) =>
    rest.startsWith(`${key}-`),
  );
}

function guardHealthValueText(key: GuardHealthKey, value: number): string {
  return key === 'monthlyBudgetCap' ? `¥${value.toLocaleString()}` : `${value}%`;
}

export interface GuardHealthEscalationSync {
  /** 新建的升级项数量。 */
  created: number;
  /** 条件已消失、被自动收口的升级项数量。 */
  closed: number;
  /** 当前仍在待办中的护栏数。 */
  open: number;
  /** 是否有内容变化，供 UI 决定是否刷新收件箱。 */
  changed: boolean;
}

/**
 * P32.3：把需要人表态的护栏变成一条待办，其余情况不打扰人。
 * - 长期未确认：运行超过 30 天仍是模板值；
 * - 未确认但已在拦截：模板值已经在替人做判断，先请人确认（比等到第 31 天更早暴露问题）；
 * - 长期高频：近 30 天同一条护栏拦下不少于 3 次，请人校准这条线是否还符合意图。
 * 人确认护栏或拦截回落后，下次同步自动收口，不留下过期的提醒。
 */
function buildGuardHealthEscalation(args: {
  storeId: AllMallId;
  storeName: string;
  ageDays: number;
  unconfirmed: boolean;
  item: GuardHealthItem;
  timeoutHours: number;
}): ExceptionItem {
  const { storeId, storeName, ageDays, unconfirmed, item, timeoutHours } = args;
  const label = GUARD_HEALTH_LABELS[item.key];
  const currentText = guardHealthValueText(item.key, item.current);
  const highFrequency = item.blocks30d >= GUARD_HEALTH_HIGH_FREQUENCY;
  const title = highFrequency ? `护栏高频拦截 · ${label}` : `护栏未确认 · ${label}`;
  const reason = highFrequency
    ? `近 30 天有 ${item.blocks30d} 条 Agent 动作被「${label} ${currentText}」拦下，其中近 7 天 ${item.blocks7d} 条。`
    : unconfirmed && item.blocks7d > 0
      ? `「${label} ${currentText}」仍是平台模板值，从未由人确认，但近 7 天已拦下 ${item.blocks7d} 条 Agent 动作。`
      : `店铺已运行 ${ageDays} 天，「${label} ${currentText}」仍是平台模板值，从未由人确认。`;
  const effectText = item.advice.effect
    ? `（预演放开 ${item.advice.effect.unlocked} 条，GMV ${item.advice.effect.gmvDelta >= 0 ? '+' : ''}${item.advice.effect.gmvDelta.toLocaleString()}）`
    : '';
  const adviceText =
    item.advice.suggested !== null
      ? `Agent 建议调到 ${guardHealthValueText(item.key, item.advice.suggested)}：${GUARD_HEALTH_BASIS_TEXT[item.advice.basis]}${effectText}。`
      : `Agent 建议维持当前值：${GUARD_HEALTH_BASIS_TEXT[item.advice.basis]}。`;
  const headroomUnit = item.key === 'monthlyBudgetCap' ? ' 元' : ' 个百分点';
  const suggestedText =
    item.advice.suggested !== null ? guardHealthValueText(item.key, item.advice.suggested) : null;
  const basisText = GUARD_HEALTH_BASIS_TEXT[item.advice.basis];
  // 确认与校准是两种诉求：确认过之后如果仍然长期高频，要能作为新信息重新进待办。
  const idSuffix = highFrequency ? 'frequency' : 'unconfirmed';
  return {
    id: `${GUARD_HEALTH_ESCALATION_PREFIX}${storeId}-${item.key}-${idSuffix}`,
    type: 'guard_health',
    title,
    storeName,
    storeId,
    agentType: 'orchestrator',
    level: 'warning',
    summary: `${reason}${adviceText}`,
    detail: `体检口径：近 30 天拦截 ${item.blocks30d} 次、近 7 天 ${item.blocks7d} 次；${
      item.nearest === null
        ? '本轮没有贴近这条线的动作。'
        : `最贴边的动作取值 ${guardHealthValueText(item.key, item.nearest)}，余量 ${item.headroom ?? 0}${headroomUnit}。`
    }`,
    suggestedAction:
      '在收件箱点选「确认维持」或「调至建议值」；要自己填原因并预览影响时，到经营总览 → 经营目标卡（护栏体检）调整。不处理时超时按维持当前值收尾。',
    // P36.1：护栏升级不再只给一句「去体检」，人可在收件箱一次点选落库。
    // 默认与超时结论都是「维持当前值」——不扩大权限，也不替人放宽判断边界。
    decision: {
      question: suggestedText
        ? `「${label}」当前 ${currentText}：确认维持，还是按 Agent 建议调到 ${suggestedText}？`
        : `「${label}」当前 ${currentText}：是否确认维持这条护栏？`,
      options: [
        {
          id: 'uphold',
          label: `确认维持 ${currentText}`,
          consequence: `「${label}」保持 ${currentText}；确认记录进护栏审计，本条关闭，之后按新的拦截重新体检。`,
          recommended: true,
        },
        ...(suggestedText && item.advice.suggested !== item.current
          ? [
              {
                id: 'override' as const,
                label: `调至 ${suggestedText}`,
                consequence: `「${label}」${currentText} → ${suggestedText}${effectText}；依据：${basisText}。改动原因记为「收件箱采纳 Agent 体检建议」并进审计，之后仍可在目标卡改回。`,
              },
            ]
          : []),
      ],
      timeoutHours,
      deadline: dayjs().add(timeoutHours, 'hour').toISOString(),
      timeoutOptionId: 'uphold',
    },
    createdAt: new Date().toISOString(),
    resolved: false,
    ignored: false,
    linkTo: `/dashboard?storeId=${storeId}#store-goal-card`,
  };
}

const GUARD_HEALTH_ACCOUNT_PREFIX = 'guard-health-account-';

function asGuardHealthKey(key?: string): GuardHealthKey | undefined {
  return (Object.keys(GUARD_HEALTH_LABELS) as GuardHealthKey[]).find((entry) => entry === key);
}

/** 结论选项的签名：同一条护栏要问的事一样，才允许合并成一次表态。 */
function escalationOptionSignature(decision?: ExceptionItem['decision']): string {
  return (decision?.options ?? []).map((option) => option.id).sort().join('+');
}

interface GuardHealthPendingEntry {
  storeId: AllMallId;
  storeName: string;
  ageDays: number;
  unconfirmed: boolean;
  item: GuardHealthItem;
  timeoutHours: number;
}

/** P38.1：单店护栏体检 → 需要人表态的护栏清单（不写库，供单店与账户级同步复用）。 */
async function collectGuardHealthPending(
  storeId: AllMallId,
  allItems: ExceptionItem[],
): Promise<GuardHealthPendingEntry[]> {
  const health = await orchestratorApi.getGuardHealth(storeId);
  const changes = await operatingModelApi.listGuardChanges(storeId);
  const store = stores.find((entry) => entry.id === storeId);
  const storeName = store?.name ?? '当前店铺';
  const ageDays = store ? dayjs().diff(dayjs(store.createdAt), 'day') : 0;

  /** 确认按「单条护栏」算：改过毛利率不代表预算上限也被人确认过。 */
  const lastChangeAt = (item: GuardHealthItem): string | undefined =>
    changes
      .filter((change) => change.summary.startsWith(GUARD_HEALTH_LABELS[item.key]))
      .map((change) => change.at)
      .sort()
      .pop();

  /**
   * 长期高频只看「这条护栏最近一次被人调整之后」的拦截：
   * 人刚把线改过，旧拦截不该继续催他；同时最多回看 30 天，避免拿很久以前的数据下结论。
   */
  const blocksSinceLastChange = (item: GuardHealthItem): number => {
    const since30d = dayjs().subtract(GUARD_HEALTH_STALE_DAYS, 'day');
    const changedAt = lastChangeAt(item);
    const since = changedAt && dayjs(changedAt).isAfter(since30d) ? dayjs(changedAt) : since30d;
    return allItems.filter(
      (entry) =>
        entry.storeId === storeId &&
        entry.title.startsWith(GUARD_HEALTH_BLOCK_PREFIX[item.key]) &&
        dayjs(entry.createdAt).isAfter(since),
    ).length;
  };

  const timeoutHours = exceptionsApi.getEscalationPolicy(storeId).timeoutHours;
  return health.items
    .map((item) => {
      const guardUnconfirmed = !lastChangeAt(item);
      const recentBlocks = blocksSinceLastChange(item);
      const highFrequency = recentBlocks >= GUARD_HEALTH_HIGH_FREQUENCY;
      const needConfirm = guardUnconfirmed && (ageDays > GUARD_HEALTH_STALE_DAYS || item.blocks7d > 0);
      return needConfirm || highFrequency
        ? {
            storeId,
            storeName,
            ageDays,
            unconfirmed: guardUnconfirmed,
            item: { ...item, blocks30d: recentBlocks },
            timeoutHours,
          }
        : null;
    })
    .filter((entry): entry is GuardHealthPendingEntry => entry !== null);
}

/**
 * P38.1：同一条护栏在多家店都等人表态时，合并成一条账户级待办。
 * 人只做一次判断，Agent 按名单逐店落库并各自留审计；名单随巡检更新。
 */
function buildAccountGuardEscalation(
  rows: { entry: GuardHealthPendingEntry; escalation: ExceptionItem }[],
): ExceptionItem {
  const key = rows[0].entry.item.key;
  const label = GUARD_HEALTH_LABELS[key];
  const storeIds = rows.map((row) => row.entry.storeId);
  const signature = escalationOptionSignature(rows[0].escalation.decision);
  const allUnconfirmed = rows.every((row) => row.entry.unconfirmed);
  const hasFrequency = rows.some(
    (row) => row.entry.item.blocks30d >= GUARD_HEALTH_HIGH_FREQUENCY,
  );
  const timeoutHours = Math.min(...rows.map((row) => row.entry.timeoutHours));
  const currentTexts = rows.map(
    (row) => `${row.entry.storeName} ${guardHealthValueText(key, row.entry.item.current)}`,
  );
  const overrideTexts = rows
    .filter(
      (row) =>
        row.entry.item.advice.suggested !== null &&
        row.entry.item.advice.suggested !== row.entry.item.current,
    )
    .map(
      (row) =>
        `${row.entry.storeName} ${guardHealthValueText(key, row.entry.item.current)} → ${guardHealthValueText(
          key,
          row.entry.item.advice.suggested as number,
        )}`,
    );
  const canOverrideAll = overrideTexts.length === rows.length;
  const titleBase = allUnconfirmed ? '护栏未确认' : hasFrequency ? '护栏高频拦截' : '护栏同类待表态';
  const detailLines = rows
    .map((row) => {
      const { item, storeName } = row.entry;
      const suggested = item.advice.suggested;
      const advice =
        suggested !== null && suggested !== item.current
          ? `建议 ${guardHealthValueText(key, suggested)}（${GUARD_HEALTH_BASIS_TEXT[item.advice.basis]}）`
          : `建议维持（${GUARD_HEALTH_BASIS_TEXT[item.advice.basis]}）`;
      return `${storeName}：近 30 天拦截 ${item.blocks30d} 次 / 近 7 天 ${item.blocks7d} 次，${advice}`;
    })
    .join('\n');

  return {
    id: `${GUARD_HEALTH_ACCOUNT_PREFIX}${key}-${signature.replace(/\+/g, '_')}`,
    type: 'guard_health_account',
    title: `${titleBase} · ${label}（${rows.length} 家店）`,
    storeName: `${rows.length} 家店`,
    storeId: storeIds[0],
    agentType: 'orchestrator',
    level: 'warning',
    summary: `${rows.length} 家店同一条「${label}」都在等你表态：${currentTexts.join('、')}。Agent 已按各店体检结果给出建议，处理一次会分别落到每家店的护栏审计。`,
    detail: `${detailLines}\n合并口径：同一条护栏、同样的可选结论才合并；任一店出现不同选项时仍逐店单列，避免一次表态误伤其他店。`,
    suggestedAction: `点选「全部确认维持」或「全部调至各店建议值」即可；仍需逐店微调时到经营总览 → 经营目标卡。不处理时超过 ${timeoutHours} 小时按各店维持当前值收尾。`,
    decision: {
      question: `「${label}」在 ${rows.length} 家店都等你表态：全部确认维持，还是按各店建议值分别调整？`,
      options: [
        {
          id: 'uphold',
          label: `全部确认维持（${rows.length} 家店）`,
          consequence: `${currentTexts.join('、')} 保持不动；每店各记一条确认审计，本条关闭。`,
          recommended: true,
        },
        ...(canOverrideAll
          ? [
              {
                id: 'override' as const,
                label: `全部调至各店建议值（${rows.length} 家店）`,
                consequence: `${overrideTexts.join('；')}；每店按体检依据分别改值并各自留审计，之后仍可在单店目标卡改回。`,
              },
            ]
          : []),
      ],
      timeoutHours,
      deadline: dayjs().add(timeoutHours, 'hour').toISOString(),
      timeoutOptionId: 'uphold',
    },
    createdAt: new Date().toISOString(),
    resolved: false,
    ignored: false,
    linkTo: `/dashboard?storeId=${storeIds[0]}#store-goal-card`,
    guardAccount: { key, storeIds },
  };
}

/**
 * P38.1：一次巡检内同步护栏升级，并把「同一条护栏、同样的可选结论」的多店提醒合并成一条。
 * 单店条件消失时只收口该店；合并项名单变化时关闭旧条目、按新名单重建。
 */
async function syncGuardEscalationsAcross(
  storeIds: AllMallId[],
): Promise<GuardHealthEscalationSync & { changedStores: number }> {
  const scope = Array.from(new Set(storeIds));
  const allItems = await exceptionsApi.list();
  const pending: GuardHealthPendingEntry[] = [];
  for (const storeId of scope) {
    pending.push(...(await collectGuardHealthPending(storeId, allItems)));
  }

  const built = pending.map((entry) => ({
    entry,
    escalation: buildGuardHealthEscalation(entry),
  }));
  const groups = new Map<string, typeof built>();
  for (const row of built) {
    const groupKey = `${row.entry.item.key}|${escalationOptionSignature(row.escalation.decision)}`;
    const group = groups.get(groupKey);
    if (group) group.push(row);
    else groups.set(groupKey, [row]);
  }

  const nextItems: ExceptionItem[] = [];
  const accountItems: ExceptionItem[] = [];
  for (const group of groups.values()) {
    if (group.length >= 2) accountItems.push(buildAccountGuardEscalation(group));
    else if (group.length === 1) nextItems.push(group[0].escalation);
  }

  const prefixes = scope.map((storeId) => `${GUARD_HEALTH_ESCALATION_PREFIX}${storeId}-`);
  const scopeSet = new Set<AllMallId>(scope);
  const openItems = allItems.filter(
    (item) =>
      !item.resolved &&
      !item.ignored &&
      (prefixes.some((prefix) => item.id.startsWith(prefix)) ||
        (item.type === 'guard_health_account' &&
          (item.guardAccount?.storeIds ?? []).every((id) => scopeSet.has(id as AllMallId)))),
  );
  const openById = new Map(openItems.map((item) => [item.id, item]));

  let created = 0;
  let changed = false;
  const changedStores = new Set<AllMallId>();
  for (const next of [...nextItems, ...accountItems]) {
    const existing = openById.get(next.id);
    const isNew = await exceptionsApi.upsertEscalation(next);
    if (isNew) created += 1;
    if (
      !existing ||
      existing.title !== next.title ||
      existing.summary !== next.summary ||
      existing.level !== next.level
    ) {
      changed = true;
      if (next.guardAccount) {
        for (const id of next.guardAccount.storeIds) changedStores.add(id as AllMallId);
      } else if (next.storeId !== undefined) {
        changedStores.add(next.storeId);
      }
    }
  }

  const keep = new Set([...nextItems, ...accountItems].map((item) => item.id));
  const stale = openItems.filter((item) => !keep.has(item.id));
  const stalePerStore = stale.filter((item) => item.type !== 'guard_health_account');
  if (stalePerStore.length > 0) {
    await exceptionsApi.batchResolve(stalePerStore.map((item) => item.id));
    for (const item of stalePerStore) if (item.storeId !== undefined) changedStores.add(item.storeId);
    changed = true;
  }
  for (const item of stale.filter((entry) => entry.type === 'guard_health_account')) {
    await exceptionsApi.resolve(
      item.id,
      'P38.1：同类护栏已无店铺需要表态，Agent 自动收口账户级提醒。',
      'Agent',
    );
    for (const id of item.guardAccount?.storeIds ?? []) changedStores.add(id as AllMallId);
    changed = true;
  }

  return {
    created,
    closed: stale.length,
    open: nextItems.length + accountItems.length,
    changed,
    changedStores: changedStores.size,
  };
}

/**
 * P55.1：护栏是 Agent 自己按期收回的，方案就该由 Agent 自己按收回后的边界重排，
 * 而不是留一张「目标或护栏已变更，请让 Agent 重跑」把人拖回来点一次。
 * 只重排已存在的方案；方案里已有已提交/在途动作时不重排，保留 P54 的过期回执给人拦。
 * 重排失败（例如没有开启任何 Agent）不写假回执，仍由 P54 的卡上回执兜底。
 */
async function replanCycleAfterGuardRestore(storeId: AllMallId): Promise<boolean> {
  const cycle = cycles.get(storeId);
  if (!cycle) return false;
  if (cycle.proposals.some((proposal) => proposal.status === 'submitted')) return false;
  const store = stores.find((item) => item.id === storeId);
  try {
    await orchestratorApi.generateCycle(storeId, { trigger: 'guard', storeName: store?.name });
    return true;
  } catch {
    return false;
  }
}

export const orchestratorApi = {
  /** 读取店铺当前经营周期；未生成时返回空环（阶段停在“感知”）。 */
  getCycle: (storeId: AllMallId): Promise<OperatingCycle> => {
    const existing = cycles.get(storeId);
    // 归因记录可能因审批通过而变化，读取时始终附带最新回写状态。
    const outcomes = getOutcomes(storeId);
    if (existing) {
      const cloned = cloneCycle(existing);
      // 提交/审批会改变提案状态，协同组状态与合计收益随之重算。
      cloned.collaborations = buildCollaborations(cloned.proposals, cloned.id);
      cloned.outcomes = outcomes;
      return mockDelay(cloned);
    }
    const goalFallback: OperatingCycle = {
      id: cycleIdOf(storeId),
      storeId,
      periodLabel: '',
      stage: 'observe',
      diagnosis: { metric: 'gmv', target: 0, current: 0, gapPct: 0, priority: 'growth' },
      proposals: [],
      conflicts: [],
      collaborations: [],
      outcomes,
    };
    return mockDelay(goalFallback);
  },

  /**
   * P29.4 护栏影响预演：人在改护栏前先看清两件事——
   * 1) 过去 7 天 Agent 因护栏被拦下多少次（按升级项归因，已处理的历史也计入）；
   * 2) 按本轮已生成的方案，这次改动会放开 / 多拦哪些动作，GMV 与毛利预计怎么变。
   * 预演只读，不写周期、不生成升级项；口径与仲裁共用 guardBlockKind。
   */
  previewGuardImpact: async (
    storeId: AllMallId,
    next: StoreGoal['constraints'],
  ): Promise<GuardImpactPreview> => {
    const goal = await operatingModelApi.getGoal(storeId);
    const policy = operatingModelApi.getEffectivePolicy(storeId);
    const windowDays = 7;
    const since = dayjs().subtract(windowDays, 'day');
    // 同一动作在新一轮重新被拦会再次提醒；这里统计的是「拦截事件」，不是去重后的商品数。
    const recent = (await exceptionsApi.list()).filter(
      (item) => item.storeId === storeId && dayjs(item.createdAt).isAfter(since),
    );
    const countByTitle = (prefix: string) =>
      recent.filter((item) => item.title.startsWith(prefix)).length;
    const marginBlocks = countByTitle('毛利护栏拦截');
    const discountBlocks = countByTitle('折扣超过上限');
    const budgetBlocks = countByTitle('预算不足');

    const cycle = cycles.get(storeId);
    const unlocked: GuardImpactItem[] = [];
    const blocked: GuardImpactItem[] = [];
    if (cycle) {
      // 方向/依赖/重复计益的败者即使护栏放开也不会执行，不能算进「放开」的收益。
      const nonGuardLosers = new Set(
        cycle.conflicts
          .filter(
            (conflict) =>
              conflict.type === 'direction' ||
              conflict.type === 'dependency' ||
              conflict.type === 'double_count',
          )
          .flatMap((conflict) => conflict.loserProposalIds),
      );
      const toItem = (proposal: CycleProposal, reason: GuardBlockKind): GuardImpactItem => ({
        proposalId: proposal.id,
        targetLabel: proposal.targetLabel,
        action: proposal.action,
        reason,
        expectedImpact: proposal.expectedImpact,
        projectedGrossMargin: proposal.projectedGrossMargin,
      });
      cycle.proposals.forEach((proposal) => {
        if (proposal.status === 'submitted' || nonGuardLosers.has(proposal.id)) return;
        const current = guardBlockKind(
          proposal,
          goal.constraints,
          policy.budgetPool,
          goal.priority,
        );
        const after = guardBlockKind(proposal, next, policy.budgetPool, goal.priority);
        if (current && !after) {
          unlocked.push(toItem(proposal, current));
        } else if (!current && after && proposal.status === 'selected') {
          blocked.push(toItem(proposal, after));
        }
      });
    }

    const signedGmv =
      unlocked.reduce((sum, item) => sum + item.expectedImpact, 0) -
      blocked.reduce((sum, item) => sum + item.expectedImpact, 0);
    // 毛利只对有预计毛利率的动作估算；补货/加投的成本项不在 GMV 口径里，不做臆测。
    const signedGrossProfit =
      unlocked.reduce(
        (sum, item) =>
          sum +
          (item.projectedGrossMargin !== undefined
            ? (item.expectedImpact * item.projectedGrossMargin) / 100
            : 0),
        0,
      ) -
      blocked.reduce(
        (sum, item) =>
          sum +
          (item.projectedGrossMargin !== undefined
            ? (item.expectedImpact * item.projectedGrossMargin) / 100
            : 0),
        0,
      );

    return mockDelay({
      storeId,
      windowDays,
      pastBlocks: {
        total: marginBlocks + discountBlocks + budgetBlocks,
        margin: marginBlocks,
        discount: discountBlocks,
        budget: budgetBlocks,
      },
      hasCycle: Boolean(cycle && cycle.proposals.length > 0),
      unlocked,
      blocked,
      gmvDelta: Math.round(signedGmv),
      grossProfitDelta: Math.round(signedGrossProfit),
    });
  },

  /**
   * P32.1 护栏体检：回答三个问题——这条护栏近 7 天拦过什么、本轮最接近它的动作离边界多远、
   * 它到底是不是人设的（还是平台模板值）。只读：复用升级项归因、本轮方案与护栏变更审计，
   * 不写库、不生成升级项。
   */
  getGuardHealth: async (storeId: AllMallId): Promise<GuardHealth> => {
    const goal = await operatingModelApi.getGoal(storeId);
    const policy = operatingModelApi.getEffectivePolicy(storeId);
    const changes = await operatingModelApi.listGuardChanges(storeId);
    const windowDays = 7;
    const since = dayjs().subtract(windowDays, 'day');
    /** P32.3：长期高频拦截按 30 天看，短期拦截仍按 7 天，两个窗口都保留。 */
    const since30d = dayjs().subtract(30, 'day');
    const storeItems = (await exceptionsApi.list()).filter((item) => item.storeId === storeId);
    const recent = storeItems.filter((item) => dayjs(item.createdAt).isAfter(since));
    const recent30d = storeItems.filter((item) => dayjs(item.createdAt).isAfter(since30d));
    const countByTitle = (prefix: string) =>
      recent.filter((item) => item.title.startsWith(prefix)).length;
    const count30dByTitle = (prefix: string) =>
      recent30d.filter((item) => item.title.startsWith(prefix)).length;

    // 只有真正会执行的提案才代表护栏「正在承受的压力」；被拦下的动作只体现在拦截次数里。
    const cycle = cycles.get(storeId);
    const executing = (cycle?.proposals ?? []).filter(
      (proposal) => proposal.status === 'selected' || proposal.status === 'submitted',
    );
    const margins = executing
      .map((proposal) => proposal.projectedGrossMargin)
      .filter((value): value is number => value !== undefined);
    const discounts = executing
      .map((proposal) => proposal.discountPct)
      .filter((value): value is number => value !== undefined);

    /** 余量小于 5 个百分点即视为「接近生效」，避免护栏调得刚好擦着动作走。 */
    const CLOSE_HEADROOM = 5;
    const marginBlocks = countByTitle('毛利护栏拦截');
    const discountBlocks = countByTitle('折扣超过上限');
    const budgetBlocks = countByTitle('预算不足');

    const marginNearest = margins.length > 0 ? Math.min(...margins) : null;
    const marginHeadroom =
      marginNearest === null ? null : marginNearest - goal.constraints.minGrossMargin;
    const discountNearest = discounts.length > 0 ? Math.max(...discounts) : null;
    const discountHeadroom =
      discountNearest === null ? null : goal.constraints.maxDiscountPct - discountNearest;
    const poolTotal = policy.budgetPool.adMonthly + policy.budgetPool.promoMonthly;
    const budgetHeadroom = goal.constraints.monthlyBudgetCap - poolTotal;

    const verdictOf = (blocks: number, headroom: number | null): GuardHealthVerdict => {
      if (blocks > 0) return 'binding';
      if (headroom === null) return 'no_data';
      return headroom <= CLOSE_HEADROOM ? 'close' : 'idle';
    };

    const proposals = cycle?.proposals ?? [];
    /** 本轮真正被这条护栏拦下的提案；与预演、仲裁共用 guardBlockKind，不另立口径。 */
    const blockedByKind = (kind: GuardBlockKind) =>
      proposals.filter(
        (proposal) =>
          proposal.status !== 'submitted' &&
          guardBlockKind(proposal, goal.constraints, policy.budgetPool, goal.priority) === kind,
      );

    /** 单轮最多动 5 个单位：护栏是安全边界，一次调太多人无法判断自己改了什么。 */
    const MAX_STEP = 5;

    /**
     * P32.2 建议值：人不需要自己反推「该往哪调、调多少」。
     * - 正在拦动作：只放开最擦边的一条，且一次不超过 5 个单位；
     * - 空转：把线收到离本轮动作 5 个点的位置，让护栏真正起作用；
     * - 其余：明确建议维持，并说明为什么不动（例如预算的卡点是池子而不是上限）。
     */
    const buildAdvice = (key: GuardHealthKey, verdict: GuardHealthVerdict): GuardAdvice => {
      const current = goal.constraints[key];
      const hold = (basis: GuardAdviceBasis, extra?: Partial<GuardAdvice>): GuardAdvice => ({
        basis,
        suggested: null,
        delta: 0,
        blockedActions: 0,
        ...extra,
      });

      if (key === 'monthlyBudgetCap') {
        const budgetBlocked = proposals.filter(
          (proposal) =>
            proposal.action === 'increase_ad_budget' &&
            guardBlockKind(proposal, goal.constraints, policy.budgetPool, goal.priority) === 'budget',
        );
        if (budgetBlocked.length === 0) return hold('hold_no_data');
        const cheapest = Math.min(...budgetBlocked.map((proposal) => proposal.cost));
        const neededCap = Math.ceil(cheapest / (1 - AD_SPENT_RATIO));
        // 判定式取 min(广告月预算池, 人设上限)：上限提到池子以上也不会放行，别让人白改一次。
        if (neededCap > policy.budgetPool.adMonthly) {
          return hold('hold_pool_bound', {
            blockedActions: budgetBlocked.length,
            anchor: neededCap,
            poolLimit: policy.budgetPool.adMonthly,
          });
        }
        return {
          basis: 'unlock',
          suggested: neededCap,
          delta: neededCap - current,
          blockedActions: budgetBlocked.length,
          anchor: neededCap,
        };
      }

      const kind: GuardBlockKind = key === 'minGrossMargin' ? 'margin' : 'discount_cap';
      const guardBlocked = blockedByKind(kind);
      if (guardBlocked.length > 0) {
        const values = guardBlocked
          .map((proposal) => (kind === 'margin' ? proposal.projectedGrossMargin : proposal.discountPct))
          .filter((value): value is number => value !== undefined);
        if (values.length === 0) return hold('hold_no_data');
        // 只放开最擦边的一条：毛利取被拦动作里最高的，折扣取最低的，避免一次把线放到底。
        const anchor = kind === 'margin' ? Math.max(...values) : Math.min(...values);
        const suggested = kind === 'margin' ? Math.floor(anchor) : Math.ceil(anchor);
        if (Math.abs(current - suggested) > MAX_STEP) {
          return hold('hold_step_far', { blockedActions: guardBlocked.length, anchor });
        }
        return {
          basis: 'unlock',
          suggested,
          delta: suggested - current,
          blockedActions: guardBlocked.length,
          anchor,
        };
      }

      if (verdict === 'binding') return hold('hold_no_data');
      if (verdict === 'close') return hold('hold_close');
      if (verdict === 'idle' && marginNearest !== null && discountNearest !== null) {
        // 空转护栏：把余量收到 5 个点，让它对下一轮动作真的有约束力。
        const target =
          key === 'minGrossMargin'
            ? Math.min(marginNearest - CLOSE_HEADROOM, current + MAX_STEP)
            : Math.max(discountNearest + CLOSE_HEADROOM, current - MAX_STEP);
        const suggested = Math.max(0, Math.round(target));
        if (suggested === current) return hold('hold_no_data');
        return { basis: 'tighten', suggested, delta: suggested - current, blockedActions: 0 };
      }
      return hold('hold_no_data');
    };

    const rawItems: GuardHealthItem[] = [
      {
        key: 'minGrossMargin',
        current: goal.constraints.minGrossMargin,
        blocks7d: marginBlocks,
        blocks30d: count30dByTitle(GUARD_HEALTH_BLOCK_PREFIX.minGrossMargin),
        nearest: marginNearest,
        headroom: marginHeadroom,
        verdict: verdictOf(marginBlocks, marginHeadroom),
        advice: buildAdvice('minGrossMargin', verdictOf(marginBlocks, marginHeadroom)),
        expiry: goal.guardExpiries?.minGrossMargin,
      },
      {
        key: 'maxDiscountPct',
        current: goal.constraints.maxDiscountPct,
        blocks7d: discountBlocks,
        blocks30d: count30dByTitle(GUARD_HEALTH_BLOCK_PREFIX.maxDiscountPct),
        nearest: discountNearest,
        headroom: discountHeadroom,
        verdict: verdictOf(discountBlocks, discountHeadroom),
        advice: buildAdvice('maxDiscountPct', verdictOf(discountBlocks, discountHeadroom)),
        expiry: goal.guardExpiries?.maxDiscountPct,
      },
      {
        key: 'monthlyBudgetCap',
        current: goal.constraints.monthlyBudgetCap,
        blocks7d: budgetBlocks,
        blocks30d: count30dByTitle(GUARD_HEALTH_BLOCK_PREFIX.monthlyBudgetCap),
        nearest: poolTotal,
        headroom: budgetHeadroom,
        verdict: verdictOf(budgetBlocks, budgetHeadroom),
        advice: buildAdvice('monthlyBudgetCap', verdictOf(budgetBlocks, budgetHeadroom)),
        expiry: goal.guardExpiries?.monthlyBudgetCap,
      },
    ];

    /** 建议值必须带「按本轮方案预演」的后果：放开几条、GMV/毛利怎么变。 */
    const withEffect = async (item: GuardHealthItem): Promise<GuardHealthItem> => {
      if (item.advice.suggested === null) return item;
      const preview = await orchestratorApi.previewGuardImpact(storeId, {
        ...goal.constraints,
        [item.key]: item.advice.suggested,
      });
      const effect = {
        unlocked: preview.unlocked.length,
        blocked: preview.blocked.length,
        gmvDelta: preview.gmvDelta,
        grossProfitDelta: preview.grossProfitDelta,
      };
      // 预演说一条都放不开：说明这些动作另有拦截原因，改护栏白费，直接退回「建议维持」。
      if (item.advice.basis === 'unlock' && effect.unlocked === 0) {
        return {
          ...item,
          advice: {
            basis: 'hold_no_effect',
            suggested: null,
            delta: 0,
            blockedActions: item.advice.blockedActions,
          },
        };
      }
      return { ...item, advice: { ...item.advice, effect } };
    };

    const items = await Promise.all(rawItems.map(withEffect));

    return mockDelay({
      storeId,
      windowDays,
      unconfirmed: changes.length === 0,
      lastChangeAt: changes[0]?.at,
      items,
      systemFloors: {
        maxPriceChangePct: policy.guards.maxPriceChangePct,
        autoRefundCap: policy.guards.autoRefundCap,
      },
    });
  },

  /**
   * P37.1：多店铺概览的账户护栏视图。
   * 逐店展开体检会把 N 家店的全部建议都算一遍，人反而更难看清；
   * 这里只汇总「是否模板值 + 近 7 天拦截数」，取值建议交给 buildAccountGuardSuggestion。
   */
  getAccountGuards: async (storeIds: AllMallId[]): Promise<AccountGuardView> => {
    const allItems = await exceptionsApi.list();
    const since = dayjs().subtract(7, 'day');
    const blockPrefixes = ACCOUNT_GUARD_KEYS.map((key) => GUARD_HEALTH_BLOCK_PREFIX[key]);
    const goals = await Promise.all(storeIds.map((storeId) => operatingModelApi.getGoal(storeId)));
    const changeLists = await Promise.all(
      storeIds.map((storeId) => operatingModelApi.listGuardChanges(storeId)),
    );
    const rows: AccountGuardRow[] = storeIds.map((storeId, index) => ({
      storeId,
      storeName: stores.find((store) => store.id === storeId)?.name ?? `#${storeId}`,
      guards: goals[index].constraints,
      unconfirmed: changeLists[index].length === 0,
      blocks7d: allItems.filter(
        (item) =>
          item.storeId === storeId &&
          dayjs(item.createdAt).isAfter(since) &&
          blockPrefixes.some((prefix) => item.title.startsWith(prefix)),
      ).length,
    }));
    return mockDelay({
      rows,
      suggestion: buildAccountGuardSuggestion(rows),
      pendingCount: rows.filter((row) => row.unconfirmed).length,
    });
  },

  /**
   * P37.1：下发前预演。与单店调护栏共用 previewGuardImpact，不另算一套口径；
   * 只统计可下发的店——已有自设值的店不会被覆盖，也不该出现在后果里。
   */
  previewAccountGuards: async (
    storeIds: AllMallId[],
    constraints: StoreGoal['constraints'],
  ): Promise<AccountGuardPreview> => {
    const view = await orchestratorApi.getAccountGuards(storeIds);
    const targets = view.rows.filter((row) => row.unconfirmed);
    const previews = await Promise.all(
      targets.map((row) => orchestratorApi.previewGuardImpact(row.storeId, constraints)),
    );
    const changedCount = targets.filter((row) =>
      ACCOUNT_GUARD_KEYS.some((key) => row.guards[key] !== constraints[key]),
    ).length;
    return mockDelay({
      storeCount: targets.length,
      changedCount,
      confirmOnlyCount: targets.length - changedCount,
      unlocked: previews.reduce((sum, item) => sum + item.unlocked.length, 0),
      blocked: previews.reduce((sum, item) => sum + item.blocked.length, 0),
      gmvDelta: previews.reduce((sum, item) => sum + item.gmvDelta, 0),
      grossProfitDelta: previews.reduce((sum, item) => sum + item.grossProfitDelta, 0),
      withCycleCount: previews.filter((item) => item.hasCycle).length,
    });
  },

  /**
   * P32.3：由 Agent 自己把「需要人表态的护栏」推进收件箱，人不必逐条巡检体检面板。
   * 只生成被点名的护栏（毛利率 / 折扣 / 预算），且同一护栏只有一条未处理提醒；
   * 条件消失（人已确认、拦截回落）下次同步自动收口，人处理过一次就不会反复打扰。
   * P38.1：同一条护栏在多店都等人表态时合并为一条账户级提醒，人只表态一次。
   */
  syncGuardEscalations: async (storeId: AllMallId): Promise<GuardHealthEscalationSync> => {
    // P38.1：护栏升级以账户为口径巡检，单店操作后也顺手刷新其他店的同类提醒，
    // 避免合并名单沿用旧值（例如人在单店手改后，账户级提醒仍点它的名）。
    const scope: AllMallId[] = stores
      .filter((entry) => entry.status === 'connected')
      .map((entry) => entry.id);
    if (!scope.includes(storeId)) scope.push(storeId);
    const result = await syncGuardEscalationsAcross(scope);
    return {
      created: result.created,
      closed: result.closed,
      open: result.open,
      changed: result.changed,
    };
  },

  /**
   * P36.1：把收件箱里选的护栏结论落到护栏本身。
   * - 确认维持：记一条「确认护栏」审计，不改值，本条关闭；
   * - 调至建议值：按同一份体检建议写回护栏，原因自动留痕，仍可在目标卡改回；
   * - 体检结果已变化：不硬造结论，只关闭过期提醒。
   */
  applyGuardHealthRemedy: async (
    storeId: AllMallId,
    exceptionId: string,
    optionId: 'uphold' | 'override',
    meta: { actor: string; actorRole?: string },
  ) => {
    const actor = meta.actor.trim() || '当前用户';
    const key = guardHealthKeyOf(storeId, exceptionId);
    const goal = await operatingModelApi.getGoal(storeId);
    const health = key ? await orchestratorApi.getGuardHealth(storeId) : null;
    const item = health?.items.find((entry) => entry.key === key);
    if (!item) {
      await exceptionsApi.resolve(exceptionId, '护栏体检结果已变化，本条自动关闭', actor);
      return mockDelay({ applied: false, value: null });
    }
    const label = GUARD_HEALTH_LABELS[item.key];
    const current = goal.constraints[item.key];
    const currentText = guardHealthValueText(item.key, current);
    const suggested = item.advice.suggested;
    const canAdopt = suggested !== null && suggested !== current;

    if (optionId === 'override' && canAdopt) {
      await operatingModelApi.saveGoal(
        storeId,
        { constraints: { ...goal.constraints, [item.key]: suggested } },
        {
          reason: `收件箱采纳 Agent 体检建议：${GUARD_HEALTH_BASIS_TEXT[item.advice.basis]}`,
          actor,
          actorRole: meta.actorRole,
        },
      );
      const effectText = item.advice.effect
        ? `；预演放开 ${item.advice.effect.unlocked} 条，GMV ${item.advice.effect.gmvDelta >= 0 ? '+' : ''}${item.advice.effect.gmvDelta.toLocaleString()}`
        : '';
      await exceptionsApi.resolve(
        exceptionId,
        `人采纳建议：${label} ${currentText} → ${guardHealthValueText(item.key, suggested)}${effectText}`,
        actor,
      );
      return mockDelay({ applied: true, value: suggested });
    }

    const reason = canAdopt
      ? `收件箱确认维持当前值，不采纳建议值 ${guardHealthValueText(item.key, suggested)}`
      : '收件箱确认维持当前值（Agent 无更高建议）';
    await operatingModelApi.confirmGuard(storeId, item.key, { actor, reason });
    await exceptionsApi.resolve(
      exceptionId,
      `人确认维持 ${label} ${currentText}${canAdopt ? `，不采纳建议值 ${guardHealthValueText(item.key, suggested)}` : ''}`,
      actor,
    );
    return mockDelay({ applied: false, value: current });
  },

  /**
   * P38.1：账户级护栏升级的一次表态落库。
   * - 全部确认维持：逐店记「确认护栏」审计，不改任何值；
   * - 全部调至各店建议值：逐店按各自体检建议改值，原因与依据逐店留痕；
   * - 落库前逐店重算体检：条件已变化的店铺跳过并在结论里点名，不按旧名单硬改。
   */
  applyAccountGuardRemedy: async (
    exceptionId: string,
    optionId: 'uphold' | 'override',
    meta: { actor: string; actorRole?: string },
  ): Promise<{ applied: boolean; stores: number; skipped: number }> => {
    const actor = meta.actor.trim() || '当前用户';
    const allItems = await exceptionsApi.list();
    const exception = allItems.find((item) => item.id === exceptionId);
    const key = asGuardHealthKey(exception?.guardAccount?.key);
    if (!exception || !key || !exception.guardAccount) {
      if (exception) {
        await exceptionsApi.resolve(exceptionId, '护栏体检结果已变化，本条自动关闭', actor);
      }
      return mockDelay({ applied: false, stores: 0, skipped: 0 });
    }

    const label = GUARD_HEALTH_LABELS[key];
    const appliedNotes: string[] = [];
    const skippedNotes: string[] = [];
    for (const storeId of exception.guardAccount.storeIds as AllMallId[]) {
      const storeName = stores.find((entry) => entry.id === storeId)?.name ?? `店铺 ${storeId}`;
      const goal = await operatingModelApi.getGoal(storeId);
      const health = await orchestratorApi.getGuardHealth(storeId);
      const item = health.items.find((entry) => entry.key === key);
      if (!item) {
        skippedNotes.push(`${storeName} 体检项已消失`);
        continue;
      }
      const current = goal.constraints[key];
      const suggested = item.advice.suggested;
      if (optionId === 'override' && (suggested === null || suggested === current)) {
        skippedNotes.push(`${storeName} 建议值已变化`);
        continue;
      }
      if (optionId === 'override') {
        await operatingModelApi.saveGoal(
          storeId,
          { constraints: { ...goal.constraints, [key]: suggested as number } },
          {
            reason: `收件箱采纳账户级同类建议：${GUARD_HEALTH_BASIS_TEXT[item.advice.basis]}`,
            actor,
            actorRole: meta.actorRole,
          },
        );
        appliedNotes.push(
          `${storeName} ${guardHealthValueText(key, current)} → ${guardHealthValueText(key, suggested as number)}`,
        );
      } else {
        await operatingModelApi.confirmGuard(storeId, key, {
          actor,
          reason: '收件箱账户级确认维持（同类问题一次表态）',
        });
        appliedNotes.push(`${storeName} 维持 ${guardHealthValueText(key, current)}`);
      }
    }

    const head =
      optionId === 'override'
        ? `人一次表态采纳账户同类建议：${label}`
        : `人一次表态确认维持账户同类护栏：${label}`;
    const skipText =
      skippedNotes.length > 0 ? `；${skippedNotes.join('、')}，未改动` : '';
    await exceptionsApi.resolve(
      exceptionId,
      `${head}；${appliedNotes.join('；') || '无店铺需要改动'}${skipText}`,
      actor,
    );
    return mockDelay({
      applied: appliedNotes.length > 0,
      stores: appliedNotes.length,
      skipped: skippedNotes.length,
    });
  },

  /**
   * P8 冲突裁决台：集中处理单店冲突。
   * - uphold：认可自动仲裁，只记录理由并关闭对应升级项；
   * - override：翻转结论（方向换胜方，其余放行败者），方向偏好沉淀给下一轮。
   */
  decideConflict: async (
    storeId: AllMallId,
    conflictId: AllMallId,
    decision: ArbitrationDecision,
    reason: ArbitrationReason,
    options?: {
      note?: string;
      actor?: string;
      submitAfterOverride?: boolean;
      storeName?: string;
      /** P30.3：本条结论由哪条决策规则给出，写回升级项以便回看。 */
      ruleId?: string;
    },
  ): Promise<OperatingCycle> => {
    const cycle = cycles.get(storeId);
    if (!cycle) throw new Error('cycle_not_found');
    const conflict = cycle.conflicts.find((item) => item.id === conflictId);
    if (!conflict) throw new Error('conflict_not_found');
    if (conflict.decision) throw new Error('conflict_already_decided');

    const releasedProposalIds: AllMallId[] = [];
    if (decision === 'override') {
      const selectedBefore = new Set(
        cycle.proposals.filter((proposal) => proposal.status === 'selected').map((proposal) => proposal.id),
      );
      applyConflictOverride(cycle, conflict);
      cycle.proposals.forEach((proposal) => {
        if (proposal.status === 'selected' && !selectedBefore.has(proposal.id)) {
          releasedProposalIds.push(proposal.id);
        }
      });
      conflict.releasedProposalIds = releasedProposalIds;
    }
    conflict.decision = decision;
    conflict.decisionReason = reason;
    conflict.decidedAt = new Date().toISOString();
    conflict.decidedBy = options?.actor;
    conflict.decisionNote = options?.note?.trim() || undefined;
    // 改判会改变提案状态，协同组需要按最新状态重算。
    cycle.collaborations = buildCollaborations(cycle.proposals, cycle.id);

    // P30.2：人工决策先解除本店超时暂停，避免旧冻结挡住下面刚放行的动作。
    // P30.3：规则是 Agent 执行的，不算人工接手，不能顺手解冻等人处置的暂停。
    if (options?.actor !== AGENT_TIMEOUT_ACTOR && options?.actor !== AGENT_RULE_ACTOR) {
      exceptionsApi.resumeAllPaused(storeId);
    }

    // P9 改判即执行：人确认改判后，可立即把被放行的动作提交执行，不再多一次点击。
    if (decision === 'override' && options?.submitAfterOverride) {
      for (const proposalId of releasedProposalIds) {
        try {
          await orchestratorApi.submitProposal(
            storeId,
            options.storeName ?? '当前店铺',
            proposalId,
          );
        } catch {
          // 单个动作提交失败不阻塞裁决记录，失败的执行回执会单独升级到收件箱。
        }
      }
      cycle.collaborations = buildCollaborations(cycle.proposals, cycle.id);
    }

    // 人已给出结论，对应升级项就此关闭，不再重复提醒（同批次/历史批次一并关闭）。
    // P30.1：超时默认由 Agent 收尾，结论前缀必须写出真实执行者，不能一律记成“人工”。
    const deciderLabel = options?.actor ?? '人工';
    const escalationNote = `${deciderLabel}${decision === 'override' ? '改判' : '维持'}（${ARBITRATION_REASON_NOTE[reason]}）${
      conflict.decisionNote ? `：${conflict.decisionNote}` : ''
    }${conflict.decidedBy ? ` · ${conflict.decidedBy}` : ''}`;
    const escalationPrefix = `cycle-esc-${cycle.id}-`;
    const items = await exceptionsApi.list();
    const matched = items.filter(
      (item) =>
        item.id.startsWith(escalationPrefix) &&
        item.id.endsWith(`-${conflict.id}`) &&
        !item.resolved &&
        !item.ignored,
    );
    for (const item of matched) {
      await exceptionsApi.resolve(item.id, escalationNote, options?.actor, {
        outcome: decision,
        ruleId: options?.ruleId,
      });
    }
    return mockDelay(cloneCycle(cycle));
  },

  /**
   * P30.1 超时默认：决策请求到期仍无人处理时，Agent 按预设的最保守结论收尾。
   * 只替人做“维持护栏”这类不扩大权限的结论；判断错了，人可以在经营周期里改判。
   * P30.2：收尾动作按店铺策略分流——提醒 / 保守降级 / 暂停 Agent / 上报 Owner，
   * 后三者都不替人下结论，只是把人需要的注意力换一种方式送达。
   */
  applyExpiredDecisionDefaults: async (): Promise<number> => {
    const now = Date.now();
    const expired = (await exceptionsApi.list()).filter(
      (item) => !item.resolved && !item.ignored && item.decision && new Date(item.decision.deadline).getTime() <= now,
    );
    let applied = 0;
    for (const item of expired) {
      // P49：账户级条目没有归属店铺，套不到门店超时策略；按同样的 24 小时默认只收口提醒，
      // 不替人确认本月承诺——账户目标行仍显示「上期 · 待确认」，随时可由人改数或确认。
      if (item.type === 'account_goal_settlement') {
        const decision = item.decision!;
        const defaultOption = decision.options.find((option) => option.id === decision.timeoutOptionId);
        const note = `超过 ${decision.timeoutHours} 小时未决策，按默认建议「${defaultOption?.label ?? '沿用上期目标'}」收尾`;
        await exceptionsApi.resolve(
          item.id,
          `${note}（账户目标维持上期原值，本月仍未确认；可随时在账户目标行确认或改数）`,
          AGENT_TIMEOUT_ACTOR,
        );
        applied += 1;
        continue;
      }
      const ref = item.conflictRef;
      const policyStoreId = ref?.storeId ?? item.storeId;
      if (policyStoreId === undefined) continue;
      const policy = exceptionsApi.getEscalationPolicy(policyStoreId);
      if (policy.action === 'remind') {
        if (await exceptionsApi.remindDecision(item.id, policy.timeoutHours)) applied += 1;
        continue;
      }
      if (policy.action === 'pause_agent') {
        if (await exceptionsApi.pauseDecisionAgent(item.id)) applied += 1;
        continue;
      }
      if (policy.action === 'escalate_owner') {
        if (await exceptionsApi.escalateDecisionToOwner(item.id)) applied += 1;
        continue;
      }
      const decision = item.decision!;
      const defaultOption = decision.options.find((option) => option.id === decision.timeoutOptionId);
      const timeoutNote = `超过 ${decision.timeoutHours} 小时未决策，按默认建议「${defaultOption?.label ?? '维持护栏'}」收尾`;
      // P33.1：目标节奏升级没有冲突对象，超时只按最保守的默认建议（维持目标）收口，不改目标。
      if (!ref) {
        if (item.type === 'goal_pace_escalation') {
          await exceptionsApi.resolve(item.id, `${timeoutNote}（目标不变，下个周期重新评估）`, AGENT_TIMEOUT_ACTOR);
          applied += 1;
        } else if (item.type === 'goal_settlement') {
          // P34.1：上期结算的超时默认就是「沿用上期目标」，不替人改本月目标。
          await exceptionsApi.resolve(item.id, `${timeoutNote}（本月目标沿用上期原值，下期重新评估）`, AGENT_TIMEOUT_ACTOR);
          applied += 1;
        } else if (item.type === 'guard_health' && item.storeId !== undefined) {
          // P36.1：护栏升级的超时默认就是「维持当前值」，只记确认、不放宽判断边界。
          const key = guardHealthKeyOf(item.storeId, item.id);
          if (key) {
            await operatingModelApi.confirmGuard(item.storeId, key, {
              actor: AGENT_TIMEOUT_ACTOR,
              reason: timeoutNote,
            });
          }
          await exceptionsApi.resolve(
            item.id,
            `${timeoutNote}（护栏维持当前值，下次体检重新评估）`,
            AGENT_TIMEOUT_ACTOR,
          );
          applied += 1;
        } else if (item.type === 'guard_health_account' && item.guardAccount) {
          // P38.1：账户级同类护栏的超时默认同样是「各店维持当前值」，逐店确认但不改值。
          const key = asGuardHealthKey(item.guardAccount.key);
          if (key) {
            for (const storeId of item.guardAccount.storeIds) {
              await operatingModelApi.confirmGuard(storeId as AllMallId, key, {
                actor: AGENT_TIMEOUT_ACTOR,
                reason: timeoutNote,
              });
            }
          }
          await exceptionsApi.resolve(
            item.id,
            `${timeoutNote}（各店护栏维持当前值，下次体检重新评估）`,
            AGENT_TIMEOUT_ACTOR,
          );
          applied += 1;
        }
        continue;
      }
      const decide = () =>
        orchestratorApi.decideConflict(ref.storeId, ref.conflictId, 'uphold', 'manual', {
          actor: AGENT_TIMEOUT_ACTOR,
          note: timeoutNote,
        });
      try {
        await decide();
        applied += 1;
        continue;
      } catch (error) {
        if ((error as Error).message !== 'cycle_not_found') continue;
      }
      try {
        // 刷新会让内存中的本轮方案失效；先重生成同店方案，再按默认结论收尾。
        await orchestratorApi.generateCycle(ref.storeId, { trigger: 'manual', storeName: item.storeName });
        await decide();
      } catch {
        // 重生成后冲突已不存在：结论已无可执行对象，直接关闭并留下默认口径。
        await exceptionsApi.resolve(item.id, `${timeoutNote}（方案已重新生成，冲突不再存在）`, AGENT_TIMEOUT_ACTOR);
      }
      applied += 1;
    }
    return applied;
  },

  /**
   * P30.3 决策规则：人已经说过「以后都这样」，同类升级不再逐条问人。
   * - 规则只按店铺 + 决策类型匹配，不跨店、不跨类型；
   * - 只写结论，不代提交执行——执行仍走既有护栏与人工入口，错了人可在周期里改判；
   * - 冲突已随方案重生成消失时不硬造结论，条目留给超时策略。
   */
  applyDecisionRules: async (): Promise<number> => {
    const rules = exceptionsApi.listDecisionRules();
    if (rules.length === 0) return 0;
    const open = (await exceptionsApi.list()).filter(
      (item) =>
        !item.resolved &&
        !item.ignored &&
        Boolean(item.decision) &&
        Boolean(item.conflictRef) &&
        Boolean(item.decisionKind) &&
        Boolean(item.storeId),
    );
    let applied = 0;
    for (const item of open) {
      const rule = rules.find(
        (entry) => entry.storeId === item.storeId && entry.decisionKind === item.decisionKind,
      );
      if (!rule) continue;
      const ref = item.conflictRef!;
      try {
        await orchestratorApi.decideConflict(ref.storeId, ref.conflictId, rule.outcome, 'manual', {
          actor: AGENT_RULE_ACTOR,
          note: `按决策规则「以后都这样」自动收尾（依据人工已连续确认 ${rule.sourceDecisionIds.length} 次）`,
          storeName: item.storeName,
          ruleId: rule.id,
        });
        exceptionsApi.markDecisionRuleApplied(rule.id);
        applied += 1;
      } catch {
        // 冲突不存在 / 已裁决：不做任何猜测，保留条目交给后续策略。
      }
    }
    return applied;
  },

  /** P3.5 多店铺经营概览：逐店汇总目标差距 + 本周/上周回写 + 周期状态。 */
  getPortfolio: async (storeIds: AllMallId[]): Promise<StorePortfolioRow[]> => {
    const weekStart = getWeekStart().valueOf();
    const lastWeekStart = getWeekStart().subtract(7, 'day').valueOf();

    const rows = await Promise.all(
      storeIds.map(async (storeId) => {
        ensureHistory(storeId);
        const goal = (await operatingModelApi.getGoal(storeId)) as StoreGoal;
        const cycle = cycles.get(storeId);
        const outcomes = getOutcomes(storeId);
        const realized = outcomes.filter((outcome) => outcome.status === 'realized');
        const sumSince = (from: number, to: number) =>
          realized
            .filter((outcome) => {
              const recordedAt = dayjs(outcome.recordedAt).valueOf();
              return recordedAt >= from && recordedAt < to;
            })
            .reduce((total, outcome) => total + (outcome.actualImpact ?? 0), 0);

        return {
          storeId,
          goal,
          gapPct: goal.target > 0 ? Math.max(0, Math.round((1 - goal.current / goal.target) * 100)) : 0,
          attributedThisWeek: sumSince(weekStart, Number.MAX_SAFE_INTEGER),
          attributedLastWeek: sumSince(lastWeekStart, weekStart),
          realizedThisWeek: realized.filter(
            (outcome) => dayjs(outcome.recordedAt).valueOf() >= weekStart,
          ).length,
          pendingCount: outcomes.filter((outcome) => outcome.status === 'projected').length,
          proposalCount: cycle?.proposals.length ?? 0,
          hasCycle: Boolean(cycle?.generatedAt),
        };
      }),
    );

    return mockDelay(rows.sort((a, b) => b.gapPct - a.gapPct));
  },

  /**
   * P4 跨店冲突仲裁：在账户层面统一调度多店候选动作。
   * 1) 共享广告预算按目标差距分配，未获配的店铺本轮延后；
   * 2) 同一商品在一店提价、另一店折扣/清仓时，标记价格方向不一致。
   * 未生成周期的店铺使用同一套候选提案参与评估，避免“必须逐店点生成才能看冲突”。
   */
  getCrossStoreArbitration: async (storeIds: AllMallId[]): Promise<CrossStoreArbitration> => {
    const entries = await Promise.all(
      storeIds.map(async (storeId) => {
        ensureHistory(storeId);
        const goal = (await operatingModelApi.getGoal(storeId)) as StoreGoal;
        const cycle = cycles.get(storeId);
        let proposals: CycleProposal[];
        if (cycle) {
          proposals = cycle.proposals
            .filter((proposal) => proposal.status !== 'submitted')
            .map((proposal) => ({ ...proposal }));
        } else {
          proposals = buildProposals(cycleIdOf(storeId));
          const effective = operatingModelApi.getEffectivePolicy(storeId);
          const shortageCount = (await inventoryApi.list({ storeId })).filter(
            (item) => item.currentStock < item.safetyStock,
          ).length;
          arbitrate(
            proposals,
            goal,
            { ...effective.guards, budgetPool: effective.budgetPool },
            cycleIdOf(storeId),
            shortageCount,
            directionPreferences.get(storeId),
          );
        }
        return {
          storeId,
          goal,
          proposals,
          gapPct: goal.target > 0 ? Math.max(0, Math.round((1 - goal.current / goal.target) * 100)) : 0,
        };
      }),
    );

    const conflicts: CrossStoreConflict[] = [];

    // 1) 共享广告预算：目标差距越大越优先获得预算。
    const demands = entries
      .map((entry) => {
        const ad = entry.proposals.find(
          (proposal) =>
            proposal.action === 'increase_ad_budget' &&
            (proposal.status === 'selected' || proposal.status === 'deferred'),
        );
        return ad ? { storeId: entry.storeId, cost: ad.cost, gapPct: entry.gapPct } : null;
      })
      .filter((item): item is { storeId: AllMallId; cost: number; gapPct: number } => item !== null)
      .sort((a, b) => b.gapPct - a.gapPct);

    let remaining = SHARED_AD_POOL_REMAINING;
    const funded: AllMallId[] = [];
    const unfunded: AllMallId[] = [];
    demands.forEach((demand) => {
      if (remaining >= demand.cost) {
        remaining -= demand.cost;
        funded.push(demand.storeId);
      } else {
        unfunded.push(demand.storeId);
      }
    });
    if (unfunded.length > 0) {
      conflicts.push({
        id: 'cross-budget',
        type: 'budget',
        targetLabel: '店铺 · 全站推广',
        winnerStoreIds: funded,
        loserStoreIds: unfunded,
        basis: 'goal_priority',
        detail: {
          remainingBudget: SHARED_AD_POOL_REMAINING,
          requestedBudget: demands.reduce((sum, demand) => sum + demand.cost, 0),
          allocatedBudget: SHARED_AD_POOL_REMAINING - remaining,
        },
      });
    }

    // 2) 同款跨店价格方向：同一商品在一店提价、另一店折扣/清仓。
    const byTarget = new Map<string, { raises: AllMallId[]; discounts: AllMallId[] }>();
    entries.forEach((entry) => {
      entry.proposals.forEach((proposal) => {
        if (proposal.status !== 'selected') return;
        const bucket = byTarget.get(proposal.targetLabel) ?? { raises: [], discounts: [] };
        if (proposal.action === 'raise_price') bucket.raises.push(entry.storeId);
        if (proposal.action === 'increase_discount' || proposal.action === 'clear_stock') {
          bucket.discounts.push(entry.storeId);
        }
        byTarget.set(proposal.targetLabel, bucket);
      });
    });
    byTarget.forEach((bucket, targetLabel) => {
      if (bucket.raises.length === 0 || bucket.discounts.length === 0) return;
      conflicts.push({
        id: `cross-price-${conflicts.length + 1}`,
        type: 'price_direction',
        targetLabel,
        winnerStoreIds: [],
        loserStoreIds: [...bucket.raises, ...bucket.discounts],
        basis: 'goal_priority',
        detail: {
          raiseStoreIds: bucket.raises,
          discountStoreIds: bucket.discounts,
        },
      });
    });

    // 3) 共享库存：同一 SKU 在一店低于安全库存、另一店有富余 → 建议跨店调拨。
    const scopedStoreIds = new Set(storeIds);
    const inventory = (await inventoryApi.list()).filter((item) => scopedStoreIds.has(item.storeId));
    const bySku = new Map<string, InventoryItem[]>();
    inventory.forEach((item) => {
      const bucket = bySku.get(item.skuCode) ?? [];
      bucket.push(item);
      bySku.set(item.skuCode, bucket);
    });
    bySku.forEach((bucket) => {
      if (bucket.length < 2) return;
      const shortages = bucket.filter((item) => item.currentStock < item.safetyStock);
      const surpluses = bucket.filter((item) => item.currentStock > item.safetyStock);
      if (shortages.length === 0 || surpluses.length === 0) return;
      shortages.forEach((shortage) => {
        const surplus = [...surpluses].sort(
          (a, b) => b.currentStock - b.safetyStock - (a.currentStock - a.safetyStock),
        )[0];
        const shortageQty = shortage.safetyStock - shortage.currentStock;
        const surplusQty = surplus.currentStock - surplus.safetyStock;
        // 调拨量：补足安全库存 + 约 3 天销量，但不超过富余店的可用富余量。
        const suggestedTransfer = Math.min(
          surplusQty,
          shortageQty + Math.ceil(shortage.dailySales * 3),
        );
        if (suggestedTransfer <= 0) return;
        conflicts.push({
          id: `cross-inventory-${conflicts.length + 1}`,
          type: 'inventory',
          targetLabel: `${shortage.skuCode} · ${shortage.skuName}`,
          winnerStoreIds: [shortage.storeId],
          loserStoreIds: [surplus.storeId],
          basis: 'stock_guardrail',
          detail: {
            skuCode: shortage.skuCode,
            shortageStock: shortage.currentStock,
            surplusStock: surplus.currentStock,
            safetyStock: shortage.safetyStock,
            suggestedTransfer,
          },
        });
      });
    });

    return mockDelay({
      sharedAdBudget: {
        available: SHARED_AD_POOL_REMAINING,
        requested: demands.reduce((sum, demand) => sum + demand.cost, 0),
        allocated: SHARED_AD_POOL_REMAINING - remaining,
      },
      conflicts,
      plans: buildCrossStorePlans(conflicts, entries).map((plan) => {
        const state = crossStorePlanStates.get(plan.id);
        return state ? { ...plan, ...state } : plan;
      }),
    });
  },

  /**
   * P7 跨店升级：把“待拍板”的跨店方案送进收件箱。
   * 已采纳/已忽略的方案不再升级；已处理的升级项由 upsertEscalation 保证不复活。
   */
  escalateCrossStore: async (
    storeIds: AllMallId[],
    storeNames: Record<number, string> = {},
  ): Promise<number> => {
    if (storeIds.length < 2) return 0;
    const arbitration = await orchestratorApi.getCrossStoreArbitration(storeIds);
    const pending = arbitration.plans.filter((plan) => plan.status === 'suggested');
    for (const plan of pending) {
      await exceptionsApi.upsertEscalation(buildCrossStoreEscalation(plan, storeNames));
    }
    return pending.length;
  },

  /**
   * 采纳跨店方案 = 跨店闭环的执行入口：
   * 1) 按稳定哈希模拟平台回执（成功/失败/超时）；
   * 2) 成功才把收益回写到受益店铺目标，失败/超时记 lost；
   * 3) 关闭收件箱里的待拍板升级项，失败/超时再生成一条执行失败升级。
   */
  acceptCrossStorePlan: async (
    storeIds: AllMallId[],
    planId: string,
    storeNames: Record<number, string> = {},
    actor?: string,
  ): Promise<{ plan: CrossStorePlan; executionStatus: ExecutionStatus; outcome?: GoalOutcome }> => {
    const arbitration = await orchestratorApi.getCrossStoreArbitration(storeIds);
    const plan = arbitration.plans.find((item) => item.id === planId);
    if (!plan) throw new Error('cross_plan_not_found');
    if (plan.status === 'accepted' && plan.executionStatus) {
      return { plan, executionStatus: plan.executionStatus };
    }

    const executionStatus = simulateCrossStoreExecution(plan.id);
    crossStorePlanStates.set(plan.id, {
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      acceptedBy: actor,
      executionStatus,
    });

    const outcome = outcomesApi.recordCrossStore({
      storeId: plan.ownerStoreId,
      cycleId: cycleIdOf(plan.ownerStoreId),
      agentType: plan.leadAgent,
      action: plan.action,
      targetLabel: plan.targetLabel,
      metric: plan.metric,
      expectedImpact: plan.expectedImpact,
      status: executionStatus === 'succeeded' ? 'realized' : 'lost',
      executionStatus,
    });

    await exceptionsApi.resolve(`cross-esc-${plan.id}`, '跨店协同方案已采纳');
    if (executionStatus !== 'succeeded') {
      await exceptionsApi.upsertEscalation({
        id: `cross-exec-${plan.id}`,
        type: 'cross_store_escalation',
        storeName: storeNameOf(plan.ownerStoreId, storeNames),
        agentType: plan.leadAgent,
        level: executionStatus === 'failed' ? 'critical' : 'warning',
        title: `${executionStatus === 'failed' ? '跨店执行失败' : '跨店执行超时'} · ${plan.targetLabel}`,
        summary: '跨店协同方案已采纳，但未拿到平台成功回执，本轮效果未计入目标进度。',
        detail: 'Agent 已停止重试，避免跨店重复改价或重复调拨。',
        suggestedAction: '到各店铺确认动作是否生效；若未生效，请重新评估跨店方案后再采纳。',
        createdAt: new Date().toISOString(),
        resolved: false,
        ignored: false,
        linkTo: '/dashboard',
      });
    }

    return {
      plan: { ...plan, ...crossStorePlanStates.get(plan.id) },
      executionStatus,
      outcome,
    };
  },

  /** 忽略跨店方案 = 本轮不协同；对应升级项标记为已忽略，不参与后续提醒。 */
  dismissCrossStorePlan: async (storeIds: AllMallId[], planId: string): Promise<CrossStorePlan> => {
    const arbitration = await orchestratorApi.getCrossStoreArbitration(storeIds);
    const plan = arbitration.plans.find((item) => item.id === planId);
    if (!plan) throw new Error('cross_plan_not_found');
    crossStorePlanStates.set(plan.id, { status: 'dismissed' });
    await exceptionsApi.ignore(`cross-esc-${plan.id}`, '跨店协同方案已忽略');
    return { ...plan, status: 'dismissed' };
  },

  /** 生成本轮方案：诊断目标差距 → 汇总跨 Agent 提案 → 仲裁冲突。 */
  generateCycle: async (
    storeId: AllMallId,
    options?: { trigger?: CycleTrigger; reason?: 'cadence' | 'stock_alert'; storeName?: string },
  ): Promise<OperatingCycle> => {
    const goal = (await operatingModelApi.getGoal(storeId)) as StoreGoal;
    const effective = operatingModelApi.getEffectivePolicy(storeId);
    const cycleId = cycleIdOf(storeId);
    // S1/S4：Agent 是运营主体 — 关闭的 Agent 不再产出提案；没有开启任何 Agent 就不生成方案。
    const agentConfigs = await agentsApi.list();
    if (!agentConfigs.some((agent) => agent.enabled)) throw new Error('no_agent_enabled');
    const agentEnabled = (agentType: CycleProposal['agentType']) => {
      const config = agentConfigs.find((agent) => agent.agentType === agentType);
      return config ? config.enabled : true;
    };
    // P30.2：超时选择了「暂停该 Agent」时，本轮不再产出它的提案；
    // 已暂停 Agent 的既有提案也无法提交，人处理决策后自动解冻。
    const pausedAgents = exceptionsApi.listPausedAgents(storeId).map((agent) => agent.agentType);
    // P3：已执行/已提交过的动作不再重复提案，避免同一动作反复刷目标进度。
    // S3：执行失败/超时（lost 且没有审批单）的动作允许重试，否则一次失败就永远不再出现。
    const history = getOutcomes(storeId);
    const blocksProposal = (outcome: GoalOutcome) =>
      outcome.status !== 'lost' || Boolean(outcome.approvalId);
    // B：行业专属型店铺对对应领域的提案给更高收益系数，通用型保持中性。
    const profile = await agentProfilesApi.getProfile(storeId);
    // P5 依赖门控依据：本店仍有 SKU 低于安全库存时，加投需要先看补货是否到位。
    const inventoryShortageCount = (await inventoryApi.list()).filter(
      (item) => item.storeId === storeId && item.currentStock < item.safetyStock,
    ).length;
    const proposals = buildProposals(cycleId)
      .filter((proposal) => agentEnabled(proposal.agentType))
      .filter((proposal) => !pausedAgents.includes(proposal.agentType))
      .filter(
        (proposal) =>
          !history.some(
            (outcome) =>
              outcome.action === proposal.action &&
              outcome.targetLabel === proposal.targetLabel &&
              blocksProposal(outcome),
          ),
      )
      .map((proposal) => {
        const domain = AGENT_TYPE_DOMAIN[proposal.agentType];
        if (!domain || !isSpecialized(profile, domain)) return proposal;
        return {
          ...proposal,
          expectedImpact: Math.round(proposal.expectedImpact * SPECIALIZED_BOOST),
        };
      });
    const conflicts = arbitrate(
      proposals,
      goal,
      { ...effective.guards, budgetPool: effective.budgetPool },
      cycleId,
      inventoryShortageCount,
      directionPreferences.get(storeId),
    );
    const collaborations = buildCollaborations(proposals, cycleId);
    const cycle: OperatingCycle = {
      id: cycleId,
      storeId,
      periodLabel: goal.periodLabel,
      stage: 'execute',
      generatedAt: new Date().toISOString(),
      diagnosis: {
        metric: goal.metric,
        target: goal.target,
        current: goal.current,
        gapPct: goal.target > 0 ? Math.max(0, Math.round((1 - goal.current / goal.target) * 100)) : 0,
        priority: goal.priority,
      },
      proposals,
      conflicts,
      collaborations,
      outcomes: history,
      triggeredBy: options?.trigger ?? 'manual',
      triggerReason: options?.reason,
      guardSnapshot: {
        minGrossMargin: goal.constraints.minGrossMargin,
        maxDiscountPct: goal.constraints.maxDiscountPct,
        monthlyBudgetCap: goal.constraints.monthlyBudgetCap,
      },
    };
    cycles.set(storeId, cycle);
    // P6：被拦截/延后的动作主动升级到收件箱，让人接手而不是等人翻抽屉。
    await escalateCycle(cycle, options?.storeName ?? '当前店铺');
    return mockDelay(cloneCycle(cycle));
  },

  /** P6 自动运转开关：默认开启，按 24h 节奏或库存告急事件触发。 */
  getAutoTrigger: (storeId: AllMallId): Promise<AutoTriggerConfig> =>
    mockDelay(autoConfigs.get(storeId) ?? { ...DEFAULT_AUTO_CONFIG }),

  setAutoTrigger: (
    storeId: AllMallId,
    patch: Partial<Pick<AutoTriggerConfig, 'enabled' | 'autoSubmitLowRisk'>>,
  ): Promise<AutoTriggerConfig> => {
    const next = { ...(autoConfigs.get(storeId) ?? DEFAULT_AUTO_CONFIG), ...patch };
    autoConfigs.set(storeId, next);
    return mockDelay({ ...next });
  },

  /**
   * 调度真值读取：不做「默认运行中」的假设。
   * 只有巡检循环真的挂载、且心跳未过期才算在线；离线时返回上一次巡检时间供人判断空窗。
   */
  getSchedulerStatus: (): Promise<SchedulerStatus> => {
    const last = schedulerRuntime.lastPatrolAt ? dayjs(schedulerRuntime.lastPatrolAt) : undefined;
    const fresh = Boolean(last && dayjs().diff(last, 'millisecond') < SCHEDULER_STALE_MS);
    return mockDelay({
      mode: SCHEDULER_MODE,
      active: schedulerRuntime.active,
      online: schedulerRuntime.active && fresh,
      lastPatrolAt: schedulerRuntime.lastPatrolAt,
      nextPatrolAt: schedulerRuntime.nextPatrolAt,
      stoppedAt: schedulerRuntime.stoppedAt,
      intervalSeconds: Math.round(PATROL_INTERVAL_MS / 1000),
      checkedStoreCount: schedulerRuntime.checkedStoreCount,
    });
  },

  /** 页面挂载/卸载时登记调度循环的在位状态，让「离线」不是靠猜。 */
  setSchedulerActive: (active: boolean): void => {
    schedulerRuntime.active = active;
    if (active) {
      schedulerRuntime.stoppedAt = undefined;
      schedulerRuntime.nextPatrolAt = new Date(Date.now() + PATROL_INTERVAL_MS).toISOString();
      return;
    }
    schedulerRuntime.stoppedAt = new Date().toISOString();
    schedulerRuntime.nextPatrolAt = undefined;
  },

  /** 立即对当前周期执行一次“自动执行低风险”，不用等下一轮调度。 */
  autoSubmitLowRisk: async (storeId: AllMallId, storeName?: string): Promise<number> =>
    mockDelay(await submitSelectedLowRisk(storeId, storeName ?? '当前店铺')),

  /**
   * 模拟调度器的一轮检查（工作台常驻定时器每轮调用）：
   * 1) 事件优先：缺货集合发生变化且当前周期没有可执行的补货动作 → 立即生成；
   * 2) 定时兜底：距上次生成超过配置节奏 → 重新诊断；
   * 3) 开启“自动执行低风险”时，把低风险且策略允许自动通过的动作直接提交，
   *    人只需要处理被拦下/失败的升级项。
   * 同一缺货指纹只触发一次，避免每轮调度都重复生成。
   */
  runAutoTriggers: async (
    storeIds: AllMallId[],
    storeNames: Record<number, string> = {},
  ): Promise<AutoTriggerResult[]> => {
    const results: AutoTriggerResult[] = [];
    for (const storeId of storeIds) {
      const config = autoConfigs.get(storeId) ?? DEFAULT_AUTO_CONFIG;
      if (!config.enabled) {
        results.push({ storeId, triggered: false });
        continue;
      }
      const cycle = cycles.get(storeId);
      const shortages = (await inventoryApi.list({ storeId })).filter(
        (item) => item.currentStock < item.safetyStock,
      );
      const fingerprint = shortages.map((item) => item.skuCode).sort().join('|');
      const hasRestockInCycle = Boolean(
        cycle?.proposals.some(
          (proposal) =>
            proposal.action === 'replenish_stock' &&
            (proposal.status === 'selected' || proposal.status === 'submitted'),
        ),
      );
      const hoursSince = cycle?.generatedAt
        ? dayjs().diff(dayjs(cycle.generatedAt), 'hour', true)
        : Number.POSITIVE_INFINITY;

      let trigger: CycleTrigger | undefined;
      let reason: 'cadence' | 'stock_alert' | undefined;
      if (
        shortages.length > 0 &&
        lastShortageFingerprint.get(storeId) !== fingerprint &&
        !hasRestockInCycle
      ) {
        trigger = 'event';
        reason = 'stock_alert';
      } else if (hoursSince >= config.cadenceHours) {
        trigger = 'schedule';
        reason = 'cadence';
      }

      if (!trigger) {
        results.push({ storeId, triggered: false });
        continue;
      }
      const next = await orchestratorApi.generateCycle(storeId, {
        trigger,
        reason,
        storeName: storeNames[storeId],
      });
      lastShortageFingerprint.set(storeId, fingerprint);
      const autoSubmitted = config.autoSubmitLowRisk
        ? await submitSelectedLowRisk(storeId, storeNames[storeId] ?? '当前店铺')
        : 0;
      results.push({
        storeId,
        triggered: true,
        trigger,
        reason,
        generatedAt: next.generatedAt,
        autoSubmitted,
      });
    }
    // P7：周期生成后立即评估跨店冲突，把需要人拍板的方案送进收件箱。
    await orchestratorApi.escalateCrossStore(storeIds, storeNames);
    // P28.3：一轮巡检结束才更新心跳 — 界面上的「上次/下次巡检」对应真实发生过的巡检，
    // 而不是周期生成时间。
    schedulerRuntime.lastPatrolAt = new Date().toISOString();
    schedulerRuntime.nextPatrolAt = new Date(Date.now() + PATROL_INTERVAL_MS).toISOString();
    schedulerRuntime.checkedStoreCount = storeIds.length;
    return mockDelay(results);
  },

  /**
   * P35.1 治理自巡检：目标跨月结算、节奏升级、护栏健康升级、决策规则与超时默认，
   * 过去都挂在「某张卡 / 收件箱被打开」上；人不进那两个页面，Agent 就等于没巡检。
   * 现在由调用方（工作台巡逻 / 应用进入）按全部已连接店铺跑一遍，幂等且只回变化量。
   */
  runGovernanceSweep: async (storeIds?: AllMallId[]): Promise<GovernanceSweepResult> => {
    const ids = storeIds ?? stores.filter((store) => store.status === 'connected').map((store) => store.id);
    let settled = 0;
    let paceChanged = 0;
    let guardChanged = 0;
    let guardRestored = 0;
    let guardExpiryCleared = 0;
    let cycleReplanned = 0;
    for (const storeId of ids) {
      const period = await operatingModelApi.settleGoalPeriod(storeId);
      if (period.settled) settled += 1;
      const pace = await operatingModelApi.syncGoalPaceEscalation(storeId);
      if (pace.escalated || pace.closed > 0) paceChanged += 1;
      // P47：临时护栏到期由 Agent 收回；人后来改过的字段只清标记、不覆盖。
      const expiries = await operatingModelApi.restoreExpiredGuards(storeId);
      guardRestored += expiries.restored;
      guardExpiryCleared += expiries.cleared;
      // P55.1：护栏是 Agent 自己收回的，方案也由 Agent 自己跟上，不把「补跑」留给人。
      if (expiries.restored > 0 && (await replanCycleAfterGuardRestore(storeId))) {
        cycleReplanned += 1;
      }
    }
    // P38.1：护栏升级按账户口径一次同步，同一条护栏的多店提醒在这里合并。
    const guard = await syncGuardEscalationsAcross(ids);
    guardChanged = guard.changedStores;
    // P49：账户上期结论不再只挂在账户目标行；巡检把「上期事实 + 沿用 / 下调」推进待办，
    // 本月已重新确认时自动收口，人不进工作台也能在收件箱看到该表态的事。
    const account = await operatingModelApi.syncAccountGoalSettlementEscalation();
    const accountChanged = account.escalated || account.closed > 0 ? 1 : 0;
    // 全局收尾：人的决策规则优先，其次超时默认；两者都只处理已到期/已可判定的条目。
    const ruleApplied = await orchestratorApi.applyDecisionRules();
    const expiredApplied = await orchestratorApi.applyExpiredDecisionDefaults();
    // P51：审批时限也由 Agent 收尾，不再只显示「已到期」却继续让人点通过/拒绝。
    const approvalTimedOut = expireDueApprovals();
    const changed =
      settled +
        paceChanged +
        guardChanged +
        accountChanged +
        ruleApplied +
        expiredApplied +
        approvalTimedOut +
        guardRestored +
        guardExpiryCleared +
        cycleReplanned >
      0;
    return {
      storeCount: ids.length,
      settled,
      paceChanged,
      guardChanged,
      ruleApplied,
      expiredApplied,
      guardRestored,
      guardExpiryCleared,
      cycleReplanned,
      accountChanged,
      approvalTimedOut,
      changed,
    };
  },

  /** 提交单个提案执行 — 走 P1 策略：可能自动执行，也可能进入待办审批。 */
  submitProposal: async (
    storeId: AllMallId,
    storeName: string,
    proposalId: AllMallId,
  ): Promise<ApprovalCreateResult & { outcome: GoalOutcome; executionStatus?: ExecutionStatus }> => {
    const cycle = cycles.get(storeId);
    const proposal = cycle?.proposals.find((p) => p.id === proposalId);
    if (!cycle || !proposal || proposal.status !== 'selected') {
      throw new Error('proposal_not_ready');
    }
    // P30.2：超时暂停期间，该 Agent 的提案不能被提交；人的决策会解除冻结。
    if (exceptionsApi.isAgentPaused(storeId, proposal.agentType)) {
      throw new Error('agent_paused');
    }
    const result = await approvalsApi.create({
      taskId: proposal.id,
      storeId,
      storeName,
      agentType: proposal.agentType,
      title: `${proposal.targetLabel} · ${proposal.after}`,
      reason: `${cycle.periodLabel}经营周期提案：${proposal.before} → ${proposal.after}`,
      proposedAction: proposal.action,
      beforeValue: proposal.before,
      afterValue: proposal.after,
      riskLevel: proposal.riskLevel,
      // P57：冻结提交时的经济口径。人之后收紧护栏时，审批页能按新边界复核这条在途动作，
      // 而不是让它凭旧判断直接执行。
      guardContext: {
        action: proposal.action,
        cost: proposal.cost,
        projectedGrossMargin: proposal.projectedGrossMargin,
        discountPct: proposal.discountPct,
        priority: cycle.diagnosis.priority,
      },
    });
    proposal.status = 'submitted';
    // P6 执行回执：自动执行也要区分成功 / 失败 / 超时，失败时升级给人并停止重试。
    const executionStatus = result.autoExecuted ? simulateExecution(proposal, storeId) : undefined;
    // P3 归因：自动执行立即回写目标进度；进入审批则先挂账，通过后再回写。
    const outcome = outcomesApi.recordForProposal({
      storeId,
      cycleId: cycle.id,
      proposal,
      metric: cycle.diagnosis.metric,
      status: !result.autoExecuted
        ? 'projected'
        : executionStatus === 'succeeded'
          ? 'realized'
          : 'lost',
      approvalId: result.approval?.id,
      executionStatus,
    });
    if (executionStatus && executionStatus !== 'succeeded') {
      await escalateExecutionFailure(cycle, storeName, proposal, executionStatus);
    }
    return { ...result, outcome, executionStatus };
  },
};

/**
 * 刷新持久化：周期、裁决偏好、跨店方案人为状态、自动运行配置都必须在刷新后保留，
 * 否则“Agent 跑到一半、人刚拍板完”的状态会被种子数据覆盖。
 */
registerMockState(
  'orchestrator',
  () => ({
    cycles: [...cycles.entries()],
    directionPreferences: [...directionPreferences.entries()],
    crossStorePlanStates: [...crossStorePlanStates.entries()],
    autoConfigs: [...autoConfigs.entries()],
    lastShortageFingerprint: [...lastShortageFingerprint.entries()],
    // active 不入快照：刷新后必须由页面重新登记，避免“上次打开过页面”被误读成仍在线。
    schedulerRuntime: {
      lastPatrolAt: schedulerRuntime.lastPatrolAt,
      nextPatrolAt: schedulerRuntime.nextPatrolAt,
      stoppedAt: schedulerRuntime.stoppedAt,
      checkedStoreCount: schedulerRuntime.checkedStoreCount,
    },
  }),
  (value) => {
    const data = value as
      | Partial<{
          cycles: [AllMallId, OperatingCycle][];
          directionPreferences: [AllMallId, 'raise' | 'discount'][];
          crossStorePlanStates: [
            string,
            {
              status: CrossStorePlanStatus;
              acceptedAt?: string;
              acceptedBy?: string;
              executionStatus?: ExecutionStatus;
            },
          ][];
          autoConfigs: [AllMallId, AutoTriggerConfig][];
          lastShortageFingerprint: [AllMallId, string][];
          schedulerRuntime: {
            lastPatrolAt?: string;
            nextPatrolAt?: string;
            stoppedAt?: string;
            checkedStoreCount?: number;
          };
        }>
      | null;
    if (!data) return;
    cycles.clear();
    (data.cycles ?? []).forEach(([storeId, cycle]) => cycles.set(storeId, cycle));
    directionPreferences.clear();
    (data.directionPreferences ?? []).forEach(([storeId, direction]) => directionPreferences.set(storeId, direction));
    crossStorePlanStates.clear();
    (data.crossStorePlanStates ?? []).forEach(([planId, state]) => crossStorePlanStates.set(planId, state));
    autoConfigs.clear();
    (data.autoConfigs ?? []).forEach(([storeId, config]) => autoConfigs.set(storeId, config));
    lastShortageFingerprint.clear();
    (data.lastShortageFingerprint ?? []).forEach(([storeId, fingerprint]) => lastShortageFingerprint.set(storeId, fingerprint));
    schedulerRuntime.lastPatrolAt = data.schedulerRuntime?.lastPatrolAt;
    schedulerRuntime.nextPatrolAt = data.schedulerRuntime?.nextPatrolAt;
    schedulerRuntime.stoppedAt = data.schedulerRuntime?.stoppedAt;
    schedulerRuntime.checkedStoreCount = data.schedulerRuntime?.checkedStoreCount ?? 0;
  },
);
