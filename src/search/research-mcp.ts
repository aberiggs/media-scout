import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { isRegularExecuteTool, type Tool } from '@openrouter/agent';
import { createMCPTools, MCPError, type MCPToolsHandle } from '@openrouter/agent/mcp';
import type { SearchStore } from './store';

const forbiddenHeaders = new Set([
  'accept', 'accept-encoding', 'authorization', 'connection', 'content-length', 'content-type', 'cookie',
  'forwarded', 'host', 'keep-alive', 'origin', 'last-event-id',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'expect',
]);
const connectTimeoutMs = 10_000;
const researchRequestTimeoutMs = 18_000;
// The adapter's tool wrapper only forwards its connection-level signal to the
// MCP SDK. Scope the fetch signal to this invocation, including SSE resumption.
const researchCall = new AsyncLocalStorage<AbortSignal>();

/** Exact canonical URL; intentionally rejects URL normalization and ambient credentials. */
export function canonicalEndpoint(value: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('invalid-endpoint');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('invalid-endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value) || url.href !== value)
    throw new Error('invalid-endpoint');
  return value;
}

export function safeHeaderName(value: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) || forbiddenHeaders.has(value.toLowerCase()) || /^(?:proxy-|sec-|mcp-|x-forwarded-)/i.test(value))
    throw new Error('invalid-header');
  return value;
}

export interface ApprovedResearchTool { name: string; fingerprint: string }
export interface ResearchMcpServer {
  id: string; name: string; namespace: string; url: string; enabled: boolean;
  credentialConfigured: boolean; approvedTools: ApprovedResearchTool[];
}
type DiscoveredTool = { name: string; description: string; fingerprint: string };
type Credential = { header: string; value: string };
type StoredServer = Omit<ResearchMcpServer, 'credentialConfigured'> & { credential?: Credential; discoveredTools?: DiscoveredTool[] };
type ToolDefinition = Awaited<ReturnType<MCPToolsHandle['serialize']>>['tools'][number];
const settingKey = 'research-mcp-servers-v1';
const fingerprint = (tool: unknown) => createHash('sha256').update(stableJson(tool)).digest('hex');
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function records(store: SearchStore): StoredServer[] {
  const value = store.getSetting(settingKey);
  return Array.isArray(value) ? value as StoredServer[] : [];
}
function publicRecord(row: StoredServer): ResearchMcpServer {
  const { credential, discoveredTools: _discoveredTools, ...safe } = row;
  return { ...safe, credentialConfigured: !!credential };
}
function allowed(url: string, endpoints: readonly string[]): string {
  const canonical = canonicalEndpoint(url);
  if (!endpoints.includes(canonical)) throw new Error('endpoint-denied');
  return canonical;
}
export function listResearchServers(store: SearchStore): ResearchMcpServer[] {
  return records(store).map(publicRecord);
}
function sameCredential(a: Credential | undefined, b: Credential | undefined) {
  return a?.header === b?.header && a?.value === b?.value;
}
function credentialValues(credential?: Credential) {
  if (!credential) return [];
  return [credential.value, ...(credential.header === 'authorization' ? [credential.value.slice(7)] : [])];
}
export function saveResearchServer(store: SearchStore, endpoints: readonly string[], id: string | undefined, input: {
  name: string; namespace: string; url: string; enabled: boolean; approvedTools: ApprovedResearchTool[];
  credential?: { mode: 'replace'; header: string; value: string } | { mode: 'clear' };
}): ResearchMcpServer {
  const all = records(store), prior = id ? all.find(row => row.id === id) : undefined;
  if (id && !prior) throw new Error('not-found');
  if (!prior && all.length >= 12) throw new Error('server-limit');
  const url = canonicalEndpoint(input.url);
  if (!(prior?.url === url && !input.enabled && input.credential?.mode !== 'replace')) allowed(url, endpoints);
  if (all.some(row => row.id !== id && row.namespace.toLowerCase() === input.namespace.toLowerCase())) throw new Error('namespace-conflict');
  const sameUrl = prior?.url === url;
  let credential = sameUrl ? prior?.credential : undefined;
  if (input.credential?.mode === 'clear') credential = undefined;
  if (input.credential?.mode === 'replace') {
    const header = input.credential.header.toLowerCase();
    if (header !== 'authorization') safeHeaderName(header);
    if (!/^[\x20-\x7e]+$/.test(input.credential.value) || input.credential.value.trim() !== input.credential.value
      || (header === 'authorization' && !/^Bearer [!-~]+$/.test(input.credential.value))) throw new Error('invalid-credential');
    credential = { header, value: input.credential.value };
  }
  const unchangedConnection = sameUrl && sameCredential(prior?.credential, credential);
  const discoveredTools = unchangedConnection ? prior?.discoveredTools : undefined;
  const approvedTools = [...new Map(input.approvedTools
    .filter(approval => discoveredTools?.some(tool => tool.name === approval.name && tool.fingerprint === approval.fingerprint))
    .map(approval => [approval.name, approval])).values()];
  const row: StoredServer = {
    id: prior?.id ?? randomUUID(), name: input.name, namespace: input.namespace, url, enabled: input.enabled,
    approvedTools, ...(discoveredTools ? { discoveredTools } : {}), ...(credential ? { credential } : {}),
  };
  store.setSetting(settingKey, all.filter(existing => existing.id !== id).concat(row));
  return publicRecord(row);
}
export function deleteResearchServer(store: SearchStore, id: string): boolean {
  const all = records(store);
  if (!all.some(row => row.id === id)) return false;
  store.setSetting(settingKey, all.filter(row => row.id !== id));
  return true;
}

