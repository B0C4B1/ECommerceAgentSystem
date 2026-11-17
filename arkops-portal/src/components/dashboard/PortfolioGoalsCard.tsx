/**
 * File: PortfolioGoalsCard.tsx
 * Purpose: P3.5 经营周期升维 —— 把“本店目标 + 回写”扩成多店铺视图：
 * 一眼看到每个店铺的目标进度、本周/上周回写效果与当前经营状态，并能直接切店。
 *
 * 为什么放在 Dashboard：不新增路由，用一张表回答“我的多个店现在各自跑到哪了、
 * 上周的动作这周还有没有效果”，这是从单店闭环走向多店自动化运营的最短一步。
 *
 * P16：跨店方案的采纳/忽略已并入待办中心（与单店升级项同一个裁决入口），
 * 本卡只保留跨店预算与待拍板数量，避免出现第二套决策面板。
 */
import { AimOutlined, SafetyCertificateOutlined, WalletOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Divider,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Col,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  operatingModelApi,
  type AccountAllocation,
  type BudgetPoolProposal,
} from '../../api/operatingModel';
import { orchestratorApi, type StorePortfolioRow } from '../../api/orchestrator';
import { useAuth } from '../../app/auth';
import { useI18n } from '../../app/i18n';
import { usePermission } from '../../app/usePermission';
import { useStoreScope } from '../../app/storeScope';
import type { AllMallId, StoreGoal } from '../../types/domain';
import { invalidateOperatingModelQueries } from '../../utils/operatingModelQueries';

