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

## Step 1: Discover API Endpoints (Avoid Context Pollution)

Instead of loading the entire 2.7MB OpenAPI schema into the context, use the local Python CLI helper script inside the skill directory to dynamically search and inspect endpoints.

1.  **Search Endpoints**: Find the exact paths and operations by query keywords (e.g., `jobs`, `repositories`, `restore`):
    ```bash
    python3 /Users/edwardhoward/.gemini/antigravity/skills/veeam-v13/veeam_search.py search "jobs"
    ```

2.  **Inspect Payload Schema**: To construct a query parameter list or JSON request body, inspect the exact route signature and components:
    ```bash
    python3 /Users/edwardhoward/.gemini/antigravity/skills/veeam-v13/veeam_search.py inspect POST /api/v1/jobs
    ```

## Step 2: Query Veeam via the Proxy

All Veeam requests must be routed through the Atelier proxy gateway. Do not access the Veeam server directly.

### Request Format
-   **Base URL**: Use the deployed Atelier app route followed by `/veeam` (e.g. `http://veeam-proxy.atelier.home.arpa/veeam` or `http://localhost:8080/veeam`).
-   **Headers**:
    -   `Authorization: Bearer <your_proxy_api_key>`
    -   `Content-Type: application/json`

### Example Calls

1.  **Get All Backup Jobs (GET)**:
    ```bash
    curl -s -X GET "http://veeam-proxy.atelier.home.arpa/veeam/api/v1/jobs" \
      -H "Authorization: Bearer <your_proxy_api_key>"
    ```

2.  **Start a Backup Job (POST)**:
    ```bash
    curl -s -X POST "http://veeam-proxy.atelier.home.arpa/veeam/api/v1/jobs/{id}/start" \
      -H "Authorization: Bearer <your_proxy_api_key>"
    ```

## Step 3: Access Control & Safety Rules

-   **Viewer**: Can only execute `GET` requests. Any write operations (`POST`, `PUT`, `DELETE`) will be rejected with `403 Forbidden`.
-   **Operator**: Can execute `GET` requests, and `POST` requests to trigger execution endpoints ending in `/start`, `/stop`, `/retry`, `/enable`, `/disable`, `/backup`, `/restore` or restore tasks. Other creation/edit paths are blocked.
-   **Admin**: Can run all operations, except globally blocked operations.
-   **Global Blocks**: By default, all `DELETE` operations are globally blocked for all roles.
