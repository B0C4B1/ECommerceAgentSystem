/**
 * File: operatingModel.ts
 * Purpose: P1 经营模型 — 店铺目标（Goal）与运营策略（Policy）的 mock 存储与解析层。
 *
 * 为什么需要这一层：审批是否发生不再由全局风险等级单独决定，而是
 * riskLevel × 店铺生效自主等级。此前 autonomy 只写进场景配置，没有任何消费方，
 * 导致「托管」拨盘不改变实际审批量。所有审批判定统一走本文件的 resolver。
 */
import dayjs from 'dayjs';
import { mockDelay } from './client';
import { getAuditLogs, recordAuditLog } from './auditLogger';
import { getStoreOperatingBaseline } from './businessDashboard';
import { exceptionsApi } from './exceptions';
import { stores } from './mockData';
import { registerMockState, saveMockPersistence } from './mockPersistence';
import { getScenarioAutonomy, getScenarioForAgent } from './scenarioData';
import type {
  AccountGoal,
  AllMallId,
  ApprovalPolicy,
  ApprovalRequirement,
  AutonomyLevel,
  EffectivePolicy,
  GoalMetric,
  GoalPeriodSettlement,
  GuardExpiries,
  MerchantProfile,
  OperatingPolicy,
  RiskLevel,
  StoreGoal,
} from '../types/domain';

/** 中小商家通用型模板 — 开箱即用的默认值。 */
const GENERAL_PROFILE: MerchantProfile = { type: 'general', industry: '综合', scale: 'small' };

const DEFAULT_BUDGET_POOL = { adMonthly: 10000, promoMonthly: 5000 };
/** 不可编辑的系统底线；毛利/折扣/月预算三项由 StoreGoal.constraints 单源派生。 */
const DEFAULT_GUARDS = {
  minGrossMargin: 20,
  maxDiscountPct: 30,
  maxPriceChangePct: 15,
  autoRefundCap: 20,
};

/** P37.1 账户护栏的兜底值：与人从未设定时单店目标卡看到的模板值同源，避免两处默认值各写一份。 */
export const GUARD_TEMPLATE: StoreGoal['constraints'] = {
  minGrossMargin: DEFAULT_GUARDS.minGrossMargin,
  maxDiscountPct: DEFAULT_GUARDS.maxDiscountPct,
  monthlyBudgetCap: DEFAULT_BUDGET_POOL.adMonthly + DEFAULT_BUDGET_POOL.promoMonthly,
};

/** 自主等级 × 风险等级 → 审批要求。L3 仍保留高风险单人审批作为安全底线。 */
const REQUIREMENT_MATRIX: Record<AutonomyLevel, Record<RiskLevel, ApprovalRequirement>> = {
  L1: { low: 'single', medium: 'single', high: 'dual' },
  L2: { low: 'auto', medium: 'single', high: 'dual' },
  L3: { low: 'auto', medium: 'auto', high: 'single' },
};

const goalSeeds = [
  { target: 180000, ratio: 0.62, priority: 'growth' as const },
  // 演示：这家店的目标是上个月设的、跨月后还没确认，用来验证周期归属与上期结算。
  { target: 260000, ratio: 0.48, priority: 'profit' as const, monthsAgo: 1 },
  // 演示 P34.1：同样跨月，但上期没达成（上一自然月实际约为目标的 69%），结算后应进待办。
  { target: 320000, ratio: 0.71, priority: 'growth' as const, monthsAgo: 1 },
  { target: 150000, ratio: 0.35, priority: 'clearance' as const },
  { target: 420000, ratio: 0.55, priority: 'profit' as const },
];

const goals: StoreGoal[] = [];
const policies: OperatingPolicy[] = [];
/** P29.3 账户级目标：全账户只有一个，人设定后由 Agent 分配到店。 */
let accountGoal: AccountGoal | null = null;

/** P33.2：目标归属月份只有一种格式（YYYY-MM），可直接按字符串比较先后。 */
function currentPeriodKey() {
  return dayjs().format('YYYY-MM');
}

function defaultGoal(storeId: AllMallId): StoreGoal {
  const seed = goalSeeds[storeId % goalSeeds.length];
  const monthsAgo = seed.monthsAgo ?? 0;
  return {
    storeId,
    metric: 'gmv',
    target: seed.target,
    current: Math.round(seed.target * seed.ratio),
    horizon: 'month',
    periodLabel: '本月',
    periodKey: dayjs().subtract(monthsAgo, 'month').format('YYYY-MM'),
    priority: seed.priority,
    constraints: {
      minGrossMargin: GUARD_TEMPLATE.minGrossMargin,
      maxDiscountPct: GUARD_TEMPLATE.maxDiscountPct,
      monthlyBudgetCap: GUARD_TEMPLATE.monthlyBudgetCap,
    },
    updatedAt: dayjs().subtract(monthsAgo, 'month').toISOString(),
  };
}

/**
 * 护栏派生：唯一可编辑源是 StoreGoal.constraints。
 * 目标尚未建立时用默认模板，保证店铺详情与工作台的默认值一致。
 */
function deriveGuards(storeId: AllMallId): EffectivePolicy['guards'] {
  const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
  return {
    minGrossMargin: goal.constraints.minGrossMargin,
    maxDiscountPct: goal.constraints.maxDiscountPct,
    monthlyBudgetCap: goal.constraints.monthlyBudgetCap,
    maxPriceChangePct: DEFAULT_GUARDS.maxPriceChangePct,
    autoRefundCap: DEFAULT_GUARDS.autoRefundCap,
  };
}

/** 需要留痕的三项关键护栏：改一项就记一条，人能逐项追责。 */
const GUARD_FIELDS: Array<{
  key: keyof StoreGoal['constraints'];
  label: string;
  format: (value: number) => string;
}> = [
  { key: 'minGrossMargin', label: '毛利率下限', format: (v) => `${v}%` },
  { key: 'maxDiscountPct', label: '折扣上限', format: (v) => `${v}%` },
  {
    key: 'monthlyBudgetCap',
    label: '月度预算上限',
    format: (v) => `¥${new Intl.NumberFormat('zh-CN').format(v)}`,
  },
];

export interface GuardChange {
  field: keyof StoreGoal['constraints'];
  label: string;
  from: string;
  to: string;
}

/** 对比当前生效护栏与新护栏，返回将被留痕的变更项。 */
export function diffGuards(current: StoreGoal['constraints'], next: StoreGoal['constraints']): GuardChange[] {
  return GUARD_FIELDS.filter((item) => current[item.key] !== next[item.key]).map((item) => ({
    field: item.key,
    label: item.label,
    from: item.format(current[item.key]),
    to: item.format(next[item.key]),
  }));
}

/** 护栏变更的确认信息：旧值→新值之外的「为什么、谁确认的」。 */
export interface GuardChangeMeta {
  reason: string;
  actor: string;
  actorRole?: string;
  /** P47：本次变更临时生效的天数；不传表示长期生效。 */
  expiresInDays?: number;
}

/**
 * P29.1 Agent 目标提议：Agent 用近 30 天真实经营数据给出「按当前节奏能否达成」，
 * 人只做「采用 / 不采用」的决策，不再自己算目标和预算。
 * 数字全部来自同一套日 GMV 生成器（businessDashboard），不另造演示值。
 */
export interface GoalProposal {
  storeId: AllMallId;
  metric: GoalMetric;
  currentTarget: number;
  /** 月末预计 GMV（按近 14 天日均推算）。 */
  projectedMonthGmv: number;
  /** 预计达成率，1 = 100%。 */
  achievedPct: number;
  verdict: 'over' | 'on_track' | 'at_risk';
  /** 按月末预计 ±10% 得出的可达区间，取整到千元。 */
  reachableLow: number;
  reachableHigh: number;
  /** Agent 建议的目标值（按当前节奏可达）。 */
  suggestedTarget: number;
  /** 维持当前目标所需的 GMV 缺口与增量预算（ROAS 口径）。 */
  gap: number;
  requiredBudget: number;
  remainingBudget: number;
  budgetSufficient: boolean;
  last30Gmv: number;
  previous30Gmv: number;
  mtdGmv: number;
  dailyAvg: number;
  monthDay: number;
  daysInMonth: number;
  roas: number;
}

