/**
 * File: OperatingCycleCard.tsx
 * Purpose: P2 编排层的唯一 UI 面 —— 在 Dashboard 上展示“本店经营周期”：
 * 目标差距 → 跨 Agent 提案 → 冲突仲裁 → 提交执行（交回 P1 的店铺策略判定）。
 *
 * 为什么放在工作台：经营周期是“为什么做/做什么”的主线，目标卡回答“为什么”，
 * 这张卡回答“本周打算怎么做、哪些动作被拦下了”。
 */
import { QuestionCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Steps,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { agentProfilesApi, AGENT_TYPE_DOMAIN, isSpecialized, SPECIALIZED_BOOST } from '../../api/agentProfiles';
import { agentsApi } from '../../api/agents';
import { exceptionsApi } from '../../api/exceptions';
import { orchestratorApi } from '../../api/orchestrator';
import { operatingModelApi, resolveApprovalRequirement } from '../../api/operatingModel';
import { useAuth } from '../../app/auth';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import type {
  AgentCollaboration,
  AgentType,
  ArbitrationDecision,
  ArbitrationReason,
  ConflictResolution,
  CycleProposal,
  GoalOutcome,
  OutcomeStatus,
  ProposalStatus,
} from '../../types/domain';

const STATUS_COLOR: Record<ProposalStatus, string> = {
  pending: 'default',
  selected: 'blue',
  blocked: 'red',
  deferred: 'orange',
  submitted: 'green',
};

const OUTCOME_COLOR: Record<OutcomeStatus, string> = {
  projected: 'orange',
  realized: 'green',
  lost: 'default',
};

const STAGES = ['observe', 'diagnose', 'propose', 'arbitrate', 'execute'] as const;

function formatMoney(value: number) {
  return `¥${new Intl.NumberFormat('zh-CN').format(value)}`;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

const ARBITRATION_REASONS: ArbitrationReason[] = [
  'goal_priority',
  'protect_margin',
  'protect_stock',
  'platform_recommendation',
  'manual',
];

/** 批量维持自动裁决时，按冲突类型写入对应的仲裁依据，保证审计口径一致。 */
function upholdReason(conflict: ConflictResolution): ArbitrationReason {
  if (conflict.type === 'margin' || conflict.type === 'discount_cap') return 'protect_margin';
  if (conflict.type === 'dependency') return 'protect_stock';
  return 'goal_priority';
}

/**
 * P8 冲突裁决台的一行：展示自动仲裁结论，并提供“维持 / 改判 + 理由”。
 * 裁决后只读展示结论与理由，避免同一条冲突被反复改来改去。
 */
function ConflictArbitrationRow({
  conflict,
  description,
  agentTypes,
  recommendation,
  overridePreview,
  ruleDirection,
  canDecide,
  deciding,
  highlighted,
  t,
  onDecide,
}: {
  conflict: ConflictResolution;
  description: string;
  agentTypes: AgentType[];
  recommendation: string;
  overridePreview?: string;
  ruleDirection?: 'raise' | 'discount';
  canDecide: boolean;
  deciding: boolean;
  highlighted?: boolean;
  t: Translate;
  onDecide: (
    decision: ArbitrationDecision,
    reason: ArbitrationReason,
    note?: string,
    submitAfterOverride?: boolean,
  ) => void;
}) {
  const [reason, setReason] = useState<ArbitrationReason>('goal_priority');
  const [note, setNote] = useState('');
  const [submitAfterOverride, setSubmitAfterOverride] = useState(true);
  const decided = Boolean(conflict.decision);
  return (
    <Alert
      type={decided ? (conflict.decision === 'override' ? 'success' : 'info') : 'warning'}
      showIcon
      style={highlighted ? { boxShadow: '0 0 0 2px var(--ark-blue)', borderRadius: 8 } : undefined}
      message={
        <Space size={6} wrap>
          <span>{t(`cycle.conflictType_${conflict.type}`, { target: conflict.targetLabel })}</span>
          <Tag>{t(`cycle.basis_${conflict.basis}`)}</Tag>
          {agentTypes.map((agentType) => (
            <Tag key={agentType} color="geekblue">{t(`agent.${agentType}`)}</Tag>
          ))}
          {conflict.decision && (
            <Tag color={conflict.decision === 'override' ? 'green' : 'default'}>
              {t(`cycle.decisionTag_${conflict.decision}`)}
            </Tag>
          )}
          {conflict.detail.preferredDirection && (
            <Tag color="purple">
              {t('cycle.ruleApplied', {
                direction: t(`cycle.direction_${conflict.detail.preferredDirection}`),
              })}
            </Tag>
          )}
        </Space>
      }
      description={
        <>
          <div>{description}</div>
          {!decided && (
            <div style={{ marginTop: 4 }}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                <RobotOutlined style={{ marginRight: 4 }} />
                {recommendation}
              </Typography.Text>
              {overridePreview && (
                <Typography.Text type="warning" style={{ display: 'block', fontSize: 12 }}>
                  {overridePreview}
                </Typography.Text>
              )}
            </div>
          )}
          {decided ? (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
              {t('cycle.decidedNote', {
                reason: t(`cycle.reason_${conflict.decisionReason}`),
                time: dayjs(conflict.decidedAt).format('MM-DD HH:mm'),
              })}
              {conflict.decidedBy
                ? ` · ${t('cycle.decidedBy', { actor: conflict.decidedBy })}`
                : ''}
              {ruleDirection
                ? ` · ${t('cycle.ruleSaved', { direction: t(`cycle.direction_${ruleDirection}`) })}`
                : ''}
              {conflict.decisionNote ? (
                <span style={{ display: 'block' }}>{t('cycle.decisionNoteLabel', { note: conflict.decisionNote })}</span>
              ) : null}
            </Typography.Text>
          ) : (
            <div style={{ marginTop: 6 }}>
              <Space size={6} wrap>
                <Select
                  size="small"
                  value={reason}
                  style={{ width: 150 }}
                  disabled={!canDecide}
                  onChange={(value) => setReason(value)}
                  options={ARBITRATION_REASONS.map((item) => ({
                    value: item,
                    label: t(`cycle.reason_${item}`),
                  }))}
                />
                <Button
                  size="small"
                  type="primary"
                  loading={deciding}
                  disabled={!canDecide}
                  onClick={() => onDecide('uphold', reason, note)}
                >
                  {t('cycle.decideUphold')}
                </Button>
                <Button
                  size="small"
                  loading={deciding}
                  disabled={!canDecide}
                  onClick={() => onDecide('override', reason, note, submitAfterOverride)}
                >
                  {t('cycle.decideOverride')}
                </Button>
              </Space>
              <Input.TextArea
                size="small"
                value={note}
                disabled={!canDecide}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t('cycle.decisionNotePlaceholder')}
                autoSize={{ minRows: 1, maxRows: 3 }}
                style={{ marginTop: 6 }}
              />
              <Checkbox
                checked={submitAfterOverride}
                disabled={!canDecide}
                onChange={(event) => setSubmitAfterOverride(event.target.checked)}
                style={{ marginTop: 4, fontSize: 12 }}
              >
                {t('cycle.submitAfterOverride')}
              </Checkbox>
            </div>
          )}
        </>
      }
    />
  );
}

export function OperatingCycleCard({
  storeId,
  storeName,
  focusEscalationId,
}: {
  storeId?: number;
  storeName?: string;
  /** 从收件箱升级项深链进入时，自动打开抽屉并高亮对应冲突 */
  focusEscalationId?: string;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { can } = usePermission();
  const canUpdateSetup = can('setup', 'update');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: cycle } = useQuery({
    queryKey: ['operatingCycle', storeId],
    queryFn: () => orchestratorApi.getCycle(storeId!),
    enabled: storeId !== undefined,
  });

  // P10 目标/护栏是否在本轮生成后被改过 — 改过就提示重新生成，避免旧结论继续生效。
  const { data: goal } = useQuery({
    queryKey: ['storeGoal', storeId],
    queryFn: () => operatingModelApi.getGoal(storeId!),
    enabled: storeId !== undefined,
  });

  const guardChanged = Boolean(
    goal &&
      ((cycle?.guardSnapshot &&
        (cycle.guardSnapshot.minGrossMargin !== goal.constraints.minGrossMargin ||
          cycle.guardSnapshot.maxDiscountPct !== goal.constraints.maxDiscountPct ||
          cycle.guardSnapshot.monthlyBudgetCap !== goal.constraints.monthlyBudgetCap)) ||
        (cycle?.diagnosis && cycle.diagnosis.priority !== goal.priority)),
  );

  // P11 收件箱升级项深链：直接落到本店的裁决台，而不是只跳到工作台首页。
  useEffect(() => {
    if (focusEscalationId?.startsWith('cycle-') && storeId !== undefined) setOpen(true);
  }, [focusEscalationId, storeId]);

  // B：当前店铺的 Agent 画像 — 让“这家店用的是通用型还是行业专属型”可见。
  const { data: profile } = useQuery({
    queryKey: ['agentStoreProfile', storeId],
    queryFn: () => agentProfilesApi.getProfile(storeId!),
    enabled: storeId !== undefined,
  });

  // P6 自动运转：默认开启，人可随时关掉（关掉后只保留手动生成）。
  const { data: autoConfig } = useQuery({
    queryKey: ['autoTrigger', storeId],
    queryFn: () => orchestratorApi.getAutoTrigger(storeId!),
    enabled: storeId !== undefined,
  });

  // P30.6 人工接管：接管中 Agent 只出方案，不自动执行；提案保留，可手动提交。
  const { data: takeovers = [] } = useQuery({
    queryKey: ['storeTakeovers'],
    queryFn: async () => exceptionsApi.listTakeovers(),
  });
  const takeover = takeovers.find((entry) => entry.storeId === storeId);

  // P28.3 调度真值：巡检时间来自心跳，不再拿「周期生成时间」冒充上一次巡检。
  const { data: schedulerStatus } = useQuery({
    queryKey: ['schedulerStatus'],
    queryFn: () => orchestratorApi.getSchedulerStatus(),
    refetchInterval: 15_000,
  });

  // S1：登录引导 Agent 不产出经营动作；除它之外全部关闭时，生成只会得到空方案。
  const { data: agentConfigs = [] } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.list() });
  const hasBusinessAgent = agentConfigs.some(
    (agent) => agent.enabled && agent.agentType !== 'login_bootstrap',
  );

  const autoToggleMutation = useMutation({
    mutationFn: (patch: { enabled?: boolean; autoSubmitLowRisk?: boolean }) =>
      orchestratorApi.setAutoTrigger(storeId!, patch),
    onSuccess: (next, patch) => {
      queryClient.setQueryData(['autoTrigger', storeId], next);
      if (patch.autoSubmitLowRisk === true) {
        // 开启即执行一次，不用等下一轮调度 — 否则开关看起来“没反应”。
        orchestratorApi.autoSubmitLowRisk(storeId!, storeName).then((count) => {
          queryClient.invalidateQueries({ queryKey: ['operatingCycle', storeId] });
          queryClient.invalidateQueries({ queryKey: ['exceptions'] });
          queryClient.invalidateQueries({ queryKey: ['approvals'] });
          // P27: 执行会写归因账本，工作台复盘卡要同步刷新。
          queryClient.invalidateQueries({ queryKey: ['reviewOutcomes'] });
          message.success(
            t(count > 0 ? 'cycle.autoLowRiskOn' : 'cycle.autoLowRiskOnIdle', {
              count: String(count),
            }),
          );
        });
        return;
      }
      if (patch.autoSubmitLowRisk === false) {
        message.success(t('cycle.autoLowRiskOff'));
        return;
      }
      message.success(t(next.enabled ? 'cycle.autoOn' : 'cycle.autoOff'));
    },
  });

  const isSpecializedProposal = (agentType: string) => {
    const domain = AGENT_TYPE_DOMAIN[agentType];
    return domain ? isSpecialized(profile, domain) : false;
  };

  const generateMutation = useMutation({
    mutationFn: () => orchestratorApi.generateCycle(storeId!),
    onSuccess: (next) => {
      queryClient.setQueryData(['operatingCycle', storeId], next);
      // 下一轮诊断基于回写后的目标进度，同步刷新目标卡与多店铺概览。
      queryClient.invalidateQueries({ queryKey: ['storeGoal', storeId] });
      // P32.2：体检里的建议值来自本轮提案，新方案生成后必须重算，否则会给过期的建议。
      queryClient.invalidateQueries({ queryKey: ['guardHealth', storeId] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
      // 生成是明确的人工动作，下一步就是看方案：直接打开抽屉，别让人以为没反应。
      setOpen(true);
      message.success(t('cycle.generated'));
    },
    onError: (error: Error) => {
      // S1：没有开启任何 Agent 时不再假装生成成功，直接把人引到 Agent 广场。
      if (error.message === 'no_agent_enabled') {
        message.warning(t('cycle.noAgentEnabled'));
        return;
      }
      message.error(t('cycle.generateFailed'));
    },
  });

  /**
   * S3：执行失败后不再只剩“已停止重试”。
   * 先关掉对应升级项，再重新生成一轮 —— 失败动作已在归因账本里标记为可重试，会重新出现在提案里。
   */
  const retryFailed = async (outcome: GoalOutcome) => {
    try {
      const items = await exceptionsApi.list();
      const related = items.find(
        (item) => item.id.startsWith(`cycle-exec-${cycle?.id}-`) && item.id.endsWith(`-${outcome.proposalId}`),
      );
      if (related) await exceptionsApi.resolve(related.id);
      generateMutation.mutate();
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    } catch {
      message.error(t('cycle.generateFailed'));
    }
  };

  const submitMutation = useMutation({
    mutationFn: (proposalId: number) =>
      orchestratorApi.submitProposal(storeId!, storeName ?? '', proposalId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['operatingCycle', storeId] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal', storeId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      // P27: 执行会写归因账本，工作台复盘卡要同步刷新。
      queryClient.invalidateQueries({ queryKey: ['reviewOutcomes'] });
      // P6：自动执行也拿平台回执，失败/超时不算收益，并已升级到收件箱。
      if (result.executionStatus === 'failed' || result.executionStatus === 'timeout') {
        message.error(
          t(`cycle.exec_${result.executionStatus}Toast`, { target: result.outcome.targetLabel }),
        );
        return;
      }
      if (result.autoExecuted) {
        message.success(
          t('cycle.submittedAutoOutcome', { value: formatMoney(result.outcome.actualImpact ?? 0) }),
        );
      } else {
        message.success(
          t('cycle.submittedPendingOutcome', {
            requirement: t(`cycle.requirement_${result.requirement}`),
          }),
        );
      }
    },
    onError: (error: Error) =>
      message.error(error.message === 'agent_paused' ? t('cycle.agentPaused') : t('cycle.submitFailed')),
  });

  // P5 协同执行：按协同组给出的顺序依次提交，避免用户手动打乱先后关系。
  const submitGroupMutation = useMutation({
    mutationFn: async (proposalIds: number[]) => {
      const results = [];
      for (const proposalId of proposalIds) {
        results.push(await orchestratorApi.submitProposal(storeId!, storeName ?? '', proposalId));
      }
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ['operatingCycle', storeId] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal', storeId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['reviewOutcomes'] });
      const degraded = results.filter(
        (result) => result.executionStatus === 'failed' || result.executionStatus === 'timeout',
      ).length;
      if (degraded > 0) {
        message.warning(
          t('cycle.collabSubmittedPartial', { done: String(results.length - degraded), failed: String(degraded) }),
        );
        return;
      }
      message.success(t('cycle.collabSubmitted', { count: String(results.length) }));
    },
    onError: (error: Error) =>
      message.error(error.message === 'agent_paused' ? t('cycle.agentPaused') : t('cycle.submitFailed')),
  });

  // P8 冲突裁决：维持只记录理由，改判会翻转提案状态并重算协同组。
  const decideMutation = useMutation({
    mutationFn: (vars: {
      conflictId: number;
      decision: ArbitrationDecision;
      reason: ArbitrationReason;
      note?: string;
      submitAfterOverride?: boolean;
    }) =>
      orchestratorApi.decideConflict(storeId!, vars.conflictId, vars.decision, vars.reason, {
        note: vars.note,
        actor: user?.name,
        submitAfterOverride: vars.submitAfterOverride,
        storeName,
      }),
    onSuccess: (next, vars) => {
      queryClient.setQueryData(['operatingCycle', storeId], next);
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal', storeId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      // 改判放行动作会改变跨店预算/价格方向评估。
      queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
      // 改判并放行会提交动作，归因账本随之变化。
      queryClient.invalidateQueries({ queryKey: ['reviewOutcomes'] });
      message.success(
        t(vars.decision === 'override' ? 'cycle.decisionOverrideToast' : 'cycle.decisionUpholdToast'),
      );
    },
    onError: () => message.error(t('cycle.submitFailed')),
  });

  // 批量确认自动裁决：人只改判自己不同意的结论，其余维持 Agent 的仲裁。
  const upholdAllMutation = useMutation({
    mutationFn: async () => {
      if (!storeId || !cycle) return { next: cycle, count: 0 };
      const pending = cycle.conflicts.filter((conflict) => !conflict.decision);
      let next = cycle;
      for (const conflict of pending) {
        next = await orchestratorApi.decideConflict(storeId, conflict.id, 'uphold', upholdReason(conflict), {
          actor: user?.name,
          note: t('cycle.upholdAllNote'),
          storeName,
        });
      }
      return { next, count: pending.length };
    },
    onSuccess: ({ next, count }) => {
      if (next) queryClient.setQueryData(['operatingCycle', storeId], next);
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal', storeId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
      message.success(t('cycle.upholdAllToast', { count: String(count) }));
    },
    onError: () => message.error(t('cycle.submitFailed')),
  });

  if (!storeId || !cycle) return null;

  const generated = Boolean(cycle.generatedAt);
  const selected = cycle.proposals.filter((p) => p.status === 'selected');
  const autoRunnable = selected.filter(
    (p) => resolveApprovalRequirement(storeId, p.agentType, p.riskLevel) === 'auto',
  ).length;
  const attributed = cycle.outcomes
    .filter((outcome) => outcome.status === 'realized')
    .reduce((sum, outcome) => sum + (outcome.actualImpact ?? 0), 0);
  const proposalById = (id?: number) => cycle.proposals.find((p) => p.id === id);
  const undecidedConflicts = cycle.conflicts.filter((conflict) => !conflict.decision);

  const conflictDescription = (conflict: ConflictResolution) => {
    if (conflict.type === 'direction') {
      const winner = proposalById(conflict.winnerProposalId);
      const loser = proposalById(conflict.loserProposalIds[0]);
      return t('cycle.conflictDirectionDesc', {
        winner: winner ? t(`cycle.action_${winner.action}`) : '-',
        loser: loser ? t(`cycle.action_${loser.action}`) : '-',
        priority: t(`goal.priority_${conflict.detail.priority}`),
      });
    }
    if (conflict.type === 'budget') {
      return t('cycle.conflictBudgetDesc', {
        remaining: formatMoney(conflict.detail.remainingBudget ?? 0),
        required: formatMoney(conflict.detail.requiredBudget ?? 0),
      });
    }
    if (conflict.type === 'dependency') {
      return t('cycle.conflictDependencyDesc', {
        count: String(conflict.detail.shortageCount ?? 0),
      });
    }
    if (conflict.type === 'double_count') {
      return t('cycle.conflictDoubleCountDesc', {
        impact: formatMoney(conflict.detail.duplicateImpact ?? 0),
      });
    }
    if (conflict.type === 'discount_cap') {
      return t('cycle.conflictDiscountCapDesc', {
        discount: String(conflict.detail.discountPct ?? 0),
        max: String(conflict.detail.maxDiscountPct ?? 0),
      });
    }
    return t('cycle.conflictMarginDesc', {
      projected: String(conflict.detail.projectedMargin ?? 0),
      min: String(conflict.detail.minMargin ?? 0),
    });
  };

  // 冲突涉及的 Agent：仲裁文案之外再给出“是谁和谁冲突”，避免只看到动作看不到责任方。
  const conflictAgentTypes = (conflict: ConflictResolution) => {
    const ids = [conflict.winnerProposalId, ...conflict.loserProposalIds].filter(
      (id): id is number => typeof id === 'number',
    );
    return Array.from(
      new Set(
        ids
          .map((id) => proposalById(id)?.agentType)
          .filter((agentType): agentType is AgentType => Boolean(agentType)),
      ),
    );
  };

  /** Agent 的默认建议：自动仲裁结论就是推荐项，人只需要否定自己不同意的部分。 */
  const recommendationFor = (conflict: ConflictResolution) =>
    t('cycle.agentRecommend', { basis: t(`cycle.basis_${conflict.basis}`) });

  /** 改判的影响预览：把被放行的动作和预期收益说清楚，避免盲改。 */
  const overridePreviewFor = (conflict: ConflictResolution) => {
    const released = conflict.loserProposalIds
      .map((id) => proposalById(id))
      .filter((proposal): proposal is CycleProposal => Boolean(proposal));
    if (released.length === 0) return undefined;
    return t('cycle.overridePreview', {
      action: released.map((proposal) => t(`cycle.action_${proposal.action}`)).join(' / '),
      value: new Intl.NumberFormat('zh-CN').format(
        released.reduce((sum, proposal) => sum + proposal.expectedImpact, 0),
      ),
      metric: t(`goal.metric_${cycle.diagnosis.metric}`),
    });
  };

  const proposalRow = (proposal: CycleProposal) => (
    <div
      key={proposal.id}
      style={{ borderBottom: '1px solid var(--ark-border-soft)', paddingBottom: 10 }}
    >
      <Space size={6} wrap>
        <Typography.Text strong>{proposal.targetLabel}</Typography.Text>
        <Tag>{t(`cycle.action_${proposal.action}`)}</Tag>
        <Tag color={STATUS_COLOR[proposal.status]}>{t(`cycle.status_${proposal.status}`)}</Tag>
        <Tag color={proposal.riskLevel === 'high' ? 'red' : proposal.riskLevel === 'medium' ? 'orange' : 'default'}>
          {t(`agent.${proposal.riskLevel}Risk`)}
        </Tag>
        {isSpecializedProposal(proposal.agentType) && (
          <Tag color="geekblue">{t('agentprofile.specializedTag', { boost: SPECIALIZED_BOOST })}</Tag>
        )}
      </Space>
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
        {proposal.before} → {proposal.after} · {t('cycle.impact', {
          metric: t(`goal.metric_${cycle.diagnosis.metric}`),
          value: new Intl.NumberFormat('zh-CN').format(proposal.expectedImpact),
        })}
        {proposal.cost > 0 ? ` · ${t('cycle.cost', { value: formatMoney(proposal.cost) })}` : ''}
      </Typography.Text>
      {proposal.status === 'selected' && (
        <Button
          size="small"
          type="link"
          style={{ paddingLeft: 0 }}
          loading={submitMutation.isPending && submitMutation.variables === proposal.id}
          disabled={!canUpdateSetup}
          onClick={() => submitMutation.mutate(proposal.id)}
        >
          {t('cycle.submit')}
        </Button>
      )}
    </div>
  );

  const collaborationRow = (collaboration: AgentCollaboration) => {
    const statusColor =
      collaboration.status === 'ready'
        ? 'blue'
        : collaboration.status === 'partial'
          ? 'orange'
          : collaboration.status === 'done'
            ? 'green'
            : 'red';
    const runnableIds = collaboration.sequence.filter(
      (id) => proposalById(id)?.status === 'selected',
    );
    return (
      <div
        key={collaboration.id}
        style={{
          border: '1px solid var(--ark-border-soft)',
          borderRadius: 8,
          padding: 10,
        }}
      >
        <Space size={6} wrap>
          <Tag color={statusColor}>{t(`cycle.collabStatus_${collaboration.status}`)}</Tag>
          <Typography.Text strong>{t(`cycle.collabKind_${collaboration.kind}`)}</Typography.Text>
          <Tag color="purple">{t('cycle.collabFactor', { factor: collaboration.factor })}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('cycle.collabImpact', { value: formatMoney(collaboration.combinedImpact) })}
          </Typography.Text>
        </Space>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
          {t(`cycle.collabDesc_${collaboration.kind}`)}
        </Typography.Text>
        <Typography.Text style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
          {t('cycle.collabLead', { agent: t(`agent.${collaboration.leadAgent}`) })}
        </Typography.Text>
        <Typography.Text style={{ display: 'block', marginTop: 2, fontSize: 12 }}>
          {t('cycle.collabSequence')}
          {collaboration.sequence
            .map((id, index) => {
              const proposal = proposalById(id);
              if (!proposal) return '';
              return `${index + 1}. ${t(`cycle.action_${proposal.action}`)}（${t(`cycle.status_${proposal.status}`)}）`;
            })
            .filter(Boolean)
            .join(' → ')}
        </Typography.Text>
        {runnableIds.length > 0 && (
          <Button
            size="small"
            type="primary"
            ghost
            style={{ marginTop: 8 }}
            loading={submitGroupMutation.isPending}
            disabled={!canUpdateSetup}
            onClick={() => submitGroupMutation.mutate(runnableIds)}
          >
            {t('cycle.collabRun', { count: String(runnableIds.length) })}
          </Button>
        )}
      </div>
    );
  };

  const outcomeRow = (outcome: GoalOutcome) => (
    <div
      key={outcome.id}
      style={{ borderBottom: '1px solid var(--ark-border-soft)', paddingBottom: 8 }}
    >
      <Space size={6} wrap>
        <Typography.Text strong>{outcome.targetLabel}</Typography.Text>
        <Tag>{t(`cycle.action_${outcome.action}`)}</Tag>
        <Tag color={OUTCOME_COLOR[outcome.status]}>{t(`cycle.outcomeStatus_${outcome.status}`)}</Tag>
        {outcome.executionStatus === 'failed' || outcome.executionStatus === 'timeout' ? (
          <Tag color="red">{t(`cycle.execution_${outcome.executionStatus}`)}</Tag>
        ) : null}
        {(outcome.executionStatus === 'failed' || outcome.executionStatus === 'timeout') && (
          <Button
            size="small"
            type="link"
            style={{ padding: 0, height: 'auto' }}
            loading={generateMutation.isPending}
            onClick={() => retryFailed(outcome)}
          >
            {t('cycle.retryFailed')}
          </Button>
        )}
      </Space>
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
        {t('cycle.outcomeExpected', { value: formatMoney(outcome.expectedImpact) })}
        {outcome.actualImpact !== undefined
          ? ` · ${t('cycle.outcomeActual', { value: formatMoney(outcome.actualImpact) })}`
          : ''}
        {' · '}
        {t('cycle.outcomeRecordedAt', { time: dayjs(outcome.recordedAt).format('MM-DD HH:mm') })}
      </Typography.Text>
    </div>
  );

  return (
    <Card
      style={{ marginBottom: 16 }}
      title={
        <Space size={8} wrap>
          {t('cycle.title')}
          <Tag color="purple">{t('cycle.template')}</Tag>
          {takeover && <Tag color="orange">{t('cycle.takeoverTag')}</Tag>}
          {profile && (
            <Tag color={profile.merchantType === 'specialized' ? 'geekblue' : 'default'}>
              {t('agentprofile.cycleTag', {
                merchant: t(`agentprofile.merchant_${profile.merchantType}`),
                industry: t(`agentprofile.industry_${profile.industry}`),
              })}
            </Tag>
          )}
          {generated && (
            <Tag
              color={
                cycle.triggeredBy === 'event'
                  ? 'orange'
                  : cycle.triggeredBy === 'schedule'
                    ? 'blue'
                    : 'default'
              }
            >
              {t(`cycle.trigger_${cycle.triggeredBy ?? 'manual'}`)}
              {cycle.triggerReason === 'stock_alert'
                ? ` · ${t('cycle.triggerReason_stock_alert')}`
                : ''}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Space size={8}>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('cycle.autoRun')}
            </Typography.Text>
            <Switch
              size="small"
              checked={autoConfig?.enabled ?? true}
              loading={autoToggleMutation.isPending}
              disabled={!canUpdateSetup}
              onChange={(checked) => autoToggleMutation.mutate({ enabled: checked })}
            />
          </Space>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('cycle.autoLowRisk')}
            </Typography.Text>
            <Switch
              size="small"
              checked={autoConfig?.autoSubmitLowRisk ?? false}
              loading={autoToggleMutation.isPending}
              disabled={!canUpdateSetup || !(autoConfig?.enabled ?? true) || Boolean(takeover)}
              onChange={(checked) => autoToggleMutation.mutate({ autoSubmitLowRisk: checked })}
            />
          </Space>
          {generated && (
            <Button
              size="small"
              disabled={!canUpdateSetup}
              loading={generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
            >
              {t('cycle.regenerate')}
            </Button>
          )}
          <Button size="small" onClick={() => setOpen(true)}>{t('cycle.viewPlan')}</Button>
        </Space>
      }
    >
      {takeover && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('cycle.takeoverAlert', {
            actor: takeover.actor,
            time: dayjs(takeover.startedAt).format('MM-DD HH:mm'),
          })}
        />
      )}
      <Steps
        size="small"
        current={generated ? STAGES.length - 1 : 0}
        status={generated ? 'finish' : 'process'}
        items={STAGES.map((stage) => ({ title: t(`cycle.stage_${stage}`) }))}
      />

      {generated ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, margin: '16px 0 8px' }}>
            <div>
              <Typography.Text type="secondary">{t('cycle.goalGap')}</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {t('cycle.goalGapValue', { pct: String(cycle.diagnosis.gapPct) })}
              </Typography.Title>
            </div>
            <div>
              <Typography.Text type="secondary">{t('cycle.proposals')}</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>{cycle.proposals.length}</Typography.Title>
            </div>
            <div>
              <Typography.Text type="secondary">{t('cycle.conflicts')}</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>{cycle.conflicts.length}</Typography.Title>
            </div>
            <div>
              <Typography.Text type="secondary">{t('cycle.collabStat')}</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>{cycle.collaborations.length}</Typography.Title>
            </div>
            <div>
              <Typography.Text type="secondary">{t('cycle.autoRunnable')}</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>{autoRunnable}</Typography.Title>
            </div>
            <div>
              <Typography.Text type="secondary">{t('cycle.outcomeStat')}</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>{formatMoney(attributed)}</Typography.Title>
            </div>
          </div>
          <Typography.Text type="secondary">
            {t('cycle.generatedAt', { time: dayjs(cycle.generatedAt).format('MM-DD HH:mm') })}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
            <RobotOutlined style={{ marginRight: 4 }} />
            {!(autoConfig?.enabled ?? true)
              ? t('cycle.autoStatusOff')
              : !schedulerStatus
                ? t('agentConsole.checkingHint')
                : !schedulerStatus.online
                  ? t('cycle.autoStatusOffline', {
                      last: schedulerStatus.lastPatrolAt
                        ? dayjs(schedulerStatus.lastPatrolAt).format('MM-DD HH:mm')
                        : t('agentConsole.neverPatrolled'),
                    })
                  : t('cycle.autoStatusOn', {
                      interval: String(schedulerStatus.intervalSeconds),
                      last: schedulerStatus.lastPatrolAt
                        ? dayjs(schedulerStatus.lastPatrolAt).format('MM-DD HH:mm')
                        : t('agentConsole.neverPatrolled'),
                      next: schedulerStatus.nextPatrolAt
                        ? dayjs(schedulerStatus.nextPatrolAt).format('MM-DD HH:mm')
                        : '—',
                    })}
          </Typography.Text>
        </>
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ margin: '16px 0 12px' }}>
            {t('cycle.desc')}
          </Typography.Paragraph>
          {!hasBusinessAgent && (
            <Alert
              type="warning"
              showIcon
              message={t('cycle.noBusinessAgentHint')}
              action={<Link to="/setup">{t('cycle.goToSetup')}</Link>}
              style={{ marginBottom: 12 }}
            />
          )}
          {autoConfig?.enabled ?? true ? (
            <Alert
              type="info"
              showIcon
              icon={<RobotOutlined />}
              message={t('cycle.autoFirstRun')}
              action={
                <Button
                  size="small"
                  disabled={!canUpdateSetup}
                  loading={generateMutation.isPending}
                  onClick={() => generateMutation.mutate()}
                >
                  {t('cycle.generateNow')}
                </Button>
              }
            />
          ) : (
            <Button
              type="primary"
              disabled={!canUpdateSetup}
              loading={generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
            >
              {t('cycle.generate')}
            </Button>
          )}
        </>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        width={620}
        title={
          storeName
            ? t('cycle.drawerTitleWithStore', { store: storeName, period: cycle.periodLabel })
            : t('cycle.planTitle', { period: cycle.periodLabel })
        }
      >
        {!generated ? (
          <Empty description={t('cycle.empty')} />
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              icon={<QuestionCircleOutlined />}
              message={t('cycle.diagnosis')}
              description={t('cycle.diagnosisText', {
                period: cycle.periodLabel,
                metric: t(`goal.metric_${cycle.diagnosis.metric}`),
                pct: String(cycle.diagnosis.gapPct),
                priority: t(`goal.priority_${cycle.diagnosis.priority}`),
              })}
              style={{ marginBottom: 16 }}
            />

            {cycle.guardSnapshot && (
              <div style={{ marginBottom: 12 }}>
                <Space size={6} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('cycle.guardSnapshotLabel')}
                  </Typography.Text>
                  <Tag>{t('cycle.guardMargin', { value: String(cycle.guardSnapshot.minGrossMargin) })}</Tag>
                  <Tag>{t('cycle.guardDiscount', { value: String(cycle.guardSnapshot.maxDiscountPct) })}</Tag>
                  <Tag>
                    {t('cycle.guardBudget', { value: formatMoney(cycle.guardSnapshot.monthlyBudgetCap) })}
                  </Tag>
                </Space>
                {guardChanged && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={t('cycle.guardChanged')}
                    action={
                      <Button
                        size="small"
                        loading={generateMutation.isPending}
                        disabled={!canUpdateSetup}
                        onClick={() => generateMutation.mutate()}
                      >
                        {t('cycle.regenerate')}
                      </Button>
                    }
                  />
                )}
              </div>
            )}

            <Typography.Title level={5}>{t('cycle.planTitle', { period: cycle.periodLabel })}</Typography.Title>
            {cycle.proposals.length === 0 ? (
              !hasBusinessAgent ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t('cycle.noBusinessAgentHint')}
                  action={<Link to="/setup">{t('cycle.goToSetup')}</Link>}
                />
              ) : (
                <Empty description={t('cycle.noProposals')} />
              )
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {cycle.proposals.map(proposalRow)}
              </div>
            )}

            <Divider />
            <Typography.Title level={5}>{t('cycle.collabTitle')}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {t('cycle.collabNote')}
            </Typography.Paragraph>
            {cycle.collaborations.length === 0 ? (
              <Typography.Text type="secondary">{t('cycle.collabEmpty')}</Typography.Text>
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {cycle.collaborations.map(collaborationRow)}
              </Space>
            )}

            <Divider />
            <Typography.Title level={5}>{t('cycle.conflictTitle')}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {t('cycle.arbitrationHint')}
            </Typography.Paragraph>
            {undecidedConflicts.length > 0 && (
              <Space align="center" wrap style={{ marginBottom: 10 }}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  loading={upholdAllMutation.isPending}
                  disabled={!canUpdateSetup}
                  onClick={() => upholdAllMutation.mutate()}
                >
                  {t('cycle.upholdAll', { count: String(undecidedConflicts.length) })}
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('cycle.upholdAllHint')}
                </Typography.Text>
              </Space>
            )}
            {cycle.conflicts.length === 0 ? (
              <Typography.Text type="secondary">{t('cycle.noConflict')}</Typography.Text>
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {cycle.conflicts.map((conflict) => {
                  const ruleDirection =
                    conflict.type === 'direction' && conflict.decision === 'override'
                      ? proposalById(conflict.winnerProposalId)?.action === 'increase_discount' ||
                        proposalById(conflict.winnerProposalId)?.action === 'clear_stock'
                        ? 'discount'
                        : 'raise'
                      : undefined;
                  return (
                    <ConflictArbitrationRow
                      key={conflict.id}
                      conflict={conflict}
                      description={conflictDescription(conflict)}
                      agentTypes={conflictAgentTypes(conflict)}
                      recommendation={recommendationFor(conflict)}
                      overridePreview={overridePreviewFor(conflict)}
                      ruleDirection={ruleDirection}
                      canDecide={canUpdateSetup}
                      deciding={
                        decideMutation.isPending &&
                        decideMutation.variables?.conflictId === conflict.id
                      }
                      highlighted={Boolean(
                        focusEscalationId?.startsWith(`cycle-esc-${cycle.id}-`) &&
                          focusEscalationId.endsWith(`-${conflict.id}`),
                      )}
                      t={t}
                      onDecide={(decision, reason, note, submitAfterOverride) =>
                        decideMutation.mutate({
                          conflictId: conflict.id,
                          decision,
                          reason,
                          note,
                          submitAfterOverride,
                        })
                      }
                    />
                  );
                })}
              </Space>
            )}

            <Divider />
            <Typography.Title level={5}>{t('cycle.outcomeTitle')}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {t('cycle.outcomeDesc')}
            </Typography.Paragraph>
            {cycle.outcomes.length === 0 ? (
              <Typography.Text type="secondary">{t('cycle.outcomeEmpty')}</Typography.Text>
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {cycle.outcomes.map(outcomeRow)}
              </Space>
            )}
          </>
        )}
      </Drawer>
    </Card>
  );
}
