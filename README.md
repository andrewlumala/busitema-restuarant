# Busitema Canteen — Backend API

Backend for the Busitema University Canteen digital ordering system: student
ordering & wallet, kitchen live order feed, and admin management. Pairs with
the three frontend prototypes (student app, kitchen display, admin dashboard).

## Stack

- Node.js + Express — REST API
- PostgreSQL — data storage
- Socket.IO — real-time order updates (kitchen ↔ student)
- JWT — authentication for students and staff

## Setup — Option A: Docker (fastest, no accounts needed)

Requires only [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed.

```bash
docker compose up
```

This starts PostgreSQL, loads `schema.sql` and `seed.sql` automatically on first run (menu items
only — see below for staff accounts), and starts the API on `http://localhost:4000`. Check
`http://localhost:4000/health` to confirm it's up.

**One-time step, once it's running** — create the default kitchen/admin logins:
```bash
docker compose exec api node scripts/seed-staff.js
```
This creates `kitchen1` and `admin1`, both with password `password123` (change it — either via
the admin Staff tab once you've logged in, or before a real pilot). Safe to run again later;
it skips accounts that already exist.

To stop: `docker compose down` (add `-v` to also wipe the database — you'll need to re-run the
staff seeder if you do, since a fresh database has no accounts).

## Setup — Option B: Manual (if you already have Postgres/Node installed)

1. **Create the database and load the schema:**
   ```bash
   createdb busitema_canteen
   psql busitema_canteen < db/schema.sql
   psql busitema_canteen < db/seed.sql   # optional sample data
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # then edit .env with your real DB credentials and a random JWT_SECRET
   ```

4. **Run it:**
   ```bash
   npm run dev      # with auto-restart (nodemon)
   # or
   npm start
   ```

## Going live — deploying so the frontend can actually reach it

Once Option A works locally, the same Dockerfile deploys almost anywhere. For a student
project, the cheapest reliable path:

1. **Database:** create a free Postgres instance on [Neon](https://neon.tech) or
   [Supabase](https://supabase.com) — copy the connection details into your `.env`/production
   environment variables. Run `schema.sql` and `seed.sql` against it once (their web consoles
   let you run SQL directly, or use `psql` with the connection string they give you).
2. **API:** deploy this repo to [Railway](https://railway.app) or [Render](https://render.com) —
   both detect the `Dockerfile` automatically. Set the same environment variables as your `.env`
   (DB credentials, `JWT_SECRET`, mobile money keys) in their dashboard.
3. You'll get a public URL like `https://busitema-canteen-api.up.railway.app` — that's what the
   three frontend prototypes need to point at (see "Connecting the frontend prototypes" below).

## API Overview

| Endpoint | Method | Who | Purpose |
|---|---|---|---|
| `/api/auth/register` | POST | Public | Student sign-up (creates wallet too) |
| `/api/auth/login` | POST | Public | Student login |
| `/api/auth/staff-login` | POST | Public | Kitchen/admin login |
| `/api/menu` | GET | Public | Browse menu |
| `/api/menu` | POST | Admin | Add menu item |
| `/api/menu/:id` | PATCH | Admin | Update price/stock/availability |
| `/api/wallet` | GET | Student | Check balance |
| `/api/wallet/topup` | POST | Student | Top up via mobile money |
| `/api/orders` | POST | Student | Place an order (wallet or momo, optional `pickup_time`) |
| `/api/orders/mine` | GET | Student | Own order history |
| `/api/orders/kitchen` | GET | Kitchen/Admin | Active order queue (sorted by pickup time) |
| `/api/orders/:id/status` | PATCH | Kitchen/Admin | Advance order status |
| `/api/orders/:id/receipt` | GET | Student/Staff | Full receipt for one order |
| `/api/orders/:id/refund` | POST | Admin | Refund a paid order back to the student's wallet |
| `/api/ratings` | POST | Student | Rate an item from a served order |
| `/api/ratings/summary` | GET | Public | Average rating per menu item |
| `/api/disputes` | POST | Student | Report an issue with an order |
| `/api/disputes` | GET | Admin | List disputes (filter by `?status=`) |
| `/api/disputes/:id` | PATCH | Admin | Resolve/reject a dispute, optionally with a refund |
| `/api/guest/orders` | POST | Public | Guest checkout — no account required |
| `/api/guest/orders/:id` | GET | Public | Poll a guest order's status |
| `/api/orders/pending-cash` | GET | Kitchen/Admin | Guest orders awaiting cash confirmation |
| `/api/orders/:id/confirm-cash` | POST | Kitchen/Admin | Confirm cash received — pushes the order to the kitchen |
| `/api/orders/:id/cancel` | POST | Student | Cancel own order (only while status is `placed`) |
| `/api/auth/create-staff` | POST | Admin | Create a kitchen/admin/cashier account |
| `/api/auth/forgot-password` | POST | Public | Request an SMS reset code |
| `/api/auth/reset-password` | POST | Public | Reset password with the code |
| `/api/audit` | GET | Admin | Full audit trail of refunds, dispute resolutions, staff creation |
| `/api/export/sales.csv` | GET | Admin | Download orders as CSV, optional `?from=&to=` date range |

## Guest checkout

Anyone can order without an account — click "Continue as a guest" on `student.html`. Since
guests have no wallet, they pay either:

- **Cash at the counter** — order stays `pending` until a cashier taps "Confirm cash received"
  on the kitchen page (new "Awaiting Cash" column), which is what actually sends it to the
  kitchen.
- **Mobile money** — same request-to-pay flow as everything else; the webhook confirms it.

Guests have no login, so their ticket page polls `GET /api/guest/orders/:id` every few seconds
for status instead of using Socket.IO (which needs a JWT to authenticate the connection).

One limitation worth knowing: guest payments aren't wallet transactions, so they won't show up
in the admin Transactions tab yet (that table is wallet-based). If that matters for your pilot,
the cleanest fix is a `payments` table that both wallet and guest transactions write to — happy
to build that if you want a unified view.

All protected routes need `Authorization: Bearer <token>` from login.

## Real-time events (Socket.IO)

Connect with `auth: { token: '<jwt>' }`.

- Kitchen/admin clients auto-join the `kitchen` room → receive `order:new`, `order:updated`, and `dispute:new`
- Student clients auto-join `student:<their id>` → receive `order:status` and `dispute:resolved`

## Security & reliability features

| Feature | How it works |
|---|---|
| **Staff accounts via API** | `POST /api/auth/create-staff` (admin-only) — also has a form in `admin.html` → Staff tab. No more hand-editing SQL for new kitchen/admin logins. |
| **CORS locked down** | Set `FRONTEND_URL` in `.env` to your real frontend's URL before deploying. Left blank, it allows any origin (fine for local dev only) and logs a warning. |
| **Login rate limiting** | 10 attempts per 15 minutes per IP on both student and staff login (`express-rate-limit`). |
| **Webhook signature verification** | Set `MOMO_WEBHOOK_SECRET` and the webhook checks an HMAC signature before trusting any payload. Blank = unverified (logs a warning) — fine for sandbox testing, not for production. |
| **Password reset** | `POST /api/auth/forgot-password` + `/reset-password`, SMS-delivered code (via the same SMS stub as "order ready" — see below). Student page has a "Forgot password?" flow. |
| **Cancel order** | Students can self-cancel via `POST /api/orders/:id/cancel`, but only while status is still `placed` — once the kitchen has started, only an admin refund makes sense. Refunds to wallet and returns stock automatically. |
| **Double-order protection** | Pass an `idempotency_key` (any UUID, one per checkout attempt) with `POST /api/orders` or `/api/guest/orders` — a retried/double-tapped request returns the original order instead of creating a duplicate. |
| **SMS on "ready"** | When an order's status becomes `ready`, an SMS goes out via `config/notifications.js` (stub — see below) to the student's or guest's phone. |
| **Sales CSV export** | `GET /api/export/sales.csv?from=&to=` (admin) — also a one-click "Export CSV" link in `admin.html` → Transactions. |
| **Audit log** | Every refund, dispute resolution, and staff account creation is recorded in the `audit_log` table with who/what/when. Viewable in `admin.html` → Audit Log. |
| **Menu photos** | `image_url` on menu items — click a photo cell in the admin Menu tab to set one; shows as a thumbnail on the student menu. |

### SMS provider (stub, like mobile money)

`config/notifications.js` follows the same pattern as `config/momo.js` — it logs what it *would*
send until you set `SMS_API_KEY` in `.env`. Africa's Talking (https://africastalking.com) is the
common choice in Uganda; the file has a commented example of wiring it in.

### A few honest limitations, not fixed here

- The webhook signature check re-serializes the parsed JSON body rather than signing the raw
  bytes — fine for testing, but check your provider's exact signing method before going live.
- The CSV export passes the auth token as a `?token=` query param (download links can't set
  headers) — this means the token can end up in server access logs. Acceptable for a small
  admin-only report; swap for a short-lived signed download link if this needs to be tighter.
- No automated tests yet. Worth adding before this handles real money at scale.

## Automatic stock handling

When an order is placed, `POST /api/orders` decrements `stock_qty` for each item and, if it
hits zero, flips `available` to `false` in the same query — no separate admin action needed.
Re-enabling it (once restocked) is a normal `PATCH /api/menu/:id` with `available: true`.

## Mobile money

Merchant codes are set: **MTN MoMo — 171790**, **Airtel Money — 434366** (in `.env.example`,
used by `config/momo.js`).

### MTN MoMo sandbox (self-service, free)

1. Sign up at https://momodeveloper.mtn.com
2. Products → **Collections** → Subscribe → copy your **Subscription Key**
3. Run the provisioning script once:
   ```bash
   MTN_SUBSCRIPTION_KEY=your_key_here node scripts/mtn-sandbox-setup.js
   ```
4. Copy the printed `MTN_MOMO_API_USER` and `MTN_MOMO_API_KEY` into `.env` along with the
   subscription key. `config/momo.js` will automatically switch from the stub to real sandbox
   calls once all three are set.
5. Test with `POST /api/wallet/topup` using a sandbox test MSISDN (MTN's docs list numbers that
   simulate SUCCESS/FAILED/PENDING/TIMEOUT outcomes).

Note: MTN's **sandbox** only accepts `currency: "EUR"` regardless of market — this is a sandbox
quirk, not a bug. `config/momo.js` is already set this way; switch to `"UGX"` only once you've
gone through MTN's KYC/business approval for production.

### Airtel Money sandbox (requires approval)

Unlike MTN, Airtel doesn't offer a self-serve sandbox — sign up at
https://developers.airtel.africa/signup, register an Application, and wait for approval to get
your `client_id`/`client_secret`. This step typically asks for business registration details, so
it may be worth doing once the restaurant formally adopts the system rather than now. The
request shape is already sketched in `config/momo.js`, commented out until you have credentials.

## What's stubbed for now

- **Airtel Money request** — payload shape is sketched in `config/momo.js` but commented out
  pending Airtel approval.
- **Mobile money webhook** (`routes/momo-webhook.js`) — implemented, but the field names
  (`referenceId`, `status`) are guesses; check your provider's sandbox docs once registered and
  adjust to match their real callback payload. It also needs a signature/secret check added
  before going live — right now anything could call it.

## The connected frontend (real, not simulated)

Once the backend is running (Docker or manual), it serves three working pages directly —
same origin as the API, so no CORS or CSP issues:

| Page | URL | Login |
|---|---|---|
| Student ordering | `http://localhost:4000/student.html` | Register a new account, or any student you've created |
| Kitchen display | `http://localhost:4000/kitchen.html` | `kitchen1` / `password123` (after running `scripts/seed-staff.js`) |
| Admin dashboard | `http://localhost:4000/admin.html` | `admin1` / `password123` (after running `scripts/seed-staff.js`) |

These call the real API — placing an order on the student page actually deducts wallet
balance, generates a real queue ticket, and appears instantly on the kitchen page via
Socket.IO. Open the student and kitchen pages in two different browser tabs to see the
real-time sync for yourself.

**Note on the polished demo prototypes** (the ones shared earlier as `claude.ai/artifact/...`
links) — those stay as-is for pitching and screenshots; they're deliberately simulated so they
work without any setup. The pages above are the real, functional counterpart, now covering:
login/register, guest checkout (cash or mobile money, no account needed), wallet or mobile money
ordering, order cancellation, password reset, live status via Socket.IO, menu management with
photos, transactions, disputes, staff account creation, audit log, and CSV export.

Not yet wired into the connected pages (only in the demo prototypes): **ratings** and
**scheduled pickup time**. The backend API for both already exists (`/api/ratings`, `pickup_time`
on `POST /api/orders`) — only the connected-page UI is missing. Happy to add those next if useful.
