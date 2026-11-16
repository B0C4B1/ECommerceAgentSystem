import {
  AppstoreOutlined,
  BankOutlined,
  BellOutlined,
  CameraOutlined,
  CheckCircleOutlined,
  CrownOutlined,
  CustomerServiceOutlined,
  PayCircleOutlined,
  EditOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FireOutlined,
  GiftOutlined,
  GlobalOutlined,
  LineChartOutlined,
  PictureOutlined,
  PushpinOutlined,
  RadarChartOutlined,
  SafetyOutlined,
  SearchOutlined,
  ShoppingCartOutlined,
  SkinOutlined,
  SmileOutlined,
  StarOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UnorderedListOutlined,
  WalletOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { AgentTaskGrid, type AgentTaskDefinition } from '../../components/agents/AgentTaskCard';
import { useI18n } from '../../app/i18n';
import type { AgentType } from '../../types/domain';

interface AgentBuiltinTasksSectionProps {
  agentType: AgentType;
  /**
   * WS-D (D6): when provided, built-in task cards become clickable and hand the
   * selected template (localized title + goal) to the caller — used by
   * AgentConfigPage to pre-fill the task creation modal.
   */
  onTaskSelect?: (template: { title: string; goal: string }) => void;
}

/**
 * WS-D: plain-data spec for every agent's built-in tasks (i18n keys, no JSX).
 * Shared by this section, the pre-enable drawer ("what it will do") and the
 * new-task goal templates. Icons/spans stay in the component below.
 */
export interface BuiltinTaskSpec {
  titleKey: string;
  descKey: string;
  tagKey?: string;
  tagColor?: string;
}

export const BUILTIN_TASKS: Partial<Record<AgentType, BuiltinTaskSpec[]>> = {
  pricing_strategy: [
    { titleKey: 'priceScan', descKey: 'priceScanDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'dynamicPrice', descKey: 'dynamicPriceDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'floorProtect', descKey: 'floorProtectDesc', tagKey: 'scheduled', tagColor: 'purple' },
  ],
  login_bootstrap: [
    { titleKey: 'sessionCheckTask', descKey: 'sessionCheckTaskDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'sessionFailedTask', descKey: 'sessionFailedTaskDesc', tagKey: 'passive', tagColor: 'blue' },
    { titleKey: 'bulkPatrol', descKey: 'bulkPatrolDesc', tagKey: 'scheduled', tagColor: 'purple' },
  ],
  competitor_intel: [
    { titleKey: 'passiveCompetitorMonitor', descKey: 'passiveCompetitorMonitorDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'productResearch', descKey: 'productResearchDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'trendMonitor', descKey: 'trendMonitorDesc', tagKey: 'scheduled', tagColor: 'purple' },
  ],
  product_launch: [
    { titleKey: 'imageRecognition', descKey: 'imageRecognitionDesc', tagKey: 'active', tagColor: 'orange' },
    { titleKey: 'draftGeneration', descKey: 'draftGenerationDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'complianceCheck', descKey: 'complianceCheckDesc', tagKey: 'auto', tagColor: 'green' },
  ],
  ads_optimizer: [
    { titleKey: 'roiPatrol', descKey: 'roiPatrolDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'budgetOptimize', descKey: 'budgetOptimizeDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'abTest', descKey: 'abTestDesc', tagKey: 'scheduled', tagColor: 'purple' },
  ],
  crm_retention: [
    { titleKey: 'segmentRefresh', descKey: 'segmentRefreshDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'couponSend', descKey: 'couponSendDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'churnPredict', descKey: 'churnPredictDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'vipCare', descKey: 'vipCareDesc', tagKey: 'auto', tagColor: 'green' },
  ],
  review_manager: [
    { titleKey: 'negativeMonitor', descKey: 'negativeMonitorDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'autoReply', descKey: 'autoReplyDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'reviewInvite', descKey: 'reviewInviteDesc', tagKey: 'scheduled', tagColor: 'purple' },
  ],
  customer_service: [
    { titleKey: 'smartReply', descKey: 'smartReplyDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'escalateHuman', descKey: 'escalateHumanDesc', tagKey: 'passive', tagColor: 'blue' },
    { titleKey: 'faqLearn', descKey: 'faqLearnDesc', tagKey: 'passive', tagColor: 'blue' },
  ],
  after_sales: [
    { titleKey: 'returnAudit', descKey: 'returnAuditDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'refundProcess', descKey: 'refundProcessDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'logisticsTrack', descKey: 'logisticsTrackDesc', tagKey: 'scheduled', tagColor: 'purple' },
  ],
  creative_factory: [
    { titleKey: 'imageGen', descKey: 'imageGenDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'videoGen', descKey: 'videoGenDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'copyGen', descKey: 'copyGenDesc', tagKey: 'auto', tagColor: 'green' },
  ],
  inventory_alert: [
    { titleKey: 'lowStockAlert', descKey: 'lowStockAlertDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'deadStock', descKey: 'deadStockDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'replenish', descKey: 'replenishDesc', tagKey: 'auto', tagColor: 'green' },
  ],
  risk_control: [
    { titleKey: 'complianceScan', descKey: 'complianceScanDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'behaviorMonitor', descKey: 'behaviorMonitorDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'circuitBreaker', descKey: 'circuitBreakerDesc', tagKey: 'passive', tagColor: 'blue' },
  ],
  finance_audit: [
    { titleKey: 'monthlyReconcile', descKey: 'monthlyReconcileDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'discrepancyMark', descKey: 'discrepancyMarkDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'reportGen', descKey: 'reportGenDesc', tagKey: 'auto', tagColor: 'green' },
  ],
  promotion_campaign: [
    { titleKey: 'flashSaleSetup', descKey: 'flashSaleSetupDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'couponCampaign', descKey: 'couponCampaignDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'bundleDeal', descKey: 'bundleDealDesc', tagKey: 'auto', tagColor: 'green' },
  ],
  live_stream_ops: [
    { titleKey: 'liveSchedule', descKey: 'liveScheduleDesc', tagKey: 'scheduled', tagColor: 'purple' },
    { titleKey: 'productPinning', descKey: 'productPinningDesc', tagKey: 'auto', tagColor: 'green' },
    { titleKey: 'liveMetrics', descKey: 'liveMetricsDesc', tagKey: 'passive', tagColor: 'blue' },
  ],
};

const taskIconStyle = (color: string) => ({ color, marginRight: 6 });

interface AgentTaskLayout {
  titleIcon: JSX.Element;
  mdSpan?: number;
  smSpan?: number;
  /** Ordered icons matching BUILTIN_TASKS[agentType]. */
  icons: JSX.Element[];
}

export function AgentBuiltinTasksSection({
  agentType,
  onTaskSelect,
}: AgentBuiltinTasksSectionProps) {
  const { t } = useI18n();

  const layouts: Partial<Record<AgentType, AgentTaskLayout>> = {
    pricing_strategy: {
      titleIcon: <PayCircleOutlined />,
      icons: [
        <EyeOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <ToolOutlined style={taskIconStyle('var(--ark-green)')} />,
        <WarningOutlined style={taskIconStyle('var(--ark-orange)')} />,
      ],
    },
    login_bootstrap: {
      titleIcon: <UnorderedListOutlined />,
      smSpan: 12,
      icons: [
        <CheckCircleOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <BellOutlined style={taskIconStyle('var(--ark-orange)')} />,
        <GlobalOutlined style={taskIconStyle('var(--ark-purple)')} />,
      ],
    },
    competitor_intel: {
      titleIcon: <RadarChartOutlined />,
      icons: [
        <EyeOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <SearchOutlined style={taskIconStyle('var(--ark-green)')} />,
        <GlobalOutlined style={taskIconStyle('var(--ark-purple)')} />,
      ],
    },
    product_launch: {
      titleIcon: <CameraOutlined />,
      icons: [
        <CameraOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <EditOutlined style={taskIconStyle('var(--ark-green)')} />,
        <SafetyOutlined style={taskIconStyle('var(--ark-orange)')} />,
      ],
    },
    ads_optimizer: {
      titleIcon: <ThunderboltOutlined />,
      icons: [
        <LineChartOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <ToolOutlined style={taskIconStyle('var(--ark-green)')} />,
        <FireOutlined style={taskIconStyle('var(--ark-orange)')} />,
      ],
    },
    crm_retention: {
      titleIcon: <GiftOutlined />,
      mdSpan: 6,
      smSpan: 12,
      icons: [
        <SkinOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <GiftOutlined style={taskIconStyle('var(--ark-green)')} />,
        <WarningOutlined style={taskIconStyle('var(--ark-orange)')} />,
        <CrownOutlined style={taskIconStyle('var(--ark-amber)')} />,
      ],
    },
    review_manager: {
      titleIcon: <StarOutlined />,
      icons: [
        <WarningOutlined style={taskIconStyle('var(--ark-red)')} />,
        <EditOutlined style={taskIconStyle('var(--ark-green)')} />,
        <SmileOutlined style={taskIconStyle('var(--ark-blue)')} />,
      ],
    },
    customer_service: {
      titleIcon: <CustomerServiceOutlined />,
      icons: [
        <SmileOutlined style={taskIconStyle('var(--ark-green)')} />,
        <WarningOutlined style={taskIconStyle('var(--ark-orange)')} />,
        <SearchOutlined style={taskIconStyle('var(--ark-purple)')} />,
      ],
    },
    after_sales: {
      titleIcon: <ToolOutlined />,
      icons: [
        <FileSearchOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <WalletOutlined style={taskIconStyle('var(--ark-green)')} />,
        <ShoppingCartOutlined style={taskIconStyle('var(--ark-orange)')} />,
      ],
    },
    creative_factory: {
      titleIcon: <PictureOutlined />,
      icons: [
        <PictureOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <CameraOutlined style={taskIconStyle('var(--ark-green)')} />,
        <EditOutlined style={taskIconStyle('var(--ark-orange)')} />,
      ],
    },
    inventory_alert: {
      titleIcon: <ShoppingCartOutlined />,
      icons: [
        <WarningOutlined style={taskIconStyle('var(--ark-red)')} />,
        <StopOutlined style={taskIconStyle('var(--ark-muted)')} />,
        <ShoppingCartOutlined style={taskIconStyle('var(--ark-green)')} />,
      ],
    },
    risk_control: {
      titleIcon: <SafetyOutlined />,
      icons: [
        <FileSearchOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <EyeOutlined style={taskIconStyle('var(--ark-orange)')} />,
        <StopOutlined style={taskIconStyle('var(--ark-red)')} />,
      ],
    },
    finance_audit: {
      titleIcon: <BankOutlined />,
      icons: [
        <FileSearchOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <WarningOutlined style={taskIconStyle('var(--ark-orange)')} />,
        <EditOutlined style={taskIconStyle('var(--ark-green)')} />,
      ],
    },
    promotion_campaign: {
      titleIcon: <GiftOutlined />,
      icons: [
        <ThunderboltOutlined style={taskIconStyle('var(--ark-red)')} />,
        <PayCircleOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <ShoppingCartOutlined style={taskIconStyle('var(--ark-green)')} />,
      ],
    },
    live_stream_ops: {
      titleIcon: <CustomerServiceOutlined />,
      icons: [
        <UnorderedListOutlined style={taskIconStyle('var(--ark-blue)')} />,
        <PushpinOutlined style={taskIconStyle('var(--ark-orange)')} />,
        <LineChartOutlined style={taskIconStyle('var(--ark-green)')} />,
      ],
    },
  };

  const specs = BUILTIN_TASKS[agentType];
  const layout = layouts[agentType];
  if (!specs || !layout) return null;

  const tasks: AgentTaskDefinition[] = specs.map((spec, i) => {
    const title = t(`agent.${spec.titleKey}`);
    const description = t(`agent.${spec.descKey}`);
    return {
      icon: layout.icons[i],
      title,
      description,
      tag: spec.tagKey ? t(`agent.${spec.tagKey}`) : undefined,
      tagColor: spec.tagColor,
      onClick: onTaskSelect ? () => onTaskSelect({ title, goal: description }) : undefined,
    };
  });

  return (
    <AgentTaskGrid
      title={<><AppstoreOutlined /> {t('agent.builtinTasks')}</>}
      tasks={tasks}
      mdSpan={layout.mdSpan}
      smSpan={layout.smSpan}
    />
  );
}
