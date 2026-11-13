const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'badizo-pos-dev-secret-change-me';

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Login required.' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired login.' });
  }
  try {
    const activation = require('../services/recoverySessionScope').currentRecoveryActivation();
    if (activation && req.user.recovery_activation_id !== activation) return res.status(401).json({
      code: 'RECOVERY_SESSION_CHANGED', error: 'The database was recovered. Sign in again; old pending bills are retained for review.' });
  } catch { return res.status(503).json({ error: 'Recovery authority cannot be verified. Billing remains unavailable.' }); }
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied.' });
    }
    next();
  };
}

module.exports = {
  JWT_SECRET,
  authenticate,
  authorize
};
