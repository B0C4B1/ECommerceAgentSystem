import type { StoreConfig } from '../types/domain';
import { registerMockState } from './mockPersistence';

export const storeConfigs: StoreConfig[] = [];

/** 刷新持久化：店铺连接/平台配置是经营上下文，演示中新建的连接刷新后不能消失。 */
registerMockState(
  'storeConfigs',
  () => ({ configs: storeConfigs }),
  (value) => {
    const data = value as { configs?: StoreConfig[] } | null;
    if (!data?.configs) return;
    storeConfigs.length = 0;
    storeConfigs.push(...data.configs);
  },
);
