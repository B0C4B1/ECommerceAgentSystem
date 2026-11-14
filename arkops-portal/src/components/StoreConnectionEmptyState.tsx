import { CloudSyncOutlined } from '@ant-design/icons';
import { Card } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../app/i18n';
import { EmptyState } from './EmptyState';

interface StoreConnectionEmptyStateProps {
  description: string;
}

/** Unified empty state shown before a new merchant connects the first store. */
export function StoreConnectionEmptyState({ description }: StoreConnectionEmptyStateProps) {
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <Card className="store-connection-empty-card">
      <EmptyState
        description={description}
        actionText={t('common.connectStore')}
        actionIcon={<CloudSyncOutlined />}
        onAction={() => navigate('/stores/onboarding?journey=import')}
      />
    </Card>
  );
}
