# CrowdGrid API

Express + MongoDB backend for CrowdGrid, a pilgrimage and mass-gathering operations platform (flagship: Simhastha Kumbh Mela, Nashik–Trimbakeshwar).

## Run it

```bash
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
# edit .env: MONGO_URI (Atlas), JWT_SECRET, QR_SECRET, SEED_PASSWORD
npm run seed                 # WARNING: wipes and refills the database in MONGO_URI
npm run dev                  # http://localhost:5000
```

Then start the frontend (`crowdgrid-frontend`, `npm run dev`) and open http://localhost:5173.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

### Demo accounts (after `npm run seed`)

`npm run seed` creates one account per role (Super Admin, Authority, NGO admin,
Corporate admin, Volunteer and three pilgrims). Their password is `SEED_PASSWORD`
from your `.env`, and the corporate access code is `SEED_ACCESS_CODE` (or a random
code printed by the seed). The phone numbers and passwords are kept in the team's
private notes, not in this public repository.

Set `PASS_TIME_WINDOWS=relaxed` in `.env` to let meal tokens scan at any time on their day (useful for a demo outside meal hours). The default `strict` follows the spec.

## Settings added in November 2026

| Setting | What it does |
| --- | --- |
| `SEED_PASSWORD` | Password for every demo account created by the seed (required) |
| `SEED_ACCESS_CODE` | Fixed corporate access code for the seeded summit (random when empty) |
| `QR_SECRET` | Now required: the server will not start without it |
| `VERCEL_PROJECT` | Vercel project name whose addresses CORS allows (default `crowdgrid-frontend`) |
| `TEST_MONGO_URI` | Database for the test scripts; must end in `_test` (see below) |
| `OTP_PROVIDER`, `OTP_REQUIRED` | Sign-up phone codes; `SIMULATED` shows the code on screen |
| `STATIC_PERSONAL_QR` | `allow` (default, with an ID-check warning) or `deny` fixed personal QRs; live 30-second QRs are always accepted |
| `ROUTE_LANE_CAPACITY` | Plans per lane per 15 min before load-aware routing doubles its cost (default 40) |

## Testing without touching the shared database

The flow and concurrency tests create and delete data, so they refuse to run on a
database whose name does not end in `_test` or `_dev`.

```bash
# .env: TEST_MONGO_URI=mongodb+srv://.../crowdgrid_test?retryWrites=true&w=majority
npm run seed:test          # fill the test database once
npm run test:flows
npm run test:concurrency
npm run test:unit          # no database needed
npm run bench:route        # Dijkstra vs A* on 10,000-junction grids
```

`TESTS_ON_SHARED_DB=yes npm run test:flows` runs on the shared database on purpose
(for a last check right after the demo seed). GitHub Actions runs the unit tests and
the benchmark on every push; add `TEST_MONGO_URI` and `SEED_PASSWORD` as repository
secrets to run the flow tests there too.

## Prove there is no double booking

```bash
npm run test:concurrency
```

200 pilgrims race for 10 beds at the same instant, then one pilgrim fires 20 simultaneous lunch claims. Expected: exactly 10 bookings with 0 beds left, and exactly 1 meal token. The script cleans up after itself.

## Check the new features

After `npm run seed`, run:

```bash
npm run test:flows
```

It checks phone validation, tent and bed numbers, the cart with simulated
payment, family meal tokens, the profile rules (date of birth must make the
user 18 or older) and the personal QR against your database, then deletes
everything it created.

**Simulated payment (demo, no real money):** UPI `anything@okaxis` is approved,
`fail@upi` is declined. Card `4242 4242 4242 4242` is approved,
`4000 0000 0000 0002` is declined (any future expiry, any 3-digit CVV).
Paid camps and bus passes must go through `/api/orders`; booking them
directly returns `402 Payment Required`.

