# CrowdGrid v2 – project status

Last updated: Saturday 10 Oct 2026. Review / presentation: **Monday 12 Oct 2026**.

## Decisions taken
- Database: **MongoDB Atlas** for now (MySQL migration possible later; all DB code lives in `*.service.js` / `*.model.js`).
- Roles (6): `SUPER_ADMIN`, `AUTHORITY`, `CORPORATE_ADMIN`, `NGO_ADMIN`, `VOLUNTEER`, `USER` (pilgrim/attendee). Signup always creates `USER`.
- Flagship event: **Simhastha Kumbh Mela 2027, Nashik–Trimbakeshwar** (Dhwajarohan 31 Oct 2026). The requirements doc's "Prayagraj 2027" is incorrect.
- All work is on branch **`v2`** in both repos (`crowdgrid-backend`, `crowdgrid-frontend`). `main` still holds the old version.

## Done and verified on Atlas
- `npm run seed` – demo data loaded (all demo passwords `Crowd@123`; see README for accounts).
- `npm run test:concurrency` – PASS: 200 pilgrims / 10 beds → exactly 10 bookings, 0 beds left; 20 simultaneous lunch claims → 1 token (~12 s).
- Pilgrim flow in the browser: login, book a bed, lodging QR pass shows in the passbook.

## Pending (in this order)
1. **Testing**
   - Scanner: copy pass code → log in as volunteer `9000000005` in an incognito window → paste → expect green "VALID – CHECKED IN"; check again → red "Already used"; passbook shows the pass as used.
   - Food tab: claim a token, claim the same meal again → refused ("limit 1 per meal").
   - Authority `9000000002`: control room shows occupancy, open SOS alert, "Godavari Yuva Mandal" awaiting verification.
   - NGO admin `9000000003`: Sunita's seva application awaiting approval.
2. **Merge `v2` → `main`** (after tests pass): tag current `main` as `v1-backup`, open a PR per repo, merge.
3. **Documentation**: update the requirements doc (MongoDB design with atomic updates, 6 roles, Nashik), write a 5-minute demo script and viva Q&A.

## Presentation on a friend's laptop
- Friend is a collaborator: clone both repos, `git checkout v2` (or `main` after the merge), `npm install` in each.
- Copy `.env` privately into `crowdgrid-backend` (it is not on GitHub).
- Atlas → Network Access → add the friend's / venue's IP. Keep a mobile hotspot as backup.
- PowerShell error "running scripts is disabled": `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.
- No need to re-seed (same Atlas database).

## Security to-do before submission
- Rotate the Atlas password and `JWT_SECRET` / `QR_SECRET` once more (they were shared during setup). The very first `.env` is still in `main`'s git history.

## Later (after Monday)
Leaflet maps, Hindi/Marathi i18n, live SOS push (Socket.IO), corporate-admin event creation UI, optional MySQL migration.
