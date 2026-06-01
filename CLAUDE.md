# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a two-part monorepo for securely bridging an AI agent to a Veeam Backup & Replication v13 server:

- `gateway/` — A secure reverse proxy. Express backend ([server.js](gateway/server.js)) + a single-file React SPA admin dashboard ([src/App.tsx](gateway/src/App.tsx)) built with Vite and served by the same Express process in production.
- `skills/veeam-v13/` — A custom AI skill ([SKILL.md](skills/veeam-v13/SKILL.md)) the agent loads to learn how to talk to the proxy, plus [veeam_search.py](skills/veeam-v13/veeam_search.py), a local CLI for searching the 2.7MB `swagger.json` without polluting context.

There is no test suite and no linter configured. The two halves are deployed independently.

## Gateway — Commands

All commands run from `gateway/`:

```bash
npm install
npm run dev:server   # Express backend on :8080 (uses local database.sqlite)
npm run dev:client   # Vite dev server on :3000, proxies /api and /veeam to :8080
npm run build        # Compile React SPA to dist/ (consumed by server.js in prod)
npm start            # node server.js (production entry; serves dist/ + API)
```

Local dev needs both `dev:server` and `dev:client` running. The Vite proxy ([vite.config.ts](gateway/vite.config.ts)) forwards API calls to the backend.

Container build/run (Docker or Podman, port 8080, see [gateway/README.md](gateway/README.md)):
```bash
docker build -t veeam-gateway .
docker run -d -p 8080:8080 --name veeam-gateway --env-file .env -v veeam-gateway-data:/data veeam-gateway
```

Deploy to the Atelier platform: `./push_to_atelier.sh` (force-pushes to a git remote using `ATELIER_API_TOKEN` from `.env`).

### Environment / config
Settings come from `.env` (see [gateway/README.md](gateway/README.md)): `VEEAM_API_URL`, `VEEAM_USERNAME`, `VEEAM_PASSWORD`, `ADMIN_API_KEY`, `ENCRYPTION_KEY`. Env values seed the DB **only on first run when tables are empty**; afterwards the SQLite DB is the source of truth (editable via the dashboard). `NODE_ENV=production` switches the DB path to `/data/database.sqlite` (mount a volume there).

## Gateway — Architecture

`server.js` (~1300 lines, single file) is the whole backend. Key concepts:

**Request pipeline for proxied Veeam calls** — `app.all('/veeam/*', ...)` chains four middlewares in order; understand all four before changing auth behavior:
1. `authenticateApiKey` — Bearer token is SHA-256 hashed and matched against `api_keys.token_hash`. Also honors `ADMIN_API_KEY` env var directly. Enforces expiry and per-key IP/CIDR allowlists (`ipMatches`).
2. `validateVeeamEndpoint` — strips the `/veeam` prefix and matches the path+method against regexes compiled from `swagger.json` at boot (`loadSwaggerRoutes`). Unknown paths → 404, wrong method → 405. This blocks path injection.
3. `authorizeRequest` — the access-control core. Evaluation order: **global blocklist rules** (`global_rules`) → **explicit group DENY** → **explicit group ALLOW** → **default deny**. DENY always wins; a request with no matching ALLOW is rejected. This mirrors the Azure-style policy model documented in SKILL.md.
4. The handler forwards to Veeam via `axios`, attaching a cached OAuth2 bearer token.

**Veeam token lifecycle** — `getVeeamToken()` exchanges the stored username/password at `/api/oauth2/token` for a short-lived bearer, caches it in memory with expiry, and transparently uses the refresh token. Clients never see Veeam credentials. SSL verification is disabled (`rejectUnauthorized: false`) for self-signed Veeam certs.

**Identity model** — `users` ←→ `user_groups` ←→ `groups` → `group_rules`. API keys belong to a user; a user's effective permissions are the union of all their groups' rules. "Admin" is not a role flag alone — `checkIsAdmin` treats membership in a group holding the wildcard `ALLOW * *` rule as admin. The `global_rules` table is a separate system-wide safety blocklist (seeded with `DELETE *` blocked).

**Credential encryption** — the Veeam password is stored AES-256-GCM encrypted as `iv:authTag:ciphertext` (`encrypt`/`decrypt`). The key derives from SHA-256 of `ENCRYPTION_KEY` → `ADMIN_API_KEY` → a static fallback. On boot, legacy plaintext passwords are auto-migrated to encrypted form. `GET /api/config` never returns the password (only `hasPassword`).

**Schema migrations** — `initDb()` runs at startup: `CREATE TABLE IF NOT EXISTS`, seeds defaults (admin user, Administrators group, default admin key printed once to logs, default DELETE blocklist), and applies additive migrations via `addColumnIfMissing`. There are no migration files — schema changes go in `initDb()`.

**Audit logging** — every authz decision and proxied call writes to `audit_logs` via `logOperation`. `parseVeeamActionAndResource` maps method+path to human-readable action/resource labels (extend it when adding recognized endpoint families).

The React dashboard ("Enterprise Console") is split across `gateway/src/`: [App.tsx](gateway/src/App.tsx) is the shell — auth/login, sidebar nav + theme/collapse state, all `fetch` logic, and a single `Ctx` object ([types.ts](gateway/src/types.ts)) of data + action handlers passed down to presentational screens. [screens.tsx](gateway/src/screens.tsx) holds the six tab screens (Dashboard, Keys, Users, Security, Logs, Config) and their modals; [DashGrid.tsx](gateway/src/DashGrid.tsx) is a dependency-free draggable/resizable widget grid (layout persists to `localStorage`); [icons.tsx](gateway/src/icons.tsx) is an inline SVG icon set. There is no client-side router or component library — `App.tsx` switches screens on the `tab` state. When adding an API interaction, thread it through `Ctx` (add to the interface in `types.ts`, implement in `App.tsx`, consume in `screens.tsx`) rather than fetching from a screen directly. UI-only state lives in `localStorage`: `vgw_theme`, `vgw_collapsed`, `vgw_dash_v1` (dashboard layout); the admin token stays under `vproxy_admin_token`.

## Skill — `skills/veeam-v13/`

The agent should **not** load the full `swagger.json` into context. Instead use the local helper:
```bash
python3 <skill_dir>/veeam_search.py search "jobs"
python3 <skill_dir>/veeam_search.py inspect /api/v1/jobs          # auto-detects method (prefers GET)
python3 <skill_dir>/veeam_search.py inspect POST /api/v1/jobs     # force a method
```
`inspect` resolves `$ref`s recursively and renders request/response schemas. All real Veeam calls go through the proxy under the `/veeam` prefix (e.g. `GET <proxy_base>/veeam/api/v1/backupInfrastructure/repositories`) with `Authorization: Bearer <proxy_api_key>`. Proxy base URLs differ in-cluster vs. external — see SKILL.md.

Note: `gateway/swagger.json` and `skills/veeam-v13/swagger.json` are separate copies of the same Veeam OpenAPI spec serving different purposes (runtime route validation vs. agent lookup).
