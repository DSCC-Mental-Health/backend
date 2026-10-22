'use strict';

const { forbidden } = require('../lib/errors');

// Allows only enrolled recruits (users with a company_recruits row).
// Must run after authenticate.
function requireRecruit(req, res, next) {
  const role = req.auth && req.auth.role;
  if (role === 'recruit') return next();
  if (role === 'commander') {
    throw forbidden('RECRUITS_ONLY', 'This endpoint is for recruit accounts.');
  }
  throw forbidden('NOT_ENROLLED', "Your account isn't linked to a company yet. Ask your commander to add you.");
}

module.exports = { requireRecruit };
