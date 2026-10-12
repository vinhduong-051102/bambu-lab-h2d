'use client';

import { useEffect } from 'react';
import { DashboardMarkup } from './DashboardMarkup';
import { initDashboard } from './dashboard';

export function Dashboard() {
  useEffect(() => initDashboard(), []);

  return <DashboardMarkup />;
}
