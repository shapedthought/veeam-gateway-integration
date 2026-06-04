---
name: veeam-v13
description: >-
  Interact with Veeam v13 Backup & Replication REST API via secure proxy.
  Allows querying backup infrastructure status, managing backup repositories,
  jobs, and executing operations like starting, stopping, or retrying backups.
  Contains search tools to lookup swagger schemas dynamically.
---

# Veeam v13 Backup & Replication Custom Skill

This skill allows you to securely interact with a Veeam Backup & Replication v13 environment through a secure proxy. The proxy holds the actual Veeam server credentials, provides audit logs, and filters requests according to a dynamic Policy-Based Access Rule system (similar to Azure Security Groups) and global safety rules.

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

### Choosing which Veeam server (multi-VBR)

The gateway can front **multiple** Veeam Backup & Replication servers, and every request resolves to exactly one:

* **Default server** — a path beginning `/veeam/api/…` goes to your key's **default** server (or the system default if the key has none). This is the common case; you don't name the server.
* **Explicit server** — to target a specific one, insert its **slug** right after `/veeam`:
  `GET <proxy_base_url>/veeam/<slug>/api/v1/jobs`. (Real Veeam paths always start with `/api`, so any other first segment is read as a server slug.)
* **Discover servers** — `GET <proxy_base_url>/api/servers` lists configured servers (`slug`, `name`, `url` — never credentials). Use it to learn which slugs you can address.
* **Unknown slug** → `404` (`Veeam server '<slug>' is not configured`).

Authorization is enforced **per server**, so a `403` can mean your key is permitted on one VBR but not another (see Step 4).

---

## Step 4: Policy-Based Access Rules & Permissions Hierarchy

The proxy evaluates incoming request authorization using a **Policy-Based Access Rule system** mapped to Users and Groups:

1.  **Authorization Evaluation Hierarchy**:
    - **Global Override Rules**: Check first. If a request matches any System-wide Global Block Rule, it is blocked immediately (**403 Forbidden**).
    - **Explicit Deny Rules**: Check next. If a request matches **any** group-level `DENY` rule for the caller's assigned groups, it is blocked immediately (**403 Forbidden**).
    - **Explicit Allow Rules**: Check next. If a request matches **at least one** group-level `ALLOW` rule, it is allowed and forwarded.
    - **Default Deny**: If a request does not match any allow rules, it is blocked by default (**403 Forbidden**).

2.  **Wildcard Matching (Globs)**:
    - Rules use wildcard patterns for paths (e.g., `/api/v1/jobs/*` matches `/api/v1/jobs/123-abc` and `GET` or `POST` or `*` for all methods).

3.  **Troubleshooting `403 Forbidden` Errors**:
    - If a request fails with `403 Forbidden` from the gateway, read the JSON error body:
      - **"Blocked by system-wide global rule..."**: System policy forbids this action. Do not retry.
      - **"Access Denied: Request is explicitly blocked by group rule..."**: Your user's group policies explicitly deny this action.
      - **"Access Denied: No matching ALLOW rule found..."**: Default Deny. The proxy does not have an active policy permitting this endpoint. Report the exact request details (Method + Path) to the system administrator to request an appropriate ALLOW rule.
    - **Veeam Server Error fallback**: Even if the proxy allows a request, the Veeam server itself might return a 403 or 401 if the configured target credentials lack authorization in the Veeam console.
