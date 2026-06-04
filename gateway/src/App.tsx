import { useState, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import {
  DashboardScreen, KeysScreen, UsersScreen, SecurityScreen, LogsScreen, ConfigScreen,
  RevealModal, UserGroupsModal, CreateGroupModal,
} from './screens.tsx';
import type { ApiKey, GlobalRule, Group, User, AuditLog, StatusInfo, TabId, Ctx, ConfigInfo, GroupRule, VeeamServer } from './types.ts';
import './index.css';

const getApiUrl = (suffix: string): string => {
  let basePath = window.location.pathname;
  if (!basePath.endsWith('/')) basePath += '/';
  if (basePath === '/') return '/api/' + suffix;
  return basePath + 'api/' + suffix;
};

type Modal =
  | { type: 'reveal'; name: string; token: string }
  | { type: 'userGroups'; user: User }
  | { type: 'createGroup' }
  | null;

const NAV: { id: TabId; icon: IconName; label: string }[] = [
  { id: 'dashboard', icon: 'dashboard', label: 'Dashboard' },
  { id: 'keys', icon: 'key', label: 'API Keys' },
  { id: 'users', icon: 'users', label: 'Users' },
  { id: 'security', icon: 'shield', label: 'Security' },
  { id: 'logs', icon: 'logs', label: 'Audit Logs' },
  { id: 'config', icon: 'server', label: 'Veeam Server' },
];

const PAGE_META: Record<TabId, [string, string]> = {
  dashboard: ['Dashboard', 'Gateway overview & system health'],
  keys: ['API Keys', 'Issue and revoke proxy credentials'],
  users: ['Users', 'Manage proxy users and group membership'],
  security: ['Security', 'Role-based access policies & global rules'],
  logs: ['Audit Logs', 'Every request routed through the gateway'],
  config: ['Veeam Server', 'Backend connection settings'],
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default function App() {
  const [apiKey, setApiKey] = useState<string>(localStorage.getItem('vproxy_admin_token') || '');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tempKeyInput, setTempKeyInput] = useState('');

  const [tab, setTab] = useState<TabId>('dashboard');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('vgw_theme') as 'light' | 'dark') || 'light');
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem('vgw_collapsed') === '1');

  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [servers, setServers] = useState<VeeamServer[]>([]);
  const [rules, setRules] = useState<GlobalRule[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [config, setConfig] = useState<ConfigInfo>({ url: '', username: '', hasPassword: false, apiVersion: '1.3-rev1' });

  const [modal, setModal] = useState<Modal>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = (m: string) => {
    setToastMsg(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2200);
  };

  useEffect(() => { localStorage.setItem('vgw_theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('vgw_collapsed', collapsed ? '1' : '0'); }, [collapsed]);

  const jsonHeaders = (token = apiKey): Record<string, string> => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  const fetchData = async (tokenToUse = apiKey) => {
    if (!tokenToUse) return;
    const headers = { Authorization: `Bearer ${tokenToUse}` };
    try {
      const statusRes = await fetch(getApiUrl('status'), { headers });
      if (statusRes.status === 401) { setIsAuthorized(false); setAuthError('Invalid Admin API key.'); return; }
      if (!statusRes.ok) throw new Error('Failed to load status');
      const statusData = await statusRes.json();
      setStatus(statusData);
      setIsAuthorized(true);
      setAuthError(null);
      localStorage.setItem('vproxy_admin_token', tokenToUse);
      setApiKey(tokenToUse);

      const keysRes = await fetch(getApiUrl('keys'), { headers });
      if (keysRes.ok) setKeys(await keysRes.json());
      const rulesRes = await fetch(getApiUrl('rules'), { headers });
      if (rulesRes.ok) setRules(await rulesRes.json());
      const logsRes = await fetch(getApiUrl('logs'), { headers });
      if (logsRes.ok) setLogs(await logsRes.json());
      const configRes = await fetch(getApiUrl('config'), { headers });
      if (configRes.ok) {
        const c = await configRes.json();
        setConfig({ url: c.url || '', username: c.username || '', hasPassword: !!c.hasPassword, apiVersion: c.apiVersion || '1.3-rev1' });
      }
      const usersRes = await fetch(getApiUrl('users'), { headers });
      if (usersRes.ok) setUsers(await usersRes.json());
      const groupsRes = await fetch(getApiUrl('groups'), { headers });
      if (groupsRes.ok) setGroups(await groupsRes.json());
      // Servers carry connection details (url/username) and are only consumed by admin-only
      // editors (rule scope selector, and Phase 3 server/key management) — skip for Viewers.
      if (statusData.isAdmin) {
        const serversRes = await fetch(getApiUrl('servers'), { headers });
        if (serversRes.ok) setServers(await serversRes.json());
      } else {
        setServers([]);
      }
    } catch (err) {
      setAuthError(`Connection failed: ${errMsg(err)}`);
    }
  };

  useEffect(() => { if (apiKey) fetchData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = (e: FormEvent) => { e.preventDefault(); if (tempKeyInput.trim()) fetchData(tempKeyInput.trim()); };
  const handleLogout = () => { localStorage.removeItem('vproxy_admin_token'); setApiKey(''); setIsAuthorized(false); setTempKeyInput(''); setStatus(null); };

  const post = async (suffix: string, body: unknown, okMsg?: string) => {
    try {
      const res = await fetch(getApiUrl(suffix), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Request failed'); return null; }
      if (okMsg) toast(okMsg);
      return res;
    } catch (err) { alert(errMsg(err)); return null; }
  };

  const ctx: Ctx = {
    keys, users, groups, servers, rules, logs, config, status, isAdmin: !!status?.isAdmin, toast, go: setTab,
    createKey: async ({ name, userId, ips, exp, role }) => {
      const res = await post('keys', { name, userId, role, expiresAt: exp || null, allowedIps: ips || null });
      if (res) { const data = await res.json(); setModal({ type: 'reveal', name: data.name, token: data.token }); fetchData(); }
    },
    revokeKey: async (id) => {
      if (!confirm('Revoke this API key? This cannot be undone.')) return;
      const res = await post(`keys/${id}/revoke`, {}, 'Key revoked');
      if (res) fetchData();
    },
    createUser: async ({ name, email, gids }) => {
      const res = await post('users', { username: name, email, groupIds: gids }, 'User created');
      if (res) fetchData();
    },
    deleteUser: async (id) => {
      if (!confirm('Delete this user? Their keys will be orphaned.')) return;
      try {
        const res = await fetch(getApiUrl(`users/${id}`), { method: 'DELETE', headers: jsonHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Failed to delete user'); return; }
        toast('User deleted'); fetchData();
      } catch (err) { alert(errMsg(err)); }
    },
    openUserGroups: (user) => setModal({ type: 'userGroups', user }),
    openCreateGroup: () => setModal({ type: 'createGroup' }),
    deleteGroup: async (id) => {
      const g = groups.find((x) => x.id === id);
      if (g && g.name === 'Administrators') { alert('The default Administrators group cannot be deleted.'); return; }
      if (!confirm(`Delete security group "${g ? g.name : ''}"?`)) return;
      try {
        const res = await fetch(getApiUrl(`groups/${id}`), { method: 'DELETE', headers: jsonHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Failed to delete group'); return; }
        toast('Group deleted'); fetchData();
      } catch (err) { alert(errMsg(err)); }
    },
    addGroupRule: async (groupId, rule: GroupRule) => {
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      const res = await post('groups', { id: g.id, name: g.name, description: g.description, rules: [...(g.rules || []), rule] }, 'Rule added');
      if (res) fetchData();
    },
    deleteGroupRule: async (groupId, index) => {
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      const res = await post('groups', { id: g.id, name: g.name, description: g.description, rules: (g.rules || []).filter((_, i) => i !== index) });
      if (res) fetchData();
    },
    addGlobalRule: async (rule) => {
      const res = await post('rules', { method: rule.method, path_pattern: rule.path_pattern, action: 'block', description: rule.description }, 'Global rule created');
      if (res) fetchData();
    },
    deleteGlobalRule: async (id) => {
      if (!confirm('Delete this global rule?')) return;
      try {
        const res = await fetch(getApiUrl(`rules/${id}`), { method: 'DELETE', headers: jsonHeaders() });
        if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Failed to delete rule'); return; }
        fetchData();
      } catch (err) { alert(errMsg(err)); }
    },
    saveConfig: async ({ url, username, password, apiVersion }) => {
      const res = await post('config', { url, username, password, apiVersion }, 'Settings saved · testing connection');
      if (res) fetchData();
    },
  };

  const saveUserGroups = async (userId: string, gids: string[]) => {
    try {
      const res = await fetch(getApiUrl(`users/${userId}/groups`), { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ groupIds: gids }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Failed to update groups'); return; }
      setModal(null); toast('Groups updated'); fetchData();
    } catch (err) { alert(errMsg(err)); }
  };
  const saveGroup = async (name: string, desc: string) => {
    const res = await post('groups', { name, description: desc, rules: [] }, 'Group created');
    if (res) { setModal(null); fetchData(); }
  };

  // ---------- Login ----------
  if (!isAuthorized) {
    return (
      <div className={`console ${theme}`} style={{ height: '100%' }}>
        <div className="login-wrap">
          <div className="card login-card">
            <div className="brand" style={{ flexDirection: 'column', padding: '32px 28px 24px' }}>
              <div className="login-mark">V</div>
              <div className="brand-text" style={{ textAlign: 'center' }}>
                <div className="brand-name" style={{ fontSize: 15 }}>Veeam Gateway</div>
                <div className="brand-sub">Secure Proxy · Control Center</div>
              </div>
            </div>
            <div className="panel-body" style={{ padding: 28 }}>
              <form onSubmit={handleLogin}>
                <div className="field">
                  <label className="fl">Admin Bearer Token</label>
                  <input className="inp" type="password" placeholder="veeam_vproxy_…" value={tempKeyInput} onChange={(e) => setTempKeyInput(e.target.value)} autoFocus />
                </div>
                {authError ? <div className="callout danger" style={{ marginBottom: 16 }}><Icon name="shield" size={16} /><span>{authError}</span></div> : null}
                <button className="btn primary" type="submit" style={{ width: '100%' }}>Authenticate</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const [title, subtitle] = PAGE_META[tab];
  const renderScreen = () => {
    switch (tab) {
      case 'keys': return <KeysScreen ctx={ctx} />;
      case 'users': return <UsersScreen ctx={ctx} />;
      case 'security': return <SecurityScreen ctx={ctx} />;
      case 'logs': return <LogsScreen ctx={ctx} />;
      case 'config': return <ConfigScreen ctx={ctx} />;
      default: return <DashboardScreen ctx={ctx} />;
    }
  };

  const connected = (status?.connectionStatus || 'Disconnected') === 'Connected';
  const isAdmin = !!status?.isAdmin;

  return (
    <div className={`console ${theme}`} style={{ height: '100%' }}>
      <div className="app-frame">
        <aside className={`sidebar ${collapsed ? 'rail' : ''}`}>
          <div className="brand">
            <div className="brand-mark">V</div>
            <div className="brand-text"><div className="brand-name">Veeam Gateway</div><div className="brand-sub">Secure Proxy</div></div>
          </div>
          <nav className="nav-group">
            <div className="nav-label">Control Center</div>
            {NAV.map((n) => {
              const count = n.id === 'keys' ? keys.filter((k) => k.status === 'active').length : n.id === 'users' ? users.length : null;
              return (
                <div key={n.id} className={`nav-item ${tab === n.id ? 'active' : ''}`} onClick={() => setTab(n.id)} title={collapsed ? n.label : undefined}>
                  <Icon name={n.icon} size={18} /><span>{n.label}</span>
                  {count != null ? <span className="badge-count">{count}</span> : null}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <div className="conn-mini"><span className={`dot ${connected ? 'ok' : 'danger'}`}></span><div className="conn-mini-text"><b>{connected ? 'Connected' : 'Disconnected'}</b><span>{(status?.veeamUrl || '').replace('https://', '') || '—'}</span></div></div>
            <div className="user-row">
              <div className="avatar">{isAdmin ? 'AD' : 'VW'}</div>
              <div className="user-meta"><b>{isAdmin ? 'admin' : 'viewer'}</b><span>{isAdmin ? 'Administrator' : 'Read-only access'}</span></div>
              <button className="icon-btn logout" title="Disconnect" onClick={handleLogout}><Icon name="power" size={17} /></button>
            </div>
          </div>
        </aside>

        <div className="main-col">
          <header className="topbar">
            <button className="icon-btn" title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((c) => !c)} style={{ marginLeft: '-6px' }}><Icon name="panel" size={19} /></button>
            <div className="page-title"><h1>{title}</h1><p>{subtitle}</p></div>
            <div className="topbar-spacer"></div>
            {!isAdmin ? <span className="ro-badge" title="This key has read-only (Viewer) access"><Icon name="shield" size={13} />Read-only</span> : null}
            <button className="icon-btn" title="Refresh" onClick={() => { fetchData(); toast('Refreshed'); }}><Icon name="refresh" size={18} /></button>
            <div className="theme-toggle">
              <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')} title="Light"><Icon name="sun" size={16} /></button>
              <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')} title="Dark"><Icon name="moon" size={16} /></button>
            </div>
          </header>
          <div className="content">{renderScreen()}</div>
        </div>
      </div>

      {modal?.type === 'reveal' ? <RevealModal name={modal.name} token={modal.token} onClose={() => setModal(null)} toast={toast} /> : null}
      {modal?.type === 'userGroups' ? <UserGroupsModal user={modal.user} groups={groups} onSave={(gids) => saveUserGroups(modal.user.id, gids)} onClose={() => setModal(null)} /> : null}
      {modal?.type === 'createGroup' ? <CreateGroupModal onSave={saveGroup} onClose={() => setModal(null)} /> : null}
      {toastMsg ? <div className="toast">{toastMsg}</div> : null}
    </div>
  );
}
