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
import LocalAccountsWorkspace from './components/LocalAccountsWorkspace';
import { PaymentDiaryReminder } from './components/PaymentDiaryView';
import OrdersView from './components/OrdersView';
import PriceListView from './components/PriceListView';
import ProductImportHistoryView from './components/ProductImportHistoryView';
import ReportsView from './components/ReportsView';
import StaffPayrollView from './components/StaffPayrollView';
import SystemView from './components/SystemView';
import CloudPassword from './components/CloudPassword';
import CloudStatusBanner from './components/CloudStatusBanner';
import api, { clearAuthSession, fetchBackupHealth, getStoredUser, logout as recordLogout, pingBackendHealth, recordLogoutOnExit } from './api/client';
import { backupAlerts, acknowledgedBackupAlerts, acknowledgeBackupAlert, backupHealthUnavailable } from './utils/backupHealth';
import { APP_TABS, canAccessTab } from './config/navigation';
import './styles.css';
import ReportApprovalNotifications from './components/ReportApprovalNotifications';

function currentSessionLabel(user) {
  if (!user) return '';
  const role = String(user.role || '').toUpperCase();
  const counterNo = Number(user.counter_no || 0);
  const systemNo = Number(user.system_no || 0);
  if (role === 'COUNTER' && counterNo > 0) {
    return systemNo > 0 ? `S${systemNo}/Counter${counterNo}` : `Counter${counterNo}`;
  }
  return user.username || role || 'User';
}

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('billing');
  const [workspaceNavigationKey, setWorkspaceNavigationKey] = useState(0);
  const [productFormNavigationKey, setProductFormNavigationKey] = useState(0);
  const [mountedWorkspaces, setMountedWorkspaces] = useState(() => new Set(['billing']));
  const [billingState, setBillingState] = useState(process.env.REACT_APP_BADIZO_CLOUD_BUILD === 'true' ? {server:'Cloud',mode:'unknown'} : null);
  const billingPaused = billingState && billingState.mode !== 'active';
  const [currentUser, setCurrentUser] = useState(getStoredUser);
  const [backupAlert, setBackupAlert] = useState(null);
  const [openPaymentDiary,setOpenPaymentDiary]=useState(false);
  useEffect(() => {
    const changed = () => setCurrentUser(null);
    window.addEventListener('badizo-recovery-session-changed', changed);
    return () => window.removeEventListener('badizo-recovery-session-changed', changed);
  }, []);

  const [usageEnabled,setUsageEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    setUsageEnabled(false);
    if (currentUser) api.get('/system-health/usage-enabled').then(({data})=>{
      if (active) setUsageEnabled(data.enabled === true);
    }).catch(()=>{});
    return () => { active=false; };
  }, [currentUser]);
  useEffect(() => {
    if (usageEnabled && currentUser && APP_TABS.some(tab => tab.key === activeWorkspace && canAccessTab(tab,currentUser))) {
      api.post('/system-health/workspace-open',{area:activeWorkspace}).catch(()=>{});
    }
  }, [activeWorkspace,currentUser,usageEnabled]);

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
        const ok = await pingBackendHealth(2000, { onBillingState: setBillingState });
        if (!ok) setBillingState(previous => previous && { ...previous, mode: 'unknown' });
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

  useEffect(() => {
    if (!currentUser) return undefined;
    const keepServerConnectionWarm = () => {
      pingBackendHealth(1500).catch(() => false);
    };
    keepServerConnectionWarm();
    const timer = window.setInterval(keepServerConnectionWarm, 60000);
    window.addEventListener('online', keepServerConnectionWarm);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', keepServerConnectionWarm);
    };
  }, [currentUser]);


  useEffect(() => {
    if (!currentUser) return undefined;
    let cancelled = false;
    if (process.env.REACT_APP_BADIZO_CLOUD_BUILD === 'true') return undefined;
    const checkBackupHealth = async () => {
      try {
        const health = await fetchBackupHealth();
        if (cancelled) return;
        const acknowledged = acknowledgedBackupAlerts(window.localStorage);
        setBackupAlert(backupAlerts(health).find(alert => !acknowledged.includes(alert.alertId)) || null);
      } catch (_err) {
        if (cancelled) return;
        const alert = backupHealthUnavailable();
        setBackupAlert(acknowledgedBackupAlerts(window.localStorage).includes(alert.alertId) ? null : alert);
      }
    };
    const initialTimer = window.setTimeout(checkBackupHealth, 15 * 1000);
    const timer = window.setInterval(checkBackupHealth, 60 * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
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

  const handleLogout = () => {
    recordLogout().catch(() => {
      // The server audit is best-effort; local logout is immediate.
    });
    clearAuthSession();
    setCurrentUser(null);
  };
  const sessionLabel = currentSessionLabel(currentUser);

  const views = {
    dashboard: <DashboardView setActiveWorkspace={setActiveWorkspace} />,
    billing: <BillingTerminalView isActive={activeWorkspace === 'billing' && !billingPaused} />,
    closing: <CounterClosingView onClose={() => setActiveWorkspace('billing')} />,
    cashLedger: <CounterCashLedgerView />,
    gatePass: <GatePassView />,
    inventory: (
      <InventoryDashboardView
        isActive={activeWorkspace === 'inventory'}
        navigationKey={workspaceNavigationKey}
        productFormNavigationKey={productFormNavigationKey}
        setActiveWorkspace={setActiveWorkspace}
      />
    ),
    importHistory: <ProductImportHistoryView onClose={() => setActiveWorkspace('inventory')} />,
    orders: <OrdersView />,
    priceList: <PriceListView />,
    barcode: <BarcodeStickersView key={`${currentUser.role}:${currentUser.username}`} printerProfile={`${currentUser.role}:${currentUser.username}`} useServerPrinter={currentUser?.role === 'SERVER'} isActive={activeWorkspace === 'barcode'} onBackToProductForm={() => {
      setProductFormNavigationKey((current) => current + 1);
      setActiveWorkspace('inventory');
    }} />,
    inward: <InwardEntryView />,
    staffPayroll: <StaffPayrollView />,
    reports: <ReportsView isActive={activeWorkspace === 'reports'} onClose={() => setActiveWorkspace('billing')} />,
    books: <BooksView setActiveWorkspace={setActiveWorkspace} />,
    localAccounts: <LocalAccountsWorkspace isActive={activeWorkspace==='localAccounts'} openDiary={openPaymentDiary} onDiaryOpened={()=>setOpenPaymentDiary(false)}/>,
    system: <SystemView />
  };

  return (
    <div className="app-shell">
      <ReportApprovalNotifications currentUser={currentUser} />
      <PaymentDiaryReminder user={currentUser} onOpenDiary={()=>{setOpenPaymentDiary(true);setActiveWorkspace('localAccounts');}}/>
      {backupAlert && (
        <div className="backup-alert-toast-wrap" role="alert" aria-live="assertive">
          <div className={`backup-alert-modal ${backupAlert.status === 'success' ? 'backup-alert-success' : ''}`}>
            <button className="backup-alert-close" type="button" aria-label="Close backup notification" onClick={() => {
              acknowledgeBackupAlert(window.localStorage, backupAlert.alertId);
              setBackupAlert(null);
            }}>×</button>
            <h2>{backupAlert.title}</h2>
            <p>{backupAlert.description}</p>
            <p className="backup-alert-detail">{backupAlert.message}</p>
            {backupAlert.file && <p className="backup-alert-time">File: {backupAlert.file}</p>}
            {backupAlert.at && <p className="backup-alert-time">Checked: {new Date(backupAlert.at).toLocaleString()}</p>}
            <button type="button" onClick={() => {
              acknowledgeBackupAlert(window.localStorage, backupAlert.alertId);
              setBackupAlert(null);
            }}>{backupAlert.status === 'success' ? 'OK' : 'OK — Inform Admin'}</button>
          </div>
        </div>
      )}      <header className="topbar">
        <div className="brand-wrap">
          <img className="brand-image" src="/badizo-logo-transparent.png" alt="Badizo" />
          <span className="brand-pulse-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>

        <nav className="nav-tabs" aria-label="Workspace">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab-button ${tab.key === 'localAccounts' ? 'local-accounts-tab' : ''} ${activeWorkspace === tab.key ? 'active' : ''}`}
              onClick={() => openWorkspaceFromTopNav(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          {process.env.REACT_APP_BADIZO_CLOUD_BUILD === 'true' && <CloudPassword username={currentUser.username} />}
          {currentUser.role === 'COUNTER' && (
            <button
              className="tab-button"
              onClick={handleLogout}
              title="Logout and select another counter for this system"
            >
              Change Counter ({sessionLabel})
            </button>
          )}
          <button
            className="tab-button logout-button"
            onClick={handleLogout}
          >
            Logout ({sessionLabel})
          </button>
        </nav>
      </header>

      <>{billingState ? (billingPaused
        ? <div className="alert-box" role="alert"><strong>{billingState.server} billing {billingState.mode === 'unknown' ? 'status is unconfirmed' : 'is paused'}.</strong> Do not start a bill here. Use the counter the owner has confirmed is active. Only the owner can switch billing in System.</div>
        : <div role="status">{billingState.server} billing is active on this server.</div>) : <CloudStatusBanner />}</>
      <main className="workspace">
        {allowedTabs.map((tab) => (
          mountedWorkspaces.has(tab.key) ? (
            <section
              key={tab.key}
              className="workspace-screen"
              hidden={activeWorkspace !== tab.key}
            >
              {tab.key === 'billing' ? <div className="billing-guard-container">
                <div inert={billingPaused ? '' : undefined}>{views.billing}</div>
                {billingPaused && <div className="billing-guard-overlay"><div role="alertdialog" aria-labelledby="billing-guard-title" aria-describedby="billing-guard-message" className="billing-guard-notice">
                  <h2 id="billing-guard-title">{billingState.server} billing {billingState.mode === 'unknown' ? 'status is unconfirmed' : 'is paused'}</h2>
                  <p id="billing-guard-message">This counter cannot save a sale here. If the owner has confirmed {billingState.server === 'Local' ? 'cloud' : 'local'} billing is active, use that server. Otherwise wait for the owner to check the switch in System.</p>
                </div></div>}
              </div> : views[tab.key]}
            </section>
          ) : null
        ))}
      </main>
    </div>
  );
}
