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
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired login.' });
  }
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
