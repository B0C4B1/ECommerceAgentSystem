import { mockDelay } from './client';
import { approvalEvidence, approvalPriorApprovals, approvals, auditLogs, tasks } from './mockData';
import { insertFirst, replaceItem } from './mockRepository';
import { recordAuditLog } from './auditLogger';
import { registerMockState } from './mockPersistence';
import { resolveApprovalRequirement } from './operatingModel';
import { getPolicyForRisk } from './approvalPolicies';
import { outcomesApi } from './outcomes';
import type {
  AgentType,
  AllMallId,
  Approval,
  ApprovalRequirement,
  ApprovalStatus,
  AuditLog,
  GoalMetric,
  GoalOutcome,
  ProposalAction,
  RiskLevel,
  Task,
} from '../types/domain';

const CURRENT_ACTOR = '当前用户';
/** P51：超时收尾的审计与决策人统一记为 Agent，方便人区分「谁关掉的」。 */
const TIMEOUT_ACTOR = 'Agent（审批超时）';

/** WS-B (B3): attach structured before/after evidence and dual-approval progress. */
function withEvidence(approval: Approval): Approval {
  return {
    ...approval,
    evidence: approval.evidence ?? approvalEvidence[approval.id],
    priorApprovals: approval.priorApprovals ?? approvalPriorApprovals[approval.id]
  };
}

/** P1: 创建审批的结果 — 店铺策略判定为自动执行时不会产生审批单。 */
export interface ApprovalCreateResult {
  approval?: Approval;
  autoExecuted: boolean;
  requirement: ApprovalRequirement;
}

/** WS-B (B4): outcome of a decision — dual approval may leave the item pending. */
export interface ApprovalDecisionResult {
  approval: Approval;
  /** false when a dual-approval item recorded its first approval and stays pending */
  finalized: boolean;
  /** number of approvals completed so far (dual approval) */
  approvalsCompleted: number;
  /** number of approvals required by policy */
  approvalsRequired: number;
  /** S1 回执：审批真正影响到的目标效果记录（没有挂账时为空） */
  outcome?: GoalOutcome;
}

function recordDecisionAudit(
  approval: Approval,
  action: string,
  summary: string,
  actor: string = CURRENT_ACTOR,
): void {
  const auditLog: AuditLog = {
    id: 6000 + auditLogs.length + 1,
    actor,
    action,
    entity: '审批',
    entityId: approval.id,
    storeId: approval.storeId,
    summary,
    at: new Date().toISOString(),
    category: 'approval',
    linkTo: '/agents/approvals/' + approval.id
  };
  auditLogs.push(auditLog);
}

function syncTaskAfterDecision(approval: Approval, status: 'approved' | 'rejected'): void {
  const task: Task | undefined = tasks.find((t) => t.id === approval.taskId);
  if (!task) return;
  replaceItem(tasks, (t) => t.id === task.id, (t) => ({
    ...t,
    status: (status === 'approved' ? 'running' : 'cancelled') as Task['status'],
    updatedAt: new Date().toISOString(),
    timeline: [
      ...t.timeline,
      {
        id: Date.now(),
        type: (status === 'approved' ? 'run_started' : 'run_failed') as Task['timeline'][number]['type'],
        title: status === 'approved' ? '审批通过，任务继续执行' : '审批拒绝，任务已取消',
        summary: status === 'approved' ? '审批已通过，Agent 继续执行' : '审批未通过，任务已取消',
        at: new Date().toISOString()
      }
    ]
  }));
}

/**
 * P51：审批时限必须真的执行，否则「到期未处理将……」只是一句文案。
 * 在读取列表/详情和治理巡检时调用；幂等，只处理已过策略时限的待审批单。
 * - auto_reject：关闭为「已过期」，任务取消、挂账作废；
 * - auto_approve：遗留的低风险单按策略自动通过并回写效果；
 * - escalate：保留待办，只记一次「已升级给管理员」，仍由人做最终决策。
 */
