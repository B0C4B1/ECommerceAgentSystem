/**
 * Promotion Calendar View — V1.1
 * Month calendar showing campaign badges on their active dates.
 */
import { Calendar, Badge, Tooltip, Typography, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useI18n } from '../../app/i18n';
import type { PromotionCampaign, Store } from '../../types/domain';

interface Props {
  campaigns: PromotionCampaign[];
  stores: Store[];
}

/*
 * 活动类型识别色：日历格子是「饱和底 + 白字」的小色块，属于主题无关的分类标识。
 * 若换成 --ark-* 语义色，暗色下 token 变浅会让白字对比跌到 2:1 左右，故此处放行裸 hex。
 */
/* hex-audit-off */
const TYPE_COLORS: Record<string, string> = {
  flash_sale: '#ff4d4f',
  seckill: '#f5222d',
  coupon: '#faad14',
  bundle: '#722ed1',
  full_reduction: '#1890ff',
};
/* hex-audit-on */

export function CalendarView({ campaigns, stores }: Props) {
  const { t } = useI18n();
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const dateRender = (date: Dayjs) => {
    const dayCampaigns = campaigns.filter((c) => {
      const start = dayjs(c.startDate);
      const end = dayjs(c.endDate);
      return date.isAfter(start.subtract(1, 'day')) && date.isBefore(end.add(1, 'day'));
    });

    return (
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <div style={{ fontSize: 12, marginBottom: 2, textAlign: 'right', paddingRight: 4 }}>
          {date.date()}
        </div>
        {dayCampaigns.slice(0, 3).map((c) => (
          <Tooltip key={c.id} title={`${c.name}\n${storeById.get(c.storeId)?.name ?? ''}\n${dayjs(c.startDate).format('MM/DD')} - ${dayjs(c.endDate).format('MM/DD')}`}>
            <div style={{
              fontSize: 10, lineHeight: '16px', padding: '0 3px', marginBottom: 1,
              background: TYPE_COLORS[c.type] ?? 'var(--ark-purple)',
              color: 'var(--ark-on-accent)', borderRadius: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {c.name}
            </div>
          </Tooltip>
        ))}
        {dayCampaigns.length > 3 && (
          <Typography.Text type="secondary" style={{ fontSize: 10, paddingLeft: 3 }}>
            +{dayCampaigns.length - 3} {t('promotions.more')}
          </Typography.Text>
        )}
      </div>
    );
  };

  return (
    <Calendar
      dateCellRender={dateRender}
      style={{ background: 'var(--ark-panel)', borderRadius: 8, padding: 16 }}
    />
  );
}
