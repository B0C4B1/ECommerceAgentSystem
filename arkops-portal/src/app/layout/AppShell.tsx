/**
 * File: AppShell.tsx
 * Purpose: Authenticated application frame — responsive sidebar/drawer navigation,
 * header controls (theme, notifications, identity), demo banner, and routed content.
 *
 * Author: Michael Lee
 *
 * Main exports:
 * - AppShell: layout wrapper rendered by the router for all authenticated pages.
 *
 * Major updates:
 * - 2026-07-22: WS-E — responsive navigation: Sider collapses via breakpoint="lg"
 *   with collapsedWidth={0}; under 768px the nav renders in a Drawer opened by a
 *   header hamburger trigger, keeping the app usable at 375px.
 */
import {
  AlertOutlined,
  AppstoreOutlined,
  AuditOutlined,
  ApartmentOutlined,
  BellOutlined,
  CheckSquareOutlined,
  CloseOutlined,
  CustomerServiceOutlined,
  DashboardOutlined,
  DesktopOutlined,
  GiftOutlined,
  InboxOutlined, // WS-B
  PayCircleOutlined,
  ExperimentOutlined as LabOutlined,
  ExperimentOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  SearchOutlined,
  SettingOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  ShopOutlined,
  PlaySquareOutlined,
  StarOutlined,
  SunOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import { Avatar, Badge, Button, Divider, Drawer, Dropdown, Layout, Menu, Popconfirm, Segmented, Select, Space, Tag, Tooltip, Typography, message } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useDemoMode } from '../demoMode';
import { LANGUAGE_SWITCHER_ENABLED, useI18n } from '../i18n';
import type { TranslationKey } from '../i18n';
import { useStoreScope } from '../storeScope';
import { useTheme } from '../theme';
import { dashboardApi } from '../../api/dashboard';
import { exceptionsApi } from '../../api/exceptions';
import { orchestratorApi } from '../../api/orchestrator';
import { operatingModelApi } from '../../api/operatingModel';
import { resetMockPersistence } from '../../api/mockPersistence';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { getAccessiblePaths } from '../rolePermissions';
import type { Role } from '../rolePermissions';
import { CommandPalette } from '../../components/CommandPalette';
import { OnboardingTour } from '../../components/OnboardingTour';
import { useEffect, useState } from 'react';

const { Header, Sider, Content } = Layout;

const MOBILE_NAV_MEDIA_QUERY = '(max-width: 767px)';

/**
 * Tracks a CSS media query, initialized synchronously to avoid layout flicker.
 *
 * @param query - Media query string to observe.
 * @returns Whether the query currently matches.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

const routeMenuPrefixes = [
  '/orders',
  '/products',
  '/stores',
  '/dashboard',
  '/settings',
  // D-nav/B: 业务运营 group members — each keeps its own highlighted entry inside the group.
  '/customer-service',
  '/reviews',
  '/promotions',
  '/ads',
  '/inventory',
  '/livestream',
];

/** 业务运营 group members — used to auto-open the group and fold reports into the dashboard. */
const BUSINESS_GROUP_PATHS = ['/customer-service', '/reviews', '/promotions', '/ads', '/inventory', '/livestream'];

/** Sidebar entry → page-title key, so the browser tab matches the active navigation item. */
const ROUTE_TITLE_KEYS: Record<string, TranslationKey> = {
  '/dashboard': 'nav.dashboard',
  // /reports is folded into the dashboard menu item but is its own page.
  '/reports': 'nav.reports',
  '/stores': 'nav.storeManagement',
  '/products': 'nav.products',
  '/orders': 'nav.orders',
  '/inbox': 'nav.todoCenter',
  '/customer-service': 'nav.customerService',
  '/reviews': 'nav.reviews',
  '/promotions': 'nav.promotions',
  '/ads': 'nav.ads',
  '/inventory': 'nav.inventory',
  '/livestream': 'nav.live',
  '/setup': 'nav.automationConfig',
  '/settings/members': 'nav.memberManagement',
  '/settings/models': 'nav.models',
  '/settings/notifications': 'nav.notificationSettings',
  '/settings/audit-logs': 'nav.auditLogs',
  '/settings/billing': 'nav.planBilling',
  '/settings/guide': 'nav.helpCenter',
};

