/**
 * File: StoreAgentProfileCard.tsx
 * Purpose: B — Agent 店铺化的配置面。按店铺选择商家类型与行业，并为定价、促销、
 * 广告、库存、客服分别指定通用型或行业专属型 Agent。
 *
 * 为什么单独一张卡：店铺化不是全局开关，它必须先回答“这家店是什么商家”，
 * 再决定“哪些领域的 Agent 要换行业包”。放在场景激活之后，保持“先开通能力、
 * 再按店铺调优”的配置顺序。
 */
import { EditOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Drawer,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import {
  AGENT_DOMAINS,
  agentProfilesApi,
  defaultProfile,
  INDUSTRY_KEYS,
  SPECIALIZED_BOOST,
  type AgentDomain,
  type AgentMode,
  type IndustryKey,
  type MerchantType,
  type StoreAgentProfile,
} from '../../api/agentProfiles';
import { storesApi } from '../../api/stores';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import type { Store } from '../../types/domain';

export function StoreAgentProfileCard({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const { can } = usePermission();
  const canUpdate = can('setup', 'update');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<StoreAgentProfile | null>(null);

  const { data: stores = [] } = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list() });
  const { data: profiles = [] } = useQuery({
    queryKey: ['agentStoreProfiles'],
    queryFn: () => agentProfilesApi.list(),
  });

  const profileFor = (storeId: number): StoreAgentProfile =>
    profiles.find((profile) => profile.storeId === storeId) ?? defaultProfile(storeId);

  const saveMutation = useMutation({
    mutationFn: (profile: StoreAgentProfile) => agentProfilesApi.saveProfile(profile),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agentStoreProfiles'] });
      queryClient.invalidateQueries({ queryKey: ['agentStoreProfile'] });
      message.success(t('agentprofile.saved'));
      setDraft(null);
    },
  });

  const openEditor = (store: Store) => setDraft(profileFor(store.id));

  const updateMerchantType = (merchantType: MerchantType) => {
    if (!draft) return;
    if (merchantType === 'general') {
      // 通用型不携带行业包，切回通用型时同步把各领域恢复为通用版。
      const modes = { ...draft.modes };
      AGENT_DOMAINS.forEach((domain) => {
        modes[domain] = 'general';
      });
      setDraft({ ...draft, merchantType, modes });
      return;
    }
    setDraft({ ...draft, merchantType });
  };

  const updateMode = (domain: AgentDomain, mode: AgentMode) => {
    if (!draft) return;
    setDraft({ ...draft, modes: { ...draft.modes, [domain]: mode } });
  };

  const draftStoreName = draft
    ? stores.find((store) => store.id === draft.storeId)?.name ?? `#${draft.storeId}`
    : '';

  const content = (
    <>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        {t('agentprofile.desc')}
      </Typography.Text>

      <Table
        rowKey="id"
        dataSource={stores}
        pagination={false}
        size="small"
        scroll={{ x: 720 }}
        locale={{ emptyText: t('agentprofile.empty') }}
        columns={[
          {
            title: t('agentprofile.colStore'),
            dataIndex: 'name',
            width: 190,
            render: (name: string, store: Store) => (
              <Space size={6} wrap>
                <Typography.Text strong style={{ fontSize: 13 }}>{name}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{store.platform}</Typography.Text>
              </Space>
            ),
          },
          {
            title: t('agentprofile.colMerchant'),
            width: 170,
            render: (_: unknown, store: Store) => {
              const profile = profileFor(store.id);
              return (
                <Tag color={profile.merchantType === 'specialized' ? 'purple' : 'default'}>
                  {t(`agentprofile.merchant_${profile.merchantType}`)}
                </Tag>
              );
            },
          },
          {
            title: t('agentprofile.colIndustry'),
            width: 120,
            render: (_: unknown, store: Store) => (
              <Typography.Text style={{ fontSize: 12 }}>
                {t(`agentprofile.industry_${profileFor(store.id).industry}`)}
              </Typography.Text>
            ),
          },
          {
            title: t('agentprofile.colModes'),
            render: (_: unknown, store: Store) => {
              const profile = profileFor(store.id);
              const specialized = AGENT_DOMAINS.filter((domain) => profile.modes[domain] === 'specialized');
              if (profile.merchantType === 'general' || specialized.length === 0) {
                return (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('agentprofile.allGeneral')}
                  </Typography.Text>
                );
              }
              return (
                <Space size={4} wrap>
                  {specialized.map((domain) => (
                    <Tag key={domain} color="geekblue" style={{ fontSize: 11 }}>
                      {t(`agentprofile.domain_${domain}`)}
                    </Tag>
                  ))}
                </Space>
              );
            },
          },
          {
            title: t('agentprofile.colUpdated'),
            width: 120,
            render: (_: unknown, store: Store) => {
              const profile = profileFor(store.id);
              return (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {profile.updatedAt ? dayjs(profile.updatedAt).format('MM-DD HH:mm') : '—'}
                </Typography.Text>
              );
            },
          },
          {
            title: t('common.actions'),
            width: 100,
            render: (_: unknown, store: Store) =>
              canUpdate ? (
                <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditor(store)}>
                  {t('agentprofile.edit')}
                </Button>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>
              ),
          },
        ]}
      />

      <Drawer
        title={t('agentprofile.editTitle', { store: draftStoreName })}
        open={draft !== null}
        width={420}
        onClose={() => setDraft(null)}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              loading={saveMutation.isPending}
              onClick={() => draft && saveMutation.mutate(draft)}
            >
              {t('common.save')}
            </Button>
          </Space>
        }
      >
        {draft && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                {t('agentprofile.colMerchant')}
              </Typography.Text>
              <Segmented
                block
                value={draft.merchantType}
                options={[
                  { value: 'general', label: t('agentprofile.merchant_general') },
                  { value: 'specialized', label: t('agentprofile.merchant_specialized') },
                ]}
                onChange={(value) => updateMerchantType(value as MerchantType)}
              />
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                {t(`agentprofile.merchantHint_${draft.merchantType}`)}
              </Typography.Text>
            </div>

            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                {t('agentprofile.colIndustry')}
              </Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={draft.industry}
                disabled={draft.merchantType === 'general'}
                onChange={(industry: IndustryKey) => setDraft({ ...draft, industry })}
                options={INDUSTRY_KEYS.map((key) => ({
                  value: key,
                  label: t(`agentprofile.industry_${key}`),
                }))}
              />
            </div>

            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                {t('agentprofile.modesLabel')}
              </Typography.Text>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {AGENT_DOMAINS.map((domain) => {
                  const specialized = draft.modes[domain] === 'specialized';
                  return (
                    <div key={domain} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography.Text style={{ fontSize: 13 }}>{t(`agentprofile.domain_${domain}`)}</Typography.Text>
                      <Space size={6}>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {specialized ? t('agentprofile.mode_specialized') : t('agentprofile.mode_general')}
                        </Typography.Text>
                        <Switch
                          size="small"
                          checked={specialized}
                          disabled={draft.merchantType === 'general'}
                          onChange={(checked) => updateMode(domain, checked ? 'specialized' : 'general')}
                        />
                      </Space>
                    </div>
                  );
                })}
              </Space>
            </div>
          </Space>
        )}
      </Drawer>
    </>
  );

  // 嵌在折叠区里时不再套一层 Card，避免标题重复。
  if (embedded) return content;

  return (
    <Card
      title={t('agentprofile.title')}
      extra={<Tag style={{ fontSize: 10 }}>{t('agentprofile.boostNote', { boost: SPECIALIZED_BOOST })}</Tag>}
      style={{ marginBottom: 16 }}
    >
      {content}
    </Card>
  );
}