export function expireDueApprovals(now: Date = new Date()): number {
  let changed = 0;
  const nowMs = now.getTime();
  for (const current of [...approvals]) {
    if (current.status !== 'pending') continue;
    const policy = getPolicyForRisk(current.riskLevel);
    if (!policy) continue;
    const deadlineMs = new Date(current.requestedAt).getTime() + policy.timeoutHours * 60 * 60 * 1000;
    if (nowMs < deadlineMs) continue;

    if (policy.timeoutAction === 'escalate') {
      if (current.timeoutEscalatedAt) continue;
      const escalated = replaceItem(approvals, (item) => item.id === current.id, (item) => ({
        ...withEvidence(item),
        timeoutEscalatedAt: now.toISOString(),
      }));
      if (!escalated) continue;
      recordDecisionAudit(
        escalated,
        '审批超时升级',
        `${escalated.title} - 超过 ${policy.timeoutHours} 小时未处理，已升级给管理员，仍待决策`,
        TIMEOUT_ACTOR,
      );
      changed += 1;
      continue;
    }

    const approved = policy.timeoutAction === 'auto_approve';
    const updated = replaceItem(approvals, (item) => item.id === current.id, (item) => ({
      ...withEvidence(item),
      status: (approved ? 'approved' : 'expired') as ApprovalStatus,
      decidedAt: now.toISOString(),
      decidedBy: TIMEOUT_ACTOR,
      decisionNote: `超过 ${policy.timeoutHours} 小时未处理，按审批策略自动${approved ? '通过' : '驳回'}`,
    }));
    if (!updated) continue;
    syncTaskAfterDecision(updated, approved ? 'approved' : 'rejected');
    if (approved) outcomesApi.realizeByApproval(updated.id);
    else outcomesApi.discardByApproval(updated.id);
    recordDecisionAudit(
      updated,
      approved ? '审批超时自动通过' : '审批超时自动驳回',
      `${updated.title} - 超过 ${policy.timeoutHours} 小时未处理，按策略自动${approved ? '通过' : '驳回'}`,
      TIMEOUT_ACTOR,
    );
    changed += 1;
  }
  return changed;
}