function roundTo(value: number, step: number) {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * P29.2 节奏预测：目标卡要能直接回答「按当前速度能不能达成、哪天达成、差几天」。
 * 数字与 P29.1 提议同源（businessDashboard 的日 GMV 生成器），不另造演示值。
 */
export interface GoalPace {
  storeId: AllMallId;
  target: number;
  /** 数据口径的本月至今 GMV。 */
  achieved: number;
  progressPct: number;
  /** 近 14 天日均 GMV，即 run-rate。 */
  runRate: number;
  projectedMonthEnd: number;
  gap: number;
  gapPct: number;
  /** 按 run-rate 填平缺口还需要的天数；已达成时为 0，无法推算为 null。 */
  daysToTarget: number | null;
  /** 预计达成日（YYYY-MM-DD）；已达成或无法推算为 null。 */
  projectedDate: string | null;
  /** 相对月末提前/落后的天数：正数提前，负数落后；无法推算为 null。 */
  daysVsMonthEnd: number | null;
  /** 缺口超过该百分比才升级，避免日均波动每天都报警。 */
  alertThresholdPct: number;
  status: 'achieved' | 'on_track' | 'behind';
}

/** 缺口超过目标的 10% 才算「节奏落后」。 */
const PACE_ALERT_THRESHOLD_PCT = 10;

function paceEscalationPrefix(storeId: AllMallId) {
  return `goal-pace-${storeId}-`;
}

function formatCny(value: number) {
  return `¥${new Intl.NumberFormat('zh-CN').format(Math.round(value))}`;
}

/** 只读推算；没有 GMV 基线时返回 null，界面不显示任何推算数字。 */
function buildGoalPace(storeId: AllMallId): GoalPace | null {
  const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
  if (goal.metric !== 'gmv') return null;
  const store = stores.find((s) => s.id === storeId);
  const baseline = store ? getStoreOperatingBaseline(store.name) : null;
  if (!baseline) return null;

  const achieved = baseline.mtdGmv;
  const projectedMonthEnd = baseline.projectedMonthGmv;
  const remaining = Math.max(0, goal.target - achieved);
  // 缺口按「月末预计」算，而不是「本月至今」：run-rate 会把剩余天数补上，用月至今判断会天天误报。
  const gap = Math.max(0, goal.target - projectedMonthEnd);
  const gapPct = goal.target > 0 ? (gap / goal.target) * 100 : 0;
  const daysToTarget = remaining === 0 ? 0 : baseline.dailyAvg > 0 ? Math.ceil(remaining / baseline.dailyAvg) : null;
  const daysLeft = baseline.daysInMonth - baseline.monthDay;
  const status: GoalPace['status'] =
    remaining === 0 ? 'achieved' : gap > 0 ? 'behind' : 'on_track';

  return {
    storeId,
    target: goal.target,
    achieved,
    progressPct: goal.target > 0 ? (achieved / goal.target) * 100 : 0,
    runRate: baseline.dailyAvg,
    projectedMonthEnd,
    gap,
    gapPct,
    daysToTarget,
    projectedDate:
      remaining === 0 || daysToTarget === null ? null : dayjs().add(daysToTarget, 'day').format('YYYY-MM-DD'),
    daysVsMonthEnd: remaining === 0 || daysToTarget === null ? null : daysLeft - daysToTarget,
    alertThresholdPct: PACE_ALERT_THRESHOLD_PCT,
    status,
  };
}

/**
 * 目标提议的纯计算：目标卡「请 Agent 评估」与收件箱补救选项共用同一份口径，
 * 避免两处各算一套数字。没有基线时返回 null，调用方不得编造。
 */
function buildGoalProposal(storeId: AllMallId): GoalProposal | null {
  const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
  if (goal.metric !== 'gmv') return null;
  const store = stores.find((s) => s.id === storeId);
  const baseline = store ? getStoreOperatingBaseline(store.name) : null;
  if (!baseline) return null;

  const achievedPct = goal.target > 0 ? baseline.projectedMonthGmv / goal.target : 0;
  const verdict: GoalProposal['verdict'] =
    achievedPct >= 1.1 ? 'over' : achievedPct >= 0.9 ? 'on_track' : 'at_risk';
  const gap = Math.max(0, goal.target - baseline.projectedMonthGmv);
  const requiredBudget = gap > 0 ? Math.round(gap / baseline.roas) : 0;
  const remainingBudget = Math.max(0, goal.constraints.monthlyBudgetCap - baseline.mtdAdSpend);

  return {
    storeId,
    metric: goal.metric,
    currentTarget: goal.target,
    projectedMonthGmv: baseline.projectedMonthGmv,
    achievedPct,
    verdict,
    reachableLow: roundTo(baseline.projectedMonthGmv * 0.9, 1000),
    reachableHigh: roundTo(baseline.projectedMonthGmv * 1.1, 1000),
    suggestedTarget: roundTo(baseline.projectedMonthGmv, 1000),
    gap,
    requiredBudget,
    remainingBudget,
    budgetSufficient: requiredBudget <= remainingBudget,
    last30Gmv: baseline.last30Gmv,
    previous30Gmv: baseline.previous30Gmv,
    mtdGmv: baseline.mtdGmv,
    dailyAvg: baseline.dailyAvg,
    monthDay: baseline.monthDay,
    daysInMonth: baseline.daysInMonth,
    roas: baseline.roas,
  };
}

/**
 * P46 预算池跟着目标走：账户广告预算是一个池子，但「目标 → 所需广告预算」此前只停在单店
 * 目标提议里，撞池时人只能去改预算池或延后动作。这里把各店「目标所需 vs 当前池」摆到账户层，
 * 由 Agent 在账户总额不变的前提下把富余挪给缺口最大的店，人只做一次确认。
 */
export interface BudgetPoolRow {
  storeId: AllMallId;
  storeName: string;
  hasBaseline: boolean;
  target: number;
  /** 按当前节奏的月末预计 GMV；无经营基线时为 null。 */
  projectedMonthEnd: number | null;
  /** 本月至今广告花费（与目标提议同源）。 */
  mtdAdSpend: number;
  /** 按 ROAS 填平月末缺口还需的增量广告预算。 */
  requiredAdBudget: number;
  /** 本月达到目标所需的广告总额 = 已花 + 还需。 */
  neededAdMonthly: number;
  /** 当前广告月预算池。 */
  adPoolMonthly: number;
  promoPoolMonthly: number;
  /** 正数 = 缺口，负数 = 富余。 */
  gap: number;
  /** 单店 ROAS；无基线时为 null，不参与收益估算。 */
  roas: number | null;
  role: 'receiver' | 'donor' | 'balanced';
  /** 从本店转出的金额。 */
  give: number;
  /** 转入本店的金额。 */
  take: number;
  /** 再分配后的广告月预算池。 */
  nextAdPool: number;
}

export interface BudgetPoolProposal {
  rows: BudgetPoolRow[];
  /** 账户广告预算池总额：再分配前后必须一致。 */
  accountAdTotal: number;
  totalShortage: number;
  totalSurplus: number;
  /** 本轮实际挪动的金额。 */
  allocated: number;
  /** 富余全部挪出后仍未补上的缺口。 */
  uncovered: number;
  /** 按各店 ROAS 估算的额外回写 GMV（只算真正转入的金额）。 */
  expectedGmvGain: number;
  moves: Array<{ fromStoreId: AllMallId; toStoreId: AllMallId; amount: number }>;
}

export interface BudgetReallocationStore {
  storeId: AllMallId;
  storeName: string;
  from: number;
  to: number;
  current: number;
  /** 当前预算池仍等于该次写入的新值。 */
  unchanged: boolean;
}

/** P46.3：最近一次预算池再分配，供界面提示「上次挪了什么、能不能整批撤销」。 */
export interface BudgetReallocationRecord {
  batchId: string;
  at: string;
  actor: string;
  rows: BudgetReallocationStore[];
  /** 所有店当前预算池仍等于该次新值时，才允许整批撤销。 */
  reversible: boolean;
}

/** 太小的钱挪来挪去只会制造噪音，也不值得人确认一次。 */
const BUDGET_MOVE_MIN = 100;

function buildBudgetPoolProposal(storeIds: AllMallId[]): BudgetPoolProposal {
  const rows: BudgetPoolRow[] = storeIds.map((storeId) => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const store = stores.find((s) => s.id === storeId);
    const policy = policies.find((p) => p.storeId === storeId);
    const pool = policy?.budgetPool ?? DEFAULT_BUDGET_POOL;
    const baseline = store && goal.metric === 'gmv' ? getStoreOperatingBaseline(store.name) : null;
    const base = {
      storeId,
      storeName: store?.name ?? `#${storeId}`,
      target: goal.target,
      adPoolMonthly: pool.adMonthly,
      promoPoolMonthly: pool.promoMonthly,
      nextAdPool: pool.adMonthly,
      give: 0,
      take: 0,
      role: 'balanced' as const,
    };
    if (!baseline) {
      return {
        ...base,
        hasBaseline: false,
        projectedMonthEnd: null,
        mtdAdSpend: 0,
        requiredAdBudget: 0,
        neededAdMonthly: pool.adMonthly,
        gap: 0,
        roas: null,
      };
    }
    const gapGmv = Math.max(0, goal.target - baseline.projectedMonthGmv);
    const requiredAdBudget = Math.round(gapGmv / baseline.roas);
    const neededAdMonthly = baseline.mtdAdSpend + requiredAdBudget;
    return {
      ...base,
      hasBaseline: true,
      projectedMonthEnd: baseline.projectedMonthGmv,
      mtdAdSpend: baseline.mtdAdSpend,
      requiredAdBudget,
      neededAdMonthly,
      gap: neededAdMonthly - pool.adMonthly,
      roas: baseline.roas,
    };
  });

  const receivers = rows.filter((row) => row.gap >= BUDGET_MOVE_MIN).sort((a, b) => b.gap - a.gap);
  const donors = rows
    .filter((row) => row.gap <= -BUDGET_MOVE_MIN)
    .sort((a, b) => a.gap - b.gap)
    .map((row) => ({ row, left: -row.gap }));
  const totalShortage = receivers.reduce((sum, row) => sum + row.gap, 0);
  const totalSurplus = donors.reduce((sum, item) => sum + item.left, 0);
  const moves: BudgetPoolProposal['moves'] = [];

  // 只把富余挪到「本店自己也不够」的店，且每家店不会被挪到低于自身所需。
  receivers.forEach((receiver) => {
    let need = receiver.gap;
    donors.forEach((donor) => {
      if (need < BUDGET_MOVE_MIN || donor.left < BUDGET_MOVE_MIN) return;
      const amount = Math.min(need, donor.left);
      if (amount < BUDGET_MOVE_MIN) return;
      need -= amount;
      donor.left -= amount;
      donor.row.give += amount;
      receiver.take += amount;
      moves.push({ fromStoreId: donor.row.storeId, toStoreId: receiver.storeId, amount });
    });
  });

  rows.forEach((row) => {
    row.nextAdPool = row.adPoolMonthly - row.give + row.take;
    row.role = row.give > 0 ? 'donor' : row.gap > 0 ? 'receiver' : 'balanced';
  });

  const allocated = rows.reduce((sum, row) => sum + row.take, 0);
  return {
    rows,
    accountAdTotal: rows.reduce((sum, row) => sum + row.adPoolMonthly, 0),
    totalShortage,
    totalSurplus,
    allocated,
    uncovered: Math.max(0, totalShortage - allocated),
    expectedGmvGain: Math.round(
      rows.reduce((sum, row) => sum + (row.roas ? row.take * row.roas : 0), 0),
    ),
    moves,
  };
}

