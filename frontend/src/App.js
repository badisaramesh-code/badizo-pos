import React, { useState } from 'react';
import BarcodeStickersView from './components/BarcodeStickersView';
import BillingTerminalView from './components/BillingTerminalView';
import BooksView from './components/BooksView';
import CounterClosingView from './components/CounterClosingView';
import DashboardView from './components/DashboardView';
import InwardEntryView from './components/InwardEntryView';
import InventoryDashboardView from './components/InventoryDashboardView';
import LoginView from './components/LoginView';
import ReportsView from './components/ReportsView';
import SystemView from './components/SystemView';
import { clearAuthSession, getStoredUser } from './api/client';
import { APP_TABS, canAccessTab } from './config/navigation';
import './styles.css';

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('billing');
  const [currentUser, setCurrentUser] = useState(getStoredUser);

  if (!currentUser) {
    return <LoginView onLogin={setCurrentUser} />;
  }

  const allowedTabs = APP_TABS.filter((tab) => canAccessTab(tab, currentUser));

  const views = {
    dashboard: <DashboardView setActiveWorkspace={setActiveWorkspace} />,
    billing: <BillingTerminalView />,
    closing: <CounterClosingView />,
    inventory: <InventoryDashboardView />,
    barcode: <BarcodeStickersView />,
    inward: <InwardEntryView />,
    reports: <ReportsView />,
    books: <BooksView />,
    system: <SystemView />
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <img className="brand-image" src="/badizo-logo.jpg" alt="Badizo" />
        </div>

        <nav className="nav-tabs" aria-label="Workspace">
          {allowedTabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab-button ${activeWorkspace === tab.key ? 'active' : ''}`}
              onClick={() => setActiveWorkspace(tab.key)}
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
        {views[activeWorkspace]}
      </main>
    </div>
  );
}
