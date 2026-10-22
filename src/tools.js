'use strict';

const express = require('express');

function toolsRoutes({ authenticate, requireRecruit, tools }) {
  const router = express.Router();

  router.get('/tools', authenticate, requireRecruit, async (req, res) => {
    res.json(await tools.list(req.db));
  });

  router.get('/tools/:slug', authenticate, requireRecruit, async (req, res) => {
    res.json(await tools.get(req.db, req.params.slug));
  });

  router.post('/tools/:slug/sessions', authenticate, requireRecruit, async (req, res) => {
    res.status(201).json(await tools.logSession(req.db, req.auth.userId, req.params.slug, req.body));
  });

  return router;
}

module.exports = { toolsRoutes };
