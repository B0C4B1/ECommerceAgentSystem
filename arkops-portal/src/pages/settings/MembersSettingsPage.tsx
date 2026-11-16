import { UserAddOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, message, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { settingsApi } from '../../api/settings';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { TablePageSkeleton } from '../../components/PageSkeleton';
import type { Member } from '../../types/domain';

const ALL_ROLES = ['Owner', 'Admin', 'Operator', 'Approver', 'Finance', 'Viewer'] as const;

export function MembersSettingsPage() {
  const { t } = useI18n();
  const { can } = usePermission();
  const canInviteMember = can('members', 'create');
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteForm] = Form.useForm();
  const queryClient = useQueryClient();
  // U6.4：显式持有三态，避免「还没读到」被 antd 表格默认渲染成「暂无数据」。
  const membersQuery = useQuery({ queryKey: ['members'], queryFn: settingsApi.members, retry: 1 });
  const data = membersQuery.data ?? [];

  const inviteMutation = useMutation({
    mutationFn: (params: { email: string; role: Member['role'] }) => settingsApi.inviteMember(params),
    onSuccess: (result) => {
      if (result.existed) {
        message.info(t('settings.inviteExists'));
        return;
      }
      message.success(t('settings.inviteSuccess'));
      setInviteModalOpen(false);
      inviteForm.resetFields();
      queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });

  const roleOptions = useMemo(() => [
    { value: 'Admin', label: t('member.role.Admin') },
    { value: 'Operator', label: t('member.role.Operator') },
    { value: 'Approver', label: t('member.role.Approver') },
    { value: 'Finance', label: t('member.role.Finance') },
    { value: 'Viewer', label: t('member.role.Viewer') },
  ], [t]);

  const columns: ColumnsType<Member> = [
    { title: t('settings.name'), dataIndex: 'name' },
    { title: t('login.email'), dataIndex: 'email' },
    { title: t('settings.role'), dataIndex: 'role', render: (role) => t(`member.role.${role}`) },
    { title: t('stores.status'), dataIndex: 'status', render: (status) => t(`member.status.${status}`) }
  ];

  // 邀请弹窗同时服务「有成员」与「真·空」两种首屏，抽出来避免两处各写一份。
  const inviteModal = (
    <Modal
      title={t('settings.inviteMember')}
      open={inviteModalOpen}
      onCancel={() => { setInviteModalOpen(false); inviteForm.resetFields(); }}
      onOk={() => {
        inviteForm.validateFields().then((values) => {
          inviteMutation.mutate({ email: values.email, role: values.role });
        });
      }}
      confirmLoading={inviteMutation.isPending}
    >
      <Form form={inviteForm} layout="vertical">
        <Form.Item label={t('login.email')} name="email" rules={[{ required: true, type: 'email', message: t('settings.emailValidation') }]}>
          <Input placeholder={t('settings.emailPlaceholder')} />
        </Form.Item>
        <Form.Item label={t('settings.role')} name="role" rules={[{ required: true }]} initialValue="Operator">
          <Select options={roleOptions} />
        </Form.Item>
      </Form>
    </Modal>
  );

  // U6.4 三态之一：读取中。成员未返回前不渲染「暂无数据」，也不先给一张空表。
  if (membersQuery.isLoading) {
    return <TablePageSkeleton />;
  }

  // U6.4 三态之二：读取失败。说明「读不出来 ≠ 没有人」，就地重试。
  if (membersQuery.isError) {
    return (
      <div className="page-stack">
        <PageHeader title={t('settings.membersTitle')} description={t('settings.membersDescription')} />
        <Card>
          <EmptyState
            description={t('settings.membersLoadFailed')}
            actionText={t('settings.membersLoadRetry')}
            onAction={() => void membersQuery.refetch()}
          />
        </Card>
      </div>
    );
  }

  // U6.4 三态之三：确实为空（成功且 0 人），给出邀请下一人这条路径。
  if (data.length === 0) {
    return (
      <div className="page-stack">
        <PageHeader title={t('settings.membersTitle')} description={t('settings.membersDescription')} />
        <Card>
          <EmptyState
            description={t('settings.membersEmpty')}
            actionText={canInviteMember ? t('settings.invite') : undefined}
            onAction={canInviteMember ? () => setInviteModalOpen(true) : undefined}
          />
        </Card>
        {inviteModal}
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('settings.membersTitle')}
        description={t('settings.membersDescription')}
        actions={canInviteMember ? <Button icon={<UserAddOutlined />} onClick={() => setInviteModalOpen(true)}>{t('settings.invite')}</Button> : undefined}
      />
      <Card>
        <Table rowKey="id" columns={columns} dataSource={data} pagination={false} />
      </Card>
      <Card title={t('settings.mvpRoles')}>
        <Space wrap>
          {ALL_ROLES.map((role) => (
            <Tag key={role} color={role === 'Owner' ? 'blue' : role === 'Viewer' ? 'default' : 'geekblue'}>
              {t(`member.role.${role}`)}
            </Tag>
          ))}
        </Space>
      </Card>

      {inviteModal}
    </div>
  );
}
