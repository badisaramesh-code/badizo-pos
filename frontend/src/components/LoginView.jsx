import React, { useEffect, useState } from 'react';
import { fetchLoginOptions, login } from '../api/client';

const FALLBACK_LOGIN_OPTIONS = [
  { label: 'Server', username: 'server' },
  { label: 'Admin', username: 'admin' },
  { label: 'Counter 1', username: 'counter1' },
  { label: 'Counter 2', username: 'counter2' },
  { label: 'Counter 3', username: 'counter3' }
];

export default function LoginView({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loginOptions, setLoginOptions] = useState(FALLBACK_LOGIN_OPTIONS);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadLoginOptions() {
      try {
        const options = await fetchLoginOptions();
        if (!isMounted || options.length === 0) return;

        setLoginOptions(options);
        setUsername((currentUsername) => (
          options.some((option) => option.username === currentUsername)
            ? currentUsername
            : options[0].username
        ));
      } catch (err) {
        if (isMounted) {
          setLoginOptions(FALLBACK_LOGIN_OPTIONS);
        }
      }
    }

    loadLoginOptions();
    return () => {
      isMounted = false;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMessage('');
    setIsLoading(true);

    try {
      const user = await login(username, password);
      onLogin(user);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to login.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-logo-wrap">
          <img className="login-brand-image" src="/badizo-logo-transparent.png" alt="Badizo" />
        </div>
        <h1 className="brand-title" style={{ color: 'var(--brand-dark)', textAlign: 'center' }}>POS</h1>
        <p className="muted" style={{ textAlign: 'center' }}>Login to continue billing</p>

        {errorMessage && <div className="alert-box">{errorMessage}</div>}

        <label>
          <span className="field-label">Role</span>
          <select className="field" value={username} onChange={(event) => setUsername(event.target.value)} autoFocus>
            {loginOptions.map((role) => (
              <option key={role.username} value={role.username}>{role.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span className="field-label">Password</span>
          <input className="field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>

        <button className="primary-button" type="submit" disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Login'}
        </button>

        <div className="change-box">
          Default passwords: Server server123, Admin admin123, Counters counter123.
        </div>
      </form>
    </div>
  );
}
