export type StoreStatus = 'pending_login' | 'connected' | 'login_required' | 'expired' | 'revoked';
export type StoreAuthMethod = 'credentials' | 'api_key' | 'oauth';
export type StoreServiceType = 'store_backend' | 'advertising' | 'customer_service' | 'logistics' | 'finance' | 'other';
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type RiskLevel = 'low' | 'medium' | 'high';
export type AllMallId = number;

export interface StoreConnection {
  id: AllMallId;
  serviceName: string;
  serviceType: StoreServiceType;
  authMethod: StoreAuthMethod;
  status: StoreStatus;
  apiKey?: string;
  apiSecret?: string;
  account?: string;
  runtimeProvider: 'mulerun' | 'direct';
  runtimeSessionId?: string;
  lastVerifiedAt?: string;
  createdAt: string;
}

export interface Store {
  id: AllMallId;
  name: string;
  platform: string;
  status: StoreStatus;
  authMethod: StoreAuthMethod;
  runtimeProvider: 'mulerun';
  runtimeSessionId?: string;
  apiKey?: string;
  apiSecret?: string;
  oauthProvider?: string;
  account?: string;
  region?: string;
  currency?: string;
  lastVerifiedAt?: string;
  /** Predicted session expiry time — shown in proactive expiry warnings (D7.3). */
  authExpiresAt?: string;
  createdAt: string;
  recentTaskIds: AllMallId[];
  connections: StoreConnection[];
}

export interface TimelineEvent {
  id: AllMallId;
  type:
    | 'run_started'
    | 'step_started'
    | 'step_completed'
    | 'approval_required'
    | 'login_required'
    | 'run_succeeded'
    | 'run_failed';
  title: string;
  summary: string;
  at: string;
  artifactUrl?: string;
}

export interface Task {
  id: AllMallId;
  title: string;
  storeId: AllMallId;
  agentType: AgentType;
  goal: string;
  status: TaskStatus;
  riskLevel: RiskLevel;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEvent[];
}

/** P29.4 可被店铺目标直接调整的三类护栏；direction/dependency/double_count 不在此列。 */
export type GuardBlockKind = 'margin' | 'discount_cap' | 'budget';

/**
 * P57：审批提交时冻结的提案经济口径。护栏在提案生成后仍可能被人改动，
 * 决策前必须拿「同一套口径 × 当前护栏」重算，否则旧判断会越过新边界被执行。
 */
export interface ApprovalGuardContext {
  action: ProposalAction;
  cost: number;
  projectedGrossMargin?: number;
  discountPct?: number;
  /** 仲裁时的目标优先级：清仓目标下毛利护栏不适用，复核必须沿用同一口径。 */
  priority: GoalPriority;
}

/** P57：按当前生效护栏复核出的越界项；actual / limit 让人一眼看出「越了多少」。 */
export interface ApprovalGuardViolation {
  kind: GuardBlockKind;
  actual: number;
  limit: number;
}

export interface Approval {
  id: AllMallId;
  taskId: AllMallId;
  storeId: AllMallId;
  storeName: string;
  agentType: string;
  title: string;
  reason: string;
  proposedAction: string;
  beforeValue: string;
  afterValue: string;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  /** P57：只有经营周期提交的审批带这项；首启/历史审批没有它就不复核，避免误报。 */
  guardContext?: ApprovalGuardContext;
  /** P57：接口派生（不入库）——按店铺当前护栏重算的越界项，空表示仍合规。 */
  guardViolations?: ApprovalGuardViolation[];
  // WS-B (B3/B4): appended optional fields — structured evidence & decision metadata
  evidence?: ApprovalEvidenceField[];
  decisionNote?: string;
  decidedBy?: string;
  priorApprovals?: PriorApprovalRecord[];
  /** 创建时由店铺策略解析出的审批要求；历史数据缺失时按当前策略实时解析 */
  requirement?: ApprovalRequirement;
  /** P51：高风险审批超时未决时，Agent 已将其升级给管理员的时间（只记一次） */
  timeoutEscalatedAt?: string;
}

export type AuditCategory = 'approval' | 'agent_action' | 'human_ops' | 'system_event' | 'store_session' | 'task' | 'agent' | 'exception' | 'store';

/** P45.1：护栏变更的结构化原值——摘要给人读，这里留给「撤销回到变更前」用。 */
export interface AuditGuardChange {
  field: 'minGrossMargin' | 'maxDiscountPct' | 'monthlyBudgetCap';
  from: number;
  to: number;
}

/** P46.3：预算池再分配的结构化原值——按批次留下每家店的旧/新预算，支持整批撤销。 */
export interface AuditBudgetChange {
  batchId: string;
  from: number;
  to: number;
}

export interface AuditLog {
  id: AllMallId;
  actor: string;
  action: string;
  entity: string;
  entityId: AllMallId | string;
  summary: string;
  at: string;
  category: AuditCategory;
  linkTo?: string;
  /** 可归因到店铺的操作带上店铺 id，审计页才能按店筛选；系统级事件为空。 */
  storeId?: AllMallId;
  /** P45.1：只有护栏变更带这项；没有它（历史记录）就不提供撤销，不猜旧值。 */
  guardChanges?: AuditGuardChange[];
  /** P46.3：只有预算池再分配/撤销带这项，含批次与单店旧值 → 新值。 */
  budgetChange?: AuditBudgetChange;
}

export interface Member {
  id: AllMallId;
  name: string;
  email: string;
  role: 'Owner' | 'Admin' | 'Operator' | 'Approver' | 'Finance' | 'Viewer';
  status: 'active' | 'invited';
  /** P30.5：该成员负责的店铺；为空表示不参与店铺维度路由，只按角色兜底。 */
  storeIds?: AllMallId[];
}

// ===== Agent Management =====

export type AgentTriggerMode = 'manual' | 'scheduled' | 'event';

export type AgentType =
  | 'login_bootstrap'
  | 'product_launch'
  | 'ads_optimizer'
  | 'pricing_strategy'
  | 'crm_retention'
  | 'review_manager'
  | 'customer_service'
  | 'after_sales'
  | 'competitor_intel'
  | 'creative_factory'
  | 'inventory_alert'
  | 'risk_control'
  | 'finance_audit'
  | 'promotion_campaign'
  | 'live_stream_ops';

