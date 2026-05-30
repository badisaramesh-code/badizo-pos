import React, { useState } from 'react';
import { login } from '../api/client';

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
        <div className="brand-logo" style={{ margin: '0 auto 12px' }}>B</div>
        <h1 className="brand-title" style={{ color: 'var(--brand-dark)', textAlign: 'center' }}>BADIZO POS</h1>
        <p className="muted" style={{ textAlign: 'center' }}>Login to continue billing</p>

        {errorMessage && <div className="alert-box">{errorMessage}</div>}

        <label>
          <span className="field-label">Username</span>
          <input className="field" value={username} onChange={(event) => setUsername(event.target.value)} autoFocus />
        </label>

        <label>
          <span className="field-label">Password</span>
          <input className="field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>

        <button className="primary-button" type="submit" disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Login'}
        </button>

        <div className="change-box">
          Default test users: admin/admin123, counter1/counter123, server/server123
        </div>
      </form>
    </div>
  );
}
