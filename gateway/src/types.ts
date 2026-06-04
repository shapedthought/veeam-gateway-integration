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
  default_server?: string | null; // slug of the key's default VBR (null = system default)
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
  server_id?: string | null;   // null/undefined/'*' = applies to all servers
  server_slug?: string | null; // display only (joined server-side)
}

export interface VeeamServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  username: string;
  hasPassword: boolean;
  apiVersion: string;
  isDefault: boolean;
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
  server?: string | null; // which Veeam server the request hit
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
  apiVersion: string;
}

/** Context object handed to every screen component. */
export interface Ctx {
  keys: ApiKey[];
  users: User[];
  groups: Group[];
  servers: VeeamServer[];
  rules: GlobalRule[];
  logs: AuditLog[];
  config: ConfigInfo;
  status: StatusInfo | null;
  isAdmin: boolean;
  toast: (msg: string) => void;
  go: (tab: TabId) => void;
  createKey: (data: { name: string; userId: string; ips: string; exp: string; role: 'Admin' | 'Viewer'; defaultServerId: string }) => void;
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
  saveConfig: (data: { url: string; username: string; password: string; apiVersion: string }) => Promise<void>;
  createServer: (data: ServerInput) => Promise<boolean>;
  updateServer: (id: string, data: ServerInput) => Promise<boolean>;
  deleteServer: (id: string) => void;
  testServer: (id: string) => Promise<ServerStatus>;
}

export interface ServerInput {
  slug: string;
  name: string;
  url: string;
  username: string;
  password: string;
  apiVersion: string;
  isDefault: boolean;
}

export interface ServerStatus {
  connectionStatus: 'Connected' | 'Disconnected' | 'Error';
  error: string | null;
}
