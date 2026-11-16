import { mockDelay } from './client';
import { exceptionItems } from '../pages/operations/exceptionCenterMockData';
import type {
  EscalationDecisionKind,
  EscalationDecisionOutcome,
  EscalationDecisionRule,
  EscalationTimeoutAction,
  ExceptionItem,
  StoreEscalationPolicy,
} from '../pages/operations/exceptionCenterMockData';
import { batchUpdate, replaceItem } from './mockRepository';
import { recordAuditLog } from './auditLogger';
import { registerMockState } from './mockPersistence';
import { members as seedMembers, stores } from './mockData';
import type { Member } from '../types/domain';

// WS-B (B6): the ExceptionItem shape lives in exceptionCenterMockData.ts;
// re-export it so API consumers keep a single source of truth.
export type { ExceptionItem, EscalationTimeoutAction, StoreEscalationPolicy };

const CURRENT_ACTOR = '当前用户';
/** P30.2：超时策略的执行者不是人，审计里必须能区分。 */
const AGENT_POLICY_ACTOR = 'Agent（超时策略）';
/** P30.3：Agent 自己的收尾不算「人反复这样选」，否则规则会自我强化。 */
const AGENT_DECIDERS = ['Agent（超时默认）', 'Agent（决策规则）'];

/**
 * P31.1：复盘里的改判率只统计人做的决策。Agent 超时默认 / 规则收尾不算，
 * 否则保守的自动选项会稀释「人是否采纳 Agent 建议」这一信号。
 */
export function isAgentDecisionActor(actor?: string): boolean {
  return AGENT_DECIDERS.includes(actor ?? '');
}
/** P30.5：路由的执行者同样不是人，审计里要能和人手改派区分开。 */
const AGENT_ROUTER_ACTOR = 'Agent（路由规则）';
/** P30.5：超过这条可核对金额的升级项不留在运营手里，直接路由到 Owner。 */
export const ROUTE_OWNER_AMOUNT_THRESHOLD = 5000;
const DEFAULT_TIMEOUT_HOURS = 24;

const escalationPolicies = new Map<number, StoreEscalationPolicy>();
/** P30.3：人工沉淀的「以后都这样」规则，同一店铺同一决策类型只保留一条。 */
const decisionRules: EscalationDecisionRule[] = [];
/**
 * P30.6：人工接管。人显式接过本店执行权后，Agent 只保留诊断与提案，不再自动提交；
 * 接管是人的主动动作，与服务端超时触发的「暂停 Agent」分开记录，便于审计区分。
 */
export interface StoreTakeover {
  storeId: number;
  reason: string;
  actor: string;
  startedAt: string;
}

const storeTakeovers = new Map<number, StoreTakeover>();

/**
 * P30.5：指派通知（站内信）。
 * 只记录「Agent 或人把哪条升级交给了谁、为什么、有没有读过」，不引入外部推送渠道：
 * 飞书 / 钉钉 / Webhook 通道的连通状态在通知设置页，但本地没有真实发送端点，
 * 因此这里只做可核对的站内通知，避免出现「显示已发送、实际没发」的假链路。
 */
export interface EscalationNotice {
  id: string;
  escalationId: string;
  title: string;
  storeName: string;
  reason: string;
  recipientName: string;
  recipientRole: Member['role'];
  assignedBy: string;
  createdAt: string;
  readAt?: string;
  /** 被改派后旧通知作废：原负责人不该继续收到已不属于他的提醒。 */
  supersededAt?: string;
}

const escalationNotices: EscalationNotice[] = [];
let noticeSeq = 0;

/** 同一条升级只保留一条未读通知；改派时旧负责人的通知作废。 */
function notifyAssignee(item: ExceptionItem, member: Member, reason: string, actor: string): void {
  const at = nowIso();
  escalationNotices.forEach((notice) => {
    if (notice.escalationId === item.id && notice.recipientName !== member.name && !notice.supersededAt) {
      notice.supersededAt = at;
    }
  });
  const pending = escalationNotices.find(
    (notice) => notice.escalationId === item.id && notice.recipientName === member.name && !notice.readAt && !notice.supersededAt,
  );
  if (pending) {
    pending.reason = reason;
    pending.createdAt = at;
    return;
  }
  noticeSeq += 1;
  escalationNotices.unshift({
    id: `notice_${item.id}_${noticeSeq}`,
    escalationId: item.id,
    title: item.title,
    storeName: item.storeName,
    reason,
    recipientName: member.name,
    recipientRole: member.role,
    assignedBy: actor,
    createdAt: at,
  });
  // 通知只用于「最近谁被指到什么」，保留最近 50 条足够回看，不无限增长。
  if (escalationNotices.length > 50) escalationNotices.length = 50;
}

