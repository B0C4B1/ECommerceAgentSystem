import { mockDelay } from './client';
import { agentConfigs, agentOutcomesMap, agentRunStatsMap } from './agentMockData';
import { stores, tasks } from './mockData';
import { insertFirst, replaceItem } from './mockRepository';
import { nextId } from './idGenerator';
import { recordAuditLog } from './auditLogger';
import { registerMockState } from './mockPersistence';
import type {
  AgentConfig,
  AgentOutcomeRecord,
  AgentRunStats,
  AgentStrategyConfig,
  AgentType,
  AllMallId,
  Store,
  Task,
  TaskStatus,
} from '../types/domain';

export interface AgentListItem extends AgentConfig {
  runStats?: AgentRunStats;
  activeTaskCount?: number;
}

// ===== P28.4 Agent 健康态：把「卡住了」从隐性变成显式 =====

export type AgentHealthIssueKind = 'auth_invalid' | 'upstream_disabled' | 'idle';

export interface AgentHealthIssue {
  kind: AgentHealthIssueKind;
  /** 该问题影响的已启用 Agent 数量：授权失效是整店，其余是单个 Agent。 */
  affectedAgentCount: number;
  /** kind = upstream_disabled / idle：出问题的 Agent */
  agentType?: AgentType;
  displayName?: string;
  /** kind = upstream_disabled：被依赖但未启用的上游 Agent */
  upstream?: { agentType: AgentType; displayName: string }[];
  /** kind = auth_invalid：授权已失效的店铺 */
  storeId?: AllMallId;
  storeName?: string;
  storeStatus?: Store['status'];
  /** kind = idle：连续多少天没有任何执行 */
  idleDays?: number;
}

export interface AgentHealth {
  enabledCount: number;
  blockedAgentCount: number;
  healthyCount: number;
  issues: AgentHealthIssue[];
}

/** 连续多少个自然日无执行才算「空转」：低于 3 天可能只是当天还没轮询到。 */
const IDLE_DAYS = 3;

