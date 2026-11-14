/**
 * Data Export & Reports Page — V1.2
 * Export data and view pre-built reports.
 */
import { useState } from 'react';
import {
  DownloadOutlined, FileExcelOutlined, FilePdfOutlined,
  ExportOutlined, BarChartOutlined,
} from '@ant-design/icons';
import { Button, Card, Col, Empty, List, Modal, Row, Select, Space, Statistic, Tag, Typography, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { storesApi } from '../../api/stores';
import { useI18n } from '../../app/i18n';
import { useStoreScope } from '../../app/storeScope';
import { usePermission } from '../../app/usePermission';
import { PageHeader } from '../../components/PageHeader';
import type { AllMallId } from '../../types/domain';

const exportOptions = [
  { key: 'products', labelKey: 'reports.exportProducts', desc: 'reports.exportProductsDesc', format: 'csv' },
  { key: 'orders', labelKey: 'reports.exportOrders', desc: 'reports.exportOrdersDesc', format: 'csv' },
  { key: 'reviews', labelKey: 'reports.exportReviews', desc: 'reports.exportReviewsDesc', format: 'excel' },
  { key: 'finance', labelKey: 'reports.exportFinance', desc: 'reports.exportFinanceDesc', format: 'excel' },
  { key: 'ads', labelKey: 'reports.exportAds', desc: 'reports.exportAdsDesc', format: 'pdf' },
];

const prebuiltReports = [
  { title: 'reports.weeklySales', icon: <BarChartOutlined />, color: '#1890ff' },
  { title: 'reports.monthlyPnl', icon: <FilePdfOutlined />, color: '#52c41a' },
  { title: 'reports.productPerformance', icon: <BarChartOutlined />, color: '#722ed1' },
  { title: 'reports.customerInsight', icon: <FilePdfOutlined />, color: '#eb2f96' },
];

export function ReportsPage() {
  const { t } = useI18n();
  const { scope } = useStoreScope();
  const { can } = usePermission();
  const canExportReports = can('reports', 'export');
  // Store filtering is shell-level (D3); the page no longer owns a store select.
  const storeFilter = scope === 'all' ? undefined : scope;
  const [dateRange, setDateRange] = useState<string>('last30');

  const { data: stores = [] } = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });
  const storeName = stores.find((s) => s.id === storeFilter)?.name;

  const handleExport = (key: string, format: string) => {
    message.success(t('reports.exportStarted', { key: t(`reports.export${key.charAt(0).toUpperCase() + key.slice(1)}`) + (storeName ? ` · ${storeName}` : '') }));
    // Mock: simulate download trigger
    setTimeout(() => message.success(t('reports.exportDone', { format })), 1500);
  };

  // Pre-built report cards must produce something; a card titled "Click to Generate"
  // that only shows a toast is a fake action, so mirror the export flow end to end.
  const generateReport = (titleKey: string) => {
    if (!canExportReports) {
      message.warning(t('reports.noPermission'));
      return;
    }
    message.success(t('reports.exportStarted', { key: t(titleKey) }));
    setTimeout(() => message.success(t('reports.exportDone', { format: 'PDF' })), 1500);
  };

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <PageHeader title={t('nav.reports')} description={t('reports.subtitle')} />

      <div style={{ padding: '0 24px' }}>
        {/* Filters */}
        <Space wrap style={{ marginBottom: 16 }}>
          <Select value={dateRange} onChange={setDateRange} style={{ width: 140 }} options={[
            { value: 'last7', label: t('reports.last7d') },
            { value: 'last30', label: t('reports.last30d') },
            { value: 'last90', label: t('reports.last90d') },
            { value: 'thismonth', label: t('reports.thisMonth') },
          ]} />
        </Space>

        <Row gutter={[16, 16]}>
          {/* Export section */}
          <Col xs={24} lg={12}>
            <Card title={<><ExportOutlined style={{ marginRight: 6 }} />{t('reports.exportTitle')}</>} size="small">
              <List
                dataSource={exportOptions}
                renderItem={(item) => (
                  <List.Item
                    actions={canExportReports ? [
                      <Button key="export" size="small" icon={<DownloadOutlined />} onClick={() => handleExport(item.key, item.format)}>
                        {item.format.toUpperCase()}
                      </Button>,
                    ] : []}
                  >
                    <List.Item.Meta
                      avatar={item.format === 'csv' ? <FileExcelOutlined style={{ color: '#52c41a', fontSize: 20 }} /> : item.format === 'excel' ? <FileExcelOutlined style={{ color: '#1890ff', fontSize: 20 }} /> : <FilePdfOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />}
                      title={t(item.labelKey)}
                      description={t(item.desc)}
                    />
                  </List.Item>
                )}
              />
            </Card>
          </Col>

          {/* Pre-built reports */}
          <Col xs={24} lg={12}>
            <Card title={<><BarChartOutlined style={{ marginRight: 6 }} />{t('reports.prebuiltTitle')}</>} size="small">
              <Row gutter={[12, 12]}>
                {prebuiltReports.map((r) => (
                  <Col span={12} key={r.title}>
                    <Card size="small" hoverable onClick={() => generateReport(r.title)}>
                      <Statistic title={t(r.title)} value={t('reports.clickToGenerate')} valueStyle={{ fontSize: 14, color: r.color }} prefix={r.icon} />
                    </Card>
                  </Col>
                ))}
              </Row>
            </Card>
          </Col>
        </Row>
      </div>
    </div>
  );
}
