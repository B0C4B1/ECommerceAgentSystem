/**
 * Inventory Management Mock API (V1.1)
 */
import { mockDelay } from './client';
import { registerMockState } from './mockPersistence';
import type { AllMallId, InventoryItem, ReplenishSuggestion, SafetyStockConfig, TransferRecommendation } from '../types/domain';

const items: InventoryItem[] = [
  { id: 4701, productId: 4001, storeId: 1001, skuCode: 'BAG-001-BLK', skuName: '真皮托特包-黑色', currentStock: 23, safetyStock: 30, dailySales: 5.2, daysUntilStockout: 4, alertLevel: 'low', source: 'shared_pool', lastRestockedAt: '2026-07-28' },
  { id: 4702, productId: 4001, storeId: 1001, skuCode: 'BAG-001-BRN', skuName: '真皮托特包-棕色', currentStock: 85, safetyStock: 30, dailySales: 4.1, daysUntilStockout: 21, alertLevel: 'healthy', source: 'physical', lastRestockedAt: '2026-07-25' },
  { id: 4703, productId: 4002, storeId: 1002, skuCode: 'SHIRT-002-WHT', skuName: '冰丝衬衫-白色', currentStock: 5, safetyStock: 25, dailySales: 8.3, daysUntilStockout: 1, alertLevel: 'critical', source: 'shared_pool', lastRestockedAt: '2026-07-30' },
  { id: 4704, productId: 4002, storeId: 1002, skuCode: 'SHIRT-002-BLU', skuName: '冰丝衬衫-蓝色', currentStock: 42, safetyStock: 25, dailySales: 6.5, daysUntilStockout: 6, alertLevel: 'low', source: 'physical', lastRestockedAt: '2026-07-22' },
  { id: 4705, productId: 4004, storeId: 1003, skuCode: 'BLOCK-004-A', skuName: '积木桌套装-A款', currentStock: 2, safetyStock: 20, dailySales: 4.0, daysUntilStockout: 0, alertLevel: 'critical', source: 'virtual', lastRestockedAt: '2026-07-18' },
  { id: 4706, productId: 4004, storeId: 1003, skuCode: 'BLOCK-004-B', skuName: '积木桌套装-B款', currentStock: 18, safetyStock: 20, dailySales: 3.2, daysUntilStockout: 6, alertLevel: 'low', source: 'shared_pool', lastRestockedAt: '2026-07-20' },
  { id: 4707, productId: 4005, storeId: 1001, skuCode: 'LAMP-005-WHT', skuName: '露营灯-白色', currentStock: 56, safetyStock: 15, dailySales: 2.1, daysUntilStockout: 27, alertLevel: 'healthy', source: 'physical', lastRestockedAt: '2026-07-28' },
  { id: 4708, productId: 4005, storeId: 1002, skuCode: 'LAMP-005-WHT', skuName: '露营灯-白色', currentStock: 8, safetyStock: 15, dailySales: 4.5, daysUntilStockout: 2, alertLevel: 'critical', source: 'virtual', lastRestockedAt: '2026-07-30' },
  { id: 4709, productId: 4006, storeId: 1003, skuCode: 'SHOE-006-RED', skuName: '运动鞋-红色', currentStock: 67, safetyStock: 25, dailySales: 3.8, daysUntilStockout: 18, alertLevel: 'healthy', source: 'physical', lastRestockedAt: '2026-07-15' },
  { id: 4710, productId: 4006, storeId: 1001, skuCode: 'SHOE-006-BLK', skuName: '运动鞋-黑色', currentStock: 11, safetyStock: 25, dailySales: 7.2, daysUntilStockout: 2, alertLevel: 'critical', source: 'shared_pool', lastRestockedAt: '2026-07-26' },
];

