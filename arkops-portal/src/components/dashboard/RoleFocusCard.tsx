/**
 * File: RoleFocusCard.tsx
 * Purpose: P31.3 角色首屏 —— 同一份首页数据按职责只留一件事：
 * Owner 看「目标与放权」，Operator 看「归我的升级」，Approver 看「待我审批」。
 * 人在第一屏就能完成自己的首要动作，不必先去收件箱里挑「哪些归我」，也不必自己算目标缺口。
 *
 * 口径：
 * - Owner 目标取 orchestratorApi.getPortfolio（与目标卡 / 多店概览同一份数据）；
 * - Operator / Admin 的升级队列直接复用 Agent 的路由口径（routeEscalation().role === 'Admin'），
 *   不另造一份「归谁」的规则：Agent 判给运营的，就是运营首屏要处理的；
 *   排序复用 P30.4 的可核对金额优先；
 * - Approver 只看 pending，双签进度按 priorApprovals 已有一签计算。
 */
import { AimOutlined, AlertOutlined, AuditOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Row, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { approvalsApi } from '../../api/approvals';
import { compareEscalationPriority, exceptionsApi, routeEscalation, summarizeImpact } from '../../api/exceptions';
import { orchestratorApi } from '../../api/orchestrator';
import { useAuth } from '../../app/auth';
import { useI18n } from '../../app/i18n';
import { useStoreScope } from '../../app/storeScope';
import type { AllMallId, RiskLevel } from '../../types/domain';

function formatMoney(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

const RISK_RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div style={{ minWidth: 128 }}>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        {label}
      </Typography.Text>
      <Typography.Text strong style={{ display: 'block', fontSize: 20, lineHeight: '28px' }}>
        {value}
      </Typography.Text>
      {hint && (
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
          {hint}
        </Typography.Text>
      )}
    </div>
  );
}

