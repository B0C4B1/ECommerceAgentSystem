import dayjs from 'dayjs';
import type { Member } from '../../types/domain';

// ===== 异常类型 =====
export type ExceptionType = 'review_negative' | 'chat_escalation' | 'ad_low_roi' | 'logistics_stuck' | 'compliance_flag' | 'cycle_escalation' | 'cross_store_escalation' | 'goal_pace_escalation' | 'goal_settlement' | 'decision_request' | 'guard_health' | 'guard_health_account';

/**
 * P30.1：Agent 主动请求决策。
 * 与普通异常的区别是——Agent 已经把可选结论、默认建议和超时口径算好，
 * 人只需在有限选项里选一个，而不是自由填写处理意见。
 */
export type EscalationDecisionOptionId = 'uphold' | 'override' | 'adjust_guard';

/**
 * P30.2：决策请求超时后 Agent 的动作，按店铺配置。
 * 每一项都不扩大权限——提醒不替人下结论，暂停只收窄执行，上报只换人。
 */
export type EscalationTimeoutAction = 'remind' | 'degrade' | 'pause_agent' | 'escalate_owner';

export interface StoreEscalationPolicy {
  storeId: number;
  timeoutHours: number;
  action: EscalationTimeoutAction;
  updatedAt?: string;
  updatedBy?: string;
}

export interface EscalationDecisionOption {
  id: EscalationDecisionOptionId;
  label: string;
  /** 选它会怎样：写清影响范围和不可逆部分，供人在点下之前判断。 */
  consequence: string;
  recommended?: boolean;
}

export interface EscalationDecision {
  question: string;
  options: EscalationDecisionOption[];
  timeoutHours: number;
  /** 建议决策截止时间（ISO）。 */
  deadline: string;
  /** 超时后 Agent 采用的选项，必须是 options 之一，且必须是最保守的那个。 */
  timeoutOptionId: EscalationDecisionOptionId;
}

/**
 * P30.3：可沉淀为规则的决策类型，与经营周期的护栏拦截类型一一对应。
 * 只有护栏拦截才有稳定的「同类」口径；依赖门控等一次性冲突不做规则化。
 */
export type EscalationDecisionKind = 'budget' | 'margin' | 'discount_cap';

export type EscalationDecisionOutcome = 'uphold' | 'override';

/**
 * P30.3：人把「每次同类升级都这样选」固化成规则，之后同类升级由 Agent 直接收尾。
 * 规则只按店铺 + 决策类型匹配，不跨店生效；创建、自动执行、撤销都留痕。
 */
export interface EscalationDecisionRule {
  id: string;
  storeId: number;
  decisionKind: EscalationDecisionKind;
  outcome: EscalationDecisionOutcome;
  /** 规则依据：促成它的人工决策条目 id，供人回看为什么会有这条规则。 */
  sourceDecisionIds: string[];
  createdAt: string;
  createdBy: string;
  appliedCount: number;
  lastAppliedAt?: string;
}

/**
 * P30.4：升级项的可量化影响，用来替人排出「今天先处理哪条」。
 * 只记录能从既有数据推出的金额（预计 GMV / 目标缺口 / 预计成本）；
 * 推不出来的条目保持空值，界面显示「未量化」，不编造数字。
 */
export type EscalationImpactKind = 'gmv' | 'goal_gap' | 'cost';

export interface EscalationImpact {
  amount: number;
  kind: EscalationImpactKind;
  /** 金额来源，一行可核对（例如“被拦动作的预计 GMV 贡献”）。 */
  basis: string;
}

export type ExceptionStatus = 'pending' | 'resolved' | 'ignored' | 'all';