function formatMoney(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * P29.3 账户级目标：人只下一个账户月度 GMV 目标，Agent 按近 30 天 GMV 占比拆到店，
 * 人确认后一次写回所有店铺目标。目标是多店时才有意义，单店直接改本店目标即可。
 */
function AccountGoalSection({
  storeIds,
  storeTargetSum,
}: {
  storeIds: AllMallId[];
  storeTargetSum: number;
}) {
  const { t } = useI18n();
  const { can } = usePermission();
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can('setup', 'update');

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);

  const { data: accountGoal } = useQuery({
    queryKey: ['accountGoal'],
    queryFn: () => operatingModelApi.getAccountGoal(),
  });

  /**
   * P44.1：账户目标只在「写下的那个月」算本月承诺。
   * 账户目标没有独立周期字段，写入时刻即归属月份（adopt 只会写当月），
   * 因此用 updatedAt 的月份判定，跨月后自动落回「上期 · 待确认」，不会把上月承诺当本月。
   */
  const isCurrent = Boolean(accountGoal && dayjs(accountGoal.updatedAt).isSame(dayjs(), 'month'));

  /** Agent 建议的账户目标：各店按当前节奏的月末预计之和，人可改可不改。 */
  const { data: suggestion } = useQuery({
    queryKey: ['accountGoalSuggestion', storeIds],
    queryFn: () => operatingModelApi.suggestAccountTarget(storeIds),
    enabled: storeIds.length > 0,
  });

  /** P48.1：跨月未确认时，Agent 先把上期承诺与实际算清楚，人再决定沿用还是调整。 */
  const { data: review } = useQuery({
    queryKey: ['accountGoalReview', accountGoal?.updatedAt],
    queryFn: () => operatingModelApi.getAccountGoalReview(),
    enabled: Boolean(accountGoal) && !isCurrent,
  });

  /** 预演：只算不写；人确认后才落库。 */
  const { data: allocation } = useQuery({
    queryKey: ['accountAllocation', storeIds, draft],
    queryFn: () => operatingModelApi.proposeAccountAllocation(draft!, storeIds),
    enabled: open && Boolean(draft && draft > 0),
  });

  const adopt = useMutation({
    mutationFn: (value: AccountAllocation) =>
      operatingModelApi.adoptAccountAllocation(value, {
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
      }),
    onError: (error) => message.error((error as Error).message),
    onSuccess: (result) => {
      result.goals.forEach((goal) => queryClient.setQueryData(['storeGoal', goal.storeId], goal));
      // P50：账户目标会重写各店目标，账户侧与单店侧一起失效，别留旧预算/旧护栏。
      invalidateOperatingModelQueries(queryClient);
      setOpen(false);
      message.success(t('accountGoal.saved', { count: String(result.goals.length) }));
    },
  });

  /**
   * P56：上期 · 待确认时，人不需要打开弹窗重填一个和上期相同的数字。
   * Agent 按上期承诺直接落本月确认，各店目标与护栏保持不动；错点后仍可重新调整。
   */
  const uphold = useMutation({
    mutationFn: () =>
      operatingModelApi.upholdAccountGoal({
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
      }),
    onError: (error) => message.error((error as Error).message),
    onSuccess: (result) => {
      if (!result.confirmed) {
        message.info(t('accountGoal.carryOverNoop'));
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['accountGoal'] });
      queryClient.invalidateQueries({ queryKey: ['accountGoalReview'] });
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      message.success(t('accountGoal.carriedOver', { value: formatMoney(result.target) }));
    },
  });

  if (storeIds.length <= 1) return null;

  const targetGap = accountGoal && isCurrent ? storeTargetSum - accountGoal.target : 0;

  return (
    <div style={{ marginBottom: 12 }}>
      <Space size={8} wrap>
        <AimOutlined style={{ color: 'var(--ark-blue)' }} />
        <Typography.Text strong>{t('accountGoal.title')}</Typography.Text>
        {accountGoal && isCurrent ? (
          <Tag color="blue">
            {t('accountGoal.current', {
              value: formatMoney(accountGoal.target),
              period: accountGoal.periodLabel,
            })}
          </Tag>
        ) : accountGoal ? (
          <Tag color="orange">{t('accountGoal.stale')}</Tag>
        ) : (
          <Tag color="orange">{t('accountGoal.unconfirmed')}</Tag>
        )}
        {/* 未确认 / 上期：先说清「现在跑的算不算你的承诺」，再给唯一动作。 */}
        {!isCurrent && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {accountGoal
              ? t('accountGoal.staleHint', {
                  value: formatMoney(accountGoal.target),
                  sum: formatMoney(storeTargetSum),
                })
              : t('accountGoal.unconfirmedHint', { sum: formatMoney(storeTargetSum) })}
          </Typography.Text>
        )}
        {!isCurrent && suggestion && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('accountGoal.suggest', {
              value: formatMoney(suggestion.target),
              covered: String(suggestion.coveredStores),
              total: String(suggestion.storeCount),
            })}
          </Typography.Text>
        )}
        {/* P48.1：上期的账先算清楚，人再决定本月承诺，不再盲拍。 */}
        {!isCurrent && review && (
          <Typography.Text
            type={review.verdict === 'missed' ? 'warning' : 'success'}
            style={{ fontSize: 12 }}
          >
            {review.verdict === 'missed'
              ? t('accountGoal.reviewMissed', {
                  period: review.periodKey,
                  actual: formatMoney(review.actualGmv),
                  pct: `${Math.round(review.achievedPct * 100)}%`,
                  shortfall: formatMoney(review.shortfall),
                })
              : t('accountGoal.reviewAchieved', {
                  period: review.periodKey,
                  actual: formatMoney(review.actualGmv),
                  pct: `${Math.round(review.achievedPct * 100)}%`,
                })}
            {' · '}
            {t('accountGoal.reviewCoverage', {
              covered: String(review.coveredStores),
              total: String(review.storeCount),
            })}
          </Typography.Text>
        )}
        {isCurrent && accountGoal && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('accountGoal.confirmedAt', { date: dayjs(accountGoal.updatedAt).format('MM-DD') })}
            {' · '}
            {t('accountGoal.sumNote', { value: formatMoney(storeTargetSum) })}
            {Math.abs(targetGap) >= 1
              ? ` · ${t('accountGoal.gapNote', { value: formatMoney(Math.abs(targetGap)) })}`
              : ` · ${t('accountGoal.aligned')}`}
          </Typography.Text>
        )}
        {/* P56：待确认时先给最省事的「沿用上期」，调整仍走「重新确认」。 */}
        {canEdit && !isCurrent && accountGoal && (
          <Button
            size="small"
            type="primary"
            loading={uphold.isPending}
            onClick={() => uphold.mutate()}
          >
            {t('accountGoal.carryOver', { value: formatMoney(accountGoal.target) })}
          </Button>
        )}
        {canEdit && (
          <Button
            size="small"
            type={!accountGoal ? 'primary' : 'default'}
            icon={<AimOutlined />}
            onClick={() => {
              setDraft(
                isCurrent ? accountGoal!.target : suggestion?.target ?? accountGoal?.target ?? null,
              );
              setOpen(true);
            }}
          >
            {!accountGoal
              ? suggestion
                ? t('accountGoal.confirmSuggested', { value: formatMoney(suggestion.target) })
                : t('accountGoal.open')
              : isCurrent
                ? t('accountGoal.open')
                : t('accountGoal.reopen')}
          </Button>
        )}
      </Space>

      <Modal
        open={open}
        width={760}
        title={t('accountGoal.modalTitle')}
        onCancel={() => setOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              loading={adopt.isPending}
              disabled={!allocation || allocation.coveredStores === 0 || !draft}
              onClick={() => allocation && adopt.mutate(allocation)}
            >
              {t('accountGoal.confirm')}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">{t('accountGoal.targetLabel')}</Typography.Text>
            <InputNumber
              style={{ width: '100%', marginTop: 4 }}
              min={0}
              step={10000}
              prefix="¥"
              value={draft}
              onChange={(value) => setDraft(value ?? null)}
            />
            {suggestion && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('accountGoal.suggestHint', { value: formatMoney(suggestion.target) })}
              </Typography.Text>
            )}
          </div>
          {/* P48.1：先把上期事实摆在人眼前，再让人填本月承诺。 */}
          {!isCurrent && review && (
            <Alert
              type={review.verdict === 'missed' ? 'warning' : 'success'}
              showIcon
              message={t('accountGoal.reviewAlert', {
                period: review.periodKey,
                target: formatMoney(review.target),
                actual: formatMoney(review.actualGmv),
                pct: `${Math.round(review.achievedPct * 100)}%`,
              })}
              description={t('accountGoal.reviewBasis')}
            />
          )}
          <Alert type="info" showIcon message={t('accountGoal.basis')} />
          {allocation && allocation.overCapacityCount > 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('accountGoal.overCapacityWarn', { count: String(allocation.overCapacityCount) })}
            />
          )}
          <Table
            rowKey="storeId"
            size="small"
            pagination={false}
            dataSource={allocation?.rows ?? []}
            locale={{ emptyText: t('accountGoal.unavailable') }}
            columns={[
              {
                title: t('accountGoal.colStore'),
                render: (_: unknown, row: AccountAllocation['rows'][number]) => (
                  <Space size={4} wrap>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {row.storeName}
                    </Typography.Text>
                    {row.overCapacity && <Tag color="orange">{t('accountGoal.overCapacity')}</Tag>}
                  </Space>
                ),
              },
              {
                title: t('accountGoal.colLast30'),
                align: 'right' as const,
                render: (_: unknown, row: AccountAllocation['rows'][number]) =>
                  row.hasBaseline ? (
                    formatMoney(row.last30Gmv ?? 0)
                  ) : (
                    <Typography.Text type="secondary">{t('accountGoal.noBaseline')}</Typography.Text>
                  ),
              },
              {
                title: t('accountGoal.colShare'),
                width: 80,
                align: 'right' as const,
                render: (_: unknown, row: AccountAllocation['rows'][number]) =>
                  row.hasBaseline ? `${Math.round(row.share * 100)}%` : '—',
              },
              {
                title: t('accountGoal.colCurrent'),
                align: 'right' as const,
                render: (_: unknown, row: AccountAllocation['rows'][number]) => formatMoney(row.currentTarget),
              },
              {
                title: t('accountGoal.colSuggested'),
                align: 'right' as const,
                render: (_: unknown, row: AccountAllocation['rows'][number]) => (
                  <Typography.Text strong={row.hasBaseline}>{formatMoney(row.suggestedTarget)}</Typography.Text>
                ),
              },
              {
                title: t('accountGoal.colDelta'),
                align: 'right' as const,
                render: (_: unknown, row: AccountAllocation['rows'][number]) =>
                  row.delta === 0 ? (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ) : (
                    <Typography.Text style={{ color: row.delta > 0 ? 'var(--ark-green)' : 'var(--ark-red)' }}>
                      {row.delta > 0 ? '+' : '-'}
                      {formatMoney(Math.abs(row.delta))}
                    </Typography.Text>
                  ),
              },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('accountGoal.auditNote')}
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
}

