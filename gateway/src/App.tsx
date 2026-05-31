import React, { useState, useEffect } from 'react';

interface ApiKey {
  id: string;
  name: string;
  token_masked: string;
  role: 'Admin' | 'Operator' | 'Viewer';
  status: 'active' | 'revoked';
  created_at: string;
}

interface GlobalRule {
  id: number;
  method: string;
  path_pattern: string;
  action: 'block' | 'allow';
  description: string;
}

interface AuditLog {
  id: number;
  timestamp: string;
  key_id: string;
  key_name: string;
  method: string;
  path: string;
  status_code: number;
  message: string;
}

interface StatusInfo {
  veeamConfigured: boolean;
  veeamUrl: string;
  connectionStatus: 'Connected' | 'Disconnected' | 'Error';
  error: string | null;
}

const getApiUrl = (suffix: string) => {
  let basePath = window.location.pathname;
  if (!basePath.endsWith('/')) {
    basePath += '/';
  }
  if (basePath === '/') {
    return '/api/' + suffix;
  }
  return basePath + 'api/' + suffix;
};

export default function App() {
  const [apiKey, setApiKey] = useState<string>(localStorage.getItem('vproxy_admin_token') || '');
  const [isAuthorized, setIsAuthorized] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tempKeyInput, setTempKeyInput] = useState<string>('');

  const [activeTab, setActiveTab] = useState<'dashboard' | 'keys' | 'rules' | 'logs' | 'config'>('dashboard');
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [keysList, setKeysList] = useState<ApiKey[]>([]);
  const [rulesList, setRulesList] = useState<GlobalRule[]>([]);
  const [logsList, setLogsList] = useState<AuditLog[]>([]);

  // Veeam Config states
  const [configUrl, setConfigUrl] = useState('');
  const [configUsername, setConfigUsername] = useState('');
  const [configPassword, setConfigPassword] = useState('');
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Key generation states
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState<'Admin' | 'Operator' | 'Viewer'>('Viewer');
  const [revealedNewKey, setRevealedNewKey] = useState<{ token: string; name: string } | null>(null);

  // Rule creation states
  const [newRuleMethod, setNewRuleMethod] = useState('DELETE');
  const [newRulePattern, setNewRulePattern] = useState('*');
  const [newRuleDesc, setNewRuleDesc] = useState('Globally block all DELETE operations');

  // Logs search and filter
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Load configuration and data
  const fetchData = async (tokenToUse = apiKey) => {
    if (!tokenToUse) return;
    const headers = { Authorization: `Bearer ${tokenToUse}` };

    try {
      // 1. Fetch Status
      const statusRes = await fetch(getApiUrl('status'), { headers });
      if (statusRes.status === 401) {
        setIsAuthorized(false);
        setAuthError('Invalid Admin API key.');
        return;
      }
      if (!statusRes.ok) throw new Error('Failed to load status');
      const statusData = await statusRes.json();
      setStatus(statusData);
      setIsAuthorized(true);
      setAuthError(null);

      // Save valid token
      localStorage.setItem('vproxy_admin_token', tokenToUse);
      setApiKey(tokenToUse);

      // 2. Fetch Keys
      const keysRes = await fetch(getApiUrl('keys'), { headers });
      if (keysRes.ok) setKeysList(await keysRes.json());

      // 3. Fetch Rules
      const rulesRes = await fetch(getApiUrl('rules'), { headers });
      if (rulesRes.ok) setRulesList(await rulesRes.json());

      // 4. Fetch Logs
      const logsRes = await fetch(getApiUrl('logs'), { headers });
      if (logsRes.ok) setLogsList(await logsRes.json());

      // 5. Fetch Connection Configuration
      const configRes = await fetch(getApiUrl('config'), { headers });
      if (configRes.ok) {
        const configData = await configRes.json();
        setConfigUrl(configData.url || '');
        setConfigUsername(configData.username || '');
        setConfigPassword(configData.hasPassword ? '******' : '');
      }

    } catch (err: any) {
      console.error('API load error:', err.message);
      setAuthError(`Connection failed: ${err.message}`);
    }
  };

  useEffect(() => {
    if (apiKey) {
      fetchData();
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempKeyInput.trim()) return;
    fetchData(tempKeyInput.trim());
  };

  const handleLogout = () => {
    localStorage.removeItem('vproxy_admin_token');
    setApiKey('');
    setIsAuthorized(false);
    setTempKeyInput('');
    setStatus(null);
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch(getApiUrl('keys'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ name: newKeyName, role: newKeyRole })
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || 'Failed to create key');
        return;
      }
      const data = await res.json();
      setRevealedNewKey({ token: data.token, name: data.name });
      setNewKeyName('');
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key? This cannot be undone.')) return;
    try {
      const res = await fetch(getApiUrl(`keys/${id}/revoke`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to revoke key');
        return;
      }
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(getApiUrl('rules'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          method: newRuleMethod,
          path_pattern: newRulePattern,
          action: 'block',
          description: newRuleDesc
        })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to create rule');
        return;
      }
      setNewRulePattern('*');
      setNewRuleDesc('');
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteRule = async (id: number) => {
    if (!confirm('Are you sure you want to delete this global rule?')) return;
    try {
      const res = await fetch(getApiUrl(`rules/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to delete rule');
        return;
      }
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingConfig(true);
    try {
      const res = await fetch(getApiUrl('config'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          url: configUrl,
          username: configUsername,
          password: configPassword
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || 'Failed to save settings');
        return;
      }
      alert('Connection settings saved successfully. Testing connection...');
      fetchData(); // Reload status using new credentials
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Filter logs list
  const filteredLogs = logsList.filter(log => {
    const keyMatch = log.key_name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                     log.path.toLowerCase().includes(searchQuery.toLowerCase());
    const methodMatch = methodFilter === 'ALL' || log.method.toUpperCase() === methodFilter;
    
    let statusMatch = true;
    if (statusFilter === 'SUCCESS') {
      statusMatch = log.status_code >= 200 && log.status_code < 300;
    } else if (statusFilter === 'BLOCKED') {
      statusMatch = log.status_code === 403;
    } else if (statusFilter === 'FAILED') {
      statusMatch = log.status_code >= 400 && log.status_code !== 403;
    }

    return keyMatch && methodMatch && statusMatch;
  });

  // Render Login screen if not authorized
  if (!isAuthorized) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '20px' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '420px' }}>
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <div className="logo-icon" style={{ margin: '0 auto 16px', width: '48px', height: '48px', fontSize: '1.2rem' }}>V</div>
            <h1 className="logo-text" style={{ fontSize: '1.5rem', marginBottom: '8px' }}>VEEAM GATEWAY</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Enter your proxy Admin API key to log in</p>
          </div>
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="admin-key">Admin API Token</label>
              <input 
                id="admin-key"
                type="password" 
                placeholder="veeam_vproxy_..." 
                value={tempKeyInput}
                onChange={(e) => setTempKeyInput(e.target.value)}
              />
            </div>
            {authError && (
              <p style={{ color: 'var(--accent-red)', fontSize: '0.85rem', marginBottom: '16px', fontWeight: '500' }}>
                ⚠️ {authError}
              </p>
            )}
            <button className="btn btn-primary" type="submit" style={{ width: '100%' }}>
              Authenticate
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <>
      <header>
        <div className="header-container">
          <div className="logo-section">
            <div className="logo-icon">V</div>
            <div className="logo-text">VEEAM GATEWAY</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="nav-tabs">
              <button 
                className={`nav-tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
                onClick={() => setActiveTab('dashboard')}
              >
                Dashboard
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'keys' ? 'active' : ''}`}
                onClick={() => setActiveTab('keys')}
              >
                API Keys
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'rules' ? 'active' : ''}`}
                onClick={() => setActiveTab('rules')}
              >
                Global Rules
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
                onClick={() => setActiveTab('logs')}
              >
                Audit Logs
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'config' ? 'active' : ''}`}
                onClick={() => setActiveTab('config')}
              >
                Veeam Settings
              </button>
            </div>
            <button className="btn btn-secondary" onClick={handleLogout} style={{ padding: '6px 12px', fontSize: '0.85rem' }}>
              Disconnect
            </button>
          </div>
        </div>
      </header>

      <main>
        {activeTab === 'dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="dashboard-grid">
              <div className="glass-panel status-card">
                <div className="status-info">
                  <h3>Veeam Connection</h3>
                  <div className="status-val" style={{ fontSize: '1.4rem', marginTop: '6px' }}>
                    {status?.veeamUrl?.replace('https://', '').split(':')[0] || 'Veeam Backup'}
                  </div>
                </div>
                <div className={`status-indicator ${status?.connectionStatus === 'Connected' ? 'status-connected' : 'status-disconnected'}`}>
                  <span className="status-dot"></span>
                  {status?.connectionStatus || 'Disconnected'}
                </div>
              </div>

              <div className="glass-panel status-card">
                <div className="status-info">
                  <h3>Active API Keys</h3>
                  <div className="status-val">{keysList.filter(k => k.status === 'active').length}</div>
                </div>
                <div style={{ color: 'var(--accent-teal)', fontSize: '0.9rem', fontWeight: 'bold' }}>Keys Issued</div>
              </div>

              <div className="glass-panel status-card">
                <div className="status-info">
                  <h3>Security Filters</h3>
                  <div className="status-val">{rulesList.length}</div>
                </div>
                <div style={{ color: 'var(--accent-purple)', fontSize: '0.9rem', fontWeight: 'bold' }}>Active Policies</div>
              </div>

              <div className="glass-panel status-card">
                <div className="status-info">
                  <h3>Proxied Operations</h3>
                  <div className="status-val">{logsList.length}</div>
                </div>
                <div style={{ color: 'var(--accent-blue)', fontSize: '0.9rem', fontWeight: 'bold' }}>Requests logged</div>
              </div>
            </div>

            {status?.error && (
              <div className="glass-panel" style={{ borderColor: 'rgba(239, 68, 68, 0.3)', background: 'rgba(239, 68, 68, 0.05)' }}>
                <h3 style={{ color: 'var(--accent-red)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  ⚠️ Connection Error
                </h3>
                <code style={{ fontSize: '0.9rem', background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px', display: 'block', whiteSpace: 'pre-wrap' }}>
                  {status.error}
                </code>
              </div>
            )}

            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--accent-teal)' }}>Veeam custom AI Skill config</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginBottom: '16px', lineHeight: '1.5' }}>
                This gateway serves as a proxy to keep credentials secure. To interact with Veeam using your AI Agent, configure the Veeam skill to run requests against this proxy.
              </p>
              <div style={{ background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <p style={{ fontSize: '0.9rem', margin: '4px 0', fontFamily: 'monospace' }}>
                  <strong style={{ color: 'var(--accent-blue)' }}>Proxy Base URL:</strong> {window.location.origin}/veeam
                </p>
                <p style={{ fontSize: '0.9rem', margin: '8px 0 4px', fontFamily: 'monospace' }}>
                  <strong style={{ color: 'var(--accent-blue)' }}>Authorization Header:</strong> Authorization: Bearer &lt;YOUR_API_KEY&gt;
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'keys' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '24px', alignItems: 'start' }}>
            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Manage API Credentials</h2>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Token Preview</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keysList.map(key => (
                      <tr key={key.id}>
                        <td style={{ fontWeight: '500' }}>{key.name}</td>
                        <td>
                          <span className={`badge badge-${key.role.toLowerCase()}`}>
                            {key.role}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{key.token_masked}</td>
                        <td>
                          <span style={{ 
                            color: key.status === 'active' ? 'var(--accent-green)' : 'var(--text-muted)', 
                            fontWeight: '600' 
                          }}>
                            {key.status === 'active' ? '● Active' : 'Revoked'}
                          </span>
                        </td>
                        <td>
                          {key.status === 'active' ? (
                            <button 
                              className="btn btn-danger" 
                              onClick={() => handleRevokeKey(key.id)}
                              style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                            >
                              Revoke
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Issue New Token</h2>
              <form onSubmit={handleCreateKey}>
                <div className="form-group">
                  <label htmlFor="key-name">Key Name / Client</label>
                  <input 
                    id="key-name"
                    type="text" 
                    placeholder="e.g. AI-Hermes-Skill" 
                    value={newKeyName} 
                    onChange={e => setNewKeyName(e.target.value)} 
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="key-role">Role (RBAC Group)</label>
                  <select 
                    id="key-role"
                    value={newKeyRole} 
                    onChange={e => setNewKeyRole(e.target.value as any)}
                  >
                    <option value="Viewer">Viewer (Read-Only GET)</option>
                    <option value="Operator">Operator (GET + start/stop/restore)</option>
                    <option value="Admin">Admin (Full endpoints access)</option>
                  </select>
                </div>
                <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: '8px' }}>
                  Generate Key
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'rules' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '24px', alignItems: 'start' }}>
            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Global Access Rules</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
                Global rules run prior to RBAC and block matched operations across ALL keys. 
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Path Pattern</th>
                      <th>Action</th>
                      <th>Description</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rulesList.map(rule => (
                      <tr key={rule.id}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{rule.method}</td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--accent-blue)' }}>{rule.path_pattern}</td>
                        <td>
                          <span className="badge badge-admin" style={{ color: 'var(--accent-red)', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.1)' }}>
                            {rule.action}
                          </span>
                        </td>
                        <td>{rule.description}</td>
                        <td>
                          <button 
                            className="btn btn-danger" 
                            onClick={() => handleDeleteRule(rule.id)}
                            style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rulesList.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No global rules configured.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Add Global Rule</h2>
              <form onSubmit={handleCreateRule}>
                <div className="form-group">
                  <label htmlFor="rule-method">HTTP Method</label>
                  <select 
                    id="rule-method"
                    value={newRuleMethod} 
                    onChange={e => setNewRuleMethod(e.target.value)}
                  >
                    <option value="DELETE">DELETE</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="GET">GET</option>
                    <option value="*">* (All methods)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="rule-pattern">Path Wildcard Pattern</label>
                  <input 
                    id="rule-pattern"
                    type="text" 
                    value={newRulePattern} 
                    onChange={e => setNewRulePattern(e.target.value)} 
                    required
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>E.g. `/api/v1/jobs/*` or `*` for all paths</span>
                </div>
                <div className="form-group">
                  <label htmlFor="rule-desc">Rule Description</label>
                  <textarea 
                    id="rule-desc"
                    rows={2}
                    placeholder="Block modifications on configuration backups" 
                    value={newRuleDesc} 
                    onChange={e => setNewRuleDesc(e.target.value)} 
                    required
                  />
                </div>
                <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: '8px' }}>
                  Create Block Rule
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="glass-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '16px' }}>
              <h2 style={{ fontSize: '1.25rem' }}>Audit Transaction Log</h2>
              
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input 
                  type="text" 
                  placeholder="Search key or path..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{ padding: '8px 12px', fontSize: '0.85rem', width: '200px' }}
                />

                <select 
                  value={methodFilter} 
                  onChange={e => setMethodFilter(e.target.value)}
                  style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                >
                  <option value="ALL">All Methods</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                </select>

                <select 
                  value={statusFilter} 
                  onChange={e => setStatusFilter(e.target.value)}
                  style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                >
                  <option value="ALL">All Transactions</option>
                  <option value="SUCCESS">Success (2xx)</option>
                  <option value="BLOCKED">Blocked (403)</option>
                  <option value="FAILED">Errors (4xx/5xx)</option>
                </select>
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Client (Key)</th>
                    <th>Method</th>
                    <th>Endpoint Path</th>
                    <th>Status</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map(log => {
                    const isSuccess = log.status_code >= 200 && log.status_code < 300;
                    const isBlocked = log.status_code === 403;
                    
                    return (
                      <tr key={log.id}>
                        <td style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                          {new Date(log.timestamp).toLocaleString()}
                        </td>
                        <td style={{ fontWeight: '500' }}>{log.key_name}</td>
                        <td style={{ fontWeight: 'bold', fontFamily: 'monospace' }}>{log.method}</td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--accent-blue)', fontSize: '0.85rem' }}>{log.path}</td>
                        <td>
                          <span className={`status-log-badge ${isSuccess ? 'status-log-success' : isBlocked ? 'status-log-blocked' : 'status-log-blocked'}`} style={!isSuccess && !isBlocked ? { background: 'rgba(245,158,11,0.1)', color: 'var(--accent-yellow)' } : {}}>
                            {log.status_code}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.9rem', color: isBlocked ? 'var(--accent-red)' : 'var(--text-primary)' }}>{log.message}</td>
                      </tr>
                    );
                  })}
                  {filteredLogs.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No audit logs match current filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'config' && (
          <div className="glass-panel" style={{ maxWidth: '600px', margin: '0 auto' }}>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--accent-teal)' }}>Veeam Server Connection Settings</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '20px', lineHeight: '1.5' }}>
              Configure the credentials used by the proxy gateway to authenticate with your Veeam Backup & Replication server.
              These settings are securely saved in the persistent database.
            </p>
            <form onSubmit={handleSaveConfig}>
              <div className="form-group">
                <label htmlFor="veeam-url">Veeam REST API URL</label>
                <input 
                  id="veeam-url"
                  type="url" 
                  placeholder="https://192.168.0.238:9419" 
                  value={configUrl}
                  onChange={e => setConfigUrl(e.target.value)}
                  required
                />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Include protocol and port (typically 9419)</span>
              </div>
              <div className="form-group">
                <label htmlFor="veeam-username">Veeam Username</label>
                <input 
                  id="veeam-username"
                  type="text" 
                  placeholder="Administrator" 
                  value={configUsername}
                  onChange={e => setConfigUsername(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="veeam-password">Veeam Password</label>
                <input 
                  id="veeam-password"
                  type="password" 
                  placeholder="••••••••••••" 
                  value={configPassword}
                  onChange={e => setConfigPassword(e.target.value)}
                  required
                />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Enter password to overwrite existing, or leave as ******</span>
              </div>
              <button className="btn btn-primary" type="submit" disabled={isSavingConfig} style={{ width: '100%', marginTop: '12px' }}>
                {isSavingConfig ? 'Saving Settings...' : 'Save & Test Connection'}
              </button>
            </form>
          </div>
        )}
      </main>

      {/* API Key Reveal Modal */}
      {revealedNewKey && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2 style={{ fontSize: '1.25rem', color: 'var(--accent-teal)', marginBottom: '12px' }}>API Token Generated</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5' }}>
              API key <strong>{revealedNewKey.name}</strong> created successfully. 
              Please copy the token below. For security, it will not be shown again.
            </p>
            <div className="key-reveal-box">
              <span>{revealedNewKey.token}</span>
              <button 
                className="copy-btn" 
                onClick={() => {
                  navigator.clipboard.writeText(revealedNewKey.token);
                  alert('Copied to clipboard!');
                }}
              >
                Copy
              </button>
            </div>
            <div style={{ textAlign: 'right', marginTop: '16px' }}>
              <button className="btn btn-primary" onClick={() => setRevealedNewKey(null)}>
                I have saved this key
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
