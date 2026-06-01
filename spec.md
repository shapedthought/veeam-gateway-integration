# Veeam Secure Gateway & AI Skill — Build Specification

This document specifies **what** the two artifacts in this repository must do and
which guarantees they must preserve — independent of the language, framework, or
storage engine used to build them. It exists so you can build your **own** version
of the tool (different stack, different host, folded into existing infrastructure)
instead of running the pre-baked reference implementation in this repo.

> **Read this as a contract, not a tutorial.** The pre-baked version
> ([`gateway/`](gateway/), [`skills/veeam-v13/`](skills/veeam-v13/)) is Node/Express +
> SQLite + React. That stack is incidental. The parts that matter — and that this
> spec pins down — are the **interface** between the two artifacts and the
> **security invariants** of the gateway. The code in [`gateway/server.js`](gateway/server.js)
> is the source of truth for mechanics; this spec is the source of truth for *intent*.

Requirement levels use **MUST** / **SHOULD** / **MAY** in the RFC 2119 sense.
Sections marked **🔒 SECURITY INVARIANT** are non-negotiable: an implementation that
violates one is not a conformant gateway, even if it appears to work.

---

## 1. Purpose & threat model

The system lets an AI agent operate a **Veeam Backup & Replication v13** environment
through its REST API **without ever holding the Veeam credentials** and **without
unrestricted access** to the backup infrastructure. A proxy gateway sits between the
agent and Veeam; the agent authenticates to the proxy with revocable, scoped API
keys, and the proxy authenticates to Veeam on the agent's behalf.

**Protects against:**

- **Credential exposure** — the Veeam username/password never reach the client; a
  leaked client key is revocable and grants only its scoped permissions.
- **Path injection / API abuse** — only paths that exist in the Veeam OpenAPI schema
  are forwardable; arbitrary URLs are rejected.
- **Over-privileged agents** — every request is authorized against per-identity
  allow/deny policy plus a system-wide blocklist before it reaches Veeam.
- **Credential theft at rest** — the stored Veeam password is encrypted in the
  gateway's datastore.

**Explicitly out of scope** (the operator is responsible for these):

- Network-level protection of the gateway↔Veeam link and the datastore volume.
- Transport security (TLS termination) in front of the gateway.
- The trustworthiness of the Veeam credentials' own role inside Veeam — the gateway
  constrains *which API calls* are made, not what the underlying Veeam account can do.

---

## 2. System overview

Two artifacts with a single defined seam between them:

```
┌────────────┐   Authorization: Bearer <proxy_api_key>   ┌──────────────┐   OAuth2 + bearer    ┌─────────────┐
│  AI Agent  │ ────────────────────────────────────────► │   Gateway    │ ───────────────────► │  Veeam v13  │
│  (Skill)   │      GET /api/status                       │   (Proxy)    │   x-api-version 1.3   │  REST API   │
│            │      /veeam/<veeam-path>                   │              │                       │  :9419      │
└────────────┘ ◄──────────────────────────────────────── └──────────────┘ ◄─────────────────── └─────────────┘
                    forwarded Veeam response                  audit + authz
```

- **Gateway** (§3–§6) — the secure proxy and its control plane. Holds the Veeam
  credentials, mints/validates client keys, enforces policy, logs an audit trail.
- **Skill** (§7) — the instructions + tooling an agent loads to discover Veeam
  endpoints and call them through the gateway. Holds **no** credentials of its own
  beyond a single proxy API key supplied to it.

Either side MAY be reimplemented independently as long as the §3 interface holds.

---

## 3. Interface contract (the skill ↔ gateway seam)

This is the highest-leverage part of the spec: conform to it and the two halves are
swappable.

### 3.1 Client authentication

- Every client request to the gateway MUST carry `Authorization: Bearer <key>`.
- Client keys are opaque strings. The reference implementation prefixes proxy keys
  with `veeam_vproxy_` for recognizability; this is a convention, not a requirement.
- A missing/invalid/revoked/expired key MUST yield **401**. An authenticated key that
  is not permitted the request MUST yield **403** (see §4.2). The two MUST be
  distinguishable by status code.

### 3.2 The proxy surface — `/veeam/*`

- The gateway MUST expose a catch-all under a **`/veeam` prefix**. A request to
  `/veeam/<veeam-path>` is authorized and, if allowed, forwarded to
  `<veeam-base-url>/<veeam-path>` with the gateway's Veeam bearer token attached.
- The gateway MUST forward the HTTP method, query string, and (for write methods) the
  request body unchanged, and MUST relay Veeam's status code and body back to the
  client (it MUST NOT collapse Veeam error codes into 200).
- The client MUST NOT need to know the Veeam base URL, credentials, or API version.

### 3.3 The health surface — `GET /api/status`

- MUST return whether Veeam is configured and reachable, without leaking secrets.
  Reference shape:
  ```json
  { "veeamConfigured": true, "veeamUrl": "https://…:9419",
    "connectionStatus": "Connected" | "Disconnected" | "Error", "error": null }
  ```
