# Veeam Gateway Proxy

This is the secure proxy gateway that mediates connections between clients (like AI agents) and your Veeam Backup & Replication server.

## Running locally with Docker Desktop or Podman

The application is containerized using a multi-stage Docker build that compiles the React SPA frontend and serves it via the Express backend.

### 1. Configure Connection Settings
Before building, create an `.env` configuration file in this directory to declare your Veeam credentials and encryption settings:

```bash
VEEAM_API_URL=https://192.168.0.238:9419
VEEAM_USERNAME=your_veeam_user
VEEAM_PASSWORD=your_veeam_password
VEEAM_API_VERSION=1.3-rev1
ADMIN_API_KEY=veeam_vproxy_my_custom_admin_key_12345
ENCRYPTION_KEY=my_secure_symmetric_encryption_key_here
```
> [!NOTE]
> - The `VEEAM_*` values seed the **default** Veeam server on first run only; afterwards servers are managed in the dashboard, and you can add more (see *Managing multiple Veeam servers* below). `VEEAM_API_VERSION` is optional and defaults to `1.3-rev1`.
> - If you omit `ADMIN_API_KEY`, a random one will be generated at startup and printed to the container logs (`docker logs veeam-gateway`).
> - The `ENCRYPTION_KEY` is optional but highly recommended to encrypt stored passwords in the SQLite database. If omitted, the `ADMIN_API_KEY` (or a static default) is used as a fallback.
> - Revoked API keys can be removed from the dashboard (per-key **Delete**, or **Clear revoked** in bulk) and are auto-purged on startup after `REVOKED_KEY_RETENTION_DAYS` days (optional, default `30`).

---

### 2. Build the Image

Run the build command from this directory:

**Using Docker:**
```bash
docker build -t veeam-gateway .
```

**Using Podman:**
```bash
podman build -t veeam-gateway .
```

---

### 3. Run the Container

The container runs on port `8080` internally. In production mode, the gateway stores keys, rules, and audit logs in an SQLite database at `/data/database.sqlite`. To persist this database across container restarts, mount a persistent volume to `/data`.

#### Run with volume mount (Recommended)
This ensures API keys and audit logs are not wiped when updating or restarting the container.

**Using Docker:**
```bash
docker run -d \
  -p 8080:8080 \
  --name veeam-gateway \
  --env-file .env \
  -v veeam-gateway-data:/data \
  veeam-gateway
```

**Using Podman:**
```bash
podman run -d \
  -p 8080:8080 \
  --name veeam-gateway \
  --env-file .env \
  -v veeam-gateway-data:/data \
  veeam-gateway
```

#### Run without volume mount (Temporary test)
```bash
docker run -d -p 8080:8080 --name veeam-gateway --env-file .env veeam-gateway
```

---

### 4. Verify the Container is Running

Check container logs to verify the database initialized and the Swagger schema compiled:
```bash
docker logs veeam-gateway
```

**Example healthy output:**
```log
[SWAGGER] Loaded and compiled 332 route definitions for runtime validation.
[CONFIG] Veeam connection config loaded from DB. URL: https://192.168.0.238:9419
[SERVER] Veeam Integration Gateway running on port 8080
```

Verify you can hit the status endpoint using your configure admin key:
```bash
curl -i -H "Authorization: Bearer veeam_vproxy_my_custom_admin_key_12345" http://localhost:8080/api/status
```

---

## How to Use the Dashboard

The gateway ships with an **Enterprise Console** web dashboard served at the gateway's own URL (`http://localhost:8080` locally, or the app URL when deployed). Sign in with an **Admin** bearer token — either your configured `ADMIN_API_KEY`, or the seeded **Default Admin** key printed once to the container logs on first run.

The console has six screens:

| Screen | What it's for |
|--------|---------------|
| **Dashboard** | At-a-glance health: Veeam connection, active keys, security groups, blocked requests, recent activity. |
| **API Keys** | Issue and revoke the proxy keys clients use to authenticate to the gateway. |
| **Users** | Proxy users and their security-group membership. |
| **Security** | Group access policies (`ALLOW`/`DENY` rules over Veeam paths) and system-wide global block rules. |
| **Audit Logs** | Every request and authorization decision routed through the gateway (incl. which Veeam server it hit). |
| **Veeam Servers** | Manage the Veeam Backup & Replication server(s) the gateway proxies to — add / edit / delete, set the default, and test connectivity. |