export const agentsApi = {
  list: (): Promise<AgentListItem[]> =>
    mockDelay(
      agentConfigs.map((a) => {
        const stats = agentRunStatsMap[a.agentType];
        const activeTaskStatuses: TaskStatus[] = ['draft', 'queued', 'running', 'waiting_approval'];
        const activeCount = tasks.filter(
          (t) => t.agentType === a.agentType && activeTaskStatuses.includes(t.status)
        ).length;
        return { ...a, runStats: stats, activeTaskCount: activeCount };
      })
    ),

  get: (agentType: AgentType): Promise<AgentConfig | undefined> =>
    mockDelay(agentConfigs.find((a) => a.agentType === agentType)),

  getStats: (agentType: AgentType) => mockDelay(agentRunStatsMap[agentType]),

  /**
   * P28.4 健康态：只报告「已启用但跑不动」的 Agent，并给出人能处理的原因。
   * 1) 店铺授权失效（非 connected）→ 该店所有已启用 Agent 都阻塞；
   * 2) 上游 Agent 未启用 → 依赖门控无法通过；
   * 3) 连续 IDLE_DAYS 天无任何执行 → 可能在空转。
   * 未启用的 Agent 不算阻塞：那是人的选择，不是故障。
   */
  getHealth: (storeId?: AllMallId): Promise<AgentHealth> => {
    const enabled = agentConfigs.filter((agent) => agent.enabled);
    const store = storeId !== undefined ? stores.find((item) => item.id === storeId) : undefined;

    if (store && store.status !== 'connected') {
      return mockDelay({
        enabledCount: enabled.length,
        blockedAgentCount: enabled.length,
        healthyCount: 0,
        // 整店授权失效是一个问题，不是 N 个 Agent 各自出错。
        issues: [
          {
            kind: 'auth_invalid',
            affectedAgentCount: enabled.length,
            storeId: store.id,
            storeName: store.name,
            storeStatus: store.status,
          },
        ],
      });
    }

    const issues: AgentHealthIssue[] = [];
    for (const agent of enabled) {
      const upstream = agent.dependsOn
        .map((dep) => agentConfigs.find((candidate) => candidate.agentType === dep))
        .filter((dep): dep is AgentConfig => Boolean(dep) && !dep?.enabled)
        .map((dep) => ({ agentType: dep.agentType, displayName: dep.displayName }));

      if (upstream.length > 0) {
        issues.push({
          agentType: agent.agentType,
          displayName: agent.displayName,
          kind: 'upstream_disabled',
          affectedAgentCount: 1,
          upstream,
        });
        continue;
      }

      const recent = (agentRunStatsMap[agent.agentType]?.trend ?? []).slice(-IDLE_DAYS);
      if (recent.length === IDLE_DAYS && recent.every((point) => point.runs === 0)) {
        issues.push({
          agentType: agent.agentType,
          displayName: agent.displayName,
          kind: 'idle',
          affectedAgentCount: 1,
          idleDays: IDLE_DAYS,
        });
      }
    }

    return mockDelay({
      enabledCount: enabled.length,
      blockedAgentCount: issues.reduce((sum, issue) => sum + issue.affectedAgentCount, 0),
      healthyCount: enabled.length - issues.length,
      issues,
    });
  },

  // WS-D (S4): mock "decisions & outcomes" records — action → metric before/after 3/7d → assessment.
  getOutcomes: (agentType: AgentType): Promise<AgentOutcomeRecord[]> =>
    mockDelay(agentOutcomesMap[agentType] ?? []),

  getTasks: (agentType: AgentType): Promise<Task[]> =>
    mockDelay(tasks.filter((t) => t.agentType === agentType)),

  createTask: (
    agentType: AgentType,
    input: { title: string; goal: string; storeId: AllMallId; images?: string[] }
  ): Promise<Task> => {
    const task: Task = {
      id: nextId('tasks', tasks.length),
      title: input.title,
      storeId: input.storeId,
      agentType,
      goal: input.goal,
      status: 'queued' as TaskStatus, // Consistent: all new tasks start as 'queued'
      riskLevel: 'medium',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timeline: input.images
        ? input.images.map((name, i) => ({
            id: Date.now() + i,
            type: 'step_completed' as const,
            title: `上传图片 ${i + 1}`,
            summary: name,
            at: new Date().toISOString(),
          }))
        : [],
    };
    insertFirst(tasks, task);

    recordAuditLog({
      actor: '当前用户',
      action: '创建任务',
      entity: '任务',
      entityId: task.id,
      summary: `Agent [${agentType}] 创建任务: ${input.title}`,
      category: 'task',
    });

    return mockDelay(task);
  },

  toggle: (agentType: AgentType): Promise<AgentConfig | undefined> => {
    const agent = agentConfigs.find((a) => a.agentType === agentType);
    if (agent) {
      // Check dependencies before enabling
      if (!agent.enabled) {
        const missing = agent.dependsOn.filter(
          (dep) => !agentConfigs.find((a) => a.agentType === dep)?.enabled
        );
        if (missing.length > 0) {
          throw new Error(`依赖未满足: ${missing.join(', ')}`);
        }
      }
      const updated = replaceItem(agentConfigs, (a) => a.agentType === agentType, (current) => ({
        ...current,
        enabled: !current.enabled,
      }));

      recordAuditLog({
        actor: '当前用户',
        action: updated?.enabled ? '启用 Agent' : '停用 Agent',
        entity: 'Agent',
        entityId: agentType as unknown as number,
        summary: `Agent [${agentType}] 已${updated?.enabled ? '启用' : '停用'}`,
        category: 'agent',
      });

      return mockDelay(updated);
    }
    return mockDelay(agent);
  },

  batchEnable: (agentTypes: AgentType[]): Promise<AgentConfig[]> => {
    // Check dependencies for each agent before batch enabling.
    // WS-D: dependencies included in the same batch count as satisfied, so
    // scenario bundles can enable an agent together with its dependencies.
    const batch = new Set<AgentType>(agentTypes);
    for (const agentType of agentTypes) {
      const agent = agentConfigs.find((a) => a.agentType === agentType);
      if (agent && !agent.enabled) {
        const missing = agent.dependsOn.filter(
          (dep) => !batch.has(dep) && !agentConfigs.find((a) => a.agentType === dep)?.enabled
        );
        if (missing.length > 0) {
          throw new Error(
            `Agent [${agentType}] 依赖未满足: ${missing.join(', ')}`
          );
        }
      }
    }

    return mockDelay(600).then(() => {
      for (const ag of agentConfigs) {
        if (agentTypes.includes(ag.agentType)) {
          ag.enabled = true;
        }
      }

      recordAuditLog({
        actor: '当前用户',
        action: '批量启用',
        entity: 'Agent',
        entityId: 0,
        summary: `批量启用 ${agentTypes.length} 个 Agent: ${agentTypes.join(', ')}`,
        category: 'agent',
      });

      return agentConfigs;
    });
  },

  regenerateSeoKeywords: (agentType: AgentType): Promise<string[]> => {
    const agent = agentConfigs.find((a) => a.agentType === agentType);
    const pool = [
      'wireless earbuds',
      'bluetooth 5.3',
      'noise cancelling',
      'long battery life',
      'IPX5 waterproof',
      'ergonomic design',
      'fast charging',
      'premium audio',
      'gaming headset',
      'sports earphones',
      'ANC technology',
      'dual driver',
      'ultra-lightweight',
      'voice assistant',
      'touch control',
      'USB-C charging',
    ];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const keywords = shuffled.slice(0, 6 + Math.floor(Math.random() * 4));
    if (agent?.strategyConfig?.seoKeywords) {
      replaceItem(agentConfigs, (a) => a.agentType === agentType, (current) => ({
        ...current,
        strategyConfig: current.strategyConfig
          ? {
              ...current.strategyConfig,
              seoKeywords: current.strategyConfig.seoKeywords
                ? {
                    ...current.strategyConfig.seoKeywords,
                    keywords,
                    lastGenerated: new Date().toISOString(),
                  }
                : undefined,
            }
          : undefined,
      }));
    }
    return mockDelay(keywords);
  },

  regenerateAudience: (agentType: AgentType): Promise<string[]> => {
    const agent = agentConfigs.find((a) => a.agentType === agentType);
    const pool = [
      '18-35岁',
      '科技爱好者',
      '运动健身人群',
      '通勤白领',
      '学生群体',
      '音乐发烧友',
      '数码极客',
      '户外旅行者',
      '潮流青年',
      '商务人士',
      '游戏玩家',
      '居家办公族',
      '宝妈人群',
      '银发一族',
      '跨境买家',
    ];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const tags = shuffled.slice(0, 4 + Math.floor(Math.random() * 4));
    if (agent?.strategyConfig?.targetAudience) {
      replaceItem(agentConfigs, (a) => a.agentType === agentType, (current) => ({
        ...current,
        strategyConfig: current.strategyConfig
          ? {
              ...current.strategyConfig,
              targetAudience: current.strategyConfig.targetAudience
                ? {
                    ...current.strategyConfig.targetAudience,
                    tags,
                    lastGenerated: new Date().toISOString(),
                  }
                : undefined,
            }
          : undefined,
      }));
    }
    return mockDelay(tags);
  },

  saveStrategyConfig: (
    agentType: AgentType,
    config: Partial<AgentStrategyConfig>
  ): Promise<AgentConfig | undefined> => {
    const agent = agentConfigs.find((a) => a.agentType === agentType);
    if (agent?.strategyConfig) {
      const updated = replaceItem(agentConfigs, (a) => a.agentType === agentType, (current) => ({
        ...current,
        strategyConfig: {
          ...current.strategyConfig!,
          ...config,
        },
      }));

      recordAuditLog({
        actor: '当前用户',
        action: '保存策略配置',
        entity: 'Agent',
        entityId: agentType as unknown as number,
        summary: `Agent [${agentType}] 策略配置已更新`,
        category: 'agent',
      });

      return mockDelay(updated);
    }
    return mockDelay(agent);
  },

  cancelTask: (taskId: AllMallId): Promise<Task | undefined> => {
    const task = replaceItem(tasks, (t) => t.id === taskId, (current) => ({
      ...current,
      status: 'cancelled' as const,
      updatedAt: new Date().toISOString(),
      timeline: [
        ...current.timeline,
        {
          id: Date.now(),
          type: 'run_failed' as const,
          title: '任务已取消',
          summary: '由用户手动取消',
          at: new Date().toISOString(),
        },
      ],
    }));

    if (task) {
      recordAuditLog({
        actor: '当前用户',
        action: '取消任务',
        entity: '任务',
        entityId: taskId,
        summary: `任务已取消: ${task.title}`,
        category: 'task',
      });
    }

    return mockDelay(task);
  },

  // Approving a draft ends the task; without this the draft stays in the active queue
  // and could be approved repeatedly, creating duplicate products.
  completeTask: (taskId: AllMallId, summary: string): Promise<Task | undefined> => {
    const task = replaceItem(tasks, (t) => t.id === taskId, (current) => ({
      ...current,
      status: 'succeeded' as const,
      updatedAt: new Date().toISOString(),
      timeline: [
        ...current.timeline,
        {
          id: Date.now(),
          type: 'run_succeeded' as const,
          title: '草稿已发布',
          summary,
          at: new Date().toISOString(),
        },
      ],
    }));

    if (task) {
      recordAuditLog({
        actor: '当前用户',
        action: '发布商品草稿',
        entity: '任务',
        entityId: taskId,
        summary: `任务已完成: ${task.title}`,
        category: 'task',
      });
    }

    return mockDelay(task);
  },
};

// Agent 启停、策略配置与任务队列是用户操作结果，刷新后必须保持。
registerMockState(
  'agents.configs',
  () => agentConfigs,
  (value) => {
    if (Array.isArray(value)) agentConfigs.splice(0, agentConfigs.length, ...(value as AgentConfig[]));
  }
);
registerMockState(
  'agents.tasks',
  () => tasks,
  (value) => {
    if (Array.isArray(value)) tasks.splice(0, tasks.length, ...(value as Task[]));
  }
);
