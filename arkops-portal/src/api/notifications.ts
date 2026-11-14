/**
 * File: notifications.ts
 * Purpose: Mock API for the notification event × channel matrix (WS-F F4).
 * Backs the Notifications settings page: channel list, per-event subscription
 * toggles, add-channel flow, and a mock test-send action.
 *
 * Author: Michael Lee
 * Created: 2026-07-22
 *
 * Main exports:
 * - notificationsApi: listChannels / toggleEvent / addChannel / testSend.
 *
 * Major updates:
 * - 2026-07-22: Initial version (WS-F F4).
 */
import { mockDelay } from './client';
import { recordAuditLog } from './auditLogger';
import { insertFirst, replaceItem } from './mockRepository';
import { registerMockState } from './mockPersistence';
import type { NotificationChannelConfig, NotificationChannelType, NotificationEventKey } from '../types/domain';

// WS-F: seeded to match the previous static mock story — Feishu connected for
// approval/re-login, DingTalk not configured, Webhook receiving everything.
const channels: NotificationChannelConfig[] = [
  {
    id: 'ch_feishu',
    type: 'feishu',
    name: '飞书',
    status: 'connected',
    endpoint: 'https://open.feishu.cn/open-apis/bot/v2/hook/****',
    events: { approval_required: true, relogin_required: true, run_failed: false }
  },
  {
    id: 'ch_dingtalk',
    type: 'dingtalk',
    name: '钉钉',
    status: 'not_configured',
    events: { approval_required: false, relogin_required: false, run_failed: false }
  },
  {
    id: 'ch_webhook',
    type: 'webhook',
    name: 'Webhook',
    status: 'connected',
    endpoint: 'https://example.com/hooks/allmall',
    events: { approval_required: true, relogin_required: true, run_failed: true }
  }
];

const EVENT_LABELS: Record<NotificationEventKey, string> = {
  approval_required: '需要审批',
  relogin_required: '需要重新登录',
  run_failed: '任务失败'
};

export const notificationsApi = {
  listChannels: (): Promise<NotificationChannelConfig[]> => mockDelay(channels.map((c) => ({ ...c, events: { ...c.events } }))),

  toggleEvent: (channelId: string, event: NotificationEventKey, enabled: boolean): Promise<NotificationChannelConfig | undefined> => {
    const next = replaceItem(channels, (c) => c.id === channelId, (c) => ({
      ...c,
      events: { ...c.events, [event]: enabled }
    }));
    if (next) {
      recordAuditLog({
        actor: '李鹏',
        action: '修改设置',
        entity: '通知',
        entityId: next.id,
        summary: `${enabled ? '开启' : '关闭'} ${next.name} 通道的「${EVENT_LABELS[event]}」事件通知。`,
        category: 'human_ops',
        linkTo: '/settings/notifications'
      });
    }
    return mockDelay(next);
  },

  addChannel: (input: { type: NotificationChannelType; name: string; endpoint?: string }): Promise<NotificationChannelConfig> => {
    const channel: NotificationChannelConfig = {
      id: `ch_${Date.now()}`,
      type: input.type,
      name: input.name,
      // 新通道先标记为未配置，验证成功后才开始接收通知。
      status: 'not_configured',
      endpoint: input.endpoint,
      events: { approval_required: true, relogin_required: false, run_failed: false }
    };
    insertFirst(channels, channel);
    recordAuditLog({
      actor: '李鹏',
      action: '修改设置',
      entity: '通知',
      entityId: channel.id,
      summary: `添加通知通道 ${channel.name}（${channel.type}）。`,
      category: 'human_ops',
      linkTo: '/settings/notifications'
    });
    return mockDelay({ ...channel, events: { ...channel.events } });
  },

  updateEndpoint: (channelId: string, endpoint: string): Promise<NotificationChannelConfig | undefined> => {
    const next = replaceItem(channels, (c) => c.id === channelId, (c) => ({
      ...c,
      endpoint: endpoint.trim() || undefined,
      // 地址变更后必须重新验证，避免沿用旧的已验证状态。
      status: 'not_configured' as const
    }));
    if (next) {
      recordAuditLog({
        actor: '李鹏',
        action: '修改设置',
        entity: '通知',
        entityId: next.id,
        summary: `更新 ${next.name} 通道的接收地址。`,
        category: 'human_ops',
        linkTo: '/settings/notifications'
      });
    }
    return mockDelay(next);
  },

  /** Mock test send: 有地址的通道验证成功后转为已连接；未填写地址则失败。 */
  testSend: (channelId: string): Promise<{ ok: boolean; sentAt: string }> => {
    const channel = channels.find((c) => c.id === channelId);
    const ok = Boolean(channel?.endpoint);
    if (ok && channel) channel.status = 'connected';
    return mockDelay({ ok, sentAt: new Date().toISOString() }, 700);
  }
};

// 通知通道的开关、验证结果与新增通道都属于用户已保存的配置。
registerMockState(
  'notifications.channels',
  () => channels,
  (value) => {
    if (Array.isArray(value)) channels.splice(0, channels.length, ...(value as NotificationChannelConfig[]));
  }
);
