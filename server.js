require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

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
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', ordersRoutesFactory(io)); // orders routes need io to broadcast
app.use('/api/guest/orders', guestOrdersRoutesFactory(io));
app.use('/api/momo', momoWebhookRoutesFactory(io));
app.use('/api/ratings', ratingsRoutes);
app.use('/api/disputes', disputesRoutesFactory(io));
app.use('/api/transactions', transactionsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/export', exportRoutes);

// Serves the connected frontend pages (public/student.html, kitchen.html, admin.html) —
// same origin as the API, so no CORS/CSP issues like the published Claude artifact demos have.
app.use(express.static('public'));

initSockets(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Busitema Canteen API running on port ${PORT}`));