- This is the agent's smoke test before issuing real calls.

### 3.4 Schema discovery — `GET /api/swagger.json`

- The gateway SHOULD serve the Veeam OpenAPI schema to authenticated clients so a
  skill can discover endpoints dynamically rather than embedding a multi-MB spec.

### 3.5 Error semantics

- Authorization failures MUST return a JSON body whose message distinguishes the
  cause, so an agent can decide whether to retry or escalate. The reference
  implementation uses three distinct 403 messages: blocked by a system-wide global
  rule; blocked by an explicit group DENY; and default-deny (no matching ALLOW). An
  implementation SHOULD preserve this three-way distinction.

---

## 4. Gateway security invariants 🔒

These define a conformant gateway. **All are MUST.**

### 4.1 Credential isolation 🔒 SECURITY INVARIANT

- Veeam credentials MUST live only on the gateway and MUST NOT be returned to any
  client by any endpoint. The settings-read endpoint (§6) MUST report only whether a
  password is set (e.g. `hasPassword: true`), never the value.
- The gateway MUST exchange the stored username/password for a short-lived Veeam
  session token and attach **that** to forwarded requests — clients never see it.

### 4.2 Authorization precedence 🔒 SECURITY INVARIANT

For every `/veeam/*` request, the gateway MUST evaluate authorization in this exact
order and stop at the first decision:

1. **Global blocklist** — if the request matches any system-wide block rule
   (method + path-glob), **deny (403)**. This overrides everything, including admins.
2. **Explicit DENY** — if any policy rule attached to the caller's identity is a
   `DENY` matching the request, **deny (403)**. A DENY MUST override any ALLOW.
3. **Explicit ALLOW** — if at least one attached rule is an `ALLOW` matching the
   request, **permit** and forward.
4. **Default deny** — otherwise **deny (403)**. Absence of a matching ALLOW is a
   denial, never a permit. A key with no associated identity MUST be denied here.

Method matching MUST support a wildcard (`*` = any method). Path matching MUST support
glob wildcards (e.g. `/api/v1/jobs/*` matches `/api/v1/jobs/<id>`).

### 4.3 Endpoint validation 🔒 SECURITY INVARIANT

- Before forwarding, the gateway MUST validate the target path **and** method against
  the Veeam OpenAPI schema. An unknown path MUST yield **404**; a known path with a
  disallowed method MUST yield **405**. This is the anti-path-injection control and
  runs **before** the request reaches Veeam.
- If the schema cannot be loaded, the implementation MUST fail safe per its documented
  posture. (The reference implementation logs a warning and bypasses validation — a
  permissive choice an operator should be aware of and MAY tighten.)

### 4.4 Encryption at rest 🔒 SECURITY INVARIANT

- The Veeam password MUST be stored encrypted with an authenticated cipher. The
  reference implementation uses **AES-256-GCM**, storing `iv:authTag:ciphertext`
  (12-byte IV), with the key derived as `SHA-256(ENCRYPTION_KEY)` and a documented
  fallback chain. Any conformant implementation MUST use authenticated encryption and
  MUST NOT store the password in plaintext.
- It SHOULD support transparent migration of a pre-existing plaintext value to the
  encrypted form on read.

### 4.5 Key handling 🔒 SECURITY INVARIANT

- Client keys MUST be stored as a one-way hash (reference: SHA-256), never reversibly.
  Only a masked form MAY be persisted for display.
- A full key MUST be shown to the operator exactly once at creation and never
  retrievable again.
- Keys MUST be independently revocable; revocation MUST take effect immediately.
- The gateway SHOULD support per-key **expiry** and per-key **IP/CIDR allowlists**, and
  when set, MUST enforce them during authentication (expired → 401; disallowed IP →
  403).

### 4.6 Audit 🔒 SECURITY INVARIANT

- The gateway MUST append an audit record for every authorization decision and every
  forwarded request, capturing at minimum: timestamp, key identity, method, path,
  resulting status, client IP, and a human-readable message. Denials MUST be logged
  with their reason. Audit records SHOULD survive restarts (persistent store).

---

## 5. Behavioral spec (SHOULD)

Stable behaviors that make the gateway usable; reimplement faithfully but with
latitude over mechanics.

### 5.1 Veeam session lifecycle

- Acquire a Veeam token via the OAuth2 token endpoint using the password grant;
  cache it in memory with its expiry and reuse it across requests (refresh ahead of
  expiry with a safety skew — reference: 60s). Use the refresh-token grant when
  available and fall back to a full re-auth if refresh fails.
- Send the Veeam API version header the target expects (reference: `x-api-version:
  1.3-rev1`). Self-signed Veeam certificates are common; the operator decides the TLS
  verification posture for the gateway→Veeam hop (the reference disables verification —
  a deliberate, documented tradeoff for lab/self-signed use).