function getSelectedMenuKey(pathname: string) {
  if (pathname === '/') return '/dashboard';
  // settings sub-items match their exact path
  if (pathname.startsWith('/settings/')) return pathname;
  // store workflow pages belong to the top-level Store Management item
  if (pathname === '/stores' || pathname.startsWith('/stores/')) return '/stores';
  // D9: the exception/approval centres are folded into the inbox; only the approval
  // detail page remains under /agents/approvals/:id and it belongs to the inbox entry.
  if (pathname.startsWith('/agents/approvals')) return '/inbox';
  // Legacy approval detail URL (/approvals/:id) still resolves — keep the inbox highlighted.
  if (pathname.startsWith('/approvals')) return '/inbox';
  // D10: the sidebar entry is 自动化配置 (/setup) — the scenario surface. The per-agent
  // pages under /agents are the "expert view" reached from a button there, not their own
  // nav item, so they highlight the 自动化配置 entry.
  if (pathname === '/agents' || pathname.startsWith('/agents/')) return '/setup';
  // D-nav/B: 报表 folded into 经营总览 — no own nav item, so highlight the dashboard.
  if (pathname === '/reports' || pathname.startsWith('/reports/')) return '/dashboard';
  return routeMenuPrefixes.find((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ?? pathname;
}

function getActiveMenuGroup(selectedKey: string): string | null {
  // D9: 待办中心 is a single top-level item now, so it has no group to expand.
  if (selectedKey.startsWith('/settings/') && selectedKey !== '/settings/billing' && selectedKey !== '/settings/guide') return 'settings-group';
  // D-nav/B: business-line pages live under the 业务运营 group — open it when one is active.
  if (BUSINESS_GROUP_PATHS.includes(selectedKey)) return 'business-group';
  return null;
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { language, setLanguage, t } = useI18n();
  const { mode, setMode } = useTheme();
  const { isDemo, exitDemo } = useDemoMode();
  const { role, setRole, user, logout } = useAuth();
  const { scope: storeScope, setScope: setStoreScope, stores: scopeStores } = useStoreScope();
  const accessiblePaths = getAccessiblePaths(role ?? 'Owner');

  const handleLogout = () => {
    exitDemo();
    logout();
    navigate('/login', { replace: true });
  };

  /** Filter menu items based on role permissions */
  function filterMenuByRole(items: any[]): any[] {
    if (!accessiblePaths) return items; // null = all visible
    return items.filter(item => {
      if (item.children) {
        const filteredChildren = filterMenuByRole(item.children);
        return filteredChildren.length > 0;
      }
      return accessiblePaths.includes(item.key);
    }).map(item => {
      if (item.children) {
        return { ...item, children: filterMenuByRole(item.children) };
      }
      return item;
    });
  }

  const { data: dashboard } = useQuery({
    queryKey: ['dashboard'],
    queryFn: dashboardApi.getSummary,
    refetchInterval: 30_000
  });

  const hasBusinessData = user?.experience !== 'onboarding';
  const queryClient = useQueryClient();

  /** P44.2 演示路径：把账户目标退到上期，复现「上期 · 待确认」。 */
  const simulateAccountGoalCarryOver = async () => {
    const next = await operatingModelApi.carryOverAccountGoalForDemo();
    if (!next) {
      message.warning(t('app.simulateMonthEndEmpty'));
      return;
    }
    // P49：跨月后立刻跑一轮巡检，让「上期结论进待办」当场可见，而不是等人下次刷新才出现。
    await orchestratorApi.runGovernanceSweep();
    await queryClient.invalidateQueries();
    message.success(t('app.simulateMonthEndDone'));
  };

  /**
   * P35.1 进入应用即触发一轮治理自巡检：目标结算、节奏/护栏升级、决策规则与超时默认
   * 这些 Agent 职责不再等人打开工作台或收件箱才发生。幂等，只回变化量。
   */
  useEffect(() => {
    if (!hasBusinessData) return;
    let cancelled = false;
    orchestratorApi
      .runGovernanceSweep()
      .then((sweep) => {
        if (cancelled || !sweep.changed) return;
        queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        queryClient.invalidateQueries({ queryKey: ['exceptions'] });
        queryClient.invalidateQueries({ queryKey: ['storeGoal'] });
        queryClient.invalidateQueries({ queryKey: ['goalPeriod'] });
        queryClient.invalidateQueries({ queryKey: ['goalPace'] });
        queryClient.invalidateQueries({ queryKey: ['guardHealth'] });
        queryClient.invalidateQueries({ queryKey: ['guardChanges'] });
        queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasBusinessData, queryClient]);

  const pendingApprovals = hasBusinessData ? dashboard?.pendingApprovals ?? 0 : 0;
  const exceptionPending = hasBusinessData ? dashboard?.exceptionCenterPending ?? 0 : 0;
  const orderExceptions = hasBusinessData ? dashboard?.orderExceptions ?? 0 : 0;
  // WS-B (B2): unified Action Inbox count = approvals + exceptions + re-login stores
  const loginRequiredStores = hasBusinessData ? dashboard?.loginRequiredStores ?? 0 : 0;
  const inboxCount = hasBusinessData ? dashboard?.inboxTotal ?? 0 : 0;
  const selectedMenuKey = getSelectedMenuKey(location.pathname);
  const activeMenuGroup = getActiveMenuGroup(selectedMenuKey);
  const [openMenuKeys, setOpenMenuKeys] = useState<string[]>(() => activeMenuGroup ? [activeMenuGroup] : []);
  const isMobileNav = useMediaQuery(MOBILE_NAV_MEDIA_QUERY);
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Close the mobile nav drawer after any route change.
  useEffect(() => {
    setNavDrawerOpen(false);
  }, [location.pathname]);

  // E4: auto-open the active group additively — never force-close groups the user opened.
  useEffect(() => {
    if (!activeMenuGroup) return;
    setOpenMenuKeys((prev) => (prev.includes(activeMenuGroup) ? prev : [...prev, activeMenuGroup]));
  }, [activeMenuGroup]);

  const menuItems = [
    // 1. 经营总览
    { key: '/dashboard', icon: <DashboardOutlined />, label: t('nav.dashboard') },

    // 2. 店铺管理 — 新用户连接入口与多店铺管理
    {
      key: '/stores',
      icon: <ShopOutlined />,
      label: user?.experience === 'onboarding' ? t('nav.connectStore') : t('nav.storeManagement')
    },

    // 3. 商品管理
    { key: '/products', icon: <AppstoreOutlined />, label: t('nav.products') },

    // 4. 订单管理 — 日常订单处理
    {
      key: '/orders',
      icon: <ShoppingCartOutlined />,
      label: (
        <span>
          {t('nav.orders')}
          {orderExceptions > 0 && (
            <Badge count={orderExceptions} size="small" offset={[8, -2]} style={{ marginLeft: 8 }} />
          )}
        </span>
      )
    },

    // 5. 待办中心 — 审批 / 异常 / 重新登录 / 订单 / 商品的统一队列（D9：三合一，不再分子项）
    {
      key: '/inbox',
      icon: <InboxOutlined />,
      label: (
        <span>
          {t('nav.todoCenter')}
          {inboxCount > 0 && (
            <Badge count={inboxCount} size="small" offset={[8, -2]} style={{ marginLeft: 8 }} />
          )}
        </span>
      )
    },

    // 5a. 业务运营 — D-nav/B: the per-line pages are the手动兜底/专家视图 of the Agent
    // scenarios, so they fold into one collapsible group instead of 6 flat top-level
    // items. 报表 moved into 经营总览; each line is also reachable from its scenario card.
    {
      key: 'business-group',
      icon: <ApartmentOutlined />,
      label: t('nav.businessOps'),
      children: [
        { key: '/customer-service', icon: <CustomerServiceOutlined />, label: t('nav.customerService') },
        { key: '/reviews', icon: <StarOutlined />, label: t('nav.reviews') },
        { key: '/promotions', icon: <GiftOutlined />, label: t('nav.promotions') },
        { key: '/ads', icon: <ThunderboltOutlined />, label: t('nav.ads') },
        { key: '/inventory', icon: <ShoppingOutlined />, label: t('nav.inventory') },
        { key: '/livestream', icon: <PlaySquareOutlined />, label: t('nav.live') },
      ],
    },

    // 6. 自动化配置（场景优先；逐 Agent 专家视图从页内进入）
    {
      // D10: 自动化配置 (the scenario surface) is the single Agent entry; the per-agent
      // "expert view" (/agents) is reached from a button there, not a nav item.
      key: '/setup',
      icon: <ThunderboltOutlined />,
      label: t('nav.automationConfig')
    },

    // 7. 平台设置
    {
      key: 'settings-group',
      icon: <SettingOutlined />,
      label: t('nav.platformSettings'),
      children: [
        { key: '/settings/members', icon: <TeamOutlined />, label: t('nav.memberManagement') },
        { key: '/settings/models', icon: <ExperimentOutlined />, label: t('nav.models') },
        { key: '/settings/notifications', icon: <BellOutlined />, label: t('nav.notificationSettings') },
        { key: '/settings/audit-logs', icon: <AuditOutlined />, label: t('nav.auditLogs') },
      ]
    },

    // 8-9. 账户与帮助
    { key: '/settings/billing', icon: <PayCircleOutlined />, label: t('nav.planBilling') },
    { key: '/settings/guide', icon: <QuestionCircleOutlined />, label: t('nav.helpCenter') },
  ];

  const experienceLabel =
    user?.experience === 'onboarding' ? t('shell.newMerchant') : t('shell.establishedMerchant');

  // Keep the browser tab in sync with the page so multi-tab operators can tell them apart.
  useEffect(() => {
    const titleKey = ROUTE_TITLE_KEYS[location.pathname] ?? ROUTE_TITLE_KEYS[getSelectedMenuKey(location.pathname)];
    document.title = titleKey ? `${t(titleKey)} · AllMall` : 'AllMall Portal';
  }, [location.pathname, t]);

  // Identity panel (E3): user summary + demo "view as" role switcher + logout in one place.
  const identityPanel = (
    <div className="identity-menu">
      <div className="identity-menu-user">
        <Avatar
          size={40}
          style={{ background: user?.experience === 'onboarding' ? 'var(--ark-blue)' : 'var(--ark-green)' }}
        >
          {user?.name.slice(-2) ?? 'AM'}
        </Avatar>
        <div>
          <Typography.Text strong style={{ display: 'block' }}>{user?.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{experienceLabel}</Typography.Text>
        </div>
      </div>
      <div className="identity-menu-role">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('shell.currentRole')}</Typography.Text>
        <Tag style={{ margin: 0 }}>{role ?? 'Owner'}</Tag>
      </div>
      <Divider style={{ margin: '10px 0' }} />
      <div className="identity-menu-viewas">
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('shell.viewAs')}</Typography.Text>
          <Tooltip title={t('shell.viewAsHint')}>
            <QuestionCircleOutlined className="identity-menu-hint" />
          </Tooltip>
        </Space>
        <Select
          size="small"
          value={role ?? 'Owner'}
          onChange={(v) => setRole(v as Role)}
          style={{ width: '100%' }}
          options={[
            { label: 'Owner', value: 'Owner' },
            { label: 'Admin', value: 'Admin' },
            { label: 'Operator', value: 'Operator' },
            { label: 'Approver', value: 'Approver' },
            { label: 'Finance', value: 'Finance' },
            { label: 'Viewer', value: 'Viewer' },
          ]}
        />
      </div>
      <Divider style={{ margin: '10px 0' }} />
      <Button block icon={<LogoutOutlined />} onClick={handleLogout}>
        {t('shell.logout')}
      </Button>
    </div>
  );

  // P30.5：指派通知。Agent 或人把升级交给某成员后，按成员名或角色推到这个铃铛，
  // 人不必先打开待办中心逐条找「哪条归我」；通知只做站内，外部渠道未接入。
  const { data: notices, refetch: refetchNotices } = useQuery({
    queryKey: ['escalation-notices'],
    queryFn: exceptionsApi.listNotices,
    refetchInterval: 30_000,
  });
  const myNotices = (notices ?? []).filter(
    (notice) => notice.recipientName === user?.name || notice.recipientRole === user?.role,
  );
  const unreadNotices = myNotices.filter((notice) => !notice.readAt);
  const bellCount = hasBusinessData ? (unreadNotices.length > 0 ? unreadNotices.length : inboxCount) : 0;

  const openInboxFromNotice = (noticeId?: string) => {
    const task = noticeId ? exceptionsApi.markNoticesRead([noticeId]) : Promise.resolve();
    void task.then(() => refetchNotices());
    navigate('/inbox');
  };

  const noticePanel = (
    <div className="identity-menu" style={{ width: 340 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text strong>{t('shell.noticesTitle')}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('shell.noticesUnread', { count: unreadNotices.length })}
        </Typography.Text>
      </div>
      {myNotices.length === 0 ? (
        <Typography.Text type="secondary" style={{ display: 'block', padding: '10px 0', fontSize: 12 }}>
          {t('shell.noticesEmpty')}
        </Typography.Text>
      ) : (
        <div style={{ marginTop: 8 }}>
          {myNotices.slice(0, 5).map((notice) => (
            <button
              type="button"
              key={notice.id}
              onClick={() => openInboxFromNotice(notice.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 6px',
                border: 'none',
                borderLeft: notice.readAt ? '3px solid transparent' : '3px solid var(--ark-blue)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <Typography.Text strong={!notice.readAt} style={{ display: 'block', fontSize: 13 }}>
                {notice.title}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {notice.storeName} · {notice.reason}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                {t('shell.noticeAssignedTo', {
                  name: notice.recipientName,
                  role: t(`member.role.${notice.recipientRole}` as TranslationKey),
                })}
              </Typography.Text>
            </button>
          ))}
        </div>
      )}
      <Divider style={{ margin: '8px 0' }} />
      <Space size={4} wrap>
        <Button type="link" size="small" onClick={() => openInboxFromNotice()}>
          {t('shell.noticesOpenInbox', { count: inboxCount })}
        </Button>
        {unreadNotices.length > 0 && (
          <Button
            type="link"
            size="small"
            onClick={() => {
              void exceptionsApi
                .markAllNoticesRead({ name: user?.name, role: user?.role ?? undefined })
                .then(() => refetchNotices());
            }}
          >
            {t('shell.noticesMarkAllRead')}
          </Button>
        )}
      </Space>
    </div>
  );

  const navContent = (
    <>
      <div className="brand">
        <div className="brand-mark">A</div>
        <div>
          <Typography.Text strong>AllMall</Typography.Text>
          <Typography.Text type="secondary" className="brand-subtitle">
            {t('app.subtitle')}
          </Typography.Text>
        </div>
      </div>
      <Menu
        mode="inline"
        selectedKeys={[selectedMenuKey]}
        openKeys={openMenuKeys}
        onOpenChange={(keys) => setOpenMenuKeys(keys as string[])}
        items={filterMenuByRole(menuItems)}
        onClick={({ key }) => {
          navigate(key);
          if (isMobileNav) setNavDrawerOpen(false);
        }}
      />
    </>
  );

  return (
    <Layout className="app-shell">
      {isMobileNav ? (
        <Drawer
          placement="left"
          width={264}
          open={navDrawerOpen}
          onClose={() => setNavDrawerOpen(false)}
          closable={false}
          className="app-nav-drawer"
          styles={{ body: { padding: 0 } }}
        >
          {navContent}
        </Drawer>
      ) : (
        <Sider
          width={248}
          className="app-sider"
          collapsible
          collapsed={siderCollapsed}
          trigger={null}
          breakpoint="lg"
          collapsedWidth={0}
          onCollapse={(collapsed) => setSiderCollapsed(collapsed)}
        >
          {navContent}
        </Sider>
      )}
      <Layout>
        <Header className="app-header">
          <Space>
            <Button
              type="text"
              icon={<MenuOutlined />}
              aria-label={t('shell.menuToggle')}
              title={t('shell.menuToggle')}
              onClick={() => (isMobileNav ? setNavDrawerOpen(true) : setSiderCollapsed((prev) => !prev))}
            />
            <Badge status="processing" text={t('app.beta')} />
            <Typography.Text type="secondary" className="app-header-tenant">
              {user?.experience === 'onboarding' ? t('shell.tenantOnboarding') : t('app.tenant')}
            </Typography.Text>
          </Space>
          <Space>
            <Select
              className="header-store-scope"
              size="small"
              aria-label={t('shell.storeScope')}
              title={t('shell.storeScope')}
              value={storeScope === 'all' ? 'all' : String(storeScope)}
              onChange={(value) => setStoreScope(value === 'all' ? 'all' : Number(value))}
              popupMatchSelectWidth={false}
              options={[
                { value: 'all', label: <><ShopOutlined /> {t('shell.allStores')}</> },
                ...scopeStores.map((store) => ({
                  value: String(store.id),
                  label: <><ShopOutlined /> {store.name}</>
                }))
              ]}
            />
            <Segmented
              size="small"
              value={mode}
              onChange={(value) => setMode(value as 'system' | 'light' | 'dark')}
              options={[
                { label: <span title={t('theme.system')}><DesktopOutlined /></span>, value: 'system' },
                { label: <span title={t('theme.light')}><SunOutlined /></span>, value: 'light' },
                { label: <span title={t('theme.dark')}><MoonOutlined /></span>, value: 'dark' }
              ]}
            />
            {LANGUAGE_SWITCHER_ENABLED && (
              <Segmented
                size="small"
                value={language}
                onChange={(value) => setLanguage(value as 'en' | 'zh')}
                options={[
                  { label: 'EN', value: 'en' },
                  { label: '中文', value: 'zh' }
                ]}
              />
            )}
            <Button
              icon={<SearchOutlined />}
              aria-label={t('shell.searchOpen')}
              title={t('shell.searchOpen')}
              onClick={() => setPaletteOpen(true)}
            />
            {/* WS-B (B2): bell opens assigned-escalation notices (P30.5) with a live unread badge */}
            <Badge count={bellCount} size="small" offset={[-4, 4]}>
              <Dropdown trigger={['click']} placement="bottomRight" dropdownRender={() => noticePanel}>
                <Button icon={<BellOutlined />}>{t('app.alerts')}</Button>
              </Dropdown>
            </Badge>
            <Dropdown trigger={['click']} placement="bottomRight" dropdownRender={() => identityPanel}>
              <button type="button" className="header-identity" aria-label={t('shell.currentRole')}>
                <Avatar style={{ background: user?.experience === 'onboarding' ? 'var(--ark-blue)' : 'var(--ark-green)' }}>
                  {user?.name.slice(-2) ?? 'AM'}
                </Avatar>
                <span className="header-identity-copy">
                  <Typography.Text strong style={{ display: 'block', fontSize: 12 }}>{user?.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 10 }}>
                    {experienceLabel}
                  </Typography.Text>
                </span>
              </button>
            </Dropdown>
          </Space>
        </Header>
        <Content className="app-content">
          {isDemo && (
            <div className="demo-banner">
              <Space size={8}>
                <LabOutlined className="demo-banner-icon" />
                <Typography.Text className="demo-banner-text">
                  {t('app.demoBanner')}
                </Typography.Text>
                <Tag color="gold" style={{ fontSize: 10, margin: 0 }}>{t('shell.demoScenarioTag')}</Tag>
              </Space>
              <Space size={4}>
                <Button
                  size="small"
                  type="text"
                  icon={<HistoryOutlined />}
                  onClick={simulateAccountGoalCarryOver}
                >
                  {t('app.simulateMonthEnd')}
                </Button>
                <Popconfirm
                  title={t('app.resetMockTitle')}
                  description={t('app.resetMockDesc')}
                  okText={t('app.resetMockConfirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={resetMockPersistence}
                >
                  <Button size="small" type="text" icon={<ReloadOutlined />}>
                    {t('app.resetMock')}
                  </Button>
                </Popconfirm>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={exitDemo} className="demo-banner-exit">
                  {t('app.exitDemo')}
                </Button>
              </Space>
            </div>
          )}
          <Outlet />
        </Content>
      </Layout>
      <OnboardingTour />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </Layout>
  );
}
