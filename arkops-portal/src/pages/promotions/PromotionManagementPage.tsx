/**
 * Promotion Management Page — V1.1
 * Full-page promotion management with calendar/list views and create drawer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CalendarOutlined, FireOutlined, PlusOutlined, RobotOutlined,
  ScheduleOutlined, ThunderboltOutlined, UnorderedListOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Col, Row, Segmented, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { promotionsApi } from '../../api/promotions';
import { storesApi } from '../../api/stores';
import { useI18n } from '../../app/i18n';
import { useStoreScope } from '../../app/storeScope';
import { usePermission } from '../../app/usePermission';
import { PageHeader } from '../../components/PageHeader';
import { StoreConnectionEmptyState } from '../../components/StoreConnectionEmptyState';
import { CalendarView } from './CalendarView';
import { CreatePromotionDrawer } from './CreatePromotionDrawer';
import type { PromotionDefaults } from './CreatePromotionDrawer';
import { PromotionList } from './PromotionList';
import type { PromotionType } from '../../types/domain';

function formatCurrency(n: number): string {
  if (n >= 10000) return `¥${(n / 10000).toFixed(1)}万`;
  return `¥${n.toLocaleString()}`;
}

export function PromotionManagementPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { scope } = useStoreScope();
  const { can } = usePermission();
  const canCreatePromotion = can('promotions', 'create');
  const canUpdatePromotion = can('promotions', 'update');
  // Store filtering is shell-level (D3); the page no longer owns a store select.
  const storeFilter = scope === 'all' ? undefined : scope;
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('list');
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<PromotionDefaults | null>(null);
  // Agent automation
  const [agentEnabled, setAgentEnabled] = useState(() => promotionsApi.getAutomationEnabled());
  const [agentSuggesting, setAgentSuggesting] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<{ name: string; type: string; reason: string; discount: number }[]>([]);

  const { data: stores = [] } = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });
  const { data: campaigns = [] } = useQuery({
    queryKey: ['promotions', storeFilter, statusFilter, typeFilter, search],
    queryFn: () => promotionsApi.list({ storeId: storeFilter, status: statusFilter, type: typeFilter, search }),
  });
  const { data: stats } = useQuery({ queryKey: ['promotionStats', storeFilter], queryFn: () => promotionsApi.getStats(storeFilter) });
  const { data: products = [] } = useQuery({ queryKey: ['products'], queryFn: () => import('../../api/products').then((m) => m.productsApi.list()) });

  const createMutation = useMutation({
    mutationFn: promotionsApi.create,
    onSuccess: () => {
      setCreateOpen(false);
      message.success(t('promotions.created'));
      queryClient.invalidateQueries({ queryKey: ['promotions'] });
      queryClient.invalidateQueries({ queryKey: ['promotionStats'] });
    },
  });

  // Agent: analyze and suggest promotions — 建议基于真实商品，不虚构库存天数与竞品价格。
  const handleAgentSuggest = async () => {
    if (products.length === 0) {
      message.info(t('promotions.noProductsForSuggestion'));
      return;
    }
    setAgentSuggesting(true);
    await new Promise((r) => setTimeout(r, 1200));
    const picks = products.slice(0, 3);
    const drafts = [
      { name: t('promotions.suggestionFlashName', { name: picks[0].name }), type: 'flash_sale' as const, reason: t('promotions.suggestionFlashReason'), discount: 40 },
      { name: t('promotions.suggestionBundleName', { name: picks[1]?.name ?? picks[0].name }), type: 'full_reduction' as const, reason: t('promotions.suggestionBundleReason'), discount: 20 },
      { name: t('promotions.suggestionCouponName', { name: picks[2]?.name ?? picks[0].name }), type: 'coupon' as const, reason: t('promotions.suggestionCouponReason'), discount: 25 },
    ];
    setAiSuggestions(drafts);
    setAgentSuggesting(false);
    message.success(t('promotions.agentSuggested'));
  };

  const openCreateDrawer = () => {
    setCreateDefaults(null);
    setCreateOpen(true);
  };

  const handleApplySuggestion = (suggestion: typeof aiSuggestions[0]) => {
    setCreateDefaults({ name: suggestion.name, type: suggestion.type as PromotionType, discount: suggestion.discount });
    setCreateOpen(true);
    message.info(t('promotions.agentApplyHint', { name: suggestion.name }));
  };

  const closeCreateDrawer = () => {
    setCreateOpen(false);
    setCreateDefaults(null);
  };

  if (stores.length === 0) {
    return <StoreConnectionEmptyState description={t('promotions.emptyNoStore')} />;
  }

  const activeCount = stats?.active ?? 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PageHeader
        title={t('nav.promotions')}
        description={t('promotions.subtitle', { total: campaigns.length })}
        actions={
          canCreatePromotion ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateDrawer}>
              {t('promotions.create')}
            </Button>
          ) : undefined
        }
      />

      {/* Agent card: promotion_campaign */}
      <Card
        size="small"
        style={{ margin: '0 24px 12px', borderLeft: '3px solid var(--ark-purple)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <RobotOutlined style={{ color: 'var(--ark-purple)', fontSize: 16 }} />
            <Typography.Text strong>{t('promotions.agentTitle')}</Typography.Text>
            <Tag color="purple">{t('agent.promotion_campaign')}</Tag>
            <Tag color={agentEnabled ? 'green' : 'default'}>{agentEnabled ? t('promotions.agentActive') : t('promotions.agentPaused')}</Tag>
          </Space>
          <Space>
            <Switch
              checked={agentEnabled}
              onChange={(checked) => {
                setAgentEnabled(checked);
                promotionsApi.setAutomationEnabled(checked);
                message.success(t('promotions.agentSwitchSaved', { state: checked ? t('promotions.agentActive') : t('promotions.agentPaused') }));
              }}
              disabled={!canUpdatePromotion}
              checkedChildren="ON"
              unCheckedChildren="OFF"
              size="small"
            />
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              type="primary"
              ghost
              onClick={handleAgentSuggest}
              loading={agentSuggesting}
              disabled={!agentEnabled}
            >
              {t('promotions.agentSuggest')}
            </Button>
          </Space>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          {t('promotions.agentDescription')}
        </Typography.Text>

        {/* AI suggestions */}
        {aiSuggestions.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              <RobotOutlined style={{ marginRight: 4 }} />{t('promotions.aiSuggestions')}：
            </Typography.Text>
            {aiSuggestions.map((s, i) => (
              <Card key={i} size="small" style={{ background: 'var(--ark-bg-sink)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <Space size={4}>
                      <Typography.Text strong style={{ fontSize: 13 }}>{s.name}</Typography.Text>
                      <Tag color={s.type === 'flash_sale' ? 'red' : s.type === 'coupon' ? 'orange' : 'blue'}>
                        {t(`promotions.${s.type}`)}
                      </Tag>
                    </Space>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 0, marginTop: 2 }}>
                      {s.reason}
                    </Typography.Paragraph>
                  </div>
                  {canCreatePromotion && (
                    <Button size="small" type="link" onClick={() => handleApplySuggestion(s)}>
                      {t('promotions.agentQuickCreate')} →
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>

      {/* Stats */}
      <Row gutter={[12, 12]} style={{ padding: '0 24px', marginBottom: 12 }}>
        <Col xs={12} sm={4}>
          <Card size="small"><StatBox icon={<FireOutlined style={{ color: '#ff4d4f' }} />} label={t('promotions.active')} value={stats?.active ?? 0} color="#ff4d4f" /></Card>
        </Col>
        <Col xs={12} sm={4}>
          <Card size="small"><StatBox icon={<ScheduleOutlined style={{ color: '#faad14' }} />} label={t('promotions.scheduled')} value={stats?.scheduled ?? 0} color="#faad14" /></Card>
        </Col>
        <Col xs={12} sm={4}>
          <Card size="small"><StatBox icon={<ThunderboltOutlined style={{ color: 'var(--ark-text-tertiary)' }} />} label={t('promotions.ended')} value={stats?.ended ?? 0} color="var(--ark-text-tertiary)" /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><StatBox icon={null} label={t('promotions.totalRevenue')} value={formatCurrency(stats?.totalRevenue ?? 0)} color="var(--ark-purple)" /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><StatBox icon={null} label={t('promotions.avgRoi')} value={`${stats?.totalRoi ?? 0}x`} color="var(--ark-green)" /></Card>
        </Col>
      </Row>

      {/* Active campaign alert */}
      {activeCount > 0 && (
        <Alert
          type="info"
          showIcon
          icon={<FireOutlined />}
          message={t('promotions.activeAlert', { count: activeCount })}
          style={{ margin: '0 24px 12px' }}
        />
      )}

      {/* Toolbar */}
      <div style={{ padding: '0 24px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            allowClear
            placeholder={t('promotions.filterStatus')}
            style={{ width: 120 }}
            options={[
              { value: 'active', label: t('promotions.active') },
              { value: 'scheduled', label: t('promotions.scheduled') },
              { value: 'ended', label: t('promotions.ended') },
            ]}
          />
          <Select
            value={typeFilter}
            onChange={setTypeFilter}
            allowClear
            placeholder={t('promotions.filterType')}
            style={{ width: 140 }}
            options={[
              { value: 'flash_sale', label: t('promotions.flashSale') },
              { value: 'seckill', label: t('promotions.seckill') },
              { value: 'coupon', label: t('promotions.coupon') },
              { value: 'bundle', label: t('promotions.bundle') },
              { value: 'full_reduction', label: t('promotions.fullReduction') },
            ]}
          />
        </div>
        <Segmented
          size="small"
          value={viewMode}
          onChange={(val) => setViewMode(val as 'calendar' | 'list')}
          options={[
            { value: 'list', icon: <UnorderedListOutlined />, label: t('promotions.listView') },
            { value: 'calendar', icon: <CalendarOutlined />, label: t('promotions.calendarView') },
          ]}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '0 24px', overflow: 'auto' }}>
        {viewMode === 'calendar' ? (
          <CalendarView campaigns={campaigns} stores={stores} />
        ) : (
          <PromotionList campaigns={campaigns} stores={stores} products={products} />
        )}
      </div>

      {/* Create drawer */}
      <CreatePromotionDrawer
        open={createOpen}
        onClose={closeCreateDrawer}
        onCreate={createMutation.mutate}
        loading={createMutation.isPending}
        stores={stores}
        products={products}
        defaults={createDefaults}
      />
    </div>
  );
}

function StatBox({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number | string; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ marginBottom: 4 }}>{icon}</div>
      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{label}</Typography.Text>
      <Typography.Text strong style={{ fontSize: 20, color }}>{value}</Typography.Text>
    </div>
  );
}