export type AgentLayer = 'foundation' | 'traffic' | 'growth' | 'support' | 'standalone';

export interface AgentConfig {
  agentType: AgentType;
  displayName: string;
  description: string;
  icon: string;
  layer: AgentLayer;
  riskLevel: RiskLevel;
  triggerMode: AgentTriggerMode;
  needsConfig: boolean;
  needsApproval: boolean;
  dependsOn: AgentType[];
  servesFor: AgentType[];
  required: boolean;           // 必须启用，不可关闭
  cronExpression?: string;
  eventTrigger?: string;
  executionParams: { key: string; label: string; defaultValue: string; type?: 'number' | 'text' | 'select'; options?: string[] }[];
  riskGuard: {
    maxBudgetPerAction: number;
    actionWhitelist: string[];
    actionBlacklist: string[];
  };
  approvalStrategy: {
    requireApproval: boolean;
    approverRole: string;
    requireSecondApproval: boolean;
    autoApproveRules?: { maxOrderValue?: number; maxPriceChangePct?: number; maxBudgetChange?: number; lowRiskOnly?: boolean };
  };
  modelBinding: {
    provider: string;
    model: string;
  };
  retryPolicy: {
    maxRetries: number;
    retryIntervalMinutes: number;
  };
  timeoutMinutes: number;
  enabled: boolean;
  strategyConfig?: AgentStrategyConfig;
}

export type PricingMode = 'market' | 'cost' | 'manual';

export interface AgentStrategyConfig {
  pricingRule?: {
    mode: PricingMode;
    // 市场驱动
    targetMargin?: number;
    competitorStrategy?: 'undercut' | 'match' | 'premium';
    // 成本驱动
    costMultiplier?: number;
    roundUp?: boolean;
    costFile?: string;
    // 自主定价
    floorPrice?: number;
    ceilingPrice?: number;
    // 通用
    currency: string;
  };
  adSpendBudget?: { dailyCap: number; monthlyCap: number; targetROI?: number; lookbackDays?: number };
  seoKeywords?: { keywords: string[]; lastGenerated: string; source: string };
  targetAudience?: { tags: string[]; lastGenerated: string; source: string };
  crmConfig?: { discountCap: number; segmentCount: number };
  afterSalesConfig?: { autoRefundCap: number; returnAddress: string };
  creativeConfig?: { outputSizes: string; copyTone: string };
  riskControlConfig?: RiskControlConfig;
  inventoryConfig?: { lowStockThreshold: number; deadStockDays: number; autoReplenishEnabled: boolean; replenishLeadTimeDays: number };
  intelConfig?: { monitorFrequencyHours: number; monitoredCategories: string[]; competitorUrls: string[]; priceAlertThresholdPct: number; autoPushDownstream: boolean };
  financeConfig?: { autoReconcileDay: number; discrepancyAlertThreshold: number; autoGenerateReport: boolean };
  promotionConfig?: { maxDiscountPercent: number; campaignBudget: number; autoSchedule: boolean; targetPlatforms: string[]; autoTriggerRules: { deadStockDays: number; deadStockDiscount: number; lowStockClearance: boolean; competitorPriceDropThreshold: number; seasonalAutoPromo: boolean } };
  liveStreamConfig?: { autoPinProducts: boolean; replyTemplate: string; performanceAlertThreshold: number; peakHourBoost: boolean };
  reviewConfig?: { autoReplyThreshold: number; replyTone: string };
  csConfig?: { autoReplyEnabled: boolean; escalateKeywords: string[] };
  bootstrapConfig?: { notifyChannels: string; checkIntervalMinutes: number; maxRetries: number; autoRelaunchEnabled: boolean };
  productLaunchConfig?: { defaultCategory: string; targetMarket: string };
}

export interface RiskControlConfig {
  compliance: {
    adLawFilter: boolean;          // 广告法禁用词过滤
    platformRuleCheck: boolean;    // 平台规则合规检测
    falseClaimDetection: boolean;  // 虚假宣传检测
  };
  behavior: {
    roiFloorThreshold: number;     // ROI 红线
    actionFrequencyLimit: number;  // 操作频率限制（次/分钟）
    priceDeviationPercent: number; // 价格异常偏差阈值（%）
  };
  business: {
    minPriceRatio: number;         // 最低售价（成本×）
    categoryMatchCheck: boolean;   // 类目错放检测
    imageComplianceCheck: boolean; // 图片合规检测（水印/Logo/版权）
    inventorySafetyCheck: boolean; // 库存透支保护
    negativeReviewSurgeCheck: boolean; // 差评激增预警
  };
}

export interface AgentRunStats {
  totalRuns: number;
  successRate: number;
  avgDurationMinutes: number;
  avgTokenUsage: number;
  avgCost: number;
  /** ISO timestamp of the most recent run — the real "last executed" time. */
  lastRunAt?: string;
  trend: { date: string; runs: number; successRate: number }[];
  failureReasons: { reason: string; count: number }[];
}

// ===== Store Config =====

export interface StoreConfig {
  storeId: AllMallId;
  riskThresholds: {
    maxBudgetAdjustment: number;
    highRiskActions: string[];
  };
  operationWindow: {
    enabled: boolean;
    startTime: string;
    endTime: string;
    timezone: string;
  };
  autoReconnect: {
    enabled: boolean;
    retryAfterMinutes: number;
    maxRetries: number;
  };
  approvalRules: {
    useIndependentApprover: boolean;
    approverMemberId?: AllMallId;
    enableSecondApproval: boolean;
  };
}

// ===== Approval Policy =====

export interface ApprovalPolicy {
  id: AllMallId;
  riskLevel: RiskLevel;
  action: 'auto_execute' | 'single_approval' | 'dual_approval';
  approverType: 'role' | 'specific';
  approverRole?: string;
  approverMemberId?: AllMallId;
  timeoutHours: number;
  timeoutAction: 'auto_reject' | 'auto_approve' | 'escalate';
  storeSpecificRules: { storeId: AllMallId; riskLevel: RiskLevel; action: string }[];
}