/**
 * P46 预算池跟着目标走：账户广告预算总额不变，只把「超出自身所需」的富余挪给缺口店。
 * Agent 算缺口、排顺序、给预期回写；人只确认一次，确认后才写回预算池。
 */
function BudgetPoolSection({ storeIds }: { storeIds: AllMallId[] }) {
  const { t } = useI18n();
  const { can } = usePermission();
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can('setup', 'update');
  const [open, setOpen] = useState(false);

  const { data: proposal } = useQuery({
    queryKey: ['budgetPool', storeIds],
    queryFn: () => operatingModelApi.getBudgetPoolProposal(storeIds),
    enabled: storeIds.length > 1,
  });

  const { data: lastRevert } = useQuery({
    queryKey: ['budgetRevert', storeIds],
    queryFn: () => operatingModelApi.getLastBudgetReallocation(),
    enabled: storeIds.length > 1,
  });

  const revert = useMutation({
    mutationFn: () =>
      operatingModelApi.revertBudgetReallocation({
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
      }),
    onError: (error) => message.error((error as Error).message),
    onSuccess: () => {
      // P50：预算池写回的是各店护栏，账户护栏与账户建议都跟着变。
      invalidateOperatingModelQueries(queryClient);
      message.success(t('budgetPool.reverted'));
    },
  });

  const apply = useMutation({
    mutationFn: () =>
      operatingModelApi.reallocateAdBudget(storeIds, {
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
      }),
    onError: (error) => message.error((error as Error).message),
    onSuccess: (result) => {
      // P50：预算池写回的是各店护栏，账户护栏与账户建议都跟着变。
      invalidateOperatingModelQueries(queryClient);
      setOpen(false);
      message.success(t('budgetPool.saved', { count: String(result.moves.length) }));
    },
  });

  if (storeIds.length <= 1 || !proposal) return null;

  const hasMoves = proposal.moves.length > 0;
  const movesText = proposal.moves
    .map((move) => {
      const from = proposal.rows.find((row) => row.storeId === move.fromStoreId)?.storeName;
      const to = proposal.rows.find((row) => row.storeId === move.toStoreId)?.storeName;
      return t('budgetPool.movesPair', {
        from: from ?? `#${move.fromStoreId}`,
        to: to ?? `#${move.toStoreId}`,
        amount: formatMoney(move.amount),
      });
    })
    .join('；');

  return (
    <div style={{ marginBottom: 12 }}>
      <Space size={8} wrap>
        <WalletOutlined style={{ color: 'var(--ark-blue)' }} />
        <Typography.Text strong>{t('budgetPool.title')}</Typography.Text>
        {hasMoves ? (
          <Tag color="orange">{t('budgetPool.movable', { amount: formatMoney(proposal.allocated) })}</Tag>
        ) : (
          <Tag color="green">{t('budgetPool.balanced')}</Tag>
        )}
        {proposal.uncovered > 0 && (
          <Tag color="red">{t('budgetPool.uncovered', { value: formatMoney(proposal.uncovered) })}</Tag>
        )}
        {canEdit && (
          <Button
            size="small"
            icon={<WalletOutlined />}
            onClick={() => setOpen(true)}
          >
            {t('budgetPool.open')}
          </Button>
        )}
      </Space>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
        {hasMoves
          ? t('budgetPool.summary', {
              pool: formatMoney(proposal.accountAdTotal),
              shortage: formatMoney(proposal.totalShortage),
              surplus: formatMoney(proposal.totalSurplus),
            })
          : proposal.uncovered > 0
            ? t('budgetPool.summaryNoSurplus', {
                pool: formatMoney(proposal.accountAdTotal),
                shortage: formatMoney(proposal.uncovered),
              })
            : t('budgetPool.summaryBalanced', { pool: formatMoney(proposal.accountAdTotal) })}
      </Typography.Text>
      {lastRevert && lastRevert.rows.length > 0 && (
        <Space size={8} wrap style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('budgetPool.lastReallocation', {
              time: dayjs(lastRevert.at).format('MM-DD HH:mm'),
              actor: lastRevert.actor,
              count: String(lastRevert.rows.length),
            })}
          </Typography.Text>
          {canEdit && (
            <Popconfirm
              title={t('budgetPool.revertConfirm', { count: String(lastRevert.rows.length) })}
              okText={t('budgetPool.revert')}
              cancelText={t('common.cancel')}
              disabled={!lastRevert.reversible}
              onConfirm={() => revert.mutate()}
            >
              <Button
                size="small"
                type="link"
                danger
                disabled={!lastRevert.reversible}
                loading={revert.isPending}
              >
                {lastRevert.reversible
                  ? t('budgetPool.revert')
                  : t('budgetPool.revertBlocked')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      )}

      <Modal
        open={open}
        width={860}
        title={t('budgetPool.modalTitle')}
        onCancel={() => setOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              loading={apply.isPending}
              disabled={!hasMoves}
              onClick={() => apply.mutate()}
            >
              {t('budgetPool.confirm')}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message={t('budgetPool.basis')} />
          {!hasMoves && (
            <Alert type="warning" showIcon message={t('budgetPool.noMovesWarn')} />
          )}
          {proposal.uncovered > 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('budgetPool.uncoveredWarn', { value: formatMoney(proposal.uncovered) })}
            />
          )}
          <Table
            rowKey="storeId"
            size="small"
            pagination={false}
            dataSource={proposal.rows}
            columns={[
              {
                title: t('budgetPool.colStore'),
                render: (_: unknown, row: BudgetPoolProposal['rows'][number]) => (
                  <Space size={4} wrap>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {row.storeName}
                    </Typography.Text>
                    {row.give > 0 && <Tag color="blue">{t('budgetPool.roleGive')}</Tag>}
                    {row.take > 0 && <Tag color="green">{t('budgetPool.roleTake')}</Tag>}
                    {row.gap > 0 && row.take === 0 && (
                      <Tag color="red">{t('budgetPool.roleUnfunded')}</Tag>
                    )}
                  </Space>
                ),
              },
              {
                title: t('budgetPool.colTarget'),
                align: 'right' as const,
                render: (_: unknown, row: BudgetPoolProposal['rows'][number]) =>
                  row.hasBaseline && row.projectedMonthEnd !== null ? (
                    <div>
                      <Typography.Text>{formatMoney(row.projectedMonthEnd)}</Typography.Text>
                      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                        {t('budgetPool.targetHint', { value: formatMoney(row.target) })}
                      </Typography.Text>
                    </div>
                  ) : (
                    <Typography.Text type="secondary">{t('budgetPool.noBaseline')}</Typography.Text>
                  ),
              },
              {
                title: t('budgetPool.colNeeded'),
                align: 'right' as const,
                render: (_: unknown, row: BudgetPoolProposal['rows'][number]) =>
                  row.hasBaseline ? (
                    <div>
                      <Typography.Text strong>{formatMoney(row.neededAdMonthly)}</Typography.Text>
                      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                        {t('budgetPool.neededHint', {
                          spent: formatMoney(row.mtdAdSpend),
                          required: formatMoney(row.requiredAdBudget),
                        })}
                      </Typography.Text>
                    </div>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              {
                title: t('budgetPool.colPool'),
                align: 'right' as const,
                render: (_: unknown, row: BudgetPoolProposal['rows'][number]) =>
                  formatMoney(row.adPoolMonthly),
              },
              {
                title: t('budgetPool.colDelta'),
                align: 'right' as const,
                render: (_: unknown, row: BudgetPoolProposal['rows'][number]) => {
                  const delta = row.take - row.give;
                  if (delta === 0) return <Typography.Text type="secondary">—</Typography.Text>;
                  return (
                    <Typography.Text style={{ color: delta > 0 ? 'var(--ark-green)' : 'var(--ark-red)' }}>
                      {delta > 0 ? '+' : '-'}
                      {formatMoney(Math.abs(delta))}
                    </Typography.Text>
                  );
                },
              },
              {
                title: t('budgetPool.colNext'),
                align: 'right' as const,
                render: (_: unknown, row: BudgetPoolProposal['rows'][number]) => (
                  <Typography.Text strong={row.give > 0 || row.take > 0}>
                    {formatMoney(row.nextAdPool)}
                  </Typography.Text>
                ),
              },
            ]}
          />
          {hasMoves && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('budgetPool.movesNote', { moves: movesText })}
            </Typography.Text>
          )}
          {proposal.expectedGmvGain > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('budgetPool.gain', { value: formatMoney(proposal.expectedGmvGain) })}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('budgetPool.auditNote')}
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
}

const GUARD_KEYS: Array<keyof StoreGoal['constraints']> = [
  'minGrossMargin',
  'maxDiscountPct',
  'monthlyBudgetCap',
];

function formatGuardSet(guards: StoreGoal['constraints']) {
  return `${guards.minGrossMargin}% · ${guards.maxDiscountPct}% · ${formatMoney(guards.monthlyBudgetCap)}`;
}

function signedMoney(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatMoney(Math.abs(value))}`;
}

/**
 * P37.1 账户护栏：人只对一组数表态一次，Agent 负责落到仍是平台模板值的店。
 * 这里不复制单店体检的完整建议——只回答「哪些店还是模板值、哪些在拦动作」，
 * 具体取值与预演仍走 orchestrator 的同一套口径。
 */
function AccountGuardSection({ storeIds }: { storeIds: AllMallId[] }) {
  const { t } = useI18n();
  const { can } = usePermission();
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can('setup', 'update');

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<StoreGoal['constraints'] | null>(null);
  const [reason, setReason] = useState('');

  const { data: view } = useQuery({
    queryKey: ['accountGuards', storeIds],
    queryFn: () => orchestratorApi.getAccountGuards(storeIds),
    enabled: storeIds.length > 1,
  });

  /** 只算不写：人改草案值时预演跟着变，确认前能看到放开 / 拦下几条。 */
  const { data: preview } = useQuery({
    queryKey: ['accountGuardPreview', storeIds, draft],
    queryFn: () => orchestratorApi.previewAccountGuards(storeIds, draft!),
    enabled: open && Boolean(draft),
  });

  const apply = useMutation({
    mutationFn: () =>
      operatingModelApi.applyAccountGuards(storeIds, draft!, {
        actor: user?.name ?? '当前用户',
        actorRole: role ?? undefined,
        reason,
      }),
    onError: (error) => message.error((error as Error).message),
    onSuccess: (result) => {
      // P50：账户护栏写回各店护栏，预算池所需广告与单店卡都要同页重算。
      invalidateOperatingModelQueries(queryClient);
      setOpen(false);
      setReason('');
      message.success(
        t('accountGuard.saved', {
          applied: String(result.applied.length),
          changed: String(result.changedFields),
          confirmed: String(result.confirmedFields),
          skipped: String(result.skipped.length),
        }),
      );
    },
  });

  if (storeIds.length <= 1 || !view) return null;

  const blocking = view.rows.filter((row) => row.blocks7d > 0).length;
  const keptCount = view.rows.length - view.pendingCount;

  return (
    <div style={{ marginBottom: 12 }}>
      <Space size={8} wrap>
        <SafetyCertificateOutlined style={{ color: 'var(--ark-blue)' }} />
        <Typography.Text strong>{t('accountGuard.title')}</Typography.Text>
        {view.pendingCount > 0 ? (
          <Tag color="orange">
            {t('accountGuard.pending', {
              count: String(view.pendingCount),
              total: String(view.rows.length),
            })}
          </Tag>
        ) : (
          <Tag color="green">{t('accountGuard.allSet')}</Tag>
        )}
        {blocking > 0 && (
          <Tag color="red">{t('accountGuard.blocking', { count: String(blocking) })}</Tag>
        )}
        {canEdit && (
          <Button
            size="small"
            icon={<SafetyCertificateOutlined />}
            disabled={view.pendingCount === 0}
            onClick={() => {
              setDraft({ ...view.suggestion.constraints });
              setReason('');
              setOpen(true);
            }}
          >
            {t('accountGuard.open')}
          </Button>
        )}
      </Space>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
        {t('accountGuard.summary')}
      </Typography.Text>

      <Modal
        open={open}
        width={820}
        title={t('accountGuard.modalTitle')}
        onCancel={() => setOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              loading={apply.isPending}
              disabled={!draft || !reason.trim() || view.pendingCount === 0}
              onClick={() => draft && apply.mutate()}
            >
              {t('accountGuard.confirm', { count: String(view.pendingCount) })}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={t('accountGuard.scopeNote', { count: String(view.pendingCount) })}
          />
          <Row gutter={8}>
            {[
              {
                key: 'minGrossMargin' as const,
                label: t('goal.minGrossMargin'),
                suffix: '%' as string | undefined,
                prefix: undefined as string | undefined,
              },
              {
                key: 'maxDiscountPct' as const,
                label: t('goal.maxDiscount'),
                suffix: '%' as string | undefined,
                prefix: undefined as string | undefined,
              },
              {
                key: 'monthlyBudgetCap' as const,
                label: t('goal.monthlyBudgetCap'),
                suffix: undefined as string | undefined,
                prefix: '¥' as string | undefined,
              },
            ].map((field) => (
              <Col span={8} key={field.key}>
                <Typography.Text type="secondary">{field.label}</Typography.Text>
                <InputNumber
                  style={{ width: '100%', marginTop: 4 }}
                  min={0}
                  max={field.suffix ? 100 : undefined}
                  addonAfter={field.suffix}
                  prefix={field.prefix}
                  value={draft?.[field.key]}
                  onChange={(value) =>
                    setDraft((current) => (current ? { ...current, [field.key]: value ?? 0 } : current))
                  }
                />
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                  {view.suggestion.basis[field.key] === 'human_consensus'
                    ? t('accountGuard.basisConsensus', {
                        count: String(view.suggestion.support[field.key]),
                      })
                    : t('accountGuard.basisTemplate')}
                </Typography.Text>
              </Col>
            ))}
          </Row>
          <Table
            rowKey="storeId"
            size="small"
            pagination={false}
            dataSource={view.rows}
            columns={[
              {
                title: t('accountGuard.colStore'),
                width: 200,
                render: (_: unknown, row: (typeof view.rows)[number]) => (
                  <Space size={4} wrap>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {row.storeName}
                    </Typography.Text>
                    {row.unconfirmed ? (
                      <Tag>{t('accountGuard.sourceTemplate')}</Tag>
                    ) : (
                      <Tag color="blue">{t('accountGuard.sourceHuman')}</Tag>
                    )}
                  </Space>
                ),
              },
              {
                title: t('accountGuard.colGuards'),
                render: (_: unknown, row: (typeof view.rows)[number]) => (
                  <Typography.Text style={{ fontSize: 12 }}>{formatGuardSet(row.guards)}</Typography.Text>
                ),
              },
              {
                title: t('accountGuard.colBlocks'),
                width: 110,
                align: 'right' as const,
                render: (_: unknown, row: (typeof view.rows)[number]) =>
                  row.blocks7d > 0 ? (
                    <Typography.Text style={{ color: 'var(--ark-red)' }}>{row.blocks7d}</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              {
                title: t('accountGuard.colAction'),
                width: 140,
                render: (_: unknown, row: (typeof view.rows)[number]) => {
                  if (!row.unconfirmed) {
                    return <Tag>{t('accountGuard.keep')}</Tag>;
                  }
                  const willChange = draft && GUARD_KEYS.some((key) => row.guards[key] !== draft[key]);
                  return (
                    <Tag color={willChange ? 'blue' : 'green'}>
                      {willChange ? t('accountGuard.willChange') : t('accountGuard.willConfirm')}
                    </Tag>
                  );
                },
              },
            ]}
          />
          {preview && (
            <Alert
              type="warning"
              showIcon
              message={
                preview.withCycleCount > 0
                  ? t('accountGuard.preview', {
                      stores: String(preview.withCycleCount),
                      unlocked: String(preview.unlocked),
                      blocked: String(preview.blocked),
                      gmv: signedMoney(preview.gmvDelta),
                      profit: signedMoney(preview.grossProfitDelta),
                    })
                  : t('accountGuard.previewNoCycle')
              }
            />
          )}
          {preview && preview.affectedApprovals.length > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 8 }}
              message={t('accountGuard.previewApprovals', {
                count: String(preview.affectedApprovals.length),
              })}
            />
          )}
          {keptCount > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accountGuard.keepNote', { count: String(keptCount) })}
            </Typography.Text>
          )}
          <div>
            <Typography.Text type="secondary">{t('accountGuard.reason')}</Typography.Text>
            <Input.TextArea
              rows={2}
              style={{ marginTop: 4 }}
              value={reason}
              placeholder={t('accountGuard.reasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('accountGuard.auditNote')}
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
}

export function PortfolioGoalsCard() {
  const { t } = useI18n();
  const { stores, scope, setScope, activeStore } = useStoreScope();
  const navigate = useNavigate();
  const storeIds = stores.map((store) => store.id);

  const { data: rows = [] } = useQuery({
    queryKey: ['portfolio', storeIds],
    queryFn: () => orchestratorApi.getPortfolio(storeIds),
    enabled: storeIds.length > 0,
  });

  const { data: arbitration } = useQuery({
    queryKey: ['crossStoreArbitration', storeIds],
    queryFn: () => orchestratorApi.getCrossStoreArbitration(storeIds),
    enabled: storeIds.length > 1,
  });

  if (storeIds.length === 0) return null;

  const currentLabel = activeStore?.name ?? t('biz.allStores');
  const pendingPlans = (arbitration?.plans ?? []).filter(
    (plan) => plan.status === 'suggested',
  ).length;
  const storeTargetSum = rows.reduce((sum, row) => sum + row.goal.target, 0);

  return (
    <Card
      id="portfolio-goals-card"
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space size={8} wrap>
          <Typography.Text strong>{t('portfolio.title')}</Typography.Text>
          <Tag color={scope === 'all' ? 'default' : 'blue'}>
            {t('portfolio.scope', { scope: currentLabel })}
          </Tag>
        </Space>
      }
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('portfolio.weekNote')}
        </Typography.Text>
      }
    >
      <AccountGoalSection storeIds={storeIds} storeTargetSum={storeTargetSum} />
      <BudgetPoolSection storeIds={storeIds} />
      <AccountGuardSection storeIds={storeIds} />
      <Table
        rowKey="storeId"
        dataSource={rows}
        pagination={false}
        size="small"
        scroll={{ x: 900 }}
        locale={{ emptyText: t('portfolio.empty') }}
        columns={[
          {
            title: t('portfolio.colStore'),
            dataIndex: 'storeId',
            width: 200,
            render: (storeId: number) => {
              const store = stores.find((item) => item.id === storeId);
              return (
                <Space size={6} wrap>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {store?.name ?? `#${storeId}`}
                  </Typography.Text>
                  {scope === storeId && <Tag color="blue">{t('portfolio.current')}</Tag>}
                </Space>
              );
            },
          },
          {
            title: t('portfolio.colProgress'),
            width: 220,
            render: (_: unknown, row: StorePortfolioRow) => {
              const pct = row.goal.target > 0
                ? Math.min(100, Math.round((row.goal.current / row.goal.target) * 100))
                : 0;
              return (
                <div>
                  <Progress percent={pct} size="small" showInfo={false} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('portfolio.progressValue', {
                      current: formatMoney(row.goal.current),
                      target: formatMoney(row.goal.target),
                    })}
                  </Typography.Text>
                </div>
              );
            },
          },
          {
            title: t('portfolio.colThisWeek'),
            dataIndex: 'attributedThisWeek',
            width: 140,
            align: 'right' as const,
            render: (value: number, row: StorePortfolioRow) => (
              <div>
                <Typography.Text strong style={{ color: value > 0 ? 'var(--ark-green)' : undefined }}>
                  +{formatMoney(value)}
                </Typography.Text>
                {row.realizedThisWeek > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    {t('portfolio.actions', { count: String(row.realizedThisWeek) })}
                  </Typography.Text>
                )}
              </div>
            ),
          },
          {
            title: t('portfolio.colLastWeek'),
            dataIndex: 'attributedLastWeek',
            width: 130,
            align: 'right' as const,
            render: (value: number) => (
              <Typography.Text type="secondary">{formatMoney(value)}</Typography.Text>
            ),
          },
          {
            title: t('portfolio.colWow'),
            width: 100,
            align: 'right' as const,
            render: (_: unknown, row: StorePortfolioRow) => {
              if (row.attributedLastWeek === 0) {
                return <Typography.Text type="secondary">—</Typography.Text>;
              }
              const pct = Math.round(
                ((row.attributedThisWeek - row.attributedLastWeek) / row.attributedLastWeek) * 100,
              );
              return (
                <Typography.Text strong style={{ color: pct >= 0 ? 'var(--ark-green)' : 'var(--ark-red)' }}>
                  {pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}%
                </Typography.Text>
              );
            },
          },
          {
            title: t('portfolio.colStatus'),
            width: 170,
            render: (_: unknown, row: StorePortfolioRow) => {
              if (!row.hasCycle) return <Tag>{t('portfolio.notGenerated')}</Tag>;
              return (
                <Space size={4} wrap>
                  <Tag color="blue">
                    {t('portfolio.proposals', { count: String(row.proposalCount) })}
                  </Tag>
                  {row.pendingCount > 0 && (
                    <Tag color="orange">
                      {t('portfolio.pending', { count: String(row.pendingCount) })}
                    </Tag>
                  )}
                </Space>
              );
            },
          },
          {
            title: t('portfolio.colAction'),
            width: 90,
            render: (_: unknown, row: StorePortfolioRow) =>
              scope === row.storeId ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('portfolio.current')}
                </Typography.Text>
              ) : (
                <Button type="link" size="small" onClick={() => setScope(row.storeId)}>
                  {t('portfolio.enter')}
                </Button>
              ),
          },
        ]}
      />

      {storeIds.length > 1 && (
        <>
          <Divider style={{ margin: '12px 0' }} />
          <Space size={8} wrap>
            <Typography.Text strong>{t('portfolio.crossTitle')}</Typography.Text>
            {arbitration && (
              <Tag color="purple">
                {t('portfolio.crossPool', {
                  requested: formatMoney(arbitration.sharedAdBudget.requested),
                  available: formatMoney(arbitration.sharedAdBudget.available),
                })}
              </Tag>
            )}
            {pendingPlans > 0 ? (
              <Tag color="orange">
                {t('portfolio.crossPending', { count: String(pendingPlans) })}
              </Tag>
            ) : (
              <Tag color="green">{t('portfolio.crossAllDecided')}</Tag>
            )}
            {pendingPlans > 0 && (
              <Button size="small" type="primary" onClick={() => navigate('/inbox')}>
                {t('portfolio.crossGoInbox')}
              </Button>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
            {t('portfolio.crossMovedNote')}
          </Typography.Text>
        </>
      )}
    </Card>
  );
}
