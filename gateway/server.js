import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Initialize SQLite DB (persistent /data in production, local in development)
const dbPath = process.env.NODE_ENV === 'production'
  ? '/data/database.sqlite'
  : path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Helper function to hash tokens
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// --- Symmetric Encryption & Decryption Helpers ---
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.ADMIN_API_KEY || 'veeam-gateway-default-fallback-key-2026';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(cipherText) {
  if (!cipherText) return '';
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    // Legacy plaintext fallback
    return cipherText;
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.warn('[SECURITY] Failed to decrypt value. Falling back to treating as plaintext.', err.message);
    return cipherText;
  }
}

// Promisified DB calls
const dbRun = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// --- Veeam Connection Configuration in DB ---
const DEFAULT_VEEAM_API_VERSION = '1.3-rev1';
let veeamConfig = {
  url: process.env.VEEAM_API_URL || '',
  username: process.env.VEEAM_USERNAME || '',
  password: process.env.VEEAM_PASSWORD || '',
  apiVersion: process.env.VEEAM_API_VERSION || DEFAULT_VEEAM_API_VERSION
};

async function loadVeeamConfigFromDb() {
  try {
    const rows = await dbAll('SELECT key, value FROM veeam_config');
    for (const row of rows) {
      if (row.key === 'veeam_url') veeamConfig.url = row.value;
      if (row.key === 'veeam_username') veeamConfig.username = row.value;
      if (row.key === 'veeam_api_version' && row.value) veeamConfig.apiVersion = row.value;
      if (row.key === 'veeam_password') {
        const decrypted = decrypt(row.value);
        veeamConfig.password = decrypted;
        
        // Auto-migration: if the stored database value was legacy plaintext, update it to encrypted format
        if (decrypted && row.value.split(':').length !== 3) {
          const encryptedValue = encrypt(decrypted);
          dbRun('INSERT OR REPLACE INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_password', encryptedValue])
            .then(() => console.log('[CONFIG] Legacy plaintext Veeam password automatically migrated to encrypted format in DB.'))
            .catch(err => console.error('[CONFIG] Failed to migrate legacy password:', err.message));
        }
      }
    }
    console.log('[CONFIG] Veeam connection config loaded from DB. URL:', veeamConfig.url || 'Not set');
  } catch (err) {
    console.error('[CONFIG] Error loading config from DB:', err.message);
  }
}

// --- Multi-VBR server model ---
// Each Veeam Backup & Replication server the gateway can proxy to is a row in
// veeam_servers. Loaded into memory here; `veeamConfig` above is kept pointed at
// the default server purely for back-compat with the single-connection code paths.
let servers = new Map(); // id -> { id, slug, name, url, username, password, apiVersion, isDefault }
let defaultServerId = null;

function publicServer(s) {
  return { id: s.id, slug: s.slug, name: s.name, url: s.url, username: s.username, hasPassword: !!s.password, apiVersion: s.apiVersion, isDefault: s.isDefault };
}
function getDefaultServer() {
  return (defaultServerId && servers.get(defaultServerId)) || null;
}
function getServerForKey(keyInfo) {
  if (keyInfo && keyInfo.defaultServerId && servers.has(keyInfo.defaultServerId)) return servers.get(keyInfo.defaultServerId);
  return getDefaultServer();
}
function getServerBySlug(slug) {
  for (const s of servers.values()) if (s.slug === slug) return s;
  return null;
}

async function loadServersFromDb() {
  try {
    const rows = await dbAll('SELECT * FROM veeam_servers');
    const next = new Map();
    let def = null;
    for (const r of rows) {
      const password = decrypt(r.password || '');
      // Auto-migrate a legacy plaintext password to encrypted-at-rest form. Encrypted
      // values have the 3-part iv:authTag:ciphertext shape; anything else is plaintext
      // (key off the part count so passwords containing ':' still get migrated).
      if (password && (r.password || '').split(':').length !== 3) {
        dbRun('UPDATE veeam_servers SET password = ? WHERE id = ?', [encrypt(password), r.id]).catch(() => {});
      }
      next.set(r.id, { id: r.id, slug: r.slug, name: r.name, url: r.url, username: r.username, password, apiVersion: r.api_version || DEFAULT_VEEAM_API_VERSION, isDefault: !!r.is_default });
      if (r.is_default) def = r.id;
    }
    servers = next;
    defaultServerId = def || (rows[0] && rows[0].id) || null;
    const d = getDefaultServer();
    if (d) veeamConfig = { url: d.url, username: d.username, password: d.password, apiVersion: d.apiVersion };
    console.log(`[CONFIG] Loaded ${servers.size} Veeam server(s). Default: ${getDefaultServer()?.slug || 'none'}`);
  } catch (err) {
    console.error('[CONFIG] Error loading servers from DB:', err.message);
  }
}

async function addColumnIfMissing(table, column, type) {
  try {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`[DB] Column ${column} added to table ${table}`);
  } catch (err) {
    if (err.message.includes('duplicate column name') || err.message.includes('already exists')) {
      // Column already exists, safe to ignore
    } else {
      console.warn(`[DB] Warning: could not add column ${column} to table ${table}:`, err.message);
    }
  }
}