/** 升级被解决 / 忽略后，相关通知不再需要人处理，直接标记已读避免残留未读。 */
function closeNotices(escalationId: string): void {
  const at = nowIso();
  escalationNotices.forEach((notice) => {
    if (notice.escalationId === escalationId && !notice.readAt) notice.readAt = at;
  });
}

/** 未配置时沿用 P30.1 的保守默认：24 小时 → 维持护栏。 */
export function getEscalationPolicy(storeId: number): StoreEscalationPolicy {
  return (
    escalationPolicies.get(storeId) ?? {
      storeId,
      timeoutHours: DEFAULT_TIMEOUT_HOURS,
      action: 'degrade',
    }
  );
}

function openItemsOf(storeId: number, agentType?: string): ExceptionItem[] {
  return exceptionItems.filter(
    (item) =>
      item.storeId === storeId &&
      !item.resolved &&
      !item.ignored &&
      (!agentType || item.agentType === agentType),
  );
}

/** P30.2：暂停只收窄该店铺该 Agent 的自动执行，不影响其他店铺与其他 Agent。 */
export function isAgentPaused(storeId: number, agentType: string): boolean {
  return openItemsOf(storeId, agentType).some((item) => Boolean(item.agentPausedAt));
}

export function listPausedAgents(storeId: number): { agentType: string; pausedAt: string }[] {
  const seen = new Map<string, string>();
  openItemsOf(storeId).forEach((item) => {
    if (item.agentPausedAt && !seen.has(item.agentType)) {
      seen.set(item.agentType, item.agentPausedAt);
    }
  });
  return [...seen.entries()].map(([agentType, pausedAt]) => ({ agentType, pausedAt }));
}

/** 人重新接手（解决/忽略该决策）即解除暂停：冻结的目的是等人，不是永久停摆。 */
function releasePauseForItem(id: string): void {
  const item = exceptionItems.find((entry) => entry.id === id);
  if (!item?.agentPausedAt || !item.storeId) return;
  openItemsOf(item.storeId, item.agentType).forEach((entry) => {
    entry.agentPausedAt = undefined;
  });
}

function releasePausedAgent(storeId: number, agentType: string): void {
  openItemsOf(storeId, agentType).forEach((item) => {
    item.agentPausedAt = undefined;
  });
}


