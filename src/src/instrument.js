// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");

// Never send bearer tokens, cookies or request bodies (which can contain
// handoff reasons or journal text) to Sentry.
function scrubRequest(event) {
  if (event && event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (/^(authorization|cookie|x-api-key|apikey)$/i.test(name)) delete event.request.headers[name];
      }
    }
  }
  return event;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN || "https://af895d3d5d7b981fae24ddc95bb6d70d@o4507685694210048.ingest.us.sentry.io/4511953439948800",
  // Tests must not report to the real Sentry project.
  enabled: process.env.NODE_ENV !== "test",
  sendDefaultPii: false,
  beforeSend: scrubRequest,
  beforeSendTransaction: scrubRequest,
  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#dataCollection
    // userInfo: false,
    // httpBodies: [],
  },
});

module.exports = { scrubRequest };
