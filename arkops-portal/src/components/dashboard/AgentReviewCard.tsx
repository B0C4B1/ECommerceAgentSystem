/**
 * File: AgentReviewCard.tsx
 * Purpose: P25 最近 7 天 Agent 复盘 — 人只设目标之后，仍要知道 Agent 干成了什么、亏在哪。
 * 数据来自归因账本（GoalOutcome）：已回写看实际影响，失败/超时看预期影响，待观察看 projected。
 * P31.1：补上「投入成本」与「人的介入成本」——只回答干成了什么还不够，
 * 人要继续放权前得先看到为这件事花了多少、自己被叫起来多少次。
 * P31.2：把这些数字收敛成一句「放权建议」——兑现率 / 失败率 / 改判率达到什么条件
 * 才该动 L1–L3，人不需要自己算；/setup 的信任累积使用同一份判断。
 */
import { BarChartOutlined, CheckCircleOutlined, ClockCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Drawer, Empty, List, Row, Segmented, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { agentsApi } from '../../api/agents';
import {
  AUTONOMY_ADVICE_WINDOW_DAYS,
  AUTONOMY_MIN_DECIDED,
  buildAutonomyAdvice,
  type AutonomyAdvice,
} from '../../api/autonomyAdvice';
import { exceptionsApi, isAgentDecisionActor, type ExceptionItem } from '../../api/exceptions';
import { operatingModelApi, type GoalPace } from '../../api/operatingModel';
import { outcomesApi } from '../../api/outcomes';
import { scenarioDefinitions, scenariosApi } from '../../api/scenarioData';
import { storeBusinessApi } from '../../api/storeBusiness';
import { storesApi } from '../../api/stores';
import { useI18n } from '../../app/i18n';
import type { AgentType, GoalHorizon, GoalOutcome } from '../../types/domain';

function formatCurrency(value: number) {
  return `¥${new Intl.NumberFormat('zh-CN').format(Math.round(value))}`;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

interface AgentReviewCardProps {
  /** 只统计这些店铺；为空时不渲染（无店铺的新用户不需要复盘） */
  storeIds: number[];
  /** 当前聚合范围（全部店铺或单店名），与目标卡/周期卡保持同一口径 */
  scopeLabel: string;
}

export function AgentReviewCard({ storeIds, scopeLabel }: AgentReviewCardProps) {
  const { t } = useI18n();
  const [detailOpen, setDetailOpen] = useState(false);
  /** P31.4：复盘默认跟随目标周期；近 7 天保留为短期排查视图。 */
  const [windowMode, setWindowMode] = useState<'period' | 'recent'>('period');

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.list() });
  const { data: stores = [] } = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list() });
  const { data: exceptions = [] } = useQuery({ queryKey: ['exceptions'], queryFn: exceptionsApi.list });
  const { data: scenarioStates = [] } = useQuery({ queryKey: ['scenarios'], queryFn: scenariosApi.list });
  // 投放花费取店铺经营数据的 7 天趋势；与店铺列表同一份 mock，避免复盘另造一套成本口径。
  const { data: businessDetails = [] } = useQuery({
    queryKey: ['storeBusiness', 'list'],
    queryFn: storeBusinessApi.list,
  });

  // 账本按店铺分开存，读全量再按时间窗聚合，避免在页面上按店铺重复计算。
  const { data: outcomes = [] } = useQuery({
    queryKey: ['reviewOutcomes', storeIds],
    queryFn: async () => {
      const lists = await Promise.all(storeIds.map((storeId) => outcomesApi.list(storeId)));
      return lists.flat() as GoalOutcome[];
    },
    enabled: storeIds.length > 0,
  });

  // ===== P31.4 复盘窗口对齐目标周期 =====
  // 目标周期由店铺目标自身决定（月 / 季），复盘不再固定 7 天：否则「本月目标」与「近 7 天回写」长期不可比。
  const { data: goals = [] } = useQuery({
    queryKey: ['reviewGoals', storeIds],
    queryFn: () => Promise.all(storeIds.map((storeId) => operatingModelApi.getGoal(storeId))),
    enabled: storeIds.length > 0,
  });
  const horizon: GoalHorizon = goals.some((goal) => goal.horizon === 'quarter') ? 'quarter' : 'month';
  // 季度起始不引入 dayjs 插件：月份 0–11，向下取整到 3 的倍数即可。
  const periodStart =
    horizon === 'quarter'
      ? dayjs().startOf('month').subtract(dayjs().month() % 3, 'month')
      : dayjs().startOf('month');

  // 预计达成率复用目标卡的节奏推算（getGoalPace），不在复盘里另算一套。
  const { data: goalPaces = [] } = useQuery({
    queryKey: ['reviewGoalPace', storeIds],
    queryFn: async () => {
      const paces = await Promise.all(storeIds.map((storeId) => operatingModelApi.getGoalPace(storeId)));
      return paces.filter((pace): pace is GoalPace => Boolean(pace));
    },
    enabled: storeIds.length > 0 && horizon === 'month' && windowMode === 'period',
  });

  const windowStart = windowMode === 'recent' ? dayjs().subtract(7, 'day') : periodStart;
  const windowLabel =
    windowMode === 'recent'
      ? t('review.window')
      : horizon === 'quarter'
        ? t('review.windowQuarter')
        : t('review.windowPeriod');

  const recent = outcomes.filter((outcome) => dayjs(outcome.recordedAt).isAfter(windowStart));
  // 有历史但当前窗口没有动作时也要出现：复盘面不能悄悄消失，否则人会以为功能没了。
  if (outcomes.length === 0) return null;
  const realized = recent.filter((outcome) => outcome.status === 'realized');
  const lost = recent.filter((outcome) => outcome.status === 'lost');
  const pending = recent.filter((outcome) => outcome.status === 'projected');

  const realizedAmount = sum(realized.map((outcome) => outcome.actualImpact ?? 0));
  const expectedOfRealized = sum(realized.map((outcome) => outcome.expectedImpact));
  const lostAmount = sum(lost.map((outcome) => outcome.expectedImpact));
  const fulfillment = expectedOfRealized > 0 ? Math.round((realizedAmount / expectedOfRealized) * 100) : undefined;

  // ===== P31.4 预计达成率：与目标卡同一套节奏推算，按店铺加总 =====
  // 只有可推算的 GMV 目标参与；季度目标暂无基线，如实显示「—」而不是硬凑数字。
  const paceTarget = sum(goalPaces.map((pace) => pace.target));
  const paceProjected = sum(goalPaces.map((pace) => pace.projectedMonthEnd));
  const projectedRate =
    horizon === 'month' && paceTarget > 0 ? Math.round((paceProjected / paceTarget) * 100) : undefined;
  const paceCoverage = goalPaces.filter((pace) => pace.target > 0).length;

  // ===== P31.1 投入成本：预算花费 + Agent 调用，对照回写产出 =====
  // 投放与调用明细只有 7 天粒度，所以投入产出比固定按 7 天算，不和目标周期窗口混算。
  const costSince = dayjs().subtract(7, 'day');
  const recent7d = outcomes.filter((outcome) => dayjs(outcome.recordedAt).isAfter(costSince));
  const realized7dAmount = sum(
    recent7d.filter((outcome) => outcome.status === 'realized').map((outcome) => outcome.actualImpact ?? 0),
  );
  const businessByStore = new Map(businessDetails.map((detail) => [detail.storeId, detail]));
  const budgetSpend = sum(
    storeIds.map((storeId) => {
      const ad = businessByStore.get(storeId)?.adMetrics;
      if (!ad) return 0;
      return ad.trend.length > 0 ? sum(ad.trend.map((point) => point.spend)) : ad.todaySpend;
    }),
  );
  const involvedAgentTypes = new Set(recent7d.map((outcome) => outcome.agentType));
  const callStats = agents.reduce(
    (acc, agent) => {
      if (!agent.runStats || !involvedAgentTypes.has(agent.agentType)) return acc;
      const runs = sum(agent.runStats.trend.map((point) => point.runs));
      return { runs: acc.runs + runs, cost: acc.cost + runs * agent.runStats.avgCost };
    },
    { runs: 0, cost: 0 },
  );
  const totalCost = budgetSpend + callStats.cost;
  const costPerOutput = totalCost > 0 ? realized7dAmount / totalCost : undefined;

  // ===== P31.1 人的介入成本：升级数 / 改判率 / 平均决策时长 =====
  // 种子升级项没有 storeId，按店铺名归位；Agent 超时或规则收尾不计入改判率。
  const scopeStoreNames = new Set(
    stores.filter((store) => storeIds.includes(store.id)).map((store) => store.name),
  );
  const inScopeEscalation = (item: ExceptionItem) =>
    item.storeId !== undefined ? storeIds.includes(item.storeId) : scopeStoreNames.has(item.storeName);
  const windowEscalations = exceptions.filter(
    (item) => inScopeEscalation(item) && dayjs(item.createdAt).isAfter(windowStart),
  );
  const humanDecisions = windowEscalations.filter(
    (item) =>
      item.resolved &&
      Boolean(item.decisionOutcome) &&
      Boolean(item.resolvedAt) &&
      dayjs(item.resolvedAt).isAfter(windowStart) &&
      !isAgentDecisionActor(item.resolvedBy),
  );
  const overrides = humanDecisions.filter((item) => item.decisionOutcome === 'override').length;
  const overrideRate =
    humanDecisions.length > 0 ? Math.round((overrides / humanDecisions.length) * 100) : undefined;
  const decisionHours = humanDecisions.map(
    (item) => (dayjs(item.resolvedAt).valueOf() - dayjs(item.createdAt).valueOf()) / 3_600_000,
  );
  const avgDecisionHours =
    decisionHours.length > 0 ? sum(decisionHours) / decisionHours.length : undefined;

  // ===== P31.2 放权建议：用比复盘更长的 30 天证据收敛成 L1–L3 建议 =====
  // 只展示有数据支撑的场景；收紧建议排在放宽前，安全信号优先被看到。
  const adviceSince = dayjs().subtract(AUTONOMY_ADVICE_WINDOW_DAYS, 'day');
  const adviceOutcomes = outcomes.filter((outcome) => dayjs(outcome.recordedAt).isAfter(adviceSince));
  const adviceEscalations = exceptions.filter((item) => {
    const inScope =
      item.storeId !== undefined ? storeIds.includes(item.storeId) : scopeStoreNames.has(item.storeName);
    return inScope && dayjs(item.createdAt).isAfter(adviceSince);
  });
  const autonomyAdvice = buildAutonomyAdvice(adviceOutcomes, adviceEscalations, scenarioStates)
    .filter((advice) => advice.evidence.decided > 0 || advice.evidence.humanDecisions > 0)
    .sort((a, b) => {
      const weight = { tighten: 0, loosen: 1, keep: 2 } as const;
      return weight[a.direction] - weight[b.direction];
    })
    .slice(0, 3);

  const adviceReasonText = (advice: AutonomyAdvice) => {
    const { evidence } = advice;
    const level = t(`scenario.autonomy${advice.current}`);
    switch (advice.reason) {
      case 'insufficient_sample':
        return t('review.adviceInsufficient', {
          decided: evidence.decided,
          human: evidence.humanDecisions,
          required: AUTONOMY_MIN_DECIDED,
          level,
        });
      case 'loosen_strong':
        return t('review.adviceLoosen', {
          fulfillment: evidence.fulfillmentRate ?? '—',
          failure: evidence.failureRate ?? '—',
          override: evidence.overrideRate ?? '—',
        });
      case 'tighten_failure':
        return t('review.adviceTightenFailure', { rate: evidence.failureRate ?? 0 });
      case 'tighten_override':
        return t('review.adviceTightenOverride', { rate: evidence.overrideRate ?? 0 });
      default:
        return t('review.adviceHold', {
          fulfillment: evidence.fulfillmentRate ?? '—',
          failure: evidence.failureRate ?? '—',
          level,
        });
    }
  };

  const agentNameOf = (agentType: AgentType) =>
    agents.find((agent) => agent.agentType === agentType)?.displayName ?? agentType;
  const storeNameOf = (storeId: number) => stores.find((store) => store.id === storeId)?.name ?? `#${storeId}`;

  const contribution = new Map<AgentType, number>();
  for (const outcome of realized) {
    contribution.set(outcome.agentType, (contribution.get(outcome.agentType) ?? 0) + (outcome.actualImpact ?? 0));
  }
  const topAgents = [...contribution.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([agentType, amount]) => ({
      agentType,
      amount,
      name: agentNameOf(agentType),
    }));

  // 汇总数字必须能逐条核对：抽屉里摊开当前窗口内的每条账本记录，按时间倒序。
  const recentSorted = [...recent].sort(
    (a, b) => dayjs(b.recordedAt).valueOf() - dayjs(a.recordedAt).valueOf(),
  );
  const statusMeta: Record<string, { label: string; color: string }> = {
    realized: { label: t('review.statusRealized'), color: 'green' },
    lost: { label: t('review.statusLost'), color: 'red' },
    projected: { label: t('review.statusPending'), color: 'gold' },
  };

  const stats = [
    {
      key: 'realized',
      label: t('review.realized'),
      value: formatCurrency(realizedAmount),
      icon: <CheckCircleOutlined style={{ color: 'var(--ark-green)' }} />,
      hint: t('review.successActions', { count: String(realized.length) }),
    },
    {
      key: 'lost',
      label: t('review.failedActions'),
      value: String(lost.length),
      icon: <WarningOutlined style={{ color: lost.length > 0 ? 'var(--ark-red)' : 'var(--ark-muted)' }} />,
      hint: lost.length > 0 ? t('review.lostImpact', { amount: formatCurrency(lostAmount) }) : t('review.noFailure'),
    },
    {
      key: 'pending',
      label: t('review.pendingActions'),
      value: String(pending.length),
      icon: <ClockCircleOutlined style={{ color: 'var(--ark-amber)' }} />,
      hint: t('review.pendingHint'),
    },
    {
      key: 'rate',
      label: t('review.fulfillment'),
      value: fulfillment === undefined ? '—' : `${fulfillment}%`,
      icon: <BarChartOutlined style={{ color: 'var(--ark-blue)' }} />,
      hint: t('review.fulfillmentHint'),
    },
  ];

  return (
    <>
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space size={8}>
            <BarChartOutlined style={{ color: 'var(--ark-blue)' }} />
            <Typography.Text strong>{t('review.title')}</Typography.Text>
            <Tag>{windowLabel}</Tag>
            {scopeLabel && <Tag color="blue">{scopeLabel}</Tag>}
          </Space>
        }
        extra={
          <Space size={12}>
            <Segmented
              size="small"
              value={windowMode}
              onChange={(value) => setWindowMode(value as 'period' | 'recent')}
              options={[
                { label: t('review.modePeriod'), value: 'period' },
                { label: t('review.modeRecent'), value: 'recent' },
              ]}
            />
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              disabled={recent.length === 0}
              onClick={() => setDetailOpen(true)}
            >
              {t('review.viewDetail', { count: String(recent.length) })}
            </Button>
            <Link to="/settings/audit-logs">{t('review.viewAudit')}</Link>
          </Space>
        }
      >
      {/* P31.4：复盘默认对齐目标周期，并把「预计能不能达成」放在回写明细之前。 */}
      {windowMode === 'period' && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            background: 'var(--ark-panel-soft)',
            border: '1px solid var(--ark-border-soft)',
            borderRadius: 6,
          }}
        >
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('review.paceTitle')}
            </Typography.Text>
            {projectedRate === undefined ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('review.paceUnavailable')}
              </Typography.Text>
            ) : (
              <>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {t('review.paceValue', { percent: String(projectedRate) })}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('review.paceBasis', {
                    projected: formatCurrency(paceProjected),
                    target: formatCurrency(paceTarget),
                  })}
                </Typography.Text>
                {paceCoverage < storeIds.length && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('review.paceCoverage', {
                      covered: String(paceCoverage),
                      total: String(storeIds.length),
                    })}
                  </Typography.Text>
                )}
              </>
            )}
            <a href="#store-goal-card" style={{ fontSize: 12 }}>{t('review.paceGoGoal')}</a>
          </Space>
        </div>
      )}

      {recent.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={windowMode === 'recent' ? t('review.emptyWindow') : t('review.emptyPeriod')}
        />
      )}

      {recent.length > 0 && (
          <Row gutter={[12, 12]}>
            {stats.map((stat) => (
              <Col xs={12} md={6} key={stat.key}>
                <div style={{ padding: '4px 0' }}>
                  <Space size={6} style={{ marginBottom: 2 }}>
                    {stat.icon}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{stat.label}</Typography.Text>
                  </Space>
                  <Typography.Title level={4} style={{ margin: 0 }}>{stat.value}</Typography.Title>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{stat.hint}</Typography.Text>
                </div>
              </Col>
            ))}
          </Row>
      )}

          {/* P31.1：验收不只看「赚了多少」，还要看「花了多少、人被打断几次」。
              没有回写时这块反而更重要：投入已经发生，产出为零。 */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ark-border-soft)' }}>
            <Row gutter={[16, 12]}>
              <Col xs={24} md={12}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('review.costTitle')}
                </Typography.Text>
                <Row gutter={[12, 4]} style={{ marginTop: 4 }}>
                  {[
                    { key: 'input', label: t('review.costInput'), value: formatCurrency(totalCost) },
                    { key: 'output', label: t('review.costOutput'), value: formatCurrency(realized7dAmount) },
                    {
                      key: 'ratio',
                      label: t('review.costRatio'),
                      value: costPerOutput === undefined ? '—' : `¥${costPerOutput.toFixed(1)}`,
                    },
                  ].map((metric) => (
                    <Col span={8} key={metric.key}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{metric.label}</Typography.Text>
                      <Typography.Text strong style={{ display: 'block', fontSize: 15 }}>{metric.value}</Typography.Text>
                    </Col>
                  ))}
                </Row>
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                  {t('review.costInputHint', {
                    budget: formatCurrency(budgetSpend),
                    calls: formatCurrency(callStats.cost),
                    runs: callStats.runs,
                  })}
                </Typography.Text>
                {windowMode === 'period' && (
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 2, fontSize: 11 }}>
                    {t('review.costWindowHint')}
                  </Typography.Text>
                )}
              </Col>
              <Col xs={24} md={12}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('review.humanCostTitle')}
                </Typography.Text>
                <Row gutter={[12, 4]} style={{ marginTop: 4 }}>
                  {[
                    {
                      key: 'escalations',
                      label: t('review.escalations'),
                      value: t('review.escalationCount', { count: windowEscalations.length }),
                    },
                    {
                      key: 'override',
                      label: t('review.overrideRate'),
                      value: overrideRate === undefined ? '—' : `${overrideRate}%`,
                    },
                    {
                      key: 'decisionTime',
                      label: t('review.avgDecision'),
                      value: avgDecisionHours === undefined ? '—' : `${avgDecisionHours.toFixed(1)}h`,
                    },
                  ].map((metric) => (
                    <Col span={8} key={metric.key}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{metric.label}</Typography.Text>
                      <Typography.Text strong style={{ display: 'block', fontSize: 15 }}>{metric.value}</Typography.Text>
                    </Col>
                  ))}
                </Row>
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                  {t('review.humanCostHint')}
                </Typography.Text>
              </Col>
            </Row>
          </div>

          {/* P31.2：把数字收敛成「该不该动等级」的判断，并给出唯一调整入口 /setup */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ark-border-soft)' }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }} size={8} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('review.adviceTitle')}
                </Typography.Text>
                <Link to="/setup" style={{ fontSize: 12 }}>{t('review.adviceGoSetup')}</Link>
              </Space>
              {autonomyAdvice.length === 0 ? (
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  {t('review.adviceNoData')}
                </Typography.Text>
              ) : (
                autonomyAdvice.map((advice) => {
                  const def = scenarioDefinitions.find((item) => item.key === advice.scenarioKey);
                  return (
                    <Space key={advice.scenarioKey} size={6} wrap style={{ marginTop: 6, display: 'flex' }}>
                      <Typography.Text style={{ fontSize: 13 }}>
                        {def ? t(def.nameKey) : advice.scenarioKey}
                      </Typography.Text>
                      <Tag
                        color={
                          advice.direction === 'loosen'
                            ? 'green'
                            : advice.direction === 'tighten'
                              ? 'orange'
                              : 'default'
                        }
                      >
                        {t(`scenario.autonomy${advice.current}`)}
                        {advice.direction === 'keep'
                          ? ''
                          : ` → ${t(`scenario.autonomy${advice.recommended}`)}`}
                      </Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {adviceReasonText(advice)}
                      </Typography.Text>
                    </Space>
                  );
                })
              )}
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
                {t('review.adviceHint')}
              </Typography.Text>
          </div>

          {recent.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--ark-border-soft)' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('review.topAgents')}
            </Typography.Text>
            {topAgents.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('review.noContribution')} />
            ) : (
              <Row gutter={[12, 8]} style={{ marginTop: 6 }}>
                {topAgents.map((agent) => (
                  <Col xs={24} md={8} key={agent.agentType}>
                    <Space size={6} wrap>
                      <Typography.Text style={{ fontSize: 13 }}>{agent.name}</Typography.Text>
                      <Typography.Text strong style={{ fontSize: 13 }}>{formatCurrency(agent.amount)}</Typography.Text>
                    </Space>
                  </Col>
                ))}
              </Row>
            )}
            {lost.length > 0 && (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                {t('review.retryHint')}
              </Typography.Text>
            )}
          </div>
          )}
      </Card>

      {/* P26: 汇总可核对 — 抽屉里列出同一窗口内的每条账本记录，避免汇总数与流水对不上。 */}
      <Drawer
        title={
          <Space size={8}>
            <Typography.Text strong>{t('review.detailTitle')}</Typography.Text>
            <Tag>{windowLabel}</Tag>
          </Space>
        }
        width={480}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      >
        <List
          dataSource={recentSorted}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={windowMode === 'recent' ? t('review.emptyWindow') : t('review.emptyPeriod')}
              />
            ),
          }}
          renderItem={(outcome) => {
            const meta = statusMeta[outcome.status] ?? { label: outcome.status, color: 'default' };
            return (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space size={6} wrap>
                      <Typography.Text style={{ fontSize: 13 }}>{outcome.targetLabel}</Typography.Text>
                      <Tag color={meta.color}>{meta.label}</Tag>
                    </Space>
                  }
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {agentNameOf(outcome.agentType)} · {storeNameOf(outcome.storeId)} ·{' '}
                      {dayjs(outcome.recordedAt).format('MM-DD HH:mm')}
                    </Typography.Text>
                  }
                />
                <Space direction="vertical" size={0} align="end">
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {outcome.status === 'realized' ? formatCurrency(outcome.actualImpact ?? 0) : '—'}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('review.colExpected')} {formatCurrency(outcome.expectedImpact)}
                  </Typography.Text>
                </Space>
              </List.Item>
            );
          }}
        />
      </Drawer>
    </>
  );
}
