/**
 * File: agentProfiles.ts
 * Purpose: B — Agent 店铺化。不同商家类型 / 行业需要不同的 Agent 能力包：
 * 中小商家零配置走通用型（不额外调优）；行业商家可把定价、促销、广告、库存、
 * 客服等领域切到专属型，编排层据此对提案收益做可解释的加权。
 *
 * 为什么不塞进 agents.ts：agents.ts 是“有哪些 Agent、开没开”的全局清单，
 * 这里回答的是“这家店用哪一版 Agent”，维度不同，混在一起会让两件事互相牵制。
 */
import { mockDelay } from './client';
import { registerMockState } from './mockPersistence';
import type { AllMallId } from '../types/domain';

export type MerchantType = 'general' | 'specialized';
export type IndustryKey = 'general' | 'digital' | 'outdoor';
export type AgentDomain = 'pricing' | 'promotion' | 'ads' | 'inventory' | 'customer_service';
export type AgentMode = 'general' | 'specialized';

export interface StoreAgentProfile {
  storeId: AllMallId;
  merchantType: MerchantType;
  industry: IndustryKey;
  /** 每个业务领域的 Agent 版本：通用型 / 行业专属型 */
  modes: Record<AgentDomain, AgentMode>;
  updatedAt: string;
}

/** 行业专属型提案的收益系数 — UI 明示，避免“悄悄变好”。 */
export const SPECIALIZED_BOOST = 1.08;

export const AGENT_DOMAINS: AgentDomain[] = ['pricing', 'promotion', 'ads', 'inventory', 'customer_service'];
export const INDUSTRY_KEYS: IndustryKey[] = ['general', 'digital', 'outdoor'];

/** 提案 Agent → 业务领域，用于判断该提案是否命中行业专属能力。 */
export const AGENT_TYPE_DOMAIN: Partial<Record<string, AgentDomain>> = {
  pricing_strategy: 'pricing',
  promotion_campaign: 'promotion',
  ads_optimizer: 'ads',
  inventory_alert: 'inventory',
  review_manager: 'customer_service',
  cs_agent: 'customer_service',
};

function defaultModes(mode: AgentMode = 'general'): Record<AgentDomain, AgentMode> {
  return AGENT_DOMAINS.reduce(
    (acc, domain) => ({ ...acc, [domain]: mode }),
    {} as Record<AgentDomain, AgentMode>,
  );
}

const seedProfiles: StoreAgentProfile[] = [
  {
    storeId: 1001,
    merchantType: 'general',
    industry: 'general',
    modes: defaultModes('general'),
    updatedAt: '2026-08-01T09:00:00.000Z',
  },
  {
    storeId: 1002,
    merchantType: 'specialized',
    industry: 'outdoor',
    modes: {
      pricing: 'general',
      promotion: 'specialized',
      ads: 'specialized',
      inventory: 'specialized',
      customer_service: 'general',
    },
    updatedAt: '2026-08-05T09:00:00.000Z',
  },
  {
    storeId: 1003,
    merchantType: 'specialized',
    industry: 'digital',
    modes: {
      pricing: 'specialized',
      promotion: 'specialized',
      ads: 'specialized',
      inventory: 'general',
      customer_service: 'specialized',
    },
    updatedAt: '2026-08-08T09:00:00.000Z',
  },
];

const profiles = new Map<AllMallId, StoreAgentProfile>(
  seedProfiles.map((profile) => [profile.storeId, { ...profile, modes: { ...profile.modes } }]),
);

function cloneProfile(profile: StoreAgentProfile): StoreAgentProfile {
  return { ...profile, modes: { ...profile.modes } };
}

/** 刷新持久化：商家类型与各领域 Agent 模式决定提案与审批口径，刷新后需保留。 */
registerMockState(
  'agentProfiles',
  () => ({ profiles: [...profiles.entries()] }),
  (value) => {
    const data = value as { profiles?: [AllMallId, StoreAgentProfile][] } | null;
    if (!data?.profiles) return;
    profiles.clear();
    data.profiles.forEach(([storeId, profile]) =>
      profiles.set(storeId, { ...profile, modes: { ...profile.modes } }),
    );
  },
);

export function isSpecialized(profile: StoreAgentProfile | undefined, domain: AgentDomain): boolean {
  return Boolean(
    profile && profile.merchantType === 'specialized' && profile.modes[domain] === 'specialized',
  );
}

/** 中小商家的零配置画像：通用型 + 综合行业，全部领域保持通用版。 */
export function defaultProfile(storeId: AllMallId): StoreAgentProfile {
  return {
    storeId,
    merchantType: 'general',
    industry: 'general',
    modes: defaultModes('general'),
    updatedAt: '',
  };
}

export const agentProfilesApi = {
  list: (): Promise<StoreAgentProfile[]> =>
    mockDelay([...profiles.values()].map(cloneProfile)),

  /** 未配置店铺默认返回通用型画像 — 中小商家无需配置即可运行。 */
  getProfile: (storeId: AllMallId): Promise<StoreAgentProfile> => {
    const existing = profiles.get(storeId);
    return mockDelay(existing ? cloneProfile(existing) : defaultProfile(storeId));
  },

  saveProfile: (profile: StoreAgentProfile): Promise<StoreAgentProfile> => {
    const next = { ...cloneProfile(profile), updatedAt: new Date().toISOString() };
    profiles.set(profile.storeId, next);
    return mockDelay(cloneProfile(next));
  },
};