const replenishSuggestions: ReplenishSuggestion[] = [
  { storeId: 1002, productName: '冰丝衬衫-白色', skuCode: 'SHIRT-002-WHT', currentStock: 5, safetyStock: 25, dailySales: 8.3, suggestedQuantity: 120, suggestedDate: '2026-08-12', supplier: '嘉兴服饰供应链', leadTimeDays: 3, priority: 'urgent', reason: '库存仅剩 1 天，日均销量 8.3 件，建议紧急补货 120 件（约 14 天用量 + 安全库存）' },
  { storeId: 1003, productName: '积木桌套装-A款', skuCode: 'BLOCK-004-A', currentStock: 2, safetyStock: 20, dailySales: 4.0, suggestedQuantity: 80, suggestedDate: '2026-08-12', supplier: '汕头玩具工厂', leadTimeDays: 5, priority: 'urgent', reason: '已断货，日均销量 4 件，建议紧急补货 80 件（20 天用量 + 安全库存）' },
  { storeId: 1001, productName: '运动鞋-黑色', skuCode: 'SHOE-006-BLK', currentStock: 11, safetyStock: 25, dailySales: 7.2, suggestedQuantity: 100, suggestedDate: '2026-08-13', supplier: '晋江鞋业供应链', leadTimeDays: 4, priority: 'urgent', reason: '库存仅剩 2 天，日均销量 7.2 件，建议补货 100 件（约 14 天用量 + 缓冲）' },
  { storeId: 1001, productName: '真皮托特包-黑色', skuCode: 'BAG-001-BLK', currentStock: 23, safetyStock: 30, dailySales: 5.2, suggestedQuantity: 60, suggestedDate: '2026-08-15', supplier: '广州皮具供应链', leadTimeDays: 5, priority: 'normal', reason: '低于安全库存线（30 件），日均 5.2 件，建议补货 60 件以恢复安全水位' },
  { storeId: 1002, productName: '露营灯-白色', skuCode: 'LAMP-005-WHT', currentStock: 8, safetyStock: 15, dailySales: 4.5, suggestedQuantity: 40, suggestedDate: '2026-08-13', supplier: '深圳户外用品供应链', leadTimeDays: 3, priority: 'urgent', reason: '库存低于安全线，露营旺季日均 4.5 件，建议紧急补货 40 件' },
];

const transferRecs: TransferRecommendation[] = [
  { fromStoreId: 1001, toStoreId: 1002, productName: '露营灯-白色', skuCode: 'LAMP-005-WHT', quantity: 20, fromStock: 56, toStock: 8, reason: '拼多多旗舰店库存充足（56件），淘宝旗舰店告急（8件），建议调拨 20 件以平衡库存', urgency: 'urgent' },
  { fromStoreId: 1001, toStoreId: 1003, productName: '运动鞋-黑色', skuCode: 'SHOE-006-BLK', quantity: 10, fromStock: 11, toStock: 0, reason: '京东自营店断货，拼多多有少量库存，建议调拨 10 件暂渡（留下 1 件自用）', urgency: 'urgent' },
];

const orderedReplenishments = new Set<string>();

const safetyStockConfigs: SafetyStockConfig[] = [
  { storeId: 1001, productId: 4001, currentSafetyStock: 30, suggestedSafetyStock: 35, recommendation: '真皮托特包旺季销量增长 20%，建议提高安全库存至 35 件' },
  { storeId: 1002, productId: 4002, currentSafetyStock: 25, suggestedSafetyStock: 30, recommendation: '冰丝衬衫夏季爆款日销 8+ 件，安全库存建议从 25 调整至 30' },
  { storeId: 1003, productId: 4004, currentSafetyStock: 20, suggestedSafetyStock: 25, recommendation: '积木桌儿童节后仍保持热度，建议提高至 25 件覆盖补货周期' },
];

/** 供总览关注条使用：与库存明细「预警」筛选同口径（低库存 + 严重不足）。 */
export function getInventoryAlertCount(storeId?: AllMallId): number {
  const scoped = storeId ? items.filter((i) => i.storeId === storeId) : items;
  return scoped.filter((i) => i.alertLevel === 'low' || i.alertLevel === 'critical').length;
}

