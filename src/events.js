'use strict';

const express = require('express');

function eventsRoutes({ authenticate, requireRecruit, events }) {
  const router = express.Router();

  // Registered BEFORE /events so "upcoming" can never be read as a parameter
  // if a dynamic /events/:id route is added later.
  router.get('/events/upcoming', authenticate, requireRecruit, async (req, res) => {
    res.json(await events.listUpcoming(req));
  });

  // Any signed-in user. Commanders pass ?companyId= (see eventsService).
  router.get('/events', authenticate, async (req, res) => {
    res.json(await events.listAll(req));
  });

  return router;
}

module.exports = { eventsRoutes };
