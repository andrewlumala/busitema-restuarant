require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const walletRoutes = require('./routes/wallet');
const ordersRoutesFactory = require('./routes/orders');
const guestOrdersRoutesFactory = require('./routes/guest-orders');
const momoWebhookRoutesFactory = require('./routes/momo-webhook');
const ratingsRoutes = require('./routes/ratings');
const disputesRoutesFactory = require('./routes/disputes');
const transactionsRoutes = require('./routes/transactions');
const auditRoutes = require('./routes/audit');
const exportRoutes = require('./routes/export');
const overviewRoutes = require('./routes/overview');
const initSockets = require('./sockets');

const app = express();
const server = http.createServer(app);

// CORS: since the frontend is served from the same origin (public/ via express.static),
// this only matters if you point a separately-hosted frontend at this API. Set
// FRONTEND_URL in production — leaving this as '*' means any website can call your API.
const allowedOrigin = process.env.FRONTEND_URL || '*';
if (allowedOrigin === '*') {
  console.warn('[cors] FRONTEND_URL is not set — allowing requests from any origin. Set it before deploying publicly.');
}
const io = new Server(server, { cors: { origin: allowedOrigin } });

app.use(cors({ origin: allowedOrigin }));
// Default 100kb limit is too small for base64-encoded menu photos (see admin.html's
// photo upload, which resizes client-side but still needs headroom)
app.use(express.json({ limit: '2mb' }));

// Request logging — 'combined' format includes response status and timing, useful for
// spotting problems in Railway/Render logs without needing a separate monitoring tool.
app.use(morgan('combined'));

// General API rate limit — defense in depth beyond the stricter login limiter in auth.js.
// 200 requests/minute/IP is generous for normal use, tight enough to blunt casual abuse.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
}));

// Tighter limit specifically on order creation — stops someone from scripting hundreds
// of orders (each one holds a DB transaction and touches stock).
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders placed too quickly — please wait a moment.' },
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', orderLimiter, ordersRoutesFactory(io)); // orders routes need io to broadcast
app.use('/api/guest/orders', orderLimiter, guestOrdersRoutesFactory(io));
app.use('/api/momo', momoWebhookRoutesFactory(io));
app.use('/api/ratings', ratingsRoutes);
app.use('/api/disputes', disputesRoutesFactory(io));
app.use('/api/transactions', transactionsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/overview', overviewRoutes);

// Serves the connected frontend pages (public/student.html, kitchen.html, admin.html) —
// same origin as the API, so no CORS/CSP issues like the published Claude artifact demos have.
app.use(express.static('public'));

// Catches anything that slipped past individual route try/catch blocks, so a bug never
// crashes the whole server silently — always logs, always responds instead of hanging.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our end' });
});

// Belt-and-suspenders: if something throws outside Express's request cycle entirely
// (a bad Promise somewhere), log it loudly instead of the process dying silently.
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

initSockets(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Busitema Restaurant API running on port ${PORT}`));