function scrollToCard(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

interface RoleFocusCardProps {
  /** 与目标卡 / 复盘卡同一店铺范围 */
  storeIds: AllMallId[];
}

export function RoleFocusCard({ storeIds }: RoleFocusCardProps) {
  const { t } = useI18n();
  const { role } = useAuth();
  const { stores, isAllStores } = useStoreScope();

  // 只有这三类职责有明确的首要动作；Finance / Viewer 不造入口。
  // Admin 是 Agent 路由升级的实际承接人（店铺日常异常），首屏给升级队列而不是目标编辑。
  const focus: 'owner' | 'operator' | 'approver' | null =
    role === 'Owner'
      ? 'owner'
      : role === 'Admin' || role === 'Operator'
        ? 'operator'
        : role === 'Approver'
          ? 'approver'
          : null;

  const { data: rows = [] } = useQuery({
    queryKey: ['portfolio', storeIds],
    queryFn: () => orchestratorApi.getPortfolio(storeIds),
    enabled: focus === 'owner' && storeIds.length > 0,
  });
  const { data: exceptions = [] } = useQuery({
    queryKey: ['exceptions'],
    queryFn: exceptionsApi.list,
    enabled: focus === 'operator',
  });
  const { data: approvals = [] } = useQuery({
    queryKey: ['approvals'],
    queryFn: approvalsApi.list,
    enabled: focus === 'approver',
  });

  if (!focus) return null;

  const storeNameOf = (storeId: number) => stores.find((store) => store.id === storeId)?.name ?? `#${storeId}`;
  const roleTag = {
    owner: { label: t('roleFocus.ownerRoleTag'), color: 'blue', icon: <AimOutlined style={{ color: '#2563eb' }} />, title: t('roleFocus.ownerTitle'), hint: t('roleFocus.ownerHint') },
    operator: { label: t(`member.role.${role}`), color: 'orange', icon: <AlertOutlined style={{ color: '#ea580c' }} />, title: t('roleFocus.operatorTitle'), hint: t('roleFocus.operatorHint') },
    approver: { label: t('roleFocus.approverRoleTag'), color: 'purple', icon: <AuditOutlined style={{ color: '#7c3aed' }} />, title: t('roleFocus.approverTitle'), hint: t('roleFocus.approverHint') },
  }[focus];

  let stats: { label: string; value: ReactNode; hint?: string }[] = [];
  let note = '';
  let actions: ReactNode = null;

  if (focus === 'owner') {
    const target = rows.reduce((sum, row) => sum + row.goal.target, 0);
    const current = rows.reduce((sum, row) => sum + row.goal.current, 0);
    const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    const week = rows.reduce((sum, row) => sum + row.attributedThisWeek, 0);
    const weekActions = rows.reduce((sum, row) => sum + row.realizedThisWeek, 0);
    const pending = rows.reduce((sum, row) => sum + row.pendingCount, 0);
    const weakest = [...rows].sort((a, b) => b.gapPct - a.gapPct)[0];
    const multiStore = storeIds.length > 1;

    stats = [
      {
        label: t('roleFocus.targetProgress'),
        value: `${pct}%`,
        hint: t('roleFocus.targetValue', { current: formatMoney(current), target: formatMoney(target) }),
      },
      {
        label: t('roleFocus.weekWriteBack'),
        value: `+${formatMoney(week)}`,
        hint: t('roleFocus.weekActions', { count: String(weekActions) }),
      },
      {
        label: t('roleFocus.pendingWriteBack'),
        value: t('roleFocus.operatorCount', { count: String(pending) }),
        hint: t('roleFocus.pendingHint'),
      },
    ];
    note = weakest
      ? t('roleFocus.biggestGap', {
          store: storeNameOf(weakest.storeId),
          gap: formatMoney(Math.max(0, weakest.goal.target - weakest.goal.current)),
          pct: String(Math.round(weakest.gapPct)),
        })
      : t('roleFocus.goalOnTrack');
    actions = (
      <Space size={8} wrap>
        <Button
          size="small"
          onClick={() => scrollToCard(multiStore ? 'portfolio-goals-card' : 'store-goal-card')}
        >
          {multiStore ? t('roleFocus.adjustAccountGoal') : t('roleFocus.adjustGoal')}
        </Button>
        <Link to="/setup">
          <Button size="small" type="primary">
            {t('roleFocus.delegation')}
          </Button>
        </Link>
      </Space>
    );
  }

  if (focus === 'operator') {
    // 与 Agent 同一条路由规则：被判给 Admin 进行中的升级，就是运营首屏要处理的。
    const opsQueue = exceptions
      .filter((item) => !item.resolved && !item.ignored && routeEscalation(item).role === 'Admin')
      .sort(compareEscalationPriority);
    const { quantified, total } = summarizeImpact(opsQueue);
    const storeCount = new Set(opsQueue.map((item) => item.storeName)).size;
    const top = opsQueue[0];

    stats = [
      {
        label: t('roleFocus.operatorMine'),
        value: t('roleFocus.operatorCount', { count: String(opsQueue.length) }),
        hint: t('roleFocus.crossStoreNote'),
      },
      {
        label: t('roleFocus.operatorImpact'),
        value: quantified > 0 ? formatMoney(total) : '—',
        hint: t('roleFocus.operatorQuantified', { count: String(quantified) }),
      },
      {
        label: t('roleFocus.operatorStores'),
        value: t('roleFocus.operatorStoreCount', { count: String(storeCount) }),
      },
    ];
    note = top
      ? `${t('roleFocus.operatorTop', { title: top.title, store: top.storeName })} · ${t(
          'roleFocus.operatorReason',
          { reason: routeEscalation(top).reason },
        )}`
      : t('roleFocus.operatorEmpty');
    actions = (
      <Space size={8} wrap>
        <Link to="/inbox">
          <Button size="small" type="primary">
            {t('roleFocus.openAll')}
          </Button>
        </Link>
        <Link to="/inbox?mine=1">
          <Button size="small">{t('roleFocus.openMine')}</Button>
        </Link>
      </Space>
    );
  }

  if (focus === 'approver') {
    const pending = approvals.filter((approval) => approval.status === 'pending');
    const dualWaiting = pending.filter((approval) => (approval.priorApprovals?.length ?? 0) > 0);
    const oldest = [...pending].sort(
      (a, b) => dayjs(a.requestedAt).valueOf() - dayjs(b.requestedAt).valueOf(),
    )[0];
    const waitedHours = oldest ? Math.max(0, dayjs().diff(dayjs(oldest.requestedAt), 'hour')) : 0;
    const top = [...pending].sort(
      (a, b) =>
        RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel] ||
        dayjs(a.requestedAt).valueOf() - dayjs(b.requestedAt).valueOf(),
    )[0];
    const riskLabel = (risk: RiskLevel) =>
      risk === 'high' ? t('agent.highRisk') : risk === 'medium' ? t('agent.mediumRisk') : t('agent.lowRisk');

    stats = [
      {
        label: t('roleFocus.approverPending'),
        value: t('roleFocus.operatorCount', { count: String(pending.length) }),
        hint: t('roleFocus.crossStoreNote'),
      },
      {
        label: t('roleFocus.approverDual'),
        value: t('roleFocus.operatorCount', { count: String(dualWaiting.length) }),
      },
      {
        label: t('roleFocus.approverOldest'),
        value:
          waitedHours >= 48
            ? t('roleFocus.hoursDays', { days: String(Math.floor(waitedHours / 24)) })
            : t('roleFocus.hours', { hours: String(waitedHours) }),
      },
    ];
    note = top
      ? t('roleFocus.approverTop', {
          title: top.title,
          store: top.storeName,
          risk: riskLabel(top.riskLevel),
        })
      : t('roleFocus.approverEmpty');
    actions = (
      <Space size={8} wrap>
        <Link to="/inbox?type=approval">
          <Button size="small" type="primary">
            {t('roleFocus.openApprovals')}
          </Button>
        </Link>
        <Link to="/agents/approvals">
          <Button size="small">{t('roleFocus.allApprovals')}</Button>
        </Link>
      </Space>
    );
  }

  // 单店视图下 Operator / Approver 的队列本来就是跨店铺的，补一句避免和店铺范围过滤器打架。
  const crossStoreHint = isAllStores || focus === 'owner' ? null : t('roleFocus.crossStoreNote');

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space size={8} wrap>
          {roleTag.icon}
          <Typography.Text strong>{roleTag.title}</Typography.Text>
          <Tag color={roleTag.color}>{roleTag.label}</Tag>
        </Space>
      }
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {crossStoreHint ?? roleTag.hint}
        </Typography.Text>
      }
    >
      <Row gutter={[16, 12]} align="middle" justify="space-between">
        <Col flex="auto">
          <Space size={32} wrap align="start">
            {stats.map((stat) => (
              <Stat key={stat.label} {...stat} />
            ))}
          </Space>
          <Typography.Text
            type="secondary"
            style={{ display: 'block', marginTop: 10, fontSize: 12 }}
            ellipsis={{ tooltip: note }}
          >
            {note}
          </Typography.Text>
        </Col>
        <Col>{actions}</Col>
      </Row>
    </Card>
  );
}
