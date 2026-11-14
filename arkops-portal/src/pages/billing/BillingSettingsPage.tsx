import { Tabs } from 'antd';
import { useState } from 'react';
import { useI18n } from '../../app/i18n';
import { PageHeader } from '../../components/PageHeader';
import { BillingSection, FinanceSummary, OverageRateSection, UsageSection } from './billing-sections/UsageBillingSections';
import {
  BankTransferInfoSection,
  CurrentPlanSection,
  InvoiceSection,
  PaymentMethodsSection,
  PlansSection,
  PrivateDeploySection,
} from './billing-sections/SubscriptionSections';

export function BillingSettingsPage() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState('usage');

  const tabItems = [
    {
      key: 'usage',
      label: t('finance.tabUsage'),
      children: (
        <>
          <FinanceSummary onSwitchToSubscription={() => setActiveTab('subscription')} />
          <UsageSection />
          <OverageRateSection />
          <BillingSection />
        </>
      ),
    },
    {
      key: 'subscription',
      label: t('finance.tabSubscription'),
      children: (
        <>
          <CurrentPlanSection />
          <PlansSection />
          <PaymentMethodsSection />
          <InvoiceSection />
          <BankTransferInfoSection />
          <PrivateDeploySection />
        </>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader title={t('finance.title')} description={t('finance.description')} />
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
    </div>
  );
}