### First-time setup

1. **Veeam Servers → Add Server**: give it a slug, your Veeam REST API URL (e.g. `https://192.168.0.238:9419`), username, password, and (optionally) API version → save, then **Test**. The password is stored encrypted (see Security Architecture below) and is never returned by the API. *(If you set the `VEEAM_*` env vars, a **default** server is already seeded.)*
2. **Users** → register the people/agents that will hold keys, and assign them to security groups.
3. **API Keys** → issue a key for each client. The full token is shown **once** at creation — copy it then.

### Key roles: Admin vs Viewer

Every API key has a **console role**, chosen when you issue it:

- **Admin** — full control of the gateway (manage keys, users, groups, rules, and the Veeam connection).
- **Viewer** — can sign in and **read** every screen, but **cannot change anything**; all create/edit/delete/save actions are blocked server-side (HTTP `403`), not merely hidden. A "Read-only" badge is shown in the top bar.

> New keys **default to Viewer** (least privilege). Choose **Admin** explicitly when you need an administrative key.

A key's **console role is independent of its Veeam access**: what a key may call through the `/veeam/*` proxy is governed by its user's **group policies** (Security screen), not by the Admin/Viewer role. So a true "look but touch nothing" key needs both a Viewer role *and* a user with no (or read-only) Veeam permissions.

### Managing multiple Veeam servers

The gateway can front **multiple** Veeam Backup & Replication servers at once:

