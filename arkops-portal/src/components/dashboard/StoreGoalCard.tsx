/**
 * File: StoreGoalCard.tsx
 * Purpose: P1 店铺目标卡 — 让 Dashboard 回答「这家店今年要什么」。
 *
 * 目标挂在店铺上而不是任务上：Agent 的每个动作都应当能对回一个 Goal。
 * 中小商家默认使用通用型模板，无需配置即可看到目标与护栏。
 */
import { AimOutlined, CalendarOutlined, EditOutlined, HistoryOutlined, RiseOutlined, RobotOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Drawer, Input, InputNumber, Modal, Progress, Row, Select, Space, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { diffGuards, operatingModelApi, type GoalProposal } from '../../api/operatingModel';
import { orchestratorApi, type GuardHealthItem, type GuardHealthKey } from '../../api/orchestrator';
import { useAuth } from '../../app/auth';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import type { GoalMetric, GoalPriority, StoreGoal } from '../../types/domain';
import { invalidateOperatingModelQueries } from '../../utils/operatingModelQueries';

interface StoreGoalCardProps {
  /** 未指定时取当前店铺作用域；都为空则不渲染 */
  storeId?: number;
  /** P43.1：店名只用于标明这张卡改的是谁，全部店铺范围下尤其必要 */
  storeName?: string;
  /** P43.1：全部店铺范围下，这张卡并非账户目标，需就地说明并给出跳转 */
  scopeAllStores?: boolean;
}

const METRICS: GoalMetric[] = ['gmv', 'gross_profit', 'inventory_turnover', 'cs_sla'];
const PRIORITIES: GoalPriority[] = ['growth', 'profit', 'clearance'];
const GUARD_LABEL_KEYS: Record<GuardHealthKey, string> = {
  minGrossMargin: 'goal.minGrossMargin',
  maxDiscountPct: 'goal.maxDiscount',
  monthlyBudgetCap: 'goal.monthlyBudgetCap',
};

function formatGoalValue(metric: GoalMetric, value: number) {
  if (metric === 'gmv' || metric === 'gross_profit') return `¥${new Intl.NumberFormat('zh-CN').format(value)}`;
  if (metric === 'inventory_turnover') return `${value}`;
  return `${value}h`;
}

/** P29.1：提议里的金额统一按人民币展示。 */
function formatMoney(value: number) {
  return `¥${new Intl.NumberFormat('zh-CN').format(Math.round(value))}`;
}

/** P29.4：预演金额带方向，让人一眼看出这次改护栏是赚还是亏。 */
function signedMoney(value: number) {
  return `${value >= 0 ? '+' : '−'}${formatMoney(Math.abs(value))}`;
}

/** P32.2：建议值与护栏同单位——毛利 / 折扣是百分点，预算是金额。 */
function formatGuardValue(key: GuardHealthKey, value: number) {
  return key === 'monthlyBudgetCap' ? formatMoney(value) : `${value}%`;
}

export function StoreGoalCard({ storeId, storeName, scopeAllStores }: StoreGoalCardProps) {
  const { t } = useI18n();
  const { can } = usePermission();
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StoreGoal | null>(null);
  const [reason, setReason] = useState('');
  /** P47：本次护栏改动临时生效的天数；0 表示长期生效。 */
  const [expiryDays, setExpiryDays] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** P32.1：护栏体检抽屉——只读说明每条护栏现在是否真的在约束 Agent。 */
  const [healthOpen, setHealthOpen] = useState(false);
  /** P29.1：Agent 目标提议仅在点击后拉取，避免每次打开面板都算一遍。 */
  const [proposal, setProposal] = useState<GoalProposal | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);

  const { data: goal } = useQuery({
    queryKey: ['storeGoal', storeId],
    queryFn: () => operatingModelApi.getGoal(storeId!),
    enabled: Boolean(storeId),
  });

  /** 护栏变更记录读审计流水，不在卡片里另存一份。 */
  const { data: guardChanges = [] } = useQuery({
    queryKey: ['guardChanges', storeId],
    queryFn: () => operatingModelApi.listGuardChanges(storeId!),
    enabled: Boolean(storeId),
  });

  /** P32.1：体检读近 7 天拦截与本轮动作，只读；保存护栏后需要重算。 */
  const { data: guardHealth } = useQuery({
    queryKey: ['guardHealth', storeId],
    queryFn: () => orchestratorApi.getGuardHealth(storeId!),
    enabled: Boolean(storeId),
  });

  /** P29.2 节奏预测：与目标提议同一套经营基线，回答「按当前速度哪天达成、差几天」。 */
  const { data: pace } = useQuery({
    queryKey: ['goalPace', storeId],
    queryFn: () => operatingModelApi.getGoalPace(storeId!),
    enabled: Boolean(storeId),
  });
  /** 升级项是否仍未处理；人处理过之后不再显示「已升级」。 */
  const [paceEscalationOpen, setPaceEscalationOpen] = useState(false);

  /** P33.2 目标周期：跨月后先结算上期再顺延，旧目标不会带着旧进度静默沿用。 */
  const { data: goalPeriod } = useQuery({
    queryKey: ['goalPeriod', storeId],
    queryFn: () => operatingModelApi.getGoalPeriod(storeId!),
    enabled: Boolean(storeId),
  });

  useEffect(() => {
    if (!storeId || !goalPeriod?.rolledOver) return;
    let cancelled = false;
    operatingModelApi
      .settleGoalPeriod(storeId)
      .then((result) => {
        if (cancelled || !result.settled) return;
        queryClient.invalidateQueries({ queryKey: ['storeGoal', storeId] });
        queryClient.invalidateQueries({ queryKey: ['goalPeriod', storeId] });
        queryClient.invalidateQueries({ queryKey: ['goalPace', storeId] });
        queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storeId, goalPeriod?.rolledOver, goalPeriod?.periodKey, queryClient]);

  /**
   * P29.2：节奏一算出来就让 Agent 自检一次——缺口超过阈值直接推进待办中心，
   * 不需要人先发现、再手动登记。
   */
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    setPaceEscalationOpen(false);
    operatingModelApi
      .syncGoalPaceEscalation(storeId)
      .then((result) => {
        if (cancelled) return;
        setPaceEscalationOpen(result.open);
        if (result.escalated || result.closed > 0) {
          queryClient.invalidateQueries({ queryKey: ['exceptions'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storeId, pace?.status, pace?.gap, queryClient]);

  /**
   * P32.3：体检一算出来就让 Agent 自检一次——需要人表态的护栏直接推进待办，
   * 人只处理被点名的那几条；人确认后条件消失，下次同步自动收口。
   */
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    orchestratorApi
      .syncGuardEscalations(storeId)
      .then((result) => {
        if (cancelled || !result.changed) return;
        queryClient.invalidateQueries({ queryKey: ['exceptions'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storeId, guardHealth, queryClient]);

  const mutation = useMutation({
    mutationFn: (next: StoreGoal) =>
      operatingModelApi.saveGoal(
        next.storeId,
        {
          metric: next.metric,
          target: next.target,
          priority: next.priority,
          constraints: next.constraints,
        },
        // P28.2：旧值→新值、原因、确认人一起进审计，人不写原因就改不了护栏。
        // P47：带上临时期限，到期由 Agent 自动恢复原值。
        {
          reason,
          actor: user?.name ?? '当前用户',
          actorRole: role ?? undefined,
          expiresInDays: expiryDays || undefined,
        },
      ),
    onError: (error) => {
      message.error((error as Error).message);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['storeGoal', saved.storeId], saved);
      // P50：单店目标/护栏一改，同页账户级推导（建议、预算池、账户护栏）全部依赖它，统一失效。
      invalidateOperatingModelQueries(queryClient);
      setEditing(null);
      setReason('');
      setExpiryDays(0);
      message.success(t('goal.saved'));
      // 目标/护栏是仲裁输入：改完后立即让 Agent 按新约束重跑一轮，而不是等人再点“重新生成”。
      orchestratorApi
        .generateCycle(saved.storeId)
        .then((cycle) => {
          queryClient.setQueryData(['operatingCycle', saved.storeId], cycle);
          // P32.2：建议值跟本轮提案走，重跑后同步重算体检，别让人看到旧建议。
          queryClient.invalidateQueries({ queryKey: ['guardHealth', saved.storeId] });
          queryClient.invalidateQueries({ queryKey: ['exceptions'] });
          queryClient.invalidateQueries({ queryKey: ['approvals'] });
          queryClient.invalidateQueries({ queryKey: ['portfolio'] });
          message.info(t('goal.replanned'));
        })
        .catch(() => {
          // 自动重跑失败不阻塞保存，卡片上的“重新生成”仍可手动补跑。
        });
    },
  });

  /**
   * P45.1：护栏改错就地回到变更前。撤销本身仍是一次带原因的护栏变更，
   * 所以重跑一轮 Agent 让动作按恢复后的边界重排，而不是留着按放宽值生成的动作。
   */
  const revertMutation = useMutation({
    mutationFn: (auditLogId: number) =>
      operatingModelApi.revertGuardChange(storeId!, auditLogId, {
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
      }),
    onError: (error) => {
      message.error((error as Error).message);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['storeGoal', saved.storeId], saved);
      invalidateOperatingModelQueries(queryClient);
      message.success(t('goal.guardReverted'));
      orchestratorApi
        .generateCycle(saved.storeId)
        .then((cycle) => {
          queryClient.setQueryData(['operatingCycle', saved.storeId], cycle);
          queryClient.invalidateQueries({ queryKey: ['guardHealth', saved.storeId] });
        })
        .catch(() => undefined);
    },
  });

  /**
   * P29.1：Agent 给出建议，人只决定采不采。
   * 提议失败（无基线/非 GMV 目标）时明确告知，不用假数字兜底。
   */
  const proposalMutation = useMutation({
    mutationFn: () => operatingModelApi.proposeGoal(storeId!),
    onSuccess: (result) => {
      if (!result) {
        message.warning(t('goal.proposal.unavailable'));
        return;
      }
      setProposal(result);
      setProposalOpen(true);
    },
    onError: (error) => {
      message.error((error as Error).message);
    },
  });

  const adoptMutation = useMutation({
    mutationFn: (next: GoalProposal) =>
      operatingModelApi.adoptGoalProposal(next, {
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
      }),
    onError: (error) => {
      message.error((error as Error).message);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['storeGoal', saved.storeId], saved);
      invalidateOperatingModelQueries(queryClient);
      setProposalOpen(false);
      setProposal(null);
      message.success(t('goal.proposal.adopted'));
      // 目标变了，Agent 需要按新目标立刻重跑一轮；失败不阻塞采纳结果。
      orchestratorApi
        .generateCycle(saved.storeId)
        .then((cycle) => {
          queryClient.setQueryData(['operatingCycle', saved.storeId], cycle);
          // P32.2：建议值跟本轮提案走，重跑后同步重算体检，别让人看到旧建议。
          queryClient.invalidateQueries({ queryKey: ['guardHealth', saved.storeId] });
          queryClient.invalidateQueries({ queryKey: ['exceptions'] });
          queryClient.invalidateQueries({ queryKey: ['approvals'] });
          queryClient.invalidateQueries({ queryKey: ['portfolio'] });
        })
        .catch(() => undefined);
    },
  });

  /**
   * P29.4 护栏影响预演：只在护栏真的被改动后拉取，打开弹窗不产生额外推演。
   * 预演只读，人可以反复调数看影响，再决定是否保存。
   */
  const pendingGuardChanges = goal && editing ? diffGuards(goal.constraints, editing.constraints) : [];
  const { data: guardImpact } = useQuery({
    queryKey: [
      'guardImpact',
      storeId,
      editing?.constraints.minGrossMargin,
      editing?.constraints.maxDiscountPct,
      editing?.constraints.monthlyBudgetCap,
    ],
    queryFn: () => orchestratorApi.previewGuardImpact(storeId!, editing!.constraints),
    enabled: Boolean(storeId && editing && pendingGuardChanges.length > 0),
  });

  if (!storeId || !goal) return null;
  const percent = goal.target > 0 ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
  const canEdit = can('setup', 'update');
  const latestChange = guardChanges[0];

  // P32.1：同一份体检结果同时用于标签配色、摘要行与抽屉，避免三处口径不一致。
  const guardItem = (key: GuardHealthKey) =>
    guardHealth?.items.find((item) => item.key === key);
  const guardTagColor = (key: GuardHealthKey) => {
    const verdict = guardItem(key)?.verdict;
    if (verdict === 'binding') return 'orange';
    if (verdict === 'close') return 'blue';
    return undefined;
  };
  const guardLabel = (key: GuardHealthKey) => t(GUARD_LABEL_KEYS[key]);
  const healthSummary = (() => {
    if (!guardHealth) return null;
    const binding = guardHealth.items.find((item) => item.verdict === 'binding');
    if (binding) {
      return t('goal.health.summaryBinding', {
        guard: guardLabel(binding.key),
        count: binding.blocks7d,
      });
    }
    const close = guardHealth.items.find((item) => item.verdict === 'close');
    if (close) {
      return t('goal.health.summaryClose', {
        guard: guardLabel(close.key),
        headroom: close.headroom ?? 0,
      });
    }
    const idle = guardHealth.items.find((item) => item.verdict === 'idle');
    if (idle) {
      return t('goal.health.summaryIdle', {
        guard: guardLabel(idle.key),
        headroom: idle.headroom ?? 0,
      });
    }
    return t('goal.health.summaryNone');
  })();
  const guardBasis = (item: GuardHealthItem) => {
    if (item.key === 'monthlyBudgetCap') {
      return t('goal.health.basisBudget', {
        pool: formatMoney(item.nearest ?? 0),
        cap: formatMoney(item.current),
      });
    }
    if (item.nearest === null || item.headroom === null) return null;
    return item.key === 'minGrossMargin'
      ? t('goal.health.basisMargin', { nearest: item.nearest, headroom: item.headroom })
      : t('goal.health.basisDiscount', { nearest: item.nearest, headroom: item.headroom });
  };

  // P32.2：建议值与体检结论同一份数据；人只需认可或否掉一个数，不再自己反推该调多少。
  const adviceCount = guardHealth?.items.filter((item) => item.advice.suggested !== null).length ?? 0;
  const adviceText = (item: GuardHealthItem) => {
    const { advice } = item;
    return t(`goal.advice.${advice.basis}`, {
      guard: guardLabel(item.key),
      current: formatGuardValue(item.key, item.current),
      from: formatGuardValue(item.key, item.current),
      to: advice.suggested === null ? '—' : formatGuardValue(item.key, advice.suggested),
      count: advice.blockedActions,
      anchor: advice.anchor === undefined ? '—' : formatGuardValue(item.key, advice.anchor),
      pool: formatGuardValue('monthlyBudgetCap', advice.poolLimit ?? 0),
      headroom: Math.max(0, item.headroom ?? 0),
    });
  };
  const adviceEffectText = (item: GuardHealthItem) => {
    const effect = item.advice.effect;
    if (!effect) return null;
    if (effect.unlocked > 0) {
      return t('goal.advice.effectUnlock', {
        count: effect.unlocked,
        gmv: signedMoney(effect.gmvDelta),
        profit: signedMoney(effect.grossProfitDelta),
      });
    }
    return t('goal.advice.effectBlock', {
      count: effect.blocked,
      gmv: signedMoney(effect.gmvDelta),
    });
  };
  /** 建议值只做预填：仍走原来的改护栏弹窗，原因与影响预演一个都不能少。 */
  const applyAdvice = (item: GuardHealthItem) => {
    const suggested = item.advice.suggested;
    if (suggested === null) return;
    setHealthOpen(false);
    setReason('');
    setExpiryDays(0);
    setEditing({
      ...goal,
      constraints: { ...goal.constraints, [item.key]: suggested },
    });
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space wrap size={6}>
          <AimOutlined style={{ color: 'var(--ark-blue)' }} />
          <Typography.Text strong>{t('goal.cardTitle')}</Typography.Text>
          {/* P43.1：全部店铺范围下数字默认落到第一家店，店名必须摆在标题上 */}
          {storeName ? <Tag color="geekblue">{storeName}</Tag> : null}
          <Tag color="blue">{t('goal.generalTemplate')}</Tag>
        </Space>
      }
      extra={
        <Space size={8}>
          <Button
            size="small"
            icon={<RobotOutlined />}
            loading={proposalMutation.isPending}
            onClick={() => proposalMutation.mutate()}
          >
            {t('goal.proposal.open')}
          </Button>
          {canEdit ? (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setReason('');
                setExpiryDays(0);
                setEditing(goal);
              }}
            >
              {t('goal.edit')}
            </Button>
          ) : null}
        </Space>
      }
    >
      {scopeAllStores ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('goal.scopeAllHint', { store: storeName ?? t('goal.scopeAllHintStore') })}
          action={
            <Button
              size="small"
              type="link"
              style={{ paddingInline: 4 }}
              onClick={() =>
                document
                  .getElementById('portfolio-goals-card')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {t('goal.scopeAllJump')}
            </Button>
          }
        />
      ) : null}
      <Row gutter={[24, 12]} align="middle">
        <Col xs={24} md={10}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space size={6}>
              <Tag color="geekblue">{t(`goal.horizon_${goal.horizon}`)} {t(`goal.metric_${goal.metric}`)}</Tag>
              <Tag>{t('goal.period.owner', { month: goal.periodKey })}</Tag>
              <Typography.Text strong>
                {formatGoalValue(goal.metric, goal.current)} / {formatGoalValue(goal.metric, goal.target)}
              </Typography.Text>
            </Space>
            <Progress percent={percent} strokeColor="var(--ark-blue)" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('goal.progress', { percent })}
            </Typography.Text>
            {/* P33.2：跨月后上期结算结果留在目标上，人不用自己对账「上个月到底达成了没有」。 */}
            {goal.lastSettlement && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <CalendarOutlined style={{ marginRight: 4 }} />
                {goal.lastSettlement.verdict === 'unknown' || goal.lastSettlement.actualGmv === null
                  ? t('goal.period.unknown', { month: goal.lastSettlement.periodKey })
                  : t('goal.period.settled', {
                      month: goal.lastSettlement.periodKey,
                      target: formatMoney(goal.lastSettlement.target),
                      actual: formatMoney(goal.lastSettlement.actualGmv),
                      percent: `${Math.round((goal.lastSettlement.achievedPct ?? 0) * 100)}`,
                    })}
                {goal.lastSettlement.verdict === 'missed' && (
                  <Tag color="orange" style={{ marginLeft: 6 }}>
                    {t('goal.period.missed')}
                  </Tag>
                )}
              </Typography.Text>
            )}
            {pace && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <RiseOutlined style={{ marginRight: 4 }} />
                  {t('goal.pace.runRate', { value: formatMoney(pace.runRate) })} ·{' '}
                  {t('goal.pace.projection', {
                    value: formatMoney(pace.projectedMonthEnd),
                    percent: `${pace.target > 0 ? Math.round((pace.projectedMonthEnd / pace.target) * 100) : 0}`,
                  })}
                  {pace.projectedDate
                    ? ` · ${t('goal.pace.date', { date: dayjs(pace.projectedDate).format('MM-DD') })}`
                    : ''}
                </Typography.Text>
                <Space size={6} wrap style={{ display: 'flex', marginTop: 2 }}>
                  {pace.status === 'achieved' ? (
                    <Tag color="green" style={{ margin: 0 }}>
                      {t('goal.pace.achieved')}
                    </Tag>
                  ) : pace.status === 'on_track' ? (
                    <Tag color="blue" style={{ margin: 0 }}>
                      {t('goal.pace.onTrack')}
                    </Tag>
                  ) : (
                    <Tag color="orange" style={{ margin: 0 }}>
                      {t('goal.pace.behind', { days: Math.abs(pace.daysVsMonthEnd ?? 0) })}
                    </Tag>
                  )}
                  {paceEscalationOpen && (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {t('goal.pace.escalated', { percent: pace.alertThresholdPct })}
                      <Link to="/inbox?type=exception" style={{ marginLeft: 6 }}>
                        {t('goal.pace.openInbox')}
                      </Link>
                    </Typography.Text>
                  )}
                </Space>
              </div>
            )}
          </Space>
        </Col>
        <Col xs={24} md={14}>
          <Space size={[8, 8]} wrap>
            <Tag color="purple">
              {t('goal.priorityLabel')}: {t(`goal.priority_${goal.priority}`)}
            </Tag>
            {(Object.keys(GUARD_LABEL_KEYS) as GuardHealthKey[]).map((key) => (
              <Space key={key} size={4} wrap>
                <Tag color={guardTagColor(key)}>
                  {key === 'minGrossMargin'
                    ? `${t('goal.minGrossMargin')} ≥ ${goal.constraints.minGrossMargin}%`
                    : key === 'maxDiscountPct'
                      ? `${t('goal.maxDiscount')} ≤ ${goal.constraints.maxDiscountPct}%`
                      : `${t('goal.monthlyBudgetCap')} ≤ ${formatGuardValue(key, goal.constraints.monthlyBudgetCap)}`}
                </Tag>
                {/* P47：临时放宽必须显式到期，人不用记「哪天该收」。 */}
                {goal.guardExpiries?.[key] && (
                  <Tag color="gold" style={{ margin: 0 }}>
                    {t('goal.guardTemporaryTag', {
                      time: dayjs(goal.guardExpiries[key]!.until).format('MM-DD HH:mm'),
                    })}
                  </Tag>
                )}
              </Space>
            ))}
          </Space>
          {guardHealth && (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              <SafetyCertificateOutlined style={{ marginRight: 4 }} />
              {guardHealth.unconfirmed
                ? t('goal.health.unconfirmed')
                : t('goal.health.confirmed', { count: guardChanges.length })}
              {healthSummary ? ` · ${healthSummary}` : ''}
              {adviceCount > 0 ? ` · ${t('goal.advice.hint', { count: adviceCount })}` : ''}
              <Button type="link" size="small" onClick={() => setHealthOpen(true)}>
                {t('goal.health.open')}
              </Button>
            </Typography.Text>
          )}
        </Col>
      </Row>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10, fontSize: 12 }}>
        <RobotOutlined style={{ marginRight: 4 }} />
        {t('goal.agentBasis')}
        {/* S4：目标/护栏与 Agent 行为要能互相跳转，而不是各说各话 */}
        <Link to="/setup" style={{ marginLeft: 8 }}>
          {t('goal.adjustGuardrails')}
        </Link>
      </Typography.Text>

      {latestChange && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
          <HistoryOutlined style={{ marginRight: 4 }} />
          {t('goal.lastGuardChange', {
            time: dayjs(latestChange.at).format('MM-DD HH:mm'),
            actor: latestChange.actor,
          })}
          <Button type="link" size="small" onClick={() => setHistoryOpen(true)}>
            {t('goal.guardChangeHistory')} ({guardChanges.length})
          </Button>
        </Typography.Text>
      )}

      <Modal
        open={historyOpen}
        title={t('goal.guardChangeHistory')}
        footer={null}
        onCancel={() => setHistoryOpen(false)}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {guardChanges.map((change) => {
            const guardChange = change.guardChanges?.[0];
            // P45.1：只有「这条变更的值现在仍然生效」才允许撤销，否则会覆盖后来的人为调整。
            // P47：Agent 到期恢复不是人的决定，不提供「撤销恢复」（否则又会把放宽值放回去）。
            const reversible = change.action === '变更护栏';
            const stillEffective = Boolean(
              guardChange && goal && goal.constraints[guardChange.field] === guardChange.to,
            );
            return (
              <div key={change.id}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {dayjs(change.at).format('YYYY-MM-DD HH:mm')} · {change.actor}
                </Typography.Text>
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {change.summary}
                  {canEdit && guardChange && goal && reversible && (
                    stillEffective ? (
                      <Button
                        type="link"
                        size="small"
                        style={{ paddingInline: 6, height: 20 }}
                        loading={revertMutation.isPending}
                        onClick={() => revertMutation.mutate(change.id)}
                      >
                        {t('goal.guardRevert', { value: formatGuardValue(guardChange.field, guardChange.from) })}
                      </Button>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('goal.guardRevertStale')}
                      </Typography.Text>
                    )
                  )}
                </Typography.Paragraph>
              </div>
            );
          })}
        </Space>
      </Modal>

      <Drawer
        open={healthOpen}
        title={t('goal.health.title')}
        width={420}
        onClose={() => setHealthOpen(false)}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('goal.health.intro', { days: guardHealth?.windowDays ?? 7 })}
        </Typography.Text>
        <Space direction="vertical" size={14} style={{ width: '100%', marginTop: 12 }}>
          {(guardHealth?.items ?? []).map((item) => (
            <div key={item.key}>
              <Space size={6} wrap>
                <Typography.Text strong>{guardLabel(item.key)}</Typography.Text>
                <Typography.Text type="secondary">
                  {item.key === 'monthlyBudgetCap'
                    ? `≤ ${formatMoney(item.current)}`
                    : item.key === 'minGrossMargin'
                      ? `≥ ${item.current}%`
                      : `≤ ${item.current}%`}
                </Typography.Text>
                <Tag color={guardTagColor(item.key)} style={{ margin: 0 }}>
                  {t(`goal.health.verdict_${item.verdict}`)}
                </Tag>
              </Space>
              {guardBasis(item) && (
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                  {guardBasis(item)}
                </Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {item.blocks7d > 0
                  ? t('goal.health.blocks', { days: guardHealth?.windowDays ?? 7, count: item.blocks7d })
                  : t('goal.health.noBlocks', { days: guardHealth?.windowDays ?? 7 })}
              </Typography.Text>
              {/* P47：体检要能看出这条是临时放宽，以及到期后由 Agent 收回成什么值。 */}
              {item.expiry && (
                <Typography.Text style={{ display: 'block', fontSize: 12, color: 'var(--ark-orange)' }}>
                  {t('goal.health.temporary', {
                    time: dayjs(item.expiry.until).format('MM-DD HH:mm'),
                    value: formatGuardValue(item.key, item.expiry.baseValue),
                  })}
                </Typography.Text>
              )}
              {/* P32.2：Agent 给建议值 + 依据 + 预演后果；人只决定要不要带入。 */}
              <Space size={6} wrap style={{ marginTop: 2 }}>
                <Typography.Text
                  style={{ fontSize: 12, color: item.advice.suggested === null ? undefined : 'var(--ark-blue)' }}
                  type={item.advice.suggested === null ? 'secondary' : undefined}
                >
                  <RobotOutlined style={{ marginRight: 4 }} />
                  {adviceText(item)}
                </Typography.Text>
                {item.advice.effect && (
                  <Tag
                    color={(item.advice.effect.gmvDelta ?? 0) >= 0 ? 'green' : 'orange'}
                    style={{ margin: 0 }}
                  >
                    {adviceEffectText(item)}
                  </Tag>
                )}
                {canEdit && item.advice.suggested !== null && (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 18 }}
                    onClick={() => applyAdvice(item)}
                  >
                    {t('goal.advice.apply')}
                  </Button>
                )}
              </Space>
            </div>
          ))}
        </Space>
        {guardHealth && (
          <>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 6, fontSize: 12 }}>
              {t('goal.health.floors', {
                price: guardHealth.systemFloors.maxPriceChangePct,
                refund: formatMoney(guardHealth.systemFloors.autoRefundCap),
              })}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {guardHealth.unconfirmed
                ? t('goal.health.sourceTemplate')
                : t('goal.health.sourceConfirmed', {
                    time: guardHealth.lastChangeAt
                      ? dayjs(guardHealth.lastChangeAt).format('YYYY-MM-DD')
                      : '—',
                  })}
            </Typography.Paragraph>
          </>
        )}
      </Drawer>

      <Modal
        open={Boolean(editing)}
        title={t('goal.editTitle')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={mutation.isPending}
        okButtonProps={{ disabled: pendingGuardChanges.length > 0 && !reason.trim() }}
        onCancel={() => {
          setEditing(null);
          setExpiryDays(0);
        }}
        onOk={() => editing && mutation.mutate(editing)}
        destroyOnClose
      >
        {editing && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">{t('goal.metric')}</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={editing.metric}
                onChange={(metric) => setEditing({ ...editing, metric })}
                options={METRICS.map((metric) => ({ value: metric, label: t(`goal.metric_${metric}`) }))}
              />
            </div>
            <div>
              <Typography.Text type="secondary">{t('goal.target')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 4 }}
                min={0}
                value={editing.target}
                onChange={(target) => setEditing({ ...editing, target: target ?? 0 })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">{t('goal.priorityLabel')}</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={editing.priority}
                onChange={(priority) => setEditing({ ...editing, priority })}
                options={PRIORITIES.map((priority) => ({ value: priority, label: t(`goal.priority_${priority}`) }))}
              />
            </div>
            <Row gutter={8}>
              <Col span={8}>
                <Typography.Text type="secondary">{t('goal.minGrossMargin')}</Typography.Text>
                <InputNumber
                  style={{ width: '100%', marginTop: 4 }}
                  min={0}
                  max={100}
                  addonAfter="%"
                  value={editing.constraints.minGrossMargin}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      constraints: { ...editing.constraints, minGrossMargin: value ?? 0 },
                    })
                  }
                />
              </Col>
              <Col span={8}>
                <Typography.Text type="secondary">{t('goal.maxDiscount')}</Typography.Text>
                <InputNumber
                  style={{ width: '100%', marginTop: 4 }}
                  min={0}
                  max={100}
                  addonAfter="%"
                  value={editing.constraints.maxDiscountPct}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      constraints: { ...editing.constraints, maxDiscountPct: value ?? 0 },
                    })
                  }
                />
              </Col>
              <Col span={8}>
                <Typography.Text type="secondary">{t('goal.monthlyBudgetCap')}</Typography.Text>
                <InputNumber
                  style={{ width: '100%', marginTop: 4 }}
                  min={0}
                  prefix="¥"
                  value={editing.constraints.monthlyBudgetCap}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      constraints: { ...editing.constraints, monthlyBudgetCap: value ?? 0 },
                    })
                  }
                />
              </Col>
            </Row>
            {pendingGuardChanges.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('goal.guardChangeTitle')}
                description={
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Typography.Text style={{ fontSize: 12 }}>{t('goal.guardChangeHint')}</Typography.Text>
                    <Space size={[8, 4]} wrap>
                      {pendingGuardChanges.map((change) => (
                        <Tag key={change.field} color="orange">
                          {change.label} {change.from} → {change.to}
                        </Tag>
                      ))}
                    </Space>
                    {guardImpact && (
                      <div
                        style={{
                          // 影响预估是橙色虚线提示框：底色走面板色、描边由 --ark-orange 混出，暗色下不再是白底。
                          background: 'var(--ark-panel)',
                          border: '1px dashed color-mix(in srgb, var(--ark-orange) 45%, var(--ark-panel))',
                          borderRadius: 6,
                          padding: '8px 10px',
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 12 }}>
                          {t('goal.impact.title')}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                          {guardImpact.pastBlocks.total > 0
                            ? t('goal.impact.past', {
                                days: guardImpact.windowDays,
                                total: guardImpact.pastBlocks.total,
                                margin: guardImpact.pastBlocks.margin,
                                discount: guardImpact.pastBlocks.discount,
                                budget: guardImpact.pastBlocks.budget,
                              })
                            : t('goal.impact.pastZero', { days: guardImpact.windowDays })}
                        </Typography.Text>
                        {guardImpact.hasCycle ? (
                          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                            {guardImpact.unlocked.length === 0 && guardImpact.blocked.length === 0 ? (
                              t('goal.impact.none')
                            ) : (
                              <>
                                {guardImpact.unlocked.length > 0
                                  ? `${t('goal.impact.unlock', { count: guardImpact.unlocked.length })} `
                                  : ''}
                                {guardImpact.blocked.length > 0
                                  ? `${t('goal.impact.block', { count: guardImpact.blocked.length })} `
                                  : ''}
                                {t('goal.impact.delta', {
                                  gmv: signedMoney(guardImpact.gmvDelta),
                                  profit: signedMoney(guardImpact.grossProfitDelta),
                                })}
                              </>
                            )}
                          </Typography.Text>
                        ) : (
                          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                            {t('goal.impact.noCycle')}
                          </Typography.Text>
                        )}
                        {(guardImpact.unlocked.length > 0 || guardImpact.blocked.length > 0) && (
                          <Space size={[6, 4]} wrap style={{ marginTop: 6 }}>
                            {[
                              ...guardImpact.unlocked.map((item) => ({ ...item, direction: 'unlock' as const })),
                              ...guardImpact.blocked.map((item) => ({ ...item, direction: 'block' as const })),
                            ].map((item) => (
                              <Tag
                                key={`${item.direction}-${item.proposalId}`}
                                color={item.direction === 'unlock' ? 'green' : 'red'}
                                style={{ margin: 0 }}
                              >
                                {t(
                                  item.direction === 'unlock'
                                    ? 'goal.impact.tagUnlock'
                                    : 'goal.impact.tagBlock',
                                )}{' '}
                                · {item.targetLabel}（{t(`goal.impact.reason_${item.reason}`)}）
                              </Tag>
                            ))}
                          </Space>
                        )}
                        <Typography.Text
                          type="secondary"
                          style={{ display: 'block', fontSize: 11, marginTop: 4 }}
                        >
                          {t('goal.impact.basis')}
                        </Typography.Text>
                      </div>
                    )}
                    {/* P47：临时放宽说清「放到哪天」，到期由 Agent 收回，人不靠记忆。 */}
                    <div>
                      <Typography.Text type="secondary">{t('goal.guardDurationLabel')}</Typography.Text>
                      <Select
                        style={{ width: '100%', marginTop: 4 }}
                        value={expiryDays}
                        onChange={setExpiryDays}
                        options={[0, 1, 3, 7, 14, 30].map((days) => ({
                          value: days,
                          label:
                            days === 0
                              ? t('goal.guardDurationLong')
                              : t('goal.guardDurationDays', { days }),
                        }))}
                      />
                      {expiryDays > 0 && (
                        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                          {t('goal.guardDurationHint', {
                            time: dayjs().add(expiryDays, 'day').endOf('day').format('MM-DD HH:mm'),
                            values: pendingGuardChanges.map((change) => `${change.label} ${change.from}`).join('、'),
                          })}
                        </Typography.Text>
                      )}
                    </div>
                    <Input.TextArea
                      rows={2}
                      maxLength={120}
                      value={reason}
                      placeholder={t('goal.guardChangeReasonPlaceholder')}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('goal.guardChangeConfirm', { actor: `${user?.name ?? '当前用户'}${role ? `（${role}）` : ''}` })}
                    </Typography.Text>
                  </Space>
                }
              />
            )}
          </Space>
        )}
      </Modal>
      <Modal
        open={proposalOpen && Boolean(proposal)}
        title={t('goal.proposal.title')}
        width={600}
        onCancel={() => setProposalOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setProposalOpen(false)}>{t('common.cancel')}</Button>
            {canEdit && proposal ? (
              <Button
                type="primary"
                loading={adoptMutation.isPending}
                onClick={() => adoptMutation.mutate(proposal)}
              >
                {t('goal.proposal.adopt', { value: formatMoney(proposal.suggestedTarget) })}
              </Button>
            ) : null}
          </Space>
        }
      >
        {proposal && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type={proposal.verdict === 'over' ? 'success' : proposal.verdict === 'on_track' ? 'info' : 'warning'}
              showIcon
              message={t(`goal.proposal.verdict_${proposal.verdict}`)}
              description={t(`goal.proposal.desc_${proposal.verdict}`, {
                projected: formatMoney(proposal.projectedMonthGmv),
                percent: `${Math.round(proposal.achievedPct * 100)}%`,
                gap: formatMoney(proposal.gap),
                budget: formatMoney(proposal.requiredBudget),
                suggested: formatMoney(proposal.suggestedTarget),
              })}
            />
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('goal.proposal.basis')}
              </Typography.Text>
              <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 4 }}>
                <Typography.Text style={{ fontSize: 12 }}>
                  {t('goal.proposal.last30')}：{formatMoney(proposal.last30Gmv)} · {t('goal.proposal.prev30')}{' '}
                  {formatMoney(proposal.previous30Gmv)}（
                  {proposal.previous30Gmv > 0
                    ? `${(((proposal.last30Gmv - proposal.previous30Gmv) / proposal.previous30Gmv) * 100).toFixed(1)}%`
                    : '—'}
                  ）
                </Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>
                  {t('goal.proposal.mtd', { day: proposal.monthDay, days: proposal.daysInMonth })}
                  {formatMoney(proposal.mtdGmv)} · {t('goal.proposal.daily')} {formatMoney(proposal.dailyAvg)}
                </Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>
                  {t('goal.proposal.range')}：{formatMoney(proposal.reachableLow)} – {formatMoney(proposal.reachableHigh)} ·{' '}
                  {t('goal.proposal.rangeHint')}
                </Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>
                  {t('goal.proposal.budget')}：
                  {proposal.gap > 0
                    ? `${formatMoney(proposal.requiredBudget)} · ${t('goal.proposal.roas', { value: proposal.roas })}`
                    : t('goal.proposal.noGap')}
                </Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>
                  {t('goal.proposal.budgetRemaining')}：{formatMoney(proposal.remainingBudget)}{' '}
                  <Tag
                    color={
                      proposal.gap === 0 ? 'default' : proposal.budgetSufficient ? 'green' : 'red'
                    }
                  >
                    {proposal.gap === 0
                      ? proposal.remainingBudget > 0
                        ? t('goal.proposal.budgetNoNeed')
                        : t('goal.proposal.budgetExhausted')
                      : proposal.budgetSufficient
                        ? t('goal.proposal.budgetSufficient')
                        : t('goal.proposal.budgetInsufficient')}
                  </Tag>
                </Typography.Text>
              </Space>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('goal.proposal.note')}
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </Card>
  );
}