| New endpoint | Purpose |
| --- | --- |
| `POST /api/orders` | Create an order from cart items (server prices them) |
| `POST /api/orders/:id/pay` | Pay with `{ method: 'UPI', upiId }` or `{ method: 'CARD', cardNumber, expiry, cvv }` |
| `GET /api/orders/mine`, `GET /api/orders/:id` | Order history and receipt |
| `GET /api/passes/my-qr`, `POST /api/passes/my-qr/reset` | One personal QR for all passes; reset revokes old copies |
| `POST /api/passes/scan` | Now also takes `service` (`FOOD`, `LODGING`, `TRANSIT`, `ENTRY`, `VOLUNTEER`) and `passId` for personal QRs |
| `POST /api/food/slots/:id/claim` | Now takes `{ people: 1-6, names }` for a family token |

## Architecture

```
server.js                 routes, security middleware, error handler
config/roles.js           6 roles + permission map (the access matrix)
middleware/auth.js        JWT check, loads the user fresh from the DB, requirePermission()
utils/passToken.js        HMAC-signed QR payloads
utils/tx.js               transaction helper (Atlas) with fallback for standalone MongoDB
modules/<feature>/        model, service (all DB logic), routes (thin HTTP layer)
  auth, event, provider, lodging, food, transit, pass, volunteer, sos, lostfound, ngo, admin
scripts/seed.js, scripts/concurrency-test.js
```

Controllers never call Mongoose directly. Everything database-specific lives in `*.service.js` and `*.model.js`, so moving to MySQL later means rewriting those files only.

## Roles

| Role | How you get it |
|---|---|
| `USER` (Pilgrim / Attendee) | Sign up (any role sent at sign-up is ignored) |
| `VOLUNTEER` | Apply for seva, then an NGO / Authority approves |
| `NGO_ADMIN` | Register an organisation, then Authority / Super Admin verifies it |
| `CORPORATE_ADMIN`, `AUTHORITY` | Created by the Super Admin (`POST /api/auth/staff`) |
| `SUPER_ADMIN` | Seeded only |

Routes check permissions such as `pass:scan` or `inventory:manage`, not role names, so the access matrix lives in one file.

## Viva notes: how the guarantees work

**Zero double-booking (NFR 4.2).** A bed is taken with one atomic, conditional update:

```js
Lodging.findOneAndUpdate(
  { _id, availableBeds: { $gte: beds } },   // only matches if enough beds remain
  { $inc: { availableBeds: -beds } }
)
```

MongoDB applies each single-document update atomically, so concurrent requests cannot both see the last bed. Losing requests match nothing and get "Sold out". This is the MongoDB equivalent of the spec's MySQL `SELECT … FOR UPDATE` and `UPDATE`.

The claim deliberately runs outside a transaction: wrapping it in one made 200 simultaneous requests collide and retry (about 67 s in testing). Afterwards, the booking and QR pass are written together in a transaction, and if that step fails the beds are handed back (a compensating update).

**Beds are counted per night.** Each camp has one `LodgingNight` row per night with the
beds booked that night. A stay claims every one of its nights with the same atomic
conditional update (`booked + beds <= totalBeds - heldBeds`); if any night is full, the
nights already taken are handed back. So a bed booked for 2 Aug is free again on 3 Aug.
Bed numbers are per night too: a unique index on (camp, bed, night).

**Shuttle seats.** Each route carries seats per trip x departures per day; a
`TransitDay` counter per route per day is claimed the same way.

**Load-aware safest route.** Every route the server plans is remembered for 15 minutes.
A lane's cost is length x crowd factor x (1 + recent plans / `ROUTE_LANE_CAPACITY`), so
later pilgrims are spread over other lanes instead of everyone being sent the same way.
Every multiplier is at least 1, so A*'s straight-line estimate still never overestimates
and A* returns the same cost as Dijkstra (checked by the unit tests).

**Trustworthy crowd signals.** Check-ins count people, linked to map junctions by id.
An OPEN SOS changes lanes only after staff acknowledge it or a second person reports
within 150 m, so one fake alert cannot steer everyone's route.

**Phone verification.** Sign-up needs a 6-digit code sent to the number (simulated in
the demo, like payments): stored hashed, 5-minute expiry, single use, 3 per hour.

**Orders.** Unpaid orders lapse after 15 minutes; a payment interrupted by a crash
returns to "unpaid" after 5 minutes so it can be retried.

