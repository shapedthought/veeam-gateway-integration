import React, { useState, useEffect } from 'react';

interface ApiKey {
  id: string;
  name: string;
  token_masked: string;
  role: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  allowed_ips: string | null;
  created_at: string;
  owner_name: string | null;
}

interface GlobalRule {
  id: number;
  method: string;
  path_pattern: string;
  action: 'block' | 'allow';
  description: string;
}

interface GroupRule {
  id: string;
  effect: 'ALLOW' | 'DENY';
  method: string;
  path_pattern: string;
  description: string;
}

interface Group {
  id: string;
  name: string;
  description: string;
  rules: GroupRule[];
}

interface User {
  id: string;
  username: string;
  email: string;
  created_at: string;
  groups: string[];
  groupIds: string[];
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
  client_ip: string | null;
  action: string | null;
  resource: string | null;
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

  const [activeTab, setActiveTab] = useState<'dashboard' | 'keys' | 'users' | 'security' | 'logs' | 'config'>('dashboard');
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [keysList, setKeysList] = useState<ApiKey[]>([]);
  const [rulesList, setRulesList] = useState<GlobalRule[]>([]); // global system rules
  const [logsList, setLogsList] = useState<AuditLog[]>([]);
  
  // Scaffolding security states
  const [usersList, setUsersList] = useState<User[]>([]);
  const [groupsList, setGroupsList] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [securitySection, setSecuritySection] = useState<'groups' | 'global'>('groups');

