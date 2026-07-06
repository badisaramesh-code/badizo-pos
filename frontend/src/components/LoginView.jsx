import React, { useEffect, useMemo, useState } from 'react';
import { fetchLoginOptions, login } from '../api/client';

const FALLBACK_LOGIN_OPTIONS = [
  { label: 'Server', username: 'server' },
  { label: 'Admin 1', username: 'admin1' },
  { label: 'Admin 2', username: 'admin2' },
  { label: 'Counter 1', username: 'counter1' },
  { label: 'Counter 2', username: 'counter2' },
  { label: 'Counter 3', username: 'counter3' },
  { label: 'Counter 4', username: 'counter4' },
  { label: 'Counter 5', username: 'counter5' },
  { label: 'Counter 6', username: 'counter6' },
  { label: 'Security 1', username: 'security1' },
  { label: 'Security 2', username: 'security2' }
];

function loginModeFromUrl() {
  const params = new URLSearchParams(window.location.search || '');
  const mode = String(params.get('loginMode') || params.get('login') || params.get('mode') || '').trim().toLowerCase();
  return ['server', 'admin', 'counter', 'security', 'all'].includes(mode) ? mode : 'all';
}

function filterLoginOptions(options, mode) {
  if (mode === 'counter') {
    return options.filter((option) => option.role === 'COUNTER' || /^counter[1-6]$/i.test(option.username));
  }
  if (mode === 'admin') {
    return options.filter((option) => ['admin1', 'admin2'].includes(String(option.username || '').toLowerCase()));
  }
  if (mode === 'server') {
    return options.filter((option) => String(option.username || '').toLowerCase() === 'server');
  }
  if (mode === 'security') {
    return options.filter((option) => option.role === 'SECURITY' || /^security[12]$/i.test(option.username));
  }
  return options;
}

function mergeLoginOptions(options) {
  const merged = [...(Array.isArray(options) ? options : [])];
  FALLBACK_LOGIN_OPTIONS.forEach((fallback) => {
    if (!merged.some((option) => option.username === fallback.username)) {
      merged.push(fallback);
    }
  });
  return merged;
}

export default function LoginView({ onLogin }) {
  const loginMode = loginModeFromUrl();
  const isSecurityLogin = loginMode === 'security';
  const initialOptions = useMemo(() => filterLoginOptions(FALLBACK_LOGIN_OPTIONS, loginMode), [loginMode]);
  const [username, setUsername] = useState(initialOptions[0]?.username || 'admin1');
  const [personName, setPersonName] = useState('');
  const [password, setPassword] = useState(loginMode === 'counter' ? 'counter1' : loginMode === 'server' ? 'server123' : loginMode === 'security' ? 'admin123' : 'admin123');
  const [loginOptions, setLoginOptions] = useState(initialOptions.length ? initialOptions : FALLBACK_LOGIN_OPTIONS);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  function defaultPasswordForUsername(nextUsername) {
    const value = String(nextUsername || '').toLowerCase();
    if (/^counter([1-9]|10)$/.test(value)) return value;
    if (/^security[12]$/.test(value) || value === 'security') return 'admin123';
    if (value === 'server') return 'server123';
    if (value.startsWith('admin')) return 'admin123';
    return '';
  }

  useEffect(() => {
    let isMounted = true;

    async function loadLoginOptions() {
      try {
        const options = await fetchLoginOptions();
        if (!isMounted || options.length === 0) return;

        const mergedOptions = mergeLoginOptions(options);
        const filteredOptions = filterLoginOptions(mergedOptions, loginMode);
        const visibleOptions = filteredOptions.length ? filteredOptions : mergedOptions;
        setLoginOptions(visibleOptions);
        setUsername((currentUsername) => (
          visibleOptions.some((option) => option.username === currentUsername)
            ? currentUsername
            : visibleOptions[0].username
        ));
      } catch (err) {
        if (isMounted) {
          setLoginOptions(initialOptions.length ? initialOptions : FALLBACK_LOGIN_OPTIONS);
        }
      }
    }

    loadLoginOptions();
    return () => {
      isMounted = false;
    };
  }, [loginMode, initialOptions]);

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMessage('');
    if (!personName.trim()) {
      setErrorMessage('Person name is required.');
      return;
    }
    setIsLoading(true);

    try {
      const user = await login(username, password, personName);
      onLogin(user);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to login.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className={`login-screen ${isSecurityLogin ? 'security-login-screen' : ''}`}>
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-logo-wrap">
          <img className="login-brand-image" src="/badizo-logo-transparent.png" alt="Badizo" />
        </div>
        <h1 className="brand-title" style={{ color: 'var(--brand-dark)', textAlign: 'center' }}>{isSecurityLogin ? 'Gate Pass' : 'POS'}</h1>
        <p className="muted" style={{ textAlign: 'center' }}>
          {isSecurityLogin ? 'Security login for inward and outward stock' : 'Login to continue billing'}
        </p>

        {errorMessage && <div className="alert-box">{errorMessage}</div>}

        <label>
          <span className="field-label">Role</span>
          <select
            className="field"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setPassword(defaultPasswordForUsername(event.target.value));
            }}
            autoFocus
          >
            {loginOptions.map((role) => (
              <option key={role.username} value={role.username}>{role.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="field-label">Person Name</span>
          <input
            className="field"
            value={personName}
            onChange={(event) => setPersonName(event.target.value)}
            placeholder="Enter duty person name"
          />
        </label>

        <label>
          <span className="field-label">Password</span>
          <input className="field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>

        <button className="primary-button" type="submit" disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Login'}
        </button>

        {!isSecurityLogin && (
          <div className="change-box">
            Default passwords: Server server123, Admin admin123, Counters counter1 to counter6, Security admin123.
          </div>
        )}
      </form>
    </div>
  );
}
