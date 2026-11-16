/**
 * File: SetupConfigPage.tsx
 * Purpose: WS-D (D1/D2/D3) scenario-first activation surface. The 5 confirmed scenario
 * bundles are the primary configuration model: each card shows its member agents,
 * aggregate risk, and a visible L1/L2/L3 autonomy dial; activation goes through a
 * risk-grouped review modal; per-store parameter overrides live in an explicit drawer.
 * Earned-trust suggestions and the weekly digest stub implement the S3 trust journey.
 *
 * Author: Michael Lee (WS-D)
 * Created: 2026-07-22 (rebuilt from the previous global-vs-per-store hybrid page;
 *   fixes the setState-during-render lazy init and the silent post-save collapse)
 */
import {
  CheckCircleOutlined,
  DollarOutlined,
  InboxOutlined,
  PlusOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingOutlined,
  SmileOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { agentsApi } from '../../api/agents';
import {
  AUTONOMY_MIN_DECIDED,
  getAutonomyAdvice,
  type AutonomyAdvice,
} from '../../api/autonomyAdvice';
import {
  computeEnableClosure,
  scenarioDefinitions,
  scenarioRiskLevel,
  scenariosApi,
  type ScenarioDefinition,
} from '../../api/scenarioData';
import { storesApi } from '../../api/stores';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import { EnableAllReviewModal } from '../../components/agents/EnableAllReviewModal';
import { StoreAgentProfileCard } from '../../components/agents/StoreAgentProfileCard';
import { PageHeader } from '../../components/PageHeader';
import type {
  AgentType,
  AutonomyLevel,
  ScenarioKey,
  ScenarioStoreOverride,
} from '../../types/domain';

const SCENARIO_ICONS: Record<ScenarioKey, React.ReactNode> = {
  pricing_promo: <DollarOutlined />,
  cs_aftersales: <SmileOutlined />,
  inventory: <InboxOutlined />,
  fulfillment_risk: <SafetyCertificateOutlined />,
  listing_content: <ShoppingOutlined />,
};

/**
 * D-nav/B: each scenario's "manual view" — the business-line pages that are the手动兜底/
 * 专家视图 of this scenario. They live in the 业务运营 nav group but are narratively
 * owned by the scenario, so they're reachable straight from the card.
 */
const SCENARIO_MANUAL_VIEWS: Record<ScenarioKey, { to: string; labelKey: string }[]> = {
  pricing_promo: [
    { to: '/promotions', labelKey: 'nav.promotions' },
    { to: '/ads', labelKey: 'nav.ads' },
  ],
  cs_aftersales: [
    { to: '/customer-service', labelKey: 'nav.customerService' },
    { to: '/reviews', labelKey: 'nav.reviews' },
  ],
  inventory: [{ to: '/inventory', labelKey: 'nav.inventory' }],
  listing_content: [{ to: '/livestream', labelKey: 'nav.live' }],
  fulfillment_risk: [],
};

const AUTONOMY_LEVELS: AutonomyLevel[] = ['L1', 'L2', 'L3'];

export function SetupConfigPage() {
  const { t } = useI18n();
  const { can } = usePermission();
  const navigate = useNavigate();
  const canUpdateSetup = can('setup', 'update');
  const canCreateStore = can('stores', 'create');
  const queryClient = useQueryClient();

  const { data: storesData = [] } = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list() });
  const { data: allAgents = [] } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.list() });
  const { data: scenarios = [] } = useQuery({ queryKey: ['scenarios'], queryFn: scenariosApi.list });
  // P31.2：信任累积不再读静态计数，改为近 7 天账本 + 升级的实测证据。
  const { data: autonomyAdvice = [] } = useQuery({
    queryKey: ['autonomyAdvice'],
    queryFn: () => getAutonomyAdvice(),
  });
  const adviceByScenario = useMemo(
    () => new Map(autonomyAdvice.map((advice) => [advice.scenarioKey, advice])),
    [autonomyAdvice],
  );
  const { data: digest } = useQuery({ queryKey: ['scenario-digest'], queryFn: scenariosApi.getWeeklyDigest });
  const attentionStoreCount = storesData.filter((store) =>
    ['login_required', 'expired', 'pending_login', 'revoked'].includes(store.status)
  ).length;

  // ===== 场景激活（风险分组确认弹窗） =====
  const [activatingKey, setActivatingKey] = useState<ScenarioKey | null>(null);
  const activatingDef = scenarioDefinitions.find((d) => d.key === activatingKey) ?? null;
  const activatingCandidates = useMemo(() => {
    if (!activatingDef) return [];
    return activatingDef.agents
      .map((at) => allAgents.find((a) => a.agentType === at))
      .filter((a): a is NonNullable<typeof a> => Boolean(a) && !a!.enabled);
  }, [activatingDef, allAgents]);
  const activatingExtraDeps = useMemo(
    () => computeEnableClosure(activatingCandidates.map((a) => a.agentType)).extraDeps,
    [activatingCandidates]
  );

  const activateMutation = useMutation({
    mutationFn: async (input: { key: ScenarioKey; selected: AgentType[] }) => {
      const { ordered } = computeEnableClosure(input.selected);
      if (ordered.length > 0) await agentsApi.batchEnable(ordered);
      await scenariosApi.setEnabled(input.key, true);
      return ordered.length;
    },
    onSuccess: (count, input) => {
      const def = scenarioDefinitions.find((d) => d.key === input.key);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['scenarios'] });
      message.success(t('scenario.enableSuccess', { name: def ? t(def.nameKey) : input.key, count }));
      // 保持页面上下文：只关闭弹窗，不重置其他状态
      setActivatingKey(null);
    },
    onError: (error: Error) => message.error(error.message),
  });

  const disableMutation = useMutation({
    mutationFn: async (key: ScenarioKey) => {
      const def = scenarioDefinitions.find((d) => d.key === key);
      if (def) {
        // 仅停用：非必须启用、且不被其他已启用场景使用的成员 Agent
        const otherEnabledAgents = new Set(
          scenarios
            .filter((s) => s.enabled && s.key !== key)
            .flatMap((s) => scenarioDefinitions.find((d) => d.key === s.key)?.agents ?? [])
        );
        for (const at of def.agents) {
          const agent = allAgents.find((a) => a.agentType === at);
          if (agent?.enabled && !agent.required && !otherEnabledAgents.has(at)) {
            await agentsApi.toggle(at);
          }
        }
      }
      await scenariosApi.setEnabled(key, false);
    },
    onSuccess: (_data, key) => {
      const def = scenarioDefinitions.find((d) => d.key === key);
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['scenarios'] });
      message.success(t('scenario.disableSuccess', { name: def ? t(def.nameKey) : key }));
    },
    onError: (error: Error) => message.error(error.message),
  });

  // ===== 自主等级（D3） =====
  const autonomyMutation = useMutation({
    mutationFn: (input: { key: ScenarioKey; level: AutonomyLevel }) =>
      scenariosApi.setAutonomy(input.key, input.level),
    onSuccess: (_state, input) => {
      const def = scenarioDefinitions.find((d) => d.key === input.key);
      queryClient.invalidateQueries({ queryKey: ['scenarios'] });
      queryClient.invalidateQueries({ queryKey: ['autonomyAdvice'] });
      message.success(
        t('scenario.autonomyChanged', {
          name: def ? t(def.nameKey) : input.key,
          level: t(`scenario.autonomy${input.level}`),
        })
      );
    },
  });

  // ===== 店铺级策略（P1：店铺自主等级覆盖场景默认） =====
  const dismissMutation = useMutation({
    mutationFn: (key: ScenarioKey) => scenariosApi.dismissTrustSuggestion(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scenarios'] });
      message.info(t('agenttrust.suggestionDismissed'));
    },
  });

  // ===== 按店铺覆盖（D2，显式抽屉） =====
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideScenario, setOverrideScenario] = useState<ScenarioKey>('pricing_promo');
  const [overrideStoreId, setOverrideStoreId] = useState<string>('');
  const [overrideValues, setOverrideValues] = useState<ScenarioStoreOverride>({});

  const overrideDef = scenarioDefinitions.find((d) => d.key === overrideScenario)!;

  const defaultsFor = (def: ScenarioDefinition): ScenarioStoreOverride =>
    Object.fromEntries(def.overrideFields.map((f) => [f.id, f.defaultValue]));

  const loadOverride = (key: ScenarioKey, storeId: string) => {
    const def = scenarioDefinitions.find((d) => d.key === key)!;
    const state = scenarios.find((s) => s.key === key);
    const existing = storeId ? state?.storeOverrides[storeId] : undefined;
    setOverrideValues({ ...defaultsFor(def), ...existing });
  };

  const openOverrideDrawer = (key: ScenarioKey, storeId?: string) => {
    const targetStore = storeId ?? (storesData[0] ? String(storesData[0].id) : '');
    setOverrideScenario(key);
    setOverrideStoreId(targetStore);
    setOverrideOpen(true);
    loadOverride(key, targetStore);
  };

  const saveOverrideMutation = useMutation({
    mutationFn: (input: { key: ScenarioKey; storeId: string; values: ScenarioStoreOverride }) =>
      scenariosApi.saveStoreOverride(input.key, input.storeId, input.values),
    onSuccess: (_state, input) => {
      const storeName = storesData.find((s) => String(s.id) === input.storeId)?.name ?? input.storeId;
      queryClient.invalidateQueries({ queryKey: ['scenarios'] });
      // 保持上下文：抽屉与所选店铺保持打开状态（修复旧版保存后页面收起的问题）
      message.success(t('scenario.overrideSaved', { store: storeName }));
    },
  });

  const handleSaveOverride = () => {
    if (!overrideStoreId) return;
    // 交叉字段校验
    for (const field of overrideDef.overrideFields) {
      const value = overrideValues[field.id];
      if (field.type !== 'number' || typeof value !== 'number') continue;
      if (field.mustBePositive && value <= 0) {
        message.error(t('scenario.overrideInvalidPositive', { field: t(field.labelKey) }));
        return;
      }
      if (field.mustNotExceed) {
        const other = overrideValues[field.mustNotExceed];
        const otherField = overrideDef.overrideFields.find((f) => f.id === field.mustNotExceed);
        if (typeof other === 'number' && value > other) {
          message.error(
            t('scenario.overrideInvalidExceed', {
              field: t(field.labelKey),
              other: otherField ? t(otherField.labelKey) : field.mustNotExceed,
            })
          );
          return;
        }
      }
    }
    saveOverrideMutation.mutate({ key: overrideScenario, storeId: overrideStoreId, values: overrideValues });
  };

  /** P31.2：把建议口径摊开成一行可核对的话，复盘卡与 /setup 共用同一套阈值。 */
  const adviceReasonText = (advice: AutonomyAdvice) => {
    const { evidence } = advice;
    const level = t(`scenario.autonomy${advice.current}`);
    switch (advice.reason) {
      case 'insufficient_sample':
        return t('agenttrust.adviceInsufficient', {
          decided: evidence.decided,
          human: evidence.humanDecisions,
          required: AUTONOMY_MIN_DECIDED,
          level,
        });
      case 'loosen_strong':
        return t('agenttrust.adviceLoosenBody', {
          fulfillment: evidence.fulfillmentRate ?? '—',
          failure: evidence.failureRate ?? '—',
          override: evidence.overrideRate ?? '—',
        });
      case 'tighten_failure':
        return t('agenttrust.adviceTightenFailure', { rate: evidence.failureRate ?? 0 });
      case 'tighten_override':
        return t('agenttrust.adviceTightenOverride', { rate: evidence.overrideRate ?? 0 });
      default:
        return t('agenttrust.adviceEvidence', {
          decided: evidence.decided,
          fulfillment: evidence.fulfillmentRate ?? '—',
          override: evidence.overrideRate ?? '—',
          level,
        });
    }
  };

  return (
    <div className="page-stack">
      <PageHeader
        title={t('scenario.pageTitle')}
        description={t('scenario.pageDesc')}
        actions={
          canCreateStore ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/stores/onboarding?journey=import')}>
              {t('setup.addStore')}
            </Button>
          ) : undefined
        }
      />

      {/* D2: 配置层级说明 — 修复旧版"全局适用"与按店铺存储的矛盾 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('scenario.hierarchyNote')}
        description={t('scenario.scopeGlobal')}
      />

      {/* ===== 场景卡片（D1） ===== */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {scenarioDefinitions.map((def) => {
          const state = scenarios.find((s) => s.key === def.key);
          const scenarioResult = digest?.perScenario.find((row) => row.key === def.key);
          const memberAgents = def.agents
            .map((at) => allAgents.find((a) => a.agentType === at))
            .filter((a): a is NonNullable<typeof a> => Boolean(a));
          const enabledCount = memberAgents.filter((a) => a.enabled).length;
          const risk = scenarioRiskLevel(def);
          const riskColor = risk === 'high' ? 'red' : risk === 'medium' ? 'orange' : 'green';
          const riskLabel = risk === 'high' ? t('agent.highRisk') : risk === 'medium' ? t('agent.mediumRisk') : t('agent.lowRisk');
          const overrideCount = state ? Object.keys(state.storeOverrides).length : 0;
          const advice = adviceByScenario.get(def.key);
          // P31.2：只有「已启用」且证据支持动等级的场景才提示；维持当前等级时只展示证据。
          const showTrustSuggestion =
            Boolean(state?.enabled) &&
            Boolean(advice) &&
            advice!.direction !== 'keep' &&
            !state?.trustSuggestionDismissed;
          const showEvidenceLine = Boolean(state?.enabled) && Boolean(advice);

          return (
            <Col xs={24} lg={12} key={def.key}>
              <Card
                style={{ borderLeft: `4px solid ${def.color}`, height: '100%' }}
                title={
                  <Space>
                    <span style={{ color: def.color, fontSize: 16 }}>{SCENARIO_ICONS[def.key]}</span>
                    <Typography.Text strong>{t(def.nameKey)}</Typography.Text>
                    <Tag color={riskColor} style={{ fontSize: 10 }}>{t('scenario.riskAggregate')}: {riskLabel}</Tag>
                  </Space>
                }
                extra={
                  state?.enabled ? (
                    <Tag color="green" icon={<CheckCircleOutlined />}>{t('scenario.enabled')}</Tag>
                  ) : (
                    <Tag>{t('scenario.notEnabled')}</Tag>
                  )
                }
              >
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                  {t(def.descKey)}
                </Typography.Paragraph>

                {/* Results-first: an enabled scenario shows what it did for the merchant;
                    a disabled one shows what it will do, in plain outcome language. */}
                {state?.enabled && scenarioResult ? (
                  <div style={{
                    marginBottom: 12, padding: '8px 10px', borderRadius: 6,
                    background: 'color-mix(in srgb, var(--ark-green) 8%, var(--ark-panel))',
                  }}>
                    <Typography.Text style={{ fontSize: 12 }}>
                      <ThunderboltOutlined style={{ color: 'var(--ark-green)', marginRight: 4 }} />
                      {t('scenario.thisWeekResult', { actions: scenarioResult.actions, hours: scenarioResult.hoursSaved })}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                      {t(scenarioResult.outcomeKey)}
                    </Typography.Text>
                  </div>
                ) : (
                  <div style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('scenario.willDo')} {t(`scenario.preview_${def.key}`)}。
                    </Typography.Text>
                  </div>
                )}

                {/* 成员 Agent */}
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {t('scenario.includedAgents')}（{t('scenario.agentCount', { count: def.agents.length })}，{enabledCount}/{def.agents.length} {t('common.enabled')}）:
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {memberAgents.map((agent) => (
                      <Link key={agent.agentType} to={`/agents/${agent.agentType}`}>
                        <Tag
                          color={agent.enabled ? 'green' : 'default'}
                          style={{ fontSize: 11, cursor: 'pointer' }}
                        >
                          {t(`agent.${agent.agentType}`)}
                        </Tag>
                      </Link>
                    ))}
                  </div>
                </div>

                {/* 手动视图 — the business-line pages this scenario owns (手动兜底/专家视图) */}
                {SCENARIO_MANUAL_VIEWS[def.key].length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {t('scenario.manualViews')}:
                    </Typography.Text>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
                      {SCENARIO_MANUAL_VIEWS[def.key].map((view) => (
                        <Link key={view.to} to={view.to} style={{ fontSize: 12 }}>
                          {t(view.labelKey)} →
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* D3: 自主等级拨盘 */}
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                    {t('scenario.autonomyLabel')}
                  </Typography.Text>
                  <Segmented
                    size="small"
                    disabled={!state?.enabled || !canUpdateSetup}
                    value={state?.autonomy ?? 'L1'}
                    options={AUTONOMY_LEVELS.map((level) => ({
                      label: t(`scenario.autonomy${level}`),
                      value: level,
                    }))}
                    onChange={(value) =>
                      autonomyMutation.mutate({ key: def.key, level: value as AutonomyLevel })
                    }
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 4 }}>
                    {t(`scenario.autonomy${state?.autonomy ?? 'L1'}Hint`)}
                  </Typography.Text>
                  {/* S4：讲清楚“这个等级下，哪些动作会直接执行、不再找人” */}
                  <Typography.Text style={{ fontSize: 10, display: 'block', marginTop: 2 }}>
                    {t('setup.autonomyAutoPreview', {
                      risk: t(`setup.autoRisk_${state?.autonomy ?? 'L1'}`),
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 2 }}>
                    {t('setup.autonomyScopeNote')}
                    <Link to="/dashboard" style={{ marginLeft: 8 }}>
                      {t('setup.viewInDashboard')}
                    </Link>
                  </Typography.Text>
                  {/* P31.2：把「信任累积」的实测依据摊开，人能看到建议背后的数字 */}
                  {showEvidenceLine && advice && (
                    <Typography.Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 2 }}>
                      {adviceReasonText(advice)}
                    </Typography.Text>
                  )}
                </div>

                {/* P31.2: 信任累积建议 — 证据来自近 7 天账本与人工决策，不再读静态计数 */}
                {showTrustSuggestion && state && advice && (
                  <Alert
                    type={advice.direction === 'loosen' ? 'success' : 'warning'}
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={t(
                      advice.direction === 'loosen'
                        ? 'agenttrust.adviceLoosenTitle'
                        : 'agenttrust.adviceTightenTitle',
                      {
                        name: t(def.nameKey),
                        from: t(`scenario.autonomy${advice.current}`),
                        to: t(`scenario.autonomy${advice.recommended}`),
                      },
                    )}
                    description={
                      <Typography.Text style={{ fontSize: 12 }}>
                        {adviceReasonText(advice)}
                      </Typography.Text>
                    }
                    action={
                      canUpdateSetup ? (
                        <Space direction="vertical" size={4}>
                          <Button
                            size="small"
                            type={advice.direction === 'loosen' ? 'primary' : 'default'}
                            danger={advice.direction === 'tighten'}
                            onClick={() =>
                              autonomyMutation.mutate({ key: def.key, level: advice.recommended })
                            }
                          >
                            {t(
                              advice.direction === 'loosen'
                                ? 'agenttrust.applySuggestion'
                                : 'agenttrust.adviceTightenOne',
                            )}
                          </Button>
                          <Button size="small" onClick={() => dismissMutation.mutate(def.key)}>
                            {t('agenttrust.dismissSuggestion')}
                          </Button>
                        </Space>
                      ) : null
                    }
                  />
                )}

                {/* 操作 */}
                <Space wrap>
                  {canUpdateSetup && (state?.enabled ? (
                    <Popconfirm
                      title={t('scenario.disable')}
                      description={t('scenario.disableConfirm')}
                      okText={t('common.confirm')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => disableMutation.mutate(def.key)}
                    >
                      <Button size="small" danger loading={disableMutation.isPending}>
                        {t('scenario.disable')}
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      style={{ background: def.color }}
                      onClick={() => setActivatingKey(def.key)}
                    >
                      {t('scenario.enable')}
                    </Button>
                  ))}
                  <Button
                    size="small"
                    icon={<SettingOutlined />}
                    onClick={() => openOverrideDrawer(def.key)}
                    disabled={storesData.length === 0}
                  >
                    {t('scenario.perStoreConfig')}
                  </Button>
                  {overrideCount > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {t('scenario.storeCount', { count: overrideCount })}
                    </Typography.Text>
                  )}
                </Space>
              </Card>
            </Col>
          );
        })}
      </Row>

      {/* ===== B: Agent 店铺化 — 默认折叠，避免和场景卡抢注意力 ===== */}
      <Collapse
        size="small"
        style={{ marginBottom: 16, background: 'var(--ark-panel)' }}
        items={[
          {
            key: 'agentProfiles',
            label: (
              <Space size={6}>
                <RobotOutlined />
                <Typography.Text strong style={{ fontSize: 13 }}>{t('setup.agentProfileTitle')}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('setup.agentProfileHint')}</Typography.Text>
              </Space>
            ),
            children: <StoreAgentProfileCard embedded />,
          },
        ]}
      />

      {/* ===== 店铺只做摘要，管理动作统一回 /stores ===== */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space size={8} wrap>
          <ShopOutlined />
          <Typography.Text>
            {t('setup.storeSummary', { total: storesData.length, attention: attentionStoreCount })}
          </Typography.Text>
          <Link to="/stores">{t('setup.goStoreManagement')} →</Link>
        </Space>
      </Card>

      {/* ===== 场景激活确认弹窗（复用风险分组审查组件） ===== */}
      <EnableAllReviewModal
        open={activatingKey !== null}
        title={activatingDef ? t('scenario.activateTitle', { name: t(activatingDef.nameKey) }) : ''}
        intro={t('scenario.activateAgentsIntro')}
        candidates={activatingCandidates}
        extraDeps={activatingExtraDeps}
        confirmLoading={activateMutation.isPending}
        onConfirm={(selected) => {
          if (activatingKey) activateMutation.mutate({ key: activatingKey, selected });
        }}
        onCancel={() => setActivatingKey(null)}
      />

      {/* ===== 按店铺覆盖抽屉（D2） ===== */}
      <Drawer
        title={t('scenario.perStoreTitle', { name: t(overrideDef.nameKey) })}
        open={overrideOpen}
        width={420}
        onClose={() => setOverrideOpen(false)}
        footer={canUpdateSetup ? (
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              onClick={() => setOverrideValues(defaultsFor(overrideDef))}
            >
              {t('scenario.resetOverride')}
            </Button>
            <Button
              type="primary"
              loading={saveOverrideMutation.isPending}
              disabled={!overrideStoreId}
              onClick={handleSaveOverride}
            >
              {t('scenario.saveOverride')}
            </Button>
          </Space>
        ) : null}
      >
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('scenario.perStoreNote')} />

        <div style={{ marginBottom: 16 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            {t('scenario.selectStore')}
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            value={overrideStoreId || undefined}
            placeholder={t('scenario.selectStore')}
            onChange={(storeId: string) => {
              setOverrideStoreId(storeId);
              loadOverride(overrideScenario, storeId);
            }}
            options={storesData.map((s) => ({ value: String(s.id), label: `${s.name}（${s.platform}）` }))}
          />
        </div>

        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {overrideDef.overrideFields.map((field) => (
            <div key={field.id}>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                {t(field.labelKey)}
              </Typography.Text>
              {field.type === 'number' && (
                <InputNumber
                  style={{ width: '100%' }}
                  disabled={!canUpdateSetup}
                  min={field.min}
                  max={field.max}
                  prefix={field.prefix}
                  suffix={field.suffix}
                  value={typeof overrideValues[field.id] === 'number' ? (overrideValues[field.id] as number) : undefined}
                  onChange={(v) => setOverrideValues((prev) => ({ ...prev, [field.id]: v ?? 0 }))}
                />
              )}
              {field.type === 'switch' && (
                <Switch
                  checked={Boolean(overrideValues[field.id])}
                  disabled={!canUpdateSetup}
                  onChange={(checked) => setOverrideValues((prev) => ({ ...prev, [field.id]: checked }))}
                />
              )}
              {field.type === 'text' && (
                <Input
                  value={typeof overrideValues[field.id] === 'string' ? (overrideValues[field.id] as string) : ''}
                  disabled={!canUpdateSetup}
                  onChange={(e) => setOverrideValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </Space>
      </Drawer>
    </div>
  );
}
