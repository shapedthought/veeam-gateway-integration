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
let veeamConfig = {
  url: process.env.VEEAM_API_URL || '',
  username: process.env.VEEAM_USERNAME || '',
  password: process.env.VEEAM_PASSWORD || ''
};

async function loadVeeamConfigFromDb() {
  try {
    const rows = await dbAll('SELECT key, value FROM veeam_config');
    for (const row of rows) {
      if (row.key === 'veeam_url') veeamConfig.url = row.value;
      if (row.key === 'veeam_username') veeamConfig.username = row.value;
      if (row.key === 'veeam_password') veeamConfig.password = row.value;
    }
    console.log('[CONFIG] Veeam connection config loaded from DB. URL:', veeamConfig.url || 'Not set');
  } catch (err) {
    console.error('[CONFIG] Error loading config from DB:', err.message);
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
    if (process.env.VEEAM_PASSWORD) await dbRun('INSERT INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_password', process.env.VEEAM_PASSWORD]);
    console.log('[DB] Seeded veeam_config from environment variables');
  }

  // Load configuration into memory
  await loadVeeamConfigFromDb();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_masked TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
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
      message TEXT
    )
  `);

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

    await dbRun(
      'INSERT INTO api_keys (id, name, token_hash, token_masked, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [keyId, 'Default Admin', defaultHash, defaultMasked, 'Admin', 'active', now]
    );

    console.log('\n==================================================');
    console.log('[SETUP] SEEDED INITIAL ADMIN API KEY:');
    console.log(`[SETUP] Key Name: Default Admin`);
    console.log(`[SETUP] Token   : ${defaultToken}`);
    console.log('[SETUP] IMPORTANT: Copy this token now. It will not be shown again.');
    console.log('==================================================\n');
  }
}

// Audit logger helper
async function logOperation(keyId, keyName, method, path, statusCode, message) {
  const now = new Date().toISOString();
  try {
    await dbRun(
      'INSERT INTO audit_logs (timestamp, key_id, key_name, method, path, status_code, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [now, keyId || 'SYSTEM', keyName || 'SYSTEM', method, path, statusCode, message]
    );
  } catch (err) {
    console.error('[LOGGER] Error writing audit log:', err.message);
  }
}

// --- Veeam API Credentials and Connection Handling ---
let veeamAccessToken = null;
let veeamRefreshToken = null;
let veeamTokenExpiry = 0; // Epoch in ms

// Disable SSL rejection for self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

async function getVeeamToken() {
  const now = Date.now();
  if (veeamAccessToken && veeamTokenExpiry > now + 60000) {
    return veeamAccessToken;
  }

  const veeamUrl = veeamConfig.url;
  const username = veeamConfig.username;
  const password = veeamConfig.password;

  if (!veeamUrl || !username || !password) {
    throw new Error('Veeam connection settings missing or not configured');
  }

  try {
    const params = new URLSearchParams();
    if (veeamRefreshToken) {
      params.append('grant_type', 'Refresh_token');
      params.append('refresh_token', veeamRefreshToken);
    } else {
      params.append('grant_type', 'Password');
      params.append('username', username);
      params.append('password', password);
    }

    console.log('[VEEAM-AUTH] Authenticating with Veeam API at:', `${veeamUrl}/api/oauth2/token`);
    const response = await axios.post(`${veeamUrl}/api/oauth2/token`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-version': '1.3-rev1',
      },
      httpsAgent,
      timeout: 5000 // Fail fast if Veeam is unreachable
    });

    veeamAccessToken = response.data.access_token;
    veeamRefreshToken = response.data.refresh_token;
    const expiresIn = response.data.expires_in || 3600;
    veeamTokenExpiry = now + expiresIn * 1000;
    console.log('[VEEAM-AUTH] Token successfully acquired. Expires in:', expiresIn, 'seconds');
    return veeamAccessToken;
  } catch (err) {
    console.error('[VEEAM-AUTH] Error authenticating with Veeam:', err.response?.data || err.message);
    if (veeamRefreshToken) {
      // If refresh failed, clear token and retry using credentials
      console.log('[VEEAM-AUTH] Refresh token failed. Retrying with full credentials.');
      veeamRefreshToken = null;
      return getVeeamToken();
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
  const targetPath = req.path.startsWith('/veeam') ? req.path.substring(6) : req.path;
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

// 1. Verify Client API Key
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
      role: 'Admin'
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

    req.keyInfo = {
      id: keyRecord.id,
      name: keyRecord.name,
      role: keyRecord.role
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

// 2. Validate Access Control Policies (Global & RBAC)
async function authorizeRequest(req, res, next) {
  const { method, path } = req;
  // Normalize the proxied Veeam path (strip '/veeam' prefix)
  const veeamPath = path.startsWith('/veeam') ? path.substring(6) : path;
  const role = req.keyInfo.role;

  // 2a. Check Global Rules Blocklist
  try {
    const globalRules = await dbAll("SELECT * FROM global_rules WHERE action = 'block'");
    for (const rule of globalRules) {
      const methodMatches = rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase();
      const pathMatches = pathMatchesPattern(veeamPath, rule.path_pattern);
      if (methodMatches && pathMatches) {
        await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, `Blocked by global rule: ${rule.description}`);
        return res.status(403).json({ error: `Blocked by global rule: ${rule.description}` });
      }
    }
  } catch (err) {
    console.error('[AUTHZ] Error checking global rules:', err);
  }

  // 2b. Check RBAC permissions based on Role
  if (role === 'Viewer') {
    if (method !== 'GET') {
      await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, 'Blocked: Viewer role is restricted to read-only (GET) operations');
      return res.status(403).json({ error: 'Viewer role is restricted to read-only (GET) operations' });
    }
  } else if (role === 'Operator') {
    if (method === 'GET') {
      // Allowed
    } else if (method === 'POST') {
      // Allowed only for execution/trigger sub-resources (start, stop, retry, enable, disable, backup, restore)
      const allowedActions = ['/start', '/stop', '/retry', '/enable', '/disable', '/backup', '/restore'];
      const isAllowedAction = allowedActions.some(action => veeamPath.endsWith(action)) || veeamPath.startsWith('/api/v1/restore/');
      
      if (!isAllowedAction) {
        await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, 'Blocked: Operator is restricted from making schema edits or configuration updates');
        return res.status(403).json({ error: 'Operator is restricted from making schema edits or configuration updates. Only job actions (start/stop/restore) are permitted.' });
      }
    } else {
      // Block PUT/DELETE/etc.
      await logOperation(req.keyInfo.id, req.keyInfo.name, method, veeamPath, 403, `Blocked: Operators are not authorized to perform ${method} operations`);
      return res.status(403).json({ error: `Operators are not authorized to perform ${method} operations` });
    }
  }

  next();
}

// --- Endpoints for Management UI (Requires proxy authentication - Admin only for configuration) ---

// Get Status (Veeam connectivity, settings details)
app.get('/api/status', authenticateApiKey, async (req, res) => {
  const status = {
    veeamConfigured: !!veeamConfig.url,
    veeamUrl: veeamConfig.url || 'Not set',
    connectionStatus: 'Disconnected',
    error: null,
  };

  if (veeamConfig.url) {
    try {
      const token = await getVeeamToken();
      // Test connectivity by calling Veeam's jobs endpoint (GET /api/v1/jobs?limit=1)
      await axios.get(`${veeamConfig.url}/api/v1/jobs?limit=1`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-api-version': '1.3-rev1',
        },
        httpsAgent,
        timeout: 3000 // Check connectivity quickly
      });
      status.connectionStatus = 'Connected';
    } catch (err) {
      status.error = err.response?.data?.message || err.message;
      status.connectionStatus = 'Error';
    }
  }

  res.json(status);
});

// List API Keys
app.get('/api/keys', authenticateApiKey, async (req, res) => {
  try {
    const keys = await dbAll('SELECT id, name, token_masked, role, status, created_at FROM api_keys ORDER BY created_at DESC');
    res.json(keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create API Key (Admin only)
app.post('/api/keys', authenticateApiKey, async (req, res) => {
  if (req.keyInfo.role !== 'Admin') {
    return res.status(403).json({ error: 'Only administrators can create API keys' });
  }

  const { name, role } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'Name and Role are required' });
  }

  if (!['Admin', 'Operator', 'Viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Choose from Admin, Operator, Viewer' });
  }

  try {
    const token = 'veeam_vproxy_' + crypto.randomBytes(24).toString('hex');
    const tokenHash = hashToken(token);
    const tokenMasked = token.substring(0, 13) + '...' + token.substring(token.length - 4);
    const keyId = crypto.randomUUID();
    const now = new Date().toISOString();

    await dbRun(
      'INSERT INTO api_keys (id, name, token_hash, token_masked, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [keyId, name, tokenHash, tokenMasked, role, 'active', now]
    );

    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/keys`, 201, `Created key: ${name} (${role})`);

    // Return the clear token ONCE
    res.status(201).json({
      id: keyId,
      name,
      role,
      token,
      masked: tokenMasked,
      created_at: now
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revoke API Key (Admin only)
app.post('/api/keys/:id/revoke', authenticateApiKey, async (req, res) => {
  if (req.keyInfo.role !== 'Admin') {
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
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/keys/${id}/revoke`, 200, `Revoked key: ${key.name}`);
    res.json({ message: 'Key successfully revoked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Global Rules
app.get('/api/rules', authenticateApiKey, async (req, res) => {
  try {
    const rules = await dbAll('SELECT * FROM global_rules');
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Global Rule (Admin only)
app.post('/api/rules', authenticateApiKey, async (req, res) => {
  if (req.keyInfo.role !== 'Admin') {
    return res.status(403).json({ error: 'Only administrators can modify rules' });
  }

  const { method, path_pattern, action, description } = req.body;
  if (!method || !path_pattern || !action || !description) {
    return res.status(400).json({ error: 'All rule parameters are required' });
  }

  try {
    const result = await dbRun(
      'INSERT INTO global_rules (method, path_pattern, action, description) VALUES (?, ?, ?, ?)',
      [method.toUpperCase(), path_pattern, action, description]
    );
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', `/api/rules`, 201, `Created rule: ${action} ${method} ${path_pattern}`);
    res.status(201).json({ id: result.lastID, method, path_pattern, action, description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Global Rule (Admin only)
app.delete('/api/rules/:id', authenticateApiKey, async (req, res) => {
  if (req.keyInfo.role !== 'Admin') {
    return res.status(403).json({ error: 'Only administrators can delete rules' });
  }

  const { id } = req.params;
  try {
    const rule = await dbGet('SELECT * FROM global_rules WHERE id = ?', [id]);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    await dbRun('DELETE FROM global_rules WHERE id = ?', [id]);
    await logOperation(req.keyInfo.id, req.keyInfo.name, 'DELETE', `/api/rules/${id}`, 200, `Deleted rule: ${rule.action} ${rule.method} ${rule.path_pattern}`);
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
  if (req.keyInfo.role !== 'Admin') {
    return res.status(403).json({ error: 'Only administrators can read connection settings' });
  }
  res.json({
    url: veeamConfig.url,
    username: veeamConfig.username,
    hasPassword: !!veeamConfig.password
  });
});

// Update Veeam Connection Settings (Admin only)
app.post('/api/config', authenticateApiKey, async (req, res) => {
  if (req.keyInfo.role !== 'Admin') {
    return res.status(403).json({ error: 'Only administrators can update settings' });
  }
  const { url, username, password } = req.body;
  if (!url || !username) {
    return res.status(400).json({ error: 'URL and Username are required' });
  }
  try {
    await dbRun('INSERT OR REPLACE INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_url', url]);
    await dbRun('INSERT OR REPLACE INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_username', username]);
    
    // Only update password if provided and not masked placeholder
    if (password && password !== '******') {
      await dbRun('INSERT OR REPLACE INTO veeam_config (key, value) VALUES (?, ?)', ['veeam_password', password]);
    }
    
    // Reload config in memory
    await loadVeeamConfigFromDb();
    
    // Reset connection token cache to enforce re-auth
    veeamAccessToken = null;
    veeamRefreshToken = null;
    veeamTokenExpiry = 0;

    await logOperation(req.keyInfo.id, req.keyInfo.name, 'POST', '/api/config', 200, `Updated Veeam connection settings`);
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Proxy Routing: Forward requests to Veeam REST API (V13) ---
app.all('/veeam/*', authenticateApiKey, validateVeeamEndpoint, authorizeRequest, async (req, res) => {
  const { method, body, headers } = req;
  // Extract target path
  const targetPath = req.path.substring(6); // strips '/veeam' prefix
  const veeamUrl = veeamConfig.url;

  if (!veeamUrl) {
    return res.status(500).json({ error: 'Veeam connection settings missing or not configured' });
  }

  try {
    const token = await getVeeamToken();
    const proxyHeaders = {
      'Authorization': `Bearer ${token}`,
      'x-api-version': '1.3-rev1',
      'Content-Type': headers['content-type'] || 'application/json',
      'Accept': headers['accept'] || 'application/json',
    };

    const config = {
      method,
      url: `${veeamUrl}${targetPath}`,
      headers: proxyHeaders,
      data: body,
      params: req.query,
      httpsAgent,
      validateStatus: () => true // Forward all status codes directly
    };

    const response = await axios(config);
    
    // Log the successful transaction
    await logOperation(
      req.keyInfo.id,
      req.keyInfo.name,
      method,
      targetPath,
      response.status,
      `Forwarded: ${response.statusText || 'OK'}`
    );

    // Forward headers & status code
    res.status(response.status);
    if (response.headers['content-type']) {
      res.setHeader('content-type', response.headers['content-type']);
    }
    res.send(response.data);

  } catch (err) {
    console.error(`[PROXY-ERROR] ${method} ${targetPath}:`, err.message);
    const errStatus = err.response?.status || 502;
    const errMsg = err.response?.data || { error: err.message };

    await logOperation(
      req.keyInfo.id,
      req.keyInfo.name,
      method,
      targetPath,
      errStatus,
      `Proxy failed: ${err.message}`
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
