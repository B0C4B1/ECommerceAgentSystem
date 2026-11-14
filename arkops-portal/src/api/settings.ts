import { mockDelay } from './client';
import { registerMockState } from './mockPersistence';
import { members as seedMembers } from './mockData';
import type { Member } from '../types/domain';

const members: Member[] = seedMembers.map((member) => ({ ...member }));

export const settingsApi = {
  members: () => mockDelay([...members]),
  inviteMember: (params: { email: string; role: Member['role'] }) => {
    const email = params.email.trim().toLowerCase();
    const existing = members.find((member) => member.email.toLowerCase() === email);
    if (existing) return mockDelay({ member: { ...existing }, existed: true });
    const member: Member = {
      id: Math.max(...members.map((entry) => entry.id)) + 1,
      name: email.split('@')[0],
      email,
      role: params.role,
      status: 'invited',
    };
    members.push(member);
    return mockDelay({ member: { ...member }, existed: false });
  },
  notifications: () =>
    mockDelay([
      { channel: '飞书', status: 'connected', events: '需要审批、需要重新登录' },
      { channel: '钉钉', status: 'not_configured', events: '未配置' },
      { channel: 'Webhook', status: 'connected', events: '所有 runtime 事件' }
    ]),
  billing: () =>
    mockDelay({
      plan: '内部测试版',
      workerLimit: 5,
      browserSessionLimit: 12,
      tokenUsage: 184200,
      operationUsage: 392
    })
};

registerMockState(
  'settings-members',
  () => members,
  (value) => {
    const data = value as Member[] | null;
    if (!Array.isArray(data)) return;
    members.length = 0;
    members.push(...data);
  },
);