- **Add servers** on the **Veeam Servers** screen. Each has a unique **slug** (used in URLs), its own URL / credentials / API version, and exactly one is the **default**.
- **Routing** — a request to `/veeam/api/…` hits the key's **Default VBR** (or the system default); to target another server explicitly, insert its slug: `/veeam/<slug>/api/…`. (Real Veeam paths start with `/api`, so any other first segment is read as a server slug; an unknown slug returns `404`.)
- **Per-key default** — set a key's **Default VBR** when issuing it (API Keys screen) so single-server clients never have to name a server.
- **Per-server access control** — group policy rules can apply to **All servers** or a **specific** one (Security screen → the rule's *Server* field), so a user can be allowed on one VBR and denied on another. Unscoped rules apply everywhere.

### Generating a view-only (Viewer) key

To create a key that can observe the dashboard but change nothing — and make no Veeam calls at all:

1. **Users → Register User.** Give it a name (e.g. `dashboard-viewer`) and tick the **Dashboard Viewers** group. This group is seeded automatically and has **no rules**, so its members are default-denied on every `/veeam` call.
2. **API Keys → Issue Token.** Set **Associated User** to that user, set **Console Role** to **Viewer**, and **Generate Key**.
3. **Copy the token** from the one-time reveal modal — it is not shown again.

The holder can now sign in and review status, keys, users, policies, and audit logs read-only. Each sign-in is recorded in **Audit Logs** as a `Viewer console access` event (with client IP and timestamp), so you can audit when the key is used. Revoke it anytime from **API Keys → Revoke**.

> **Want a viewer that can also *read* Veeam data** (but not write)? Put its user in a group whose only rule is `ALLOW GET *` instead of *Dashboard Viewers* — read-only console **and** read-only Veeam.

---

## Security Architecture & Credential Storage

The gateway is built from the ground up to act as a secure boundary shielding your primary backup infrastructure.

### 1. Veeam Credential Isolation
* **Zero Client Exposure**: The actual username and password to your Veeam Backup & Replication server are kept strictly on the gateway server. Clients (e.g. AI agents, web dashboards) only ever authenticate to the gateway using proxy-specific, revocable API keys (`veeam_vproxy_...`).
* **OAuth2 Token Exchange**: The gateway manages Veeam session lifetimes in the background. It sends the username/password to Veeam's `/api/oauth2/token` endpoint to acquire a short-lived bearer token (900s expiry), caches it in memory, and appends it to authorized proxy requests. Raw credentials are never exposed in transit to clients.

### 2. Configuration & Password Storage
Connection settings can be initialized via environment variables (`.env`) or modified dynamically in the dashboard UI.
* **Symmetric Encryption (AES-256-GCM)**: To protect credentials on-disk, each Veeam server's password is encrypted in the SQLite database using authenticated AES-256-GCM encryption. The stored format is `iv:authTag:ciphertext`.
* **Master Key Derivation**: The encryption key is derived using a SHA-256 hash of the `ENCRYPTION_KEY` environment variable. If `ENCRYPTION_KEY` is not set, `ADMIN_API_KEY` is used as a fallback, followed by a static key.
* **Auto-Migration of Legacy Credentials**: The gateway maintains backward compatibility with older gateway setups. Upon server startup, if a plaintext (unencrypted) password is found in the database, the gateway reads it, automatically encrypts it using the current key, and updates the database row.
* **Zero-Leak GET API**: The API endpoint to retrieve settings (`GET /api/config`) is restricted to the **Admin** role. For security, it **never returns the password** in plaintext; it only returns a boolean flag (`hasPassword: true`) to let the frontend know a password is set.
* **Securing the DB Volume**: While the credentials are encrypted at rest, they are readable by the Node process inside the container. Ensure the volume host directory (or Docker/Podman volume) is protected with strict filesystem permissions (e.g., `chmod 700` and restricted ownership to the container runtime user).

### 3. Middleware Security Layers
Every request routed through the `/veeam/*` proxy endpoint passes through three middleware stages, in order:

1.  **Authentication**: The incoming API key is hashed with SHA-256 and matched against active keys in SQLite. Per-key expiry and IP/CIDR allowlists are enforced here — an expired key is rejected with `401`, a request from a disallowed source IP with `403`.
2.  **Schema Validation**: The target path and method are matched against the compiled Veeam v13 OpenAPI definitions. An unknown path is dropped with `404 Not Found`, and a known path called with a disallowed method with `405 Method Not Allowed` — filtering out path injection before anything reaches Veeam.
3.  **Authorization (Policy-Based Access Rules)**: The request's method and path are evaluated against an Azure-style allow/deny policy, first match wins, in this precedence:
    1.  **Global blocklist** — system-wide block rules (e.g. `DELETE *`) are checked first and override everything, including admins → `403`.
    2.  **Explicit DENY** — any `DENY` rule from the caller's groups blocks the request → `403`. A DENY always beats an ALLOW.
    3.  **Explicit ALLOW** — at least one matching `ALLOW` rule from the caller's groups permits the request, and it is forwarded to Veeam.
    4.  **Default deny** — no matching ALLOW rule → `403`.

    Rules match on HTTP method (or `*`) and glob path patterns (e.g. `/api/v1/jobs/*`), and may be **scoped to a specific Veeam server** (or all servers) — the request's resolved target server is part of the match. A key's Veeam permissions are the **union of its owner's group rules** — there are no fixed per-key proxy roles. (The separate **Admin/Viewer** role on a key governs the management dashboard under `/api/*`, *not* this `/veeam` policy — see *How to Use the Dashboard* above.)

---

## Deploying to Atelier

This gateway runs on the Atelier platform as a `direct`-build app: the Atelier app's git repo holds **this `gateway/` folder's contents at its root**, and pushing to that repo's `main` branch triggers a build from the `Dockerfile`.

[`push_to_atelier.sh`](push_to_atelier.sh) automates that push. It clones the Atelier app repo, mirrors this source into it (preserving Atelier's own build outputs like `atelier-spec.yaml` and `k8s/`), and pushes a commit to `main` — **without touching the surrounding monorepo's git history**.

```bash
# from gateway/
DRY_RUN=1 ./push_to_atelier.sh   # preview what would deploy (pushes nothing)
./push_to_atelier.sh             # deploy → triggers the build
```

Configuration is read from `gateway/.env` (or the environment):

| Variable | Required | Purpose |
|---|---|---|
| `ATELIER_API_TOKEN` | yes | Developer-role token (`atl_…`) used for git authentication |
| `ATELIER_API_URL` | no | REST base, used only to print the build-watch hint |
| `ATELIER_GIT_HOST` | no | git proxy host (default `atelier.home.arpa`) |
| `ATELIER_APP_NAME` | no | app / repo name (default `veeam-gateway`) |

The token is fed to git out-of-band via a temporary askpass helper created **outside** the repo, so it is never written into the working tree or a commit.
