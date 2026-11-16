import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  LockOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RocketOutlined,
  SafetyOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Button, Card, Col, Input, Progress, Row, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { agentsApi } from '../../api/agents';
import type { AgentListItem } from '../../api/agents';
import { computeEnableClosure } from '../../api/scenarioData';
import { financeApi } from '../../api/finance';
import { AgentPreEnableDrawer } from '../../components/agents/AgentPreEnableDrawer';
import { EnableAllReviewModal } from '../../components/agents/EnableAllReviewModal';
import { useAuth } from '../../app/auth';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { TablePageSkeleton } from '../../components/PageSkeleton';
import { StatusBadge } from '../../components/StatusBadge';
import { StoreConnectionEmptyState } from '../../components/StoreConnectionEmptyState';
import { MetricCard } from '../../components/metrics/MetricCard';
import type { AgentConfig, AgentLayer, AgentType } from '../../types/domain';
import type { AgentRunStats } from '../../types/domain';

function getRecentRunText(stats: AgentRunStats | undefined, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!stats?.lastRunAt) return '-';
  const lastDate = new Date(stats.lastRunAt);
  if (Number.isNaN(lastDate.getTime())) return '-';
  const hoursAgo = Math.max(0, (Date.now() - lastDate.getTime()) / (1000 * 60 * 60));
  if (hoursAgo <= 1) return t('agent.recentWithin1h');
  if (hoursAgo <= 24) return t('agent.recentHoursAgo', { hours: Math.round(hoursAgo) });
  return t('agent.recentDaysAgo', { days: Math.round(hoursAgo / 24) });
}

const layerColors: Record<AgentLayer, string> = {
  foundation: 'var(--ark-red)',
  traffic: 'var(--ark-blue)',
  growth: 'var(--ark-green)',
  support: 'var(--ark-purple)',
  standalone: 'var(--ark-orange)'
};