### 5.2 Identity & policy model

- **Identities (users)** own **keys** and belong to **groups**. A group carries an
  ordered-by-effect set of **rules** (`ALLOW`/`DENY`, method, path-glob). A user's
  effective policy is the union of their groups' rules, evaluated per §4.2.
- **Admin** is not merely a flag: an identity is administrative if it belongs to a
  group holding the wildcard `ALLOW * *` rule. Control-plane mutations (§6) MUST be
  restricted to admins.
- A separate **global blocklist** (method + path-glob + description) is the
  system-wide override of §4.2 step 1.

### 5.3 Seed / first-run state

A fresh datastore SHOULD self-seed to a safe, usable baseline:

- an `admin` identity and an `Administrators` group holding `ALLOW * *`;
- a default global rule **blocking `DELETE *`** (destructive ops off by default);
- one initial admin key, surfaced to the operator exactly once.

Configuration MAY be seeded from environment on first run, after which the datastore
is authoritative.

### 5.4 Persistence

- State that must survive restarts (keys, identities, policy, config, audit) MUST be
  persisted. In a containerized deployment this MUST live on a mounted volume, not the
  ephemeral container filesystem.

---

## 6. Control-plane API surface (admin)

The reference implementation exposes the following under `/api/*`, all requiring an
admin caller except `/api/status`. Reimplementations MAY reshape these but MUST keep
the §4 invariants (especially: config-read never returns the password).

| Concern | Operations |
|---|---|
| Status | `GET /api/status` (any authenticated key) |
| Veeam config | `GET /api/config` (returns `hasPassword`, **never** the password) · `POST /api/config` |
| Client keys | `GET /api/keys` · `POST /api/keys` · `POST /api/keys/{id}/revoke` |
| Identities | `GET/POST /api/users` · `PUT /api/users/{id}/groups` · `DELETE /api/users/{id}` |
| Groups & rules | `GET/POST /api/groups` · `DELETE /api/groups/{id}` |
| Global blocklist | `GET/POST /api/rules` · `DELETE /api/rules/{id}` |
| Audit | `GET /api/logs` |
| Schema | `GET /api/swagger.json` |

A management UI is OPTIONAL; the reference ships a React dashboard over these
endpoints, but the API is the contract.

---

## 7. The skill (agent side)

The skill equips an agent to use the gateway. It is a directory containing an
instruction document plus optional tooling. Requirements:

- **Health first** — instruct the agent to call `GET /api/status` before issuing
  Veeam calls.
- **Discover, don't embed** — provide a way to search/inspect the Veeam OpenAPI schema
  locally (the reference ships `veeam_search.py` with `search` and `inspect`
  subcommands that resolve `$ref`s) rather than loading the multi-MB spec into context.
  Fall back to `GET /api/swagger.json` for the raw schema.
- **Call through the proxy** — all Veeam calls go to `<proxy-base>/veeam/<veeam-path>`
  with the `Authorization: Bearer <proxy_api_key>` header; never directly to Veeam.
- **Document both base URLs** — in-cluster vs. external reach the gateway at different
  addresses; the skill MUST tell the agent how to choose.
- **Teach the 403 taxonomy** — map the three denial reasons (§3.5) to agent actions:
  global block → do not retry; explicit DENY → do not retry, escalate; default-deny →
  request an ALLOW rule from an admin. A Veeam-side 401/403 (vs. gateway-side) means
  the Veeam account itself lacks the permission.

The skill holds exactly one secret: the proxy API key. It MUST NOT contain Veeam
credentials.

---

## 8. Building your own

1. **Pick your stack.** Anything that can run an HTTP reverse proxy with a datastore.
   Satisfy §3 (interface) and §4 (invariants); §5–§7 guide the rest.
2. **Start from the invariants, not the UI.** The dashboard is the easy, replaceable
   part. The authz precedence (§4.2), endpoint validation (§4.3), and credential
   handling (§4.1/§4.4/§4.5) are where a reimplementation goes wrong — build and test
   those first, including the negative cases (default-deny, DENY-over-ALLOW, unknown
   path → 404, plaintext-password rejection).
3. **Generate it, if you like.** Because this spec is stack-agnostic and contract-first,
   it can be fed to a coding agent or to an Atelier `classic`/`orchestrator` build to
   produce a variant. If you do, treat §4 as acceptance criteria, not suggestions.
4. **Conformance checklist** — a build is conformant when: credentials never leave the
   gateway; authz follows the §4.2 order with default-deny; non-schema paths are
   rejected pre-forward; the password is stored only under authenticated encryption;
   keys are hashed, revocable, shown once; and every decision is audited.

The pre-baked reference satisfying all of the above lives in [`gateway/`](gateway/)
and [`skills/veeam-v13/`](skills/veeam-v13/); see [`CLAUDE.md`](CLAUDE.md) for its
architecture and [`gateway/README.md`](gateway/README.md) for its security details.
