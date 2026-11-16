import { PushpinOutlined, ReloadOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { Badge, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { useState } from 'react';
import { useI18n } from '../../../app/i18n';
import { mockLiveMetrics, mockLiveProducts } from '../agentConfigMockData';

export function LiveMonitorCard() {
  const { t } = useI18n();
  const [syncing, setSyncing] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [lastSync, setLastSync] = useState(() => t('inbox.hoursAgo', { hours: 2 }));
  const [products, setProducts] = useState(mockLiveProducts.map(p => ({ ...p })));

  const handlePin = (id: number) => {
    setProducts(prev => prev.map(p => (p.id === id ? { ...p, pinned: true } : p)));
    message.success(t('live.pinnedSuccess'));
  };

  const handleSync = () => {
    setSyncing(true);
    setTimeout(() => {
      setSyncing(false);
      setLastSync(t('inbox.justNow'));
      message.success(t('live.syncDone'));
    }, 2000);
  };

  const handleAutoPin = () => {
    setPinning(true);
    setTimeout(() => {
      setPinning(false);
      setProducts(prev => prev.map(p => ({ ...p, pinned: true })));
      message.success(t('live.pinDone'));
    }, 1500);
  };

  const totalOrders = products.reduce((sum, p) => sum + p.orders, 0);

  const columns = [
    {
      title: t('live.productName'),
      dataIndex: 'name',
      render: (v: string, record: typeof products[0]) => (
        <Space>
          <Typography.Text strong style={{ fontSize: 13 }}>{v}</Typography.Text>
          {record.pinned && <Tag color="orange" style={{ fontSize: 10 }}>{t('live.pinned')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('live.price'),
      dataIndex: 'price',
      width: 100,
      render: (v: number) => <Typography.Text style={{ fontSize: 13 }}>¥{v.toFixed(2)}</Typography.Text>,
    },
    {
      title: t('live.clicks'),
      dataIndex: 'clicks',
      width: 100,
      render: (v: number) => <Typography.Text style={{ fontSize: 13 }}>{v.toLocaleString()}</Typography.Text>,
    },
    {
      title: t('live.sales'),
      dataIndex: 'orders',
      width: 100,
      render: (v: number) => <Typography.Text style={{ fontSize: 13, fontWeight: 600 }}>{v}</Typography.Text>,
    },
    {
      title: t('common.actions'),
      width: 90,
      render: (_: unknown, r: typeof products[0]) => (
        <Button
          size="small"
          type="link"
          disabled={r.pinned}
          style={{ fontSize: 12, padding: 0 }}
          onClick={() => handlePin(r.id)}
        >
          {t('live.pin')}
        </Button>
      ),
    },
  ];

  return (
    <Card
      style={{ marginBottom: 16, borderTop: '3px solid var(--ark-orange)' }}
      title={
        <Space>
          <VideoCameraOutlined style={{ color: 'var(--ark-orange)' }} />
          {t('live.monitorTitle')}
          <Badge status="processing" />
          <Tag color="orange" style={{ fontSize: 11 }}>{t('live.lastSync')}: {lastSync}</Tag>
        </Space>
      }
      extra={
        <Space size="small">
          <Button size="small" icon={<ReloadOutlined />} loading={syncing} onClick={handleSync}>
            {t('live.syncNow')}
          </Button>
          <Button size="small" type="primary" icon={<PushpinOutlined />} loading={pinning} onClick={handleAutoPin}>
            {t('live.autoPin')}
          </Button>
        </Space>
      }
    >
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ textAlign: 'center' }}>
            <Statistic title={t('live.viewers')} value={mockLiveMetrics.viewers} valueStyle={{ fontSize: 22, color: 'var(--ark-orange)' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ textAlign: 'center' }}>
            <Statistic title={t('live.orders')} value={totalOrders} valueStyle={{ fontSize: 22, color: 'var(--ark-blue)' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ textAlign: 'center' }}>
            <Statistic title="GMV" value={mockLiveMetrics.gmv} prefix="¥" valueStyle={{ fontSize: 22, color: 'var(--ark-green)' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ textAlign: 'center' }}>
            <Statistic title={t('live.conversionRate')} value={mockLiveMetrics.conversionRate} suffix="%" valueStyle={{ fontSize: 22, color: 'var(--ark-green)' }} />
          </Card>
        </Col>
      </Row>
      <Table dataSource={products} columns={columns} rowKey="id" pagination={false} size="small" />
    </Card>
  );
}