/** 最近一次仍未被撤销的预算池再分配；更早的批次已经是历史，不再提供撤销。 */
function getBudgetReallocationRecord(): BudgetReallocationRecord | null {
  const logs = getAuditLogs();
  const latest = logs
    .filter((log) => log.action === '调整广告预算池' && log.budgetChange)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!latest?.budgetChange) return null;
  const batchId = latest.budgetChange.batchId;
  const reverted = logs.some(
    (log) => log.action === '撤销预算池再分配' && log.budgetChange?.batchId === batchId,
  );
  if (reverted) return null;
  const batch = logs.filter(
    (log) =>
      log.action === '调整广告预算池' &&
      log.budgetChange?.batchId === batchId &&
      typeof log.storeId === 'number',
  );
  const rows: BudgetReallocationStore[] = batch.map((log) => {
    const change = log.budgetChange!;
    const storeId = log.storeId as AllMallId;
    const policy = policies.find((p) => p.storeId === storeId);
    const current = policy?.budgetPool ?? DEFAULT_BUDGET_POOL;
    return {
      storeId,
      storeName: stores.find((s) => s.id === storeId)?.name ?? `#${storeId}`,
      from: change.from,
      to: change.to,
      current: current.adMonthly,
      unchanged: Math.abs(current.adMonthly - change.to) < 0.5,
    };
  });
  return {
    batchId,
    at: latest.at,
    actor: latest.actor,
    rows,
    reversible: rows.length > 0 && rows.every((row) => row.unchanged),
  };
}

export interface GoalPaceSync {
  pace: GoalPace | null;
  /** 本轮是否新建了升级项（已有未处理的不会重复创建）。 */
  escalated: boolean;
  /** 同步后是否存在未处理的升级项（人已处理过的不复活）。 */
  open: boolean;
  /** 本轮自动关闭的过期升级项数量（节奏恢复或跨月）。 */
  closed: number;
}

/**
 * P33.2 目标周期归属：目标属于哪个月是事实，不是默认值。
 * 跨月后 Agent 先结算上期，再把目标顺延到本月并校准进度，不再静默沿用旧进度。
 */
export interface GoalPeriodState {
  storeId: AllMallId;
  /** 目标当前归属的月份。 */
  periodKey: string;
  currentPeriodKey: string;
  /** 目标仍停在上个月或更早：需要 Agent 结算上期并顺延。 */
  rolledOver: boolean;
  /** 被顺延的目标金额（与上期一致，Agent 不替人定新目标）。 */
  carriedTarget: number;
  /** 最近一次跨月结算结果；从未跨月为 null。 */
  lastSettlement: GoalPeriodSettlement | null;
}

/** 历史持久化目标没有 periodKey：按最后更新时间归属，不凭空当成本月目标。 */
function resolvePeriodKey(goal: StoreGoal): string {
  return goal.periodKey ?? dayjs(goal.updatedAt).format('YYYY-MM');
}

export interface GoalPeriodSync {
  /** 本轮是否真的做了跨月结转（已在本月则为 false）。 */
  settled: boolean;
  period: GoalPeriodState;
}

function buildGoalPeriod(storeId: AllMallId): GoalPeriodState {
  const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
  const periodKey = resolvePeriodKey(goal);
  const nowKey = currentPeriodKey();
  return {
    storeId,
    periodKey,
    currentPeriodKey: nowKey,
    rolledOver: periodKey < nowKey,
    carriedTarget: goal.target,
    lastSettlement: goal.lastSettlement ?? null,
  };
}

/**
 * 只结算「上一个自然月」：用上一个自然月的整月 GMV 对照该月目标。
 * 更早的月份没有可信数据窗口，如实返回 unknown，不拿近 30 天冒充整月。
 */
function buildSettlement(goal: StoreGoal, periodKey: string): GoalPeriodSettlement {
  const store = stores.find((s) => s.id === goal.storeId);
  const baseline = store ? getStoreOperatingBaseline(store.name) : null;
  const prevKey = dayjs().subtract(1, 'month').format('YYYY-MM');
  const settledAt = new Date().toISOString();
  if (!baseline || periodKey !== prevKey) {
    return { periodKey, target: goal.target, actualGmv: null, achievedPct: null, verdict: 'unknown', settledAt };
  }
  const achievedPct = goal.target > 0 ? baseline.previousMonthGmv / goal.target : null;
  return {
    periodKey,
    target: goal.target,
    actualGmv: baseline.previousMonthGmv,
    achievedPct,
    verdict: achievedPct === null ? 'unknown' : achievedPct >= 1 ? 'achieved' : 'missed',
    settledAt,
  };
}

/**
 * P29.3 账户级目标分配：人只给一个账户月度 GMV 目标，Agent 按各店近 30 天 GMV 占比拆到店，
 * 人确认后写回单店目标。权重与承载判断全部来自经营基线，不另造数字。
 */
export interface AccountAllocationRow {
  storeId: AllMallId;
  storeName: string;
  /** 近 30 天 GMV，作为分配权重；无可用基线时为 null。 */
  last30Gmv: number | null;
  /** 按当前节奏的月末预计，用于判断分配是否超出该店承载。 */
  projectedMonthEnd: number | null;
  /** 分配权重占比 0–1。 */
  share: number;
  currentTarget: number;
  suggestedTarget: number;
  delta: number;
  /** 建议目标高出月末预计 10% 以上：按当前节奏大概率接不住。 */
  overCapacity: boolean;
  hasBaseline: boolean;
}

export interface AccountAllocation {
  target: number;
  rows: AccountAllocationRow[];
  coveredStores: number;
  storeCount: number;
  overCapacityCount: number;
  /** 已分配到店的建议目标合计（不含无基线店铺保留的原目标）。 */
  allocatedTotal: number;
}

/** 分配目标超出月末预计多少才提示「接不住」，与节奏升级阈值保持一致。 */
const ALLOCATION_HEADROOM_PCT = 10;

function buildAccountBasis(storeIds: AllMallId[]): AccountAllocationRow[] {
  return storeIds.map((storeId) => {
    const store = stores.find((s) => s.id === storeId);
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const baseline = store ? getStoreOperatingBaseline(store.name) : null;
    // 账户目标只覆盖 GMV 口径；非 GMV 目标的店铺保留原目标，不参与分配。
    const usable = Boolean(baseline) && goal.metric === 'gmv';
    return {
      storeId,
      storeName: store?.name ?? `#${storeId}`,
      last30Gmv: usable ? baseline!.last30Gmv : null,
      projectedMonthEnd: usable ? baseline!.projectedMonthGmv : null,
      share: 0,
      currentTarget: goal.target,
      suggestedTarget: goal.target,
      delta: 0,
      overCapacity: false,
      hasBaseline: usable,
    };
  });
}

/** 纯计算：按近 30 天 GMV 占比拆分账户目标，取整尾差归到占比最大的店，保证合计一致。 */
export function allocateAccountTarget(basis: AccountAllocationRow[], target: number): AccountAllocation {
  const rows = basis.map((row) => ({ ...row }));
  const weighted = rows.filter((row) => row.hasBaseline && (row.last30Gmv ?? 0) > 0);
  const totalWeight = weighted.reduce((sum, row) => sum + (row.last30Gmv ?? 0), 0);
  if (weighted.length === 0 || totalWeight <= 0) {
    return {
      target,
      rows,
      coveredStores: 0,
      storeCount: rows.length,
      overCapacityCount: 0,
      allocatedTotal: 0,
    };
  }

  weighted.forEach((row) => {
    row.share = (row.last30Gmv ?? 0) / totalWeight;
    row.suggestedTarget = roundTo(target * row.share, 1000);
  });
  const anchor = weighted.reduce((max, row) =>
    (row.last30Gmv ?? 0) > (max.last30Gmv ?? 0) ? row : max,
  );
  anchor.suggestedTarget += target - weighted.reduce((sum, row) => sum + row.suggestedTarget, 0);

  weighted.forEach((row) => {
    row.delta = row.suggestedTarget - row.currentTarget;
    const projected = row.projectedMonthEnd ?? 0;
    row.overCapacity = projected > 0 && row.suggestedTarget > projected * (1 + ALLOCATION_HEADROOM_PCT / 100);
  });

  return {
    target,
    rows,
    coveredStores: weighted.length,
    storeCount: rows.length,
    overCapacityCount: weighted.filter((row) => row.overCapacity).length,
    allocatedTotal: weighted.reduce((sum, row) => sum + row.suggestedTarget, 0),
  };
}