export function AgentListPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { can } = usePermission();
  const navigate = useNavigate();
  const canUpdateAgents = can('agents', 'update');
  const queryClient = useQueryClient();
  // U6.2：目录没读到时不能渲染「已开通 0/0 · 没有待开通项」这种结论。
  // 查询改为持有生命周期，并把重试压到 1 次，失败约 1s 内交给用户重试。
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list, retry: 1 });
  const { data: agents = [] } = agentsQuery;
  const [searchText, setSearchText] = useState('');
  // WS-D (D4): risk-grouped bulk-enable review modal + shared pre-enable drawer
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [preEnableAgent, setPreEnableAgent] = useState<AgentListItem | null>(null);

  const filteredAgents = searchText
    ? agents.filter(a =>
        a.displayName.toLowerCase().includes(searchText.toLowerCase()) ||
        a.agentType.toLowerCase().includes(searchText.toLowerCase())
      )
    : agents;

  const trialStatusQuery = useQuery({
    queryKey: ['trialStatus'],
    queryFn: financeApi.getTrialStatus,
    retry: 1,
  });
  const { data: trialStatus } = trialStatusQuery;

  const isPremiumLocked = (agentType: string) => {
    return trialStatus?.premiumAgents.includes(agentType) ?? false;
  };

  const flowNodes = [
    { id: 'login_bootstrap', label: t('agent.login_bootstrap'), layer: 'foundation' as const, w: 80 },
    { id: 'competitor_intel', label: t('agent.competitor_intel'), layer: 'support' as const, w: 80 },
    { id: 'product_launch', label: t('agent.product_launch'), layer: 'foundation' as const, w: 80 },
    { id: 'creative_factory', label: t('agent.creative_factory'), layer: 'support' as const, w: 80 },
    { id: 'ads_optimizer', label: t('agent.ads_optimizer'), layer: 'traffic' as const, w: 90 },
    { id: 'pricing_strategy', label: t('agent.pricing_strategy'), layer: 'traffic' as const, w: 90 },
    { id: 'live_stream_ops', label: t('agent.live_stream_ops'), layer: 'traffic' as const, w: 90 },
  ];

  const growthSubLabels = [
    t('agent.crm_retention'),
    t('agent.review_manager'),
    t('agent.customer_service'),
    t('agent.after_sales'),
    t('agent.promotion_campaign')
  ];

  const toggleMutation = useMutation({
    mutationFn: (agentType: AgentType) => agentsApi.toggle(agentType),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      // S1/S4：开关会改变下一轮提案来源，工作台要跟着刷新。
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      message.success(updated?.enabled ? t('agent.toggledOnHint') : t('agent.toggleSuccess'));
    },
    onError: (error: Error) => {
      message.error(error.message);
    }
  });

  const disabledAgents = agents.filter(a => !a.enabled && !isPremiumLocked(a.agentType)).length;
  const bulkCandidates = agents.filter(a => !a.enabled && !isPremiumLocked(a.agentType));

  // WS-D (D4): bulk enable happens only after the review modal — dependency-ordered batch.
  const bulkEnableMutation = useMutation({
    mutationFn: async (selected: AgentType[]) => {
      const { ordered } = computeEnableClosure(selected);
      await agentsApi.batchEnable(ordered);
      return ordered.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      message.success(t('agenttrust.bulkEnableDone', { count }));
      setBulkModalOpen(false);
    },
    onError: (error: Error) => {
      message.error(error.message);
    }
  });

  const getMissingDeps = (agent: AgentListItem) =>
    agent.dependsOn
      .filter((dep) => !agents.find((a) => a.agentType === dep)?.enabled)
      .map((dep) => t(`agent.${dep}`));

  // U1.2：首屏结论要能自己解释「为什么还没开通」，这里把依赖阻塞的数量算出来，
  // 与表格里红字依赖提示、批量开通抽屉的自动补齐是同一口径。
  const blockedByDeps =
    disabledAgents > 0
      ? agents.filter((a) => !a.enabled && !isPremiumLocked(a.agentType) && getMissingDeps(a).length > 0)
          .length
      : 0;

  // 首屏那句「x/15」必须能对上账：未开通的里面还有一类是套餐没解锁的，
  // 不写出来人会自己算 15-4=11，和「7 个可开通」对不上，又得多解读一次。
  const lockedCount = agents.filter((a) => !a.enabled && isPremiumLocked(a.agentType)).length;
  const conclusionNotes = [
    lockedCount > 0 ? t('agent.conclusionLocked', { locked: lockedCount }) : '',
    blockedByDeps > 0 ? t('agent.conclusionDeps', { blocked: blockedByDeps }) : '',
  ].filter(Boolean);

  const riskControl = agents.find((a) => a.agentType === 'risk_control');
  const riskControlOn = riskControl?.enabled === true;
  const isGuarded = (agent: AgentListItem) =>
    riskControlOn && agent.agentType !== 'risk_control' && agent.agentType !== 'finance_audit';

  // ===== 汇总指标 =====
  // U6.2：四张指标卡是目录级结论，搜索只筛表格、不改统计——
  // 否则搜一个不存在的名字会让首屏变成「已开通 0/15 · 可开通 0」，与同屏「7 个现在就能开通」自相矛盾。
  const enabledAgents = agents.filter((a) => a.enabled);
  const allDisabledAgents = agents.filter((a) => !a.enabled);
  const enabledList = filteredAgents.filter((a) => a.enabled);
  const disabledList = filteredAgents.filter((a) => !a.enabled);
  const totalActiveTasks = enabledAgents.reduce((sum, a) => sum + (a.activeTaskCount ?? 0), 0);
  const avgSuccessRate = enabledAgents.length > 0
    ? Math.round(enabledAgents.reduce((sum, a) => sum + (a.runStats?.successRate ?? 0), 0) / enabledAgents.length)
    : 0;
  const layerCounts: Record<AgentLayer, { total: number; enabled: number }> = {
    foundation: { total: 0, enabled: 0 },
    traffic: { total: 0, enabled: 0 },
    growth: { total: 0, enabled: 0 },
    support: { total: 0, enabled: 0 },
    standalone: { total: 0, enabled: 0 },
  };
  agents.forEach(a => {
    layerCounts[a.layer].total++;
    if (a.enabled) layerCounts[a.layer].enabled++;
  });

  const columns: ColumnsType<AgentListItem> = [
    {
      title: t('agent.name'),
      dataIndex: 'displayName',
      render: (name: string, record: AgentListItem) => {
        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{
              width: 3, borderRadius: 2, flexShrink: 0, alignSelf: 'stretch',
              background: layerColors[record.layer],
            }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <Typography.Text
                  strong
                  style={{ cursor: 'pointer', color: 'var(--ark-blue)', fontSize: 13 }}
                  onClick={() => navigate(`/agents/${record.agentType}`)}
                >
                  {name}
                </Typography.Text>
                {record.required && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>{t('agent.required')}</Tag>}
                {record.agentType === 'risk_control' && <Tag icon={<SafetyOutlined />} color="orange" style={{ fontSize: 10, margin: 0 }}>{t('agent.systemGuard')}</Tag>}
                {isGuarded(record) && <Tag icon={<SafetyOutlined />} color="green" style={{ fontSize: 10, margin: 0 }}>{t('agent.guarded')}</Tag>}
                {isPremiumLocked(record.agentType) && <Tag icon={<LockOutlined />} color="gold" style={{ fontSize: 10, margin: 0 }}>{t('agent.premium')}</Tag>}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2, maxWidth: 360 }} ellipsis>
                {record.description}
              </Typography.Text>
              {(() => {
                const missingDeps = getMissingDeps(record);
                if (missingDeps.length === 0) return null;
                return (
                  <Typography.Text type="danger" style={{ fontSize: 10, display: 'block', marginTop: 2 }}>
                    {t('agent.dependsOn')}: {missingDeps.join(', ')}
                  </Typography.Text>
                );
              })()}
            </div>
          </div>
        );
      }
    },
    {
      title: t('agent.layer'),
      width: 80,
      dataIndex: 'layer',
      render: (layer: AgentLayer) => (
        <Tag color={layerColors[layer]} style={{ fontSize: 10, margin: 0 }}>
          {t(`agent.layer_${layer}`)}
        </Tag>
      )
    },
    {
      title: t('agent.enable'),
      width: 80,
      render: (_: unknown, record: AgentListItem) => {
        const missingDeps = getMissingDeps(record);
        const disabled = record.required || missingDeps.length > 0;
        const locked = isPremiumLocked(record.agentType);
        return (
          <div>
            <Switch
              size="small"
              checked={locked ? false : record.enabled}
              disabled={disabled || locked || !canUpdateAgents}
              onChange={() => {
                // WS-D (D4): enabling goes through the shared pre-enable drawer;
                // disabling stays a direct toggle.
                if (record.enabled) toggleMutation.mutate(record.agentType);
                else setPreEnableAgent(record);
              }}
            />
            {locked && (
              <Typography.Text type="secondary" style={{ fontSize: 9, display: 'block', marginTop: 2, color: 'var(--ark-amber)' }}>
                <LockOutlined /> {t('agent.unlockToUpgrade')}
              </Typography.Text>
            )}
          </div>
        );
      }
    },
    {
      title: t('tasks.risk'),
      dataIndex: 'riskLevel',
      width: 70,
      render: (risk: string) => <StatusBadge value={risk as AgentConfig['riskLevel']} />
    },
    {
      title: t('agent.colActiveTasks'),
      width: 90,
      align: 'center',
      render: (_: unknown, record: AgentListItem) => {
        const count = record.activeTaskCount ?? 0;
        if (!record.enabled) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
        if (count === 0) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>0</Typography.Text>;
        return (
          <Tag
            color={count >= 3 ? 'blue' : 'green'}
            style={{ cursor: 'pointer', fontWeight: 600, fontSize: 11 }}
            onClick={() => navigate(`/agents/${record.agentType}`)}
          >
            {count}
          </Tag>
        );
      }
    },
    {
      title: t('agent.colSuccessRate'),
      width: 120,
      render: (_: unknown, record: AgentListItem) => {
        const rate = record.runStats?.successRate ?? 0;
        if (!record.enabled) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Progress
              percent={rate}
              size="small"
              showInfo={false}
              style={{ width: 50, margin: 0 }}
              strokeColor={rate >= 90 ? 'var(--ark-green)' : rate >= 70 ? 'var(--ark-orange)' : 'var(--ark-red)'}
            />
            <Typography.Text style={{ fontSize: 10, fontWeight: 600, color: rate >= 90 ? 'var(--ark-green)' : rate >= 70 ? 'var(--ark-orange)' : 'var(--ark-red)' }}>
              {rate}%
            </Typography.Text>
          </div>
        );
      }
    },
    {
      title: t('agent.colRecentRun'),
      width: 90,
      render: (_: unknown, record: AgentListItem) => {
        if (!record.enabled) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
        return (
          <Typography.Text style={{ fontSize: 10 }} type="secondary">
            <ClockCircleOutlined style={{ marginRight: 3, fontSize: 9 }} />
            {getRecentRunText(record.runStats, t)}
          </Typography.Text>
        );
      }
    },
    {
      title: t('agent.properties'),
      width: 120,
      render: (_: unknown, record: AgentListItem) => (
        <Space size={4} wrap>
          {record.needsConfig && <Tooltip title={t('agent.strategyConfig')}><SettingOutlined style={{ fontSize: 12, color: 'var(--ark-blue)' }} /></Tooltip>}
          {record.needsApproval && <Tooltip title={t('agent.needApproval')}><CheckCircleOutlined style={{ fontSize: 12, color: 'var(--ark-orange)' }} /></Tooltip>}
          {record.triggerMode === 'scheduled' && <Tooltip title={t('agent.autoRun')}><ClockCircleOutlined style={{ fontSize: 12, color: 'var(--ark-purple)' }} /></Tooltip>}
          {record.triggerMode === 'event' && <Tooltip title={t('agent.eventRun')}><ThunderboltOutlined style={{ fontSize: 12, color: 'var(--ark-green)' }} /></Tooltip>}
          {record.triggerMode === 'manual' && <Tooltip title={t('agent.manualRun')}><PlayCircleOutlined style={{ fontSize: 12, color: 'var(--ark-muted)' }} /></Tooltip>}
        </Space>
      )
    }
  ];

  if (user?.experience === 'onboarding') {
    return (
      <div className="page-stack">
        <PageHeader title={t('agent.title')} description={t('agent.description')} />
        <StoreConnectionEmptyState description={t('agents.emptyNoStore')} />
      </div>
    );
  }

  // U6.2 三态之一：读取中。目录与套餐状态都没到齐之前不渲染 0 / 「没有待开通项」。
  if (agentsQuery.isLoading || trialStatusQuery.isLoading) {
    return <TablePageSkeleton />;
  }

  // U6.2 三态之二：读取失败。明确「不是没有 Agent」，并就地重试，不用刷新整页。
  if (agentsQuery.isError || trialStatusQuery.isError) {
    return (
      <div className="page-stack">
        <PageHeader title={t('agent.title')} description={t('agent.description')} />
        <Card size="small">
          <EmptyState
            description={t('agentsv2.loadFailed')}
            actionText={t('agentsv2.loadRetry')}
            onAction={() => {
              void agentsQuery.refetch();
              void trialStatusQuery.refetch();
            }}
          />
        </Card>
      </div>
    );
  }

  // U6.2 三态之三：确实为空（读到 0 条），只在成功且为空时出现。
  if (agents.length === 0) {
    return (
      <div className="page-stack">
        <PageHeader title={t('agent.title')} description={t('agent.description')} />
        <Card size="small">
          <EmptyState
            description={t('agentsv2.emptyCatalog')}
            actionText={t('agentsv2.loadRetry')}
            onAction={() => void agentsQuery.refetch()}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('agent.title')}
        description={t('agent.description')}
        actions={
          <Space size={8} wrap>
            <Button icon={<SettingOutlined />} onClick={() => navigate('/setup')}>
              {t('agent.backToSetup')}
            </Button>
            {/* U1.2：页头只留一个主动作，和首屏结论说的是同一件事（还差几个、点一下就开）。 */}
            {disabledAgents > 0 && canUpdateAgents && (
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setBulkModalOpen(true)}>
                {t('agent.bulkEnableCta', { count: disabledAgents })}
              </Button>
            )}
          </Space>
        }
      />

      {/* ===== 首屏结论：现在什么情况 → 还差什么 → 系统会不会自动补齐 ===== */}
      <div className="agent-conclusion">
        <span>
          {disabledAgents > 0
            ? t('agent.conclusionPending', {
                enabled: enabledAgents.length,
                total: agents.length,
                tasks: totalActiveTasks,
                count: disabledAgents,
              })
            : t('agent.conclusionReady', {
                enabled: enabledAgents.length,
                total: agents.length,
                tasks: totalActiveTasks,
              })}
        </span>
        {conclusionNotes.length > 0 && (
          <span className="agent-conclusion-note">{conclusionNotes.join(' · ')}</span>
        )}
      </div>

      {/* ===== 汇总指标 ===== */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <MetricCard
            title={t('agent.enabledAgents')}
            value={enabledAgents.length}
            suffix={`/ ${agents.length}`}
            overlayIcon={<CheckCircleOutlined style={{ color: 'var(--ark-green)' }} />}
            valueStyle={{ color: 'var(--ark-green)' }}
            helper={
              <Space size={6} wrap>
                {Object.entries(layerCounts).filter(([, c]) => c.total > 0).map(([layer, c]) => (
                  <Tooltip key={layer} title={t(`agent.layer_${layer}`)}>
                    <span style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: layerColors[layer as AgentLayer], display: 'inline-block' }} />
                      <span style={{ color: 'var(--ark-muted)' }}>{t(`agent.layer_${layer}`)} {c.enabled}/{c.total}</span>
                    </span>
                  </Tooltip>
                ))}
              </Space>
            }
          />
        </Col>
        <Col xs={12} sm={6}>
          <MetricCard
            title={t('agent.availableAgents')}
            value={allDisabledAgents.length}
            overlayIcon={<PlusOutlined style={{ color: 'var(--ark-blue)' }} />}
            valueStyle={{ color: 'var(--ark-blue)' }}
            helper={disabledAgents > 0 ? `${disabledAgents} ${t('agent.canEnable')}` : t('agent.allEnabled')}
          />
        </Col>
        <Col xs={12} sm={6}>
          <MetricCard
            title={t('agent.colActiveTasks')}
            value={totalActiveTasks}
            overlayIcon={<RocketOutlined style={{ color: 'var(--ark-purple)' }} />}
            valueStyle={{ color: 'var(--ark-purple)' }}
            helper={`${enabledAgents.filter(a => (a.activeTaskCount ?? 0) > 0).length} ${t('agent.agentsRunning')}`}
          />
        </Col>
        <Col xs={12} sm={6}>
          <MetricCard
            title={t('agent.colSuccessRate')}
            value={avgSuccessRate}
            suffix="%"
            overlayIcon={<ThunderboltOutlined style={{ color: avgSuccessRate >= 90 ? 'var(--ark-green)' : 'var(--ark-orange)' }} />}
            valueStyle={{ color: avgSuccessRate >= 90 ? 'var(--ark-green)' : avgSuccessRate >= 70 ? 'var(--ark-orange)' : 'var(--ark-red)' }}
            helper={
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Progress percent={avgSuccessRate} size="small" showInfo={false} style={{ width: 60, margin: 0 }} strokeColor={avgSuccessRate >= 90 ? 'var(--ark-green)' : 'var(--ark-orange)'} />
              </div>
            }
          />
        </Col>
      </Row>

      {/* ===== 搜索栏 ===== */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--ark-muted)' }} />}
          placeholder={t('common.searchPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ maxWidth: 400 }}
        />
      </div>

      {/* U6.2：搜索无结果时给专属空态与下一步，不再只剩一块空白。 */}
      {searchText.trim() && filteredAgents.length === 0 && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <EmptyState
            description={t('agentsv2.emptySearch', { keyword: searchText.trim() })}
            actionText={t('agentsv2.clearSearch')}
            onAction={() => setSearchText('')}
          />
        </Card>
      )}

      {/* WS-D (D4): risk-grouped bulk-enable review modal */}
      <EnableAllReviewModal
        open={bulkModalOpen}
        title={t('agenttrust.bulkEnableTitle')}
        candidates={bulkCandidates}
        confirmLoading={bulkEnableMutation.isPending}
        onConfirm={(selected) => bulkEnableMutation.mutate(selected)}
        onCancel={() => setBulkModalOpen(false)}
      />

      {/* WS-D (D4): shared pre-enable drawer (also used by the agent detail page) */}
      <AgentPreEnableDrawer
        agent={preEnableAgent}
        open={preEnableAgent !== null}
        allAgents={agents}
        confirmLoading={toggleMutation.isPending}
        onConfirm={() => {
          if (preEnableAgent) {
            toggleMutation.mutate(preEnableAgent.agentType, {
              onSuccess: () => setPreEnableAgent(null),
            });
          }
        }}
        onClose={() => setPreEnableAgent(null)}
      />

      {/* ===== 已开通 ===== */}
      {enabledList.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
            padding: '6px 12px', borderRadius: 8, background: 'rgba(22, 163, 74, 0.06)',
            borderLeft: '3px solid var(--ark-green)',
          }}>
            <CheckCircleOutlined style={{ color: 'var(--ark-green)' }} />
            <Typography.Text strong style={{ fontSize: 13 }}>{t('agent.enabledAgents')}</Typography.Text>
            <Tag color="green" style={{ fontSize: 11 }}>{enabledList.length}</Tag>
          </div>
          <Card bodyStyle={{ padding: 0 }}>
            <Table
              rowKey="agentType"
              columns={columns}
              dataSource={enabledList}
              pagination={false}
              size="small"
              showHeader
            />
          </Card>
        </div>
      )}

      {/* ===== 可开通 ===== */}
      {disabledList.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
            padding: '6px 12px', borderRadius: 8, background: 'rgba(37, 99, 235, 0.06)',
            borderLeft: '3px solid var(--ark-blue)',
          }}>
            <PlusOutlined style={{ color: 'var(--ark-blue)' }} />
            <Typography.Text strong style={{ fontSize: 13 }}>{t('agent.availableAgents')}</Typography.Text>
            <Tag color="blue" style={{ fontSize: 11 }}>{disabledList.length}</Tag>
          </div>
          <Card bodyStyle={{ padding: 0 }}>
            <Table
              rowKey="agentType"
              columns={columns}
              dataSource={disabledList}
              pagination={false}
              size="small"
              showHeader
            />
          </Card>
        </div>
      )}

      {/* ===== Agent 运行逻辑图 ===== */}
      <Card
        title={
          <Space>
            <ThunderboltOutlined style={{ color: 'var(--ark-purple)' }} />
            <Typography.Text strong style={{ fontSize: 13 }}>{t('agent.flowTitle')}</Typography.Text>
          </Space>
        }
        style={{ borderTop: '3px solid var(--ark-purple)' }}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          {t('agent.flowDesc')}
        </Typography.Paragraph>

        {/* 汇总条 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
          padding: '8px 14px', background: 'var(--ark-panel-soft)', borderRadius: 8, fontSize: 12,
        }}>
          <CheckCircleOutlined style={{ color: 'var(--ark-green)' }} />
          <Typography.Text style={{ fontSize: 12 }}>
            <span dangerouslySetInnerHTML={{ __html: t('agent.enabledCount', { count: enabledAgents.length, total: agents.length }) }} />
          </Typography.Text>
          <div style={{ flex: 1 }} />
          <Space size={12}>
            <Space size={4}>
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--ark-green)' }} />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('common.enabled')}</Typography.Text>
            </Space>
            <Space size={4}>
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--ark-border)', border: '1.5px dashed var(--ark-muted)' }} />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('common.disabled')}</Typography.Text>
            </Space>
          </Space>
        </div>

        <div className="agent-flow-diagram">
          {/* 第一行: 店铺保活 → 市场情报 → 商品上架 → 素材工厂 */}
          <div className="agent-flow-row">
            {flowNodes.slice(0, 4).map((node, i) => {
              const isEnabled = agents.find(a => a.agentType === node.id)?.enabled;
              return (
                <div key={node.id} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <div className={`agent-flow-node agent-flow-node--${node.layer}${isEnabled ? '' : ' agent-flow-node--disabled'}`} style={{ width: node.w }}>
                    <span>{node.label}</span>
                    <span style={{ fontSize: 9, marginLeft: 4, opacity: isEnabled ? 1 : 0.4 }}>
                      {isEnabled ? '●' : '○'}
                    </span>
                  </div>
                  {i < 3 && <div className={`agent-flow-arrow${isEnabled && agents.find(a => a.agentType === flowNodes[i + 1].id)?.enabled ? '' : ' agent-flow-arrow--dim'}`}>→</div>}
                </div>
              );
            })}
          </div>

          {/* 分叉线 */}
          <div className="agent-flow-row" style={{ justifyContent: 'center', gap: 120 }}>
            <div style={{ width: 80 }} />
            <div className="agent-flow-split">
              <div className="agent-flow-split-vbar" style={{ background: layerColors.foundation }} />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {flowNodes.slice(4, 7).map((node, i) => {
                  const isEnabled = agents.find(a => a.agentType === node.id)?.enabled;
                  return (
                    <React.Fragment key={node.id}>
                      {i > 0 && <div style={{ width: 2, height: 6, background: 'var(--ark-border)' }} />}
                      {i === 0 && <div style={{ width: 2, height: 12, background: 'var(--ark-border)' }} />}
                      <div className={`agent-flow-node agent-flow-node--traffic${isEnabled ? '' : ' agent-flow-node--disabled'}`} style={{ width: 90 }}>
                        <span>{node.label}</span>
                        <span style={{ fontSize: 9, marginLeft: 4, opacity: isEnabled ? 1 : 0.4 }}>
                          {isEnabled ? '●' : '○'}
                        </span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 侧边栏: 增值运营 + 库存预警 */}
          <div className="agent-flow-side">
            <div style={{ textAlign: 'center' }}>
              <div className={`agent-flow-node agent-flow-node--growth${agents.filter(a => a.layer === 'growth').some(a => a.enabled) ? '' : ' agent-flow-node--disabled'}`} style={{ width: 130 }}>
                <span>{t('agent.flowGrowth')}</span>
                <span style={{ fontSize: 9, marginLeft: 4, opacity: agents.filter(a => a.layer === 'growth').some(a => a.enabled) ? 1 : 0.4 }}>
                  {agents.filter(a => a.layer === 'growth').some(a => a.enabled) ? '●' : '○'}
                </span>
              </div>
              <div className="agent-flow-sublist">
                {growthSubLabels.map((s) => (
                  <Tag key={s} color="green" style={{ fontSize: 10, margin: '1px 2px' }}>{s}</Tag>
                ))}
              </div>
            </div>
            <div style={{ textAlign: 'center', marginTop: 8 }}>
              <div className={`agent-flow-node agent-flow-node--support${agents.find(a => a.agentType === 'inventory_alert')?.enabled ? '' : ' agent-flow-node--disabled'}`} style={{ width: 90 }}>
                <span>{t('agent.inventory_alert')}</span>
                <span style={{ fontSize: 9, marginLeft: 4, opacity: agents.find(a => a.agentType === 'inventory_alert')?.enabled ? 1 : 0.4 }}>
                  {agents.find(a => a.agentType === 'inventory_alert')?.enabled ? '●' : '○'}
                </span>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 4 }}>
                {t('agent.flowFeedback')}
              </Typography.Text>
            </div>
          </div>

          {/* 底部: 风险控制 外框包裹 */}
          <div className="agent-flow-guard">
            <Tag icon={<SafetyOutlined />} color={riskControlOn ? 'green' : 'orange'} style={{ fontSize: 10 }}>
              {t('agent.flowRiskControl')} {riskControlOn ? t('agent.guarding') : t('agent.notGuarding')}
            </Tag>
          </div>

          {/* 最底: 财务对账 */}
          <div className="agent-flow-row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <div className={`agent-flow-node agent-flow-node--standalone${agents.find(a => a.agentType === 'finance_audit')?.enabled ? '' : ' agent-flow-node--disabled'}`} style={{ width: 100 }}>
              <span>{t('agent.finance_audit')}</span>
              <span style={{ fontSize: 9, marginLeft: 4, opacity: agents.find(a => a.agentType === 'finance_audit')?.enabled ? 1 : 0.4 }}>
                {agents.find(a => a.agentType === 'finance_audit')?.enabled ? '●' : '○'}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