// Database Initialization
async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS veeam_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Seed veeam_config from env if empty
  const configCount = await dbGet('SELECT count(*) as count FROM veeam_config');
  if (configCount.count === 0) {
    if (process.env.VEEAM_API_URL) await dbRun('INSERT INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_url', process.env.VEEAM_API_URL]);
    if (process.env.VEEAM_USERNAME) await dbRun('INSERT INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_username', process.env.VEEAM_USERNAME]);
    if (process.env.VEEAM_PASSWORD) {
      const encryptedValue = encrypt(process.env.VEEAM_PASSWORD);
      await dbRun('INSERT INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_password', encryptedValue]);
    }
    if (process.env.VEEAM_API_VERSION) await dbRun('INSERT INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_api_version', process.env.VEEAM_API_VERSION]);
    console.log('[DB] Seeded veeam_config from environment variables');
  }

  // Load configuration into memory
  await loadVeeamConfigFromDb();

  // --- Multi-VBR: servers table (supersedes the single veeam_config) ---
  await dbRun(`
    CREATE TABLE IF NOT EXISTS veeam_servers (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT,
      api_version TEXT NOT NULL DEFAULT '1.3-rev1',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // One-time migration: fold the existing single connection into a 'default' server.
  const serverCount = await dbGet('SELECT count(*) as count FROM veeam_servers');
  if (serverCount.count === 0 && veeamConfig.url) {
    await dbRun(
      'INSERT INTO veeam_servers (id, slug, name, url, username, password, api_version, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [crypto.randomUUID(), 'default', 'Default', veeamConfig.url, veeamConfig.username, encrypt(veeamConfig.password || ''), veeamConfig.apiVersion || DEFAULT_VEEAM_API_VERSION, new Date().toISOString()]
    );
    console.log('[DB] Migrated existing Veeam connection into a default server');
  }

  await loadServersFromDb();

  // Create Users & Groups tables
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS group_rules (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      effect TEXT NOT NULL,
      method TEXT NOT NULL,
      path_pattern TEXT NOT NULL,
      description TEXT,
      FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_groups (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      PRIMARY KEY (user_id, group_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      token_masked TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT,
      allowed_ips TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS global_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      path_pattern TEXT NOT NULL,
      action TEXT NOT NULL,
      description TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      key_id TEXT,
      key_name TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      message TEXT,
      client_ip TEXT,
      action TEXT,
      resource TEXT
    )
  `);

  // Dynamic alter-table migrations for existing DBs
  await addColumnIfMissing('api_keys', 'user_id', 'TEXT');
  await addColumnIfMissing('api_keys', 'expires_at', 'TEXT');
  await addColumnIfMissing('api_keys', 'allowed_ips', 'TEXT');
  await addColumnIfMissing('api_keys', 'default_server_id', 'TEXT');
  await addColumnIfMissing('audit_logs', 'client_ip', 'TEXT');
  await addColumnIfMissing('audit_logs', 'action', 'TEXT');
  await addColumnIfMissing('audit_logs', 'resource', 'TEXT');
  await addColumnIfMissing('audit_logs', 'server', 'TEXT');
  await addColumnIfMissing('group_rules', 'server_id', 'TEXT');

  // Seed default admin user
  const userCount = await dbGet('SELECT count(*) as count FROM users');
  if (userCount.count === 0) {
    const adminId = 'admin-user-id-000000000000000000000000';
    await dbRun('INSERT OR IGNORE INTO users (id, username, email, created_at) VALUES (?, ?, ?, ?)', [
      adminId, 'admin', 'admin@local', new Date().toISOString()
    ]);
    console.log('[DB] Seeded default admin user');
  }

  // Seed default Administrators group & wildcard ALLOW rule
  const groupCount = await dbGet('SELECT count(*) as count FROM groups');
  if (groupCount.count === 0) {
    const adminGroupId = 'admin-group-id-0000000000000000000000';
    await dbRun('INSERT OR IGNORE INTO groups (id, name, description) VALUES (?, ?, ?)', [
      adminGroupId, 'Administrators', 'System administrators with full wildcard access'
    ]);
    
    await dbRun('INSERT OR IGNORE INTO group_rules (id, group_id, effect, method, path_pattern, description) VALUES (?, ?, ?, ?, ?, ?)', [
      'admin-rule-id-wildcard-0000000000000', adminGroupId, 'ALLOW', '*', '*', 'Allow all endpoints'
    ]);

    const adminUser = await dbGet("SELECT id FROM users WHERE username = 'admin'");
    if (adminUser) {
      await dbRun('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)', [
        adminUser.id, adminGroupId
      ]);
    }
    console.log('[DB] Seeded default Administrators group, rules, and linked admin user');
  }

  // Link all existing keys that have empty user_id to admin user
  const adminUser = await dbGet("SELECT id FROM users WHERE username = 'admin'");
  if (adminUser) {
    await dbRun('UPDATE api_keys SET user_id = ? WHERE user_id IS NULL OR user_id = ?', [adminUser.id, '']);
  }

  // Ensure a read-only "Dashboard Viewers" group exists (idempotent across upgrades).
  // It has NO rules, so its members are default-denied on every /veeam call — bind a
  // Viewer key's user here for "read the console, touch nothing" end to end.
  const viewerGroup = await dbGet("SELECT id FROM groups WHERE name = 'Dashboard Viewers'");
  if (!viewerGroup) {
    await dbRun('INSERT INTO groups (id, name, description) VALUES (?, ?, ?)', [
      crypto.randomUUID(), 'Dashboard Viewers',
      'Read-only console access with no Veeam API permissions (default-deny on all /veeam calls).'
    ]);
    console.log('[DB] Ensured Dashboard Viewers group (no Veeam access)');
  }

  // Seed default global rule to block DELETE if empty
  const ruleCount = await dbGet('SELECT count(*) as count FROM global_rules');
  if (ruleCount.count === 0) {
    await dbRun(
      'INSERT INTO global_rules (method, path_pattern, action, description) VALUES (?, ?, ?, ?)',
      ['DELETE', '*', 'block', 'Globally block all DELETE operations']
    );
    console.log('[DB] Seeded default global rule: block all DELETE operations');
  }

  // Seed default Admin key if empty
  const keyCount = await dbGet('SELECT count(*) as count FROM api_keys');
  if (keyCount.count === 0) {
    const defaultToken = process.env.ADMIN_API_KEY || ('veeam_vproxy_' + crypto.randomBytes(24).toString('hex'));
    const defaultHash = hashToken(defaultToken);
    const defaultMasked = defaultToken.substring(0, 13) + '...' + defaultToken.substring(defaultToken.length - 4);
    const keyId = crypto.randomUUID();
    const now = new Date().toISOString();
    const keyUserId = adminUser ? adminUser.id : 'admin-user-id-000000000000000000000000';

    await dbRun(
      'INSERT INTO api_keys (id, name, user_id, token_hash, token_masked, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [keyId, 'Default Admin', keyUserId, defaultHash, defaultMasked, 'Admin', 'active', now]
    );

    console.log('\n==================================================');
    console.log('[SETUP] SEEDED INITIAL ADMIN API KEY:');
    console.log(`[SETUP] Key Name: Default Admin`);
    console.log(`[SETUP] Token   : ${defaultToken}`);
    console.log('[SETUP] IMPORTANT: Copy this token now. It will not be shown again.');
    console.log('==================================================\n');
  }
}

