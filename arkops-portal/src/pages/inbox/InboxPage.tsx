/**
 * File: InboxPage.tsx
 * Purpose: WS-B (B1) unified Action Inbox — the single "what needs me" queue.
 * Aggregates pending approvals, unresolved exceptions, and store re-login
 * requests into one urgency/expiry-ordered list with type filters, inline
 * quick actions (decisions still go through the confirm step), and deep links
 * to detail surfaces. `/agents/approvals` and `/agents/exceptions` remain as
 * filtered views of this queue (product decision D2).
 *
 * Author: Michael Lee
 * Created: 2026-07-22
 *
 * Main exports:
 * - InboxPage: route-level page mounted at /inbox.
 *
 * Major updates:
 * - 2026-07-22: WS-B — created per D2 / plan items B1–B2.
 */
import {
  AlertOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  EyeOutlined,
  HistoryOutlined,
  InboxOutlined,
  LoginOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserAddOutlined
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Checkbox, Drawer, InputNumber, List, Modal, Popconfirm, Segmented, Select, Space, Tabs, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { approvalPolicyApi } from '../../api/approvalPolicies';
import { approvalsApi } from '../../api/approvals';
import { auditLogsApi } from '../../api/auditLogs';
import { exceptionsApi, compareEscalationPriority, routeEscalation, summarizeImpact } from '../../api/exceptions';
import type { ExceptionItem } from '../../api/exceptions';
import { orchestratorApi } from '../../api/orchestrator';
import { operatingModelApi } from '../../api/operatingModel';
import { AUTO_MERGE_CONFIDENCE_THRESHOLD, fieldConflictsApi, mergeSuggestionsApi, newProductCandidatesApi, productListingsApi, productsApi } from '../../api/products';
import { ordersApi } from '../../api/orders';
import { storesApi } from '../../api/stores';
import { useAuth } from '../../app/auth';
import { useI18n } from '../../app/i18n';
import { useStoreScope } from '../../app/storeScope';
import { usePermission } from '../../app/usePermission';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { TablePageSkeleton } from '../../components/PageSkeleton';
import { ProductThumb } from '../../components/products/ProductThumb';
import { StatusBadge } from '../../components/StatusBadge';
import { StoreConnectionEmptyState } from '../../components/StoreConnectionEmptyState';
import { getExpiringInDays } from '../../utils/storeDisplay';
import { getSlaState, isOrderActionable } from '../../utils/orderSla';
import { EXCEPTION_ORDER_STATUSES } from '../../types/domain';
import { ApprovalDecisionModal, type ApprovalDecision } from '../approvals/ApprovalDecisionModal';
import { InboxHistoryTab } from './InboxHistoryTab';
import { InboxAutoHandledTab, AUTO_HANDLED_WINDOW_DAYS, getAutoHandledRows } from './InboxAutoHandledTab';
import { settingsApi } from '../../api/settings';
import type { EscalationDecisionOption, EscalationTimeoutAction } from '../operations/exceptionCenterMockData';
import {
  URGENCY_COLORS,
  formatAge,
  formatRemaining,
  getApprovalUrgency,
  getDecisionUrgency,
  timeoutConsequenceKey
} from './urgency';
import type {
  AllMallId,
  Approval,
  FieldConflict,
  InboxItemKind,
  NewProductCandidate,
  Product,
  ProductListing,
  Order,
  ProductMergeSuggestion,
  Store
} from '../../types/domain';

type InboxFilter = 'all' | 'product' | 'store' | InboxItemKind;

/**
 * The four Smart Sync Tier 2 decisions (商品草稿/新品发现/疑似重复/字段冲突) share one
 * filter bucket: each has its own quick actions and Tag, but the full triage context for
 * all of them lives on the products page, not here — splitting them into four parallel
 * top-level filters added width without adding a real "narrow down what I'm looking at"
 * use case. `filter === 'product'` matches any of these four kinds.
 */
const PRODUCT_FILTER_KINDS: InboxItemKind[] = ['product_draft', 'product_new', 'product_merge', 'product_conflict'];

/**
 * Store-domain items: a session that already broke (relogin), one about to expire, and a
 * store whose authorization was never finished (store_pending). Same bucket for the same
 * reason as products — the filter should name the domain the merchant thinks in, not the
 * internal kind. `filter === 'store'` matches both kinds.
 */
const STORE_FILTER_KINDS: InboxItemKind[] = ['relogin', 'store_pending'];
/** P30.4：「今日 Top N」一次给出最值得先处理的数量，过多就退回逐条判断。 */
const TOP_PRIORITY_LIMIT = 5;

interface InboxEntry {
  key: string;
  kind: InboxItemKind;
  title: string;
  summary: string;
  storeName: string;
  /**
   * P39：这条待办归属的店铺。缺省 = 账户级（跨店方案、跨店合并等不归属单一店铺，
   * 任何店铺范围下都要能看到，否则换个店铺范围升级项就消失）。
   */
  storeId?: AllMallId;
  /** 0 = most urgent */
  urgencyRank: number;
  createdAt?: string;
  approval?: Approval;
  exception?: ExceptionItem;
  store?: Store;
  order?: Order;
  listing?: ProductListing;
  /** The product this listing belongs to (for product_draft entries to show thumbnail/price). */
  product?: Product;
  newProductCandidate?: NewProductCandidate;
  mergeSuggestion?: ProductMergeSuggestion;
  fieldConflict?: FieldConflict;
  /**
   * D7.3: set on proactive session-expiry warnings — the store is still connected, but
   * its authorization expires within the warning window. Distinguishes "act before it
   * breaks" from the reactive "already broken" re-login items.
   */
  expiresInDays?: number;
  /** Whether this entry's recommended action is safe to include in "accept all recommended". */
  batchable: boolean;
}

/**
 * P39：一条待办在店铺范围下的归属。返回 undefined 表示账户级（跨店方案、跨店合并），
 * 任何店铺范围下都要显示；返回数组表示「范围命中其中之一即显示」——账户级护栏合并项
 * 覆盖多家店，只挂在第一家店的范围下会让人换个店铺就看不到这条升级。
 */
function entryScopeStoreIds(entry: InboxEntry): AllMallId[] | undefined {
  if (entry.exception?.guardAccount) return entry.exception.guardAccount.storeIds;
  return entry.storeId === undefined ? undefined : [entry.storeId];
}

/** Field-conflict labels use the short form (products.descriptionLabel), not the page subtitle (products.description). */
const FIELD_LABEL_KEYS: Record<FieldConflict['field'], string> = {
  name: 'products.name',
  category: 'products.category',
  cost: 'products.cost',
  description: 'products.descriptionLabel'
};

/** Approval-rule wording per policy action, shown on approval items (D9). */
const APPROVAL_ACTION_LABELS: Record<'auto_execute' | 'single_approval' | 'dual_approval', string> = {
  auto_execute: 'agent.autoExecute',
  single_approval: 'agent.singleApproval',
  dual_approval: 'agent.dualApproval'
};

const KIND_TAG_COLORS: Record<InboxItemKind, string> = {
  approval: 'blue',
  exception: 'orange',
  relogin: 'red',
  store_pending: 'gold',
  order_exception: 'volcano',
  product_draft: 'purple',
  product_new: 'cyan',
  product_merge: 'gold',
  product_conflict: 'volcano'
};

type TranslateFn = ReturnType<typeof useI18n>['t'];

/**
 * Field-conflict comparison (Node 7): platform value vs. your (locked) value, side by
 * side, with the recommended option highlighted — a basic version now; reconciling
 * several conflicting fields on one product into a single decision surface is deferred.
 */
function FieldConflictComparison({ conflict, t }: { conflict: FieldConflict; t: TranslateFn }) {
  const highlightStyle = (isRecommended: boolean): CSSProperties => ({
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 12,
    background: isRecommended ? 'color-mix(in srgb, var(--ark-green) 12%, var(--ark-panel))' : 'var(--ark-panel-soft)',
    border: `1px solid ${isRecommended ? 'var(--ark-green)' : 'var(--ark-border-soft)'}`,
  });

  return (
    <div style={{ flex: '2 1 240px', minWidth: 0, marginBottom: 4 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t(FIELD_LABEL_KEYS[conflict.field])}：</Typography.Text>
      <Space size={8} wrap style={{ marginTop: 2 }}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{t('inbox.yourValueLabel')}</Typography.Text>
          <span style={highlightStyle(conflict.recommendation === 'keep_yours')}>{conflict.yourValue}</span>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>vs</Typography.Text>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{t('inbox.platformValueLabel')}</Typography.Text>
          <span style={highlightStyle(conflict.recommendation === 'accept_platform')}>{conflict.platformValue}</span>
        </div>
      </Space>
    </div>
  );
}

/**
 * What "accept" will actually do to one entry, plus the model's confidence where it has
 * one. Shown in the batch manifest so the user is agreeing to specific changes rather
 * than to a count.
 */
function describeRecommendation(entry: InboxEntry, t: TranslateFn): { action: string; confidence?: number } {
  if (entry.kind === 'product_new') {
    return { action: t('inbox.batchActionCreateProduct') };
  }
  if (entry.kind === 'product_merge' && entry.mergeSuggestion) {
    return { action: t('inbox.batchActionMerge'), confidence: entry.mergeSuggestion.confidence };
  }
  if (entry.kind === 'product_conflict' && entry.fieldConflict) {
    return {
      action: entry.fieldConflict.recommendation === 'keep_yours'
        ? t('inbox.batchActionKeepYours')
        : t('inbox.batchActionAcceptPlatform')
    };
  }
  if (entry.kind === 'order_exception' && entry.order?.recommendation) {
    return {
      action: entry.order.recommendation.label,
      confidence: Math.round(entry.order.recommendation.confidence * 100)
    };
  }
  return { action: t('inbox.acceptRecommended') };
}

/**
 * 可批量的三条标准，缺一不可：
 *   1. AI 推荐明确（高置信度或无歧义）
 *   2. 动作可逆或影响较小
 *   3. 逐条看也不会改变决定
 *
 * In English, for the same rule: an item may be batch-accepted only when the
 * recommendation leaves no judgement call, the action is reversible or low-impact, and
 * inspecting the item individually would not change what the user decides. Everything
 * else stays a one-by-one decision.
 *
 * This is the single place that decides. A new inbox kind has to be argued past all
 * three criteria here — not granted a `batchable: true` at its own construction site,
 * which is how the 60–95% merges and the locked-field overwrites slipped in before.
 */
function isBatchable(entry: Omit<InboxEntry, 'batchable'>): boolean {
  switch (entry.kind) {
    case 'product_new':
      // create_new only adds a record and is undone by deleting it. A likely_duplicate
      // is the textbook "seeing it might change your mind" case, so it stays manual.
      return entry.newProductCandidate?.recommendation === 'create_new';

    case 'product_merge':
      // D6 sub-decision 1: the 60–95% band exists precisely because a person should look
      // at the pair. Only the auto-merge band clears criterion 3.
      return (entry.mergeSuggestion?.confidence ?? 0) >= AUTO_MERGE_CONFIDENCE_THRESHOLD;

    case 'product_conflict':
      // keep_yours preserves the merchant's locked value — nothing of theirs is lost, so
      // it is reversible in the only sense that matters here. accept_platform discards a
      // manual edit that D6 sub-decision 2 says sync must never overwrite; that fails
      // criteria 2 and 3 and has to be seen field by field.
      return entry.fieldConflict?.recommendation === 'keep_yours';

    case 'order_exception': {
      const recommendation = entry.order?.recommendation;
      // Tier 3 (fraud release, cancel + refund) always needs a typed reason.
      if (!recommendation || recommendation.action === 'release' || recommendation.action === 'cancel_refund') return false;
      return recommendation.batchable;
    }

    default:
      // Approvals need a recorded reason; exceptions have their own resolve/ignore batch;
      // store items each need a real login session; drafts carry no recommendation to
      // accept in the first place.
      return false;
  }
}

function isValidFilter(value: string | null): value is InboxFilter {
  return (
    value === 'all' || value === 'product' || value === 'store' || value === 'approval' || value === 'exception' || value === 'relogin' || value === 'store_pending' || value === 'order_exception' ||
    value === 'product_draft' || value === 'product_new' || value === 'product_merge' || value === 'product_conflict'
  );
}

/**
 * Maps a per-kind `?type=` value onto the bucket that actually appears in the filter bar,
 * so links written before the buckets existed (e.g. `?type=relogin` from the store list)
 * still land on a highlighted segment instead of an unselected control.
 */
function toFilterBucket(value: InboxFilter): InboxFilter {
  if (STORE_FILTER_KINDS.includes(value as InboxItemKind)) return 'store';
  if (PRODUCT_FILTER_KINDS.includes(value as InboxItemKind)) return 'product';
  return value;
}

/**
 * P16：跨店方案不再在经营总览里单独拍板，而是以升级项的形式进入待办中心。
 * 升级项 id 约定为 `cross-esc-{planId}`，这里反解出方案 id 供 orchestrator 调用。
 */
function crossPlanIdOf(exception: ExceptionItem): string | undefined {
  return exception.id.startsWith('cross-esc-') ? exception.id.slice('cross-esc-'.length) : undefined;
}

export function InboxPage() {
  const { t } = useI18n();
  const { user, role } = useAuth();
  const { can } = usePermission();
  const { isAllStores, scope: shellScope, activeStore, setScope } = useStoreScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter: InboxFilter = isValidFilter(searchParams.get('type')) ? toFilterBucket(searchParams.get('type') as InboxFilter) : 'all';
  // P30.4：人不必逐条读摘要再自己判断先后。默认保持原排序；
  // 切到「今日 Top 5」即按可核对的影响金额取前 5 条，其余折叠，可一键展开。
  const [priorityView, setPriorityView] = useState<'default' | 'top' | 'all_ranked'>('default');
  const [decisionTarget, setDecisionTarget] = useState<{ approval: Approval; decision: ApprovalDecision } | null>(null);
  // D9: 待处理 / 自动处理 / 处理记录 — "what needs me → what the system did for me → what
  // I decided". Kept in `tab` so `?type=` keeps meaning "which kind of pending item";
  // the two params are independent and old links still work.
  const activeTab = searchParams.get('tab') === 'history' || searchParams.get('tab') === 'auto'
    ? (searchParams.get('tab') as 'history' | 'auto')
    : 'pending';
  const setActiveTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'pending') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  // Bulk actions cover exceptions only: exceptionsApi.batchResolve/batchIgnore are the
  // only batch endpoints, and approvals must stay one-by-one with their own confirm.
  const [selectedExceptionIds, setSelectedExceptionIds] = useState<string[]>([]);
  const [assignTarget, setAssignTarget] = useState<ExceptionItem | null>(null);
  const [assignee, setAssignee] = useState<string | undefined>();
  // P30.5：Agent 已按金额 / 级别 / 决策口径把升级项路由到角色，
  // 人只要在自己的队列里处理，不必从全部待办里挑「哪些归我」。
  // P31.3：角色首屏用 ?mine=1 深链直接落到「我负责的」，队列状态可分享、可回退。
  const mineOnly = searchParams.get('mine') === '1';
  const setMineOnly = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('mine', '1');
    else params.delete('mine');
    setSearchParams(params, { replace: true });
  };
  // Exception detail opened from the history tab.
  const [historyException, setHistoryException] = useState<ExceptionItem | null>(null);
  // "Accept all recommended" now confirms through a manifest rather than a bare count:
  // the batch spans several domains and varies in reversibility, so the user sees exactly
  // what will happen and can drop individual rows.
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchExcluded, setBatchExcluded] = useState<string[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  // P30.2: per-store escalation timeout policy; drafted locally so a half-edited row
  // never changes what the sweep will do until the user saves it.
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<
    Record<number, { timeoutHours: number; action: EscalationTimeoutAction }>
  >({});
  // The per-item mutations each toast on success. During a batch that would stack one
  // toast per item on top of the batch summary, so they stay quiet and let the summary
  // ("N applied, M failed") speak for the whole run.
  const suppressItemToast = useRef(false);
  const itemToast = (text: string) => { if (!suppressItemToast.current) message.success(text); };
  // Refresh countdowns periodically.
  const [clock, setClock] = useState(() => dayjs());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(dayjs()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // U6.3：会生成待办条目的查询必须持有引用，才能区分「还没读到 / 读不出来 / 真的没有」。
  // 失败重试收到 1 次（与 /orders、/agents 同口径），约 1s 内把「读不出来」交给用户。
  const approvalsQuery = useQuery({ queryKey: ['approvals'], queryFn: approvalsApi.list, retry: 1 });
  const approvals = approvalsQuery.data ?? [];
  // D9: the approval policy table left the inbox — the question it answered ("why does
  // this need me?") is answered on the item itself instead.
  const { data: approvalPolicies = [] } = useQuery({ queryKey: ['approval-policies'], queryFn: approvalPolicyApi.list });
  const exceptionsQuery = useQuery({ queryKey: ['exceptions'], queryFn: exceptionsApi.list, retry: 1 });
  const exceptions = exceptionsQuery.data ?? [];
  // P30.5：指派对象来自在册成员（含角色），不再用一份与成员表无关的硬编码名单。
  const { data: teamMembers = [] } = useQuery({ queryKey: ['members'], queryFn: settingsApi.members });
  // P30.3：人沉淀的决策规则，抽屉里可查、可撤销。
  const { data: decisionRules = [] } = useQuery({
    queryKey: ['decisionRules'],
    queryFn: async () => exceptionsApi.listDecisionRules(),
  });
  // P30.6：人工接管是按店铺维度的显式动作，抽屉里可接管 / 解除。
  const { data: takeovers = [] } = useQuery({
    queryKey: ['storeTakeovers'],
    queryFn: async () => exceptionsApi.listTakeovers(),
  });
  const storesQuery = useQuery({ queryKey: ['stores'], queryFn: storesApi.list, retry: 1 });
  const stores = storesQuery.data ?? [];
  const ordersQuery = useQuery({ queryKey: ['orders'], queryFn: ordersApi.list, retry: 1 });
  const orders = ordersQuery.data ?? [];
  const productListingsQuery = useQuery({ queryKey: ['productListings'], queryFn: productListingsApi.list, retry: 1 });
  const productListings = productListingsQuery.data ?? [];
  const productsQuery = useQuery({ queryKey: ['products'], queryFn: productsApi.list, retry: 1 });
  const products = productsQuery.data ?? [];
  const newProductCandidatesQuery = useQuery({ queryKey: ['newProductCandidates'], queryFn: newProductCandidatesApi.list, retry: 1 });
  const newProductCandidates = newProductCandidatesQuery.data ?? [];
  const mergeSuggestionsQuery = useQuery({ queryKey: ['productMergeSuggestions'], queryFn: mergeSuggestionsApi.list, retry: 1 });
  const mergeSuggestions = mergeSuggestionsQuery.data ?? [];
  const fieldConflictsQuery = useQuery({ queryKey: ['fieldConflicts'], queryFn: fieldConflictsApi.list, retry: 1 });
  const fieldConflicts = fieldConflictsQuery.data ?? [];
  // U1.3：第三问「系统替我做了什么」要在首屏就能答，不必先切到「自动处理」。
  // 与 tab 内容共用 getAutoHandledRows，徽标数字与点进去的行数同源。
  const auditLogsQuery = useQuery({ queryKey: ['audit-logs'], queryFn: auditLogsApi.list, retry: 1 });
  const auditLogs = auditLogsQuery.data ?? [];

  // P16：跨店方案与单店升级项在同一个入口拍板。Dashboard 只保留预算与待拍板摘要，
  // 决策动作全部收敛到这里，避免出现两套裁决面板。
  const crossStoreIds = stores.map((store) => store.id);
  const crossStoreNames = useMemo(() => {
    const names: Record<number, string> = {};
    stores.forEach((store) => { names[store.id] = store.name; });
    return names;
  }, [stores]);
  const refreshCrossStore = () => {
    queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    // P41.1：每次异常状态变化都会写审计轨迹，「自动处理」回执要和列表一起刷新。
    queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
    queryClient.invalidateQueries({ queryKey: ['crossStoreArbitration'] });
    queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    // P27: 跨店方案采纳会写归因账本，工作台复盘卡要同步。
    queryClient.invalidateQueries({ queryKey: ['reviewOutcomes'] });
  };
  const acceptCrossPlanMutation = useMutation({
    mutationFn: (planId: string) =>
      orchestratorApi.acceptCrossStorePlan(crossStoreIds, planId, crossStoreNames, user?.name),
    onSuccess: (result) => {
      refreshCrossStore();
      if (result.executionStatus === 'succeeded') itemToast(t('inbox.crossPlanAccepted'));
      else message.warning(t('inbox.crossPlanExecFailed'));
    },
    onError: () => message.error(t('inbox.crossPlanFailed'))
  });
  const dismissCrossPlanMutation = useMutation({
    mutationFn: (planId: string) => orchestratorApi.dismissCrossStorePlan(crossStoreIds, planId),
    onSuccess: () => {
      refreshCrossStore();
      itemToast(t('inbox.crossPlanDismissed'));
    },
    onError: () => message.error(t('inbox.crossPlanFailed'))
  });

  // P30.1：决策请求在收件箱内直接拍板。复用经营周期的裁决入口，
  // 选项落回提案状态；只关掉待办、不落结论的做法不在这里提供。
  const decideEscalationMutation = useMutation({
    mutationFn: async ({ exception, option }: { exception: ExceptionItem; option: EscalationDecisionOption }) => {
      const ref = exception.conflictRef!;
      const decide = () =>
        orchestratorApi.decideConflict(
          ref.storeId,
          ref.conflictId,
          option.id === 'override' ? 'override' : 'uphold',
          'manual',
          {
            actor: user?.name,
            note: `收件箱决策：${option.label}`,
            submitAfterOverride: option.id === 'override',
            storeName: exception.storeName,
          },
        );
      try {
        return await decide();
      } catch (error) {
        const messageText = (error as Error).message;
        if (messageText !== 'cycle_not_found') throw error;
        // 刷新后内存中的本轮方案会丢失；同店提案与冲突 id 稳定，重生成后再落结论，
        // 避免决策请求变成点不动的死待办。
        await orchestratorApi.generateCycle(ref.storeId, { trigger: 'manual', storeName: exception.storeName });
        try {
          return await decide();
        } catch (retryError) {
          const retryMessage = (retryError as Error).message;
          if (retryMessage !== 'conflict_not_found' && retryMessage !== 'conflict_already_decided') throw retryError;
          // 重生成后冲突已不存在（动作已完成或被其他结论覆盖），决策请求随之关闭。
          await exceptionsApi.resolve(exception.id, '本轮方案已重新生成，该冲突不再存在，决策请求自动关闭');
          return null;
        }
      }
    },
    onSuccess: (result, vars) => {
      refreshCrossStore();
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['outcomes'] });
      if (result === null) {
        itemToast(t('inbox.decisionStaleClosed'));
        return;
      }
      itemToast(vars.option.id === 'override' ? t('inbox.decisionOverrideToast') : t('inbox.decisionUpholdToast'));
    },
    onError: () => message.error(t('inbox.decisionFailed')),
  });

  // P33.1：目标节奏升级的结论直接落回目标，而不是只关掉待办。
  // 维持 → 记下「缺口被人接受」；下调 → 按 Agent 算出的可达值改写目标并校准进度。
  const goalRemedyMutation = useMutation({
    mutationFn: ({ exception, option }: { exception: ExceptionItem; option: EscalationDecisionOption }) => {
      if (!exception.storeId) throw new Error('missing_store');
      return operatingModelApi.applyGoalPaceRemedy(
        exception.storeId,
        option.id === 'override' ? 'override' : 'uphold',
        { actor: user?.name ?? '当前用户', exceptionId: exception.id },
      );
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
      queryClient.invalidateQueries({ queryKey: ['goalPace'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['outcomes'] });
      itemToast(result.applied ? t('inbox.goalRemedyLowered') : t('inbox.goalRemedyKept'));
    },
    onError: () => message.error(t('inbox.decisionFailed')),
  });

  // P34.1：上期结算未达成的结论直接落回本月目标——
  // 沿用不改目标，下调按上期实际（取整到千元）改写并校准进度。
  const settlementRemedyMutation = useMutation({
    mutationFn: ({ exception, option }: { exception: ExceptionItem; option: EscalationDecisionOption }) => {
      if (!exception.storeId) throw new Error('missing_store');
      return operatingModelApi.applyGoalSettlementRemedy(
        exception.storeId,
        option.id === 'override' ? 'override' : 'uphold',
        { actor: user?.name ?? '当前用户', exceptionId: exception.id },
      );
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
      queryClient.invalidateQueries({ queryKey: ['goalPace'] });
      queryClient.invalidateQueries({ queryKey: ['goalPeriod'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['outcomes'] });
      itemToast(result.applied ? t('inbox.settlementRemedyLowered') : t('inbox.settlementRemedyKept'));
    },
    onError: () => message.error(t('inbox.decisionFailed')),
  });
  // P49：账户上期的结论直接落回账户目标——沿用不动数字、只记本月已确认；下调按上期实际改写。
  // 两者都不重写各店目标，也不动护栏。
  const accountSettlementMutation = useMutation({
    mutationFn: ({ exception, option }: { exception: ExceptionItem; option: EscalationDecisionOption }) =>
      operatingModelApi.applyAccountGoalSettlementRemedy(
        option.id === 'override' ? 'override' : 'uphold',
        { actor: user?.name ?? '当前用户', exceptionId: exception.id },
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['outcomes'] });
      itemToast(result.applied ? t('inbox.accountSettlementLowered') : t('inbox.accountSettlementKept'));
    },
    onError: () => message.error(t('inbox.decisionFailed')),
  });
  // P36.1：护栏体检升级的结论直接落回护栏——确认维持只留痕，调至建议值才改护栏。
  const guardRemedyMutation = useMutation({
    mutationFn: async ({
      exception,
      option,
    }: {
      exception: ExceptionItem;
      option: EscalationDecisionOption;
    }): Promise<{ applied: boolean; value?: number | null; stores?: number; skipped?: number }> => {
      // P38.1：账户级同类护栏按名单逐店落库，与单店护栏共用同一条处理入口。
      if (exception.type === 'guard_health_account') {
        return orchestratorApi.applyAccountGuardRemedy(
          exception.id,
          option.id === 'override' ? 'override' : 'uphold',
          { actor: user?.name ?? '当前用户', actorRole: role ?? undefined },
        );
      }
      if (!exception.storeId) throw new Error('missing_store');
      return orchestratorApi.applyGuardHealthRemedy(
        exception.storeId,
        exception.id,
        option.id === 'override' ? 'override' : 'uphold',
        { actor: user?.name ?? '当前用户', actorRole: role ?? undefined },
      );
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['guardHealth'] });
      queryClient.invalidateQueries({ queryKey: ['guardChanges'] });
      queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
      queryClient.invalidateQueries({ queryKey: ['goalPace'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
      if (result.stores !== undefined) {
        itemToast(t('inbox.guardAccountApplied', { count: result.stores }));
      } else {
        itemToast(result.applied ? t('inbox.guardRemedyAdopted') : t('inbox.guardRemedyKept'));
      }
    },
    onError: () => message.error(t('inbox.decisionFailed')),
  });
  // P30.1：到期仍无人处理的决策，由 Agent 按默认建议（维持护栏）收尾。
  // 只做不扩大权限的默认结论；判断错了，人仍可在经营周期里改判。
  // P30.3：先跑人沉淀的「以后都这样」规则，剩下的才轮到超时默认。
  const sweptExpiredDecisions = useRef(false);
  useEffect(() => {
    if (sweptExpiredDecisions.current) return;
    sweptExpiredDecisions.current = true;
    const refreshDecisionState = () => {
      refreshCrossStore();
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['outcomes'] });
      queryClient.invalidateQueries({ queryKey: ['decisionRules'] });
    };
    orchestratorApi
      .applyDecisionRules()
      .then((ruleCount) => {
        if (ruleCount > 0) {
          refreshDecisionState();
          message.info(t('inbox.ruleAutoApplied', { count: ruleCount }));
        }
        return orchestratorApi.applyExpiredDecisionDefaults();
      })
      .then((count) => {
        if (count === 0) return;
        refreshDecisionState();
        message.info(t('inbox.decisionTimeoutApplied', { count }));
      });
  }, [queryClient, t]);

  // P33.1：节奏升级由目标卡按店铺触发。打开收件箱时把缺少结论选项的旧条目按当前节奏补算一次，
  // 避免同一类升级出现「有的能拍板、有的只能去处理」两套形态。
  useEffect(() => {
    let cancelled = false;
    exceptionsApi
      .list()
      .then((items) => {
        const pending = items.filter(
          (item) =>
            !item.resolved &&
            !item.ignored &&
            item.type === 'goal_pace_escalation' &&
            item.storeId !== undefined &&
            !item.decision,
        );
        if (pending.length === 0) return;
        return Promise.all(
          pending.map((item) => operatingModelApi.syncGoalPaceEscalation(item.storeId!)),
        ).then((results) => {
          if (!cancelled && results.some((result) => result.escalated)) {
            queryClient.invalidateQueries({ queryKey: ['exceptions'] });
          }
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const decide = useMutation({
    mutationFn: ({
      approvalId,
      status,
      note,
      acknowledgeGuardViolation,
    }: {
      approvalId: number;
      status: ApprovalDecision;
      note?: string;
      acknowledgeGuardViolation?: boolean;
    }) => approvalsApi.decide(approvalId, status, note, { acknowledgeGuardViolation }),
    onSuccess: (result) => {
      setDecisionTarget(null);
      if (result?.guardBlocked?.length) {
        // P57：护栏收紧后接口会拦下通过，收件箱不能提示「已更新」；豁免在审批详情里做。
        message.warning(t('approvalDetail.guardReviewBlocked'));
      } else if (result && !result.finalized) {
        message.info(
          t('approvalDetail.dualFirstRecorded', {
            completed: result.approvalsCompleted,
            required: result.approvalsRequired
          })
        );
      } else {
        message.success(t('approvals.updated'));
      }
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      // P27: 收件箱里拍板同样会回写目标、周期与归因账本，别只刷待办列表。
      queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['outcomes'] });
      queryClient.invalidateQueries({ queryKey: ['reviewOutcomes'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
    }
  });

  // Smart Sync Tier 2 decisions (Node 3): one-click accept/dismiss inline in the inbox,
  // reusing the same mutations the Products page's merge queue and detail page use.
  const acceptNewProductMutation = useMutation({
    mutationFn: (id: number) => newProductCandidatesApi.accept(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['newProductCandidates'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['productListings'] });
      itemToast(t('inbox.newProductAccepted'));
    }
  });
  const dismissNewProductMutation = useMutation({
    mutationFn: (id: number) => newProductCandidatesApi.dismiss(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['newProductCandidates'] });
      message.success(t('inbox.dismissed'));
    }
  });
  const mergeProductsMutation = useMutation({
    mutationFn: (id: number) => mergeSuggestionsApi.merge(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productMergeSuggestions'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['productListings'] });
      itemToast(t('inbox.merged'));
    }
  });
  const dismissMergeMutation = useMutation({
    mutationFn: (id: number) => mergeSuggestionsApi.dismiss(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productMergeSuggestions'] });
      message.success(t('inbox.dismissed'));
    }
  });
  const batchResolveMutation = useMutation({
    mutationFn: (ids: string[]) => exceptionsApi.batchResolve(ids),
    onSuccess: (_data, ids) => {
      message.success(t('inbox.batchResolveDone', { count: ids.length }));
      setSelectedExceptionIds([]);
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    }
  });
  // U2.2：批量忽略可撤回。沿用历史页「恢复」语义（exceptionsApi.unignore），
  // 把刚忽略的条目放回待处理，回执写明恢复条数，便于和列表行数对账。
  const restoreBatchIgnored = async (ids: string[]) => {
    await Promise.all(ids.map((id) => exceptionsApi.unignore(id)));
    queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    message.success(t('inbox.batchIgnoreUndone', { count: ids.length }));
  };
  const batchIgnoreMutation = useMutation({
    mutationFn: (ids: string[]) => exceptionsApi.batchIgnore(ids),
    onSuccess: (_data, ids) => {
      message.success({
        content: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {t('inbox.batchIgnoreDone', { count: ids.length })}
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: 'auto', fontSize: 12 }}
              onClick={() => void restoreBatchIgnored(ids)}
            >
              {t('inbox.restore')}
            </Button>
          </span>
        ),
        duration: 8,
      });
      setSelectedExceptionIds([]);
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    }
  });
  const assignMutation = useMutation({
    mutationFn: (input: { id: string; assignee: string }) => exceptionsApi.assign(input.id, input.assignee, user?.name),
    onSuccess: () => {
      message.success(t('inbox.assignSuccess'));
      setAssignTarget(null);
      setAssignee(undefined);
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    }
  });
  const savePolicyMutation = useMutation({
    mutationFn: (input: { storeId: number; timeoutHours: number; action: EscalationTimeoutAction }) =>
      exceptionsApi.saveEscalationPolicy(input.storeId, input.timeoutHours, input.action),
    onSuccess: (policy) => {
      message.success(t('inbox.escalationPolicySaved'));
      setPolicyDraft((prev) => ({
        ...prev,
        [policy.storeId]: { timeoutHours: policy.timeoutHours, action: policy.action },
      }));
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    },
  });
  const resumeAgentMutation = useMutation({
    mutationFn: (input: { storeId: number; agentType: string }) =>
      exceptionsApi.resumeAgent(input.storeId, input.agentType),
    onSuccess: () => {
      message.success(t('inbox.escalationResumed'));
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
    },
  });
  // P30.6：接管只冻结「自动执行」，不冻结提案——人仍可手动提交保留的动作。
  const takeoverMutation = useMutation({
    mutationFn: (input: { storeId: number; active: boolean }): Promise<unknown> =>
      input.active
        ? exceptionsApi.startTakeover(input.storeId)
        : exceptionsApi.endTakeover(input.storeId),
    onSuccess: (_, input) => {
      message.success(t(input.active ? 'inbox.takeoverStarted' : 'inbox.takeoverEnded'));
      queryClient.invalidateQueries({ queryKey: ['storeTakeovers'] });
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['autoTrigger'] });
    },
    onError: () => message.error(t('inbox.takeoverFailed')),
  });
  // P30.3：把「同类升级每次都这样选」沉淀成规则。依据只取人自己点过的连续结论，
  // 建完规则立刻对本条生效——否则人还要再点一次同样的按钮。
  const adoptRuleMutation = useMutation({
    mutationFn: async ({ exception }: { exception: ExceptionItem }) => {
      const storeId = exception.storeId!;
      const kind = exception.decisionKind!;
      const history = exceptionsApi.getDecisionHistory(storeId, kind);
      await exceptionsApi.saveDecisionRule({
        storeId,
        decisionKind: kind,
        outcome: history.outcome ?? 'uphold',
        sourceDecisionIds: history.sourceIds,
      });
      return orchestratorApi.applyDecisionRules();
    },
    onSuccess: () => {
      message.success(t('inbox.ruleCreated'));
      queryClient.invalidateQueries({ queryKey: ['decisionRules'] });
      queryClient.invalidateQueries({ queryKey: ['exceptions'] });
      refreshCrossStore();
      queryClient.invalidateQueries({ queryKey: ['operatingCycle'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: () => message.error(t('inbox.ruleFailed')),
  });
  const revokeRuleMutation = useMutation({
    mutationFn: (id: string) => exceptionsApi.revokeDecisionRule(id),
    onSuccess: () => {
      message.success(t('inbox.ruleRevoked'));
      queryClient.invalidateQueries({ queryKey: ['decisionRules'] });
    },
  });
  const applyOrderRecMutation = useMutation({
    mutationFn: (orderId: number) => ordersApi.applyRecommendation(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['orderSync'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      itemToast(t('inbox.orderRecommendationApplied'));
    }
  });
  const resolveFieldConflictMutation = useMutation({
    mutationFn: (input: { id: number; decision: 'keep_yours' | 'accept_platform' }) => fieldConflictsApi.resolve(input.id, input.decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fieldConflicts'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      itemToast(t('inbox.conflictResolved'));
    }
  });

  // T-PROD-004: draft listing actions — submit for review, approve, reject
  const submitDraftMutation = useMutation({
    mutationFn: (listingId: number) => productListingsApi.updateStatus(listingId, 'pending_review'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productListings'] });
      itemToast(t('inbox.draftSubmitted'));
    }
  });
  const approveListingMutation = useMutation({
    mutationFn: (listingId: number) => productListingsApi.updateStatus(listingId, 'listed'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productListings'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      itemToast(t('inbox.draftApproved'));
    }
  });
  const rejectListingMutation = useMutation({
    mutationFn: (listingId: number) => productListingsApi.updateStatus(listingId, 'draft'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productListings'] });
      itemToast(t('inbox.draftRejected'));
    }
  });

  const entries = useMemo<InboxEntry[]>(() => {
    const list: Omit<InboxEntry, 'batchable'>[] = [];

    for (const approval of approvals) {
      if (approval.status !== 'pending') continue;
      const urgency = getApprovalUrgency(approval, clock);
      list.push({
        key: `approval-${approval.id}`,
        kind: 'approval',
        title: approval.title,
        summary: approval.proposedAction,
        storeName: approval.storeName,
        storeId: approval.storeId,
        urgencyRank: urgency ? (urgency.tone === 'critical' ? 0 : urgency.tone === 'warning' ? 1 : 2) : 2,
        createdAt: approval.requestedAt,
        approval
      });
    }

    for (const exception of exceptions) {
      if (exception.resolved || exception.ignored) continue;
      list.push({
        key: `exception-${exception.id}`,
        kind: 'exception',
        title: exception.title,
        summary: exception.summary,
        storeName: exception.storeName,
        storeId: exception.storeId,
        urgencyRank: exception.level === 'critical' ? 0 : exception.level === 'warning' ? 1 : 2,
        createdAt: exception.createdAt,
        exception
      });
    }

    for (const store of stores) {
      if (store.status === 'login_required' || store.status === 'expired') {
        list.push({
          key: `relogin-${store.id}`,
          kind: 'relogin',
          title: t('inbox.reloginTitle', { store: store.name }),
          summary: t('inbox.reloginSummary'),
          storeName: store.name,
          storeId: store.id,
          urgencyRank: 0,
          createdAt: store.lastVerifiedAt,
          store
        });
        continue;
      }
      // A store record exists but its authorization was never completed, so nothing has
      // synced for it yet. Resolvable (finish the login and it leaves the queue), and
      // easy to forget precisely because nothing about it is visibly broken.
      if (store.status === 'pending_login') {
        list.push({
          key: `store_pending-${store.id}`,
          kind: 'store_pending',
          title: t('inbox.storePendingTitle', { store: store.name }),
          summary: t('inbox.storePendingSummary'),
          storeName: store.name,
          storeId: store.id,
          urgencyRank: 2,
          createdAt: store.createdAt,
          store
        });
        continue;
      }
      // D7.3: proactive expiry warning — a still-connected store whose authorization
      // runs out within the warning window becomes a "renew now" item before anything
      // breaks. Lower urgency than an already-expired session: nothing is paused yet.
      const expiringInDays = getExpiringInDays(store, clock);
      if (expiringInDays !== undefined) {
        list.push({
          key: `relogin-expiring-${store.id}`,
          kind: 'relogin',
          title: t('inbox.expiringTitle', { store: store.name }),
          summary: t('inbox.expiringSummary', {
            days: expiringInDays,
            date: dayjs(store.authExpiresAt).format('MM-DD HH:mm')
          }),
          storeName: store.name,
          storeId: store.id,
          urgencyRank: 2,
          createdAt: store.lastVerifiedAt,
          store,
          expiresInDays: expiringInDays
        });
      }
    }

    // D8/O4: orders that need a person — exceptions, plus orders about to miss (or that
    // have missed) the platform shipping deadline. Same "needs me" definition the orders
    // page and the sidebar badge use, so the three can never disagree.
    for (const order of orders) {
      if (!isOrderActionable(order, clock)) continue;
      const sla = getSlaState(order, clock);
      const storeName = stores.find((s) => s.id === order.storeId)?.name ?? '';
      const isException = EXCEPTION_ORDER_STATUSES.includes(order.status);
      // Breached/critical outrank exceptions with time to spare; the 6h warning band sits
      // below both so widening the window (D8) did not push genuinely urgent items down.
      const urgencyRank = sla.tone === 'breached' || sla.tone === 'critical'
        ? 0
        : isException ? 1 : 2;
      // Tier 2 recommendations can be accepted in bulk; fraud release and cancel/refund
      // are Tier 3 and must stay one-by-one with a typed reason on the orders page.
      const tier2 = order.recommendation && order.recommendation.action !== 'release' && order.recommendation.action !== 'cancel_refund'
        ? order.recommendation
        : undefined;
      list.push({
        key: `order_exception-${order.id}`,
        kind: 'order_exception',
        title: isException
          ? t('inbox.orderExceptionTitle', { order: order.orderNo })
          : sla.tone === 'breached'
            ? t('inbox.orderSlaBreachedTitle', { order: order.orderNo })
            : t('inbox.orderSlaTitle', { order: order.orderNo }),
        // A Tier 3 exception (fraud, cancel/refund) has no one-click recommendation, so
        // fall back to why it was flagged rather than to deadline copy that may not apply.
        summary: tier2
          ? tier2.rationale
          : isException
            ? (order.exceptionReason?.split('\n')[0] ?? t('inbox.orderExceptionFallbackSummary'))
            : sla.tone === 'breached'
              ? t('inbox.orderSlaBreachedSummary')
              : t('inbox.orderSlaSummary'),
        storeName,
        storeId: order.storeId,
        urgencyRank,
        createdAt: order.createdAt,
        order
      });
    }

    // D6/§3.14.9: draft/pending_review product listings fold into the inbox — informational,
    // low urgency (they don't block anything), sorted with everything else by recency.
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const listing of productListings) {
      if (listing.status !== 'draft' && listing.status !== 'pending_review') continue;
      const product = productById.get(listing.productId);
      if (!product) continue;
      const storeName = stores.find((s) => s.id === listing.storeId)?.name ?? '';
      list.push({
        key: `product_draft-${listing.id}`,
        kind: 'product_draft',
        title: product.name,
        summary: t(`inbox.productDraftSummary_${listing.status}`, { store: storeName }),
        storeName,
        storeId: listing.storeId,
        urgencyRank: 3,
        createdAt: listing.lastSyncedAt,
        listing,
        product
      });
    }

    // Smart Sync Tier 2 (Node 3): possibly-new products, merge suggestions and locked-
    // field conflicts all surface here too, each with a one-click accept for the AI
    // recommendation. Which of them may also be accepted *in bulk* is decided in one
    // place — see isBatchable.
    for (const candidate of newProductCandidates) {
      const storeName = stores.find((s) => s.id === candidate.storeId)?.name ?? '';
      const duplicateOf = candidate.possibleDuplicateOfProductId != null
        ? products.find((p) => p.id === candidate.possibleDuplicateOfProductId)
        : undefined;
      list.push({
        key: `product_new-${candidate.id}`,
        kind: 'product_new',
        title: candidate.name,
        summary: candidate.recommendation === 'create_new'
          ? t('inbox.newProductSummaryCreate')
          : t('inbox.newProductSummaryDuplicate', { product: duplicateOf?.name ?? '' }),
        storeName,
        storeId: candidate.storeId,
        urgencyRank: 2,
        createdAt: candidate.createdAt,
        newProductCandidate: candidate
      });
    }

    for (const suggestion of mergeSuggestions) {
      const productA = productById.get(suggestion.productAId);
      const productB = productById.get(suggestion.productBId);
      if (!productA || !productB) continue;
      list.push({
        key: `product_merge-${suggestion.id}`,
        kind: 'product_merge',
        title: t('inbox.mergeTitle', { a: productA.name, b: productB.name }),
        summary: t('inbox.mergeSummary', { value: suggestion.confidence }),
        // 跨店同款合并：不归属单一店铺，任何店铺范围下都要可见。
        storeName: '',
        urgencyRank: 2,
        createdAt: suggestion.createdAt,
        mergeSuggestion: suggestion
      });
    }

    for (const conflict of fieldConflicts) {
      const product = productById.get(conflict.productId);
      if (!product) continue;
      const storeName = stores.find((s) => s.id === conflict.storeId)?.name ?? '';
      list.push({
        key: `product_conflict-${conflict.id}`,
        kind: 'product_conflict',
        title: t('inbox.conflictTitle', { product: product.name }),
        summary: t('inbox.conflictSummary', { field: t(FIELD_LABEL_KEYS[conflict.field]), yours: conflict.yourValue, platform: conflict.platformValue }),
        storeName,
        storeId: conflict.storeId,
        urgencyRank: 1,
        createdAt: conflict.createdAt,
        fieldConflict: conflict
      });
    }

    return list
      .map((entry): InboxEntry => ({ ...entry, batchable: isBatchable(entry) }))
      .sort((a, b) => {
      if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
      const remainingA = a.approval ? getApprovalUrgency(a.approval, clock)?.remainingMs : undefined;
      const remainingB = b.approval ? getApprovalUrgency(b.approval, clock)?.remainingMs : undefined;
      if (remainingA !== undefined && remainingB !== undefined) return remainingA - remainingB;
      if (remainingA !== undefined) return -1;
      if (remainingB !== undefined) return 1;
      return dayjs(b.createdAt ?? 0).valueOf() - dayjs(a.createdAt ?? 0).valueOf();
    });
  }, [approvals, exceptions, stores, productListings, products, newProductCandidates, mergeSuggestions, fieldConflicts, clock, t]);

  // P39：店铺范围在待办中心显式化。选单店时只看「本店 + 账户级」，其余店铺的条数写在
  // 范围条上并可一键回到全部——既不静默隐藏升级项，也不让人在错误店铺的上下文里拍板。
  const entriesInScope = useMemo(() => {
    if (isAllStores) return entries;
    return entries.filter((entry) => {
      const storeIds = entryScopeStoreIds(entry);
      if (!storeIds) return true;
      return typeof shellScope === 'number' && storeIds.includes(shellScope);
    });
  }, [entries, isAllStores, shellScope]);
  const hiddenByScopeCount = entries.length - entriesInScope.length;
  const accountLevelInScopeCount = entriesInScope.filter((entry) => !entryScopeStoreIds(entry)).length;

  const counts = useMemo(() => {
    const byKind: Record<InboxItemKind, number> = {
      approval: 0, exception: 0, relogin: 0, store_pending: 0, order_exception: 0, product_draft: 0, product_new: 0, product_merge: 0, product_conflict: 0
    };
    for (const entry of entriesInScope) byKind[entry.kind] += 1;
    return { ...byKind, all: entriesInScope.length };
  }, [entriesInScope]);

  // U1.3：三问里的第三问——「系统替我做了什么」——在首屏就给出条数。
  // 与「自动处理」tab 的内容同源（getAutoHandledRows），点进去行数一定对得上。
  const autoHandledCount = useMemo(() => getAutoHandledRows(auditLogs).length, [auditLogs]);

  const visibleEntries = filter === 'all'
    ? entriesInScope
    : filter === 'product'
      ? entriesInScope.filter((entry) => PRODUCT_FILTER_KINDS.includes(entry.kind))
      : filter === 'store'
        ? entriesInScope.filter((entry) => STORE_FILTER_KINDS.includes(entry.kind))
        : entriesInScope.filter((entry) => entry.kind === filter);

  // P30.5：责任按角色归位——同名成员换岗后队列自动跟着角色走；人工改派仍优先命中。
  const isMyQueueItem = (item?: ExceptionItem) => {
    if (!item || !user || item.resolved || item.ignored) return false;
    return item.assignee === user.name || item.assigneeRole === user.role;
  };
  const myQueueCount = entriesInScope.filter((entry) => isMyQueueItem(entry.exception)).length;
  const scopedEntries = mineOnly ? visibleEntries.filter((entry) => isMyQueueItem(entry.exception)) : visibleEntries;

  // P30.4：排序只把「有金额」的升级项提到前面；审批、重连、订单等没有金额口径的待办
  // 保持原有顺序跟在后面，不因缺少金额被降权或丢弃。
  const impactRankedEntries = useMemo(() => {
    const quantified = scopedEntries
      .filter((entry) => Boolean(entry.exception?.impact))
      .sort((a, b) => compareEscalationPriority(a.exception!, b.exception!));
    const rest = scopedEntries.filter((entry) => !entry.exception?.impact);
    return [...quantified, ...rest];
  }, [scopedEntries]);
  const impactSummary = useMemo(
    () =>
      summarizeImpact(
        scopedEntries
          .map((entry) => entry.exception)
          .filter((item): item is ExceptionItem => Boolean(item)),
      ),
    [scopedEntries],
  );
  const rankedMode = priorityView !== 'default';
  const displayedEntries = priorityView === 'top'
    ? impactRankedEntries.slice(0, TOP_PRIORITY_LIMIT)
    : priorityView === 'all_ranked'
      ? impactRankedEntries
      : scopedEntries;
  // D7.3: ordered store ids for guided sequential re-login — already-expired stores
  // first (they block agents now), then the proactive expiry warnings.
  const reloginQueue = visibleEntries
    .filter((entry) => entry.kind === 'relogin' && entry.store)
    .map((entry) => entry.store!.id);
  const canApplyBatchEntry = (entry: InboxEntry) => {
    if (entry.kind === 'order_exception') return can('orders', 'update');
    if (entry.kind === 'product_new' || entry.kind === 'product_merge' || entry.kind === 'product_conflict') {
      return can('products', 'update');
    }
    return false;
  };
  const batchableEntries = scopedEntries.filter((entry) => entry.batchable && canApplyBatchEntry(entry));
  const batchAccepting = batchRunning;

  /** Applies one entry's recommendation. Throws so the caller can count failures. */
  const applyRecommendationFor = async (entry: InboxEntry): Promise<void> => {
    if (entry.kind === 'product_new' && entry.newProductCandidate) {
      await acceptNewProductMutation.mutateAsync(entry.newProductCandidate.id);
    } else if (entry.kind === 'product_merge' && entry.mergeSuggestion) {
      await mergeProductsMutation.mutateAsync(entry.mergeSuggestion.id);
    } else if (entry.kind === 'order_exception' && entry.order) {
      await applyOrderRecMutation.mutateAsync(entry.order.id);
    } else if (entry.kind === 'product_conflict' && entry.fieldConflict) {
      // Apply each conflict's own recommendation, not a blanket keep_yours — otherwise
      // "accept all recommended" would silently reject platform values it recommended.
      await resolveFieldConflictMutation.mutateAsync({ id: entry.fieldConflict.id, decision: entry.fieldConflict.recommendation });
    }
  };

  const handleBatchAccept = async () => {
    const targets = batchableEntries.filter((entry) => !batchExcluded.includes(entry.key));
    if (targets.length === 0) return;
    setBatchRunning(true);
    suppressItemToast.current = true;
    // Sequential but fault-isolated: one failure used to abort the loop, leaving the
    // already-applied items done, the rest untouched and the user told nothing.
    const outcomes = await Promise.allSettled(
      targets.map((entry) => () => applyRecommendationFor(entry)).map((run) => run())
    );
    suppressItemToast.current = false;
    setBatchRunning(false);
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    const succeeded = outcomes.length - failed;
    if (failed === 0) {
      message.success(t('inbox.batchAcceptDone', { count: succeeded }));
    } else {
      message.warning(t('inbox.batchAcceptPartial', { done: succeeded, failed }));
    }
    setBatchModalOpen(false);
    setBatchExcluded([]);
  };

  // P30.2：升级超时策略——每个店铺可以决定“多少小时未处理 → Agent 做什么”。
  const openPolicyDrawer = () => {
    const draft: Record<number, { timeoutHours: number; action: EscalationTimeoutAction }> = {};
    stores.forEach((store) => {
      const policy = exceptionsApi.getEscalationPolicy(store.id);
      draft[store.id] = { timeoutHours: policy.timeoutHours, action: policy.action };
    });
    setPolicyDraft(draft);
    setPolicyOpen(true);
  };
  const escalationActionOptions = (
    ['remind', 'degrade', 'pause_agent', 'escalate_owner'] as EscalationTimeoutAction[]
  ).map((action) => ({ value: action, label: t(`inbox.escalationAction_${action}`) }));
  const openDecisionCountByStore = exceptions.reduce<Record<number, number>>((acc, item) => {
    if (item.decision && !item.resolved && !item.ignored && item.storeId) {
      acc[item.storeId] = (acc[item.storeId] ?? 0) + 1;
    }
    return acc;
  }, {});
  const pausedAgentRows = stores.flatMap((store) =>
    exceptionsApi.listPausedAgents(store.id).map((agent) => ({
      ...agent,
      storeId: store.id,
      storeName: store.name,
    })),
  );

  if (user?.experience === 'onboarding') {
    return (
      <div className="page-stack">
        <PageHeader title={t('inbox.title')} description={t('inbox.description')} />
        <StoreConnectionEmptyState description={t('inbox.emptyOnboarding')} />
      </div>
    );
  }

  // U6.3 三态之一：读取中。待办条目由这些查询拼出来，任一未返回都只能说「正在读」，
  // 不能渲染 tab 计数、空态文案或「系统替你处理了 0 项」。
  const entryQueries = [
    approvalsQuery,
    exceptionsQuery,
    storesQuery,
    ordersQuery,
    productListingsQuery,
    productsQuery,
    newProductCandidatesQuery,
    mergeSuggestionsQuery,
    fieldConflictsQuery
  ];
  if (entryQueries.some((query) => query.isLoading) || auditLogsQuery.isLoading) {
    return <TablePageSkeleton />;
  }

  // U6.3 三态之二：读取失败。明确「不是没有待办」，就地重试失败的查询，不用刷新整页。
  if (entryQueries.some((query) => query.isError)) {
    return (
      <div className="page-stack">
        <PageHeader title={t('inbox.title')} description={t('inbox.description')} />
        <Card size="small">
          <EmptyState
            description={t('inbox.loadFailed')}
            actionText={t('inbox.loadRetry')}
            onAction={() => {
              entryQueries.forEach((query) => {
                if (query.isError) void query.refetch();
              });
            }}
          />
        </Card>
      </div>
    );
  }

  const renderQuickActions = (entry: InboxEntry) => {
    if (entry.kind === 'approval' && entry.approval) {
      const approval = entry.approval;
      return (
        <Space size={4} wrap>
          {can('approvals', 'approve') && (
            <>
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => setDecisionTarget({ approval, decision: 'approved' })}
              >
                {t('inbox.approve')}
              </Button>
              <Button
                size="small"
                danger
                icon={<CloseOutlined />}
                onClick={() => setDecisionTarget({ approval, decision: 'rejected' })}
              >
                {t('inbox.reject')}
              </Button>
            </>
          )}
          <Button
            size="small"
            type="link"
            style={{ padding: '0 4px' }}
            onClick={() => navigate(`/agents/approvals/${approval.id}`)}
          >
            {t('inbox.viewDetail')}
          </Button>
        </Space>
      );
    }
    if (entry.kind === 'exception' && entry.exception) {
      const exception = entry.exception;
      const crossPlanId = crossPlanIdOf(exception);
      // P30.1：Agent 已把结论算好，人只需在收件箱里点选一个，不必跳回经营总览。
      if (exception.decision && !exception.resolved && !exception.ignored) {
        const decision = exception.decision;
        const canDecide = can('exceptions', 'update');
        // 目标节奏升级 / 上期结算 / 护栏体检都没有周期冲突可裁决，选项直接写回目标或护栏（P33.1、P34.1、P36.1）。
        const isGoalPace = exception.type === 'goal_pace_escalation';
        const isGoalSettlement = exception.type === 'goal_settlement';
        const isAccountSettlement = exception.type === 'account_goal_settlement';
        const isGuardHealth =
          exception.type === 'guard_health' || exception.type === 'guard_health_account';
        const remedyPending = isGoalSettlement
          ? settlementRemedyMutation.isPending
          : isAccountSettlement
            ? accountSettlementMutation.isPending
            : isGoalPace
              ? goalRemedyMutation.isPending
              : guardRemedyMutation.isPending;
        return (
          <Space size={4} wrap style={{ justifyContent: 'flex-end' }}>
            {decision.options.map((option) => {
              if (option.id === 'adjust_guard') {
                return (
                  <Button
                    key={option.id}
                    size="small"
                    title={option.consequence}
                    onClick={() => navigate(`${exception.linkTo ?? '/dashboard'}?exc=${exception.id}`)}
                  >
                    {option.label}
                  </Button>
                );
              }
              return (
                <Popconfirm
                  key={option.id}
                  title={option.consequence}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => {
                    if (isGoalPace) goalRemedyMutation.mutate({ exception, option });
                    else if (isGoalSettlement) settlementRemedyMutation.mutate({ exception, option });
                    else if (isAccountSettlement) accountSettlementMutation.mutate({ exception, option });
                    else if (isGuardHealth) guardRemedyMutation.mutate({ exception, option });
                    else decideEscalationMutation.mutate({ exception, option });
                  }}
                >
                  <Button
                    size="small"
                    type={option.recommended ? 'primary' : 'default'}
                    title={option.consequence}
                    disabled={!canDecide}
                    loading={
                      isGoalPace || isGoalSettlement || isAccountSettlement || isGuardHealth
                        ? remedyPending
                        : decideEscalationMutation.isPending
                    }
                  >
                    {option.label}
                    {option.recommended ? ` · ${t('inbox.decisionRecommended')}` : ''}
                  </Button>
                </Popconfirm>
              );
            })}
            <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => setHistoryException(exception)}>
              {t('inbox.viewDetail')}
            </Button>
          </Space>
        );
      }
      // 跨店方案的主操作就是「采纳 / 忽略」，在这里直接完成，不再跳回经营总览；
      // 批量选中也排除它们，避免「批量已处理」绕过方案决策。
      if (crossPlanId) {
        return (
          <Space size={4} wrap>
            {can('exceptions', 'update') && (
              <>
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={acceptCrossPlanMutation.isPending}
                  onClick={() => acceptCrossPlanMutation.mutate(crossPlanId)}
                >
                  {t('inbox.crossPlanAccept')}
                </Button>
                <Popconfirm
                  title={t('inbox.crossPlanDismissTitle')}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => dismissCrossPlanMutation.mutate(crossPlanId)}
                >
                  <Button size="small" loading={dismissCrossPlanMutation.isPending}>
                    {t('inbox.crossPlanDismiss')}
                  </Button>
                </Popconfirm>
              </>
            )}
            <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => setHistoryException(exception)}>
              {t('inbox.viewDetail')}
            </Button>
          </Space>
        );
      }
      return (
        <Space size={4} wrap>
          {exception.linkTo && (
            <Button
              size="small"
              type="primary"
              icon={<EyeOutlined />}
              onClick={() => navigate(`${exception.linkTo}?exc=${exception.id}`)}
            >
              {t('inbox.goHandle')}
            </Button>
          )}
          {/* D9: assignment moved here from the exception centre. */}
          {can('exceptions', 'update') && (
            <Button
              size="small"
              icon={<UserAddOutlined />}
              onClick={() => {
                // P30.5：没有负责人时预填 Agent 的路由建议，人只需确认或改派。
                setAssignee(exception.assignee ?? routeEscalation(exception).member?.name);
                setAssignTarget(exception);
              }}
            >
              {exception.assignee ? t('inbox.assignedTo', { name: exception.assignee }) : t('inbox.assign')}
            </Button>
          )}
          <Button size="small" type="link" style={{ padding: '0 4px' }} onClick={() => setHistoryException(exception)}>
            {t('inbox.viewDetail')}
          </Button>
        </Space>
      );
    }
    if (entry.kind === 'store_pending' && entry.store) {
      return (
        <Button
          size="small"
          type="primary"
          icon={<LoginOutlined />}
          onClick={() => navigate(`/stores/${entry.store!.id}`)}
        >
          {t('inbox.goFinishAuth')}
        </Button>
      );
    }
    if (entry.kind === 'relogin' && entry.store) {
      const isProactive = entry.expiresInDays !== undefined;
      return (
        <Button
          size="small"
          type="primary"
          ghost={isProactive}
          icon={<LoginOutlined />}
          onClick={() => navigate(`/stores/${entry.store!.id}`)}
        >
          {isProactive ? t('inbox.renewNow') : t('inbox.goRelogin')}
        </Button>
      );
    }
    if (entry.kind === 'order_exception' && entry.order) {
      const order = entry.order;
      const tier2 = order.recommendation && order.recommendation.action !== 'release' && order.recommendation.action !== 'cancel_refund'
        ? order.recommendation
        : undefined;
      return (
        <Space size={4} wrap>
          {tier2 && can('orders', 'update') && (
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={applyOrderRecMutation.isPending}
              onClick={() => applyOrderRecMutation.mutate(order.id)}
            >
              {t('inbox.acceptRecommended')}
            </Button>
          )}
          <Button
            size="small"
            type={tier2 ? 'default' : 'primary'}
            icon={<EyeOutlined />}
            onClick={() => navigate(`/orders?order=${order.id}`)}
          >
            {t('inbox.goHandle')}
          </Button>
        </Space>
      );
    }
    if (entry.kind === 'product_draft' && entry.listing) {
      const listing = entry.listing;
      const canReview = can('products', 'approve');
      const canEditProduct = can('products', 'update');
      if (listing.status === 'draft' && canEditProduct) {
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={submitDraftMutation.isPending}
              onClick={() => submitDraftMutation.mutate(listing.id)}
            >
              {t('inbox.submitForReview')}
            </Button>
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/products/${listing.productId}`)}
            >
              {t('inbox.view')}
            </Button>
          </Space>
        );
      }
      if (listing.status === 'pending_review' && canReview) {
        return (
          <Space size={4} wrap>
            <Popconfirm
              title={t('inbox.approveListingConfirm')}
              onConfirm={() => approveListingMutation.mutate(listing.id)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={approveListingMutation.isPending}
              >
                {t('inbox.approveListing')}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={t('inbox.rejectListingConfirm')}
              onConfirm={() => rejectListingMutation.mutate(listing.id)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button
                size="small"
                danger
                icon={<CloseOutlined />}
                loading={rejectListingMutation.isPending}
              >
                {t('inbox.rejectListing')}
              </Button>
            </Popconfirm>
          </Space>
        );
      }
      return (
        <Button
          size="small"
          type="primary"
          icon={<EyeOutlined />}
          onClick={() => navigate(`/products/${listing.productId}`)}
        >
          {t('inbox.view')}
        </Button>
      );
    }
    if (entry.kind === 'product_new' && entry.newProductCandidate) {
      if (!can('products', 'update')) return null;
      const candidate = entry.newProductCandidate;
      return (
        <Space size={4} wrap>
          <Button
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            loading={acceptNewProductMutation.isPending}
            onClick={() => acceptNewProductMutation.mutate(candidate.id)}
          >
            {candidate.recommendation === 'create_new' ? t('inbox.acceptRecommended') : t('inbox.createAnyway')}
          </Button>
          <Button
            size="small"
            icon={<CloseOutlined />}
            loading={dismissNewProductMutation.isPending}
            onClick={() => dismissNewProductMutation.mutate(candidate.id)}
          >
            {t('inbox.dismiss')}
          </Button>
        </Space>
      );
    }
    if (entry.kind === 'product_merge' && entry.mergeSuggestion) {
      if (!can('products', 'update')) return null;
      const suggestion = entry.mergeSuggestion;
      return (
        <Space size={4} wrap>
          <Popconfirm title={t('products.mergeConfirm')} onConfirm={() => mergeProductsMutation.mutate(suggestion.id)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={mergeProductsMutation.isPending}>
              {t('inbox.acceptRecommended')}
            </Button>
          </Popconfirm>
          <Button size="small" icon={<CloseOutlined />} loading={dismissMergeMutation.isPending} onClick={() => dismissMergeMutation.mutate(suggestion.id)}>
            {t('inbox.dismiss')}
          </Button>
        </Space>
      );
    }
    if (entry.kind === 'product_conflict' && entry.fieldConflict) {
      if (!can('products', 'update')) return null;
      const conflict = entry.fieldConflict;
      return (
        <Space size={4} wrap>
          <Button
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            loading={resolveFieldConflictMutation.isPending}
            onClick={() => resolveFieldConflictMutation.mutate({ id: conflict.id, decision: 'keep_yours' })}
          >
            {t('inbox.keepYours')}
          </Button>
          <Button
            size="small"
            loading={resolveFieldConflictMutation.isPending}
            onClick={() => resolveFieldConflictMutation.mutate({ id: conflict.id, decision: 'accept_platform' })}
          >
            {t('inbox.acceptPlatform')}
          </Button>
        </Space>
      );
    }
    return null;
  };

  return (
    <div className="page-stack">
      <PageHeader
        // The count lives on the 待处理 tab (and the nav item); repeating it in the title
        // said the same number three times on one screen.
        title={t('inbox.title')}
        description={t('inbox.description')}
        actions={activeTab !== 'pending' ? undefined : (
          <Space>
            {can('exceptions', 'update') && stores.length > 0 && (
              <Button icon={<SettingOutlined />} onClick={openPolicyDrawer}>
                {t('inbox.escalationPolicy')}
              </Button>
            )}
            {/* D7.3: guided sequential re-login — hands the whole set of stores to the
                store detail page as an ordered queue, so finishing one store offers the
                next instead of dropping the user back to a list. */}
            {filter === 'store' && reloginQueue.length > 1 && (
              <Button
                type="primary"
                icon={<LoginOutlined />}
                onClick={() => navigate(`/stores/${reloginQueue[0]}?reloginQueue=${reloginQueue.join(',')}`)}
              >
                {t('inbox.batchReloginCta', { count: reloginQueue.length })}
              </Button>
            )}
            {batchableEntries.length > 0 ? (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={batchAccepting}
                onClick={() => { setBatchExcluded([]); setBatchModalOpen(true); }}
              >
                {t('inbox.batchAccept', { count: batchableEntries.length })}
              </Button>
            ) : undefined}
          </Space>
        )}
      />

      {/* U6.3：自动处理回执读不出来时单独说明，不因此把待办队列藏起来，
          也不让「自动处理」看起来像系统什么都没做。 */}
      {auditLogsQuery.isError && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 10px',
            border: '1px solid var(--ark-border-soft)',
            borderRadius: 6,
            background: 'var(--ark-panel-soft)'
          }}
        >
          <AlertOutlined style={{ color: 'var(--ark-orange)' }} />
          <Typography.Text style={{ fontSize: 12 }}>{t('inbox.autoLoadFailed')}</Typography.Text>
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => void auditLogsQuery.refetch()}>
            {t('inbox.autoLoadRetry')}
          </Button>
        </div>
      )}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'pending',
            label: <span><InboxOutlined /> {t('inbox.tabPending')}{counts.all > 0 && <Badge count={counts.all} size="small" offset={[6, -4]} style={{ marginLeft: 6 }} />}</span>,
            children: (
        <Card size="small">
          {/* P39：店铺范围条——说清「看到了什么、少了什么」，隐藏的升级项可一键找回。 */}
          {!isAllStores && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 12,
                padding: '8px 10px',
                border: '1px solid var(--ark-border-soft)',
                borderRadius: 6,
                background: 'var(--ark-panel-soft)'
              }}
            >
              <Tag color="blue" style={{ margin: 0 }}>{t('inbox.scopeTag')}</Tag>
              <Typography.Text style={{ fontSize: 12 }}>
                {t('inbox.scopeBarText', {
                  store: activeStore?.name ?? '',
                  count: entriesInScope.length,
                  account: accountLevelInScopeCount
                })}
              </Typography.Text>
              {hiddenByScopeCount > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('inbox.scopeBarHidden', { count: hiddenByScopeCount })}
                </Typography.Text>
              )}
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setScope('all')}>
                {t('inbox.scopeBarShowAll')}
              </Button>
            </div>
          )}
          {/* D9: bulk resolve/ignore, migrated from the exception centre. Only exception
              items are selectable — they are the only kind with batch endpoints. */}
          {selectedExceptionIds.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>
                {t('inbox.selectedCount', { count: selectedExceptionIds.length })}
              </Typography.Text>
              <Popconfirm
                title={t('inbox.batchResolveConfirmTitle', { count: selectedExceptionIds.length })}
                description={t('inbox.batchResolveConfirmBody')}
                onConfirm={() => batchResolveMutation.mutate(selectedExceptionIds)}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
              >
                <Button size="small" type="primary" icon={<CheckOutlined />} loading={batchResolveMutation.isPending}>
                  {t('inbox.batchResolve')}
                </Button>
              </Popconfirm>
              <Popconfirm
                title={t('inbox.batchIgnoreConfirmTitle', { count: selectedExceptionIds.length })}
                description={t('inbox.batchIgnoreConfirmBody')}
                onConfirm={() => batchIgnoreMutation.mutate(selectedExceptionIds)}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
              >
                <Button size="small" icon={<CloseOutlined />} loading={batchIgnoreMutation.isPending}>
                  {t('inbox.batchIgnore')}
                </Button>
              </Popconfirm>
              <Button size="small" type="link" onClick={() => setSelectedExceptionIds([])}>
                {t('inbox.clearSelection')}
              </Button>
            </div>
          )}
          <Segmented
            size="small"
            value={filter}
            onChange={(value) => {
              const next = value as InboxFilter;
              const params = new URLSearchParams(searchParams);
              if (next === 'all') params.delete('type');
              else params.set('type', next);
              setSearchParams(params, { replace: true });
            }}
            options={[
              { value: 'all', label: `${t('inbox.filterAll')} (${counts.all})` },
              { value: 'approval', label: `${t('inbox.filterApprovals')} (${counts.approval})` },
              { value: 'exception', label: `${t('inbox.filterExceptions')} (${counts.exception})` },
              { value: 'store', label: `${t('inbox.filterStore')} (${counts.relogin + counts.store_pending})` },
              { value: 'order_exception', label: `${t('inbox.filterOrderException')} (${counts.order_exception})` },
              {
                value: 'product',
                label: `${t('inbox.filterProduct')} (${counts.product_draft + counts.product_new + counts.product_merge + counts.product_conflict})`
              }
            ]}
          />
          {/* P30.4：先处理哪条由 Agent 按可核对的影响金额给出，人不用读完再自己排。 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Space size={8} wrap>
              <Segmented
                size="small"
                value={priorityView === 'default' ? 'default' : 'impact'}
                onChange={(value) => setPriorityView(value === 'impact' ? 'top' : 'default')}
                disabled={impactSummary.quantified === 0}
                options={[
                  { value: 'default', label: t('inbox.orderDefault') },
                  { value: 'impact', label: t('inbox.orderImpact') }
                ]}
              />
              {/* P30.5：Agent 已把升级项路由到角色，这里只回答「哪些归我」。 */}
              <Button
                size="small"
                type={mineOnly ? 'primary' : 'default'}
                onClick={() => setMineOnly(!mineOnly)}
              >
                {t('inbox.mineQueue', { count: myQueueCount })}
              </Button>
              {rankedMode && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('inbox.impactSummary', {
                    count: impactSummary.quantified,
                    amount: impactSummary.total.toLocaleString()
                  })}
                </Typography.Text>
              )}
            </Space>
            {rankedMode && impactRankedEntries.length > TOP_PRIORITY_LIMIT && (
              <Button
                size="small"
                type="link"
                onClick={() => setPriorityView(priorityView === 'top' ? 'all_ranked' : 'top')}
              >
                {priorityView === 'top'
                  ? t('inbox.showAllRanked', { count: impactRankedEntries.length })
                  : t('inbox.showTopOnly', { count: TOP_PRIORITY_LIMIT })}
              </Button>
            )}
          </div>
          {displayedEntries.length === 0 ? (
            <div style={{ padding: '32px 0' }}>
              <EmptyState
                description={
                  mineOnly && visibleEntries.length > 0
                    ? t('inbox.emptyMine')
                    : filter === 'all' ? t('inbox.empty') : t('inbox.emptyFiltered')
                }
                actionText={
                  mineOnly && visibleEntries.length > 0
                    ? t('inbox.mineQueueOff')
                    : filter === 'all' ? t('inbox.goSetup') : t('inbox.clearFilter')
                }
                onAction={() => {
                  if (mineOnly && visibleEntries.length > 0) setMineOnly(false);
                  else if (filter === 'all') navigate('/setup');
                  else setSearchParams({}, { replace: true });
                }}
              />
            </div>
          ) : (
            <List
              itemLayout="vertical"
              dataSource={displayedEntries}
              rowKey={(entry) => entry.key}
              renderItem={(entry) => {
                const urgency = entry.approval ? getApprovalUrgency(entry.approval, clock) : undefined;
                const isCrossPlan = entry.exception ? !!crossPlanIdOf(entry.exception) : false;
                // P30.1：决策请求必须选一个结论，不能被“批量已处理”静默关掉。
                const isDecisionRequest = entry.exception?.type === 'decision_request';
                const batchLocked = isCrossPlan || isDecisionRequest;
                return (
                  <List.Item style={{ padding: '12px 0' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <Checkbox
                        style={{ marginTop: 2 }}
                        disabled={entry.kind !== 'exception' || batchLocked || !can('exceptions', 'update')}
                        title={
                          entry.kind !== 'exception'
                            ? t('inbox.onlyExceptionsSelectable')
                            : isCrossPlan
                              ? t('inbox.crossPlanBatchHint')
                              : isDecisionRequest
                                ? t('inbox.decisionBatchHint')
                                : undefined
                        }
                        checked={!!entry.exception && selectedExceptionIds.includes(entry.exception.id)}
                        onChange={(e) => {
                          if (!entry.exception) return;
                          const id = entry.exception.id;
                          setSelectedExceptionIds((prev) => e.target.checked ? [...prev, id] : prev.filter((x) => x !== id));
                        }}
                      />
                      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                        <Space size={6} wrap style={{ marginBottom: 4 }}>
                          <Tag color={KIND_TAG_COLORS[entry.kind]} style={{ margin: 0 }}>
                            {t(`inbox.kind_${entry.kind}`)}
                          </Tag>
                          {/* P39：账户级待办不受店铺范围约束，标出来，免得在单店范围下看着突兀。 */}
                          {(!entry.storeId || entry.exception?.guardAccount) && (
                            <Tag style={{ margin: 0 }} title={t('inbox.accountLevelTagTitle')}>
                              {t('inbox.accountLevelTag')}
                            </Tag>
                          )}
                          {entry.approval && <StatusBadge value={entry.approval.riskLevel} />}
                          {entry.approval?.timeoutEscalatedAt && (
                            <Tag
                              color="red"
                              style={{ margin: 0 }}
                              title={t('inbox.approvalEscalatedHint')}
                            >
                              {t('inbox.approvalEscalatedTag')}
                            </Tag>
                          )}
                        {entry.approval && (() => {
                          const policy = approvalPolicies.find((p) => p.riskLevel === entry.approval!.riskLevel);
                          // An item sitting in the approval queue while its policy says
                          // "no approval needed" would read as a contradiction, so the
                          // rule is only shown when it explains why this needs a person.
                          if (!policy || policy.action === 'auto_execute') return null;
                          return (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {t(APPROVAL_ACTION_LABELS[policy.action])}
                            </Typography.Text>
                          );
                        })()}
                          {entry.exception && (
                            <Tag
                              color={entry.exception.level === 'critical' ? 'red' : entry.exception.level === 'warning' ? 'orange' : 'blue'}
                              style={{ margin: 0 }}
                            >
                              {t(`exc.${entry.exception.level}`)}
                            </Tag>
                          )}
                          {/* P30.4：金额和来源都摆在标签上，排序依据不必点开才知道。 */}
                          {entry.exception?.impact && (
                            <Tag color="cyan" style={{ margin: 0 }} title={entry.exception.impact.basis}>
                              {t(`inbox.impactKind_${entry.exception.impact.kind}`, {
                                amount: entry.exception.impact.amount.toLocaleString()
                              })}
                            </Tag>
                          )}
                          {rankedMode && entry.exception && !entry.exception.impact && (
                            <Tag style={{ margin: 0 }}>{t('inbox.impactUnknown')}</Tag>
                          )}
                          {/* P30.5：谁负责、为什么是他，都摆在行上；绿色表示 Agent 路由，灰色表示人工改派。 */}
                          {entry.exception?.assignee && (
                            <Tag
                              color={entry.exception.assignedBy?.startsWith('Agent') ? 'green' : 'default'}
                              style={{ margin: 0 }}
                              title={entry.exception.assignmentReason}
                            >
                              {entry.exception.assigneeRole
                                ? t('inbox.assignedTag', {
                                    name: entry.exception.assignee,
                                    role: t(`member.role.${entry.exception.assigneeRole}`)
                                  })
                                : t('inbox.assignedNameOnly', { name: entry.exception.assignee })}
                            </Tag>
                          )}
                          {entry.exception?.type === 'cycle_escalation' && (
                            <Tag color="purple" style={{ margin: 0 }}>
                              {t('exc.type_cycle_escalation')}
                            </Tag>
                          )}
                          {entry.exception?.type === 'cross_store_escalation' && (
                            <Tag color="geekblue" style={{ margin: 0 }}>
                              {t('exc.type_cross_store_escalation')}
                            </Tag>
                          )}
                          {entry.exception?.type === 'goal_pace_escalation' && (
                            <Tag color="magenta" style={{ margin: 0 }}>
                              {t('exc.type_goal_pace_escalation')}
                            </Tag>
                          )}
                          {entry.exception?.type === 'account_goal_settlement' && (
                            <Tag color="cyan" style={{ margin: 0 }}>
                              {t('exc.type_account_goal_settlement')}
                            </Tag>
                          )}
                          {entry.exception?.type === 'decision_request' && (
                            <Tag color="gold" style={{ margin: 0 }}>
                              {t('exc.type_decision_request')}
                            </Tag>
                          )}
                          {entry.kind === 'relogin' && (
                            entry.expiresInDays === undefined
                              ? <AlertOutlined style={{ color: 'var(--ark-red)' }} />
                              : <Tag color="orange" style={{ margin: 0 }}>{t('inbox.expiringTag', { days: entry.expiresInDays })}</Tag>
                          )}
                        </Space>
                        {/* 1024 下标题与摘要同处一行会把标题压成单字竖排（U4.2.1）：
                            给两者写明 flex 基准，空间不足时摘要换行到标题下方。 */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
                          {entry.kind === 'product_draft' && entry.product && (
                            <div style={{ flexShrink: 0 }}><ProductThumb src={entry.product.images[0]} size={48} /></div>
                          )}
                          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                          {entry.kind === 'approval' && entry.approval ? (
                            <Link to={`/agents/approvals/${entry.approval.id}`}>
                              <Typography.Text strong>{entry.title}</Typography.Text>
                            </Link>
                          ) : (
                            <Typography.Text strong>{entry.title}</Typography.Text>
                          )}
                        </div>
                        {entry.kind === 'product_conflict' && entry.fieldConflict ? (
                          <FieldConflictComparison conflict={entry.fieldConflict} t={t} />
                        ) : (
                          <Typography.Paragraph
                            type="secondary"
                            style={{ flex: '2 1 240px', minWidth: 0, marginBottom: 4, fontSize: 12 }}
                            ellipsis={{ rows: 2 }}
                          >
                            {entry.summary}
                          </Typography.Paragraph>
                        )}
                        {entry.exception?.decision && !entry.exception.resolved && (() => {
                          const decision = entry.exception!.decision!;
                          const exception = entry.exception!;
                          const policy = exceptionsApi.getEscalationPolicy(exception.storeId ?? -1);
                          const overdue = dayjs(decision.deadline).isBefore(clock);
                          const defaultLabel =
                            decision.options.find((option) => option.id === decision.timeoutOptionId)?.label ?? '';
                          const actionLabel = t(`inbox.escalationAction_${policy.action}`);
                          return (
                            <>
                              <Typography.Text type={overdue ? 'danger' : 'secondary'} style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                                {policy.action === 'degrade'
                                  ? overdue
                                    ? t('inbox.decisionOverdue', { option: defaultLabel })
                                    : t('inbox.decisionDeadline', { hours: decision.timeoutHours, option: defaultLabel })
                                  : overdue
                                    ? t('inbox.decisionOverdueAction', { action: actionLabel })
                                    : t('inbox.decisionDeadlineAction', { hours: decision.timeoutHours, action: actionLabel })}
                              </Typography.Text>
                              <Space size={4} wrap style={{ marginBottom: 2 }}>
                                {(exception.reminderCount ?? 0) > 0 && (
                                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                    {t('inbox.decisionReminded', { count: exception.reminderCount ?? 0 })}
                                  </Tag>
                                )}
                                {exception.escalatedToOwnerAt && (
                                  <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                    {t('inbox.decisionEscalatedOwner')}
                                  </Tag>
                                )}
                                {exception.agentPausedAt && (
                                  <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
                                    {t('inbox.decisionAgentPaused')}
                                  </Tag>
                                )}
                              </Space>
                              {exception.storeId && exception.decisionKind && (() => {
                                // P30.3：同类升级连续两次由人给出同一结论 → 提议沉淀成规则。
                                const history = exceptionsApi.getDecisionHistory(
                                  exception.storeId,
                                  exception.decisionKind,
                                );
                                if (history.streak < 2 || !history.outcome) return null;
                                const outcomeLabel = t(
                                  history.outcome === 'override'
                                    ? 'inbox.ruleOutcome_override'
                                    : 'inbox.ruleOutcome_uphold',
                                );
                                const kindLabel = t(`inbox.ruleKind_${exception.decisionKind}`);
                                return (
                                  <Space size={4} wrap style={{ marginBottom: 2 }}>
                                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                      {t('inbox.ruleSuggestion', {
                                        count: history.streak,
                                        kind: kindLabel,
                                        outcome: outcomeLabel,
                                      })}
                                    </Typography.Text>
                                    <Popconfirm
                                      title={t('inbox.ruleConfirmTitle')}
                                      description={t('inbox.ruleConfirm', { kind: kindLabel, outcome: outcomeLabel })}
                                      okText={t('inbox.ruleAdopt')}
                                      cancelText={t('common.cancel')}
                                      onConfirm={() => adoptRuleMutation.mutate({ exception })}
                                    >
                                      <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 11 }}>
                                        {t('inbox.ruleAdopt')}
                                      </Button>
                                    </Popconfirm>
                                  </Space>
                                );
                              })()}
                            </>
                          );
                        })()}
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {entry.storeName}
                          {entry.kind === 'product_draft' && entry.listing ? ` · ¥${entry.listing.sellingPrice.toFixed(2)}` : ''}
                          {entry.approval ? ` · ${t(`agent.${entry.approval.agentType}`)}` : ''}
                          {entry.exception ? ` · ${t(`agent.${entry.exception.agentType}`)}` : ''}
                          {entry.createdAt ? ` · ${formatAge(t, entry.createdAt, clock)}` : ''}
                        </Typography.Text>
                      </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                        {entry.exception?.decision && (() => {
                          // P40.1：把「还不处理，Agent 什么时候替我收尾」直接写在卡片上；
                          // 截止时间锚定首次登记，不再被每轮巡检刷新。
                          const due = getDecisionUrgency(entry.exception!.decision!, clock);
                          return (
                            <Typography.Text
                              strong
                              style={{ fontSize: 12, color: URGENCY_COLORS[due.tone] }}
                              title={`${t('approvalDetail.expiresAtLabel')}: ${due.deadline.format('MM-DD HH:mm')}`}
                            >
                              {due.remainingMs <= 0 ? t('inbox.pastDue') : formatRemaining(t, due.remainingMs)}
                            </Typography.Text>
                          );
                        })()}
                        {urgency && (
                          <Typography.Text
                            strong
                            style={{ fontSize: 12, color: URGENCY_COLORS[urgency.tone] }}
                            title={`${t('approvalDetail.expiresAtLabel')}: ${urgency.expiresAt.format('MM-DD HH:mm')} · ${t(timeoutConsequenceKey(urgency.policy))}`}
                          >
                            {formatRemaining(t, urgency.remainingMs)}
                          </Typography.Text>
                        )}
                        {renderQuickActions(entry)}
                      </div>
                    </div>
                  </List.Item>
                );
              }}
            />
          )}
          {counts.all > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircleOutlined /> {t('inbox.pendingCount', { count: counts.all })}
            </Typography.Text>
          )}
        </Card>
            ),
          },
          {
            // Reads as a sequence with the other two: what needs me → what the system
            // did for me → what I decided.
            key: 'auto',
            label: (
              <span
                title={
                  autoHandledCount > 0
                    ? t('inbox.tabAutoCountHint', { days: AUTO_HANDLED_WINDOW_DAYS, count: autoHandledCount })
                    : undefined
                }
              >
                <ThunderboltOutlined /> {t('inbox.tabAuto')}
                {/* 计数徽标与「待处理」同形不同色：中性描边只报数、不催促，红色才代表要动。
                    底色/文字/描边全部取 token，亮暗两套主题下都能看清胶囊形状。 */}
                {autoHandledCount > 0 && (
                  <Badge
                    count={autoHandledCount}
                    size="small"
                    offset={[6, -4]}
                    style={{
                      marginLeft: 6,
                      backgroundColor: 'var(--ark-panel)',
                      color: 'var(--ark-muted)',
                      boxShadow: 'inset 0 0 0 1px var(--ark-muted)'
                    }}
                  />
                )}
              </span>
            ),
            children: <InboxAutoHandledTab onShowPending={() => setActiveTab('pending')} onCheckEscalation={setHistoryException} />,
          },
          {
            key: 'history',
            label: <span><HistoryOutlined /> {t('inbox.tabHistory')}</span>,
            children: <InboxHistoryTab onOpenException={setHistoryException} />,
          },
        ]}
      />

      {/* Quick decisions still require the confirm step (B4) */}
      <ApprovalDecisionModal
        approval={decisionTarget?.approval ?? null}
        decision={decisionTarget?.decision ?? null}
        submitting={decide.isPending}
        onCancel={() => setDecisionTarget(null)}
        onConfirm={(note, acknowledgeGuardViolation) =>
          decisionTarget &&
          decide.mutate({
            approvalId: decisionTarget.approval.id,
            status: decisionTarget.decision,
            note: note || undefined,
            acknowledgeGuardViolation,
          })
        }
      />

      {/* Batch manifest: what will be applied, to what, at what confidence — with a way
          to drop individual rows before committing. */}
      <Modal
        title={t('inbox.batchAcceptTitle')}
        open={batchModalOpen}
        onCancel={() => setBatchModalOpen(false)}
        okText={t('inbox.batchAcceptOk', { count: batchableEntries.length - batchExcluded.length })}
        cancelText={t('common.cancel')}
        okButtonProps={{
          loading: batchRunning,
          disabled: batchableEntries.length - batchExcluded.length === 0
        }}
        onOk={handleBatchAccept}
        width={620}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
          {t('inbox.batchAcceptHint')}
        </Typography.Paragraph>
        {/* Naming what is deliberately absent is what makes the rule legible: without it
            the batch just looks like an arbitrary subset of the queue. */}
        <Typography.Paragraph type="secondary" style={{ fontSize: 11 }}>
          {t('inbox.batchAcceptExcluded')}
        </Typography.Paragraph>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {batchableEntries.map((entry) => {
            const { action, confidence } = describeRecommendation(entry, t);
            const included = !batchExcluded.includes(entry.key);
            return (
              <div
                key={entry.key}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0',
                  borderBottom: '1px solid var(--ark-border-soft)', opacity: included ? 1 : 0.45
                }}
              >
                <Checkbox
                  checked={included}
                  onChange={(e) => setBatchExcluded((prev) =>
                    e.target.checked ? prev.filter((key) => key !== entry.key) : [...prev, entry.key]
                  )}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Space size={6} wrap style={{ marginBottom: 2 }}>
                    <Tag color={KIND_TAG_COLORS[entry.kind]} style={{ margin: 0 }}>{t(`inbox.kind_${entry.kind}`)}</Tag>
                    <Typography.Text strong style={{ fontSize: 13 }}>{entry.title}</Typography.Text>
                  </Space>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{action}</Typography.Text>
                    {confidence !== undefined && (
                      <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                        {t('inbox.batchConfidence', { value: confidence })}
                      </Typography.Text>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Modal>

      {/* D9: assign an owner — migrated from the exception centre. */}
      <Modal
        title={t('inbox.assignTitle')}
        open={!!assignTarget}
        onCancel={() => { setAssignTarget(null); setAssignee(undefined); }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: !assignee, loading: assignMutation.isPending }}
        onOk={() => assignTarget && assignee && assignMutation.mutate({ id: assignTarget.id, assignee })}
        width={460}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{assignTarget?.title}</Typography.Paragraph>
        {/* P30.5：Agent 的路由结论、角色和依据先摆出来，人改派前知道自己覆盖了什么。 */}
        {assignTarget && (() => {
          const route = routeEscalation(assignTarget);
          return (
            <Typography.Paragraph style={{ fontSize: 12 }}>
              {t('inbox.routeSuggestion', {
                name: route.member?.name ?? t('inbox.routeNoMember'),
                role: t(`member.role.${route.role}`),
                reason: route.reason,
              })}
              {route.member && assignee !== route.member.name && (
                <Button
                  type="link"
                  size="small"
                  style={{ padding: '0 4px' }}
                  onClick={() => setAssignee(route.member!.name)}
                >
                  {t('inbox.routeAdopt')}
                </Button>
              )}
            </Typography.Paragraph>
          );
        })()}
        <Select
          style={{ width: '100%' }}
          placeholder={t('inbox.assignTitle')}
          value={assignee}
          onChange={setAssignee}
          options={teamMembers.map((member) => ({
            value: member.name,
            label: `${member.name} · ${t(`member.role.${member.role}`)}${
              member.status === 'invited' ? ` · ${t('inbox.memberInvited')}` : ''
            }`,
          }))}
        />
      </Modal>

      {/* Exception detail, shared by the pending queue and the history tab. */}
      <Modal
        title={historyException?.title}
        open={!!historyException}
        onCancel={() => setHistoryException(null)}
        footer={
          <Space wrap>
            <Button onClick={() => setHistoryException(null)}>{t('common.close')}</Button>
            {historyException?.linkTo && (
              <Button
                type="primary"
                icon={<EyeOutlined />}
                onClick={() => { const target = historyException; setHistoryException(null); navigate(`${target.linkTo}?exc=${target.id}`); }}
              >
                {t('inbox.goHandle')}
              </Button>
            )}
          </Space>
        }
        width={560}
      >
        {historyException && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Tag color={historyException.level === 'critical' ? 'red' : historyException.level === 'warning' ? 'orange' : 'blue'}>
                {t(`exc.${historyException.level}`)}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {historyException.storeName} · {t(`agent.${historyException.agentType}`)}
              </Typography.Text>
            </Space>
            <Typography.Text>{historyException.summary}</Typography.Text>
            {historyException.detail && (
              <Card size="small" style={{ background: 'var(--ark-panel-soft)' }}>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, fontSize: 12 }}>{historyException.detail}</pre>
              </Card>
            )}
            {historyException.suggestedAction && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('exc.suggestedAction')}: {historyException.suggestedAction}
              </Typography.Text>
            )}
            {historyException.assignee && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('inbox.assignedTo', { name: historyException.assignee })}
              </Typography.Text>
            )}
            {/* P41.1：从「自动处理」核对进来时，要能直接看到谁在什么时候收尾、结论是什么。 */}
            {historyException.resolvedBy && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('inbox.receiptResolvedBy', {
                  actor: historyException.resolvedBy,
                  time: historyException.resolvedAt ? dayjs(historyException.resolvedAt).format('MM-DD HH:mm') : '—',
                })}
              </Typography.Text>
            )}
            {historyException.resolutionNote && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('inbox.receiptNote', { note: historyException.resolutionNote })}
              </Typography.Text>
            )}
          </Space>
        )}
      </Modal>

      {/* P30.2：按店铺配置“超时未处理 → Agent 做什么”，并给被暂停的 Agent 一个恢复出口。 */}
      <Drawer
        title={t('inbox.escalationPolicyTitle')}
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        width={520}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('inbox.escalationPolicyHint')}</Typography.Text>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {stores.map((store) => {
              const policy = exceptionsApi.getEscalationPolicy(store.id);
              const draft = policyDraft[store.id] ?? {
                timeoutHours: policy.timeoutHours,
                action: policy.action,
              };
              const dirty =
                draft.timeoutHours !== policy.timeoutHours || draft.action !== policy.action;
              const saving =
                savePolicyMutation.isPending &&
                savePolicyMutation.variables?.storeId === store.id;
              const takeover = takeovers.find((entry) => entry.storeId === store.id);
              const takeoverSaving =
                takeoverMutation.isPending &&
                takeoverMutation.variables?.storeId === store.id;
              return (
                <Card key={store.id} size="small">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space size={8} wrap>
                      <Typography.Text strong>{store.name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('inbox.escalationStoreDecisions', {
                          count: openDecisionCountByStore[store.id] ?? 0,
                        })}
                      </Typography.Text>
                    </Space>
                    <Space size={8} wrap>
                      <InputNumber
                        min={1}
                        max={168}
                        value={draft.timeoutHours}
                        addonAfter={t('inbox.escalationHours')}
                        style={{ width: 140 }}
                        onChange={(value) =>
                          setPolicyDraft((prev) => ({
                            ...prev,
                            [store.id]: {
                              ...draft,
                              timeoutHours: Number(value ?? policy.timeoutHours),
                            },
                          }))
                        }
                      />
                      <Select
                        value={draft.action}
                        options={escalationActionOptions}
                        style={{ width: 210 }}
                        onChange={(action: EscalationTimeoutAction) =>
                          setPolicyDraft((prev) => ({
                            ...prev,
                            [store.id]: { ...draft, action },
                          }))
                        }
                      />
                      <Button
                        size="small"
                        type="primary"
                        disabled={!dirty}
                        loading={saving}
                        onClick={() =>
                          savePolicyMutation.mutate({
                            storeId: store.id,
                            timeoutHours: draft.timeoutHours,
                            action: draft.action,
                          })
                        }
                      >
                        {t('inbox.escalationSave')}
                      </Button>
                    </Space>
                    <div
                      style={{
                        borderTop: '1px dashed var(--ark-border-soft)',
                        paddingTop: 8,
                      }}
                    >
                      <Space size={8} wrap>
                        <Typography.Text style={{ fontSize: 12 }}>
                          {t('inbox.takeoverLabel')}
                        </Typography.Text>
                        {takeover ? (
                          <>
                            <Tag color="orange">
                              {t('inbox.takeoverActiveTag', { actor: takeover.actor })}
                            </Tag>
                            <Button
                              size="small"
                              loading={takeoverSaving}
                              onClick={() =>
                                takeoverMutation.mutate({ storeId: store.id, active: false })
                              }
                            >
                              {t('inbox.takeoverRelease')}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="small"
                            loading={takeoverSaving}
                            onClick={() =>
                              takeoverMutation.mutate({ storeId: store.id, active: true })
                            }
                          >
                            {t('inbox.takeoverStart')}
                          </Button>
                        )}
                      </Space>
                      <Typography.Text
                        type="secondary"
                        style={{ display: 'block', fontSize: 12, marginTop: 4 }}
                      >
                        {takeover
                          ? t('inbox.takeoverActiveHint', {
                              time: dayjs(takeover.startedAt).format('MM-DD HH:mm'),
                            })
                          : t('inbox.takeoverIdleHint')}
                      </Typography.Text>
                    </div>
                  </Space>
                </Card>
              );
            })}
          </Space>
          <div>
            <Typography.Text strong>{t('inbox.escalationPausedTitle')}</Typography.Text>
            {pausedAgentRows.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                {t('inbox.escalationNoPaused')}
              </Typography.Paragraph>
            ) : (
              <List
                size="small"
                style={{ marginTop: 8 }}
                dataSource={pausedAgentRows}
                renderItem={(agent) => (
                  <List.Item
                    actions={[
                      <Button
                        key="resume"
                        size="small"
                        onClick={() =>
                          resumeAgentMutation.mutate({
                            storeId: agent.storeId,
                            agentType: agent.agentType,
                          })
                        }
                      >
                        {t('inbox.escalationResume')}
                      </Button>,
                    ]}
                  >
                    <Space direction="vertical" size={0}>
                      <Typography.Text>
                        {agent.storeName} · {t(`agent.${agent.agentType}`)}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('inbox.decisionAgentPaused')} · {dayjs(agent.pausedAt).format('MM-DD HH:mm')}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </div>
          <div>
            <Typography.Text strong>{t('inbox.decisionRulesTitle')}</Typography.Text>
            {decisionRules.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                {t('inbox.decisionRulesEmpty')}
              </Typography.Paragraph>
            ) : (
              <List
                size="small"
                style={{ marginTop: 8 }}
                dataSource={decisionRules}
                renderItem={(rule) => (
                  <List.Item
                    actions={[
                      <Popconfirm
                        key="revoke"
                        title={t('inbox.ruleRevokeConfirm')}
                        okText={t('inbox.ruleRevoke')}
                        cancelText={t('common.cancel')}
                        onConfirm={() => revokeRuleMutation.mutate(rule.id)}
                      >
                        <Button size="small" danger>
                          {t('inbox.ruleRevoke')}
                        </Button>
                      </Popconfirm>,
                    ]}
                  >
                    <Space direction="vertical" size={0}>
                      <Typography.Text>
                        {stores.find((store) => store.id === rule.storeId)?.name ?? `#${rule.storeId}`} ·{' '}
                        {t(`inbox.ruleKind_${rule.decisionKind}`)} ·{' '}
                        {t(rule.outcome === 'override' ? 'inbox.ruleOutcome_override' : 'inbox.ruleOutcome_uphold')}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('inbox.ruleAppliedCount', { count: rule.appliedCount })} ·{' '}
                        {t('inbox.ruleSourceCount', { count: rule.sourceDecisionIds.length })} ·{' '}
                        {dayjs(rule.createdAt).format('MM-DD HH:mm')}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </div>
        </Space>
      </Drawer>
    </div>
  );
}