// ===== Business Dashboard Metrics =====

export interface BusinessMetrics {
  gmv: { today: number; yesterday: number; lastWeekSameDay: number };
  orders: { today: number; yesterday: number; lastWeekSameDay: number };
  aov: number;
  storeCount: { online: number; total: number };
  gmvTrend: { date: string; gmv: number; orders: number }[];
  storeGmvRank: { storeName: string; gmv: number; platform: string }[];
  adMetrics: {
    todaySpend: number;
    roas: number;
    cpm: number;
    cpc: number;
    ctr: number;
    cvr: number;
    budgetLimit: number;
    targetRoas: number;
    trend: { date: string; spend: number; gmv: number }[];
    lowPerformingPlans: { name: string; spend: number; roi: number }[];
  };
  afterSales: {
    returnRate: number;
    returnAmount: number;
    negativeReviews: number;
    respondedReviews: number;
    reviewResponseRate: number;
    storeRating: number;
    disputes: { pending: number; processing: number };
    avgResponseMinutes: number;
    reviewTrend: { date: string; returnRate: number; negativeCount: number }[];
  };
  inventory: {
    totalSkus: number;
    lowStockCount: number;
    slowMovingCount: number;
    outOfStockCount: number;
  };
}

// ===== Finance =====

export interface SubscriptionPlan {
  tier: 'Free' | 'Starter' | 'Professional' | 'Enterprise';
  storeLimit: number;
  agentConcurrency: number;
  monthlyOps: number;
  tokenQuota: number;
  price: number;
  currency: string;
}

export interface BillingDetail {
  baseSubscription: number;
  overageItems: { description: string; amount: number; currency: string }[];
  discount: number;
  total: number;
  currency: string;
}

export interface BillingRecord {
  id: string;
  period: string;
  status: 'pending' | 'paid' | 'overdue';
  amount: number;
  currency: string;
  dueDate: string;
  paidAt?: string;
  invoiceUrl?: string;
}

export interface CostAnalysis {
  byStore: { storeName: string; agentCalls: number; tokenCost: number }[];
  byAgent: { agentType: string; calls: number; cost: number }[];
  estimatedSaving: { manualCostPerOp: number; automatedOps: number; savedAmount: number };
  recommendation: string;
}

// ===== Model Management =====

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  isCustom: boolean;
  apiKey?: string;
  active: boolean;
}

export interface ModelUsageStats {
  modelId: string;
  modelName: string;
  totalCalls: number;
  totalTokens: number;
  trend: { date: string; calls: number }[];
}

export interface AgentModelBinding {
  agentType: AgentType;
  agentDisplayName: string;
  boundModelId: string;
  boundModelName: string;
}

// ===== WS-D: Scenario-first configuration & agent trust (S2/S3/S4) =====

/** 5 个托管场景包（product-design.md 五、D1 决策） */
export type ScenarioKey =
  | 'pricing_promo'      // 智能定价与促销
  | 'cs_aftersales'      // 客服与售后
  | 'inventory'          // 库存与补货
  | 'fulfillment_risk'   // 订单履约与风控
  | 'listing_content';   // 商品上架与内容

/** 场景自主等级：L1 全部需审批 / L2 仅高风险需审批 / L3 仅通知（D5 决策） */
export type AutonomyLevel = 'L1' | 'L2' | 'L3';

/** 场景的按店铺参数覆盖（scenario defaults → per-store overrides → per-agent advanced） */
export type ScenarioStoreOverride = Record<string, number | string | boolean>;

/** 场景运行时状态（mock 层持久化） */
export interface ScenarioState {
  key: ScenarioKey;
  enabled: boolean;
  autonomy: AutonomyLevel;
  /** 用户已忽略当前放宽建议 */
  trustSuggestionDismissed: boolean;
  /** storeId → 参数覆盖 */
  storeOverrides: Record<string, ScenarioStoreOverride>;
}

/** 周报摘要占位数据（S3 weekly digest stub） */
export interface WeeklyDigest {
  weekLabel: string;
  autonomousActions: number;
  approvalsRequested: number;
  approvalsApproved: number;
  hoursSaved: number;
  /** Per-scenario results, phrased for a merchant: `outcomeKey` is a translatable
   *  "what it did" summary, hoursSaved a rough labour-savings estimate. */
  perScenario: { key: ScenarioKey; actions: number; approvals: number; hoursSaved: number; outcomeKey: string }[];
}

/** 决策与结果记录（S4 outcomes 数据契约，mock） */
export interface AgentOutcomeRecord {
  id: AllMallId;
  agentType: AgentType;
  /** 动作描述，如 "上调 SKU A-102 售价 ¥86 → ¥92" */
  action: string;
  decidedAt: string;
  decision: 'auto' | 'approved' | 'rejected';
  /** 关联指标名，如 "日均销量" */
  metric: string;
  before: string;
  after3d: string;
  /** 未回收时为空 */
  after7d?: string;
  assessment: 'positive' | 'neutral' | 'negative' | 'pending';
  assessmentNote: string;
}

// ===== Operating model: merchant profile / store goal / policy =====

/** 商家类型：通用型（中小商家开箱即用）/ 垂类型（按行业定制） */
export type MerchantType = 'general' | 'vertical';

export type GoalMetric = 'gmv' | 'gross_profit' | 'inventory_turnover' | 'cs_sla';
export type GoalHorizon = 'month' | 'quarter';
export type GoalPriority = 'growth' | 'profit' | 'clearance';

/** 商家画像 — 决定默认 Goal/Policy 模板（L1 商家模板层） */
export interface MerchantProfile {
  type: MerchantType;
  industry: string;
  scale: 'small' | 'medium' | 'large';
}

/**
 * P33.2 目标周期结算：上一个自然月的目标与实际结果。
 * 目标跨月不再静默沿用，Agent 结算上期后把结论留在目标上，供人回看。
 */
