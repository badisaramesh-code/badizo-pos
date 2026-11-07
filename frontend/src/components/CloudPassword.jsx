import React, { useRef, useState } from 'react';
import api from '../api/client';

export default function CloudPassword({ username }) {
  const dialog = useRef(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { current, next, confirmation } = form.elements;
    if (next.value !== confirmation.value) return setMessage('The new passwords do not match.');
    setBusy(true);
    setMessage('');
    try {
      await api.post('/auth/change-password', { currentPassword: current.value, newPassword: next.value });
      form.reset();
      setMessage('Password changed. Use the new password next time you sign in.');
    } catch (error) {
      setMessage(error.response?.data?.error || 'Could not confirm the change. Check your connection.');
    } finally {
      setBusy(false);
    }
  }
  return <>
    <button className="tab-button" onClick={() => { setMessage(''); dialog.current.showModal(); }}>Change password</button>
    <dialog ref={dialog} aria-labelledby="cloud-password-title" onClose={() => dialog.current.querySelector('form').reset()}
      onCancel={event => { if (busy) event.preventDefault(); }}>
      <h2 id="cloud-password-title">Change cloud password</h2>
      <p>Cloud account: <strong>{username}</strong></p>
      <form onSubmit={save} style={{ display: 'grid', gap: 12 }}>
        <label>Current password <input name="current" type="password" autoComplete="current-password" required /></label>
        <label>New password <input name="next" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        <label>Confirm new password <input name="confirmation" type="password" autoComplete="new-password" required /></label>
        <span role="status">{message}</span>
        <button disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        <button type="button" disabled={busy} onClick={() => dialog.current.close()}>Close</button>
      </form>
    </dialog>
  </>;
}