  // Veeam Config states
  const [configUrl, setConfigUrl] = useState('');
  const [configUsername, setConfigUsername] = useState('');
  const [configPassword, setConfigPassword] = useState('');
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Key generation states
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyUserId, setNewKeyUserId] = useState('');
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState('');
  const [newKeyAllowedIps, setNewKeyAllowedIps] = useState('');
  const [revealedNewKey, setRevealedNewKey] = useState<{ token: string; name: string } | null>(null);

  // User management states
  const [newUsername, setNewUsername] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserGroupIds, setNewUserGroupIds] = useState<string[]>([]);
  const [editingUserGroups, setEditingUserGroups] = useState<User | null>(null);

  // Group creation states
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

  // Group rule states
  const [newGroupRuleEffect, setNewGroupRuleEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [newGroupRuleMethod, setNewGroupRuleMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE' | '*'>('*');
  const [newGroupRulePattern, setNewGroupRulePattern] = useState('*');
  const [newGroupRuleDesc, setNewGroupRuleDesc] = useState('');

  // Global rule creation states
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

      // 3. Fetch Rules (global system rules)
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

      // 6. Fetch Users
      const usersRes = await fetch(getApiUrl('users'), { headers });
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        setUsersList(usersData);
      }

      // 7. Fetch Groups & Rules
      const groupsRes = await fetch(getApiUrl('groups'), { headers });
      if (groupsRes.ok) {
        const groupsData = await groupsRes.json();
        setGroupsList(groupsData);
        if (groupsData.length > 0) {
          setSelectedGroupId(prev => {
            if (prev && groupsData.some((g: any) => g.id === prev)) {
              return prev;
            }
            return groupsData[0].id;
          });
        }
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

  // Update default user select for Key creation once usersList is loaded
  useEffect(() => {
    if (usersList.length > 0 && !newKeyUserId) {
      const adminUser = usersList.find(u => u.username === 'admin');
      setNewKeyUserId(adminUser ? adminUser.id : usersList[0].id);
    }
  }, [usersList]);

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
    if (!newKeyName.trim() || !newKeyUserId) return;

    try {
      const res = await fetch(getApiUrl('keys'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ 
          name: newKeyName, 
          userId: newKeyUserId,
          expiresAt: newKeyExpiresAt || null,
          allowedIps: newKeyAllowedIps || null
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || 'Failed to create key');
        return;
      }
      const data = await res.json();
      setRevealedNewKey({ token: data.token, name: data.name });
      setNewKeyName('');
      setNewKeyExpiresAt('');
      setNewKeyAllowedIps('');
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

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    try {
      const res = await fetch(getApiUrl('users'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          username: newUsername,
          email: newUserEmail,
          groupIds: newUserGroupIds
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || 'Failed to create user');
        return;
      }
      setNewUsername('');
      setNewUserEmail('');
      setNewUserGroupIds([]);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm('Are you sure you want to delete this user? This will also revoke/orphan their API keys.')) return;
    try {
      const res = await fetch(getApiUrl(`users/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to delete user');
        return;
      }
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateUserGroups = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUserGroups) return;

    try {
      const res = await fetch(getApiUrl(`users/${editingUserGroups.id}/groups`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          groupIds: newUserGroupIds
        })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to update user groups');
        return;
      }
      setEditingUserGroups(null);
      setNewUserGroupIds([]);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;

    try {
      const res = await fetch(getApiUrl('groups'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          name: newGroupName,
          description: newGroupDesc,
          rules: []
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        alert(errData.error || 'Failed to create group');
        return;
      }
      setNewGroupName('');
      setNewGroupDesc('');
      setIsCreatingGroup(false);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    const group = groupsList.find(g => g.id === id);
    if (!group) return;
    if (group.name === 'Administrators') {
      alert('The system default Administrators group cannot be deleted.');
      return;
    }
    if (!confirm(`Are you sure you want to delete the security group "${group.name}"?`)) return;
    try {
      const res = await fetch(getApiUrl(`groups/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to delete group');
        return;
      }
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAddGroupRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const group = groupsList.find(g => g.id === selectedGroupId);
    if (!group) return;

    const newRule = {
      effect: newGroupRuleEffect,
      method: newGroupRuleMethod,
      path_pattern: newGroupRulePattern,
      description: newGroupRuleDesc || `${newGroupRuleEffect} ${newGroupRuleMethod} on ${newGroupRulePattern}`
    };

    const updatedRules = [...(group.rules || []), newRule];

    try {
      const res = await fetch(getApiUrl('groups'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          id: group.id,
          name: group.name,
          description: group.description,
          rules: updatedRules
        })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to add group rule');
        return;
      }
      setNewGroupRuleDesc('');
      setNewGroupRulePattern('*');
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteGroupRule = async (ruleIndex: number) => {
    const group = groupsList.find(g => g.id === selectedGroupId);
    if (!group) return;

    const updatedRules = (group.rules || []).filter((_, idx) => idx !== ruleIndex);

    try {
      const res = await fetch(getApiUrl('groups'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          id: group.id,
          name: group.name,
          description: group.description,
          rules: updatedRules
        })
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
        alert(err.error || 'Failed to create global rule');
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
      fetchData();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Filter logs list
  const filteredLogs = logsList.filter(log => {
    const searchLower = searchQuery.toLowerCase();
    const keyMatch = 
      log.key_name?.toLowerCase().includes(searchLower) || 
      log.path?.toLowerCase().includes(searchLower) || 
      log.client_ip?.toLowerCase().includes(searchLower) ||
      log.action?.toLowerCase().includes(searchLower) ||
      log.resource?.toLowerCase().includes(searchLower);
      
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

  if (!isAuthorized) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '20px' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '440px', padding: '36px' }}>
          <div style={{ textAlign: 'center', marginBottom: '28px' }}>
            <div className="logo-icon" style={{ margin: '0 auto 16px', width: '56px', height: '56px', fontSize: '1.4rem' }}>V</div>
            <h1 className="logo-text" style={{ fontSize: '1.6rem', marginBottom: '8px' }}>VEEAM GATEWAY</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Enter proxy Admin Token to access dashboard</p>
          </div>
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="admin-key">Admin Bearer Token</label>
              <input 
                id="admin-key"
                type="password" 
                placeholder="veeam_vproxy_..." 
                value={tempKeyInput}
                onChange={(e) => setTempKeyInput(e.target.value)}
              />
            </div>
            {authError && (
              <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', marginBottom: '18px', fontWeight: '500' }}>
                ⚠️ {authError}
              </p>
            )}
            <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: '6px' }}>
              Authenticate Control Center
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
                📊 Dashboard
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'keys' ? 'active' : ''}`}
                onClick={() => setActiveTab('keys')}
              >
                🔑 API Keys
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'users' ? 'active' : ''}`}
                onClick={() => setActiveTab('users')}
              >
                👥 Users
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'security' ? 'active' : ''}`}
                onClick={() => setActiveTab('security')}
              >
                🛡️ Security
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
                onClick={() => setActiveTab('logs')}
              >
                📋 Audit Logs
              </button>
              <button 
                className={`nav-tab-btn ${activeTab === 'config' ? 'active' : ''}`}
                onClick={() => setActiveTab('config')}
              >
                ⚙️ Veeam Server
              </button>
            </div>
            <button className="btn btn-secondary" onClick={handleLogout} style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
              Disconnect
            </button>
          </div>
        </div>
      </header>

      <main>
        {activeTab === 'dashboard' && (
          <div className="tab-content" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="dashboard-grid">
              <div className="glass-panel status-card teal">
                <div className="status-info">
                  <h3>Veeam Connection</h3>
                  <div className="status-val" style={{ fontSize: '1.35rem', marginTop: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
                    {status?.veeamUrl?.replace('https://', '').split(':')[0] || 'Veeam Backup'}
                  </div>
                </div>
                <div className={`status-indicator ${status?.connectionStatus === 'Connected' ? 'status-connected' : 'status-disconnected'}`}>
                  <span className="status-dot"></span>
                  {status?.connectionStatus || 'Disconnected'}
                </div>
              </div>

              <div className="glass-panel status-card blue">
                <div className="status-info">
                  <h3>Active API Keys</h3>
                  <div className="status-val">{keysList.filter(k => k.status === 'active').length}</div>
                </div>
                <div style={{ color: 'var(--accent-blue)', fontSize: '0.88rem', fontWeight: 'bold' }}>Keys Active</div>
              </div>

              <div className="glass-panel status-card purple">
                <div className="status-info">
                  <h3>Security Groups</h3>
                  <div className="status-val">{groupsList.length}</div>
                </div>
                <div style={{ color: 'var(--accent-purple)', fontSize: '0.88rem', fontWeight: 'bold' }}>Role Policies</div>
              </div>

              <div className="glass-panel status-card red">
                <div className="status-info">
                  <h3>System Block Rules</h3>
                  <div className="status-val">{rulesList.length}</div>
                </div>
                <div style={{ color: 'var(--color-danger)', fontSize: '0.88rem', fontWeight: 'bold' }}>Global Rules</div>
              </div>
            </div>

            {status?.error && (
              <div className="glass-panel" style={{ borderColor: 'rgba(239, 68, 68, 0.35)', background: 'rgba(239, 68, 68, 0.05)' }}>
                <h3 style={{ color: 'var(--color-danger)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  ⚠️ Connection Error
                </h3>
                <code style={{ fontSize: '0.88rem', background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '6px', display: 'block', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                  {status.error}
                </code>
              </div>
            )}

            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--accent-teal)' }}>Veeam Custom AI Skill Configuration</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginBottom: '18px', lineHeight: '1.6' }}>
                This gateway serves as a secure proxy layer. Instruct your AI agent (like Hermes) to execute requests against this local proxy instead of Veeam directly. The proxy automatically intercepts calls, enforces custom rules, applies IP whitelists, and logs activities.
              </p>
              <div className="code-block">
                <p style={{ margin: '4px 0' }}>
                  <strong style={{ color: 'var(--accent-teal)' }}>Gateway Proxied Endpoint:</strong> {window.location.origin}/veeam
                </p>
                <p style={{ margin: '8px 0 4px' }}>
                  <strong style={{ color: 'var(--accent-teal)' }}>Bearer Authorization:</strong> Authorization: Bearer &lt;YOUR_API_KEY&gt;
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'keys' && (
          <div className="tab-content" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '24px', alignItems: 'start' }}>
            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Manage API Credentials</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
                Tokens represent access credentials associated with specific users. Permissions are dynamically evaluated based on the user's groups.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Name / Identifier</th>
                      <th>Owner User</th>
                      <th>Allowed IPs</th>
                      <th>Expires At</th>
                      <th>Token Mask</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keysList.map(key => (
                      <tr key={key.id}>
                        <td style={{ fontWeight: '600' }}>{key.name}</td>
                        <td>
                          <span className="badge badge-operator">
                            👤 {key.owner_name || 'Unassigned'}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                          {key.allowed_ips ? (
                            <span style={{ color: 'var(--accent-teal)' }}>{key.allowed_ips}</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>* (Any IP)</span>
                          )}
                        </td>
                        <td style={{ fontSize: '0.85rem' }}>
                          {key.expires_at ? (
                            <span style={{ color: new Date(key.expires_at).getTime() < Date.now() ? 'var(--color-danger)' : 'var(--text-primary)' }}>
                              {new Date(key.expires_at).toLocaleDateString()}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>Never</span>
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{key.token_masked}</td>
                        <td>
                          <span style={{ 
                            color: key.status === 'active' ? 'var(--color-success)' : 'var(--text-muted)', 
                            fontWeight: '600',
                            fontSize: '0.88rem'
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
              {usersList.length === 0 ? (
                <div style={{ padding: '16px', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', fontSize: '0.88rem', color: 'var(--color-danger)' }}>
                  ⚠️ No users are registered yet. Please create a User first in the Users tab to assign keys.
                </div>
              ) : (
                <form onSubmit={handleCreateKey}>
                  <div className="form-group">
                    <label htmlFor="key-name">Key Name / Client ID</label>
                    <input 
                      id="key-name"
                      type="text" 
                      placeholder="e.g. LLM-Client-Production" 
                      value={newKeyName} 
                      onChange={e => setNewKeyName(e.target.value)} 
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="key-owner">Associated User (Owner)</label>
                    <select 
                      id="key-owner"
                      value={newKeyUserId} 
                      onChange={e => setNewKeyUserId(e.target.value)}
                      required
                    >
                      {usersList.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.username} ({u.email || 'no email'})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="key-ips">Allowed IPs / Subnets</label>
                    <input 
                      id="key-ips"
                      type="text" 
                      placeholder="e.g. 192.168.10.25, 10.0.0.0/24" 
                      value={newKeyAllowedIps} 
                      onChange={e => setNewKeyAllowedIps(e.target.value)} 
                    />
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Comma separated. Leave empty to allow any client IP.</span>
                  </div>
                  <div className="form-group">
                    <label htmlFor="key-expires">Expiration Date</label>
                    <input 
                      id="key-expires"
                      type="date" 
                      value={newKeyExpiresAt} 
                      onChange={e => setNewKeyExpiresAt(e.target.value)} 
                    />
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Leave empty for non-expiring credentials.</span>
                  </div>
                  <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: '8px' }}>
                    Generate Key Pair
                  </button>
                </form>
              )}
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div className="tab-content" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '24px', alignItems: 'start' }}>
            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Proxy User Directory</h2>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Email Address</th>
                      <th>Assigned Security Groups</th>
                      <th>Registered On</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usersList.map(user => (
                      <tr key={user.id}>
                        <td style={{ fontWeight: '600' }}>👤 {user.username}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{user.email || <em style={{ color: 'var(--text-muted)' }}>none</em>}</td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                            {user.groups.map((g, idx) => (
                              <span key={idx} className="badge badge-viewer" style={{ fontSize: '0.7rem' }}>
                                {g}
                              </span>
                            ))}
                            {user.groups.length === 0 && (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No groups mapped (Default Deny)</span>
                            )}
                          </div>
                        </td>
                        <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button 
                              className="btn btn-secondary" 
                              onClick={() => {
                                setEditingUserGroups(user);
                                setNewUserGroupIds(user.groupIds);
                              }}
                              style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                            >
                              Groups
                            </button>
                            {user.username !== 'admin' && (
                              <button 
                                className="btn btn-danger" 
                                onClick={() => handleDeleteUser(user.id)}
                                style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="glass-panel">
              <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Register User</h2>
              <form onSubmit={handleCreateUser}>
                <div className="form-group">
                  <label htmlFor="user-name">Username</label>
                  <input 
                    id="user-name"
                    type="text" 
                    placeholder="e.g. backup-operator" 
                    value={newUsername} 
                    onChange={e => setNewUsername(e.target.value)} 
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="user-email">Email Address</label>
                  <input 
                    id="user-email"
                    type="email" 
                    placeholder="operator@local.com" 
                    value={newUserEmail} 
                    onChange={e => setNewUserEmail(e.target.value)} 
                  />
                </div>
                <div className="form-group">
                  <label>Initial Security Groups</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg-input)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-glass)', maxHeight: '160px', overflowY: 'auto', marginTop: '6px' }}>
                    {groupsList.map(group => (
                      <label key={group.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '500', color: 'var(--text-primary)' }}>
                        <input 
                          type="checkbox" 
                          checked={newUserGroupIds.includes(group.id)}
                          onChange={e => {
                            if (e.target.checked) {
                              setNewUserGroupIds(prev => [...prev, group.id]);
                            } else {
                              setNewUserGroupIds(prev => prev.filter(gid => gid !== group.id));
                            }
                          }}
                        />
                        {group.name}
                      </label>
                    ))}
                  </div>
                </div>
                <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: '8px' }}>
                  Create User Account
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="tab-content security-layout">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="glass-panel" style={{ padding: '16px' }}>
                <h3 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.5px' }}>Security Settings</h3>
                <div 
                  className={`security-sidebar-item ${securitySection === 'groups' ? 'active' : ''}`}
                  onClick={() => setSecuritySection('groups')}
                >
                  <strong style={{ fontSize: '0.9rem' }}>🛡️ Group Access Policies</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Manage group-level allow/deny policies</span>
                </div>
                <div 
                  className={`security-sidebar-item ${securitySection === 'global' ? 'active' : ''}`}
                  onClick={() => setSecuritySection('global')}
                >
                  <strong style={{ fontSize: '0.9rem' }}>⚠️ Global Overrides</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>System block rules for all clients</span>
                </div>
              </div>
              
              {securitySection === 'groups' && (
                <button 
                  className="btn btn-secondary" 
                  onClick={() => setIsCreatingGroup(true)}
                  style={{ width: '100%' }}
                >
                  ➕ Create Security Group
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {securitySection === 'groups' && (
                <>
                  <div className="glass-panel">
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>Access Control Policies (RBAC Groups)</h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
                      Configure Azure-style policy rules for each security group. Select a group below to view and edit its rules.
                    </p>
                    
                    <div className="form-group" style={{ maxWidth: '300px' }}>
                      <label htmlFor="select-group">Active Group to Configure</label>
                      <select 
                        id="select-group"
                        value={selectedGroupId} 
                        onChange={e => setSelectedGroupId(e.target.value)}
                        style={{ marginTop: '4px' }}
                      >
                        {groupsList.map(g => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    </div>

                    {selectedGroupId && (
                      <div style={{ marginTop: '20px', borderTop: '1px solid var(--border-glass)', paddingTop: '20px' }}>
                        {(() => {
                          const group = groupsList.find(g => g.id === selectedGroupId);
                          if (!group) return null;
                          return (
                            <>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <div>
                                  <h3 style={{ fontSize: '1.1rem', color: 'var(--accent-teal)' }}>Rules for Group: {group.name}</h3>
                                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '2px' }}>{group.description}</p>
                                </div>
                                {group.name !== 'Administrators' && (
                                  <button 
                                    className="btn btn-danger" 
                                    onClick={() => handleDeleteGroup(group.id)}
                                    style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                                  >
                                    Delete Group
                                  </button>
                                )}
                              </div>

                              <div style={{ overflowX: 'auto', marginBottom: '24px' }}>
                                <table>
                                  <thead>
                                    <tr>
                                      <th>Effect</th>
                                      <th>HTTP Method</th>
                                      <th>Path Wildcard Pattern</th>
                                      <th>Description</th>
                                      <th>Actions</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(group.rules || []).map((rule, idx) => (
                                      <tr key={idx}>
                                        <td>
                                          <span className={`badge badge-${rule.effect === 'DENY' ? 'deny' : 'allow'}`}>
                                            {rule.effect}
                                          </span>
                                        </td>
                                        <td style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{rule.method}</td>
                                        <td style={{ fontFamily: 'monospace', color: 'var(--accent-blue)', fontSize: '0.88rem' }}>{rule.path_pattern}</td>
                                        <td>{rule.description}</td>
                                        <td>
                                          <button 
                                            className="btn btn-danger" 
                                            onClick={() => handleDeleteGroupRule(idx)}
                                            style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                                          >
                                            Remove
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                    {(group.rules || []).length === 0 && (
                                      <tr>
                                        <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                                          No rules defined for this group. (Default Deny will apply)
                                        </td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>

                              <form onSubmit={handleAddGroupRule} className="glass-panel" style={{ background: 'rgba(0,0,0,0.15)', borderStyle: 'dashed' }}>
                                <h4 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '14px' }}>Add Policy Rule to Group</h4>
                                <div style={{ display: 'grid', gridTemplateColumns: '120px 140px 1fr', gap: '12px' }}>
                                  <div className="form-group">
                                    <label htmlFor="rule-effect">Effect</label>
                                    <select 
                                      id="rule-effect"
                                      value={newGroupRuleEffect} 
                                      onChange={e => setNewGroupRuleEffect(e.target.value as any)}
                                    >
                                      <option value="ALLOW">ALLOW</option>
                                      <option value="DENY">DENY</option>
                                    </select>
                                  </div>
                                  <div className="form-group">
                                    <label htmlFor="group-rule-method">Method</label>
                                    <select 
                                      id="group-rule-method"
                                      value={newGroupRuleMethod} 
                                      onChange={e => setNewGroupRuleMethod(e.target.value as any)}
                                    >
                                      <option value="*">* (All)</option>
                                      <option value="GET">GET</option>
                                      <option value="POST">POST</option>
                                      <option value="PUT">PUT</option>
                                      <option value="DELETE">DELETE</option>
                                    </select>
                                  </div>
                                  <div className="form-group">
                                    <label htmlFor="group-rule-pattern">Path Pattern (Glob)</label>
                                    <input 
                                      id="group-rule-pattern"
                                      type="text" 
                                      value={newGroupRulePattern} 
                                      onChange={e => setNewGroupRulePattern(e.target.value)} 
                                      required
                                    />
                                  </div>
                                </div>
                                <div className="form-group">
                                  <label htmlFor="group-rule-desc">Rule Description</label>
                                  <input 
                                    id="group-rule-desc"
                                    type="text" 
                                    placeholder="e.g. Allows querying job parameters"
                                    value={newGroupRuleDesc}
                                    onChange={e => setNewGroupRuleDesc(e.target.value)}
                                  />
                                </div>
                                <button className="btn btn-primary" type="submit" style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
                                  Add Policy Rule
                                </button>
                              </form>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </>
              )}

              {securitySection === 'global' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '24px', alignItems: 'start' }}>
                  <div className="glass-panel">
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '16px' }}>System Global Rules</h2>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '16px' }}>
                      Global system rules act as strict override blocks. If a request matches a global rule, it is blocked immediately, overriding any group-level allow rules.
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
                              <td style={{ fontFamily: 'monospace', color: 'var(--accent-blue)', fontSize: '0.88rem' }}>{rule.path_pattern}</td>
                              <td>
                                <span className="badge badge-deny">
                                  {rule.action.toUpperCase()}
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
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>E.g. `/api/v1/backupInfrastructure/*` or `*`</span>
                      </div>
                      <div className="form-group">
                        <label htmlFor="rule-desc">Rule Description</label>
                        <textarea 
                          id="rule-desc"
                          rows={2}
                          placeholder="Block configurations changes" 
                          value={newRuleDesc} 
                          onChange={e => setNewRuleDesc(e.target.value)} 
                          required
                        />
                      </div>
                      <button className="btn btn-primary" type="submit" style={{ width: '100%', marginTop: '8px' }}>
                        Create Block Override
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="tab-content glass-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '16px' }}>
              <h2 style={{ fontSize: '1.25rem' }}>Audit Transaction Log</h2>
              
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input 
                  type="text" 
                  placeholder="Filter key, path, resource..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{ padding: '8px 12px', fontSize: '0.85rem', width: '220px' }}
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
                    <th>User (IP/Key)</th>
                    <th>Action</th>
                    <th>Resource Target</th>
                    <th>Method & Path</th>
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
                        <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                          {new Date(log.timestamp).toLocaleString()}
                        </td>
                        <td>
                          <div style={{ fontWeight: '600' }}>{log.key_name}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>IP: {log.client_ip || 'SYSTEM'}</div>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span className="badge badge-operator" style={{ fontSize: '0.72rem', padding: '2px 6px' }}>
                            {log.action || 'API_CALL'}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.88rem', fontWeight: '500' }}>{log.resource || 'General'}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                          <span style={{ fontWeight: 'bold', marginRight: '6px' }}>{log.method}</span>
                          <span style={{ color: 'var(--accent-blue)' }}>{log.path}</span>
                        </td>
                        <td>
                          <span className={`status-log-badge ${isSuccess ? 'status-log-success' : isBlocked ? 'status-log-blocked' : 'status-log-warning'}`}>
                            {log.status_code}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.88rem', color: isBlocked ? 'var(--color-danger)' : 'var(--text-primary)' }}>{log.message}</td>
                      </tr>
                    );
                  })}
                  {filteredLogs.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No audit logs match current filters.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'config' && (
          <div className="tab-content glass-panel" style={{ maxWidth: '600px', margin: '0 auto' }}>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--accent-teal)' }}>Veeam Server Connection Settings</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '20px', lineHeight: '1.6' }}>
              Configure the credentials used by the proxy gateway to authenticate with your Veeam Backup & Replication server.
              These settings are encrypted using AES-256-GCM.
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

      {/* Editing User Groups Modal */}
      {editingUserGroups && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '420px' }}>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--accent-blue)' }}>
              Assign Groups to {editingUserGroups.username}
            </h2>
            <form onSubmit={handleUpdateUserGroups}>
              <div className="form-group">
                <label>Select Groups</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px', maxHeight: '200px', overflowY: 'auto', background: 'var(--bg-input)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                  {groupsList.map(group => (
                    <label key={group.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                      <input 
                        type="checkbox"
                        checked={newUserGroupIds.includes(group.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewUserGroupIds(prev => [...prev, group.id]);
                          } else {
                            setNewUserGroupIds(prev => prev.filter(gid => gid !== group.id));
                          }
                        }}
                      />
                      <span>
                        <strong>{group.name}</strong>
                        <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{group.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button className="btn btn-secondary" type="button" onClick={() => { setEditingUserGroups(null); setNewUserGroupIds([]); }}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit">
                  Save Mappings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Group Modal */}
      {isCreatingGroup && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '450px' }}>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '16px', color: 'var(--accent-teal)' }}>
              Create Security Group
            </h2>
            <form onSubmit={handleCreateGroup}>
              <div className="form-group">
                <label htmlFor="group-name">Group Name</label>
                <input 
                  id="group-name"
                  type="text"
                  placeholder="e.g. Operators-Restricted"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="group-desc">Description</label>
                <textarea 
                  id="group-desc"
                  rows={3}
                  placeholder="E.g. Access policy for operator keys with blocked repo deletion"
                  value={newGroupDesc}
                  onChange={e => setNewGroupDesc(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button className="btn btn-secondary" type="button" onClick={() => { setIsCreatingGroup(false); setNewGroupName(''); setNewGroupDesc(''); }}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit">
                  Create Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
