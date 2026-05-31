---
name: veeam-v13
description: >-
  Interact with Veeam v13 Backup & Replication REST API via secure proxy.
  Allows querying backup infrastructure status, managing backup repositories,
  jobs, and executing operations like starting, stopping, or retrying backups.
  Contains search tools to lookup swagger schemas dynamically.
---

# Veeam v13 Backup & Replication Custom Skill

This skill allows you to securely interact with a Veeam Backup & Replication v13 environment through a secure proxy. The proxy holds the actual Veeam server credentials, provides audit logs, and filters requests according to Role-Based Access Control (RBAC) and global safety rules.

## Step 1: Smoke-Test & Greeting Endpoint

Before executing Veeam actions, verify the proxy status and authentication key by hitting the gateway's status endpoint. This provides a quick connection health check:

- **Endpoint**: `GET /api/status` (via the proxy URL)
- **Headers**:
  - `Authorization: Bearer <your_proxy_api_key>`
- **Expected Response**:
  ```json
  {
    "veeamConfigured": true,
    "veeamUrl": "https://192.168.0.238:9419",
    "connectionStatus": "Connected",
    "error": null
  }
  ```

---

## Step 2: Discover API Endpoints (Avoid Context Pollution)

Instead of loading the entire 2.7MB OpenAPI schema into the context, search and inspect endpoints dynamically:

1.  **Search Endpoints**: Use the search CLI helper script inside the skill's directory:
    ```bash
    python3 <skill_dir>/veeam_search.py search "jobs"
    ```
2.  **Inspect Payload Schema**: To construct requests, inspect the exact route signature. The CLI tool auto-detects the HTTP method if you pass only the path:
    ```bash
    python3 <skill_dir>/veeam_search.py inspect /api/v1/jobs
    # Or force a specific method:
    python3 <skill_dir>/veeam_search.py inspect POST /api/v1/jobs
    ```
3.  **Fetch Full Schema (Optional)**: If you need the raw schema file, query the proxy directly:
    - `GET /api/swagger.json` (requires proxy API key header)

---

## Step 3: Query Veeam via the Proxy

All Veeam requests must be routed through the proxy gateway. Choose the base URL based on where you are running:

### Connection URLs
* **In-Cluster** (e.g., if you are running as an Atelier pod/Hermes):
  - Base proxy URL: `http://veeam-gateway.atelier.svc.cluster.local:8080`
* **External Client** (e.g., local CLI, Claude Desktop):
  - Base proxy URL: `http://atelier.home.arpa/apps/veeam-gateway`

All forwarded Veeam endpoints are prefixed with `/veeam` on the proxy.
- **Example**: `GET <proxy_base_url>/veeam/api/v1/backupInfrastructure/repositories`

---

## Step 4: Access Control & Veeam Permissions

1.  **Proxy Role Enforcement**:
    - **Viewer**: Only allowed read-only (`GET`) requests.
    - **Operator**: Allowed `GET` requests, and `POST` requests ending in `/start`, `/stop`, `/retry`, `/enable`, `/disable`, `/backup`, `/restore` or restore tasks.
    - **Admin**: Unrestricted proxy access (except globally blocked paths).
    - **Global Blocks**: All `DELETE` endpoints are globally blocked.
2.  **Veeam Server Role Enforcement**:
    - Even if the proxy allows a request (e.g., a `GET` request under the Viewer role), the backend Veeam Backup server may return a `403 Forbidden` if the configured credentials (such as user `ed`) lack permission for that resource. 
    - E.g., user `ed` is a restricted operator/viewer who gets a `403` on `GET /api/v1/jobs` but can successfully run `GET /api/v1/backupInfrastructure/repositories`.
