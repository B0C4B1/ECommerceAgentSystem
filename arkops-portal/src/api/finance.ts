import { mockDelay } from './client';
import { registerMockState } from './mockPersistence';
import type { BillingDetail, BillingRecord, CostAnalysis, SubscriptionPlan } from '../types/domain';

const plans: SubscriptionPlan[] = [
  { tier: 'Free', storeLimit: 1, agentConcurrency: 1, monthlyOps: 100, tokenQuota: 100000, price: 0, currency: 'CNY' },
  { tier: 'Starter', storeLimit: 5, agentConcurrency: 2, monthlyOps: 500, tokenQuota: 500000, price: 49, currency: 'CNY' },
  { tier: 'Professional', storeLimit: 20, agentConcurrency: 5, monthlyOps: 2000, tokenQuota: 2000000, price: 199, currency: 'CNY' },
  { tier: 'Enterprise', storeLimit: 999, agentConcurrency: 999, monthlyOps: 99999, tokenQuota: 99999999, price: 599, currency: 'CNY' }
];

const billingRecords: BillingRecord[] = [
  { id: 'inv_202606', period: '2026年6月', status: 'pending', amount: 49, currency: 'CNY', dueDate: '2026-07-01' },
  { id: 'inv_202605', period: '2026年5月', status: 'paid', amount: 49, currency: 'CNY', dueDate: '2026-06-01', paidAt: '2026-05-28', invoiceUrl: '#' },
  { id: 'inv_202604', period: '2026年4月', status: 'paid', amount: 49, currency: 'CNY', dueDate: '2026-05-01', paidAt: '2026-04-29', invoiceUrl: '#' }
];

let currentPlan: SubscriptionPlan = { ...plans[1] };

let autoRenew = true;

export interface InvoiceInfo {
  companyName: string;
  taxId: string;
  address: string;
  phone: string;
  email: string;
  bankName: string;
  bankAccount: string;
}

let invoiceInfo: InvoiceInfo = {
  companyName: '上海出海鲸科技有限公司',
  taxId: '91310000XXXXXXXXXX',
  address: '上海市浦东新区张江高科技园区XX路XX号',
  phone: '+86 21-XXXXXXXX',
  email: 'finance@chujingtech.com',
  bankName: '中国工商银行上海浦东分行',
  bankAccount: '1001 XXXX XXXX 1234 567'
};

const USED_CALLS = 665;
const USED_TOKENS = 686000;

/** 超额项按当前套餐上限计算，升级后自动归零，避免账单与套餐上限对不上。 */
function buildOverageItems(): BillingDetail['overageItems'] {
  const items: BillingDetail['overageItems'] = [];
  const callOver = Math.max(0, USED_CALLS - currentPlan.monthlyOps);
  if (callOver > 0) {
    items.push({ description: `Agent 调用超额 ${callOver} 次`, amount: Math.round(callOver * 0.08 * 100) / 100, currency: 'CNY' });
  }
  const tokenOver = Math.max(0, USED_TOKENS - currentPlan.tokenQuota);
  if (tokenOver > 0) {
    items.push({ description: `Token 超额 ${tokenOver.toLocaleString()}`, amount: Math.round((tokenOver / 1000) * 0.03 * 100) / 100, currency: 'CNY' });
  }
  return items;
}

