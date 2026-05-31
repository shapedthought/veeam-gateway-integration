# Veeam Gateway Proxy

This is the secure proxy gateway that mediates connections between clients (like AI agents) and your Veeam Backup & Replication server.

## Running locally with Docker Desktop or Podman

The application is containerized using a multi-stage Docker build that compiles the React SPA frontend and serves it via the Express backend.

### 1. Configure Connection Settings
Before building, create an `.env` configuration file in this directory to declare your Veeam credentials:

```bash
VEEAM_API_URL=https://192.168.0.238:9419
VEEAM_USERNAME=your_veeam_user
VEEAM_PASSWORD=your_veeam_password
ADMIN_API_KEY=veeam_vproxy_my_custom_admin_key_12345
```
> [!NOTE]
> If you omit `ADMIN_API_KEY`, a random one will be generated at startup and printed to the container logs (`docker logs veeam-gateway`).

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

## Security Architecture & Credential Storage

The gateway is built from the ground up to act as a secure boundary shielding your primary backup infrastructure.

### 1. Veeam Credential Isolation
* **Zero Client Exposure**: The actual username and password to your Veeam Backup & Replication server are kept strictly on the gateway server. Clients (e.g. AI agents, web dashboards) only ever authenticate to the gateway using proxy-specific, revocable API keys (`veeam_vproxy_...`).
* **OAuth2 Token Exchange**: The gateway manages Veeam session lifetimes in the background. It sends the username/password to Veeam's `/api/oauth2/token` endpoint to acquire a short-lived bearer token (900s expiry), caches it in memory, and appends it to authorized proxy requests. Raw credentials are never exposed in transit to clients.

### 2. Configuration & Password Storage
Connection settings can be initialized via environment variables (`.env`) or modified dynamically in the dashboard UI.
* **SQLite Database**: Dynamic settings are persisted in the `veeam_config` table inside `database.sqlite` (located at `/data` in production container mounts).
* **Zero-Leak GET API**: The API endpoint to retrieve settings (`GET /api/config`) is restricted to the **Admin** role. For security, it **never returns the password** in plaintext; it only returns a boolean flag (`hasPassword: true`) to let the frontend know a password is set.
* **Securing the DB Volume**: Since the credentials are readable by the Node process inside the container, the SQLite database file contains the Veeam credentials. Ensure the volume host directory (or Docker/Podman volume) is protected with strict filesystem permissions (e.g., `chmod 700` and restricted ownership to the container runtime user).

### 3. Middleware Security Layers
Every request routed through the `/veeam/*` proxy endpoint undergoes three successive validation checks:
1.  **Authentication Middleware**: Hashes the incoming API key token using SHA-256 and compares it against active records in SQLite.
2.  **API Schema Validator**: Matches the target request path against the compiled Veeam v13 OpenAPI paths. Non-existent routes are immediately dropped with a `404 Not Found` (filtering out path injections).
3.  **RBAC Authorization**: Compares the HTTP verb and path against the key's assigned role rules:
    *   **Viewer**: Only allowed read-only (`GET`) requests.
    *   **Operator**: Allowed `GET` requests, and `POST` requests targeting job starts/stops or restore actions. Cannot create or edit jobs.
    *   **Admin**: Unrestricted proxy routing.
4.  **Global Safety Rules (Blocklist)**: Evaluates a table of admin-configured wildcard rules (e.g. `DELETE *`) to drop high-risk requests before forwarding.