// Action & Resource Parser Helper for Audit Logs
function parseVeeamActionAndResource(method, veeamPath) {
  let action = `${method.toUpperCase()}_API_PATH`;
  let resource = 'General';

  // Normalize path by removing trailing slash
  const cleanPath = veeamPath.endsWith('/') ? veeamPath.slice(0, -1) : veeamPath;

  if (cleanPath.startsWith('/api/v1/jobs')) {
    const parts = cleanPath.split('/');
    if (parts.length === 5 && cleanPath.endsWith('/start')) {
      action = 'START_JOB';
      resource = `Job ID: ${parts[3]}`;
    } else if (parts.length === 5 && cleanPath.endsWith('/stop')) {
      action = 'STOP_JOB';
      resource = `Job ID: ${parts[3]}`;
    } else if (parts.length === 5 && cleanPath.endsWith('/retry')) {
      action = 'RETRY_JOB';
      resource = `Job ID: ${parts[3]}`;
    } else if (method === 'GET' && parts.length === 4) {
      action = 'GET_JOB';
      resource = `Job ID: ${parts[3]}`;
    } else if (method === 'GET') {
      action = 'LIST_JOBS';
      resource = 'All Jobs';
    } else if (method === 'POST') {
      action = 'CREATE_JOB';
      resource = 'New Job';
    } else if (method === 'PUT') {
      action = 'UPDATE_JOB';
      resource = `Job ID: ${parts[3]}`;
    } else if (method === 'DELETE') {
      action = 'DELETE_JOB';
      resource = `Job ID: ${parts[3]}`;
    }
  } else if (cleanPath.startsWith('/api/v1/backupInfrastructure/repositories')) {
    const parts = cleanPath.split('/');
    if (method === 'GET' && parts.length === 5) {
      action = 'GET_REPOSITORY';
      resource = `Repo ID: ${parts[4]}`;
    } else if (method === 'GET') {
      action = 'LIST_REPOSITORIES';
      resource = 'All Repositories';
    } else if (method === 'POST') {
      action = 'ADD_REPOSITORY';
      resource = 'New Repository';
    } else if (method === 'DELETE') {
      action = 'REMOVE_REPOSITORY';
      resource = `Repo ID: ${parts[4]}`;
    }
  } else if (cleanPath.startsWith('/api/v1/backupObjects')) {
    action = 'GET_BACKUP_OBJECTS';
    resource = 'Backup Objects';
  } else if (cleanPath.startsWith('/api/status')) {
    action = 'CHECK_STATUS';
    resource = 'Gateway Status';
  } else if (cleanPath.startsWith('/api/config')) {
    action = 'UPDATE_CONFIG';
    resource = 'Veeam Credentials';
  }

  return { action, resource };
}

// Audit logger helper
async function logOperation(keyId, keyName, method, path, statusCode, message, req = null, serverLabel = null) {
  const now = new Date().toISOString();
  const clientIp = req ? getClientIp(req) : 'SYSTEM';

  // Normalize path
  const veeamPath = path.startsWith('/veeam') ? path.substring(6) : path;
  const { action, resource } = parseVeeamActionAndResource(method, veeamPath);

  try {
    await dbRun(
      'INSERT INTO audit_logs (timestamp, key_id, key_name, method, path, status_code, message, client_ip, action, resource, server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [now, keyId || 'SYSTEM', keyName || 'SYSTEM', method, path, statusCode, message, clientIp, action, resource, serverLabel]
    );
  } catch (err) {
    console.error('[LOGGER] Error writing audit log:', err.message);
  }
}

// --- Veeam API token cache (one entry per server) ---
const veeamTokens = new Map(); // serverId -> { accessToken, refreshToken, expiry }

// Disable SSL rejection for self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

function resetVeeamToken(serverId) {
  if (serverId) veeamTokens.delete(serverId); else veeamTokens.clear();
}

async function getVeeamToken(server) {
  if (!server || !server.url || !server.username || !server.password) {
    throw new Error('Veeam connection settings missing or not configured');
  }
  const now = Date.now();
  const cached = veeamTokens.get(server.id);
  if (cached && cached.accessToken && cached.expiry > now + 60000) {
    return cached.accessToken;
  }

  const refreshToken = cached && cached.refreshToken;
  try {
    const params = new URLSearchParams();
    if (refreshToken) {
      params.append('grant_type', 'Refresh_token');
      params.append('refresh_token', refreshToken);
    } else {
      params.append('grant_type', 'Password');
      params.append('username', server.username);
      params.append('password', server.password);
    }

    console.log(`[VEEAM-AUTH] Authenticating with Veeam '${server.slug}' at:`, `${server.url}/api/oauth2/token`);
    const response = await axios.post(`${server.url}/api/oauth2/token`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-version': server.apiVersion || DEFAULT_VEEAM_API_VERSION,
      },
      httpsAgent,
      timeout: 5000 // Fail fast if Veeam is unreachable
    });

    const expiresIn = response.data.expires_in || 3600;
    veeamTokens.set(server.id, {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      expiry: now + expiresIn * 1000
    });
    console.log(`[VEEAM-AUTH] Token acquired for '${server.slug}'. Expires in:`, expiresIn, 'seconds');
    return response.data.access_token;
  } catch (err) {
    console.error(`[VEEAM-AUTH] Error authenticating with Veeam '${server.slug}':`, err.response?.data || err.message);
    if (refreshToken) {
      // Refresh failed — drop it and retry with full credentials.
      console.log('[VEEAM-AUTH] Refresh token failed. Retrying with full credentials.');
      veeamTokens.delete(server.id);
      return getVeeamToken(server);
    }
    throw err;
  }
}

// --- Swagger Spec Route Validator ---
let swaggerRoutes = [];

