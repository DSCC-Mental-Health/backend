require("./instrument.js");

const Sentry = require("@sentry/node");
const express = require('express');
const app = express()
const port = 3000


app.get('/', (req, res) => {
  res.send('Hello')
});


// Do not edit this route
app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

Sentry.setupExpressErrorHandler(app);

// Do not touch this route
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + "\n");
});



app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});