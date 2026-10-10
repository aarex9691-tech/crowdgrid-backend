# CrowdGrid API

Express + MongoDB backend for CrowdGrid, a pilgrimage and mass-gathering operations platform (flagship: Simhastha Kumbh Mela, Nashik–Trimbakeshwar).

## Run it

```bash
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
# edit .env: MONGO_URI (Atlas), JWT_SECRET, QR_SECRET
npm run seed                 # WARNING: wipes and refills the database in MONGO_URI
npm run dev                  # http://localhost:5000
```

Then start the frontend (`crowdgrid-frontend`, `npm run dev`) and open http://localhost:5173.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

### Demo accounts (after `npm run seed`)

Every account's password is `Crowd@123`.

| Mobile | Role | Use it to show |
|---|---|---|
| 9000000006 | Pilgrim (USER) | Book beds, claim meal token, shuttle pass, RSVP, SOS, passbook |
| 9000000005 | Ground Volunteer | QR scanner |
| 9000000003 | NGO / Seva Admin (Shri Ram Seva Trust) | Camp & kitchen manager, approve volunteer |
| 9000000002 | District Authority | Control room: occupancy, SOS, verify NGO |
| 9000000001 | Super Admin | Everything |
| 9000000004 | Corporate Admin | Scanner (corporate desk) |
| 9000000007 | Pilgrim with a pending seva application | Approval flow |
| 9000000009 | Pilgrim with a pending NGO application | Verification flow |

Corporate summit access code: `482913`.

Set `PASS_TIME_WINDOWS=relaxed` in `.env` to let meal tokens scan at any time on their day (useful for a demo outside meal hours). The default `strict` follows the spec.

## Prove there is no double booking

```bash
npm run test:concurrency
```

200 pilgrims race for 10 beds at the same instant, then one pilgrim fires 20 simultaneous lunch claims. Expected: exactly 10 bookings with 0 beds left, and exactly 1 meal token. The script cleans up after itself.

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

MongoDB applies each single-document update atomically, so concurrent requests cannot both see the last bed. Losing requests match nothing and get "Sold out". The booking and QR pass are written in the same multi-document transaction on Atlas. This is the MongoDB equivalent of the spec's MySQL `SELECT … FOR UPDATE` and `UPDATE`.

**One meal token per person per meal.** Each pass has a `dedupeKey` such as `MEAL:<event>:<date>:LUNCH:<user>` with a unique index. The database itself rejects the second token, even if two requests arrive together.

**Tamper-proof QR (NFR 4.3).** The QR holds `CG1.<passId>.<uuid-v4 nonce>.<HMAC-SHA256 signature>`. Without `QR_SECRET` nobody can make a valid signature, so fake or edited codes are rejected before the database is queried.

**No double redemption.** A scan flips `ACTIVE` to `REDEEMED` with one conditional update that also checks the validity window. If two volunteers scan the same QR at once, only one sees "VALID".

**Security.** bcrypt (10 rounds), JWT with the role re-read from the database on every request, helmet, rate limiting (stricter on login), NoSQL-injection stripping, uploads restricted to images up to 3 MB, contact numbers on the lost & found board hidden from the public.

## API summary

| Method & path | Who |
|---|---|
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | anyone / logged in |
| `GET /api/events`, `GET /api/events/:idOrSlug` | public |
| `POST /api/events/:id/rsvp` | booking roles |
| `POST /api/events/:id/corporate/verify` → `/badge` | logged in |
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