export interface GoalPeriodSettlement {
  /** 被结算的月份（YYYY-MM）。 */
  periodKey: string;
  target: number;
  /** 该月实际 GMV；无可用经营基线时为 null，不编数字。 */
  actualGmv: number | null;
  /** 达成率，1 = 100%；无法结算时为 null。 */
  achievedPct: number | null;
  verdict: 'achieved' | 'missed' | 'unknown';
  settledAt: string;
}

/** 店铺经营目标 — 挂在店铺上，而不是挂在单个任务上 */
export interface StoreGoal {
  storeId: AllMallId;
  metric: GoalMetric;
  target: number;
  current: number;
  horizon: GoalHorizon;
  periodLabel: string;
  /** 目标归属月份（YYYY-MM）：目标属于哪个月是事实，不靠默认值猜。 */
  periodKey: string;
  priority: GoalPriority;
  constraints: {
    minGrossMargin: number;
    maxDiscountPct: number;
    monthlyBudgetCap: number;
  };
  /** 最近一次跨月结转的结算结果；从未跨月为 undefined。 */
  lastSettlement?: GoalPeriodSettlement;
  /** P47：临时放宽的护栏。到期后 Agent 只在当前值仍等于临时值时才恢复原值。 */
  guardExpiries?: GuardExpiries;
  updatedAt: string;
}

/** P47：单条临时护栏的到期信息。 */
export interface GuardExpiry {
  /** 人设的临时值。 */
  value: number;
  /** 到期后恢复的原值。 */
  baseValue: number;
  /** 到期时间（ISO，含当天结束）。 */
  until: string;
  /** 人设定临时值的时间，用于回看。 */
  setAt: string;
}

export type GuardExpiries = Partial<Record<keyof StoreGoal['constraints'], GuardExpiry>>;

/**
 * P29.3 账户级目标 — 人只下一个账户月度 GMV 目标，分配到店由 Agent 计算。
 * 单店目标仍是执行口径（StoreGoal），账户目标只解决「人不想逐店算目标」。
 */
export interface AccountGoal {
  metric: 'gmv';
  target: number;
  periodLabel: string;
  updatedAt: string;
}

/**
 * 店铺级运营策略 — 只描述「人授权到什么程度」（自主等级 + 预算池）。
 * P28：护栏不再在策略里单独存储，唯一可编辑源是 StoreGoal.constraints，
 * 生效护栏由 operatingModel 派生，避免同一护栏两处存储、两处展示。
 */
export interface OperatingPolicy {
  storeId: AllMallId;
  autonomy: AutonomyLevel;
  budgetPool: { adMonthly: number; promoMonthly: number };
  updatedAt: string;
}

/** 派生护栏 — 从 StoreGoal.constraints 生成，只读；含两项不可编辑的系统底线。 */
export interface StoreGuards {
  minGrossMargin: number;
  maxDiscountPct: number;
  monthlyBudgetCap: number;
  maxPriceChangePct: number;
  autoRefundCap: number;
}

/** 审批要求：自动执行 / 单人审批 / 双人审批 */
export type ApprovalRequirement = 'auto' | 'single' | 'dual';

/** 生效策略的来源：店铺级覆盖 / 场景默认 / 系统兜底 */
export type PolicySource = 'store' | 'scenario' | 'system';

export interface EffectivePolicy {
  storeId: AllMallId;
  autonomy: AutonomyLevel;
  source: PolicySource;
  budgetPool: OperatingPolicy['budgetPool'];
  guards: StoreGuards;
}

// ===== Orchestrator: operating cycle / proposals / conflict arbitration =====

/** 经营周期阶段：感知 → 诊断 → 提案 → 仲裁 → 执行 */
export type CycleStage = 'observe' | 'diagnose' | 'propose' | 'arbitrate' | 'execute';

export type ProposalAction =
  | 'raise_price'
  | 'cut_price'
  | 'increase_ad_budget'
  | 'increase_discount'
  | 'clear_stock'
  | 'replenish_stock'
  /** 首启引导里的口碑修复动作，用于把审批效果挂到店铺目标上 */
  | 'reply_reviews';

/** 提案在仲裁后的去向：待提交 / 已选入 / 被拦截 / 延后 / 已提交 */
export type ProposalStatus = 'pending' | 'selected' | 'blocked' | 'deferred' | 'submitted';

export type ConflictType = 'direction' | 'budget' | 'margin' | 'discount_cap' | 'dependency' | 'double_count';

/** 单个 Agent 在一个商品/店铺目标上的行动提案 */
export interface CycleProposal {
  id: AllMallId;
  cycleId: AllMallId;
  agentType: AgentType;
  scenarioKey: ScenarioKey;
  action: ProposalAction;
  targetLabel: string;
  before: string;
  after: string;
  /** 预期对目标指标的贡献；指标含义由 Goal.metric 解释 */
  expectedImpact: number;
  /** 直接成本（预算/让利），用于预算护栏判定 */
  cost: number;
  riskLevel: RiskLevel;
  /** 折扣类提案的执行后毛利率，用于毛利护栏判定 */
  projectedGrossMargin?: number;
  /** 折扣力度（%），用于折扣上限护栏判定 */
  discountPct?: number;
  status: ProposalStatus;
}

/** P8 人工裁决结论：维持自动仲裁 / 改判 */
export type ArbitrationDecision = 'uphold' | 'override';

/** P8 裁决理由 — 记录“为什么这样裁”，供复盘和规则沉淀 */
export type ArbitrationReason =
  | 'goal_priority'
  | 'protect_margin'
  | 'protect_stock'
  | 'platform_recommendation'
  | 'manual';

