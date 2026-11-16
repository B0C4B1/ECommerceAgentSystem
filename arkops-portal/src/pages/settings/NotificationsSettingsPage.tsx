import { LinkOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Modal, Select, Skeleton, Space, Switch, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { notificationsApi } from '../../api/notifications';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import type { NotificationChannelConfig, NotificationChannelType, NotificationEventKey } from '../../types/domain';

const EVENT_ROWS: { key: NotificationEventKey; labelKey: string; policyKey: string }[] = [
  { key: 'approval_required', labelKey: 'settings.eventApprovalRequired', policyKey: 'settings.policyApprovalRequired' },
  { key: 'relogin_required', labelKey: 'settings.eventLoginRequired', policyKey: 'settings.policyLoginRequired' },
  { key: 'run_failed', labelKey: 'settings.eventRunFailed', policyKey: 'settings.policyRunFailed' }
];

const CHANNEL_TYPE_OPTIONS: { value: NotificationChannelType; label: string }[] = [
  { value: 'feishu', label: '飞书' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'webhook', label: 'Webhook' }
];

export function NotificationsSettingsPage() {
  const { t } = useI18n();
  const { can } = usePermission();
  const canUpdateNotifications = can('notifications', 'update');
  const queryClient = useQueryClient();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm] = Form.useForm();
  const [endpointChannel, setEndpointChannel] = useState<NotificationChannelConfig | null>(null);
  const [endpointForm] = Form.useForm();

  // U7.1：三态分明——读取中给骨架、失败说「读不出来 ≠ 没有」、只有成功且确实为空才说「还没有」。
  const channelsQuery = useQuery({
    queryKey: ['notification-channels'],
    queryFn: notificationsApi.listChannels,
    retry: 1
  });
  const channels = channelsQuery.data ?? [];

  const toggleMutation = useMutation({
    mutationFn: (params: { channelId: string; event: NotificationEventKey; enabled: boolean }) =>
      notificationsApi.toggleEvent(params.channelId, params.event, params.enabled),
    onSuccess: () => {
      message.success(t('notify.matrixSaved'));
      queryClient.invalidateQueries({ queryKey: ['notification-channels'] });
    }
  });

  const addMutation = useMutation({
    mutationFn: notificationsApi.addChannel,
    onSuccess: (channel) => {
      message.success(t('notify.channelAdded', { name: channel.name }));
      queryClient.invalidateQueries({ queryKey: ['notification-channels'] });
      setAddModalOpen(false);
      addForm.resetFields();
    }
  });

  const endpointMutation = useMutation({
    mutationFn: (params: { channelId: string; endpoint: string }) =>
      notificationsApi.updateEndpoint(params.channelId, params.endpoint),
    onSuccess: () => {
      message.success(t('notify.endpointUpdated'));
      queryClient.invalidateQueries({ queryKey: ['notification-channels'] });
      setEndpointChannel(null);
      endpointForm.resetFields();
    }
  });

  const openEndpointModal = (channel: NotificationChannelConfig) => {
    setEndpointChannel(channel);
    endpointForm.setFieldsValue({ endpoint: channel.endpoint ?? '' });
  };

  const testMutation = useMutation({
    mutationFn: notificationsApi.testSend,
    onSuccess: (result, channelId) => {
      const channel = channels.find((c) => c.id === channelId);
      if (result.ok) {
        message.success(t('notify.testSent', { name: channel?.name ?? '' }));
        queryClient.invalidateQueries({ queryKey: ['notification-channels'] });
      } else {
        message.error(t('notify.testFailed', { name: channel?.name ?? '' }));
      }
    }
  });

  const columns: ColumnsType<(typeof EVENT_ROWS)[number]> = [
    {
      title: t('settings.events'),
      dataIndex: 'labelKey',
      fixed: 'left',
      width: 220,
      render: (_: unknown, row) => (
        <div>
          <Typography.Text strong>{t(row.labelKey)}</Typography.Text>
          <br />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t(row.policyKey)}</Typography.Text>
        </div>
      )
    },
    ...channels.map((channel) => ({
      title: (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space size={6}>
            <Typography.Text strong>{channel.name}</Typography.Text>
            <Tag color={channel.status === 'connected' ? 'green' : 'default'} style={{ fontSize: 11 }}>
              {channel.status === 'connected' ? t('notify.connected') : t('notify.notConfigured')}
            </Tag>
          </Space>
          {channel.endpoint ? (
            <>
              <Button
                size="small"
                icon={<SendOutlined />}
                disabled={!canUpdateNotifications}
                loading={testMutation.isPending && testMutation.variables === channel.id}
                onClick={() => testMutation.mutate(channel.id)}
              >
                {channel.status === 'connected' ? t('notify.testSend') : t('notify.verifyConnect')}
              </Button>
              {canUpdateNotifications && (
                <Button size="small" type="link" onClick={() => openEndpointModal(channel)}>
                  {t('notify.editEndpoint')}
                </Button>
              )}
            </>
          ) : canUpdateNotifications ? (
            <Button size="small" icon={<LinkOutlined />} onClick={() => openEndpointModal(channel)}>
              {t('notify.setEndpoint')}
            </Button>
          ) : null}
        </Space>
      ),
      key: channel.id,
      align: 'center' as const,
      width: 150,
      render: (_: unknown, row: (typeof EVENT_ROWS)[number]) => (
        <Switch
          size="small"
          checked={channel.events[row.key]}
          disabled={channel.status !== 'connected' || !canUpdateNotifications}
          onChange={(checked) => toggleMutation.mutate({ channelId: channel.id, event: row.key, enabled: checked })}
        />
      )
    }))
  ];

  const selectedType = Form.useWatch('type', addForm) as NotificationChannelType | undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title={t('settings.notificationsTitle')}
        description={t('settings.notificationsDescription')}
        actions={
          canUpdateNotifications ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
              {t('settings.addChannel')}
            </Button>
          ) : undefined
        }
      />
      {channelsQuery.isLoading ? (
        <Card size="small" title={t('notify.matrixTitle')}>
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      ) : channelsQuery.isError ? (
        <Card size="small">
          <EmptyState
            description={t('settings.notificationsLoadFailed')}
            actionText={t('settings.notificationsLoadRetry')}
            onAction={() => channelsQuery.refetch()}
          />
        </Card>
      ) : channels.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t('notify.noChannels')}
          action={
            canUpdateNotifications ? (
              <Button size="small" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
                {t('settings.addChannel')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card title={t('notify.matrixTitle')}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            {t('notify.matrixDesc')}
          </Typography.Paragraph>
          <Table
            rowKey="key"
            columns={columns}
            dataSource={EVENT_ROWS}
            pagination={false}
            size="middle"
            scroll={{ x: 640 }}
          />
        </Card>
      )}

      <Modal
        title={t('notify.setEndpoint')}
        open={endpointChannel !== null}
        onOk={() => endpointForm.submit()}
        onCancel={() => { setEndpointChannel(null); endpointForm.resetFields(); }}
        confirmLoading={endpointMutation.isPending}
      >
        <Form
          form={endpointForm}
          layout="vertical"
          onFinish={(values: { endpoint: string }) => {
            if (!endpointChannel) return;
            endpointMutation.mutate({ channelId: endpointChannel.id, endpoint: values.endpoint });
          }}
        >
          <Form.Item
            label={endpointChannel?.type === 'webhook' ? 'Webhook URL' : t('notify.botWebhookUrl')}
            name="endpoint"
            rules={[{ required: true, message: t('notify.endpointRequired') }]}
          >
            <Input placeholder="https://..." />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            {t('notify.endpointEditHint')}
          </Typography.Paragraph>
        </Form>
      </Modal>

      <Modal
        title={t('settings.addChannel')}
        open={addModalOpen}
        onOk={() => addForm.submit()}
        onCancel={() => { setAddModalOpen(false); addForm.resetFields(); }}
        confirmLoading={addMutation.isPending}
      >
        <Form
          form={addForm}
          layout="vertical"
          initialValues={{ type: 'feishu' }}
          onFinish={(values: { type: NotificationChannelType; name?: string; endpoint?: string }) => {
            const fallbackName = CHANNEL_TYPE_OPTIONS.find((o) => o.value === values.type)?.label ?? values.type;
            addMutation.mutate({ type: values.type, name: values.name?.trim() || fallbackName, endpoint: values.endpoint });
          }}
        >
          <Form.Item label={t('notify.channelType')} name="type" rules={[{ required: true }]}>
            <Select options={CHANNEL_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item label={t('notify.channelName')} name="name">
            <Input placeholder={t('notify.channelNamePlaceholder')} />
          </Form.Item>
          <Form.Item
            label={selectedType === 'webhook' ? 'Webhook URL' : t('notify.botWebhookUrl')}
            name="endpoint"
            rules={[{ required: true, message: t('notify.endpointRequired') }]}
          >
            <Input placeholder="https://..." />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            {t('notify.addChannelHint')}
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  );
}
