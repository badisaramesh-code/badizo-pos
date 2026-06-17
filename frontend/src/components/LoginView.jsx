import React, { useState } from 'react';
import { login } from '../api/client';

const LOGIN_ROLES = [
  { label: 'Server', username: 'server' },
  { label: 'Admin', username: 'admin' },
  { label: 'Counter 1', username: 'counter1' }
];

export default function LoginView({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

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
            {LOGIN_ROLES.map((role) => (
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
          Select a role and enter its password.
        </div>
      </form>
    </div>
  );
}