/** 冲突仲裁结论 — 只记录“谁胜出”和“依据”，文案在 UI 侧按 i18n 组装 */
export interface ConflictResolution {
  id: AllMallId;
  type: ConflictType;
  targetLabel: string;
  winnerProposalId?: AllMallId;
  loserProposalIds: AllMallId[];
  basis: 'goal_priority' | 'guardrail';
  detail: {
    priority?: GoalPriority;
    remainingBudget?: number;
    requiredBudget?: number;
    projectedMargin?: number;
    minMargin?: number;
    /** 折扣上限护栏：本提案折扣力度与目标允许的上限 */
    discountPct?: number;
    maxDiscountPct?: number;
    /** 依赖门控：店铺当前低于安全库存的 SKU 数 */
    shortageCount?: number;
    /** 重复计益：被延后的重复动作预期贡献 */
    duplicateImpact?: number;
    /** P8 已沉淀的方向偏好：本轮仲裁直接按此方向，不再重复问人 */
    preferredDirection?: 'raise' | 'discount';
  };
  /** P8 人工裁决：保留自动结论或改判 */
  decision?: ArbitrationDecision;
  decisionReason?: ArbitrationReason;
  decidedAt?: string;
  /** P9 可追溯：谁做的决定、补充说明 */
  decidedBy?: string;
  decisionNote?: string;
  /** P9 改判后被放行、可直接提交的动作 */
  releasedProposalIds?: AllMallId[];
}

/** P5 多 Agent 协同：互补动作按顺序执行，避免“各自最优、合起来互相抵消”。 */
export type CollaborationKind = 'restock_price_ads' | 'restock_ads' | 'price_ads';

/** 协同组状态：可执行 / 部分受阻 / 未成立 / 已协同执行 */
export type CollaborationStatus = 'ready' | 'partial' | 'blocked' | 'done';

export interface AgentCollaboration {
  id: AllMallId;
  kind: CollaborationKind;
  /** 主 Agent：先执行、对协同结果负责 */
  leadAgent: AgentType;
  /** 参与协同的全部 Agent（含主 Agent） */
  memberAgents: AgentType[];
  proposalIds: AllMallId[];
  /** 建议执行顺序 — 先补货再加投，避免卖断货 */
  sequence: AllMallId[];
  /** 协同预期贡献：按可执行成员合计，完全成立时叠加协同系数 */
  combinedImpact: number;
  /** 协同系数，UI 明示 */
  factor: number;
  status: CollaborationStatus;
  /** 当前可执行（selected）成员数 */
  executableCount: number;
  memberCount: number;
}

/** 归因回写状态：待审批后回写 / 已回写 / 已取消（不回写） */
export type OutcomeStatus = 'projected' | 'realized' | 'lost';

/** 提案执行后的效果记录 — 把动作与目标进度连起来，供下一轮诊断读取 */
export interface GoalOutcome {
  id: AllMallId;
  storeId: AllMallId;
  cycleId: AllMallId;
  proposalId: AllMallId;
  /** 审批路径下关联的审批单；自动执行时为空 */
  approvalId?: AllMallId;
  agentType: AgentType;
  action: ProposalAction;
  targetLabel: string;
  /** 效果计入的目标指标，按提案所属周期的诊断指标解释 */
  metric: GoalMetric;
  expectedImpact: number;
  /** 实测效果；projected / lost 状态为空 */
  actualImpact?: number;
  status: OutcomeStatus;
  /** P6 执行结果：自动执行成功后仍可能失败/超时，用于升级给人 */
  executionStatus?: 'succeeded' | 'failed' | 'timeout';
  recordedAt: string;
}

export interface OperatingCycle {
  id: AllMallId;
  storeId: AllMallId;
  periodLabel: string;
  stage: CycleStage;
  generatedAt?: string;
  /** 本轮诊断：目标差距 */
  diagnosis: { metric: GoalMetric; target: number; current: number; gapPct: number; priority: GoalPriority };
  proposals: CycleProposal[];
  conflicts: ConflictResolution[];
  /** P5 多 Agent 协同组 */
  collaborations: AgentCollaboration[];
  /** 该店铺累计的归因回写记录（P3） */
  outcomes: GoalOutcome[];
  /** P6 本轮由谁触发：人工 / 定时 / 事件 */
  triggeredBy?: CycleTrigger;
  /** P6 触发原因，仅自动触发时有值 */
  triggerReason?: 'cadence' | 'stock_alert';
  /** P10 本轮仲裁实际采用的护栏，供目标/护栏被改后提示重新生成 */
  guardSnapshot?: {
    minGrossMargin: number;
    maxDiscountPct: number;
    monthlyBudgetCap: number;
  };
}

/** 方案触发来源：manual 人在环路、schedule 定时、event 事件、guard 护栏到期收回后由 Agent 重排。 */
export type CycleTrigger = 'manual' | 'schedule' | 'event' | 'guard';

// ===== Store Business Detail =====

export interface StoreBusinessDetail {
  storeId: AllMallId;
  storeName: string;
  gmv: { today: number; yesterday: number; trend: { date: string; value: number }[] };
  orders: { today: number; yesterday: number; trend: { date: string; value: number }[] };
  aov: number;
  adMetrics: {
    todaySpend: number;
    roas: number;
    cpm: number;
    cpc: number;
    ctr: number;
    cvr: number;
    budgetLimit: number;
    trend: { date: string; spend: number; gmv: number }[];
    campaigns: { name: string; spend: number; roi: number; status: string }[];
  };
  afterSales: {
    returnRate: number;
    returnAmount: number;
    negativeReviews: number;
    unresolvedReviews: number;
    storeRating: number;
    disputes: { pending: number; processing: number };
  };
  inventory: {
    totalSkus: number;
    lowStockCount: number;
    slowMovingCount: number;
    outOfStockCount: number;
    lowStockItems: { sku: string; name: string; stock: number; safetyStock: number }[];
  };
  topProducts: { name: string; gmv: number; orders: number; sku: string }[];
  /** What the Agents did for this store today — powers the store card's "AI pulse" strip. */
  aiActivity: {
    priceAdjustments: number;
    csReplies: number;
    riskIntercepts: number;
    hoursSaved: number;
  };
}

// ===== WS-F: Notification channels & event matrix (appended) =====

export type NotificationChannelType = 'feishu' | 'dingtalk' | 'webhook';

export type NotificationEventKey = 'approval_required' | 'relogin_required' | 'run_failed';

export interface NotificationChannelConfig {
  id: string;
  type: NotificationChannelType;
  name: string;
  status: 'connected' | 'not_configured';
  endpoint?: string;
  /** Event subscription matrix: which runtime events this channel receives. */
  events: Record<NotificationEventKey, boolean>;
}

// ===== WS-B: Action Inbox & approval evidence (appended) =====

