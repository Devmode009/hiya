# HAYA · Solar project operations

A MERN application built from `HAYA-product-flow-and-design-brief.pdf`. The interface adapts to phone, tablet and laptop use: single-column mobile screens, bottom navigation, large daily actions and wider review layouts on larger screens.

## Start the interface

Requires Node.js 24 LTS and npm.

```powershell
npm ci
npm run dev
```

Open **http://localhost:5173**. Development starts in a clearly labelled sample workspace. Its role selector demonstrates owner, manager, supervisor and client journeys. Sample data stays on this browser and never contacts AWS.

## Run the local MERN application

Requires Docker Desktop for MongoDB, or an existing MongoDB connection.

```powershell
Copy-Item .env.example .env
# Edit .env and choose LOCAL_ADMIN_PASSWORD (12+ characters).
docker compose up -d --wait
npm run dev:full
```

Select **Sign in** at http://localhost:5173. With `SEED_DEMO=true`, use `owner@haya.demo`, `manager@haya.demo`, `supervisor@haya.demo` or `client@haya.demo` with the password you set. With `SEED_DEMO=false`, the initial account uses `BOOTSTRAP_OWNER_EMAIL` and starts empty. Seeding applies only to a new database; editing `.env` does not reset existing credentials or data.

If MongoDB is already installed, set `MONGODB_URI=mongodb://127.0.0.1:27017/` and `MONGODB_DATABASE=haya` in `.env`; no Docker or replica-set URI is required for this initial backend. If no local server is running, `npm run dev:mongo` starts a real MongoDB process on that address with persistent data in ignored `.local/mongodb/`. Keep it running in a separate terminal, then run `npm run dev:full`. The helper reuses an existing server when one is reachable and never resets an existing database. Its first run may download MongoDB if the development binary is not cached.

The local unauthenticated MongoDB server binds to `127.0.0.1` and is for development only. AWS uses authenticated, TLS-only MongoDB in private subnets. `npm run dev:server` starts only Express; `npm run build` checks frontend/backend TypeScript and builds React. Frontend changes reload automatically. Restart the development command after backend or `.env` changes; API file watching is opt-in with `npm run dev:server -- --watch-api` because Windows file watchers can interrupt requests when local database files change.

## Implemented workflows

- Project and first-site creation, with all **74 mandatory source activities** copied into a site snapshot.
- Project → site → stage → work group → activity navigation, with remembered site context.
- Quantity updates, notes, photos, text drafts, independent approvals and requests for changes.
- Integer work ledger, cumulative rounding, allocation caps, idempotent requests and locked decisions.
- Separate quality ledger: report, verify, correct with evidence, reinspect, close/reopen. Closure never restores points automatically.
- Daily reports with labour headcount/hours, blockers and tomorrow’s plan.
- Material receipts, machinery hours, diesel issues, duplicate references and independent verification.
- Explicit location capture, check-in/out, one open visit per person and attendance exception review.
- Scoped progress exports, audit history, team creation and server-enforced permissions. Clients receive approved quantity summaries without staff locations or internal records.

The dashboard, site, checklist, reports, attendance, resources, approvals, quality, progress, handover readiness, team, template, audit and connection screens are available.

## AWS deployment

See [the deployment guide](docs/AWS-DEPLOYMENT.md) and [operator script](scripts/aws/deploy.ps1). No AWS resources have been created in this implementation session.

```powershell
.\scripts\aws\deploy.ps1 -Domain example.com -HostedZoneId Z123456789 -OwnerEmail owner@example.com -Region ap-south-1
```

The CDK stack provisions private S3/CloudFront frontend hosting, ECS Fargate/HTTPS ALB, Cognito, private versioned evidence storage, a three-node MongoDB replica set on EC2, Secrets Manager, CloudWatch and daily AWS Backup snapshots. It does not replace MongoDB with DocumentDB.

## Checks

```powershell
npm test
npm run build
npm run test:e2e
npm run test:api
npm ci --prefix infra
npm run check --prefix infra
npm run synth --prefix infra -- -c domain=example.com -c hostedZoneId=Z0123456789EXAMPLE -c ownerEmail=owner@example.com -c region=ap-south-1
```

Browser tests use installed Chrome on Windows; set `HAYA_CHROME` for another executable. Other systems use Playwright’s Chrome channel. API tests launch a temporary real MongoDB replica set and may download its binary on first use. Production data is never used. Screenshots are generated under `test-results/`.

## First-release boundaries

This is a working first release, not the entire month-long production delivery plan. Source quantities, units, allocations, engineering dependencies and acceptance rules still need approval. Template editing/migration, N/A reweighting, scope changes/reversals, stock consumption/transfers, detailed rental terms, comments/mentions, client suggestions, commissioning documents and final acceptance remain follow-up work. Handover stays gated.

Actual site boundaries have not been invented. **All attendance visits currently require exception review**, even with GPS. Managers’ exceptions require owner review. Normal geofence acceptance, retention policies and attendance corrections require actual site coordinates and approved rules. There is no continuous tracking or automatic absence.

The initial backend commits work decisions, ledger changes and audit events atomically within one MongoDB organisation document using revision compare-and-set. Before a workspace approaches MongoDB’s 16 MB document limit, split the collections and use multi-document transactions. Access creation and its audit currently use separate writes. Audit is application-controlled, not externally tamper-proof.

Local text drafts remain on the current browser. Sample media uses IndexedDB; connected development uses GridFS; AWS uses private versioned S3. Full offline media sync/conflict handling, unattached-media cleanup, malware scanning/re-encoding and EXIF handling are not implemented.

Complete real-data UAT, AWS smoke tests, engineered acceptance rules, security/access review, backup restores, certificate rotation, monitoring and retention/recovery decisions before operational use. The deployment guide records those gates explicitly.