export const inventoryApi = {
  list: (filters?: { storeId?: AllMallId; alertLevel?: string }) => {
    let result = [...items];
    if (filters?.storeId) result = result.filter((i) => i.storeId === filters.storeId);
    if (filters?.alertLevel === 'alert') {
      result = result.filter((i) => i.alertLevel !== 'healthy');
    } else if (filters?.alertLevel) {
      result = result.filter((i) => i.alertLevel === filters.alertLevel);
    }
    result.sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);
    return mockDelay(result);
  },
  getReplenishSuggestions: () =>
    mockDelay(
      replenishSuggestions.map((suggestion) => {
        const item = findItem(suggestion.storeId, suggestion.skuCode);
        return {
          ...suggestion,
          currentStock: item?.currentStock ?? suggestion.currentStock,
          safetyStock: item?.safetyStock ?? suggestion.safetyStock,
          dailySales: item?.dailySales ?? suggestion.dailySales,
          ordered: orderedReplenishments.has(suggestionKey(suggestion.storeId, suggestion.skuCode)),
        };
      }),
    ),
  /** 下单只记录“已下单”，库存要等到货后才变化；重复点击不会重复建单。 */
  createReplenishOrder: (storeId: AllMallId, skuCode: string) => {
    orderedReplenishments.add(suggestionKey(storeId, skuCode));
    return mockDelay(undefined);
  },
  getTransferRecommendations: () =>
    mockDelay(
      transferRecs.map((rec) => ({
        ...rec,
        fromStock: findItem(rec.fromStoreId, rec.skuCode)?.currentStock ?? rec.fromStock,
        toStock: findItem(rec.toStoreId, rec.skuCode)?.currentStock ?? rec.toStock,
      })),
    ),
  /** 调拨立即改变两边库存，并从建议列表移除，避免同一批货被重复调拨。 */
  applyTransfer: (rec: TransferRecommendation): Promise<{ ok: boolean; quantity: number; fromStock: number; toStock: number }> => {
    const from = findItem(rec.fromStoreId, rec.skuCode);
    if (!from) return mockDelay({ ok: false, quantity: 0, fromStock: 0, toStock: 0 });
    const quantity = Math.min(rec.quantity, from.currentStock);
    if (quantity <= 0) return mockDelay({ ok: false, quantity: 0, fromStock: from.currentStock, toStock: 0 });
    from.currentStock -= quantity;
    recomputeStockLevel(from);
    let to = findItem(rec.toStoreId, rec.skuCode);
    if (!to) {
      to = {
        id: Math.max(...items.map((item) => item.id)) + 1,
        productId: from.productId,
        storeId: rec.toStoreId,
        skuCode: from.skuCode,
        skuName: from.skuName,
        currentStock: quantity,
        safetyStock: from.safetyStock,
        dailySales: from.dailySales,
        daysUntilStockout: 0,
        alertLevel: 'healthy',
        source: 'shared_pool',
        lastRestockedAt: new Date().toISOString().slice(0, 10),
      };
      items.push(to);
    } else {
      to.currentStock += quantity;
      recomputeStockLevel(to);
    }
    const index = transferRecs.findIndex(
      (entry) => entry.fromStoreId === rec.fromStoreId && entry.toStoreId === rec.toStoreId && entry.skuCode === rec.skuCode,
    );
    if (index >= 0) transferRecs.splice(index, 1);
    return mockDelay({ ok: true as const, quantity, fromStock: from.currentStock, toStock: to.currentStock });
  },
  getSafetyStockConfigs: () => mockDelay(safetyStockConfigs),
  getOverview: (storeId?: AllMallId) => {
    const scoped = storeId ? items.filter((i) => i.storeId === storeId) : items;
    const critical = scoped.filter((i) => i.alertLevel === 'critical').length;
    const low = scoped.filter((i) => i.alertLevel === 'low').length;
    const healthy = scoped.filter((i) => i.alertLevel === 'healthy').length;
    const totalStock = scoped.reduce((s, i) => s + i.currentStock, 0);
    const totalValue = scoped.reduce((s, i) => s + i.currentStock * 50, 0); // avg 50 CNY
    return mockDelay({ critical, low, healthy, totalStock, totalValue });
  },
};

function suggestionKey(storeId: AllMallId, skuCode: string) {
  return `${storeId}:${skuCode}`;
}

function findItem(storeId: AllMallId, skuCode: string) {
  return items.find((item) => item.storeId === storeId && item.skuCode === skuCode);
}

function recomputeStockLevel(item: InventoryItem) {
  item.daysUntilStockout = item.dailySales > 0 ? Math.floor(item.currentStock / item.dailySales) : 99;
  item.alertLevel =
    item.currentStock <= 0 || item.currentStock < item.safetyStock * 0.5
      ? 'critical'
      : item.currentStock < item.safetyStock
        ? 'low'
        : 'healthy';
}

registerMockState(
  'inventory',
  () => ({ items, ordered: [...orderedReplenishments], transferRecs }),
  (value) => {
    const data = value as { items?: InventoryItem[]; ordered?: string[]; transferRecs?: TransferRecommendation[] } | null;
    if (!data) return;
    if (data.items) {
      items.length = 0;
      items.push(...data.items);
    }
    orderedReplenishments.clear();
    (data.ordered ?? []).forEach((key) => orderedReplenishments.add(key));
    if (data.transferRecs) {
      transferRecs.length = 0;
      transferRecs.push(...data.transferRecs);
    }
  },
);