/**
 * WS-B (B3): one structured before/after evidence field for an approval.
 * `beforeNumeric`/`afterNumeric` allow deltas to be computed from data
 * instead of being hardcoded in the UI; `unit` renders alongside deltas.
 */
export interface ApprovalEvidenceField {
  label: string;
  before: string;
  after: string;
  beforeNumeric?: number;
  afterNumeric?: number;
  unit?: string;
}

/** WS-B (B4): one completed approval step for dual-approval progress. */
export interface PriorApprovalRecord {
  approver: string;
  at: string;
  note?: string;
}

/** WS-B (B1): item kinds aggregated by the unified Action Inbox (/inbox). */
/**
 * 'product_draft' added in D6/§3.14.9: draft/pending_review product listings fold into
 * the inbox. 'product_new'/'product_merge'/'product_conflict' added for Smart Sync
 * Tier 2 decisions (§ Smart Sync, Node 3) — 'store_relogin' reuses the existing
 * 'relogin' kind rather than introducing a parallel representation.
 */
export type InboxItemKind = 'approval' | 'exception' | 'relogin' | 'store_pending' | 'order_exception' | 'product_draft' | 'product_new' | 'product_merge' | 'product_conflict';

// ===== Products (D6: SPU + per-store Listing, product-design.md §3.14) =====
//
// A row in the product list is a merchant-owned master product (SPU), unique across
// stores. The store is an *attribute* of the product — how/where it's listed — not the
// primary grouping. A master may exist with zero listings (create first, list later).
// "Not listed on store X" is derived (merchant's stores − stores with a listing), never
// stored redundantly.

export type ListingStatus = 'listed' | 'draft' | 'pending_review' | 'delisted';
export type InventoryMode = 'shared' | 'independent';
/** Provenance of a master attribute value: seeded from a store's sync, or user-edited (locked from sync overwrite). */
export type AttributeProvenance = { source: 'ai'; storeId: AllMallId } | { source: 'manual' };

/** Per-field provenance for the master attributes that can be AI-seeded then user-locked (D6 sub-decision 2). */
export interface ProductProvenance {
  name: AttributeProvenance;
  images: AttributeProvenance;
  category: AttributeProvenance;
  cost: AttributeProvenance;
  description: AttributeProvenance;
}

/** Master product (SPU) — merchant-owned, unique across stores. May have zero listings. */
export interface Product {
  id: AllMallId;
  /** Merchant SKU/货号 — the primary merge key for cross-store matching (D6 sub-decision 1). */
  spuCode: string;
  name: string;
  images: string[];
  category: string;
  cost: number;
  description: string;
  /** Shared total stock pool the master holds; listings draw from or carve out of it. */
  totalStock: number;
  /** Store whose values seeded the master attributes; snapshotted default = highest GMV, user-overridable. */
  primaryStoreId: AllMallId;
  provenance: ProductProvenance;
  createdBy: 'ai' | 'manual';
  createdAt: string;
}

/** A product's presence on one store — the "shelf listing", not the product itself. */
export interface ProductListing {
  id: AllMallId;
  productId: AllMallId;
  storeId: AllMallId;
  /** External platform product/SKU reference — not an AllMall-owned id. */
  platformSkuRef: string;
  sellingPrice: number;
  status: ListingStatus;
  inventoryMode: InventoryMode;
  /** Only meaningful when inventoryMode === 'independent': a fixed slice carved from the product's totalStock. */
  allocation?: number;
  /** Only meaningful when inventoryMode === 'shared': reserved from the shared pool, never sold. */
  safetyStock?: number;
  lastSyncedAt: string;
}

/** Derived, never stored: available-to-sell units for one listing (D6 sub-decision 3). */
export function listingAvailableStock(product: Product, listing: ProductListing): number {
  if (listing.inventoryMode === 'independent') return listing.allocation ?? 0;
  return Math.max(0, product.totalStock - (listing.safetyStock ?? 0));
}

/** A "possible duplicate" match between two masters awaiting human review (60–95% confidence band, D6 sub-decision 1). */
export interface ProductMergeSuggestion {
  id: AllMallId;
  productAId: AllMallId;
  productBId: AllMallId;
  confidence: number;
  /** Which signals contributed to the match, for the reviewer to judge (e.g. "标题相似度 92%"). */
  matchFactors: string[];
  createdAt: string;
}

// ===== Smart Sync (Products) — one-way platform → AllMall read-only pull =====
//
// The system proactively syncs, reconciles, and pre-computes recommendations in the
// background; the merchant reviews a results digest and confirms (mostly one-click)
// instead of operating step by step. Sync only pulls; listing/price pushes back to a
// platform go only through the existing publish flow (list-to-store, edit listing).
//
// Two tiers: Tier 0/1 changes are low-risk and applied automatically (price/stock
// updates, delists, and ≥95%-confidence/same-SPU matches); Tier 2 changes need a human
// call and surface as Action Inbox decisions with an AI-recommended default.

export type SyncRunStatus = 'idle' | 'running' | 'success' | 'failed';

/** A low-risk change the sync engine applied automatically, with no review needed (Tier 0/1). */
export interface AutoSyncChange {
  id: AllMallId;
  type: 'price_update' | 'stock_update' | 'delist' | 'auto_merge';
  productId: AllMallId;
  storeId?: AllMallId;
  summary: string;
  at: string;
}

/** The kinds of decisions a sync pass can leave pending for a human (Tier 2). 'store_relogin' is represented by the existing relogin inbox item, not a stored record here. */
export type SyncDecisionType = 'new_product' | 'merge_suggestion' | 'field_conflict' | 'store_relogin';

/** One store's health as of the last sync pass — derived, not stored redundantly. */
export interface StoreSyncHealth {
  storeId: AllMallId;
  lastSyncedAt: string | null;
  needsRelogin: boolean;
  /** Connected but hasn't synced recently. */
  stale: boolean;
}

/** The digest of one sync pass — what the merchant reviews instead of operating step by step. */
export interface SyncResult {
  startedAt: string;
  /** Timestamp of the last *successful* pass — kept as-is (not overwritten) on failure. */
  lastSyncedAt: string;
  status: SyncRunStatus;
  autoApplied: AutoSyncChange[];
  pendingDecisionCount: number;
  perStore: StoreSyncHealth[];
  /** Set when status is 'failed'. */
  errorMessage?: string;
}

