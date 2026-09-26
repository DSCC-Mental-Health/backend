require("./instrument.js");

const Sentry = require("@sentry/node");
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3000;

// -----------------------------------------------------
// Supabase client
// -----------------------------------------------------
// Use the ANON key here (safe for auth calls made on behalf of a user).
// Keep these in a .env file — never hardcode or commit them.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

// -----------------------------------------------------
// Basic route
// -----------------------------------------------------
app.get('/', (req, res) => {
  res.send('Hello')
});

// Do not edit this route
app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

// -----------------------------------------------------
// SIGN UP route
// -----------------------------------------------------
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  })

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  return res.status(200).json({
    message: 'Signup successful. Check your email to confirm your account.',
    user: data.user,
  })
})

// -----------------------------------------------------
// LOG IN route
// -----------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    // Supabase deliberately doesn't say whether it was the email or
    // password that was wrong — that's a security best practice, so
    // don't try to split this error into more specific messages.
    return res.status(401).json({ error: error.message })
  }

  return res.status(200).json({
    message: 'Login successful.',
    session: data.session, // contains access_token + refresh_token
    user: data.user,
  })
})

// -----------------------------------------------------
// LOG OUT route
// -----------------------------------------------------
app.post('/api/logout', async (req, res) => {
  const { error } = await supabase.auth.signOut()

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  return res.status(200).json({ message: 'Logged out successfully.' })
})

// -----------------------------------------------------
// REFRESH SESSION route
// -----------------------------------------------------
// The frontend calls this with the refresh_token it got from /api/login
// whenever the access_token has expired (or a protected route returns 401).
app.post('/api/refresh', async (req, res) => {
  const { refresh_token } = req.body

  if (!refresh_token) {
    return res.status(400).json({ error: 'Refresh token is required.' })
  }

  const { data, error } = await supabase.auth.refreshSession({ refresh_token })

  if (error) {
    // Refresh token is invalid, expired, or already used — user must log in again.
    return res.status(401).json({ error: error.message })
  }

  return res.status(200).json({
    message: 'Session refreshed.',
    session: data.session, // new access_token + refresh_token
    user: data.user,
  })
})

// -----------------------------------------------------
// Protected route example
// -----------------------------------------------------
// The frontend sends the access_token it got from /api/login
// in the Authorization header: "Bearer <access_token>"
app.get('/api/profile', async (req, res) => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' })
  }

  const token = authHeader.split(' ')[1]

  // Validate the token and get the user it belongs to
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token.' })
  }

  return res.status(200).json({
    message: 'This is protected data.',
    user,
  })
})

Sentry.setupExpressErrorHandler(app);

// Do not touch this route
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + "\n");
});

// -----------------------------------------------------
// Start server (single listen call)
// -----------------------------------------------------
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});
