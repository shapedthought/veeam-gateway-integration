// Veeam Gateway — Enterprise Console screens, modals and helpers.
import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { Icon } from './icons.tsx';
import { DashGrid } from './DashGrid.tsx';
import type { DashItem } from './DashGrid.tsx';
import type { Ctx, User, Group, VeeamServer, ServerStatus } from './types.ts';

const methodClass = (m: string): string => ({ GET: 'get', POST: 'post', PUT: 'post', DELETE: 'del' } as Record<string, string>)[m] || '';
const statusClass = (c: number): string => (c >= 200 && c < 300 ? 's2' : c === 403 ? 's4' : 's1');
const fmtDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/* ---------------- DASHBOARD ---------------- */
export function DashboardScreen({ ctx }: { ctx: Ctx }) {
  const active = ctx.keys.filter((k) => k.status === 'active').length;
  const recent = ctx.logs.slice(0, 5);
  const endpoint = ctx.status?.veeamUrl || ctx.config.url || '';
  const host = endpoint.replace('https://', '').replace('http://', '').split(':')[0] || 'Veeam Backup';
  const connected = (ctx.status?.connectionStatus || 'Disconnected') === 'Connected';
  const blocked = ctx.logs.filter((l) => l.status_code === 403).length;
  const policyCount = ctx.groups.reduce((n, g) => n + (g.rules ? g.rules.length : 0), 0);

  const items: DashItem[] = [
    { id: 'kpi-conn', defaultW: 1, node: (
      <div className="card kpi">
        <div className="kpi-head"><span className="kpi-label">Veeam Connection</span><span className="kpi-chip"><Icon name="server" size={18} /></span></div>
        <div className="kpi-value sm">{host}</div>
        <div className="kpi-foot"><span className={`pill ${connected ? 'ok' : 'danger'}`}><span className={`dot ${connected ? 'ok' : 'danger'}`}></span>{connected ? 'Connected' : 'Disconnected'}</span></div>
      </div>
    ) },
    { id: 'kpi-keys', defaultW: 1, node: (
      <div className="card kpi">
        <div className="kpi-head"><span className="kpi-label">Active API Keys</span><span className="kpi-chip"><Icon name="key" size={17} /></span></div>
        <div className="kpi-value">{active}</div>
        <div className="kpi-foot">{ctx.keys.length} total credentials</div>
      </div>
    ) },
    { id: 'kpi-groups', defaultW: 1, node: (
      <div className="card kpi">
        <div className="kpi-head"><span className="kpi-label">Security Groups</span><span className="kpi-chip neutral"><Icon name="shield" size={17} /></span></div>
        <div className="kpi-value">{ctx.groups.length}</div>
        <div className="kpi-foot">{policyCount} active role policies</div>
      </div>
    ) },
    { id: 'kpi-blocked', defaultW: 1, node: (
      <div className="card kpi">
        <div className="kpi-head"><span className="kpi-label">Blocked Requests</span><span className="kpi-chip danger"><Icon name="shield" size={17} /></span></div>
        <div className="kpi-value">{blocked}</div>
        <div className="kpi-foot"><span className="down">{ctx.rules.length}</span> global rules enforced</div>
      </div>
    ) },
    { id: 'ai-skill', defaultW: 2, node: (
      <div className="card">
        <div className="panel-head"><h2>AI Skill Endpoint</h2><span className="sub">Point your agent here</span></div>
        <div className="panel-body">
          <p className="muted-p">The gateway proxies and authorizes every request. Configure your AI agent to route Veeam calls through this endpoint instead of connecting to the backup server directly.</p>
          <div className="code-field">
            <div className="cf-left"><div className="cf-label">Proxied Endpoint</div><code>{window.location.origin}/veeam</code></div>
            <button className="copy" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/veeam`); ctx.toast('Endpoint copied'); }}><Icon name="copy" size={14} />Copy</button>
          </div>
          <div className="code-field" style={{ marginBottom: 0 }}>
            <div className="cf-left"><div className="cf-label">Authorization Header</div><code>Authorization: Bearer &lt;API_KEY&gt;</code></div>
            <button className="copy" onClick={() => { navigator.clipboard?.writeText('Authorization: Bearer <API_KEY>'); ctx.toast('Header copied'); }}><Icon name="copy" size={14} />Copy</button>
          </div>
        </div>
      </div>
    ) },
    { id: 'health', defaultW: 2, node: (
      <div className="card">
        <div className="panel-head"><h2>Connection Health</h2></div>
        <div className="panel-body">
          <div className="dl">
            <div className="dl-row"><span className="dl-key"><Icon name="link" size={15} />Status</span><span className="dl-val"><span className={`pill ${connected ? 'ok' : 'danger'}`}><span className={`dot ${connected ? 'ok' : 'danger'}`}></span>{connected ? 'Connected' : 'Disconnected'}</span></span></div>
            <div className="dl-row"><span className="dl-key"><Icon name="server" size={15} />Endpoint</span><span className="dl-val mono">{endpoint || '—'}</span></div>
            <div className="dl-row"><span className="dl-key"><Icon name="key" size={15} />Active Keys</span><span className="dl-val">{active}</span></div>
            <div className="dl-row"><span className="dl-key"><Icon name="logs" size={15} />Audit Events</span><span className="dl-val">{ctx.logs.length}</span></div>
          </div>
          {ctx.status?.error ? <div className="callout danger" style={{ marginTop: 14 }}><Icon name="shield" size={16} /><span>{ctx.status.error}</span></div> : null}
        </div>
      </div>
    ) },
    { id: 'activity', defaultW: 4, node: (
      <div className="card">
        <div className="panel-head"><h2>Recent Gateway Activity</h2><button className="btn ghost sm" onClick={() => ctx.go('logs')}><Icon name="logs" size={15} />View all logs</button></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Time</th><th>Key</th><th>Request</th><th>Status</th></tr></thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id}>
                <td className="t-time">{new Date(r.timestamp).toLocaleTimeString()}</td>
                <td className="t-key">{r.key_name}</td>
                <td><span className={`method ${methodClass(r.method)}`}>{r.method}</span><span className="path">{r.path}</span></td>
                <td><span className={`status-tag ${statusClass(r.status_code)}`}>{r.status_code}</span></td>
              </tr>
            ))}
            {recent.length === 0 ? <tr><td colSpan={4} className="empty">No activity recorded yet.</td></tr> : null}
          </tbody>
        </table></div>
      </div>
    ) },
  ];

  return <DashGrid items={items} />;
}

/* ---------------- API KEYS ---------------- */
export function KeysScreen({ ctx }: { ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [userId, setUserId] = useState(ctx.users[0] ? ctx.users[0].id : '');
  // Keep userId bound to a real user: if users load after mount (or the current
  // selection is removed), snap to the first user so the <select> value and state agree.
  useEffect(() => {
    if (ctx.users.length && !ctx.users.some((u) => u.id === userId)) setUserId(ctx.users[0].id);
  }, [ctx.users]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ips, setIps] = useState('');
  const [exp, setExp] = useState('');
  const [role, setRole] = useState<'Admin' | 'Viewer'>('Viewer');
  const [keySvr, setKeySvr] = useState(''); // '' = system default VBR
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; ctx.createKey({ name, userId, ips, exp, role, defaultServerId: keySvr }); setName(''); setIps(''); setExp(''); setRole('Viewer'); setKeySvr(''); setOpen(false); };
  const noUsers = ctx.users.length === 0;
  return (
    <>
      <div className="card">
        <div className="panel-head"><h2>API Credentials <span className="sub" style={{ marginLeft: 8 }}>{ctx.keys.length} total</span></h2>{ctx.isAdmin ? <button className="btn primary sm" disabled={noUsers} onClick={() => setOpen(true)}><Icon name="key" size={15} />Issue Token</button> : null}</div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Name</th><th>Owner</th><th>Role</th><th>Default VBR</th><th>Allowed IPs</th><th>Expires</th><th>Token</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {ctx.keys.map((k) => (
              <tr key={k.id}>
                <td style={{ fontWeight: 600 }}>{k.name}</td>
                <td><span className="tag owner"><Icon name="users" size={12} />{k.owner_name || 'Unassigned'}</span></td>
                <td><span className={`tag ${k.role === 'Viewer' ? 'muted' : 'group'}`}>{k.role || 'Admin'}</span></td>
                <td>{k.default_server ? <span className="tag group">{k.default_server}</span> : <span className="hint">System default</span>}</td>
                <td className="mono-cell">{k.allowed_ips || 'Any IP'}</td>
                <td className="mono-cell">{k.expires_at ? <span style={{ color: new Date(k.expires_at) < new Date() ? 'var(--danger)' : 'inherit' }}>{fmtDate(k.expires_at)}</span> : 'Never'}</td>
                <td className="mono-cell">{k.token_masked}</td>
                <td><span className={`status-live ${k.status}`}><span className="dot" style={{ background: k.status === 'active' ? 'var(--ok)' : 'var(--text-subtle)' }}></span>{k.status === 'active' ? 'Active' : 'Revoked'}</span></td>
                <td>{ctx.isAdmin && k.status === 'active' ? <button className="btn danger xs" onClick={() => ctx.revokeKey(k.id)}>Revoke</button> : <span className="hint">—</span>}</td>
              </tr>
            ))}
            {ctx.keys.length === 0 ? <tr><td colSpan={9} className="empty">No API keys issued yet.</td></tr> : null}
          </tbody>
        </table></div>
      </div>

      {noUsers ? <div className="callout warn" style={{ marginTop: 16 }}><Icon name="users" size={16} /><span>No users registered yet. Create a user first to assign keys.</span></div> : null}

      {open ? (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Issue New Token</h2><p>Generate a revocable proxy credential bound to a user.</p></div>
            <form onSubmit={submit}>
              <div className="modal-body">
                <div className="field"><label className="fl">Key Name / Client ID</label><input className="inp" placeholder="e.g. LLM-Client-Production" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></div>
                <div className="field"><label className="fl">Associated User</label>
                  <select className="sel" value={userId} onChange={(e) => setUserId(e.target.value)}>{ctx.users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.email ? ` (${u.email})` : ''}</option>)}</select>
                </div>
                <div className="field"><label className="fl">Console Role</label>
                  <select className="sel" value={role} onChange={(e) => setRole(e.target.value as 'Admin' | 'Viewer')}><option value="Viewer">Viewer — read-only dashboard</option><option value="Admin">Admin — full control</option></select>
                  <span className="hint">Viewer keys can sign in and view, but cannot change any gateway settings.</span>
                </div>
                <div className="field"><label className="fl">Default VBR</label>
                  <select className="sel" value={keySvr} onChange={(e) => setKeySvr(e.target.value)}><option value="">System default</option>{ctx.servers.map((s) => <option key={s.id} value={s.id}>{s.name || s.slug}</option>)}</select>
                  <span className="hint">Which Veeam server <code>/veeam/api/…</code> calls hit. The client can still target another with <code>/veeam/&lt;slug&gt;/…</code>.</span>
                </div>
                <div className="field"><label className="fl">Allowed IPs / Subnets</label><input className="inp" placeholder="e.g. 10.0.0.0/24" value={ips} onChange={(e) => setIps(e.target.value)} /><span className="hint">Comma separated. Leave empty to allow any client IP.</span></div>
                <div className="field" style={{ marginBottom: 0 }}><label className="fl">Expiration Date</label><input className="inp" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /><span className="hint">Leave empty for non-expiring credentials.</span></div>
              </div>
              <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn primary"><Icon name="key" size={15} />Generate Key</button></div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ---------------- USERS ---------------- */
export function UsersScreen({ ctx }: { ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [gids, setGids] = useState<string[]>([]);
  const toggle = (id: string) => setGids((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; ctx.createUser({ name, email, gids }); setName(''); setEmail(''); setGids([]); setOpen(false); };
  return (
    <>
      <div className="card">
        <div className="panel-head"><h2>Proxy User Directory <span className="sub" style={{ marginLeft: 8 }}>{ctx.users.length} users</span></h2>{ctx.isAdmin ? <button className="btn primary sm" onClick={() => setOpen(true)}><Icon name="users" size={15} />Register User</button> : null}</div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Username</th><th>Email</th><th>Security Groups</th><th>Registered</th><th></th></tr></thead>
          <tbody>
            {ctx.users.map((u) => (
              <tr key={u.id}>
                <td style={{ fontWeight: 600 }}>{u.username}</td>
                <td className="mono-cell">{u.email || '—'}</td>
                <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{u.groups.length ? u.groups.map((g, i) => <span key={i} className="tag group">{g}</span>) : <span className="tag muted">No groups · default deny</span>}</div></td>
                <td className="t-time">{fmtDate(u.created_at)}</td>
                <td>{ctx.isAdmin ? <div className="row-actions">
                  <button className="btn ghost xs" onClick={() => ctx.openUserGroups(u)}>Groups</button>
                  {u.username !== 'admin' ? <button className="btn danger xs" onClick={() => ctx.deleteUser(u.id)}>Delete</button> : null}
                </div> : <span className="hint">—</span>}</td>
              </tr>
            ))}
            {ctx.users.length === 0 ? <tr><td colSpan={5} className="empty">No users registered yet.</td></tr> : null}
          </tbody>
        </table></div>
      </div>

      {open ? (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Register User</h2><p>Create a proxy user and assign initial security groups.</p></div>
            <form onSubmit={submit}>
              <div className="modal-body">
                <div className="field"><label className="fl">Username</label><input className="inp" placeholder="e.g. backup-operator" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></div>
                <div className="field"><label className="fl">Email Address</label><input className="inp" type="email" placeholder="operator@local.com" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label className="fl">Initial Security Groups</label>
                  <div className="check-list">
                    {ctx.groups.map((g) => (
                      <label key={g.id} className="check-row"><input type="checkbox" checked={gids.includes(g.id)} onChange={() => toggle(g.id)} /><span className="cr-text"><b>{g.name}</b><span>{g.description}</span></span></label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn primary"><Icon name="users" size={15} />Create User</button></div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ---------------- SECURITY ---------------- */
export function SecurityScreen({ ctx }: { ctx: Ctx }) {
  const [section, setSection] = useState<'groups' | 'global'>('groups');
  const [sel, setSel] = useState(ctx.groups[0] ? ctx.groups[0].id : '');
  const group = ctx.groups.find((g) => g.id === sel) || ctx.groups[0];
  // Keep the selection valid as groups load/refetch (e.g. after a delete) so the
  // <select> value and state stay in sync without manual re-selection on each action.
  useEffect(() => {
    if (ctx.groups.length && !ctx.groups.some((g) => g.id === sel)) setSel(ctx.groups[0].id);
  }, [ctx.groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const [eff, setEff] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [meth, setMeth] = useState('*');
  const [pat, setPat] = useState('*');
  const [desc, setDesc] = useState('');
  const [svr, setSvr] = useState(''); // '' = all servers
  const addRule = (e: FormEvent) => { e.preventDefault(); if (!group) return; ctx.addGroupRule(group.id, { effect: eff, method: meth, path_pattern: pat, description: desc || `${eff} ${meth} on ${pat}`, server_id: svr || null }); setPat('*'); setDesc(''); };

  const [gOpen, setGOpen] = useState(false);
  const [gm, setGm] = useState('DELETE');
  const [gp, setGp] = useState('*');
  const [gd, setGd] = useState('');
  const addGlobal = (e: FormEvent) => { e.preventDefault(); ctx.addGlobalRule({ method: gm, path_pattern: gp, description: gd || `Block ${gm} ${gp}` }); setGp('*'); setGd(''); setGOpen(false); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="sec-tabbar">
        <div className="sec-tabs">
          <button className={`sec-tab ${section === 'groups' ? 'active' : ''}`} onClick={() => setSection('groups')}><Icon name="shield" size={16} />Group Policies</button>
          <button className={`sec-tab ${section === 'global' ? 'active' : ''}`} onClick={() => setSection('global')}><Icon name="logs" size={16} />Global Overrides</button>
        </div>
        {section === 'groups' && ctx.isAdmin ? <button className="btn ghost" onClick={() => ctx.openCreateGroup()}>+ Create Group</button> : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {section === 'groups' && group ? (
          <div className="card">
            <div className="panel-body">
              <div className="sec-header" style={{ marginBottom: 18 }}>
                <div>
                  <div className="field" style={{ maxWidth: 280, marginBottom: 0 }}>
                    <label className="fl">Active Group</label>
                    <select className="sel" value={sel} onChange={(e) => setSel(e.target.value)}>{ctx.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                  </div>
                  <p className="lead" style={{ marginTop: 12 }}>{group.description}</p>
                </div>
                {ctx.isAdmin && group.name !== 'Administrators' ? <button className="btn danger sm" onClick={() => ctx.deleteGroup(group.id)}>Delete Group</button> : null}
              </div>

              <div className="tbl-wrap"><table className="tbl" style={{ marginBottom: 22 }}>
                <thead><tr><th>Effect</th><th>Method</th><th>Server</th><th>Path Pattern</th><th>Description</th><th></th></tr></thead>
                <tbody>
                  {(group.rules || []).map((r, i) => (
                    <tr key={i}>
                      <td><span className={`tag ${r.effect === 'DENY' ? 'deny' : 'allow'}`}>{r.effect}</span></td>
                      <td><span className={`method ${methodClass(r.method)}`}>{r.method}</span></td>
                      <td>{r.server_id && r.server_id !== '*' ? <span className={`tag ${r.server_slug ? 'group' : 'muted'}`} title={r.server_slug ? undefined : `server id: ${r.server_id}`}>{r.server_slug || 'unknown'}</span> : <span className="hint">All</span>}</td>
                      <td className="path">{r.path_pattern}</td>
                      <td>{r.description}</td>
                      <td>{ctx.isAdmin ? <button className="btn danger xs" onClick={() => ctx.deleteGroupRule(group.id, i)}>Remove</button> : <span className="hint">—</span>}</td>
                    </tr>
                  ))}
                  {(group.rules || []).length === 0 ? <tr><td colSpan={6} className="empty">No rules — default deny applies.</td></tr> : null}
                </tbody>
              </table></div>

              {ctx.isAdmin ? (<form className="subform" onSubmit={addRule}>
                <h4>Add Policy Rule</h4>
                <div className="rule-grid">
                  <div className="field" style={{ marginBottom: 0 }}><label className="fl">Effect</label><select className="sel" value={eff} onChange={(e) => setEff(e.target.value as 'ALLOW' | 'DENY')}><option>ALLOW</option><option>DENY</option></select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label className="fl">Method</label><select className="sel" value={meth} onChange={(e) => setMeth(e.target.value)}><option value="*">* (All)</option><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label className="fl">Server</label><select className="sel" value={svr} onChange={(e) => setSvr(e.target.value)}><option value="">All servers</option>{ctx.servers.map((s) => <option key={s.id} value={s.id}>{s.name || s.slug}</option>)}</select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label className="fl">Path Pattern</label><input className="inp" value={pat} onChange={(e) => setPat(e.target.value)} required /></div>
                </div>
                <div className="field" style={{ margin: '14px 0' }}><label className="fl">Description</label><input className="inp" placeholder="e.g. Allows querying job parameters" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
                <button className="btn primary sm" type="submit">Add Rule</button>
              </form>) : null}
            </div>
          </div>
        ) : null}

        {section === 'global' ? (
          <div className="card">
            <div className="panel-head"><h2>System Global Rules</h2>{ctx.isAdmin ? <button className="btn primary sm" onClick={() => setGOpen(true)}><Icon name="shield" size={15} />Add Global Rule</button> : null}</div>
            <div className="panel-body" style={{ paddingBottom: 8 }}>
              <div className="callout danger" style={{ marginBottom: 4 }}><Icon name="shield" size={16} /><span><b>Override blocks.</b> A request matching any rule below is dropped immediately, overriding group-level allow rules.</span></div>
            </div>
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th>Method</th><th>Path Pattern</th><th>Action</th><th>Description</th><th></th></tr></thead>
              <tbody>
                {ctx.rules.map((r) => (
                  <tr key={r.id}>
                    <td><span className={`method ${methodClass(r.method)}`}>{r.method}</span></td>
                    <td className="path">{r.path_pattern}</td>
                    <td><span className="tag deny">{r.action.toUpperCase()}</span></td>
                    <td>{r.description}</td>
                    <td>{ctx.isAdmin ? <button className="btn danger xs" onClick={() => ctx.deleteGlobalRule(r.id)}>Remove</button> : <span className="hint">—</span>}</td>
                  </tr>
                ))}
                {ctx.rules.length === 0 ? <tr><td colSpan={5} className="empty">No global rules configured.</td></tr> : null}
              </tbody>
            </table></div>
          </div>
        ) : null}
      </div>

      {gOpen ? (
        <div className="overlay" onClick={() => setGOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Add Global Rule</h2><p>Block override applied to every client, ahead of group policies.</p></div>
            <form onSubmit={addGlobal}>
              <div className="modal-body">
                <div className="field"><label className="fl">HTTP Method</label><select className="sel" value={gm} onChange={(e) => setGm(e.target.value)}><option>DELETE</option><option>POST</option><option>PUT</option><option>GET</option><option value="*">* (All)</option></select></div>
                <div className="field"><label className="fl">Path Pattern</label><input className="inp" value={gp} onChange={(e) => setGp(e.target.value)} required autoFocus /><span className="hint">E.g. /api/v1/backupInfrastructure/* or *</span></div>
                <div className="field" style={{ marginBottom: 0 }}><label className="fl">Description</label><textarea className="ta" placeholder="Block configuration changes" value={gd} onChange={(e) => setGd(e.target.value)} /></div>
              </div>
              <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => setGOpen(false)}>Cancel</button><button type="submit" className="btn primary">Create Block Override</button></div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- AUDIT LOGS ---------------- */
export function LogsScreen({ ctx }: { ctx: Ctx }) {
  const [q, setQ] = useState('');
  const [mf, setMf] = useState('ALL');
  const [sf, setSf] = useState('ALL');
  const rows = ctx.logs.filter((l) => {
    const s = q.toLowerCase();
    const km = !s || [l.key_name, l.path, l.client_ip, l.action, l.resource].some((v) => (v || '').toLowerCase().includes(s));
    const mm = mf === 'ALL' || l.method === mf;
    let sm = true;
    if (sf === 'SUCCESS') sm = l.status_code >= 200 && l.status_code < 300;
    else if (sf === 'BLOCKED') sm = l.status_code === 403;
    else if (sf === 'FAILED') sm = l.status_code >= 400 && l.status_code !== 403;
    return km && mm && sm;
  });
  return (
    <div className="card">
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h2>Audit Transaction Log</h2>
        <div className="toolbar">
          <div className="search"><Icon name="search" size={16} /><input placeholder="Filter key, path, resource…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select className="sel" value={mf} onChange={(e) => setMf(e.target.value)}><option value="ALL">All Methods</option><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
          <select className="sel" value={sf} onChange={(e) => setSf(e.target.value)}><option value="ALL">All Transactions</option><option value="SUCCESS">Success (2xx)</option><option value="BLOCKED">Blocked (403)</option><option value="FAILED">Errors (4xx/5xx)</option></select>
        </div>
      </div>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>Time</th><th>Key / IP</th><th>Action</th><th>Resource</th><th>Server</th><th>Request</th><th>Status</th><th>Message</th></tr></thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <td className="t-time">{new Date(l.timestamp).toLocaleString()}</td>
              <td><div style={{ fontWeight: 600, fontSize: 12.5 }}>{l.key_name}</div><div className="mono-cell" style={{ fontSize: 11 }}>{l.client_ip || 'SYSTEM'}</div></td>
              <td><span className="tag muted">{l.action || 'API_CALL'}</span></td>
              <td style={{ fontSize: 12.5, fontWeight: 500 }}>{l.resource || 'General'}</td>
              <td>{l.server ? <span className="tag group">{l.server}</span> : <span className="hint">—</span>}</td>
              <td><span className={`method ${methodClass(l.method)}`}>{l.method}</span><span className="path">{l.path}</span></td>
              <td><span className={`status-tag ${statusClass(l.status_code)}`}>{l.status_code}</span></td>
              <td style={{ fontSize: 12.5, color: l.status_code === 403 ? 'var(--danger)' : 'var(--text-muted)' }}>{l.message}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={8} className="empty">No audit logs match the current filters.</td></tr> : null}
        </tbody>
      </table></div>
    </div>
  );
}

/* ---------------- VEEAM SERVERS ---------------- */
export function ServersScreen({ ctx }: { ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VeeamServer | null>(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [ver, setVer] = useState('1.3-rev1');
  const [isDef, setIsDef] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, ServerStatus & { loading?: boolean }>>({});

  const openAdd = () => { setEditing(null); setSlug(''); setName(''); setUrl(''); setUser(''); setPw(''); setVer('1.3-rev1'); setIsDef(ctx.servers.length === 0); setOpen(true); };
  const openEdit = (s: VeeamServer) => { setEditing(s); setSlug(s.slug); setName(s.name || ''); setUrl(s.url); setUser(s.username); setPw(s.hasPassword ? '******' : ''); setVer(s.apiVersion); setIsDef(s.isDefault); setOpen(true); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const data = { slug, name, url, username: user, password: pw, apiVersion: ver, isDefault: isDef };
    try {
      if (editing) await ctx.updateServer(editing.id, data); else await ctx.createServer(data);
      setOpen(false);
    } finally { setSaving(false); }
  };
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: { connectionStatus: 'Disconnected', error: null, loading: true } }));
    const r = await ctx.testServer(id);
    setTests((t) => ({ ...t, [id]: { ...r, loading: false } }));
  };

  if (!ctx.isAdmin) {
    return <div className="card"><div className="panel-body"><div className="callout warn"><Icon name="shield" size={16} /><span>Veeam server management is available to administrators.</span></div></div></div>;
  }

  return (
    <>
      <div className="card">
        <div className="panel-head"><h2>Veeam Servers <span className="sub" style={{ marginLeft: 8 }}>{ctx.servers.length}</span></h2><button className="btn primary sm" onClick={openAdd}><Icon name="server" size={15} />Add Server</button></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Name</th><th>Slug</th><th>URL</th><th>API Version</th><th>Default</th><th>Connection</th><th></th></tr></thead>
          <tbody>
            {ctx.servers.map((s) => {
              const t = tests[s.id];
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name || s.slug}</td>
                  <td><span className="tag group">{s.slug}</span></td>
                  <td className="mono-cell">{s.url}</td>
                  <td className="mono-cell">{s.apiVersion}</td>
                  <td>{s.isDefault ? <span className="tag allow">Default</span> : <span className="hint">—</span>}</td>
                  <td>{t?.loading
                    ? <span className="hint">Testing…</span>
                    : t
                      ? <span className={`pill ${t.connectionStatus === 'Connected' ? 'ok' : 'danger'}`} title={t.error || undefined}><span className={`dot ${t.connectionStatus === 'Connected' ? 'ok' : 'danger'}`}></span>{t.connectionStatus}</span>
                      : <button className="btn ghost xs" onClick={() => test(s.id)}>Test</button>}</td>
                  <td><div className="row-actions">
                    <button className="btn ghost xs" onClick={() => openEdit(s)}>Edit</button>
                    {!s.isDefault ? <button className="btn danger xs" onClick={() => ctx.deleteServer(s.id)}>Delete</button> : null}
                  </div></td>
                </tr>
              );
            })}
            {ctx.servers.length === 0 ? <tr><td colSpan={7} className="empty">No Veeam servers configured. Add one to start proxying.</td></tr> : null}
          </tbody>
        </table></div>
      </div>

      {open ? (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>{editing ? 'Edit' : 'Add'} Veeam Server</h2><p>Credentials are stored encrypted (AES-256-GCM) and never returned by the API.</p></div>
            <form onSubmit={submit}>
              <div className="modal-body">
                <div className="field"><label className="fl">Display Name</label><input className="inp" placeholder="e.g. Production VBR" value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div className="field"><label className="fl">Slug (URL segment)</label><input className="inp" placeholder="e.g. prod" value={slug} onChange={(e) => setSlug(e.target.value)} required /><span className="hint">Addressed as <code>/veeam/&lt;slug&gt;/…</code> — lowercase/URL-safe, and not <code>api</code>.</span></div>
                <div className="field"><label className="fl">Veeam REST API URL</label><input className="inp" type="url" placeholder="https://192.168.0.238:9419" value={url} onChange={(e) => setUrl(e.target.value)} required /><span className="hint">Include protocol and port (typically 9419).</span></div>
                <div className="field"><label className="fl">Username</label><input className="inp" value={user} onChange={(e) => setUser(e.target.value)} required /></div>
                <div className="field"><label className="fl">Password</label><input className="inp" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required={!editing} /><span className="hint">{editing ? 'Leave as ****** to keep the current password.' : ''}</span></div>
                <div className="field"><label className="fl">API Version</label><input className="inp" placeholder="1.3-rev1" value={ver} onChange={(e) => setVer(e.target.value)} /><span className="hint">Sent as the <code>x-api-version</code> header. Update when this server's REST API version changes.</span></div>
                <label className="check-row" style={{ marginBottom: 0 }}><input type="checkbox" checked={isDef} onChange={(e) => setIsDef(e.target.checked)} /><span className="cr-text"><b>Default server</b><span>Used when a key/request doesn't name a specific server.</span></span></label>
              </div>
              <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn primary" disabled={saving}><Icon name="server" size={15} />{saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add Server')}</button></div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ---------------- MODALS ---------------- */
export function RevealModal({ name, token, onClose, toast }: { name: string; token: string; onClose: () => void; toast: (m: string) => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>API Token Generated</h2><p>Key <b>{name}</b> was created. Copy the token now — for security it won't be shown again.</p></div>
        <div className="modal-body">
          <div className="reveal"><code>{token}</code><button className="copy" onClick={() => { navigator.clipboard?.writeText(token); toast('Token copied'); }}><Icon name="copy" size={14} />Copy</button></div>
        </div>
        <div className="modal-foot"><button className="btn primary" onClick={onClose}>I've saved this key</button></div>
      </div>
    </div>
  );
}

export function UserGroupsModal({ user, groups, onSave, onClose }: { user: User; groups: Group[]; onSave: (gids: string[]) => void; onClose: () => void }) {
  const [gids, setGids] = useState<string[]>([...user.groupIds]);
  const toggle = (id: string) => setGids((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>Assign Groups · {user.username}</h2></div>
        <div className="modal-body">
          <div className="check-list" style={{ maxHeight: 260 }}>
            {groups.map((g) => (
              <label key={g.id} className="check-row"><input type="checkbox" checked={gids.includes(g.id)} onChange={() => toggle(g.id)} /><span className="cr-text"><b>{g.name}</b><span>{g.description}</span></span></label>
            ))}
          </div>
        </div>
        <div className="modal-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(gids)}>Save Mappings</button></div>
      </div>
    </div>
  );
}

export function CreateGroupModal({ onSave, onClose }: { onSave: (name: string, desc: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; onSave(name, desc); };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>Create Security Group</h2></div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="field"><label className="fl">Group Name</label><input className="inp" placeholder="e.g. Operators-Restricted" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></div>
            <div className="field" style={{ marginBottom: 0 }}><label className="fl">Description</label><textarea className="ta" placeholder="Access policy for operator keys with blocked repo deletion" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          </div>
          <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn primary">Create Group</button></div>
        </form>
      </div>
    </div>
  );
}