/** 审批策略解析结果，供三元表达式之外的调用方直接使用。 */
export function resolveApprovalRequirement(
  storeId: AllMallId,
  agentType: string,
  riskLevel: RiskLevel,
): ApprovalRequirement {
  const policy = policies.find((p) => p.storeId === storeId);
  const scenarioKey = getScenarioForAgent(agentType);
  const level = policy?.autonomy ?? (scenarioKey ? getScenarioAutonomy(scenarioKey) : 'L1');
  return REQUIREMENT_MATRIX[level][riskLevel];
}

/** 把审批要求映射回 ApprovalPolicy，保留按风险等级的超时等既有配置。 */
export function resolveApprovalPolicy(
  storeId: AllMallId,
  agentType: string,
  riskLevel: RiskLevel,
  base: ApprovalPolicy | undefined,
): ApprovalPolicy | undefined {
  if (!base) return undefined;
  const requirement = resolveApprovalRequirement(storeId, agentType, riskLevel);
  const action: ApprovalPolicy['action'] =
    requirement === 'auto' ? 'auto_execute' : requirement === 'dual' ? 'dual_approval' : 'single_approval';
  return { ...base, action };
}

export const operatingModelApi = {
  getMerchantProfile: () => mockDelay(GENERAL_PROFILE),

  getGoal: (storeId: AllMallId) => {
    let goal = goals.find((g) => g.storeId === storeId);
    if (!goal) {
      goal = defaultGoal(storeId);
      goals.push(goal);
    } else if (!goal.periodKey) {
      // 历史持久化数据补归属月份：按最后更新时间落月，避免把旧目标当成「本月人刚设的」。
      goal.periodKey = resolvePeriodKey(goal);
    }
    return mockDelay(goal);
  },

  /**
   * S1 首启闭环：新店没有任何经营历史，目标进度必须从 0 起算。
   * 演示种子的 62% 只能用于预置店铺，否则新店首屏会出现“0 订单但目标已完成 62%”的矛盾。
   */
  createInitialGoal: (storeId: AllMallId) => {
    const existing = goals.find((g) => g.storeId === storeId);
    if (existing) return mockDelay(existing);
    const goal: StoreGoal = { ...defaultGoal(storeId), current: 0, periodKey: currentPeriodKey() };
    goals.push(goal);
    return mockDelay(goal);
  },

  /**
   * P28.2：护栏变更必须「有原因、有确认人、可逐项追责」。
   * 没有原因时直接拒绝写入——护栏是 Agent 的判断边界，不能悄悄改。
   */
  saveGoal: (storeId: AllMallId, patch: Partial<Omit<StoreGoal, 'storeId'>>, meta?: GuardChangeMeta) => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const guardChanges = patch.constraints ? diffGuards(goal.constraints, patch.constraints) : [];
    const reason = meta?.reason?.trim() ?? '';
    if (guardChanges.length > 0 && !reason) {
      throw new Error('护栏变更必须填写原因');
    }
    const next: StoreGoal = {
      ...goal,
      ...patch,
      storeId,
      // 人改目标即代表本月目标已由人确认，归属月份跟到当前月。
      periodKey: currentPeriodKey(),
      updatedAt: new Date().toISOString(),
    };

    // P47：这次改动若声明了临时天数，就记下「临时值 / 原值 / 到期时间」；
    // 不带期限的新改动会清掉该字段旧的期限，避免旧的临时值在到期后反过来覆盖新值。
    let expiryUntil: string | null = null;
    if (guardChanges.length > 0) {
      const days = Math.min(30, Math.max(1, Math.round(meta?.expiresInDays ?? 0)));
      const expiries: GuardExpiries = { ...(goal.guardExpiries ?? {}) };
      if (days > 0) expiryUntil = dayjs().add(days, 'day').endOf('day').toISOString();
      guardChanges.forEach((change) => {
        if (expiryUntil) {
          expiries[change.field] = {
            value: next.constraints[change.field],
            baseValue: goal.constraints[change.field],
            until: expiryUntil,
            setAt: next.updatedAt,
          };
        } else {
          delete expiries[change.field];
        }
      });
      next.guardExpiries = Object.keys(expiries).length > 0 ? expiries : undefined;
    }

    const index = goals.findIndex((g) => g.storeId === storeId);
    if (index >= 0) goals[index] = next;
    else goals.push(next);

    if (guardChanges.length > 0) {
      const actor = `${meta?.actor?.trim() || '当前用户'}${meta?.actorRole ? `（${meta.actorRole}）` : ''}`;
      const expiryNote = expiryUntil
        ? `；临时至 ${dayjs(expiryUntil).format('MM-DD HH:mm')}，到期自动恢复`
        : '';
      guardChanges.forEach((change) => {
        recordAuditLog({
          actor,
          action: '变更护栏',
          entity: 'store',
          entityId: storeId,
          storeId,
          summary: `${change.label} ${change.from} → ${change.to}；原因：${reason}${expiryNote}`,
          category: 'human_ops',
          linkTo: `/dashboard?storeId=${storeId}`,
          // P45.1：摘要给人读，原值留给「撤销回到变更前」。
          guardChanges: [
            { field: change.field, from: goal.constraints[change.field], to: next.constraints[change.field] },
          ],
        });
      });
    }

    // 目标本身（指标/数值/优先级）没变时不再补一条笼统的目标日志，避免护栏变更被稀释。
    const goalChanged =
      (patch.metric !== undefined && patch.metric !== goal.metric) ||
      (patch.target !== undefined && patch.target !== goal.target) ||
      (patch.priority !== undefined && patch.priority !== goal.priority);
    if (goalChanged || guardChanges.length === 0) {
      recordAuditLog({
        actor: '当前用户',
        action: '更新店铺目标',
        entity: 'store',
        entityId: storeId,
        storeId,
        summary: `店铺目标调整为 ${next.metric} / ${next.target}`,
        category: 'human_ops',
        linkTo: `/dashboard?storeId=${storeId}`,
      });
    }
    return mockDelay(next);
  },

  /**
   * P47：临时护栏到期收回。Agent 只在「当前值仍等于当初设的临时值」时恢复原值；
   * 人后来改过这个字段，就只清掉过期标记，不拿旧值覆盖人的新决定。
   */
  restoreExpiredGuards: (storeId: AllMallId) => {
    const index = goals.findIndex((g) => g.storeId === storeId);
    const goal = index >= 0 ? goals[index] : undefined;
    if (!goal?.guardExpiries) return mockDelay({ restored: 0, cleared: 0 });

    const now = dayjs();
    const nextExpiries: GuardExpiries = { ...goal.guardExpiries };
    const nextConstraints = { ...goal.constraints };
    let restored = 0;
    let cleared = 0;

    (Object.keys(goal.guardExpiries) as Array<keyof StoreGoal['constraints']>).forEach((key) => {
      const expiry = goal.guardExpiries?.[key];
      if (!expiry || now.isBefore(dayjs(expiry.until))) return;
      delete nextExpiries[key];
      cleared += 1;
      // 人此后改过该字段：放弃回收，只清理过期标记。
      if (goal.constraints[key] !== expiry.value) return;

      const field = GUARD_FIELDS.find((item) => item.key === key);
      const format = field?.format ?? ((value: number) => `${value}`);
      nextConstraints[key] = expiry.baseValue;
      recordAuditLog({
        actor: 'Agent（治理巡检）',
        action: '恢复护栏',
        entity: 'store',
        entityId: storeId,
        storeId,
        summary: `${field?.label ?? key} ${format(expiry.value)} → ${format(expiry.baseValue)}；原因：临时护栏到期（原定 ${dayjs(expiry.until).format('MM-DD HH:mm')}）自动恢复`,
        category: 'agent_action',
        linkTo: `/dashboard?storeId=${storeId}`,
        guardChanges: [{ field: key, from: expiry.value, to: expiry.baseValue }],
      });
      restored += 1;
    });

    if (cleared === 0) return mockDelay({ restored: 0, cleared: 0 });
    goals[index] = {
      ...goal,
      constraints: nextConstraints,
      guardExpiries: Object.keys(nextExpiries).length > 0 ? nextExpiries : undefined,
      updatedAt: new Date().toISOString(),
    };
    saveMockPersistence();
    return mockDelay({ restored, cleared });
  },

  /**
   * P45.1：护栏改错的回滚。只允许撤销「当前仍在生效」的那条变更——
   * 同一字段此后又被改过时直接拒绝，避免撤销把人后来的调整一起覆盖。
   * 撤销本身仍走 saveGoal，因此照常带上原因、确认人，并写进同一条审计流水。
   */
  revertGuardChange: (
    storeId: AllMallId,
    auditLogId: AllMallId | string,
    meta: { actor: string; actorRole?: string },
  ) => {
    const log = getAuditLogs().find(
      (item) => item.id === auditLogId && item.storeId === storeId && item.action === '变更护栏',
    );
    const change = log?.guardChanges?.[0];
    if (!log || !change) {
      throw new Error('这条记录没有留下护栏原值，无法撤销');
    }
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    if (goal.constraints[change.field] !== change.to) {
      throw new Error('这条护栏此后又被改过，撤销会覆盖后续变更');
    }
    const field = GUARD_FIELDS.find((item) => item.key === change.field);
    const label = field?.label ?? change.field;
    const previous = field ? field.format(change.from) : String(change.from);
    const reason = `撤销 ${dayjs(log.at).format('MM-DD HH:mm')} 的变更（${label} 回到 ${previous}）`;
    return operatingModelApi.saveGoal(
      storeId,
      { constraints: { ...goal.constraints, [change.field]: change.from } },
      { ...meta, reason },
    );
  },

  /**
   * P46.1/P46.2：账户广告预算再分配。只算不写，供账户目标卡展示缺口、富余与挪移方案。
   */
  getBudgetPoolProposal: (storeIds: AllMallId[]) => mockDelay(buildBudgetPoolProposal(storeIds)),

  /**
   * 人确认后一次性写回：账户总额守恒是硬约束，任何会让总额变化的方案直接拒绝。
   * 只写有实际挪移的店，保留原自主等级与促销预算池；每店一条审计，写清旧值 → 新值与来源。
   */
  reallocateAdBudget: (storeIds: AllMallId[], meta: { actor: string; actorRole?: string }) => {
    const proposal = buildBudgetPoolProposal(storeIds);
    if (proposal.moves.length === 0) {
      throw new Error('当前账户没有可再分配的广告预算');
    }
    const after = proposal.rows.reduce((sum, row) => sum + row.nextAdPool, 0);
    if (Math.abs(after - proposal.accountAdTotal) > 0.5) {
      throw new Error('再分配前后账户广告预算池必须一致');
    }
    const at = dayjs().format('MM-DD HH:mm');
    const batchId = `budget-${Date.now()}`;
    const actor = `${meta.actor.trim() || '当前用户'}${meta.actorRole ? `（${meta.actorRole}）` : ''}`;
    proposal.rows
      .filter((row) => row.give > 0 || row.take > 0)
      .forEach((row) => {
        const index = policies.findIndex((p) => p.storeId === row.storeId);
        const current = index >= 0 ? policies[index] : undefined;
        const next: OperatingPolicy = {
          storeId: row.storeId,
          autonomy: current?.autonomy ?? operatingModelApi.getEffectivePolicy(row.storeId).autonomy,
          budgetPool: { adMonthly: row.nextAdPool, promoMonthly: row.promoPoolMonthly },
          updatedAt: new Date().toISOString(),
        };
        if (index >= 0) policies[index] = next;
        else policies.push(next);
        const move = row.give > 0 ? `转出 ¥${row.give}` : `转入 ¥${row.take}`;
        recordAuditLog({
          actor,
          action: '调整广告预算池',
          entity: 'store',
          entityId: row.storeId,
          storeId: row.storeId,
          summary: `广告月预算池 ¥${row.adPoolMonthly} → ¥${row.nextAdPool}（${move}，账户再分配 ${at}）`,
          category: 'human_ops',
          linkTo: `/dashboard?storeId=${row.storeId}`,
          budgetChange: { batchId, from: row.adPoolMonthly, to: row.nextAdPool },
        });
      });
    return mockDelay(proposal);
  },

  /**
   * P46.3：最近一次预算池再分配；界面用它提示「上次挪了什么」，并判断能否整批撤销。
   */
  getLastBudgetReallocation: () => mockDelay(getBudgetReallocationRecord()),

  /**
   * P46.3：把最近一次再分配整批恢复到变更前。只要有一家店在此之后又被改过就拒绝，
   * 不拿旧批次覆盖新的调整；撤销本身按店写审计，仍可追溯。
   */
  revertBudgetReallocation: (meta: { actor: string; actorRole?: string }) => {
    const record = getBudgetReallocationRecord();
    if (!record) throw new Error('没有可撤销的预算池再分配');
    if (!record.reversible) throw new Error('预算池在此之后又被调整过，不能整批撤销');
    const actor = `${meta.actor.trim() || '当前用户'}${meta.actorRole ? `（${meta.actorRole}）` : ''}`;
    const at = dayjs(record.at).format('MM-DD HH:mm');
    record.rows.forEach((row) => {
      const index = policies.findIndex((p) => p.storeId === row.storeId);
      const current = index >= 0 ? policies[index] : undefined;
      const next: OperatingPolicy = {
        storeId: row.storeId,
        autonomy: current?.autonomy ?? operatingModelApi.getEffectivePolicy(row.storeId).autonomy,
        budgetPool: {
          adMonthly: row.from,
          promoMonthly: current?.budgetPool.promoMonthly ?? DEFAULT_BUDGET_POOL.promoMonthly,
        },
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) policies[index] = next;
      else policies.push(next);
      recordAuditLog({
        actor,
        action: '撤销预算池再分配',
        entity: 'store',
        entityId: row.storeId,
        storeId: row.storeId,
        summary: `广告月预算池 ¥${row.to} → ¥${row.from}（撤销 ${at} 的账户再分配）`,
        category: 'human_ops',
        linkTo: `/dashboard?storeId=${row.storeId}`,
        budgetChange: { batchId: record.batchId, from: row.to, to: row.from },
      });
    });
    return mockDelay(getBudgetReallocationRecord());
  },

  /**
   * P36.1：人在收件箱点「确认维持当前值」也要留下痕迹。
   * 不伪造一条 from→to 变更，而是记一条独立的「确认护栏」；体检据此认定这条线已由人确认。
   */
  confirmGuard: (
    storeId: AllMallId,
    key: keyof StoreGoal['constraints'],
    meta: { actor: string; reason: string },
  ) => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const field = GUARD_FIELDS.find((item) => item.key === key);
    if (!field) return mockDelay(goal);
    recordAuditLog({
      actor: meta.actor,
      action: '确认护栏',
      entity: 'store',
      entityId: storeId,
      storeId,
      summary: `${field.label} 维持 ${field.format(goal.constraints[key])}；原因：${meta.reason}`,
      category: 'human_ops',
      linkTo: `/dashboard?storeId=${storeId}`,
    });
    return mockDelay(goal);
  },

  /**
   * P37.1：账户护栏一次下发。
   * 人只对账户护栏表态一次，Agent 负责落到每家店：
   * - 只写「从未被人改过 / 确认过」的店；有人工自设值的店整店跳过，绝不覆盖；
   * - 有差异的护栏写「变更护栏」，无差异的写「确认护栏」，每店每条独立留痕；
   * - 不碰目标归属月份：人只是划护栏，不应顺带把上月目标确认成本月。
   */
  applyAccountGuards: (
    storeIds: AllMallId[],
    constraints: StoreGoal['constraints'],
    meta: { actor: string; reason: string; actorRole?: string },
  ) => {
    const reason = meta.reason.trim();
    if (!reason) throw new Error('护栏变更必须填写原因');
    const actor = `${meta.actor?.trim() || '当前用户'}${meta.actorRole ? `（${meta.actorRole}）` : ''}`;
    const humanGuardLogs = getAuditLogs().filter(
      (log) => log.action === '变更护栏' || log.action === '确认护栏',
    );
    const applied: AllMallId[] = [];
    const skipped: AllMallId[] = [];
    let changedFields = 0;
    let confirmedFields = 0;

    storeIds.forEach((storeId) => {
      const hasHumanGuard = humanGuardLogs.some((log) => log.storeId === storeId);
      if (hasHumanGuard) {
        skipped.push(storeId);
        return;
      }
      const index = goals.findIndex((g) => g.storeId === storeId);
      const goal = index >= 0 ? goals[index] : defaultGoal(storeId);
      const changes = diffGuards(goal.constraints, constraints);
      const next: StoreGoal = {
        ...goal,
        storeId,
        constraints: { ...constraints },
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) goals[index] = next;
      else goals.push(next);
      applied.push(storeId);

      GUARD_FIELDS.forEach((field) => {
        const change = changes.find((item) => item.field === field.key);
        if (change) {
          changedFields += 1;
          recordAuditLog({
            actor,
            action: '变更护栏',
            entity: 'store',
            entityId: storeId,
            storeId,
            summary: `${change.label} ${change.from} → ${change.to}；原因：${reason}（账户护栏下发）`,
            category: 'human_ops',
            linkTo: `/dashboard?storeId=${storeId}`,
          });
          return;
        }
        confirmedFields += 1;
        recordAuditLog({
          actor,
          action: '确认护栏',
          entity: 'store',
          entityId: storeId,
          storeId,
          summary: `${field.label} 维持 ${field.format(constraints[field.key])}；原因：${reason}（账户护栏下发）`,
          category: 'human_ops',
          linkTo: `/dashboard?storeId=${storeId}`,
        });
      });
    });

    return mockDelay({ applied, skipped, changedFields, confirmedFields });
  },

  /** 该店的护栏变更 / 确认记录（倒序）。直接读审计流水，不另存一份副本。 */
  listGuardChanges: (storeId: AllMallId) =>
    mockDelay(
      getAuditLogs()
        .filter(
          (log) =>
            log.storeId === storeId &&
            (log.action === '变更护栏' || log.action === '确认护栏' || log.action === '恢复护栏'),
        )
        .reverse(),
    ),

  /**
   * P29.1：Agent 主动给出目标提议。返回 null 表示当前店铺没有可用的经营基线
   * （非演示店铺或非 GMV 目标），界面必须显式说明，不能编一个看起来合理的数字。
   */
  proposeGoal: (storeId: AllMallId) => mockDelay(buildGoalProposal(storeId)),

  /**
   * 人确认采用 Agent 建议。目标值与「本月至今」进度同时按真实口径校准，
   * 避免目标卡仍显示 62% 而提议说已超额。旧值→新值和校准依据一起进审计。
   */
  adoptGoalProposal: (proposal: GoalProposal, meta: { actor: string; actorRole?: string }) => {
    const goal = goals.find((g) => g.storeId === proposal.storeId) ?? defaultGoal(proposal.storeId);
    const next: StoreGoal = {
      ...goal,
      target: proposal.suggestedTarget,
      current: proposal.mtdGmv,
      periodKey: currentPeriodKey(),
      updatedAt: new Date().toISOString(),
    };
    const index = goals.findIndex((g) => g.storeId === proposal.storeId);
    if (index >= 0) goals[index] = next;
    else goals.push(next);

    const actor = `${meta.actor.trim() || '当前用户'}${meta.actorRole ? `（${meta.actorRole}）` : ''}`;
    recordAuditLog({
      actor,
      action: '采用 Agent 目标建议',
      entity: 'store',
      entityId: proposal.storeId,
      storeId: proposal.storeId,
      summary: `目标 ¥${goal.target} → ¥${proposal.suggestedTarget}；进度按本月至今 ¥${proposal.mtdGmv} 校准；依据：近 30 天 ¥${proposal.last30Gmv}，按日均 ¥${proposal.dailyAvg} 预计月末 ¥${proposal.projectedMonthGmv}`,
      category: 'human_ops',
      linkTo: `/dashboard?storeId=${proposal.storeId}`,
    });
    return mockDelay(next);
  },

  /**
   * P29.2 只读节奏预测：目标卡用它回答「按当前速度哪天达成、差几天」。
   * 无 GMV 基线时返回 null，界面不显示推算数字。
   */
  getGoalPace: (storeId: AllMallId) => mockDelay(buildGoalPace(storeId)),

  /** P33.2 只读：目标属于哪个月、是否已跨月未结转。 */
  getGoalPeriod: (storeId: AllMallId) => mockDelay(buildGoalPeriod(storeId)),

  /**
   * P33.2 Agent 跨月结转：先结算上期（目标 vs 上期整月实际），再把目标顺延到本月、
   * 进度校准到本月至今。目标值本身不变——新目标仍由人设，Agent 只负责把事实算清楚。
   */
  settleGoalPeriod: async (storeId: AllMallId): Promise<GoalPeriodSync> => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const periodKey = resolvePeriodKey(goal);
    const nowKey = currentPeriodKey();
    if (periodKey >= nowKey) {
      return mockDelay({ settled: false, period: buildGoalPeriod(storeId) });
    }

    const settlement = buildSettlement(goal, periodKey);
    const store = stores.find((s) => s.id === storeId);
    const baseline = store ? getStoreOperatingBaseline(store.name) : null;
    const next: StoreGoal = {
      ...goal,
      periodKey: nowKey,
      current: baseline ? baseline.mtdGmv : goal.current,
      lastSettlement: settlement,
      updatedAt: new Date().toISOString(),
    };
    const index = goals.findIndex((g) => g.storeId === storeId);
    if (index >= 0) goals[index] = next;
    else goals.push(next);

    const verdictText =
      settlement.verdict === 'achieved'
        ? `已达成（${Math.round((settlement.achievedPct ?? 0) * 100)}%）`
        : settlement.verdict === 'missed'
          ? `未达成（${Math.round((settlement.achievedPct ?? 0) * 100)}%）`
          : '无可用经营基线，未结算';
    recordAuditLog({
      actor: 'Orchestrator',
      action: '目标周期结转',
      entity: 'store',
      entityId: storeId,
      storeId,
      summary: `上期（${settlement.periodKey}）目标 ${formatCny(settlement.target)}${
        settlement.actualGmv === null ? '' : ` · 实际 ${formatCny(settlement.actualGmv)}`
      } · ${verdictText}；${formatCny(goal.target)} 顺延为本月目标${
        baseline ? `，进度按本月至今 ${formatCny(baseline.mtdGmv)} 校准` : ''
      }`,
      category: 'agent_action',
      linkTo: `/dashboard?storeId=${storeId}`,
    });

    // P34.1：上期未达成的结论不能只留在目标卡一行字里。Agent 把「沿用 / 按上期实际下调」
    // 两个立场连同上期事实一起推进待办；不处理时超时沿用原值（最保守，不改目标）。
    if (settlement.verdict === 'missed' && settlement.actualGmv !== null) {
      const storeName = store?.name ?? '当前店铺';
      const pctText = `${Math.round((settlement.achievedPct ?? 0) * 100)}%`;
      const shortfall = Math.max(0, settlement.target - settlement.actualGmv);
      const loweredTarget = roundTo(settlement.actualGmv, 1000);
      // 取整会把「实际」抬回目标值时不提供下调选项，避免给出一个点不动的按钮。
      const canLower = loweredTarget < next.target;
      const policy = exceptionsApi.getEscalationPolicy(storeId);
      await exceptionsApi.upsertEscalation({
        id: `goal-settlement-${storeId}-${settlement.periodKey}`,
        type: 'goal_settlement',
        storeId,
        storeName,
        agentType: 'orchestrator',
        level: (settlement.achievedPct ?? 1) < 0.8 ? 'critical' : 'warning',
        title: `上期目标未达成 · ${storeName}`,
        summary: `上期（${settlement.periodKey}）目标 ${formatCny(settlement.target)} · 实际 ${formatCny(
          settlement.actualGmv,
        )}（${pctText}），缺口 ${formatCny(shortfall)}；目标已按原值顺延到本月，是否沿用由你决定。`,
        detail: `Agent 只把上期事实算清楚并把目标原值顺延到本月（进度已按本月至今校准），没有替你改目标；沿用与下调都只影响本月目标，护栏不变。`,
        suggestedAction: '在收件箱选择「沿用上期目标」或「按上期实际下调」；不处理时超时按沿用收尾。',
        decision: {
          question: `上期只完成 ${pctText}：本月继续沿用 ${formatCny(settlement.target)}${
            canLower ? `，还是按上期实际下调到 ${formatCny(loweredTarget)}` : ''
          }？`,
          options: [
            {
              id: 'uphold' as const,
              label: '沿用上期目标',
              consequence: `本月目标仍为 ${formatCny(settlement.target)}；上期缺口 ${formatCny(
                shortfall,
              )} 记为你已确认接受，不再重复提醒。`,
              recommended: true,
            },
            ...(canLower
              ? [
                  {
                    id: 'override' as const,
                    label: `下调至 ${formatCny(loweredTarget)}`,
                    consequence: `本月目标 ${formatCny(settlement.target)} → ${formatCny(
                      loweredTarget,
                    )}（上期实际取整到千元）；进度按本月至今校准并留审计，之后仍可在目标卡改回。`,
                  },
                ]
              : []),
          ],
          timeoutHours: policy.timeoutHours,
          deadline: dayjs().add(policy.timeoutHours, 'hour').toISOString(),
          timeoutOptionId: 'uphold' as const,
        },
        // P30.4：上期缺口本身就是可核对的金额影响，排序沿用同一口径。
        impact: {
          amount: Math.round(shortfall),
          kind: 'goal_gap' as const,
          basis: `上期目标未达成金额（达成 ${pctText}）`,
        },
        createdAt: new Date().toISOString(),
        resolved: false,
        ignored: false,
        linkTo: `/dashboard?storeId=${storeId}`,
      });
    }

    return mockDelay({ settled: true, period: buildGoalPeriod(storeId) });
  },

  /**
   * P29.2 Agent 主动升级：缺口超过阈值就推进待办中心，不等人来问。
   * 同店同月只保留一条（已处理/已忽略的不复活）；节奏恢复或跨月时自动关闭旧条目，
   * 避免收件箱堆积已经失效的预警。
   */
  syncGoalPaceEscalation: async (storeId: AllMallId): Promise<GoalPaceSync> => {
    const pace = buildGoalPace(storeId);
    const prefix = paceEscalationPrefix(storeId);
    const currentId = `${prefix}${dayjs().format('YYYY-MM')}`;
    const openItems = (await exceptionsApi.list()).filter(
      (item) => item.id.startsWith(prefix) && !item.resolved && !item.ignored,
    );
    // 缺口没超过阈值（或已达成）就不打扰人；已经开着的旧预警随之关闭。
    const shouldEscalate = Boolean(pace && pace.status === 'behind' && pace.gapPct > pace.alertThresholdPct);

    if (!pace || !shouldEscalate) {
      if (openItems.length > 0) {
        await exceptionsApi.batchResolve(openItems.map((item) => item.id));
      }
      return { pace, escalated: false, open: false, closed: openItems.length };
    }

    // 跨月遗留的旧条目先关掉，本月只留一条当前预警。
    const stale = openItems.filter((item) => item.id !== currentId).map((item) => item.id);
    if (stale.length > 0) await exceptionsApi.batchResolve(stale);

    const storeName = stores.find((store) => store.id === storeId)?.name ?? '当前店铺';
    const behindDays = pace.daysVsMonthEnd !== null ? Math.abs(pace.daysVsMonthEnd) : 0;
    // P33.1：节奏预警不能只给一段建议文字。Agent 先把「维持」与「下调到按当前节奏可达的值」
    // 两个结论算好，人在收件箱点选即落库；超时默认维持（最保守、不改目标）。
    const reachableTarget = roundTo(pace.projectedMonthEnd, 1000);
    const policy = exceptionsApi.getEscalationPolicy(storeId);
    const escalated = await exceptionsApi.upsertEscalation({
      id: currentId,
      type: 'goal_pace_escalation',
      storeId,
      storeName,
      agentType: 'orchestrator',
      level: pace.gapPct >= 25 ? 'critical' : 'warning',
      title: `目标节奏落后 · ${storeName}`,
      summary: `按近 14 天日均 ${formatCny(pace.runRate)} 推算，月末预计 ${formatCny(
        pace.projectedMonthEnd,
      )}，距目标 ${formatCny(pace.target)} 缺口 ${formatCny(pace.gap)}（${pace.gapPct.toFixed(1)}%）；${
        pace.projectedDate ? `预计 ${pace.projectedDate} 达成，落后月末 ${behindDays} 天。` : '当前速度无法推算达成日。'
      }`,
      detail: `本月至今 ${formatCny(pace.achieved)}（达成 ${Math.round(pace.progressPct)}%），日均 ${formatCny(
        pace.runRate,
      )}；升级阈值：缺口超过 ${pace.alertThresholdPct}%。`,
      suggestedAction: '在收件箱选择「维持目标」或「下调到可达值」；不处理时超时按维持目标收尾。',
      decision: {
        question: `目标缺口 ${pace.gapPct.toFixed(1)}%：维持 ${formatCny(pace.target)}，还是下调到按当前节奏可达的 ${formatCny(
          reachableTarget,
        )}？`,
        options: [
          {
            id: 'uphold',
            label: '维持目标',
            consequence: `目标与护栏都不变；缺口 ${formatCny(pace.gap)} 视为人已确认接受，本轮不再提醒，下个周期重新评估。`,
            recommended: true,
          },
          {
            id: 'override',
            label: `下调至 ${formatCny(reachableTarget)}`,
            consequence: `目标 ${formatCny(pace.target)} → ${formatCny(
              reachableTarget,
            )}（按当前日均推算的月末值取整）；进度按本月至今 ${formatCny(
              pace.achieved,
            )} 校准并留审计，之后仍可在目标卡改回。`,
          },
        ],
        timeoutHours: policy.timeoutHours,
        deadline: dayjs().add(policy.timeoutHours, 'hour').toISOString(),
        timeoutOptionId: 'uphold',
      },
      // P30.4：节奏升级的金额影响就是目标缺口本身，排序按同一口径比较。
      impact: pace.gap > 0
        ? {
            amount: Math.round(pace.gap),
            kind: 'goal_gap' as const,
            basis: `距月目标缺口（${pace.gapPct.toFixed(1)}%，阈值 ${pace.alertThresholdPct}%）`,
          }
        : undefined,
      createdAt: new Date().toISOString(),
      resolved: false,
      ignored: false,
      linkTo: `/dashboard?storeId=${storeId}`,
    });

    return { pace, escalated, open: escalated || openItems.some((item) => item.id === currentId), closed: stale.length };
  },

  /**
   * P33.1：把收件箱里选的目标补救方案落到目标本身。
   * - 维持：不改目标，把「缺口由人确认接受」写进审计后关闭本条；
   * - 下调：按与目标卡同一份提议口径写回目标值，进度按本月至今校准；
   * - 无基线：只允许维持，不编可达值。
   */
  applyGoalPaceRemedy: async (
    storeId: AllMallId,
    optionId: 'uphold' | 'override',
    meta: { actor: string; exceptionId: string },
  ) => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const proposal = buildGoalProposal(storeId);
    const actor = meta.actor.trim() || '当前用户';
    const linkTo = `/dashboard?storeId=${storeId}`;

    if (optionId === 'override' && proposal && proposal.suggestedTarget < goal.target) {
      const next: StoreGoal = {
        ...goal,
        target: proposal.suggestedTarget,
        current: proposal.mtdGmv,
        periodKey: currentPeriodKey(),
        updatedAt: new Date().toISOString(),
      };
      const index = goals.findIndex((g) => g.storeId === storeId);
      if (index >= 0) goals[index] = next;
      else goals.push(next);
      recordAuditLog({
        actor,
        action: '目标节奏补救 · 下调目标',
        entity: 'store',
        entityId: storeId,
        storeId,
        summary: `目标 ¥${goal.target} → ¥${proposal.suggestedTarget}；进度按本月至今 ¥${proposal.mtdGmv} 校准；依据：日均 ¥${proposal.dailyAvg} 推算月末 ¥${proposal.projectedMonthGmv}，原缺口 ¥${proposal.gap}`,
        category: 'human_ops',
        linkTo,
      });
      await exceptionsApi.resolve(
        meta.exceptionId,
        `人选择「下调目标」：¥${goal.target} → ¥${proposal.suggestedTarget}，进度已按本月至今校准`,
        actor,
      );
      return mockDelay({ applied: true, target: next.target });
    }

    recordAuditLog({
      actor,
      action: '目标节奏补救 · 维持目标',
      entity: 'store',
      entityId: storeId,
      storeId,
      summary: proposal
        ? `维持目标 ¥${goal.target}；当前节奏预计月末 ¥${proposal.projectedMonthGmv}，缺口 ¥${proposal.gap} 由人确认接受`
        : `维持目标 ¥${goal.target}；当前无可用经营基线，不做下调`,
      category: 'human_ops',
      linkTo,
    });
    await exceptionsApi.resolve(
      meta.exceptionId,
      proposal
        ? `人选择「维持目标」：接受缺口 ¥${proposal.gap}，目标不变`
        : '人选择「维持目标」：当前无可用经营基线，目标不变',
      actor,
    );
    return mockDelay({ applied: false, target: goal.target });
  },

  /**
   * P34.1：把收件箱里选的上期结算立场落到本月目标。
   * - 沿用：不改目标，把「上期缺口由人确认接受」写进审计后关闭本条；
   * - 下调：按上期实际（取整到千元）改写目标，进度按本月至今校准；
   * - 没有可用的上期实际、或下调值不低于当前目标时不给下调，只按沿用手收尾。
   */
  applyGoalSettlementRemedy: async (
    storeId: AllMallId,
    optionId: 'uphold' | 'override',
    meta: { actor: string; exceptionId: string },
  ) => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const settlement = goal.lastSettlement;
    const actor = meta.actor.trim() || '当前用户';
    const linkTo = `/dashboard?storeId=${storeId}`;
    const loweredTarget = settlement?.actualGmv !== null && settlement?.actualGmv !== undefined
      ? roundTo(settlement.actualGmv, 1000)
      : null;
    const canLower = loweredTarget !== null && loweredTarget < goal.target;

    if (optionId === 'override' && settlement && loweredTarget !== null && loweredTarget < goal.target) {
      const store = stores.find((s) => s.id === storeId);
      const baseline = store ? getStoreOperatingBaseline(store.name) : null;
      const next: StoreGoal = {
        ...goal,
        target: loweredTarget,
        current: baseline ? baseline.mtdGmv : goal.current,
        periodKey: currentPeriodKey(),
        updatedAt: new Date().toISOString(),
      };
      const index = goals.findIndex((g) => g.storeId === storeId);
      if (index >= 0) goals[index] = next;
      else goals.push(next);
      recordAuditLog({
        actor,
        action: '目标周期补救 · 按上期实际下调',
        entity: 'store',
        entityId: storeId,
        storeId,
        summary: `本月目标 ¥${goal.target} → ¥${loweredTarget}；依据：上期（${settlement.periodKey}）目标 ¥${settlement.target}、实际 ¥${settlement.actualGmv}（达成 ${Math.round((settlement.achievedPct ?? 0) * 100)}%）${
          baseline ? `；进度按本月至今 ¥${baseline.mtdGmv} 校准` : ''
        }`,
        category: 'human_ops',
        linkTo,
      });
      await exceptionsApi.resolve(
        meta.exceptionId,
        `人选择「按上期实际下调」：¥${goal.target} → ¥${loweredTarget}（上期实际取整到千元），进度已按本月至今校准`,
        actor,
      );
      return mockDelay({ applied: true, target: next.target });
    }

    const note =
      optionId === 'override' && !canLower
        ? '人选择「下调」时本月目标已不高于上期实际，Agent 未再下调，按沿用收尾'
        : settlement
          ? `人选择「沿用上期目标」：上期达成 ${Math.round((settlement.achievedPct ?? 0) * 100)}%，缺口 ¥${Math.max(
              0,
              settlement.target - (settlement.actualGmv ?? settlement.target),
            )} 记为已接受，本月目标仍为 ¥${goal.target}`
          : `人选择「沿用上期目标」：无可核对的上期结算事实，本月目标仍为 ¥${goal.target}`;
    recordAuditLog({
      actor,
      action: '目标周期补救 · 沿用上期目标',
      entity: 'store',
      entityId: storeId,
      storeId,
      summary: note,
      category: 'human_ops',
      linkTo,
    });
    await exceptionsApi.resolve(meta.exceptionId, note, actor);
    return mockDelay({ applied: false, target: goal.target });
  },

  /** P29.3 账户级目标（可能尚未设定）。 */
  getAccountGoal: () => mockDelay(accountGoal ? { ...accountGoal } : null),

  /**
   * 演示：把账户目标退回上一个自然月，复现「上期 · 待确认」。
   * 从未确认过账户目标时，用与 suggestAccountTarget 相同的基线口径补一条上期目标，
   * 保证刷新/重置后仍能走到这个状态；不写审计，因为它不是 Agent 或人的经营动作。
   */
  carryOverAccountGoalForDemo: () => {
    if (accountGoal) {
      accountGoal = { ...accountGoal, updatedAt: dayjs().subtract(1, 'month').toISOString() };
    } else {
      const projections = stores
        .map((store) => getStoreOperatingBaseline(store.name)?.projectedMonthGmv)
        .filter((value): value is number => typeof value === 'number');
      if (projections.length === 0) return mockDelay<AccountGoal | null>(null);
      accountGoal = {
        metric: 'gmv',
        target: roundTo(
          projections.reduce((sum, value) => sum + value, 0),
          1000,
        ),
        periodLabel: '本月',
        updatedAt: dayjs().subtract(1, 'month').toISOString(),
      };
    }
    saveMockPersistence();
    return mockDelay<AccountGoal>({ ...accountGoal });
  },

  /**
   * P29.3 Agent 建议账户目标：各店按当前节奏的月末预计之和，人可改可不改。
   * 没有任何可推算的店铺时返回 null，界面不编一个看起来合理的数字。
   */
  suggestAccountTarget: (storeIds: AllMallId[]) => {
    const projections = storeIds
      .map((storeId) => stores.find((s) => s.id === storeId))
      .map((store) => (store ? getStoreOperatingBaseline(store.name) : null))
      .filter((baseline): baseline is NonNullable<typeof baseline> => Boolean(baseline))
      .map((baseline) => baseline.projectedMonthGmv);
    if (projections.length === 0) {
      return mockDelay<{ target: number; coveredStores: number; storeCount: number } | null>(null);
    }
    return mockDelay({
      target: roundTo(projections.reduce((sum, value) => sum + value, 0), 1000),
      coveredStores: projections.length,
      storeCount: storeIds.length,
    });
  },

  /** P29.3 分配预演：给定账户目标，返回逐店权重、建议目标与承载提示；不写任何数据。 */
  proposeAccountAllocation: (target: number, storeIds: AllMallId[]) =>
    mockDelay(allocateAccountTarget(buildAccountBasis(storeIds), target)),

  /**
   * P29.3 人确认后写回：一次确认改 N 家店的目标，而不是逐店改 N 次。
   * 每家店的目标变更都留一条审计（旧值→新值 + 占比 + 依据），账户目标另留一条汇总。
   */
  adoptAccountAllocation: (
    allocation: AccountAllocation,
    meta: { actor: string; actorRole?: string },
  ) => {
    const actor = `${meta.actor.trim() || '当前用户'}${meta.actorRole ? `（${meta.actorRole}）` : ''}`;
    const covered = allocation.rows.filter((row) => row.hasBaseline);
    if (covered.length === 0 || allocation.allocatedTotal <= 0) {
      throw new Error('没有可分配的经营基线');
    }

    const updated: StoreGoal[] = [];
    covered.forEach((row) => {
      const goal = goals.find((g) => g.storeId === row.storeId) ?? defaultGoal(row.storeId);
      const next: StoreGoal = {
        ...goal,
        metric: 'gmv',
        target: row.suggestedTarget,
        periodKey: currentPeriodKey(),
        updatedAt: new Date().toISOString(),
      };
      const index = goals.findIndex((g) => g.storeId === row.storeId);
      if (index >= 0) goals[index] = next;
      else goals.push(next);
      updated.push(next);
      recordAuditLog({
        actor,
        action: '账户目标分配到店',
        entity: 'store',
        entityId: row.storeId,
        storeId: row.storeId,
        summary: `账户目标 ${formatCny(allocation.target)} 按近 30 天 GMV 占比 ${Math.round(
          row.share * 100,
        )}% 分配：${formatCny(row.currentTarget)} → ${formatCny(row.suggestedTarget)}；依据：近 30 天 ${formatCny(
          row.last30Gmv ?? 0,
        )}，月末预计 ${formatCny(row.projectedMonthEnd ?? 0)}`,
        category: 'human_ops',
        linkTo: `/dashboard?storeId=${row.storeId}`,
      });
    });

    accountGoal = {
      metric: 'gmv',
      target: allocation.target,
      periodLabel: '本月',
      updatedAt: new Date().toISOString(),
    };
    recordAuditLog({
      actor,
      action: '设定账户目标',
      entity: 'account',
      entityId: 'account',
      summary: `账户目标 ${formatCny(allocation.target)}，已分配到 ${covered.length}/${allocation.storeCount} 家店铺`,
      category: 'human_ops',
      linkTo: '/dashboard',
    });

    return mockDelay({ accountGoal, goals: updated });
  },

  /**
   * P3 归因回写：把已确认的动作效果计入目标进度。
   * 与 saveGoal 区分：这里不是人工改目标，而是执行结果回流。
   */
  addGoalProgress: (storeId: AllMallId, delta: number, summary: string) => {
    const goal = goals.find((g) => g.storeId === storeId) ?? defaultGoal(storeId);
    const next: StoreGoal = {
      ...goal,
      current: Math.min(goal.target, goal.current + Math.max(0, Math.round(delta))),
      updatedAt: new Date().toISOString(),
    };
    const index = goals.findIndex((g) => g.storeId === storeId);
    if (index >= 0) goals[index] = next;
    else goals.push(next);
    recordAuditLog({
      actor: 'Orchestrator',
      action: '目标进度回写',
      entity: 'store',
      entityId: storeId,
      summary: `${summary}，目标进度 +${Math.round(delta)}`,
      category: 'agent_action',
      linkTo: '/dashboard',
    });
    return { ...next };
  },

  listPolicies: () => mockDelay(policies.map((p) => ({ ...p }))),

  /** 返回该店铺的生效策略；护栏统一由目标派生，策略本身不再存护栏副本。 */
  getEffectivePolicy: (storeId: AllMallId, agentType?: string): EffectivePolicy => {
    const guards = deriveGuards(storeId);
    const policy = policies.find((p) => p.storeId === storeId);
    if (policy) {
      return { storeId, autonomy: policy.autonomy, source: 'store', budgetPool: policy.budgetPool, guards };
    }
    const scenarioKey = agentType ? getScenarioForAgent(agentType) : undefined;
    if (scenarioKey) {
      return {
        storeId,
        autonomy: getScenarioAutonomy(scenarioKey),
        source: 'scenario',
        budgetPool: DEFAULT_BUDGET_POOL,
        guards,
      };
    }
    return { storeId, autonomy: 'L1', source: 'system', budgetPool: DEFAULT_BUDGET_POOL, guards };
  },

  /** 设置店铺自主等级；传 null 表示清除覆盖，回到场景默认。 */
  saveAutonomy: (storeId: AllMallId, autonomy: AutonomyLevel | null) => {
    const index = policies.findIndex((p) => p.storeId === storeId);
    if (autonomy === null) {
      if (index >= 0) policies.splice(index, 1);
      recordAuditLog({
        actor: '当前用户',
        action: '清除店铺自主等级',
        entity: 'store',
        entityId: storeId,
        summary: '店铺自主等级恢复为场景默认',
        category: 'human_ops',
        linkTo: '/setup',
      });
      return mockDelay(null);
    }
    const current = index >= 0 ? policies[index] : undefined;
    const next: OperatingPolicy = {
      storeId,
      autonomy,
      budgetPool: current?.budgetPool ?? DEFAULT_BUDGET_POOL,
      updatedAt: new Date().toISOString(),
    };
    if (index >= 0) policies[index] = next;
    else policies.push(next);
    recordAuditLog({
      actor: '当前用户',
      action: '更新店铺自主等级',
      entity: 'store',
      entityId: storeId,
      summary: `店铺自主等级设为 ${autonomy}`,
      category: 'human_ops',
      linkTo: '/setup',
    });
    return mockDelay(next);
  },
};

/** 刷新持久化：目标与护栏是人的输入，刷新后必须还在，Agent 才有稳定依据。 */
registerMockState(
  'operatingModel',
  () => ({ goals, policies, accountGoal }),
  (value) => {
    const data = value as { goals?: StoreGoal[]; policies?: OperatingPolicy[]; accountGoal?: AccountGoal | null } | null;
    if (!data) return;
    goals.length = 0;
    goals.push(...(data.goals ?? []));
    policies.length = 0;
    policies.push(...(data.policies ?? []));
    accountGoal = data.accountGoal ?? null;
  },
);