function loadSwaggerRoutes() {
  try {
    const swaggerFilePath = path.join(__dirname, 'swagger.json');
    if (fs.existsSync(swaggerFilePath)) {
      const data = JSON.parse(fs.readFileSync(swaggerFilePath, 'utf8'));
      const paths = data.paths || {};
      for (const apiPath of Object.keys(paths)) {
        // Convert swagger route (e.g. /api/v1/jobs/{id}) to regex
        // Escape regex special characters first
        let regexPattern = apiPath.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // Replace {param} placeholders with [[^/]+] but properly escaped
        regexPattern = regexPattern.replace(/\\{[^}]+\\}/g, '[^/]+');
        const regex = new RegExp(`^${regexPattern}$`, 'i');
        
        const methods = Object.keys(paths[apiPath]).map(m => m.toUpperCase());
        swaggerRoutes.push({
          apiPath,
          regex,
          methods
        });
      }
      console.log(`[SWAGGER] Loaded and compiled ${swaggerRoutes.length} route definitions for runtime validation.`);
    } else {
      console.warn('[SWAGGER] Warning: swagger.json not found. Runtime validation will be bypassed.');
    }
  } catch (err) {
    console.error('[SWAGGER] Error parsing swagger.json:', err.message);
  }
}

loadSwaggerRoutes();

// --- Middlewares ---

// 3. Verify target path is a valid Veeam REST API endpoint pattern
function validateVeeamEndpoint(req, res, next) {
  const targetPath = req.veeamPath || (req.path.startsWith('/veeam') ? req.path.substring(6) : req.path);
  const method = req.method.toUpperCase();

  if (swaggerRoutes.length === 0) {
    return next();
  }

  // Find a matching route regex
  const matchedRoute = swaggerRoutes.find(r => r.regex.test(targetPath));

  if (!matchedRoute) {
    console.warn(`[VALIDATION-FAILED] Invalid endpoint pattern: ${method} ${targetPath}`);
    return res.status(404).json({
      error: 'Not Found',
      message: `The path '${targetPath}' is not a valid Veeam v13 REST API endpoint pattern according to the API schema.`
    });
  }

  if (!matchedRoute.methods.includes(method)) {
    console.warn(`[VALIDATION-FAILED] Invalid method: ${method} for endpoint ${targetPath}`);
    return res.status(405).json({
      error: 'Method Not Allowed',
      message: `The method '${method}' is not allowed for endpoint '${targetPath}'. Allowed methods: ${matchedRoute.methods.join(', ')}`
    });
  }

  next();
}

// Resolve which Veeam server a /veeam/* request targets, plus the Veeam path to forward.
// First segment 'api' (or empty) -> the key's default server (else the system default);
// otherwise the first segment is a server slug (real Veeam paths always start with /api).
function resolveTargetServer(req, res, next) {
  const afterVeeam = req.path.startsWith('/veeam') ? req.path.substring(6) : req.path;
  const segs = afterVeeam.split('/').filter(Boolean);
  if (segs.length === 0) {
    return res.status(404).json({ error: 'No Veeam path specified' });
  }
  let server, veeamPath;
  if (segs[0] === 'api') {
    server = getServerForKey(req.keyInfo);
    veeamPath = afterVeeam;
  } else {
    server = getServerBySlug(segs[0]);
    veeamPath = '/' + segs.slice(1).join('/');
  }
  if (!server) {
    const which = segs[0] === 'api' ? 'default' : `'${segs[0]}'`;
    return res.status(404).json({ error: `Veeam server ${which} is not configured` });
  }
  req.targetServer = server;
  req.veeamPath = veeamPath;
  next();
}

// IP Parsing Helpers
function getClientIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

function ipToInt(ip) {
  try {
    return ip.split('.').reduce((int, octet) => (int << 8) + parseInt(octet, 10), 0) >>> 0;
  } catch (e) {
    return 0;
  }
}

function cidrMatch(ip, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = ~(Math.pow(2, 32 - parseInt(bits)) - 1);
    const ipNum = ipToInt(ip);
    const rangeNum = ipToInt(range);
    return (ipNum & mask) === (rangeNum & mask);
  } catch (e) {
    return false;
  }
}

function ipMatches(clientIp, allowedIpsStr) {
  if (!allowedIpsStr) return true;
  const list = allowedIpsStr.split(',').map(item => item.trim());
  return list.some(pattern => {
    if (pattern === '*' || pattern === '') return true;
    if (pattern.includes('/')) {
      return cidrMatch(clientIp, pattern);
    }
    return pattern === clientIp;
  });
}

// 1. Verify Client API Key (Checks Expiry and IP restrictions)
async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header with Bearer token required' });
  }

  const token = authHeader.substring(7);
  const tokenHash = hashToken(token);

  // Fallback to environment variable configured Admin key
  if (process.env.ADMIN_API_KEY && token === process.env.ADMIN_API_KEY) {
    req.keyInfo = {
      id: 'env-admin-key',
      name: 'Env Admin',
      userId: 'admin-user-id-000000000000000000000000',
      role: 'Admin',
      defaultServerId: null
    };
    return next();
  }

  try {
    const keyRecord = await dbGet(
      "SELECT * FROM api_keys WHERE token_hash = ? AND status = 'active'",
      [tokenHash]
    );

    if (!keyRecord) {
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }

    // 1a. Expiration Check
    if (keyRecord.expires_at) {
      if (new Date(keyRecord.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ error: 'API key has expired' });
      }
    }

    // 1b. IP Restrictions Check
    const clientIp = getClientIp(req);
    if (keyRecord.allowed_ips && !ipMatches(clientIp, keyRecord.allowed_ips)) {
      return res.status(403).json({ error: `Access Denied: IP address ${clientIp} is not authorized for this API key` });
    }

    req.keyInfo = {
      id: keyRecord.id,
      name: keyRecord.name,
      userId: keyRecord.user_id,
      role: keyRecord.role || 'Admin',
      defaultServerId: keyRecord.default_server_id || null
    };
    next();
  } catch (err) {
    console.error('[AUTH] DB Error during authentication:', err);
    return res.status(500).json({ error: 'Internal database error' });
  }
}

// Helper to match path wildcard patterns (e.g., /api/v1/jobs/* matches /api/v1/jobs/123)
function pathMatchesPattern(reqPath, pattern) {
  if (pattern === '*') return true;
  // Escape regex specials except '*'
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*') + '$';
  const regex = new RegExp(regexStr, 'i');
  return regex.test(reqPath);
}