// ===== D7 Round 2: Store Smart Flow — service gaps, smart summary, listing suggestions =====

/** A high-value service that a connected store doesn't have authorised yet. */
export interface ServiceGap {
  /** Unique gap id (generated). */
  id: AllMallId;
  storeId: AllMallId;
  /** The missing service type. */
  serviceType: StoreServiceType;
  /** Human-readable name, e.g. "千川广告", "飞鸽客服". */
  serviceName: string;
  /** Which Agent(s) are blocked from running without this service. */
  blockedAgents: string[];
  /** Why the service is being suggested now (e.g. "store has 28410 orders but no auto-reply capability"). */
  rationale: string;
  /** Estimated monthly GMV impact if service is added (0 = unknown). */
  estimatedGmvImpact: number;
  severity: 'high' | 'medium' | 'low';
}

/** The post-connection smart summary shown after a store is connected. */
export interface StoreSmartSummary {
  storeId: AllMallId;
  /** Key metrics detected immediately after connection. */
  metrics: {
    products: number;
    skus: number;
    orders: number;
    reviews: number;
  };
  /** Services detected as missing — these block some agents. */
  serviceGaps: Pick<ServiceGap, 'serviceType' | 'serviceName' | 'blockedAgents'>[];
  /** Recommended first action after connection. */
  recommendedFirstAction: {
    type: 'fill_service_gap' | 'start_agent' | 'list_products';
    title: string;
    description: string;
  };
  /** Products that can be listed to this new store. */
  listableProductCount: number;
}

/** A product that can be batch-listed to a store it isn't on yet. */
export interface BulkListingCandidate {
  productId: AllMallId;
  spuCode: string;
  name: string;
  image: string;
  suggestedPrice: number;
  /** Stores this product is already listed on. */
  listedOnStores: string[];
}

// ===== Smart Sync (Products) continued =====
export interface NewProductCandidate {
  id: AllMallId;
  storeId: AllMallId;
  platformSkuRef: string;
  name: string;
  images: string[];
  category: string;
  cost: number;
  sellingPrice: number;
  recommendation: 'create_new' | 'likely_duplicate';
  /** Set when recommendation is 'likely_duplicate'. */
  possibleDuplicateOfProductId?: AllMallId;
  createdAt: string;
}

/** A manually-locked master field the platform tried to change during sync (Tier 2, D6 sub-decision 2). */
export interface FieldConflict {
  id: AllMallId;
  productId: AllMallId;
  storeId: AllMallId;
  field: 'name' | 'category' | 'cost' | 'description';
  yourValue: string;
  platformValue: string;
  recommendation: 'keep_yours' | 'accept_platform';
  createdAt: string;
}

// ===== Orders (D8: orders smart flow) =====

export type OrderStatus = 'auto_processing' | 'awaiting_shipment' | 'auto_shipped' | 'auto_completed' | 'exception' | 'fraud_blocked' | 'cancelled';

/** Statuses handled end-to-end by automation (cancellations deliberately excluded). */
export const AUTO_FLOW_ORDER_STATUSES: OrderStatus[] = ['auto_processing', 'awaiting_shipment', 'auto_shipped', 'auto_completed'];
export const EXCEPTION_ORDER_STATUSES: OrderStatus[] = ['exception', 'fraud_blocked'];

export type OrderExceptionType = 'address_invalid' | 'fraud_suspected' | 'out_of_stock' | 'payment_failed' | 'buyer_dispute';

/** Priority-based urgency: breached > critical > warning > ok. */
export type OrderSlaTone = 'ok' | 'warning' | 'critical' | 'breached';

export interface OrderTimelineStep {
  title: string;
  at: string; // ISO
  icon: 'check' | 'shield' | 'truck' | 'sync' | 'warning' | 'stop' | 'close';
  /** Only set for automation-produced steps. */
  automated?: boolean;
  estimated?: string;
  /** Operator-entered reason recorded with manual interventions. */
  note?: string;
}

export interface OrderRecommendation {
  action: 'apply_address_fix' | 'reallocate_stock' | 'send_payment_reminder' | 'release' | 'cancel_refund';
  label: string;
  rationale: string;
  /** How confident the system is in its recommendation (0-1). Above 0.7 = strong, recommend accepting. */
  confidence: number;
  /** Whether this recommendation can be batched with other orders of the same type. */
  batchable: boolean;
}

/**
 * Digest of one order sync pass (D8/O1). Orders arrive by store sync exactly like
 * products, so this mirrors `SyncResult` — same status machine, same per-store health —
 * and drives the same "results first, one summary line" card.
 */
export interface OrderSyncResult {
  startedAt: string;
  /** Timestamp of the last *successful* pass; preserved on failure. */
  lastSyncedAt: string | null;
  status: SyncRunStatus;
  /** Orders pulled in by this pass. */
  newOrderCount: number;
  /** Of those, how many automation carried end to end without a human. */
  autoHandledCount: number;
  /** Orders this pass left for a person (exceptions + SLA-critical). */
  pendingDecisionCount: number;
  perStore: StoreSyncHealth[];
  /** Set when status is 'failed'. */
  errorMessage?: string;
}

export interface Order {
  id: AllMallId;
  orderNo: string; // display string, e.g. #ORD-2406-0820
  /** Relationship field; the display name is resolved from the store list. */
  storeId: AllMallId;
  buyerName: string;
  items: string;
  amount: number;
  status: OrderStatus;
  trackingNo?: string;
  logisticsStatus?: string;
  exceptionType?: OrderExceptionType;
  exceptionReason?: string;
  agentAction: string;
  createdAt: string; // ISO
  paidAt?: string; // ISO — when payment was confirmed
  /** Derived from paidAt + platform fulfillment SLA (A1 assumption). */
  shipDeadlineAt?: string; // ISO
  timeline: OrderTimelineStep[];
  /** Recommendation from the mock engine for exceptions; absent for non-exception orders. */
  recommendation?: OrderRecommendation;
}

