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
ADMIN_API_KEY=veeam_vproxy_my_custom_admin_key_12345
ENCRYPTION_KEY=my_secure_symmetric_encryption_key_here
```
> [!NOTE]
> - If you omit `ADMIN_API_KEY`, a random one will be generated at startup and printed to the container logs (`docker logs veeam-gateway`).
> - The `ENCRYPTION_KEY` is optional but highly recommended to encrypt stored passwords in the SQLite database. If omitted, the `ADMIN_API_KEY` (or a static default) is used as a fallback.

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
| **Audit Logs** | Every request and authorization decision routed through the gateway. |
| **Veeam Server** | The backend Veeam connection settings (URL / username / password). |

### First-time setup

1. **Veeam Server** → enter your Veeam REST API URL (e.g. `https://192.168.0.238:9419`), username, and password → **Save & Test Connection**. The password is stored encrypted (see Security Architecture below) and is never returned by the API.
2. **Users** → register the people/agents that will hold keys, and assign them to security groups.
3. **API Keys** → issue a key for each client. The full token is shown **once** at creation — copy it then.

### Key roles: Admin vs Viewer

Every API key has a **console role**, chosen when you issue it:

- **Admin** — full control of the gateway (manage keys, users, groups, rules, and the Veeam connection).
- **Viewer** — can sign in and **read** every screen, but **cannot change anything**; all create/edit/delete/save actions are blocked server-side (HTTP `403`), not merely hidden. A "Read-only" badge is shown in the top bar.

> New keys **default to Viewer** (least privilege). Choose **Admin** explicitly when you need an administrative key.

A key's **console role is independent of its Veeam access**: what a key may call through the `/veeam/*` proxy is governed by its user's **group policies** (Security screen), not by the Admin/Viewer role. So a true "look but touch nothing" key needs both a Viewer role *and* a user with no (or read-only) Veeam permissions.

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
* **Symmetric Encryption (AES-256-GCM)**: To protect credentials on-disk, the Veeam password is encrypted in the SQLite database using authenticated AES-256-GCM encryption. The stored format is `iv:authTag:ciphertext`.
* **Master Key Derivation**: The encryption key is derived using a SHA-256 hash of the `ENCRYPTION_KEY` environment variable. If `ENCRYPTION_KEY` is not set, `ADMIN_API_KEY` is used as a fallback, followed by a static key.
* **Auto-Migration of Legacy Credentials**: The gateway maintains backward compatibility with older gateway setups. Upon server startup, if a plaintext (unencrypted) password is found in the database, the gateway reads it, automatically encrypts it using the current key, and updates the database row.
* **Zero-Leak GET API**: The API endpoint to retrieve settings (`GET /api/config`) is restricted to the **Admin** role. For security, it **never returns the password** in plaintext; it only returns a boolean flag (`hasPassword: true`) to let the frontend know a password is set.
* **Securing the DB Volume**: While the credentials are encrypted at rest, they are readable by the Node process inside the container. Ensure the volume host directory (or Docker/Podman volume) is protected with strict filesystem permissions (e.g., `chmod 700` and restricted ownership to the container runtime user).

### 3. Middleware Security Layers
Every request routed through the `/veeam/*` proxy endpoint undergoes three successive validation checks:
1.  **Authentication Middleware**: Hashes the incoming API key token using SHA-256 and compares it against active records in SQLite.
2.  **API Schema Validator**: Matches the target request path against the compiled Veeam v13 OpenAPI paths. Non-existent routes are immediately dropped with a `404 Not Found` (filtering out path injections).
3.  **RBAC Authorization**: Compares the HTTP verb and path against the key's assigned role rules:
    *   **Viewer**: Only allowed read-only (`GET`) requests.
    *   **Operator**: Allowed `GET` requests, and `POST` requests targeting job starts/stops or restore actions. Cannot create or edit jobs.
    *   **Admin**: Unrestricted proxy routing.
4.  **Global Safety Rules (Blocklist)**: Evaluates a table of admin-configured wildcard rules (e.g. `DELETE *`) to drop high-risk requests before forwarding.
