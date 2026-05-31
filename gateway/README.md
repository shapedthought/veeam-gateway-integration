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
