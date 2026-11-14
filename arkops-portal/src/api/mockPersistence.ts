/**
 * File: mockPersistence.ts
 * Purpose: 让纯前端 Mock 的“经营状态”在刷新后仍然存在。
 *
 * 为什么需要这一层：治理闭环（周期、裁决、目标回写、跨店方案、收件箱升级项）
 * 原先只活在模块级内存里，刷新即回到种子数据，导致“Agent 跑到一半、人刚拍板完”
 * 的演示无法连续。这里用一个快照容器把各模块的可变状态写进 localStorage，
 * 刷新时按模块恢复；模块也可以在没有快照时继续用自己的种子数据。
 *
 * 边界：只负责“恢复/落盘”这一件事，不感知任何业务字段；各 API 模块自行声明
 * 要保存哪些变量（read/write 成对出现），避免把领域知识堆进本文件。
 */

const STORAGE_KEY = 'allmall:mock:v2';
/** 兜底落盘节奏：页面被强杀时 pagehide 不一定触发。 */
const SAVE_INTERVAL_MS = 3000;

type MockSnapshot = Record<string, unknown>;
type StateReader = () => unknown;
type StateWriter = (value: unknown) => void;

interface RegisteredState {
  read: StateReader;
  write: StateWriter;
}

const registry = new Map<string, RegisteredState>();
/** 首次安装时读到的快照；此后注册的模块也用它做一次恢复。 */
let restoredSnapshot: MockSnapshot | null = null;
let installed = false;

function readSnapshot(): MockSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as MockSnapshot;
  } catch {
    return null;
  }
}

function restoreKey(key: string): void {
  if (!restoredSnapshot || !(key in restoredSnapshot)) return;
  const entry = registry.get(key);
  if (!entry) return;
  try {
    entry.write(restoredSnapshot[key]);
  } catch (error) {
    console.warn(`[mockPersistence] 恢复 ${key} 失败，已回退到种子数据`, error);
  }
}

/**
 * 注册一份需要跨刷新保留的模块状态。
 * 模块在 import 时调用即可；若快照已经读过，会立即恢复。
 */
export function registerMockState(key: string, read: StateReader, write: StateWriter): void {
  registry.set(key, { read, write });
  restoreKey(key);
}

/** 重置期间屏蔽落盘：否则 reload 前的 pagehide 会把旧快照又写回去，重置等于没重置。 */
let resetting = false;

/** 把所有已注册状态合并成一个快照写入 localStorage。 */
export function saveMockPersistence(): void {
  if (resetting || typeof window === 'undefined' || registry.size === 0) return;
  const snapshot: MockSnapshot = {};
  registry.forEach((entry, key) => {
    try {
      snapshot[key] = entry.read();
    } catch (error) {
      console.warn(`[mockPersistence] 读取 ${key} 失败`, error);
    }
  });
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('[mockPersistence] 保存演示数据失败', error);
  }
}

/**
 * 应用启动时调用一次：恢复已有快照，并在页面隐藏/退出前落盘。
 * 必须在任何页面查询发出前安装。
 */
export function installMockPersistence(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  restoredSnapshot = readSnapshot();
  registry.forEach((_entry, key) => restoreKey(key));
  window.addEventListener('pagehide', saveMockPersistence);
  window.addEventListener('beforeunload', saveMockPersistence);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveMockPersistence();
  });
  window.setInterval(saveMockPersistence, SAVE_INTERVAL_MS);
}

/** 清空演示数据并重新加载，回到种子状态。 */
export function resetMockPersistence(): void {
  if (typeof window === 'undefined') return;
  resetting = true;
  window.localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}
