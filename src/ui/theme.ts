import { theme, type ThemeConfig } from 'antd';

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

/** Status colours shared by tags and dots */
export const STATE_COLORS: Record<string, string> = {
  RUNNING: 'processing',
  PAUSED: 'warning',
  FINISHED: 'success',
  FAILED: 'error',
  IDLE: 'default',
  UNKNOWN: 'default',
};