export interface ExceptionItem {
  id: string;
  type: ExceptionType;
  title: string;
  storeName: string;
  /** S3 重试：经营周期产生的升级项带上店铺 id，才能回到对应店铺重新生成方案。 */
  storeId?: number;
  agentType: string;
  level: 'critical' | 'warning' | 'info';
  summary: string;
  detail: string;
  suggestedAction: string;
  /** P30.1：结构化的决策请求；有值时收件箱直接给出选项，不再只给一段建议文字。 */
  decision?: EscalationDecision;
  /** 决策对应的经营周期冲突，用于把选择落回提案状态而不是只关掉待办。 */
  conflictRef?: { storeId: number; conflictId: number };
  createdAt: string;
  resolved: boolean;
  ignored: boolean;
  assignee?: string;
  linkTo?: string; // 深链接到专业处理页面
  // WS-B (B6): appended — actor/timestamp/note for resolve & ignore semantics
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  ignoredBy?: string;
  ignoredAt?: string;
  ignoreNote?: string;
  // P30.2：超时策略在条目上留下的可核对痕迹（累计提醒次数 / 上报时间 / 暂停时间）。
  reminderCount?: number;
  lastRemindedAt?: string;
  escalatedToOwnerAt?: string;
  agentPausedAt?: string;
  // P30.3：决策类型与人工结论，用来识别「同类反复出现」并沉淀规则。
  decisionKind?: EscalationDecisionKind;
  decisionOutcome?: EscalationDecisionOutcome;
  /** 本条由哪条决策规则自动收尾（Agent 执行痕迹）。 */
  decisionRuleId?: string;
  /** P30.4：可核对的金额影响；无值表示现有数据推不出金额，排序时排在已量化之后。 */
  impact?: EscalationImpact;
  // P30.5：Agent 按影响金额 / 级别 / 决策口径把升级项直接路由到有职责的成员，
  // 人不需要逐条决定「这条该谁看」。指派结果与依据都落在条目上，可改派、可回看。
  /** 路由目标角色，决定「我负责的」队列是否命中（同名成员换人后仍按角色归位）。 */
  assigneeRole?: Member['role'];
  assignedBy?: string;
  assignedAt?: string;
  /** 路由依据，一行可核对（例如“可核对影响 ¥6,000 超过运营处理上限”）。 */
  assignmentReason?: string;
  /**
   * P38.1：账户级护栏升级覆盖的护栏与店铺。
   * 同一条护栏在多家店都等人表态时合并成一条待办；人点一次后按这份名单逐店落库，
   * 名单本身随巡检更新，条件消失的店铺会被移出。
   */
  guardAccount?: { key: string; storeIds: number[] };
}

// ===== Agent 操作日志 =====
export interface AgentLogEntry {
  id: string;
  agentType: string;
  action: string;
  target: string;
  result: 'success' | 'auto_resolved' | 'escalated' | 'blocked' | 'failed';
  summary: string;
  at: string;
}

// WS-B (B6): timestamps anchored to the real clock so urgency ordering stays live.
const now = dayjs();
const at = (hoursAgo: number) => now.subtract(hoursAgo, 'hour').format('YYYY-MM-DD HH:mm');

