/**
 * File: MetricCard.tsx
 * Purpose: Shared KPI card wrapper for dashboard, store, Agent, billing, and operations pages.
 * It standardizes statistic display, helper text, optional overlay icon, and nested content.
 *
 * Author: Michael Lee
 * Created: 2026-07-03
 *
 * Main exports:
 * - MetricCard: renders a consistent metric card around Ant Design Statistic.
 * - StatTile: renders a page-header stat tile with fixed label/value/helper rhythm.
 *
 * Major updates:
 * - 2026-07-03: Added ownership and function documentation for AI-assisted collaboration.
 * - 2026-11-16: Added StatTile so header stat blocks share one size and type scale.
 */
import { Card, Statistic, Typography } from 'antd';
import type { StatisticProps } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

export type StatTone = 'default' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'orange' | 'muted';

interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** 数值语义色，只映射到 tokens，不接受裸色值。 */
  tone?: StatTone;
  icon?: ReactNode;
  helper?: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
}

/**
 * Renders one page-header stat block with the shared label/value/helper rhythm.
 * Numbers get the same grouping antd Statistic used to provide.
 */
export function StatTile({ label, value, tone = 'default', icon, helper, badge, footer }: StatTileProps) {
  const text = typeof value === 'number' ? value.toLocaleString('en-US') : value;
  return (
    <Card size="small" className={`stat-tile stat-tile-${tone}`}>
      <div className="stat-tile-head">
        <span className="stat-tile-label">
          {/* 固定占位：有/无图标的方块标签左缘保持同一条竖线 */}
          <span className="stat-tile-icon">{icon}</span>
          {label}
        </span>
        {badge ? <span className="stat-tile-badge">{badge}</span> : null}
      </div>
      <div className="stat-tile-value">{text}</div>
      {helper ? <div className="stat-tile-helper">{helper}</div> : null}
      {footer ? <div className="stat-tile-footer">{footer}</div> : null}
    </Card>
  );
}

interface MetricCardProps {
  title: ReactNode;
  value: StatisticProps['value'];
  prefix?: ReactNode;
  suffix?: ReactNode;
  precision?: number;
  valueStyle?: CSSProperties;
  helper?: ReactNode;
  overlayIcon?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * Renders a standardized metric card with optional helper text, overlay icon, and children.
 *
 * @param props - Metric display values and optional card decoration settings.
 * @returns React element containing a reusable KPI card.
 *
 * Author: Michael Lee
 * Created: 2026-07-03
 */
export function MetricCard({
  title,
  value,
  prefix,
  suffix,
  precision,
  valueStyle,
  helper,
  overlayIcon,
  className,
  style,
  children
}: MetricCardProps) {
  return (
    <Card className={className} style={style}>
      {overlayIcon ? <div className="stat-card-icon">{overlayIcon}</div> : null}
      <Statistic
        title={title}
        value={value}
        prefix={prefix}
        suffix={suffix}
        precision={precision}
        valueStyle={valueStyle}
      />
      {helper ? <Typography.Text type="secondary" className="metric-card-helper">{helper}</Typography.Text> : null}
      {children}
    </Card>
  );
}