function prefix(server: StoredServer): string { return `research_${server.namespace.toLowerCase()}_`; }
function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return secrets.some(secret => secret.length > 0 && value.includes(secret));
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secrets));
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => containsSecret(key, secrets) || containsSecret(item, secrets));
}
function validDefinitions(server: StoredServer, tools: ToolDefinition[], secrets: readonly string[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return tools.filter(tool => counts.get(tool.name) === 1 && /^[A-Za-z0-9_-]+$/.test(tool.name)
    && prefix(server).length + tool.name.length <= 64 && !containsSecret(tool, secrets));
}
async function openResearchMcp(server: StoredServer, includeTools: string[], parent?: AbortSignal, deadlineMs = connectTimeoutMs) {
  const timeout = new AbortController();
  const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), deadlineMs);
  let lastPostStatus: number | undefined;
  let redirected = false;
  const restrictedFetch: typeof fetch = async (input, init) => {
    const requested = input instanceof Request ? input.url : String(input);
    if (requested !== server.url) throw new Error('endpoint-denied');
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const callSignal = researchCall.getStore();
    const signals = [signal, ...(requestSignal ? [requestSignal] : []), ...(callSignal ? [callSignal] : [])];
    const response = await fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.any(signals) });
    if (method === 'POST') lastPostStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      redirected = true;
      void response.body?.cancel().catch(() => {});
      throw new Error('research-redirect-denied');
    }
    return response;
  };
  const auth = server.credential ? { kind: 'headers' as const, headers: { [server.credential.header]: server.credential.value } } : undefined;
  try {
    return await createMCPTools({
      url: server.url, transport: 'streamableHttp', auth, fetch: restrictedFetch, signal, includeTools,
      toolNamePrefix: prefix(server), resources: false, emitProgress: false, autoRefreshOnListChanged: false,
    });
  } catch (error) {
    if (parent?.aborted) throw parent.reason;
    if (timeout.signal.aborted) throw new Error('research-timeout');
    if (redirected) throw new Error('research-redirect-denied');
    if (lastPostStatus === 401 || lastPostStatus === 403) throw new Error('research-auth-failed');
    if (error instanceof MCPError && error.message.startsWith('Duplicate tool name ')) throw new Error('research-duplicate-tools');
    throw new Error('research-mcp-unavailable');
  } finally { clearTimeout(timer); }
}

export async function discoverResearchTools(store: SearchStore, endpoints: readonly string[], id: string): Promise<DiscoveredTool[]> {
  const row = records(store).find(item => item.id === id);
  if (!row) throw new Error('not-found');
  allowed(row.url, endpoints);
  // Discover definitions only; do not construct executable wrappers for arbitrary advertised tools.
  const handle = await openResearchMcp(row, []);
  try {
    const { tools } = await handle.serialize();
    const all = records(store);
    const current = all.find(item => item.id === id);
    if (current?.url !== row.url || !sameCredential(current.credential, row.credential)) throw new Error('research-settings-changed');
    const discovered = validDefinitions(current, tools, credentialValues(current.credential)).map(tool => ({
      name: tool.name, description: (tool.description ?? '').slice(0, 1000), fingerprint: fingerprint(tool),
    }));
    store.setSetting(settingKey, all.map(item => item.id === id ? { ...item, discoveredTools: discovered } : item));
    return discovered;
  } finally { await handle.close(); }
}