// 2. Validate Access Control Policies (Global & Policy-based Group Rules)
async function authorizeRequest(req, res, next) {
  const { method, path } = req;
  // Normalize the proxied Veeam path (set by resolveTargetServer; fall back to stripping '/veeam')
  const veeamPath = req.veeamPath || (path.startsWith('/veeam') ? path.substring(6) : path);
  const userId = req.keyInfo.userId;

  // 2a. Check Global Rules Blocklist
  try {
    const globalRules = await dbAll("SELECT * FROM global_rules");
    for (const rule of globalRules) {
      const methodMatches = rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase();
      const pathMatches = pathMatchesPattern(veeamPath, rule.path_pattern);
      if (methodMatches && pathMatches) {
        // By default, global rules behave as system DENY overrides
        await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, `Blocked by global rule: ${rule.description}`, req);
        return res.status(403).json({ error: `Blocked by system-wide global rule: ${rule.description}` });
      }
    }
  } catch (err) {
    console.error('[AUTHZ] Error checking global rules:', err);
  }

  // 2b. Check User-Group Access Rules (ALLOW / DENY hierarchy)
  if (!userId) {
    // If there is no user associated, default deny
    await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, 'Blocked: Key has no associated User owner (Default Deny)', req);
    return res.status(403).json({ error: 'Access Denied: Key has no associated user owner' });
  }

  try {
    const userRules = await dbAll(`
      SELECT gr.effect, gr.method, gr.path_pattern, gr.server_id, g.name as group_name
      FROM group_rules gr
      JOIN user_groups ug ON gr.group_id = ug.group_id
      JOIN groups g ON ug.group_id = g.id
      WHERE ug.user_id = ?
    `, [userId]);

    let isAllowed = false;
    let isDenied = false;
    let matchingDenyRule = null;
    const targetServerId = req.targetServer ? req.targetServer.id : null;

    for (const rule of userRules) {
      const methodMatches = rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase();
      const pathMatches = pathMatchesPattern(veeamPath, rule.path_pattern);
      // A rule with no server_id (or '*') applies to every VBR; otherwise it must match the target server.
      const serverMatches = !rule.server_id || rule.server_id === '*' || rule.server_id === targetServerId;

      if (methodMatches && pathMatches && serverMatches) {
        if (rule.effect === 'DENY') {
          isDenied = true;
          matchingDenyRule = rule;
          break; // DENY overrides all ALLOWs, exit loop immediately
        } else if (rule.effect === 'ALLOW') {
          isAllowed = true;
        }
      }
    }

    if (isDenied) {
      const blockMsg = `Blocked: Explicit DENY rule matched in Group '${matchingDenyRule.group_name}' (${matchingDenyRule.method} ${matchingDenyRule.path_pattern})`;
      await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, blockMsg, req);
      return res.status(403).json({ error: `Access Denied: Request is explicitly blocked by group rule: ${matchingDenyRule.method} ${matchingDenyRule.path_pattern}` });
    }

    if (!isAllowed) {
      await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, 'Blocked: Default Deny (no matching ALLOW rules)', req);
      return res.status(403).json({ error: 'Access Denied: No matching ALLOW rule found for this request (Default Deny)' });
    }

  } catch (err) {
    console.error('[AUTHZ] Error checking policy permissions:', err);
    return res.status(500).json({ error: 'Authorization verification failed' });
  }

  next();
}

// --- Endpoints for Management UI (Requires proxy authentication - Admin only for configuration) ---

// Get Status (Veeam connectivity, settings details)
app.get('/api/status', authenticateApiKey, async (req, res) => {
  const d = getDefaultServer();
  const status = {
    veeamConfigured: !!d,
    veeamUrl: d?.url || 'Not set',
    connectionStatus: 'Disconnected',
    error: null,
  };

  if (d) {
    try {
      const token = await getVeeamToken(d);
      // Test connectivity by calling Veeam's repositories endpoint (accessible to more roles)
      try {
        await axios.get(`${d.url}/api/v1/backupInfrastructure/repositories?limit=1`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'x-api-version': d.apiVersion || DEFAULT_VEEAM_API_VERSION,
          },
          httpsAgent,
          timeout: 3000 // Check connectivity quickly
        });
        status.connectionStatus = 'Connected';
      } catch (pingErr) {
        // If we get a 403 Forbidden, it means we successfully authenticated and contacted the Veeam server,
        // but the token's role lacks query permissions for this endpoint. This still confirms connectivity.
        if (pingErr.response?.status === 403) {
          status.connectionStatus = 'Connected';
        } else {
          throw pingErr;
        }
      }
    } catch (err) {
      status.error = err.response?.data?.message || err.message;
      status.connectionStatus = 'Error';
    }
  }

  // Expose the caller's control-plane role so the UI can render read-only for Viewers.
  status.role = req.keyInfo.role;
  status.isAdmin = req.keyInfo.role === 'Admin';

  // Audit dashboard access by non-admin (Viewer) keys so their usage is traceable.
  if (!status.isAdmin) {
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'GET', '/api/status', 200, 'Viewer console access', req);
  }

  res.json(status);
});

// Control-plane admin is determined authoritatively by the key's role. A Viewer
// key is never a management-API admin, even if its user belongs to a wildcard-ALLOW
// group — that group only governs /veeam proxy access, not the management API.
async function checkIsAdmin(req) {
  return req.keyInfo.role === 'Admin';
}