export const approvalsApi = {
  list: () => {
    expireDueApprovals();
    return mockDelay(approvals.map(withEvidence));
  },
  get: (approvalId: AllMallId) => {
    expireDueApprovals();
    const approval = approvals.find((item) => item.id === approvalId);
    return mockDelay(approval ? withEvidence(approval) : undefined);
  },
  create: (input: {
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
    /**
     * S1 首启闭环：直接创建的审批（如开店引导里的“回复差评”）没有经营周期，
     * 但仍需要留下目标效果挂账，审批通过后才能回写进度。
     */
    goalEffect?: {
      action: ProposalAction;
      targetLabel: string;
      metric: GoalMetric;
      expectedImpact: number;
    };
  }) => {
    // P1: 审批是否发生由「风险等级 × 店铺生效自主等级」决定，而不是全局风险策略。
    const requirement = resolveApprovalRequirement(input.storeId, input.agentType, input.riskLevel);
    if (requirement === 'auto') {
      recordAuditLog({
        actor: CURRENT_ACTOR,
        action: '动作自动执行',
        entity: '审批',
        entityId: input.taskId,
        storeId: input.storeId,
        summary: `${input.title} — 店铺策略判定为自动执行，未进入待办`,
        category: 'agent_action',
        linkTo: `/dashboard?storeId=${input.storeId}`,
      });
      if (input.goalEffect) {
        outcomesApi.recordCrossStore({
          storeId: input.storeId,
          cycleId: 0,
          agentType: input.agentType as AgentType,
          action: input.goalEffect.action,
          targetLabel: input.goalEffect.targetLabel,
          metric: input.goalEffect.metric,
          expectedImpact: input.goalEffect.expectedImpact,
          status: 'realized',
          executionStatus: 'succeeded',
        });
      }
      return mockDelay<ApprovalCreateResult>({ autoExecuted: true, requirement });
    }

    const { goalEffect, ...approvalInput } = input;
    const approval: Approval = {
      id: 5000 + approvals.length + 1,
      ...approvalInput,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      requirement,
    };
    insertFirst(approvals, approval);
    if (goalEffect) {
      outcomesApi.recordForApproval({
        storeId: input.storeId,
        approvalId: approval.id,
        agentType: input.agentType as AgentType,
        action: goalEffect.action,
        targetLabel: goalEffect.targetLabel,
        metric: goalEffect.metric,
        expectedImpact: goalEffect.expectedImpact,
      });
    }
    return mockDelay<ApprovalCreateResult>({ approval, autoExecuted: false, requirement });
  },
  /**
   * WS-B (B4): record an approve/reject decision with an optional note.
   * High-risk items follow the dual-approval policy: the first approve is
   * recorded as progress and the item stays pending until the second approve.
   * Reject always finalizes immediately.
   */
  decide: (
    approvalId: AllMallId,
    status: Extract<ApprovalStatus, 'approved' | 'rejected'>,
    note?: string
  ): Promise<ApprovalDecisionResult | undefined> => {
    const current = approvals.find((item) => item.id === approvalId);
    if (!current) return mockDelay(undefined);
    // 已通过 / 已拒绝的审批单不可再次决策，避免双标签页重复写入结果与审计。
    if (current.status !== 'pending') return mockDelay(undefined);
    // P51：超过时限且策略要求自动收尾的单子，先在旧标签页提交也不能绕过 Agent 的时限。
    const policy = getPolicyForRisk(current.riskLevel);
    const deadlineMs = new Date(current.requestedAt).getTime() + (policy?.timeoutHours ?? 0) * 60 * 60 * 1000;
    if (policy && policy.timeoutAction !== 'escalate' && Date.now() >= deadlineMs) {
      expireDueApprovals();
      return mockDelay(undefined);
    }

    const enriched = withEvidence(current);
    // 已落库的 requirement 优先，避免调整自主等级后追溯改变历史审批的单/双人要求。
    const requirement =
      current.requirement ?? resolveApprovalRequirement(current.storeId, current.agentType, current.riskLevel);
    const approvalsRequired = requirement === 'dual' ? 2 : 1;
    const priorApprovals = enriched.priorApprovals ?? [];

    // First approve of a dual-approval item: record progress, stay pending.
    if (status === 'approved' && approvalsRequired === 2 && priorApprovals.length + 1 < approvalsRequired) {
      const updated = replaceItem(approvals, (item) => item.id === approvalId, (item) => ({
        ...withEvidence(item),
        priorApprovals: [
          ...priorApprovals,
          { approver: CURRENT_ACTOR, at: new Date().toISOString(), note }
        ]
      }));
      if (updated) {
        recordDecisionAudit(updated, '一审通过', `${updated.title} - 双人审批 1/2 已通过${note ? `（备注：${note}）` : ''}`);
      }
      return mockDelay(
        updated
          ? { approval: updated, finalized: false, approvalsCompleted: priorApprovals.length + 1, approvalsRequired }
          : undefined
      );
    }

    const approval = replaceItem(approvals, (item) => item.id === approvalId, (item) => ({
      ...withEvidence(item),
      status,
      decidedAt: new Date().toISOString(),
      decidedBy: CURRENT_ACTOR,
      decisionNote: note
    }));
    let outcome: GoalOutcome | undefined;
    if (approval) {
      syncTaskAfterDecision(approval, status);
      // P3 归因回写：仅经营周期产生的审批单有对应效果记录，其余为 no-op。
      outcome =
        status === 'approved'
          ? outcomesApi.realizeByApproval(approval.id)
          : outcomesApi.discardByApproval(approval.id);
      recordDecisionAudit(
        approval,
        status === 'approved' ? '审批通过' : '审批拒绝',
        `${approval.title} - ${status === 'approved' ? '已通过' : '已拒绝'}${note ? `（备注：${note}）` : ''}`
      );
    }
    return mockDelay(
      approval
        ? {
            approval,
            finalized: true,
            approvalsCompleted: status === 'approved' ? approvalsRequired : priorApprovals.length,
            approvalsRequired,
            outcome,
          }
        : undefined
    );
  }
};

/** P24：早期版本持久化的审计日志没有店铺归因，回灌时按种子 id 补齐，避免升级后整列变空。 */
const seedStoreIdById = new Map(auditLogs.map((log) => [log.id, log.storeId]));

/** 刷新持久化：审批决策、关联任务与审计日志是“人处理升级”的痕迹，需跨刷新保留。 */
registerMockState(
  'approvals',
  () => ({ approvals, tasks, auditLogs }),
  (value) => {
    const data = value as { approvals?: Approval[]; tasks?: Task[]; auditLogs?: AuditLog[] } | null;
    if (!data) return;
    approvals.length = 0;
    approvals.push(...(data.approvals ?? []));
    tasks.length = 0;
    tasks.push(...(data.tasks ?? []));
    auditLogs.length = 0;
    auditLogs.push(
      ...(data.auditLogs ?? []).map((log) => ({
        ...log,
        storeId: log.storeId ?? seedStoreIdById.get(log.id),
      })),
    );
  },
);
