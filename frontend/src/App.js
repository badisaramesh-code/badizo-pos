import React, { useEffect, useState } from 'react';
import BarcodeStickersView from './components/BarcodeStickersView';
import BillingTerminalView from './components/BillingTerminalView';
import BooksView from './components/BooksView';
import CounterClosingView from './components/CounterClosingView';
import DashboardView from './components/DashboardView';
import InwardEntryView from './components/InwardEntryView';
import InventoryDashboardView from './components/InventoryDashboardView';
import LoginView from './components/LoginView';
import OrdersView from './components/OrdersView';
import PriceListView from './components/PriceListView';
import ProductImportHistoryView from './components/ProductImportHistoryView';
import ReportsView from './components/ReportsView';
import SystemView from './components/SystemView';
import { clearAuthSession, getStoredUser } from './api/client';
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

  if (!currentUser) {
    return <LoginView onLogin={setCurrentUser} />;
  }

  const allowedTabs = APP_TABS.filter((tab) => canAccessTab(tab, currentUser));
  const visibleTabs = allowedTabs.filter((tab) => !tab.hidden);
  const openWorkspaceFromTopNav = (workspaceKey) => {
    setActiveWorkspace(workspaceKey);
    setWorkspaceNavigationKey((current) => current + 1);
  };

  const views = {
    dashboard: <DashboardView setActiveWorkspace={setActiveWorkspace} />,
    billing: <BillingTerminalView isActive={activeWorkspace === 'billing'} />,
    closing: <CounterClosingView />,
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
    reports: <ReportsView isActive={activeWorkspace === 'reports'} onClose={() => setActiveWorkspace('billing')} />,
    books: <BooksView />,
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
            className="tab-button"
            onClick={() => {
              clearAuthSession();
              setCurrentUser(null);
            }}
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