export function enabledResearchServerConfigs(store: SearchStore) {
  return records(store).filter(row => row.enabled && row.approvedTools.length);
}

async function openApprovedMcp(server: StoredServer, signal: AbortSignal, secrets: readonly string[]) {
  const names = server.approvedTools.map(tool => tool.name);
  const deadline = Date.now() + connectTimeoutMs;
  const timeLeft = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('research-timeout');
    return remaining;
  };
  try {
    return await openResearchMcp(server, names, signal, timeLeft());
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'research-duplicate-tools') throw error;
  }
  // The SDK rejects duplicate executable tools before returning a handle. On
  // this malformed-server path only, list without wrappers and retry with
  // unambiguous names; the executable handle's own definitions are checked again.
  const scan = await openResearchMcp(server, [], signal, timeLeft());
  let unique: string[];
  try { unique = validDefinitions(server, (await scan.serialize()).tools, secrets).map(tool => tool.name); }
  finally { await scan.close(); }
  return openResearchMcp(server, names.filter(name => unique.includes(name)), signal, timeLeft());
}

async function runResearchCall<T>(parent: AbortSignal, run: () => T | Promise<T>): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(researchRequestTimeoutMs)]);
  signal.throwIfAborted();
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    // An SSE body can be interrupted without the SDK rejecting the pending
    // JSON-RPC result. Settle the tool at our deadline independently of fetch.
    return await Promise.race([deadline, researchCall.run(signal, async () => run())]);
  } finally { signal.removeEventListener('abort', abort); }
}

export async function connectApprovedResearchTools(
  servers: ReturnType<typeof enabledResearchServerConfigs>,
  endpoints: readonly string[],
  signal: AbortSignal,
  privateValues: readonly string[],
  warn?: (message: string) => void,
): Promise<{ tools: Tool[]; close(): Promise<void> }> {
  const handles: MCPToolsHandle[] = [];
  const close = async () => { await Promise.allSettled(handles.map(handle => handle.close())); };
  const groups = await Promise.all(servers.map(async server => {
    const secrets = [...privateValues, ...credentialValues(server.credential)].filter(Boolean);
    const redactText = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
      .replace(/magnet:\?[^\s"'<>]+/gi, '[private release locator]');
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') return redactText(value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), redact(item)]));
      return value;
    };
    const label = redactText(server.namespace);
    try {
      allowed(server.url, endpoints);
      const handle = await openApprovedMcp(server, signal, secrets);
      handles.push(handle);
      const { tools: definitions } = await handle.serialize();
      const approved = new Map(server.approvedTools.map(item => [item.name, item.fingerprint]));
      const names = new Set(validDefinitions(server, definitions, secrets)
        .filter(definition => approved.get(definition.name) === fingerprint(definition))
        .map(definition => `${prefix(server)}${definition.name}`));
      const tools: Array<{ name: string; tool: Tool }> = [];
      for (const wrapped of handle.tools) {
        if (!isRegularExecuteTool(wrapped) || !names.has(wrapped.function.name)) continue;
        const fn = wrapped.function;
        tools.push({ name: fn.name, tool: { ...wrapped, function: { ...fn, timeoutMs: researchRequestTimeoutMs + 2_000, execute: async (args, context) => {
          if (containsSecret(args, secrets) || /magnet:\?/i.test(JSON.stringify(args)))
            throw new Error('Private data is not accepted by research tools.');
          try { return redact(await runResearchCall(context?.signal ?? signal, () => fn.execute(args, context))); }
          catch {
            if (!signal.aborted) warn?.(`A research tool from ${label} failed. The search can continue without it.`);
            throw new Error('Optional research tool failed.');
          }
        } } } });
      }
      if (tools.length !== approved.size) warn?.(`Some approved tools from ${label} are missing or changed. Rediscover and approve them in Settings.`);
      return tools;
    } catch {
      if (!signal.aborted) warn?.(`Research MCP ${label} is unavailable. The search can continue without it.`);
      return [];
    }
  }));
  if (signal.aborted) { await close(); throw signal.reason; }
  const tools = groups.flat();
  const names = new Set<string>(), duplicates = new Set<string>();
  for (const { name } of tools) {
    if (names.has(name)) duplicates.add(name);
    names.add(name);
  }
  if (duplicates.size) warn?.('Some research tools have conflicting names. Change their namespace in Settings.');
  return { tools: tools.filter(({ name }) => !duplicates.has(name)).map(({ tool }) => tool), close };
}