export const financeApi = {
  getCurrentPlan: (): Promise<SubscriptionPlan> => mockDelay({ ...currentPlan }),
  getAllPlans: (): Promise<SubscriptionPlan[]> => mockDelay(plans.map((p) => ({ ...p }))),
  upgradePlan: (tier: SubscriptionPlan['tier']): Promise<SubscriptionPlan> => {
    const plan = plans.find((p) => p.tier === tier);
    if (plan) currentPlan = { ...plan };
    return mockDelay({ ...currentPlan });
  },
  getAutoRenew: (): Promise<boolean> => mockDelay(autoRenew),
  setAutoRenew: (enabled: boolean): Promise<boolean> => {
    autoRenew = enabled;
    return mockDelay(autoRenew);
  },
  getInvoiceInfo: (): Promise<InvoiceInfo> => mockDelay({ ...invoiceInfo }),
  updateInvoiceInfo: (input: Partial<InvoiceInfo>): Promise<InvoiceInfo> => {
    invoiceInfo = { ...invoiceInfo, ...input };
    return mockDelay({ ...invoiceInfo });
  },
  /** 获取试用状态 — 当前计划 + 剩余天数 + 用量上限 */
  getTrialStatus: (): Promise<{
    planTier: SubscriptionPlan['tier'];
    trialDaysLeft: number;
    trialStoreLimit: number;
    usedStores: number;
    usedAgentCalls: number;
    agentCallLimit: number;
    premiumAgents: string[];
  }> =>
    mockDelay({
      planTier: currentPlan.tier,
      trialDaysLeft: 12,
      trialStoreLimit: currentPlan.storeLimit,
      usedStores: 3,
      usedAgentCalls: 665,
      agentCallLimit: currentPlan.monthlyOps,
      premiumAgents: ['competitor_intel', 'creative_factory', 'live_stream_ops', 'promotion_campaign'],
    }),
  getBillingRecords: (): Promise<BillingRecord[]> => mockDelay([...billingRecords]),
  /** 账单随当前套餐与用量实时计算，升级后上限与金额同步变化。 */
  getCurrentBillDetail: (): Promise<BillingDetail> => {
    const overageItems = buildOverageItems();
    const total = currentPlan.price + overageItems.reduce((sum, item) => sum + item.amount, 0);
    return mockDelay({
      baseSubscription: currentPlan.price,
      overageItems,
      discount: 0,
      total: Math.round(total * 100) / 100,
      currency: 'CNY',
    });
  },
  getUsageOverview: () =>
    mockDelay({
      agentCalls: { used: 665, limit: currentPlan.monthlyOps, unit: '次' },
      tokenUsage: { used: 686000, limit: currentPlan.tokenQuota, unit: 'tokens' },
      browserSessions: { used: 7, limit: 12, unit: '个' },
      workers: { used: 3, limit: 5, unit: '个' },
      stores: { used: 3, limit: currentPlan.storeLimit, unit: '个' }
    }),
  getUsageTrend: () =>
    mockDelay([
      { month: '1月', agentCalls: 380, tokenUsage: 420, browserSessions: 5, stores: 2 },
      { month: '2月', agentCalls: 420, tokenUsage: 450, browserSessions: 6, stores: 2 },
      { month: '3月', agentCalls: 510, tokenUsage: 480, browserSessions: 6, stores: 3 },
      { month: '4月', agentCalls: 490, tokenUsage: 520, browserSessions: 8, stores: 3 },
      { month: '5月', agentCalls: 580, tokenUsage: 600, browserSessions: 7, stores: 3 },
      { month: '6月', agentCalls: 665, tokenUsage: 686, browserSessions: 7, stores: 3 }
    ]),
  // WS-F F3: overage rate card — unit prices charged beyond current plan allowances.
  // Rates are consistent with the mocked current-bill overage items above.
  getOverageRates: (): Promise<{ key: string; label: string; included: string; rate: string }[]> =>
    mockDelay([
      { key: 'agentCalls', label: 'Agent 调用', included: `${currentPlan.monthlyOps.toLocaleString()} 次/月`, rate: '¥0.08 / 次' },
      { key: 'tokenUsage', label: '模型 Token', included: `${currentPlan.tokenQuota.toLocaleString()} tokens/月`, rate: '¥0.03 / 1K tokens' },
      { key: 'browserSessions', label: '浏览器会话', included: '12 个', rate: '¥2.00 / 个 · 月' },
      { key: 'stores', label: '连接店铺', included: `${currentPlan.storeLimit >= 999 ? '不限' : currentPlan.storeLimit} 个`, rate: '¥10.00 / 个 · 月' }
    ]),
  getCostAnalysis: (): Promise<CostAnalysis> =>
    mockDelay({
      byStore: [
        { storeName: '拼多多旗舰店', agentCalls: 320, tokenCost: 28.5 },
        { storeName: '淘宝户外用品店', agentCalls: 245, tokenCost: 18.2 },
        { storeName: '京东自营店', agentCalls: 100, tokenCost: 6.8 }
      ],
      byAgent: [
        { agentType: 'ads_optimizer', calls: 220, cost: 22.4 },
        { agentType: 'product_launch', calls: 180, cost: 12.6 },
        { agentType: 'login_bootstrap', calls: 156, cost: 4.8 },
        { agentType: 'crm_retention', calls: 80, cost: 6.5 },
        { agentType: 'finance_audit', calls: 29, cost: 7.2 }
      ],
      estimatedSaving: { manualCostPerOp: 15, automatedOps: 665, savedAmount: 9975 },
      recommendation: '当前费用在 Starter 套餐范围内，建议保持。广告优化 Agent 可考虑切换至 DeepSeek 模型降低 Token 成本约 40%。'
    })
};

// 套餐、自动续费与开票信息都是用户真实改动过的设置，刷新后应保持不变。
registerMockState(
  'finance-settings',
  () => ({ planTier: currentPlan.tier, autoRenew, invoiceInfo: { ...invoiceInfo } }),
  (value) => {
    if (!value || typeof value !== 'object') return;
    const saved = value as { planTier?: SubscriptionPlan['tier']; autoRenew?: boolean; invoiceInfo?: Partial<InvoiceInfo> };
    const plan = plans.find((p) => p.tier === saved.planTier);
    if (plan) currentPlan = { ...plan };
    if (typeof saved.autoRenew === 'boolean') autoRenew = saved.autoRenew;
    if (saved.invoiceInfo) invoiceInfo = { ...invoiceInfo, ...saved.invoiceInfo };
  }
);
