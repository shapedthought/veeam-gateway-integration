// Shared types for the Veeam Gateway console UI.

export interface ApiKey {
  id: string;
  name: string;
  token_masked: string;
  role?: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  allowed_ips: string | null;
  created_at?: string;
  owner_name: string | null;
}

export interface GlobalRule {
  id: number;
  method: string;
  path_pattern: string;
  action: 'block' | 'allow';
  description: string;
}

export interface GroupRule {
  id?: string;
  effect: 'ALLOW' | 'DENY';
  method: string;
  path_pattern: string;
  description: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  rules: GroupRule[];
}

export interface User {
  id: string;
  username: string;
  email: string;
  created_at: string;
  groups: string[];
  groupIds: string[];
}

export interface AuditLog {
  id: number;
  timestamp: string;
  key_id?: string;
  key_name: string;
  method: string;
  path: string;
  status_code: number;
  message: string;
  client_ip: string | null;
  action: string | null;
  resource: string | null;
}

export interface StatusInfo {
  veeamConfigured: boolean;
  veeamUrl: string;
  connectionStatus: 'Connected' | 'Disconnected' | 'Error';
  error: string | null;
  role?: string;
  isAdmin?: boolean;
}

export type TabId = 'dashboard' | 'keys' | 'users' | 'security' | 'logs' | 'config';

export interface ConfigInfo {
  url: string;
  username: string;
  hasPassword: boolean;
}

/** Context object handed to every screen component. */
export interface Ctx {
  keys: ApiKey[];
  users: User[];
  groups: Group[];
  rules: GlobalRule[];
  logs: AuditLog[];
  config: ConfigInfo;
  status: StatusInfo | null;
  isAdmin: boolean;
  toast: (msg: string) => void;
  go: (tab: TabId) => void;
  createKey: (data: { name: string; userId: string; ips: string; exp: string; role: 'Admin' | 'Viewer' }) => void;
  revokeKey: (id: string) => void;
  createUser: (data: { name: string; email: string; gids: string[] }) => void;
  deleteUser: (id: string) => void;
  openUserGroups: (user: User) => void;
  openCreateGroup: () => void;
  deleteGroup: (id: string) => void;
  addGroupRule: (groupId: string, rule: GroupRule) => void;
  deleteGroupRule: (groupId: string, index: number) => void;
  addGlobalRule: (rule: { method: string; path_pattern: string; description: string }) => void;
  deleteGlobalRule: (id: number) => void;
  saveConfig: (data: { url: string; username: string; password: string }) => Promise<void>;
}
