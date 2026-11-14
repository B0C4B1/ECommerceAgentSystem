/**
 * File: SystemPages.tsx
 * Purpose: Route-level fallbacks so an unknown URL or a render failure never drops the
 * operator onto the router's default (English, unstyled) error screen.
 *
 * Main exports:
 * - NotFoundPage: catch-all route rendered inside the app shell for unmatched paths.
 * - RouteErrorPage: router errorElement for failures while rendering a route.
 */
import { Button, Result, Space } from 'antd';
import { useEffect } from 'react';
import { useNavigate, useRouteError } from 'react-router-dom';
import { useI18n } from '../../app/i18n';

export function NotFoundPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <Result
      status="404"
      title={t('notFound.title')}
      subTitle={t('notFound.desc')}
      extra={
        <Space>
          <Button type="primary" onClick={() => navigate('/dashboard')}>
            {t('notFound.backHome')}
          </Button>
          <Button onClick={() => navigate(-1)}>{t('notFound.backPrev')}</Button>
        </Space>
      }
    />
  );
}

export function RouteErrorPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // Surface the error in devtools for diagnosis; the UI stays free of stack traces.
  const error = useRouteError();
  useEffect(() => {
    if (error) console.error(error);
  }, [error]);

  return (
    <Result
      status="error"
      title={t('routeError.title')}
      subTitle={t('routeError.desc')}
      extra={
        <Space>
          <Button type="primary" onClick={() => window.location.reload()}>
            {t('routeError.reload')}
          </Button>
          <Button onClick={() => navigate('/dashboard')}>{t('routeError.backHome')}</Button>
        </Space>
      }
    />
  );
}
