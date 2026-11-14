import {
  AlertOutlined,
  BarChartOutlined,
  DashboardOutlined,
  LineChartOutlined,
  PayCircleOutlined,
  PlayCircleOutlined,
  RightOutlined,
  RiseOutlined,
  RobotOutlined,
  ShoppingCartOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Col, Row, Segmented, Space, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { businessDashboardApi, type DashboardTimeRange } from '../../api/businessDashboard';
import { dashboardApi } from '../../api/dashboard';
import { agentsApi, type AgentHealthIssue } from '../../api/agents';
import { getInventoryAlertCount } from '../../api/inventory';
import { orchestratorApi } from '../../api/orchestrator';
import { storesApi } from '../../api/stores';
import { useAuth } from '../../app/auth';
import { canAccess } from '../../app/rolePermissions';
import { useDemoMode } from '../../app/demoMode';
import { useStoreScope } from '../../app/storeScope';
import { useI18n } from '../../app/i18n';
import { TrendBarChart } from '../../components/charts/TrendBarChart';
import { PageHeader } from '../../components/PageHeader';
import { StoreConnectionEmptyState } from '../../components/StoreConnectionEmptyState';
import { StoreGoalCard } from '../../components/dashboard/StoreGoalCard';
import { OperatingCycleCard } from '../../components/dashboard/OperatingCycleCard';
import { PortfolioGoalsCard } from '../../components/dashboard/PortfolioGoalsCard';
import { AgentReviewCard } from '../../components/dashboard/AgentReviewCard';
import { RoleFocusCard } from '../../components/dashboard/RoleFocusCard';

/** Assumed net margin used only for the profit *estimate* KPI; surfaced in the UI (C4). */
const ESTIMATED_NET_MARGIN = 0.21;

function formatCurrency(value: number, currency = 'CNY') {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** Compact CJK-friendly value label for chart columns, e.g. 28640 → "2.9万". */
function formatCompact(value: number) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return formatNumber(Math.round(value));
}

function changePercent(current: number, previous: number) {
  if (previous === 0) return { value: 0, up: true };
  const pct = Math.round(((current - previous) / previous) * 100);
  return { value: pct, up: pct >= 0 };
}

// ===== 主页面 =====

export function DashboardPage() {
  const { t } = useI18n();
  const { user, role } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 收件箱升级项深链：?exc=xxx 直接打开对应店铺的经营周期裁决台。
  // 周期升级 id 形如 cycle-esc-{cycleId}-{conflictId}，执行失败形如 cycle-exec-{cycleId}-{proposalId}；
  // cycleId 反推店铺 id，避免全店视图总落到首店。
  const focusEscalationId = searchParams.get('exc') ?? undefined;
  // 审批回执/审计回写深链：?storeId=x 直接落到对应店铺，避免多店场景指错店。
  const requestedStoreId = Number(searchParams.get('storeId')) || undefined;
  const focusCycleStoreId = (() => {
    const match = focusEscalationId?.match(/^cycle-(?:esc|exec)-(\d+)-/);
    if (!match) return undefined;
    return Math.floor(Number(match[1]) / 10);
  })();
  const { isDemo, enterDemo } = useDemoMode();
  const [timeRange, setTimeRange] = useState<DashboardTimeRange>('today');
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const [healthExpanded, setHealthExpanded] = useState(false);
  // 集成（D3）：店铺范围来自 Shell 级持久过滤器（WS-E storeScope context），页面不再自维护。
  const { scope: storeScope, activeStore, isAllStores } = useStoreScope();
  const scopedStoreName = activeStore?.name;

  const { data: storesData } = useQuery({
    queryKey: ['stores'],
    queryFn: () => storesApi.list(),
  });
  const storeCount = storesData?.length ?? 0;
  const focusStoreName = storesData?.find((store) => store.id === focusCycleStoreId)?.name;
  const targetStoreId = requestedStoreId ?? activeStore?.id ?? storesData?.[0]?.id;

  // P27: 复盘卡与目标卡/周期卡使用同一个店铺范围 — 单店时只统计该店，并在标题上标明范围。
  const reviewStoreIds = isAllStores
    ? (storesData ?? []).map((store) => store.id)
    : activeStore
      ? [activeStore.id]
      : [];
  const reviewScopeLabel = isAllStores ? t('review.scopeAllStores') : (activeStore?.name ?? '');

  // Agent 运营台：首屏先回答“Agent 现在在做什么、还有什么要你处理”，
  // 指标和明细下沉，避免首页仍被读成一块人工看板。
  const consoleStoreId = focusCycleStoreId ?? targetStoreId;
  const { data: consoleCycle } = useQuery({
    queryKey: ['operatingCycle', consoleStoreId],
    queryFn: () => orchestratorApi.getCycle(consoleStoreId!),
    enabled: consoleStoreId !== undefined,
  });
  const { data: consoleAuto } = useQuery({
    queryKey: ['autoTrigger', consoleStoreId],
    queryFn: () => orchestratorApi.getAutoTrigger(consoleStoreId!),
    enabled: consoleStoreId !== undefined,
  });
  const consoleImpact = (consoleCycle?.outcomes ?? [])
    .filter((outcome) => outcome.status === 'realized')
    .reduce((sum, outcome) => sum + (outcome.actualImpact ?? 0), 0);

  // 跨店升级深链：滚动到跨店方案卡，让人在正确的裁决入口继续处理。
  useEffect(() => {
    if (!focusEscalationId?.startsWith('cross-')) return;
    document.getElementById('portfolio-goals-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusEscalationId, storesData]);

  // P6/P12 自主运转：工作台常驻调度器，事件优先、定时兜底、可选自动执行低风险动作。
  // 真实环境由后端调度器执行；这里用页面内定时器模拟，离开工作台即停止。
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  // P28.3 调度真值：不再默认「自主运行中」，只显示能对得上心跳的状态。
  const { data: schedulerStatus } = useQuery({
    queryKey: ['schedulerStatus'],
    queryFn: () => orchestratorApi.getSchedulerStatus(),
    refetchInterval: 15_000,
  });
  const autoEnabled = consoleAuto?.enabled ?? false;
  const consoleTag = (() => {
    if (!autoEnabled) return { color: 'default', label: t('agentConsole.manual') };
    if (!schedulerStatus) return { color: 'default', label: t('agentConsole.checking') };
    if (!schedulerStatus.online) return { color: 'red', label: t('agentConsole.schedulerOffline') };
    return schedulerStatus.mode === 'demo'
      ? { color: 'blue', label: t('agentConsole.modeDemo') }
      : { color: 'green', label: t('agentConsole.modeLive') };
  })();
  const clock = (iso?: string) => (iso ? dayjs(iso).format('MM-DD HH:mm') : undefined);
  const neverPatrolled = t('agentConsole.neverPatrolled');
  const patrolTimes = schedulerStatus
    ? t('agentConsole.patrolTimes', {
        last: clock(schedulerStatus.lastPatrolAt) ?? neverPatrolled,
        next: schedulerStatus.online ? (clock(schedulerStatus.nextPatrolAt) ?? '—') : '—',
        count: String(schedulerStatus.checkedStoreCount),
      })
    : '';

  // 页面挂载即登记调度在位，卸载即标记停止：让「离线」来自事实而不是缺省值。
  useEffect(() => {
    if (!storeCount) return;
    orchestratorApi.setSchedulerActive(true);
    queryClient.invalidateQueries({ queryKey: ['schedulerStatus'] });
    return () => {
      orchestratorApi.setSchedulerActive(false);
    };
  }, [storeCount, queryClient]);

  useEffect(() => {
    if (!storesData?.length) return;
    const names: Record<number, string> = {};
    storesData.forEach((store) => {
      names[store.id] = store.name;
    });
    const run = () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      orchestratorApi
        .runAutoTriggers(
          storesData.map((store) => store.id),
          names,
        )
        .then(async (results) => {
          // P35.1：治理自巡检并入同一轮巡检 — 全部已连接店铺结算目标、同步节奏/护栏升级，
          // 再按人的决策规则与超时默认收尾；不再依赖人打开某张目标卡或收件箱。
          const sweep = await orchestratorApi
            .runGovernanceSweep(storesData.map((store) => store.id))
            .catch(() => undefined);
          const fired = results.filter((result) => result.triggered);
          // P7：跨店升级与是否触发新周期无关，也要让收件箱拿到最新条目。
          queryClient.invalidateQueries({ queryKey: ['exceptions'] });
          // 一轮巡检无论是否生成新周期都刷新心跳，「上次/下次巡检」才对得上真实时间。
          queryClient.invalidateQueries({ queryKey: ['schedulerStatus'] });
          if (sweep?.changed) {
            queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
            queryClient.invalidateQueries({ queryKey: ['goalPeriod'] });
            queryClient.invalidateQueries({ queryKey: ['goalPace'] });
            queryClient.invalidateQueries({ queryKey: ['guardHealth'] });
            queryClient.invalidateQueries({ queryKey: ['guardChanges'] });
            queryClient.invalidateQueries({ queryKey: ['portfolio'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard'] });
            queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
          }
          if (!fired.length) return;
          queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
          queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
          queryClient.invalidateQueries({ queryKey: ['portfolio'] });
          queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
          const autoSubmitted = fired.reduce(
            (sum, result) => sum + (result.autoSubmitted ?? 0),
            0,
          );
          message.info(
            autoSubmitted > 0
              ? t('cycle.autoTriggeredAndSubmitted', {
                  count: String(fired.length),
                  submitted: String(autoSubmitted),
                })
              : t('cycle.autoTriggered', { count: String(fired.length) }),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    run();
    const timer = window.setInterval(run, 60_000);
    return () => window.clearInterval(timer);
  }, [storesData, queryClient, t]);

  // P28.4 Agent 健康态：已启用却跑不动的 Agent 必须显式说出「卡在哪、找谁处理」。
  const { data: agentHealth } = useQuery({
    queryKey: ['agentHealth', consoleStoreId],
    queryFn: () => agentsApi.getHealth(consoleStoreId!),
    enabled: consoleStoreId !== undefined,
    refetchInterval: 30_000,
  });
  const canOpenAgents = !role || canAccess(role, '/agents');
  const healthReason = (issue: AgentHealthIssue) => {
    if (issue.kind === 'auth_invalid') {
      return t('agentConsole.healthAuth', {
        store: issue.storeName ?? '',
        status: t(`status.${issue.storeStatus ?? 'connected'}`),
      });
    }
    if (issue.kind === 'upstream_disabled') {
      return t('agentConsole.healthUpstream', {
        agents: (issue.upstream ?? []).map((dep) => dep.displayName).join('、'),
      });
    }
    return t('agentConsole.healthIdle', { days: String(issue.idleDays ?? 0) });
  };
  const healthFixTo = (issue: AgentHealthIssue) => {
    if (issue.kind === 'auth_invalid' && issue.storeId !== undefined) return `/stores/${issue.storeId}`;
    return `/agents/${issue.agentType}`;
  };
  const healthFixLabel = (issue: AgentHealthIssue) =>
    t(issue.kind === 'auth_invalid' ? 'agentConsole.healthFixStores' : 'agentConsole.healthFixAgents');

  const { data: businessMetrics } = useQuery({
    queryKey: ['businessDashboard', timeRange, storeScope],
    queryFn: () => businessDashboardApi.getMetrics(timeRange, scopedStoreName),
    enabled: storeCount > 0,
  });

  const { data: dashboardSummary } = useQuery({
    queryKey: ['dashboard'],
    queryFn: dashboardApi.getSummary,
    enabled: storeCount > 0,
  });

  const pendingReviews = businessMetrics
    ? businessMetrics.afterSales.negativeReviews - businessMetrics.afterSales.respondedReviews
    : 0;
  const gmvChange = businessMetrics ? changePercent(businessMetrics.periodGmv.current, businessMetrics.periodGmv.previous) : { value: 0, up: true };
  const orderChange = businessMetrics ? changePercent(businessMetrics.periodOrders.current, businessMetrics.periodOrders.previous) : { value: 0, up: true };
  const comparisonLabel = businessMetrics ? t(businessMetrics.comparisonLabelKey) : '';

  // ===== 顶部关注条数据（C1/C2）=====
  // 与库存明细「预警」筛选用同一份 SKU 数据，避免关注条数字和点进去的行数对不上。
  const stockAlertCount = getInventoryAlertCount(activeStore?.id);
  const attentionItems = [
    dashboardSummary && dashboardSummary.loginRequiredStores > 0
      ? { key: 'login', to: '/stores', tag: t('dashboardv2.tagUrgent'), tagColor: 'red', label: t('dashboardv2.itemLoginRequired'), count: t('dashboardv2.countStores', { count: dashboardSummary.loginRequiredStores }) }
      : null,
    dashboardSummary && dashboardSummary.pendingApprovals > 0
      ? { key: 'approvals', to: '/inbox?type=approval', tag: t('dashboardv2.tagApproval'), tagColor: 'orange', label: t('dashboardv2.itemPendingApprovals'), count: t('dashboardv2.countItems', { count: dashboardSummary.pendingApprovals }) }
      : null,
    dashboardSummary && dashboardSummary.exceptionCenterPending > 0
      ? { key: 'exceptions', to: '/inbox?type=exception', tag: t('dashboardv2.tagException'), tagColor: 'volcano', label: t('dashboardv2.itemExceptions'), count: t('dashboardv2.countItems', { count: dashboardSummary.exceptionCenterPending }) }
      : null,
    pendingReviews > 0
      ? { key: 'reviews', to: '/reviews', tag: t('dashboardv2.tagReview'), tagColor: 'gold', label: t('dashboardv2.itemNegativeReviews'), count: t('dashboardv2.countReviews', { count: pendingReviews }) }
      : null,
    stockAlertCount > 0
      ? { key: 'stock', to: '/inventory?alert=alert', tag: t('dashboardv2.tagStock'), tagColor: 'blue', label: t('dashboardv2.itemLowStock'), count: t('dashboardv2.countSkus', { count: stockAlertCount }) }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  // 角色过滤：关注项各自指向不同模块，受限角色（如财务）点进去只会撞 403。
  const visibleAttentionItems = attentionItems.filter(
    (item) => !role || canAccess(role, item.to.split('?')[0])
  );
  const canOpenInbox = !role || canAccess(role, '/inbox');
  const canOpenReports = !role || canAccess(role, '/reports');

  // 全账号范围提示：这些卡片不受店铺筛选影响（C3 诚实标注）
  const accountScopeTag = scopedStoreName ? (
    <Tag style={{ fontSize: 12 }} color="default">{t('dashboardv2.scopeAllStores')}</Tag>
  ) : null;

  if (user?.experience === 'onboarding') {
    return (
      <div className="page-stack">
        <PageHeader title={t('dashboard.title')} description={t('dashboard.description')} />
        <StoreConnectionEmptyState description={t('dashboardv2.onboardingEmpty')} />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
        actions={
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <SyncOutlined /> {t('dashboardv2.updatedAt', { time: dayjs().format('HH:mm') })}
            </Typography.Text>
            <Segmented
              value={timeRange}
              onChange={(value) => setTimeRange(value as DashboardTimeRange)}
              options={[
                { label: t('dashboardv2.rangeToday'), value: 'today' },
                { label: t('dashboardv2.range7d'), value: '7d' },
                { label: t('dashboardv2.range30d'), value: '30d' },
              ]}
            />
            {/* D-nav/B: 报表 folded in here — reached from 经营总览, not its own nav item. */}
            {canOpenReports && (
              <Button size="small" icon={<BarChartOutlined />} onClick={() => navigate('/reports')}>
                {t('dashboard.reportsEntry')}
              </Button>
            )}
          </Space>
        }
      />

      {/* 演示模式入口 — 无店铺时显示 */}
      {!isDemo && storeCount === 0 && (
        <Card size="small" style={{ marginBottom: 16, background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)', border: '1px solid #93c5fd' }}>
          <Row align="middle" justify="space-between">
            <Col>
              <Space>
                <PlayCircleOutlined style={{ color: '#2563eb', fontSize: 18 }} />
                <div>
                  <Typography.Text strong style={{ fontSize: 13 }}>{t('dashboard.demoBanner')}</Typography.Text>
                </div>
              </Space>
            </Col>
            <Col>
              <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => enterDemo()}>
                {t('dashboard.tryDemo')}
              </Button>
            </Col>
          </Row>
        </Card>
      )}

      {/* ===== P31.3: 角色首屏 — 目标与放权 / 归我的升级 / 待我审批 ===== */}
      {storeCount > 0 && <RoleFocusCard storeIds={reviewStoreIds} />}

      {/* ===== Agent 运营台：一屏回答“Agent 在做什么、还需要你做什么” ===== */}
      {storeCount > 0 && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Row align="middle" justify="space-between" gutter={[16, 12]}>
            <Col flex="auto">
              <Space size={8} wrap>
                <RobotOutlined style={{ color: '#2563eb', fontSize: 18 }} />
                <Typography.Text strong>{t('agentConsole.title')}</Typography.Text>
                <Tag color={consoleTag.color}>{consoleTag.label}</Tag>
                {accountScopeTag}
              </Space>
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 13 }}>
                {consoleCycle?.generatedAt
                  ? t('agentConsole.impactSummary', { impact: formatCurrency(consoleImpact) })
                  : t('agentConsole.notGenerated')}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 2, fontSize: 12 }}>
                {!autoEnabled
                  ? t('agentConsole.cadenceOff')
                  : !schedulerStatus
                    ? t('agentConsole.checkingHint')
                    : !schedulerStatus.online
                      ? t('agentConsole.schedulerOfflineHint', {
                          time: clock(schedulerStatus.lastPatrolAt) ?? neverPatrolled,
                        })
                      : t(schedulerStatus.mode === 'demo' ? 'agentConsole.demoHint' : 'agentConsole.liveHint')}
              </Typography.Text>
              {autoEnabled && patrolTimes && (
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 2, fontSize: 12 }}>
                  {patrolTimes}
                </Typography.Text>
              )}
            </Col>
            <Col>
              <Space size={12}>
                <div style={{ textAlign: 'right' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    {t('agentConsole.needsYou')}
                  </Typography.Text>
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    {dashboardSummary?.inboxTotal ? dashboardSummary.inboxTotal : t('agentConsole.allClear')}
                  </Typography.Title>
                </div>
                {canOpenInbox && (
                  <Link to="/inbox">
                    <Button size="small" type="primary">
                      {t('agentConsole.openInbox')} <RightOutlined />
                    </Button>
                  </Link>
                )}
              </Space>
            </Col>
          </Row>
          {agentHealth && (
            <div style={{ marginTop: 8 }}>
              <Space size={8} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('agentConsole.healthTitle')}
                </Typography.Text>
                {agentHealth.issues.length === 0 ? (
                  <Typography.Text type="success" style={{ fontSize: 12 }}>
                    {t('agentConsole.healthReady', { count: String(agentHealth.healthyCount) })}
                  </Typography.Text>
                ) : (
                  <Tag color="red" style={{ fontSize: 11, margin: 0 }}>
                    {t('agentConsole.healthBlocked', {
                      count: String(agentHealth.blockedAgentCount),
                    })}
                  </Tag>
                )}
              </Space>
              {agentHealth.issues.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {(() => {
                    const authIssue = agentHealth.issues.find((issue) => issue.kind === 'auth_invalid');
                    // 授权失效时所有已启用 Agent 同因阻塞，按一件事展示，避免重复 N 行。
                    if (authIssue) {
                      return (
                        <div className="agent-health-row">
                          <span>{healthReason(authIssue)}</span>
                          {canOpenAgents && (
                            <Link to={healthFixTo(authIssue)}>{healthFixLabel(authIssue)} →</Link>
                          )}
                        </div>
                      );
                    }
                    const visible = healthExpanded ? agentHealth.issues : agentHealth.issues.slice(0, 2);
                    return (
                      <>
                        {visible.map((issue) => (
                          <div key={issue.agentType ?? issue.kind} className="agent-health-row">
                            <span>
                              <strong>{issue.displayName}</strong> · {healthReason(issue)}
                            </span>
                            {canOpenAgents && (
                              <Link to={healthFixTo(issue)}>{healthFixLabel(issue)} →</Link>
                            )}
                          </div>
                        ))}
                        {agentHealth.issues.length > 2 && (
                          <Button
                            type="link"
                            size="small"
                            style={{ padding: 0, fontSize: 12 }}
                            onClick={() => setHealthExpanded((value) => !value)}
                          >
                            {healthExpanded
                              ? t('common.collapse')
                              : t('agentConsole.healthMore', {
                                  count: String(agentHealth.issues.length - 2),
                                })}
                          </Button>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ark-border-soft)' }}>
            {visibleAttentionItems.length > 0 ? (
              <>
                <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
                  <AlertOutlined style={{ color: '#ea580c', marginRight: 4 }} />
                  {t('dashboardv2.attentionTitle')} · {t('agentConsole.attentionHint')}
                </Typography.Text>
                <div className="dashboard-priority-list">
                  {(attentionExpanded ? visibleAttentionItems : visibleAttentionItems.slice(0, 3)).map((item) => (
                    <Link to={item.to} key={item.key}>
                      <span><Tag color={item.tagColor}>{item.tag}</Tag>{item.label}</span>
                      <strong>{item.count} →</strong>
                    </Link>
                  ))}
                </div>
                {visibleAttentionItems.length > 3 && (
                  <Button type="link" size="small" style={{ padding: 0, marginTop: 4, fontSize: 12 }} onClick={() => setAttentionExpanded((value) => !value)}>
                    {attentionExpanded ? t('common.collapse') : t('agentConsole.moreAttention', { count: String(visibleAttentionItems.length - 3) })}
                  </Button>
                )}
              </>
            ) : (
              <Typography.Text type="success" style={{ fontSize: 13 }}>{t('dashboardv2.attentionAllClear')}</Typography.Text>
            )}
          </div>
        </Card>
      )}

      {/* ===== P1: 店铺目标 — Agent 动作的业务锚点 ===== */}
      {storeCount > 0 && (
        <div id="store-goal-card">
          <StoreGoalCard storeId={targetStoreId} />
        </div>
      )}

      {/* ===== P2: 经营周期 — 目标 → 跨 Agent 提案 → 冲突仲裁 ===== */}
      {storeCount > 0 && (
        <OperatingCycleCard
          storeId={focusCycleStoreId ?? targetStoreId}
          storeName={focusStoreName ?? storesData?.find((store) => store.id === consoleStoreId)?.name ?? ''}
          focusEscalationId={focusEscalationId}
        />
      )}

      {/* ===== 核心 KPI（≤4 个，C4）===== */}
      {businessMetrics && (
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          {[
            {
              title: t('dashboardv2.kpiGmv'),
              value: formatCurrency(businessMetrics.periodGmv.current),
              meta: `${gmvChange.up ? '↑' : '↓'} ${Math.abs(gmvChange.value)}% ${comparisonLabel}`,
              color: '#2563eb',
              icon: <PayCircleOutlined />,
              estimate: false,
            },
            {
              title: t('dashboardv2.kpiOrders'),
              value: formatNumber(businessMetrics.periodOrders.current),
              meta: `${orderChange.up ? '↑' : '↓'} ${Math.abs(orderChange.value)}% ${comparisonLabel}`,
              color: '#0f766e',
              icon: <ShoppingCartOutlined />,
              estimate: false,
            },
            {
              title: t('dashboardv2.kpiAdRoi'),
              value: `${businessMetrics.adMetrics.roas.toFixed(1)}×`,
              meta: t('dashboardv2.adRoiTarget', { target: businessMetrics.adMetrics.targetRoas.toFixed(1) }),
              color: '#7c3aed',
              icon: <DashboardOutlined />,
              estimate: false,
            },
            {
              title: t('dashboardv2.kpiEstProfit'),
              value: formatCurrency(Math.round(businessMetrics.periodGmv.current * ESTIMATED_NET_MARGIN)),
              meta: t('dashboardv2.estProfitAssumption'),
              color: '#16a34a',
              icon: <RiseOutlined />,
              estimate: true,
            },
          ].map((metric) => (
            <Col key={metric.title} xs={12} xl={6}>
              <Card size="small" className="business-kpi-card">
                <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
                  <div>
                    <Space size={4}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{metric.title}</Typography.Text>
                      {metric.estimate && <Tag color="default" style={{ fontSize: 12, lineHeight: '16px', margin: 0 }}>{t('dashboardv2.estimateTag')}</Tag>}
                    </Space>
                    <Typography.Title level={3} style={{ margin: '6px 0 2px', color: metric.color }}>{metric.value}</Typography.Title>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{metric.meta}</Typography.Text>
                  </div>
                  <span className="business-kpi-icon" style={{ color: metric.color }}>{metric.icon}</span>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* ===== 经营结果趋势 ===== */}
      {businessMetrics && (
        <Card
          title={<><LineChartOutlined /> {t('dashboardv2.trendTitle')}</>}
          size="small"
          style={{ marginBottom: 16 }}
          extra={timeRange === '30d' ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('dashboardv2.trendBucketNote')}</Typography.Text> : null}
        >
          <TrendBarChart
            ariaLabel={t('dashboardv2.trendTitle')}
            points={businessMetrics.gmvTrend.map((point) => ({
              key: point.date,
              label: point.date,
              valueLabel: `¥${formatCompact(point.gmv)}`,
              bars: [
                { value: point.gmv, title: `GMV: ¥${formatNumber(point.gmv)}`, className: 'trend-bar-gmv', minHeight: 10 },
                { value: point.orders, title: t('dashboard.ordersColon', { count: point.orders }), className: 'trend-bar-orders', minHeight: 6 }
              ]
            }))}
          />
          <div className="chart-legend">
            <span><i className="legend-dot legend-gmv" />{t('dashboardv2.legendGmv')}</span>
            <span><i className="legend-dot legend-orders" />{t('dashboardv2.legendOrders')}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('dashboardv2.trendScaleNote')}</Typography.Text>
          </div>
        </Card>
      )}

      {/* ===== P3.5: 多店铺经营概览 — 结果之后再看各店跑位，单店不出现 ===== */}
      {storeCount > 1 && <PortfolioGoalsCard />}

      {/* ===== P25: 最近 7 天 Agent 复盘 — 人只设目标，也要能验收 Agent 的产出 =====
          P27: 复盘必须跟随店铺范围，否则切到单店时数字与目标/周期卡口径不一致。 */}
      {reviewStoreIds.length > 0 && (
        <AgentReviewCard storeIds={reviewStoreIds} scopeLabel={reviewScopeLabel} />
      )}

    </div>
  );
}