// ===== Customer Service (V1.0) =====
export type SessionStatus = 'pending_reply' | 'replied' | 'closed';

export interface CustomerSession {
  id: AllMallId;
  storeId: AllMallId;
  buyerName: string;
  buyerAvatar?: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  status: SessionStatus;
  tags: string[];
  platformId: string;
  /**
   * First-response time in seconds (buyer's first message → first reply). Undefined
   * while still unanswered. Drives the CS SLA board's first-response-rate metric.
   */
  firstResponseSeconds?: number;
  /** Who produced the first response — the AI Agent (秒回) or a human seat. */
  handledBy?: 'ai' | 'human';
  /** Whether this pending session needs a human (negotiation, complaint, escalation). */
  needsHuman?: boolean;
}

export interface CustomerMessage {
  id: AllMallId;
  sessionId: AllMallId;
  sender: 'buyer' | 'agent' | 'system';
  content: string;
  createdAt: string;
  isAutoReply: boolean;
}

export interface QuickReplyTemplate {
  id: string;
  text: string;
  category: 'greeting' | 'after_sales' | 'logistics' | 'refund' | 'general';
}

// ===== Review Management (V1.0) =====
export type ReviewRating = 1 | 2 | 3 | 4 | 5;

export interface Review {
  id: AllMallId;
  storeId: AllMallId;
  buyerName: string;
  rating: ReviewRating;
  content: string;
  /** Product name this review is for */
  productName: string;
  /** Images included in the review */
  images: string[];
  createdAt: string;
  /** Whether the merchant has replied */
  replied: boolean;
  /** The merchant's reply, if any */
  reply?: ReviewReply;
  /** AI-detected sentiment: negative reviews flagged */
  sentiment: 'positive' | 'neutral' | 'negative';
}

export interface ReviewReply {
  content: string;
  repliedAt: string;
  /** Whether auto-generated by AI */
  auto: boolean;
}

export interface ReviewTemplate {
  id: string;
  text: string;
  category: 'thanks' | 'explain' | 'apology' | 'invite';
}

// ===== Promotion Campaign (V1.1) =====
export type PromotionType = 'flash_sale' | 'coupon' | 'bundle' | 'full_reduction' | 'seckill';
export type PromotionStatus = 'active' | 'scheduled' | 'ended';

export interface PromotionCampaign {
  id: AllMallId;
  name: string;
  type: PromotionType;
  storeId: AllMallId;
  productIds: AllMallId[];
  discount: number;
  budget: number;
  spent: number;
  revenue: number;
  roi: number;
  status: PromotionStatus;
  startDate: string;
  endDate: string;
  autoCreated: boolean;
  createdAt: string;
}

export interface PromotionStats {
  active: number;
  scheduled: number;
  ended: number;
  totalRevenue: number;
  totalRoi: number;
}

// ===== V1.1 Inventory Upgrade =====
export type InventorySource = 'physical' | 'shared_pool' | 'virtual';
export type InventoryAlertLevel = 'healthy' | 'low' | 'critical';

export interface InventoryItem {
  id: AllMallId;
  productId: AllMallId;
  storeId: AllMallId;
  skuCode: string;
  skuName: string;
  currentStock: number;
  safetyStock: number;
  dailySales: number;
  daysUntilStockout: number;
  alertLevel: InventoryAlertLevel;
  source: InventorySource;
  lastRestockedAt: string;
}

export interface ReplenishSuggestion {
  storeId: AllMallId;
  productName: string;
  skuCode: string;
  currentStock: number;
  safetyStock: number;
  dailySales: number;
  suggestedQuantity: number;
  suggestedDate: string;
  supplier: string;
  leadTimeDays: number;
  priority: 'urgent' | 'normal' | 'planned';
  reason: string;
  /** 本次会话内已下补货单，卡片保留但不再重复下单。 */
  ordered?: boolean;
}

export interface TransferRecommendation {
  fromStoreId: AllMallId;
  toStoreId: AllMallId;
  productName: string;
  skuCode: string;
  quantity: number;
  fromStock: number;
  toStock: number;
  reason: string;
  urgency: 'urgent' | 'normal';
}

export interface SafetyStockConfig {
  storeId: AllMallId;
  productId: AllMallId;
  currentSafetyStock: number;
  suggestedSafetyStock: number;
  recommendation: string;
}

// ===== V1.1 Ad Visualization =====
export type AdCampaignStatus = 'active' | 'paused' | 'ended';
export type AdPlatform = 'douyin' | 'pinduoduo' | 'taobao' | 'jd';

export interface AdCampaign {
  id: AllMallId;
  name: string;
  platform: AdPlatform;
  storeId: AllMallId;
  productIds: AllMallId[];
  budget: number;
  spent: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  conversions: number;
  revenue: number;
  roi: number;
  status: AdCampaignStatus;
  startDate: string;
  endDate: string;
  /** AI auto-optimized */
  autoOptimized: boolean;
}

export interface AdCreative {
  id: AllMallId;
  campaignId: AllMallId;
  type: 'image' | 'video' | 'carousel';
  title: string;
  url: string;
  status: 'approved' | 'pending' | 'rejected';
  performance: { impressions: number; clicks: number; ctr: number; };
}

// ===== V1.3 Livestream =====
export type LiveStatus = 'upcoming' | 'live' | 'ended';

export interface LiveSession {
  id: AllMallId;
  storeId: AllMallId;
  title: string;
  startTime: string;
  endTime: string;
  status: LiveStatus;
  viewers: number;
  peakViewers: number;
  duration: number;
  products: number;
  orders: number;
  revenue: number;
  avgWatchTime: number;
}

export interface LiveScript {
  id: AllMallId;
  sessionId: AllMallId;
  phase: 'opening' | 'product_intro' | 'promo_push' | 'closing';
  title: string;
  content: string;
  duration: number;
  notes: string;
}

export interface ContentMaterial {
  id: AllMallId;
  type: 'image' | 'video' | 'script';
  name: string;
  url: string;
  campaignId?: AllMallId;
  tags: string[];
  uploadedAt: string;
}

// ===== V1.4 Finance & Billing =====