export const exceptionItems: ExceptionItem[] = [
  {
    id: 'ex_002', type: 'review_negative', title: '恶意差评检测',
    storeName: '淘宝户外用品店', agentType: 'review_manager',
    level: 'critical', summary: '折叠露营椅收到 1 星差评，AI 判定疑似同行攻击 (置信度 87%)。',
    detail: '评论内容: "质量极差，跟图片完全不符，千万别买"\n买家历史: 新账号、无购买历史、3 天内 5 条差评\nAI 判定: 同行恶意差评',
    suggestedAction: '提交平台申诉，附 AI 分析报告',
    createdAt: at(2), resolved: false, ignored: false,
    linkTo: '/agents/review_manager',
  },
  {
    id: 'ex_003', type: 'chat_escalation', title: '退款争议升级',
    storeName: '京东自营店', agentType: 'customer_service',
    level: 'critical', summary: '买家投诉未收到商品，要求全额退款并威胁信用卡拒付。',
    detail: '运单号: 1Z999AA1234567890\n物流状态: 显示已签收但买家否认\n买家情绪: 愤怒，威胁发起 chargeback',
    suggestedAction: '提供签收证明截图，安抚买家情绪，必要时部分退款',
    createdAt: at(1), resolved: false, ignored: false,
    linkTo: '/agents/customer_service',
  },
  {
    id: 'ex_004', type: 'ad_low_roi', title: '广告计划 ROI 跌破红线',
    storeName: '拼多多旗舰店', agentType: 'ads_optimizer',
    level: 'warning', summary: '广告计划 C-102 连续 3 天 ROI < 1.5，AI 已自动降低出价 15%，暂停计划待审批。',
    detail: '计划: C-102 蓝牙耳机促销\n7 天花费: ¥612，GMV: ¥869，ROI: 1.42\n红线: 1.5\n已做: 自动降低出价 15%\n待审批: 暂停计划并转移预算',
    suggestedAction: '前往待办中心审批「暂停低 ROI 广告计划」',
    // P30.4：金额取自条目里已有的 7 天花费，不另造数；继续投放的预计花费就是这条的敞口。
    impact: { amount: 612, kind: 'cost', basis: '近 7 天计划花费 ¥612，ROI 1.42 低于红线 1.5' },
    createdAt: at(4), resolved: false, ignored: false,
    linkTo: '/agents/ads_optimizer',
  },
  {
    id: 'ex_006', type: 'logistics_stuck', title: '物流包裹滞留',
    storeName: '拼多多旗舰店', agentType: 'after_sales',
    level: 'warning', summary: '退货包裹 #RT-2406-0047 在中通转运中心滞留 5 天未更新。',
    detail: '退货单号: RT-2406-0047\n物流商: 中通快递\n最后更新: ' + now.subtract(5, 'day').format('YYYY-MM-DD') + ' 杭州转运中心\n状态: 运输中（5 天无更新）',
    suggestedAction: '联系中通快递查询包裹状态，或发起丢失索赔',
    createdAt: at(6), resolved: false, ignored: false,
    linkTo: '/agents/after_sales',
  },
  {
    id: 'ex_007', type: 'compliance_flag', title: '合规风险标记',
    storeName: '拼多多旗舰店', agentType: 'risk_control',
    level: 'warning', summary: '蓝牙耳机商品描述含"最强降噪"，被标记为可能违反广告法。',
    detail: '商品: SKU BT-E01 蓝牙耳机 Pro\n问题: 描述含绝对化用语 "最强"\n法规: 广告法第 9 条禁止 "最" 字类绝对化用语',
    suggestedAction: '修改描述为 "高效降噪" 或 "顶级降噪体验"',
    createdAt: at(8), resolved: true, ignored: false,
    // WS-B (B6): resolved items carry actor + timestamp + note
    resolvedBy: '运营负责人', resolvedAt: at(5), resolutionNote: '描述已改为"高效降噪"，重新提交审核通过。',
    linkTo: '/agents/risk_control',
  },
  {
    // P41.1：一条由超时策略收回的决策样例。它存在的意义是让「自动处理」页签
    // 有一条可核对的 Agent 收尾记录——处理人、时间、结论与审计轨迹（mockData 6013）一致。
    // 真实链路同样会走 applyExpiredDecisionDefaults，这里只是把「昨天已经发生过」的初始状态摆出来。
    id: 'ex_008', type: 'decision_request', title: '折扣上限冲突（已超时收尾）',
    storeName: '拼多多旗舰店', storeId: 1002, agentType: 'pricing_strategy',
    level: 'warning', summary: '双十一全场 25% 折扣与店铺折扣上限 20% 冲突，24 小时内无人处理。',
    detail: '活动: 双十一全场促销\n冲突: 折扣 25% 超过店铺上限 20%\n被拦动作: 促销方案提交\n超时口径: 维持现有护栏，不放行超限折扣',
    suggestedAction: '维持 20% 折扣上限；若确需提额，请先调整店铺护栏再重提方案。',
    decision: {
      question: '是否放行本次活动 25% 全场折扣？',
      options: [
        { id: 'uphold', label: '维持 20% 折扣上限', consequence: '活动按 20% 执行，毛利不变，让出 GMV 比原方案少。', recommended: true },
        { id: 'override', label: '放行 25% 折扣', consequence: '超出上限 5 个点，本场毛利下降，且不再受折扣护栏保护。' },
      ],
      timeoutHours: 24,
      deadline: at(6),
      timeoutOptionId: 'uphold',
    },
    decisionKind: 'discount_cap', decisionOutcome: 'uphold',
    createdAt: at(30), resolved: true, ignored: false,
    resolvedBy: 'Agent（超时策略）', resolvedAt: at(6),
    resolutionNote: '超时默认：维持现有护栏（折扣上限 20%），未放行 25% 折扣。',
    linkTo: '/agents/pricing_strategy',
  },
];

