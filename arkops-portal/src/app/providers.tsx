import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { AuthProvider } from './auth';
import { DemoModeProvider } from './demoMode';
import { I18nProvider } from './i18n';
import { StoreScopeProvider } from './storeScope';
import { ThemeProvider, useTheme } from './theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false
    }
  }
});

// U5.2 动效克制：系统「减少动态效果」在 antd 一侧也要生效（弹层、抽屉、折叠、进度条都走 motion token）。
// 自定义动效由 global.css 的同名媒体查询兜底，两条线共用同一个偏好，不再各自判断。
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches
  );

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function AntDesignThemeProvider({ children }: PropsWithChildren) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const prefersReducedMotion = usePrefersReducedMotion();

  // 强调色在 antd 里一色两用：填充（按钮底、勾选框底，白字/白勾必须可读）与内容（选中页签文字、
  // 分页当前页、链接）。tokens.css 的 --ark-blue 暗色是 #60a5fa，只适合当内容色；
  // colorPrimary 继续做填充色（#2563eb 白字 4.8:1），内容色在暗色下单独对齐 --ark-blue，
  // 否则暗色选中页签/当前页仍是 #2563eb，压在 #111827 卡片上只有 2.78:1。
  // 亮色不动：antd 默认派生已经是 #2563eb 系，只在暗色下补这组覆盖。
  const darkContentAccent = isDark
    ? { primary: '#60a5fa', hover: '#93c5fd', active: '#bfdbfe' }
    : undefined;

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#2563eb',
          borderRadius: 8,
          motion: !prefersReducedMotion,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          colorBgBase: isDark ? '#0f172a' : '#ffffff',
          colorBgContainer: isDark ? '#111827' : '#ffffff',
          colorBorder: isDark ? '#253247' : '#dbe3ef',
          colorText: isDark ? '#e5eefc' : '#172033',
          colorTextSecondary: isDark ? '#94a3b8' : '#5b6b84',
          // antd 的 focus-visible 环取 colorPrimaryBorder（genFocusOutline）。
          // 默认派生值 #a3c9ff 在白底只有 1.7:1，键盘聚焦基本看不见；这里对齐 tokens.css 的 --ark-focus-ring。
          colorPrimaryBorder: isDark ? '#93c5fd' : '#1d4ed8',
          // 链接同属「强调色当内容用」，暗色下对齐 --ark-blue / --ark-focus-ring。
          ...(darkContentAccent
            ? {
                colorLink: darkContentAccent.primary,
                colorLinkHover: darkContentAccent.hover,
                colorLinkActive: darkContentAccent.active
              }
            : {})
        },
        components: {
          Card: { borderRadiusLG: 8 },
          Button: { borderRadius: 8 },
          Table: { headerBg: isDark ? '#162033' : '#f8fafc' },
          Layout: {
            bodyBg: isDark ? '#0b1120' : '#f5f7fb',
            headerBg: isDark ? '#111827' : '#ffffff',
            siderBg: isDark ? '#111827' : '#ffffff'
          },
          Menu: {
            itemSelectedBg: isDark ? '#1e3a8a' : '#eff6ff',
            itemSelectedColor: isDark ? '#bfdbfe' : '#2563eb'
          },
          // 选中页签文字 / 下划线 / 分页当前页都是「强调色当文字」，暗色下必须是 --ark-blue，不能是填充色。
          ...(darkContentAccent
            ? {
                Tabs: {
                  itemSelectedColor: darkContentAccent.primary,
                  itemHoverColor: darkContentAccent.hover,
                  inkBarColor: darkContentAccent.primary
                },
                Pagination: {
                  itemActiveColor: darkContentAccent.primary,
                  itemActiveColorHover: darkContentAccent.hover
                }
              }
            : {})
        }
      }}
    >
      {children}
    </ConfigProvider>
  );
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <AuthProvider>
      <DemoModeProvider>
        <ThemeProvider>
          <AntDesignThemeProvider>
            <I18nProvider>
              <QueryClientProvider client={queryClient}>
                <StoreScopeProvider>{children}</StoreScopeProvider>
              </QueryClientProvider>
            </I18nProvider>
          </AntDesignThemeProvider>
        </ThemeProvider>
      </DemoModeProvider>
    </AuthProvider>
  );
}
