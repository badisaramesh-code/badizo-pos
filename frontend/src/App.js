import React, { useEffect, useState } from 'react';
import BarcodeStickersView from './components/BarcodeStickersView';
import BillingTerminalView from './components/BillingTerminalView';
import BooksView from './components/BooksView';
import CounterCashLedgerView from './components/CounterCashLedgerView';
import CounterClosingView from './components/CounterClosingView';
import DashboardView from './components/DashboardView';
import GatePassView from './components/GatePassView';
import InwardEntryView from './components/InwardEntryView';
import InventoryDashboardView from './components/InventoryDashboardView';
import LoginView from './components/LoginView';
import OrdersView from './components/OrdersView';
import PriceListView from './components/PriceListView';
import ProductImportHistoryView from './components/ProductImportHistoryView';
import ReportsView from './components/ReportsView';
import StaffPayrollView from './components/StaffPayrollView';
import SystemView from './components/SystemView';
import { clearAuthSession, getStoredUser, logout as recordLogout, pingBackendHealth, recordLogoutOnExit } from './api/client';
import { APP_TABS, canAccessTab } from './config/navigation';
import './styles.css';

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('billing');
  const [workspaceNavigationKey, setWorkspaceNavigationKey] = useState(0);
  const [mountedWorkspaces, setMountedWorkspaces] = useState(() => new Set(['billing']));
  const [currentUser, setCurrentUser] = useState(getStoredUser);

  useEffect(() => {
    setMountedWorkspaces((current) => {
      if (current.has(activeWorkspace)) return current;
      const next = new Set(current);
      next.add(activeWorkspace);
      return next;
    });
  }, [activeWorkspace]);

  useEffect(() => {
    if (!currentUser) return;
    const allowedTabs = APP_TABS.filter((tab) => canAccessTab(tab, currentUser));
    if (allowedTabs.some((tab) => tab.key === activeWorkspace) || !allowedTabs[0]) return;
    setActiveWorkspace(allowedTabs[0].key);
  }, [activeWorkspace, currentUser]);

  useEffect(() => {
    if (!currentUser) return undefined;

    let pingInFlight = false;
    const keepLanSessionWarm = async () => {
      if (document.visibilityState === 'hidden' || pingInFlight) return;
      pingInFlight = true;
      try {
        await pingBackendHealth(2000);
      } finally {
        pingInFlight = false;
      }
    };

    keepLanSessionWarm();
    const heartbeatTimer = window.setInterval(keepLanSessionWarm, 10000);
    window.addEventListener('focus', keepLanSessionWarm);
    document.addEventListener('visibilitychange', keepLanSessionWarm);

    return () => {
      window.clearInterval(heartbeatTimer);
      window.removeEventListener('focus', keepLanSessionWarm);
      document.removeEventListener('visibilitychange', keepLanSessionWarm);
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return undefined;

    const handlePageExit = () => {
      recordLogoutOnExit();
    };

    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);

    return () => {
      window.removeEventListener('pagehide', handlePageExit);
      window.removeEventListener('beforeunload', handlePageExit);
    };
  }, [currentUser]);

  if (!currentUser) {
    return <LoginView onLogin={setCurrentUser} />;
  }

  const allowedTabs = APP_TABS.filter((tab) => canAccessTab(tab, currentUser));
  const visibleTabs = allowedTabs.filter((tab) => !tab.hidden);
  const openWorkspaceFromTopNav = (workspaceKey) => {
    setActiveWorkspace(workspaceKey);
    setWorkspaceNavigationKey((current) => current + 1);
  };

  const handleLogout = async () => {
    try {
      await recordLogout();
    } catch (err) {
      // Local logout must still work if the server is temporarily unreachable.
    } finally {
      clearAuthSession();
      setCurrentUser(null);
    }
  };

  const views = {
    dashboard: <DashboardView setActiveWorkspace={setActiveWorkspace} />,
    billing: <BillingTerminalView isActive={activeWorkspace === 'billing'} />,
    closing: <CounterClosingView />,
    cashLedger: <CounterCashLedgerView />,
    gatePass: <GatePassView />,
    inventory: (
      <InventoryDashboardView
        isActive={activeWorkspace === 'inventory'}
        navigationKey={workspaceNavigationKey}
        setActiveWorkspace={setActiveWorkspace}
      />
    ),
    importHistory: <ProductImportHistoryView onClose={() => setActiveWorkspace('inventory')} />,
    orders: <OrdersView />,
    priceList: <PriceListView />,
    barcode: <BarcodeStickersView />,
    inward: <InwardEntryView />,
    staffPayroll: <StaffPayrollView />,
    reports: <ReportsView isActive={activeWorkspace === 'reports'} onClose={() => setActiveWorkspace('billing')} />,
    books: <BooksView setActiveWorkspace={setActiveWorkspace} />,
    system: <SystemView />
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <img className="brand-image" src="/badizo-logo-transparent.png" alt="Badizo" />
        </div>

        <nav className="nav-tabs" aria-label="Workspace">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab-button ${activeWorkspace === tab.key ? 'active' : ''}`}
              onClick={() => openWorkspaceFromTopNav(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <button
            className="tab-button logout-button"
            onClick={handleLogout}
          >
            Logout ({currentUser.username})
          </button>
        </nav>
      </header>

      <main className="workspace">
        {allowedTabs.map((tab) => (
          mountedWorkspaces.has(tab.key) ? (
            <section
              key={tab.key}
              className="workspace-screen"
              hidden={activeWorkspace !== tab.key}
            >
              {views[tab.key]}
            </section>
          ) : null
        ))}
      </main>
    </div>
  );
}