export const agentLogData: AgentLogEntry[] = [
  { id: 'log_001', agentType: 'ads_optimizer', action: '降低广告出价', target: 'C-102 蓝牙耳机促销', result: 'success', summary: 'ROI 连续 3 天低于 1.5 红线，自动降低出价 15%；暂停计划仍需审批', at: '08:00' },
  { id: 'log_002', agentType: 'pricing_strategy', action: '动态调价', target: 'SKU BT-E01 蓝牙耳机 Pro', result: 'success', summary: '竞品平均降价 8%，自动调低售价 ¥39.99 → ¥36.99', at: '07:30' },
  { id: 'log_003', agentType: 'crm_retention', action: '发放优惠券', target: '沉默客户群 (3 个月未购)', result: 'success', summary: '发放 15% OFF 优惠券共 167 张，预算 ¥250', at: '07:00' },
  { id: 'log_004', agentType: 'review_manager', action: '自动回复好评', target: '露营椅 5 星好评 ×3', result: 'success', summary: '自动感谢回复 3 条 4-5 星好评', at: '06:45' },
  { id: 'log_005', agentType: 'inventory_alert', action: '低库存预警', target: 'SKU CK-C01 65W GaN 充电器', result: 'escalated', summary: '库存仅剩 35 件，低于安全阈值 50，建议补货 200 件', at: '06:30' },
  { id: 'log_006', agentType: 'customer_service', action: '智能应答', target: '买家咨询退换货政策', result: 'success', summary: '自动回复退换货政策，买家表示满意', at: '06:15' },
  { id: 'log_007', agentType: 'after_sales', action: '自动退款', target: '退货单 RT-2406-0042', result: 'success', summary: '退货签收确认，自动退款 ¥19.99 已发起', at: '06:00' },
  { id: 'log_008', agentType: 'finance_audit', action: '账单比对', target: '拼多多 6 月账单', result: 'success', summary: '平台账单与内部记录差异 ¥0.00，完全匹配', at: '05:30' },
  { id: 'log_009', agentType: 'creative_factory', action: '生成广告素材', target: '蓝牙耳机 16:9 横版视频', result: 'success', summary: '生成 3 个版式素材（1:1/16:9/9:16），待广告 Agent 调用', at: '05:00' },
  { id: 'log_010', agentType: 'risk_control', action: '阻断操作', target: '拼多多 蓝牙耳机描述', result: 'escalated', summary: '检测到 "最强" 绝对化用语，已阻断发布并通知运营修改', at: '04:45' },
  { id: 'log_011', agentType: 'competitor_intel', action: '竞品监控完成', target: '消费电子类目 5 个竞品', result: 'success', summary: '发现 2 个竞品降价 5-10%，数据已写入缓存', at: '04:30' },
  { id: 'log_012', agentType: 'login_bootstrap', action: '店铺会话保活', target: '全部 3 个店铺', result: 'success', summary: '拼多多/淘宝/京东 登录会话均正常', at: '04:00' },
];

// ===== 所有可能的 Agent 类型（用于筛选） =====
export const ALL_AGENT_TYPES = ['review_manager', 'customer_service', 'ads_optimizer', 'after_sales', 'risk_control'];


export const LEVEL_COLORS: Record<string, string> = { critical: 'red', warning: 'orange', info: 'blue' };