function logExceptionAction(id: string, action: string, detail: string, actor = CURRENT_ACTOR): void {
  recordAuditLog({
    actor,
    action,
    entity: '异常',
    entityId: id as unknown as number,
    summary: `${detail} - ${id}`,
    category: 'exception',
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function logDecisionRuleAction(id: string, action: string, detail: string, actor = CURRENT_ACTOR): void {
  recordAuditLog({
    actor,
    action,
    entity: '决策规则',
    entityId: id,
    summary: `${detail} - ${id}`,
    category: 'exception',
  });
}

/**
 * P30.3：识别「同类升级反复出现」——只看已给出结论的条目，
 * 从最近一次结论往回数连续同结论的次数。护栏是店铺级的，跨店不合并。
 */
export function getDecisionHistory(
  storeId: number,
  kind: EscalationDecisionKind,
): { streak: number; outcome?: EscalationDecisionOutcome; sourceIds: string[] } {
  const decided = exceptionItems
    .filter(
      (item) =>
        item.storeId === storeId &&
        item.decisionKind === kind &&
        Boolean(item.decisionOutcome) &&
        (item.resolved || item.ignored) &&
        !isAgentDecisionActor(item.resolvedBy),
    )
    .sort((a, b) =>
      (b.resolvedAt ?? b.ignoredAt ?? '').localeCompare(a.resolvedAt ?? a.ignoredAt ?? ''),
    );
  const latest = decided[0]?.decisionOutcome;
  const streakItems: ExceptionItem[] = [];
  for (const item of decided) {
    if (item.decisionOutcome !== latest) break;
    streakItems.push(item);
  }
  return { streak: streakItems.length, outcome: latest, sourceIds: streakItems.map((item) => item.id) };
}

export function findDecisionRule(
  storeId: number,
  kind: EscalationDecisionKind,
): EscalationDecisionRule | undefined {
  return decisionRules.find((rule) => rule.storeId === storeId && rule.decisionKind === kind);
}

/**
 * P30.4 优先排序口径：先看可核对的影响金额（预计 GMV / 目标缺口 / 预计成本），
 * 金额相同再看风险级别，最后才看新旧；金额推不出来的条目排在所有已量化条目之后。
 * 排序只读 impact 字段，不在界面层二次估算，避免出现两套金额。
 */
const LEVEL_RANK: Record<ExceptionItem['level'], number> = { critical: 0, warning: 1, info: 2 };

export function compareEscalationPriority(a: ExceptionItem, b: ExceptionItem): number {
  const amountA = a.impact?.amount;
  const amountB = b.impact?.amount;
  if (amountA !== undefined || amountB !== undefined) {
    if (amountA === undefined) return 1;
    if (amountB === undefined) return -1;
    if (amountA !== amountB) return amountB - amountA;
  }
  if (a.level !== b.level) return LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** 今日可量化影响的合计与条数，用于告诉人「Top N 覆盖了多少风险敞口」。 */
export function summarizeImpact(items: ExceptionItem[]): { quantified: number; total: number } {
  return items.reduce(
    (acc, item) => {
      if (item.impact) {
        acc.quantified += 1;
        acc.total += item.impact.amount;
      }
      return acc;
    },
    { quantified: 0, total: 0 },
  );
}

/**
 * P30.5 路由口径：只决定「谁先看」，不改结论、不改级别。
 * 1. 已上报 Owner、关键级别、或可核对金额超过 ¥5,000 → Owner（超出运营处理权限）；
 * 2. 带决策请求 / 护栏决策类型 → Approver（需要审批口径复核）；
 * 3. 其余店铺日常异常 → Admin（一线运营跟进）。
 * 排序上金额优先于级别：金额是这条升级最容易被核对的后果。
 */
export type EscalationRouteRole = Extract<Member['role'], 'Owner' | 'Admin' | 'Approver'>;

export interface EscalationRoute {
  role: EscalationRouteRole;
  /** 当前在册成员；找不到对应角色时为空，此时只给建议、不自动指派。 */
  member?: Member;
  reason: string;
  /** P30.5：命中的店铺，以及是否由该店负责人承接（false 表示按角色兜底）。 */
  storeName?: string;
  storeMatched?: boolean;
}

/**
 * P30.5 店铺维度：同一角色有多人时，优先找该店负责人；没有归属数据才退回按角色第一个在册成员。
 * 在册（active）优先于待接受邀请（invited），避免把升级推给还没进系统的人。
 */
function pickRouteMember(role: EscalationRouteRole, storeId?: number): { member?: Member; storeMatched: boolean } {
  const candidates = seedMembers.filter((member) => member.role === role);
  const active = candidates.filter((member) => member.status === 'active');
  const pool = active.length > 0 ? active : candidates;
  if (storeId !== undefined) {
    const responsible = pool.find((member) => member.storeIds?.includes(storeId));
    if (responsible) return { member: responsible, storeMatched: true };
  }
  return { member: pool[0], storeMatched: false };
}

/** 升级项历史数据只有店铺名，按店名反查 id，避免为了路由再造一份店铺字段。 */
function resolveStoreId(item: ExceptionItem): number | undefined {
  if (item.storeId !== undefined) return item.storeId;
  return stores.find((store) => store.name === item.storeName)?.id;
}

export function routeEscalation(item: ExceptionItem): EscalationRoute {
  const amount = item.impact?.amount;
  const isGuardrailDecision = Boolean(
    item.decision || item.decisionKind || item.type === 'decision_request' || item.type === 'goal_pace_escalation',
  );
  let role: EscalationRouteRole;
  let reason: string;
  if (item.escalatedToOwnerAt) {
    role = 'Owner';
    reason = 'Agent 已上报 Owner，需 Owner 接手后才能继续';
  } else if (amount !== undefined && amount >= ROUTE_OWNER_AMOUNT_THRESHOLD) {
    role = 'Owner';
    reason = `可核对影响 ¥${amount.toLocaleString()} 超过 ¥${ROUTE_OWNER_AMOUNT_THRESHOLD.toLocaleString()} 运营处理上限`;
  } else if (item.type === 'account_goal_settlement') {
    // P49：账户承诺的沿用 / 下调属于「设目标」，落到 Owner，不交给运营负责人。
    role = 'Owner';
    reason = '账户承诺是否沿用上期数值或下调，只有设目标的人能定';
  } else if (item.level === 'critical') {
    role = 'Owner';
    reason = '关键级别问题，需要 Owner 知情后再处理';
  } else if (item.type === 'guard_health' || item.type === 'guard_health_account') {
    role = 'Owner';
    reason = '护栏是否仍符合你的意图，只能由划护栏的人确认';
  } else if (item.type === 'goal_settlement') {
    role = 'Owner';
    reason = '下期目标是否沿用上期数值，只有设目标的人能决定';
  } else if (isGuardrailDecision) {
    role = 'Approver';
    reason = '落在预算 / 毛利 / 折扣护栏口径，需要审批人复核';
  } else {
    role = 'Admin';
    reason = '店铺日常异常，由运营负责人跟进';
  }
  const storeId = resolveStoreId(item);
  const storeName = stores.find((store) => store.id === storeId)?.name;
  const { member, storeMatched } = pickRouteMember(role, storeId);
  const storeNote = storeName
    ? storeMatched
      ? `（${storeName}负责人）`
      : `（${storeName}未指定负责人，按角色兜底）`
    : '';
  return {
    role,
    member,
    reason: `${reason}${storeNote}`,
    storeName,
    storeMatched,
  };
}

/**
 * P30.5：把尚未指派的进行中升级项路由出去。幂等——已有负责人（人或 Agent 指派）就不再动，
 * 因此每次读取都跑一遍等同于 Agent 在后台补位，不会覆盖人的改派。
 */
export function routePendingEscalations(): number {
  const pending = exceptionItems.filter((item) => !item.resolved && !item.ignored && !item.assignee);
  let routed = 0;
  pending.forEach((item) => {
    const route = routeEscalation(item);
    if (!route.member) return;
    const at = nowIso();
    replaceItem(exceptionItems, (entry) => entry.id === item.id, (entry) => ({
      ...entry,
      assignee: route.member!.name,
      assigneeRole: route.role,
      assignedBy: AGENT_ROUTER_ACTOR,
      assignedAt: at,
      assignmentReason: route.reason,
    }));
    notifyAssignee(item, route.member, route.reason, AGENT_ROUTER_ACTOR);
    routed += 1;
  });
  if (routed > 0) {
    recordAuditLog({
      actor: AGENT_ROUTER_ACTOR,
      action: '路由升级项',
      entity: '异常',
      entityId: 0,
      summary: `按金额 / 级别 / 决策口径路由 ${routed} 个升级项到对应角色`,
      category: 'exception',
    });
  }
  return routed;
}

/**
 * P42：升级项的店铺归属必须与店铺主数据一致，否则这条数据会在四处说谎：
 * 1. 种子只写 storeName、没写 storeId（ex_002/003/004/006）→ 收件箱把单店问题标成「账户级」，
 *    切到任何店铺范围都还在，而超时策略、按店路由又拿不到它（applyExpiredDecisionDefaults 直接跳过）；
 * 2. storeId 与 storeName 对不上（ex_008：storeName 拼多多、storeId 1002 淘宝）→
 *    条目挂在 A 店的范围下，却写着 B 店的名字。
 * 口径：storeId 是数据归属，storeName 只是展示。有 id 时用 id 纠正名字；
 * 没 id 时只有店名唯一命中才补 id；两者都对不上就保持账户级，不猜。
 */
function normalizeExceptionStoreAttribution(): void {
  for (const item of exceptionItems) {
    if (item.storeId !== undefined) {
      const matched = stores.find((store) => store.id === item.storeId);
      // id 指向未知店铺时不动，交给后续人工核对，避免把归属改到别家。
      if (matched && item.storeName !== matched.name) item.storeName = matched.name;
      continue;
    }
    const byName = stores.filter((store) => store.name === item.storeName);
    if (byName.length === 1) item.storeId = byName[0].id;
  }
}

export const exceptionsApi = {
  // P30.5：读取前先让 Agent 把新出现的未指派升级项路由出去（幂等，不覆盖人的改派）。
  // P42：先补齐店铺归属，再路由——否则缺 id 的单店条目会被当成账户级、路由与范围筛选都失效。
  list: (): Promise<ExceptionItem[]> => {
    normalizeExceptionStoreAttribution();
    routePendingEscalations();
    return mockDelay([...exceptionItems]);
  },

  // WS-B (B6): resolve/ignore capture an optional note plus actor + timestamp.
  // P30.1: actor 可由调用方覆盖——超时默认是 Agent 收尾，不能记成“当前用户”做的。
  // P30.3: 传入结论与规则 id，才能据此统计「同类反复出现」并标明由哪条规则自动收尾。
  resolve: (
    id: string,
    note?: string,
    actor?: string,
    extra?: { outcome?: EscalationDecisionOutcome; ruleId?: string },
  ) => {
    releasePauseForItem(id);
    closeNotices(id);
    replaceItem(exceptionItems, (item) => item.id === id, (item) => ({
      ...item,
      resolved: true,
      ignored: false,
      resolvedBy: actor ?? CURRENT_ACTOR,
      resolvedAt: nowIso(),
      resolutionNote: note,
      ...(extra?.outcome ? { decisionOutcome: extra.outcome } : {}),
      ...(extra?.ruleId ? { decisionRuleId: extra.ruleId } : {}),
    }));
    logExceptionAction(id, '解决异常', `异常已解决${note ? `（备注：${note}）` : ''}`, actor);
    return mockDelay(undefined);
  },

  ignore: (id: string, note?: string) => {
    releasePauseForItem(id);
    closeNotices(id);
    replaceItem(exceptionItems, (item) => item.id === id, (item) => ({
      ...item,
      ignored: true,
      ignoredBy: CURRENT_ACTOR,
      ignoredAt: nowIso(),
      ignoreNote: note,
    }));
    logExceptionAction(id, '忽略异常', `异常已忽略${note ? `（备注：${note}）` : ''}`);
    return mockDelay(undefined);
  },

  unignore: (id: string) => {
    replaceItem(exceptionItems, (item) => item.id === id, (item) => ({
      ...item,
      ignored: false,
      ignoredBy: undefined,
      ignoredAt: undefined,
      ignoreNote: undefined,
    }));
    logExceptionAction(id, '取消忽略', `取消忽略异常`);
    return mockDelay(undefined);
  },

  /** P30.5：人工改派覆盖 Agent 路由，角色按成员在册信息重算，并留下改派依据。 */
  assign: (id: string, assignee: string, actor?: string) => {
    const member = seedMembers.find((entry) => entry.name === assignee);
    const item = exceptionItems.find((entry) => entry.id === id);
    replaceItem(exceptionItems, (entry) => entry.id === id, (entry) => ({
      ...entry,
      assignee,
      assigneeRole: member?.role,
      assignedBy: actor ?? CURRENT_ACTOR,
      assignedAt: nowIso(),
      assignmentReason: '人工改派',
    }));
    if (item && member) notifyAssignee(item, member, '人工改派', actor ?? CURRENT_ACTOR);
    logExceptionAction(id, '分配异常', `分配给 ${assignee}`, actor ?? CURRENT_ACTOR);
    return mockDelay(undefined);
  },

  /** P30.5：当前可见的指派通知（作废的不再下发）；订阅人按成员名或角色匹配。 */
  listNotices: (): Promise<EscalationNotice[]> => {
    // 铃铛是 Agent 推送的入口：先补路由再取通知，未指派的新升级不会等到人打开收件箱才出现。
    routePendingEscalations();
    return mockDelay(escalationNotices.filter((notice) => !notice.supersededAt).map((notice) => ({ ...notice })));
  },

  markNoticesRead: (ids: string[]): Promise<void> => {
    const at = nowIso();
    escalationNotices.forEach((notice) => {
      if (ids.includes(notice.id) && !notice.readAt) notice.readAt = at;
    });
    return mockDelay(undefined);
  },

  markAllNoticesRead: (recipient: { name?: string; role?: string }): Promise<void> => {
    const at = nowIso();
    escalationNotices.forEach((notice) => {
      if (notice.readAt || notice.supersededAt) return;
      if (notice.recipientName === recipient.name || notice.recipientRole === recipient.role) notice.readAt = at;
    });
    return mockDelay(undefined);
  },

  batchResolve: (ids: string[]) => {
    batchUpdate(exceptionItems, (item) => ids.includes(item.id), (item) => ({
      ...item,
      resolved: true,
      ignored: false,
      resolvedBy: CURRENT_ACTOR,
      resolvedAt: nowIso(),
    }));
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '批量解决',
      entity: '异常',
      entityId: 0,
      summary: `批量解决 ${ids.length} 个异常: ${ids.join(', ')}`,
      category: 'exception',
    });
    return mockDelay(undefined);
  },

  batchIgnore: (ids: string[]) => {
    batchUpdate(exceptionItems, (item) => ids.includes(item.id), (item) => ({
      ...item,
      ignored: true,
      ignoredBy: CURRENT_ACTOR,
      ignoredAt: nowIso(),
    }));
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '批量忽略',
      entity: '异常',
      entityId: 0,
      summary: `批量忽略 ${ids.length} 个异常: ${ids.join(', ')}`,
      category: 'exception',
    });
    return mockDelay(undefined);
  },

  /**
   * P30.2 超时策略：按店铺配置「多少小时未处理 → 做什么」。
   * 保存后同时重算该店未结决策的截止时间，避免页面显示的口径与实际扫描不一致。
   */
  getEscalationPolicy,

  isAgentPaused,

  listPausedAgents,

  saveEscalationPolicy: (storeId: number, timeoutHours: number, action: EscalationTimeoutAction) => {
    const hours = Math.min(168, Math.max(1, Math.round(timeoutHours)));
    const policy: StoreEscalationPolicy = {
      storeId,
      timeoutHours: hours,
      action,
      updatedAt: nowIso(),
      updatedBy: CURRENT_ACTOR,
    };
    escalationPolicies.set(storeId, policy);
    openItemsOf(storeId)
      .filter((item) => item.decision)
      .forEach((item) => {
        const deadline = new Date(
          new Date(item.createdAt).getTime() + hours * 60 * 60 * 1000,
        ).toISOString();
        replaceItem(exceptionItems, (entry) => entry.id === item.id, (entry) => ({
          ...entry,
          decision: entry.decision
            ? { ...entry.decision, timeoutHours: hours, deadline }
            : entry.decision,
        }));
      });
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '更新超时策略',
      entity: '店铺',
      entityId: storeId,
      summary: `升级超时策略：${hours} 小时未处理 → ${action}`,
      category: 'exception',
    });
    return mockDelay(policy);
  },

  /** 提醒：只增加提醒次数与时间戳，不替人下结论，决策请求保持待处理。 */
  remindDecision: (id: string, cadenceHours: number) => {
    const item = exceptionItems.find((entry) => entry.id === id);
    if (!item?.decision || item.resolved || item.ignored) return mockDelay(false);
    const last = item.lastRemindedAt ? new Date(item.lastRemindedAt).getTime() : 0;
    if (Date.now() - last < cadenceHours * 60 * 60 * 1000) return mockDelay(false);
    replaceItem(exceptionItems, (entry) => entry.id === id, (entry) => ({
      ...entry,
      reminderCount: (entry.reminderCount ?? 0) + 1,
      lastRemindedAt: nowIso(),
    }));
    logExceptionAction(id, '超时提醒', `已提醒第 ${(item.reminderCount ?? 0) + 1} 次`, AGENT_POLICY_ACTOR);
    return mockDelay(true);
  },

  /** 暂停：冻结该店铺、该 Agent 的新提案与执行，直到人处理这条决策。 */
  pauseDecisionAgent: (id: string) => {
    const item = exceptionItems.find((entry) => entry.id === id);
    if (!item || item.agentPausedAt || item.resolved || item.ignored) return mockDelay(false);
    replaceItem(exceptionItems, (entry) => entry.id === id, (entry) => ({
      ...entry,
      agentPausedAt: nowIso(),
    }));
    logExceptionAction(
      id,
      '超时暂停 Agent',
      `${item.storeName} · ${item.agentType} 的自动执行已暂停，等待人工决策`,
      AGENT_POLICY_ACTOR,
    );
    return mockDelay(true);
  },

  /** 上报 Owner：只提升级别与标识，不替 Owner 做结论。 */
  escalateDecisionToOwner: (id: string) => {
    const item = exceptionItems.find((entry) => entry.id === id);
    if (!item || item.escalatedToOwnerAt || item.resolved || item.ignored) return mockDelay(false);
    replaceItem(exceptionItems, (entry) => entry.id === id, (entry) => ({
      ...entry,
      level: 'critical' as const,
      escalatedToOwnerAt: nowIso(),
    }));
    logExceptionAction(id, '超时上报 Owner', '决策请求已上报店铺 Owner', AGENT_POLICY_ACTOR);
    return mockDelay(true);
  },

  resumeAgent: (storeId: number, agentType: string) => {
    releasePausedAgent(storeId, agentType);
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '恢复 Agent 执行',
      entity: '店铺',
      entityId: storeId,
      summary: `恢复 ${agentType} 在本店的自动执行`,
      category: 'exception',
    });
    return mockDelay(undefined);
  },

  /** 人一旦在本店做出任何决策，就解除该店所有超时暂停——避免旧冻结挡住新判断。 */
  resumeAllPaused: (storeId: number) => {
    const paused = openItemsOf(storeId).filter((item) => item.agentPausedAt);
    if (paused.length === 0) return;
    paused.forEach((item) => {
      item.agentPausedAt = undefined;
    });
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '恢复 Agent 执行',
      entity: '店铺',
      entityId: storeId,
      summary: `人工已接手，恢复 ${paused.length} 个暂停中的 Agent 决策`,
      category: 'exception',
    });
  },

  /**
   * P30.6 人工接管：人显式接管本店后，Agent 只出方案、不再自动执行。
   * 已生成的提案保留，人可以逐条手动提交；接管是店铺维度，解除后自动执行恢复。
   */
  listTakeovers: (): StoreTakeover[] => [...storeTakeovers.values()],

  isStoreTakenOver: (storeId: number): boolean => storeTakeovers.has(storeId),

  startTakeover: (storeId: number): Promise<StoreTakeover> => {
    const existing = storeTakeovers.get(storeId);
    if (existing) return mockDelay(existing);
    const takeover: StoreTakeover = {
      storeId,
      reason: '人工接管：暂停本店自动执行，保留提案供人提交',
      actor: CURRENT_ACTOR,
      startedAt: nowIso(),
    };
    storeTakeovers.set(storeId, takeover);
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '人工接管店铺',
      entity: '店铺',
      entityId: storeId,
      summary: 'Agent 停止自动执行，保留提案供人手动提交',
      category: 'exception',
    });
    return mockDelay(takeover);
  },

  endTakeover: (storeId: number): Promise<boolean> => {
    const existing = storeTakeovers.get(storeId);
    if (!existing) return mockDelay(false);
    storeTakeovers.delete(storeId);
    recordAuditLog({
      actor: CURRENT_ACTOR,
      action: '解除人工接管',
      entity: '店铺',
      entityId: storeId,
      summary: `人工接管结束，Agent 恢复自动执行（接管自 ${existing.startedAt}）`,
      category: 'exception',
    });
    return mockDelay(true);
  },

  /**
   * P6 升级入口：经营周期里的拦截/延后与执行失败，需要人接手处理。
   * 用稳定 id 去重，避免每次读取周期都重复堆一条待办；已处理的条目不再复活。
   */
  upsertEscalation: (item: ExceptionItem) => {
    const existing = exceptionItems.find((entry) => entry.id === item.id);
    if (existing) {
      if (existing.resolved || existing.ignored) return mockDelay(false);
      // P40.1：巡检每次只重算“内容”，不重算“时钟”。
      // 等待起点、超时截止与超时策略痕迹沿用首次登记，否则每轮 60s 巡检都会把倒计时清零，
      // 超时策略（提醒/降级/暂停/上报）永远不会触发，人也看不到这条已经等了多久。
      replaceItem(exceptionItems, (entry) => entry.id === item.id, (entry) => ({
        ...item,
        createdAt: entry.createdAt,
        decision:
          item.decision && entry.decision
            ? {
                ...item.decision,
                timeoutHours: entry.decision.timeoutHours,
                deadline: entry.decision.deadline,
              }
            : item.decision,
        reminderCount: entry.reminderCount,
        lastRemindedAt: entry.lastRemindedAt,
        escalatedToOwnerAt: entry.escalatedToOwnerAt,
        agentPausedAt: entry.agentPausedAt,
        // 上报 Owner 后级别已被提升，巡检不能把它降回 warning。
        level: entry.escalatedToOwnerAt ? entry.level : item.level,
        // 路由结果属于登记痕迹：保留指派，避免每轮巡检都被当成“未指派”重新路由、重复发通知。
        assignee: entry.assignee,
        assigneeRole: entry.assigneeRole,
        assignedBy: entry.assignedBy,
        assignedAt: entry.assignedAt,
        assignmentReason: entry.assignmentReason,
      }));
      return mockDelay(false);
    }
    exceptionItems.unshift(item);
    return mockDelay(true);
  },

  /** P30.3：决策规则列表（只读副本，避免 UI 直接改内部状态）。 */
  listDecisionRules: (): EscalationDecisionRule[] => [...decisionRules],

  getDecisionHistory,
  findDecisionRule,

  /**
   * P30.3：人确认「以后都这样」→ 落一条店铺 + 决策类型维度的规则。
   * 同一店铺同一类型只有一条，重复确认视为更新结论；旧规则依据一并替换。
   */
  saveDecisionRule: (input: {
    storeId: number;
    decisionKind: EscalationDecisionKind;
    outcome: EscalationDecisionOutcome;
    sourceDecisionIds: string[];
  }): Promise<EscalationDecisionRule> => {
    const existing = findDecisionRule(input.storeId, input.decisionKind);
    if (existing) {
      existing.outcome = input.outcome;
      existing.sourceDecisionIds = input.sourceDecisionIds;
      existing.createdAt = nowIso();
      existing.createdBy = CURRENT_ACTOR;
      logDecisionRuleAction(
        existing.id,
        '更新决策规则',
        `同类升级改为「${input.outcome === 'override' ? '放行' : '维持护栏'}」`,
      );
      return mockDelay(existing);
    }
    const rule: EscalationDecisionRule = {
      id: `decision-rule-${Date.now().toString(36)}`,
      storeId: input.storeId,
      decisionKind: input.decisionKind,
      outcome: input.outcome,
      sourceDecisionIds: input.sourceDecisionIds,
      createdAt: nowIso(),
      createdBy: CURRENT_ACTOR,
      appliedCount: 0,
    };
    decisionRules.unshift(rule);
    logDecisionRuleAction(
      rule.id,
      '沉淀决策规则',
      `同类升级今后按「${input.outcome === 'override' ? '放行' : '维持护栏'}」由 Agent 收尾`,
    );
    return mockDelay(rule);
  },

  /** 撤销即回到逐条询问；已由规则收尾的历史结论不回滚。 */
  revokeDecisionRule: (id: string): Promise<boolean> => {
    const index = decisionRules.findIndex((rule) => rule.id === id);
    if (index < 0) return mockDelay(false);
    const [rule] = decisionRules.splice(index, 1);
    logDecisionRuleAction(rule.id, '撤销决策规则', '同类升级恢复逐条询问');
    return mockDelay(true);
  },

  /** 规则每自动收尾一条就记一次，供人回看规则到底替你做了多少决定。 */
  markDecisionRuleApplied: (id: string): void => {
    const rule = decisionRules.find((entry) => entry.id === id);
    if (!rule) return;
    rule.appliedCount += 1;
    rule.lastAppliedAt = nowIso();
  },
};

/** 刷新持久化：异常处理与升级项的去留是闭环的一部分，刷新后不能回到未处理。 */
registerMockState(
  'exceptions',
  () => ({
    items: exceptionItems,
    policies: [...escalationPolicies.values()],
    rules: [...decisionRules],
    takeovers: [...storeTakeovers.values()],
    notices: escalationNotices,
  }),
  (value) => {
    const data = value as {
      items?: ExceptionItem[];
      policies?: StoreEscalationPolicy[];
      rules?: EscalationDecisionRule[];
      takeovers?: StoreTakeover[];
      notices?: EscalationNotice[];
    } | null;
    if (!data?.items) return;
    exceptionItems.length = 0;
    exceptionItems.push(...data.items);
    escalationPolicies.clear();
    (data.policies ?? []).forEach((policy) => escalationPolicies.set(policy.storeId, policy));
    decisionRules.length = 0;
    decisionRules.push(...(data.rules ?? []));
    storeTakeovers.clear();
    (data.takeovers ?? []).forEach((takeover) => storeTakeovers.set(takeover.storeId, takeover));
    escalationNotices.length = 0;
    escalationNotices.push(...(data.notices ?? []));
    noticeSeq = escalationNotices.length;
  },
);