// List API Keys (includes owner username, allowed IPs, and expiration)
app.get('/api/keys', authenticateApiKey, async (req, res) => {
  try {
    const keys = await dbAll(`
      SELECT ak.id, ak.name, ak.token_masked, ak.role, ak.status, ak.expires_at, ak.allowed_ips, ak.created_at,
             ak.default_server_id, u.username as owner_name, vs.slug as default_server
      FROM api_keys ak
      LEFT JOIN users u ON ak.user_id = u.id
      LEFT JOIN veeam_servers vs ON ak.default_server_id = vs.id
      ORDER BY ak.created_at DESC
    `);
    res.json(keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create API Key (Admin only - associates keys with users)
app.post('/api/keys', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can create API keys' });
  }

  const { name, userId, expiresAt, allowedIps, role, defaultServerId } = req.body;
  if (!name || !userId) {
    return res.status(400).json({ error: 'Key Name and User Owner are required' });
  }
  // Default to least-privilege Viewer; only an explicit 'Admin' grants control-plane admin.
  const keyRole = role === 'Admin' ? 'Admin' : 'Viewer';
  // Optional default VBR — if provided it must be a known server (reject typos rather
  // than silently falling back to the system default). null = use system default at request time.
  let keyServerId = null;
  if (defaultServerId) {
    if (!servers.has(defaultServerId)) return res.status(400).json({ error: `Unknown defaultServerId '${defaultServerId}'` });
    keyServerId = defaultServerId;
  }

  try {
    const token = 'veeam_vproxy_' + crypto.randomBytes(24).toString('hex');
    const tokenHash = hashToken(token);
    const tokenMasked = token.substring(0, 13) + '...' + token.substring(token.length - 4);
    const keyId = crypto.randomUUID();
    const now = new Date().toISOString();

    await dbRun(
      'INSERT INTO api_keys (id, name, user_id, token_hash, token_masked, role, status, expires_at, allowed_ips, default_server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [keyId, name, userId, tokenHash, tokenMasked, keyRole, 'active', expiresAt || null, allowedIps || null, keyServerId, now]
    );

    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/keys`, 201, `Created ${keyRole} key: ${name} for user ID: ${userId}`, req);

    res.status(201).json({
      id: keyId,
      name,
      userId,
      token,
      role: keyRole,
      masked: tokenMasked,
      expires_at: expiresAt || null,
      allowed_ips: allowedIps || null,
      default_server_id: keyServerId,
      created_at: now
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revoke API Key (Admin only)
app.post('/api/keys/:id/revoke', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can revoke API keys' });
  }

  const { id } = req.params;
  // Prevent revoking oneself
  if (id === req.keyInfo.id) {
    return res.status(400).json({ error: 'Cannot revoke the active credentials used to make this request' });
  }

  try {
    const key = await dbGet('SELECT * FROM api_keys WHERE id = ?', [id]);
    if (!key) {
      return res.status(404).json({ error: 'Key not found' });
    }

    await dbRun("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [id]);
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/keys/${id}/revoke`, 200, `Revoked key: ${key.name}`, req);
    res.json({ message: 'Key successfully revoked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- User Management APIs (Admin only) ---

// List Users
app.get('/api/users', authenticateApiKey, async (req, res) => {
  // Read-only: any authenticated key (incl. Viewer) may list users for the console.
  try {
    const users = await dbAll(`
      SELECT u.id, u.username, u.email, u.created_at, GROUP_CONCAT(g.name) as groups_list, GROUP_CONCAT(g.id) as group_ids_list
      FROM users u
      LEFT JOIN user_groups ug ON u.id = ug.user_id
      LEFT JOIN groups g ON ug.group_id = g.id
      GROUP BY u.id
      ORDER BY u.username ASC
    `);
    
    const formatted = users.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      created_at: user.created_at,
      groups: user.groups_list ? user.groups_list.split(',') : [],
      groupIds: user.group_ids_list ? user.group_ids_list.split(',') : []
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create User
app.post('/api/users', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can create users' });
  }
  const { username, email, groupIds } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    await dbRun('INSERT INTO users (id, username, email, created_at) VALUES (?, ?, ?, ?)', [
      userId, username, email || '', now
    ]);

    if (groupIds && Array.isArray(groupIds)) {
      for (const gid of groupIds) {
        await dbRun('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)', [userId, gid]);
      }
    }

    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/users`, 201, `Created user: ${username}`, req);
    res.status(201).json({ id: userId, username, email, created_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update User Groups
app.put('/api/users/:id/groups', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can modify user group assignments' });
  }
  const { id } = req.params;
  const { groupIds } = req.body;
  if (!groupIds || !Array.isArray(groupIds)) {
    return res.status(400).json({ error: 'groupIds array is required' });
  }
  try {
    await dbRun('DELETE FROM user_groups WHERE user_id = ?', [id]);
    for (const gid of groupIds) {
      await dbRun('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)', [id, gid]);
    }
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'PUT', `/api/users/${id}/groups`, 200, `Updated user groups for ID: ${id}`, req);
    res.json({ message: 'User groups updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete User
app.delete('/api/users/:id', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can delete users' });
  }
  const { id } = req.params;
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.username === 'admin') {
      return res.status(400).json({ error: 'Cannot delete the built-in system administrator user' });
    }
    await dbRun('DELETE FROM users WHERE id = ?', [id]);
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'DELETE', `/api/users/${id}`, 200, `Deleted user: ${user.username}`, req);
    res.json({ message: 'User successfully deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Group & Access Rules Management APIs (Admin only) ---

// List Groups & Rules
app.get('/api/groups', authenticateApiKey, async (req, res) => {
  // Read-only: any authenticated key (incl. Viewer) may list groups/rules for the console.
  try {
    const groups = await dbAll('SELECT * FROM groups ORDER BY name ASC');
    const formatted = [];
    for (const g of groups) {
      const rules = await dbAll('SELECT gr.id, gr.effect, gr.method, gr.path_pattern, gr.description, gr.server_id, vs.slug as server_slug FROM group_rules gr LEFT JOIN veeam_servers vs ON gr.server_id = vs.id WHERE gr.group_id = ?', [g.id]);
      formatted.push({
        ...g,
        rules
      });
    }
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Update Group and sync its Rule Table
app.post('/api/groups', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can configure groups' });
  }
  const { id, name, description, rules } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Group Name is required' });
  }
  const groupId = id || crypto.randomUUID();
  // Validate any per-rule server scopes up front (before writes) — '*'/empty = all servers.
  if (rules && Array.isArray(rules)) {
    for (const rule of rules) {
      if (rule.server_id && rule.server_id !== '*' && !servers.has(rule.server_id)) {
        return res.status(400).json({ error: `Unknown server_id '${rule.server_id}' in a rule` });
      }
    }
  }
  try {
    await dbRun('INSERT OR REPLACE INTO groups (id, name, description) VALUES (?, ?, ?)', [
      groupId, name, description || ''
    ]);

    if (rules && Array.isArray(rules)) {
      // Clear and re-scaffold rules in group_rules
      await dbRun('DELETE FROM group_rules WHERE group_id = ?', [groupId]);
      for (const rule of rules) {
        const ruleId = crypto.randomUUID();
        const ruleServerId = (rule.server_id && rule.server_id !== '*') ? rule.server_id : null; // null = all servers
        await dbRun('INSERT INTO group_rules (id, group_id, effect, method, path_pattern, description, server_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          ruleId, groupId, rule.effect, rule.method, rule.path_pattern, rule.description || '', ruleServerId
        ]);
      }
    }
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/groups`, 200, `Configured group: ${name}`, req);
    res.json({ id: groupId, name, description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Group
app.delete('/api/groups/:id', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can delete groups' });
  }
  const { id } = req.params;
  try {
    const group = await dbGet('SELECT * FROM groups WHERE id = ?', [id]);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (group.name === 'Administrators') {
      return res.status(400).json({ error: 'Cannot delete the system Administrators group' });
    }
    await dbRun('DELETE FROM groups WHERE id = ?', [id]);
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'DELETE', `/api/groups/${id}`, 200, `Deleted group: ${group.name}`, req);
    res.json({ message: 'Group successfully deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Global System Rules (Safety overrides)
app.get('/api/rules', authenticateApiKey, async (req, res) => {
  try {
    const rules = await dbAll('SELECT * FROM global_rules');
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Update Global System Rule (Admin only)
app.post('/api/rules', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can modify system global rules' });
  }

  const { id, method, path_pattern, action, description } = req.body;
  if (!method || !path_pattern || !action || !description) {
    return res.status(400).json({ error: 'Method, Path Pattern, Action, and Description are required' });
  }

  try {
    if (id) {
      await dbRun(
        'UPDATE global_rules SET method = ?, path_pattern = ?, action = ?, description = ? WHERE id = ?',
        [method.toUpperCase(), path_pattern, action, description, id]
      );
      await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/rules`, 200, `Updated global rule: ${action} ${method} ${path_pattern}`, req);
      res.json({ message: 'Global rule updated successfully' });
    } else {
      const result = await dbRun(
        'INSERT INTO global_rules (method, path_pattern, action, description) VALUES (?, ?, ?, ?)',
        [method.toUpperCase(), path_pattern, action, description]
      );
      await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/rules`, 201, `Created global rule: ${action} ${method} ${path_pattern}`, req);
      res.status(201).json({ id: result.lastID, method, path_pattern, action, description });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Global System Rule (Admin only)
app.delete('/api/rules/:id', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) {
    return res.status(403).json({ error: 'Only administrators can delete global rules' });
  }

  const { id } = req.params;
  try {
    const rule = await dbGet('SELECT * FROM global_rules WHERE id = ?', [id]);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    await dbRun('DELETE FROM global_rules WHERE id = ?', [id]);
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'DELETE', `/api/rules/${id}`, 200, `Deleted global rule: ${rule.action} ${rule.method} ${rule.path_pattern}`, req);
    res.json({ message: 'Rule successfully deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Audit Logs
app.get('/api/logs', authenticateApiKey, async (req, res) => {
  try {
    const logs = await dbAll('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 150');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Veeam Connection Settings (Admin only)
app.get('/api/config', authenticateApiKey, async (req, res) => {
  // Back-compat single-connection view of the DEFAULT server (any authenticated key).
  // The password is never returned — only whether one is set.
  const d = getDefaultServer();
  res.json({
    url: d?.url || '',
    username: d?.username || '',
    hasPassword: !!d?.password,
    apiVersion: d?.apiVersion || DEFAULT_VEEAM_API_VERSION
  });
});

// Serve Swagger Schema (available to all authenticated API keys)
app.get('/api/swagger.json', authenticateApiKey, (req, res) => {
  res.sendFile(path.join(__dirname, 'swagger.json'));
});

// Update Veeam Connection Settings (Admin only)
app.post('/api/config', authenticateApiKey, async (req, res) => {
  if (req.keyInfo.role !== 'Admin') {
    return res.status(403).json({ error: 'Only administrators can update settings' });
  }
  const { url, username, password, apiVersion } = req.body;
  if (!url || !username) {
    return res.status(400).json({ error: 'URL and Username are required' });
  }
  try {
    // Back-compat: this edits the DEFAULT server row (creating it if there is none).
    const versionToSave = (apiVersion && apiVersion.trim()) || DEFAULT_VEEAM_API_VERSION;
    const d = getDefaultServer();
    if (d) {
      const fields = ['url = ?', 'username = ?', 'api_version = ?'];
      const vals = [url, username, versionToSave];
      if (password && password !== '******') { fields.push('password = ?'); vals.push(encrypt(password)); }
      vals.push(d.id);
      await dbRun(`UPDATE veeam_servers SET ${fields.join(', ')} WHERE id = ?`, vals);
    } else {
      await dbRun(
        'INSERT INTO veeam_servers (id, slug, name, url, username, password, api_version, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [crypto.randomUUID(), 'default', 'Default', url, username, encrypt(password && password !== '******' ? password : ''), versionToSave, new Date().toISOString()]
      );
    }

    await loadServersFromDb();
    resetVeeamToken(getDefaultServer()?.id); // force re-auth with new settings

    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', '/api/config', 200, 'Updated default Veeam server settings', req);
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Veeam Servers (multi-VBR management) ---

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

// List servers (any authenticated key; passwords never returned)
app.get('/api/servers', authenticateApiKey, async (req, res) => {
  res.json([...servers.values()].map(publicServer));
});

// Test one server's connectivity (any authenticated key) — same probe as /api/status,
// so admins can validate credentials / reachability before routing to it.
app.get('/api/servers/:id/status', authenticateApiKey, async (req, res) => {
  const server = servers.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const result = { id: server.id, slug: server.slug, connectionStatus: 'Disconnected', error: null };
  try {
    const token = await getVeeamToken(server);
    try {
      await axios.get(`${server.url}/api/v1/backupInfrastructure/repositories?limit=1`, {
        headers: { 'Authorization': `Bearer ${token}`, 'x-api-version': server.apiVersion || DEFAULT_VEEAM_API_VERSION },
        httpsAgent,
        timeout: 3000
      });
      result.connectionStatus = 'Connected';
    } catch (pingErr) {
      // 403 from Veeam still proves we authenticated and reached the server.
      if (pingErr.response?.status === 403) result.connectionStatus = 'Connected';
      else throw pingErr;
    }
  } catch (err) {
    result.connectionStatus = 'Error';
    result.error = err.response?.data?.message || err.message;
  }
  res.json(result);
});

// Create a server (Admin)
app.post('/api/servers', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) return res.status(403).json({ error: 'Only administrators can add servers' });
  const { slug, name, url, username, password, apiVersion, isDefault } = req.body;
  if (!slug || !url || !username) return res.status(400).json({ error: 'slug, url and username are required' });
  if (!SLUG_RE.test(slug) || slug.toLowerCase() === 'api') return res.status(400).json({ error: "slug must be URL-safe and not 'api'" });
  if (getServerBySlug(slug)) return res.status(409).json({ error: `A server with slug '${slug}' already exists` });
  try {
    const id = crypto.randomUUID();
    const makeDefault = !!isDefault || servers.size === 0; // first server is always the default
    if (makeDefault) await dbRun('UPDATE veeam_servers SET is_default = 0');
    await dbRun(
      'INSERT INTO veeam_servers (id, slug, name, url, username, password, api_version, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, slug, name || slug, url, username, encrypt(password || ''), (apiVersion && apiVersion.trim()) || DEFAULT_VEEAM_API_VERSION, makeDefault ? 1 : 0, new Date().toISOString()]
    );
    await loadServersFromDb();
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', '/api/servers', 201, `Added Veeam server: ${slug}`, req);
    res.status(201).json(publicServer(servers.get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a server (Admin)
app.put('/api/servers/:id', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) return res.status(403).json({ error: 'Only administrators can edit servers' });
  const { id } = req.params;
  const existing = servers.get(id);
  if (!existing) return res.status(404).json({ error: 'Server not found' });
  const { slug, name, url, username, password, apiVersion, isDefault } = req.body;
  if (slug && (!SLUG_RE.test(slug) || slug.toLowerCase() === 'api')) return res.status(400).json({ error: "slug must be URL-safe and not 'api'" });
  if (slug && slug !== existing.slug && getServerBySlug(slug)) return res.status(409).json({ error: `slug '${slug}' already in use` });
  try {
    const fields = [], vals = [];
    if (slug) { fields.push('slug = ?'); vals.push(slug); }
    if (name !== undefined) { fields.push('name = ?'); vals.push(name); }
    if (url) { fields.push('url = ?'); vals.push(url); }
    if (username) { fields.push('username = ?'); vals.push(username); }
    if (apiVersion) { fields.push('api_version = ?'); vals.push(apiVersion.trim()); }
    if (password && password !== '******') { fields.push('password = ?'); vals.push(encrypt(password)); }
    if (fields.length) { vals.push(id); await dbRun(`UPDATE veeam_servers SET ${fields.join(', ')} WHERE id = ?`, vals); }
    if (isDefault) { await dbRun('UPDATE veeam_servers SET is_default = 0'); await dbRun('UPDATE veeam_servers SET is_default = 1 WHERE id = ?', [id]); }
    await loadServersFromDb();
    resetVeeamToken(id); // creds/version may have changed
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'PUT', `/api/servers/${id}`, 200, `Updated Veeam server: ${slug || existing.slug}`, req);
    res.json(publicServer(servers.get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a server (Admin)
app.delete('/api/servers/:id', authenticateApiKey, async (req, res) => {
  if (!(await checkIsAdmin(req))) return res.status(403).json({ error: 'Only administrators can delete servers' });
  const { id } = req.params;
  const existing = servers.get(id);
  if (!existing) return res.status(404).json({ error: 'Server not found' });
  if (existing.isDefault && servers.size > 1) return res.status(400).json({ error: 'Cannot delete the default server; set another server as default first' });
  try {
    await dbRun('DELETE FROM veeam_servers WHERE id = ?', [id]);
    resetVeeamToken(id);
    await loadServersFromDb();
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'DELETE', `/api/servers/${id}`, 200, `Deleted Veeam server: ${existing.slug}`, req);
    res.json({ message: 'Server deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Proxy Routing: Forward requests to Veeam REST API (V13) ---
app.all('/veeam/*', authenticateApiKey, resolveTargetServer, validateVeeamEndpoint, authorizeRequest, async (req, res) => {
  const { method, body, headers } = req;
  const server = req.targetServer;        // resolved by resolveTargetServer
  const targetPath = req.veeamPath;        // Veeam path with any server slug stripped
  const serverLabel = server.name || server.slug;

  try {
    const token = await getVeeamToken(server);
    const proxyHeaders = {
      'Authorization': `Bearer ${token}`,
      'x-api-version': server.apiVersion || DEFAULT_VEEAM_API_VERSION,
      'Content-Type': headers['content-type'] || 'application/json',
      'Accept': headers['accept'] || 'application/json',
    };

    const config = {
      method,
      url: `${server.url}${targetPath}`,
      headers: proxyHeaders,
      data: body,
      params: req.query,
      httpsAgent,
      validateStatus: () => true // Forward all status codes directly
    };

    const response = await axios(config);

    // Log the transaction (incl. which Veeam server it hit)
    await logOperation(
      req.keyInfo.id, req.keyInfo.name, method, targetPath, response.status,
      `Forwarded to ${serverLabel}: ${response.statusText || 'OK'}`, req, serverLabel
    );

    // Forward headers & status code
    res.status(response.status);
    if (response.headers['content-type']) {
      res.setHeader('content-type', response.headers['content-type']);
    }
    res.send(response.data);

  } catch (err) {
    console.error(`[PROXY-ERROR] ${method} ${serverLabel} ${targetPath}:`, err.message);
    const errStatus = err.response?.status || 502;
    const errMsg = err.response?.data || { error: err.message };

    await logOperation(
      req.keyInfo.id, req.keyInfo.name, method, targetPath, errStatus,
      `Proxy to ${serverLabel} failed: ${err.message}`, req, serverLabel
    );

    res.status(errStatus).json(errMsg);
  }
});

// Serve frontend static build in production
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/veeam')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Start Server
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Veeam Integration Gateway running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[SERVER] Database initialization failed:', err);
  process.exit(1);
});
