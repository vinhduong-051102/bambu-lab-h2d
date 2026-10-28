import { theme, type ConfigProviderProps, type ThemeConfig } from 'antd';

/** The dashboard's dark theme: the blue accent and the fonts the gateway has always used */
export const dashboardTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorInfo: '#3b82f6',
    colorBgBase: '#07090e',
    colorBgContainer: '#121826',
    colorBgElevated: '#182033',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',
    fontFamily: "'Outfit', sans-serif",
    fontFamilyCode: "'JetBrains Mono', monospace",
    borderRadius: 8,
    borderRadiusLG: 14,
  },
  components: {
    Card: { headerFontSize: 15 },
    Layout: { bodyBg: 'transparent', headerBg: 'transparent', footerBg: 'transparent' },
  },
};

/**
 * Every modal at most as tall as the window (antd's default 100 px from the top, room below): the title and buttons
 * stay put and only the body scrolls, without scrolling the page behind when it reaches its end
 */
export const dashboardModal: ConfigProviderProps['modal'] = {
  styles: {
    container: { display: 'flex', flexDirection: 'column', maxHeight: 'calc(100dvh - 140px)' },
    // The scrollbar sits by the modal's edge (into the container's 24 px padding) rather than against the content
    body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', marginRight: -16, paddingRight: 16 },
  },
};

/** Status colours shared by tags and dots */
export const STATE_COLORS: Record<string, string> = {
  RUNNING: 'processing',
  PAUSED: 'warning',
  FINISHED: 'success',
  FAILED: 'error',
  IDLE: 'default',
  UNKNOWN: 'default',
};
