/**
 * File: InboxAutoHandledTab.tsx
 * Purpose: "自动处理" tab of the 待办中心 (D9). Completes the division of labour the three
 * tabs describe — what needs me, what the system already did for me, what I decided.
 * This one answers "what did automation handle without asking?", the transparency side of
 * a Human-in-the-Loop product.
 *
 * Author: TBD
 * Created: 2026-07-29
 *
 * Main exports:
 * - InboxAutoHandledTab: rendered inside InboxPage's tab layout.
 *
 * Major updates:
 * - 2026-11-14 (P41.1): 改读真实审计轨迹，不再渲染静态样例日志；汇总数与表格行同源，
 *   治理类条目可「核对」回原升级条目。此前无论 Agent 收尾了多少条，tab 内容都不变。
 */
import { CheckCircleOutlined, SafetyCertificateOutlined, ThunderboltOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Card, Space, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../app/i18n';
import { auditLogsApi } from '../../api/auditLogs';
import { exceptionsApi } from '../../api/exceptions';
import { DataTableCard } from '../../components/table/DataTableCard';
import type { AuditLog } from '../../types/domain';
import type { ExceptionItem } from '../operations/exceptionCenterMockData';

/** 回执窗口：只列近 7 天，避免把上古操作当「今天替你做的」。 */
export const AUTO_HANDLED_WINDOW_DAYS = 7;

/**
 * P41.1：谁算「Agent」。
 * - 业务 Agent 的自主动作统一记为 agent_action（调价、暂停计划、风控阻断…）；
 * - 治理侧 actor 为 `Agent（超时策略）` / `Agent（路由规则）` 或编排器 `Orchestrator`。
 * 人（CURRENT_ACTOR）与「AllMall 系统」的系统事件不计入，避免把人工操作和平台动作混进来。
 */
function isAgentAudit(log: AuditLog): boolean {
  return log.category === 'agent_action' || log.actor.startsWith('Agent') || log.actor === 'Orchestrator';
}

/**
 * P41.1：只收「有结果的动作」。
 * - 业务 Agent 自主动作统一记为 agent_action；
 * - 治理侧只认收尾、催办、暂停、上报、护栏写入、周期结转这类留下结论的动作；
 * - 内部记账（目标进度回写）与路由分派（路由升级项）不算「替你处理了」，
 *   它们不改变任何结论，放进来只会把人要核对的东西淹掉。
 */
const RECEIPT_ACTIONS = [
  '解决异常',
  '超时提醒',
  '超时暂停 Agent',
  '超时上报 Owner',
  '确认护栏',
  '目标周期结转',
  '目标节奏补救',
  '目标周期补救',
];

function isReceiptAudit(log: AuditLog): boolean {
  return log.category === 'agent_action' || RECEIPT_ACTIONS.some((action) => log.action.startsWith(action));
}

/** 治理动作：超时收尾、提醒、暂停、上报、护栏写入等，由治理侧 Agent 留下。 */
function isGovernanceAudit(log: AuditLog): boolean {
  return log.actor.startsWith('Agent（') || log.actor === 'Orchestrator';
}

/**
 * 近 7 天「系统替你处理了」的回执行。
 *
 * U1.3：tab 内容与 tab 上的计数徽标共用这一处筛选，保证「首屏看到的条数」与
 * 「点进去看到的行数」永远一致，不各自维护一套口径。
 *
 * Author: TBD
 * Created: 2026-11-14
 */
export function getAutoHandledRows(logs: AuditLog[]): AuditLog[] {
  const since = dayjs().subtract(AUTO_HANDLED_WINDOW_DAYS, 'day');
  return logs
    .filter((log) => isAgentAudit(log) && isReceiptAudit(log) && dayjs(log.at).isAfter(since))
    .sort((a, b) => dayjs(b.at).valueOf() - dayjs(a.at).valueOf());
}

export function InboxAutoHandledTab({
  onShowPending,
  onCheckEscalation,
}: {
  onShowPending: () => void;
  onCheckEscalation: (item: ExceptionItem) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: auditLogs = [] } = useQuery({ queryKey: ['audit-logs'], queryFn: auditLogsApi.list });
  const { data: exceptions = [] } = useQuery({ queryKey: ['exceptions'], queryFn: exceptionsApi.list });

  const rows = useMemo(() => getAutoHandledRows(auditLogs), [auditLogs]);

  const summary = useMemo(() => {
    const governance = rows.filter(isGovernanceAudit).length;
    const blocked = rows.filter((log) => log.action.includes('阻断')).length;
    const escalated = rows.filter((log) => log.action.includes('上报')).length;
    return { handled: rows.length, governance, blocked, escalated };
  }, [rows]);

  const exceptionById = useMemo(() => {
    const map = new Map<string, ExceptionItem>();
    exceptions.forEach((item) => map.set(String(item.id), item));
    return map;
  }, [exceptions]);

  const columns: ColumnsType<AuditLog> = [
    {
      title: t('audit.time'),
      dataIndex: 'at',
      width: 110,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }}>{dayjs(value).format('MM-DD HH:mm')}</Typography.Text>
      ),
    },
    {
      title: t('audit.actor'),
      dataIndex: 'actor',
      width: 150,
      render: (value: string) => <Typography.Text style={{ fontSize: 12 }}>{value}</Typography.Text>,
    },
    { title: t('audit.action'), dataIndex: 'action', width: 120 },
    { title: t('audit.entity'), dataIndex: 'entity', width: 90 },
    {
      title: t('audit.summary'),
      dataIndex: 'summary',
      ellipsis: true,
      render: (value: string) => <Typography.Text style={{ fontSize: 12 }}>{value}</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_, log) => {
        // 能对上收件箱条目就「核对」原条目（看结论与处理人）；否则只走既有深链。
        const item = exceptionById.get(String(log.entityId));
        if (item) {
          return (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => onCheckEscalation(item)}>
              {t('inbox.autoCheck')}
            </Button>
          );
        }
        if (log.linkTo) {
          return (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => navigate(log.linkTo!)}>
              {t('common.view')}
            </Button>
          );
        }
        return <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Same "results first" summary the products and orders digests use, at account
          scope: the value story is the point of this tab. */}
      <Card size="small">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Space size={8} wrap>
            <ThunderboltOutlined style={{ color: 'var(--ark-purple)' }} />
            <Typography.Text strong>{t('inbox.autoSummaryTitle')}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('inbox.autoWindow', { days: AUTO_HANDLED_WINDOW_DAYS })}
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              <CheckCircleOutlined style={{ color: 'var(--ark-green)', marginRight: 4 }} />
              {t('inbox.autoSummaryHandled', { count: summary.handled })}
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              <SafetyCertificateOutlined style={{ color: 'var(--ark-purple)', marginRight: 4 }} />
              {t('inbox.autoSummaryGovernance', { count: summary.governance })}
            </Typography.Text>
            {summary.blocked > 0 && (
              <Typography.Text style={{ fontSize: 13 }}>
                <WarningOutlined style={{ color: 'var(--ark-orange)', marginRight: 4 }} />
                {t('inbox.autoSummaryBlocked', { count: summary.blocked })}
              </Typography.Text>
            )}
            {summary.escalated > 0 && (
              <Typography.Text style={{ fontSize: 13 }}>
                <WarningOutlined style={{ color: 'var(--ark-orange)', marginRight: 4 }} />
                {t('inbox.autoSummaryEscalated', { count: summary.escalated })}
              </Typography.Text>
            )}
          </Space>
          {summary.escalated > 0 && (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={onShowPending}>
              {t('inbox.autoSummaryGoPending')}
            </Button>
          )}
        </div>
      </Card>

      <DataTableCard
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 10, size: 'small' }}
        cardProps={{ title: t('inbox.autoLogTitle') }}
        description={t('inbox.autoLogHint', { days: AUTO_HANDLED_WINDOW_DAYS })}
        locale={{ emptyText: t('inbox.autoEmpty') }}
      />
    </Space>
  );
}
