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
// server.js
// Backend API for a login system using Supabase Auth
// -----------------------------------------------------
// Install dependencies first:
//   npm init -y
//   npm install express @supabase/supabase-js dotenv cors

const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

// -----------------------------------------------------
// 1. Set up Supabase client
// -----------------------------------------------------
// Use the ANON key here (safe for auth calls made on behalf of a user).
// Keep these in a .env file — never hardcode or commit them.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

// -----------------------------------------------------
// 2. SIGN UP route
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
// 3. LOG IN route
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
// 4. LOG OUT route
// -----------------------------------------------------
app.post('/api/logout', async (req, res) => {
  const { error } = await supabase.auth.signOut()

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  return res.status(200).json({ message: 'Logged out successfully.' })
})

// -----------------------------------------------------
// 5. Protected route example
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

// -----------------------------------------------------
// Start server
// -----------------------------------------------------
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

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