**Live personal QR.** The phone gets a key derived from `QR_SECRET` and the user's QR nonce, and
makes `CGL.<user>.<30-second step>.<HMAC>` itself every 30 seconds (Web Crypto, works offline).
The scanner accepts codes up to a minute off (clock drift), so a forwarded screenshot stops
working within about a minute. Resetting the QR changes the key.

**One meal token per person per meal.** Each pass has a `dedupeKey` such as `MEAL:<event>:<date>:LUNCH:<user>` with a unique index. The database itself rejects the second token, even if two requests arrive together.

**Tamper-proof QR (NFR 4.3).** The QR holds `CG1.<passId>.<uuid-v4 nonce>.<HMAC-SHA256 signature>`. Without `QR_SECRET` nobody can make a valid signature, so fake or edited codes are rejected before the database is queried.

**No double redemption.** A scan flips `ACTIVE` to `REDEEMED` with one conditional update that also checks the validity window. If two volunteers scan the same QR at once, only one sees "VALID".

**Security.**
- Passwords: bcrypt (10 rounds); new passwords need 8+ characters with a letter and a number.
- Account lockout: 5 wrong passwords on one account locks it for 15 minutes (atomic counter).
- Sessions: JWT re-checked against the database on every request; "Log out of all devices" bumps a token version so every older token stops working.
- Authorization: permission map from the access matrix, enforced on the server, plus ownership checks.
- Rate limits: 50 login/register attempts per IP per 15 min; 5 wrong corporate access codes per user per 15 min; 2,000 API requests per IP per 15 min. All return a readable JSON message.
- Corporate access codes are generated by the server with `crypto.randomInt` and compared in constant time.
- Injection: MongoDB queries are objects (no query string to inject into, so `' OR '1'='1` is just text); `$` operators are stripped from input and values are forced to strings.
- Audit log: verifications, approvals, SOS updates, pass scans, inventory changes, lockouts and logouts are recorded and shown in the control room.
- Also: helmet headers, CORS allow-list (own Vercel project only), 100 KB body limit, image-only 3 MB uploads checked by their real file type and stored in MongoDB, contact numbers hidden from the public.

## API summary

| Method & path | Who |
|---|---|
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | anyone / logged in |
| `GET /api/events`, `GET /api/events/:idOrSlug` | public |
| `POST /api/events/:id/rsvp` | booking roles |
| `POST /api/events/:id/corporate/verify` → `/badge` | logged in |
| `GET /api/events/corporate/mine` | Corporate Admin (own events), Super Admin (all): events with access code and badge counts |
| `GET /api/events/:id/corporate/code`, `POST /api/events/:id/corporate/code` (regenerate) | organiser, Super Admin |
| `GET /api/events/:id/corporate/attendees` | organiser, Super Admin: badge holders, sessions, check-in status |
| `GET /api/lodgings?eventId&sector&category` | public |
| `POST /api/lodgings/:id/book`, `POST /api/lodgings/bookings/:id/cancel` | booking roles / owner |
| `GET /api/food?eventId&date`, `POST /api/food/slots/:id/claim` | public / booking roles |
| `GET /api/transit?eventId`, `POST /api/transit/:id/pass` | public / booking roles |
| `GET /api/passes/mine`, `POST /api/passes/scan` | logged in / scanner roles |
| `POST /api/volunteer/apply`, `GET /api/volunteer/applications`, `POST …/:id/review` | USER / reviewers |
| `POST /api/sos`, `GET /api/sos`, `PATCH /api/sos/:id` | anyone / staff / managers |
| `GET /api/lost-found`, `POST /api/lost-found` (multipart, `photo`) | public / reporters |
| `POST /api/providers/apply`, `GET /api/providers`, `POST /api/providers/:id/decision` | USER / verifiers |
| `GET /api/ngo/dashboard`, `POST /api/ngo/lodgings`, `PATCH /api/ngo/lodgings/:id/beds`, `PUT /api/ngo/food-centers/:id/slots` | NGO admin |
| `GET /api/admin/overview?eventId` | Authority, Super Admin |
