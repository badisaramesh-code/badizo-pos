import React, { useState } from 'react';
import BarcodeStickersView from './components/BarcodeStickersView';
import BillingTerminalView from './components/BillingTerminalView';
import BooksView from './components/BooksView';
import DashboardView from './components/DashboardView';
import InwardEntryView from './components/InwardEntryView';
import InventoryDashboardView from './components/InventoryDashboardView';
import LoginView from './components/LoginView';
import ReportsView from './components/ReportsView';
import SystemView from './components/SystemView';
import { clearAuthSession, getStoredUser } from './api/client';
import './styles.css';

const tabs = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'billing', label: 'Billing (POS)' },
  { key: 'inventory', label: 'Products' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'inward', label: 'Inward' },
  { key: 'reports', label: 'Reports' },
  { key: 'books', label: 'Books' },
  { key: 'system', label: 'System' }
];

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('billing');
  const [currentUser, setCurrentUser] = useState(getStoredUser);

  if (!currentUser) {
    return <LoginView onLogin={setCurrentUser} />;
  }

  const allowedTabs = tabs.filter((tab) => {
    if (currentUser.role === 'COUNTER') {
      return ['billing', 'inventory'].includes(tab.key);
    }
    return true;
  });

  const views = {
    dashboard: <DashboardView setActiveWorkspace={setActiveWorkspace} />,
    billing: <BillingTerminalView />,
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
          <div className="brand-logo">B</div>
          <div>
            <h1 className="brand-title">BADIZO</h1>
            <div className="brand-subtitle">POS System</div>
          </div>
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
