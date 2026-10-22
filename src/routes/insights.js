'use strict';

const express = require('express');

function insightsRoutes({ authenticate, requireRecruit, insights }) {
  const router = express.Router();

  // Register the static sub-path before anything dynamic.
  router.get('/insights/patterns', authenticate, requireRecruit, async (req, res) => {
    res.json(await insights.getPatterns(req.db));
  });

  router.get('/insights', authenticate, requireRecruit, async (req, res) => {
    res.json(await insights.getInsights(req.db, req.auth.userId));
  });

  return router;
}

module.exports = { insightsRoutes };
