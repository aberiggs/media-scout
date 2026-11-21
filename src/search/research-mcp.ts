import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isRegularExecuteTool, type Tool } from '@openrouter/agent';
import { createMCPTools, MCPError, type MCPToolsHandle } from '@openrouter/agent/mcp';
import { Agent } from 'undici';
import type { SearchStore } from './store';

const forbiddenHeaders = new Set([
  'accept', 'accept-encoding', 'authorization', 'connection', 'content-length', 'content-type', 'cookie',
  'forwarded', 'host', 'keep-alive', 'origin', 'last-event-id',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'expect', 'x-original-url', 'x-rewrite-url', 'x-http-method-override',
]);
const connectTimeoutMs = 10_000;
const researchRequestTimeoutMs = 18_000;
const maxToolsPerServer = 50;
const maxToolDefinitionsBytes = 512 * 1024;
// The adapter's tool wrapper only forwards its connection-level signal to the
// MCP SDK. Scope the fetch signal to this invocation, including SSE resumption.
const researchCall = new AsyncLocalStorage<AbortSignal>();

/** Normalize pasted HTTP(S) URLs while rejecting URL credentials and modifiers. */
export function canonicalEndpoint(value: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('invalid-endpoint');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('invalid-endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value))
    throw new Error('invalid-endpoint');
  return url.href;
}

export function safeHeaderName(value: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) || forbiddenHeaders.has(value.toLowerCase()) || /^(?:proxy-|sec-|mcp-|x-forwarded-)/i.test(value))
    throw new Error('invalid-header');
  return value;
}

export interface ResearchMcpServer {
  id: string; name: string; url: string; enabled: boolean;
  credentialConfigured: boolean; toolNames: string[];
}
type DiscoveredTool = { name: string; description: string; fingerprint: string };
type Credential = { header: string; value: string };
type StoredServer = { id: string; name: string; url: string; enabled: boolean; credential?: Credential; discoveredTools?: DiscoveredTool[]; modelPrefix?:string };
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
  if (!Array.isArray(value)) return [];
  return (value as Array<StoredServer & { approvedTools?: Array<{ name: string; fingerprint: string }> }>).map(row => {
    const { approvedTools, ...server } = row;
    if (!Array.isArray(approvedTools)) return server;
    // A discovery performed by the previous version was not authorization.
    // Carry its exact approved subset forward until an explicit reconnect.
    const previous = new Map(approvedTools.map(tool => [tool.name, tool.fingerprint]));
    return { ...server, discoveredTools: server.discoveredTools?.filter(tool => previous.get(tool.name) === tool.fingerprint) };
  });
}
function toolPrefix(server: Pick<StoredServer, 'id'|'name'|'modelPrefix'>): string {
  if (server.modelPrefix) return server.modelPrefix;
  const readable = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 8) || 'server';
  return `research_${readable}_${server.id.replaceAll('-', '').slice(0, 12)}_`;
}
function publicRecord(row: StoredServer): ResearchMcpServer {
  const definitions = row.discoveredTools ?? [];
  const toolNames = definitions.filter(tool => tool.name.length + toolPrefix(row).length <= 64)
    .map(tool => `${toolPrefix(row)}${tool.name}`);
  return { id: row.id, name: row.name, url: row.url, enabled: row.enabled, credentialConfigured: !!row.credential, toolNames };
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
export async function saveResearchServer(store: SearchStore, id: string | undefined, input: {
  name: string; url: string; enabled: boolean;
  credential?: { mode: 'replace'; header: string; value: string } | { mode: 'clear' };
}): Promise<ResearchMcpServer> {
  const all = records(store), prior = id ? all.find(row => row.id === id) : undefined;
  if (id && !prior) throw new Error('not-found');
  if (!prior && all.length >= 12) throw new Error('server-limit');
  const url = canonicalEndpoint(input.url);
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
  const idValue = prior?.id ?? randomUUID();
  const readable = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 8) || 'server';
  const idCompact = idValue.replaceAll('-', '');
  let idLength = 8;
  const usedPrefixes = new Set(all.filter(existing => existing.id !== id).map(existing => existing.modelPrefix ?? toolPrefix(existing)));
  let modelPrefix = `research_${readable}_${idCompact.slice(0, idLength)}_`;
  while (usedPrefixes.has(modelPrefix) && idLength < idCompact.length) modelPrefix = `research_${readable}_${idCompact.slice(0, ++idLength)}_`;
  const unchangedSettings = !!prior && unchangedConnection && prior.enabled === input.enabled && prior.name === input.name;
  let discoveredTools = unchangedConnection ? prior?.discoveredTools : undefined;
  const row: StoredServer = { id: idValue, name: input.name, url, enabled: input.enabled, modelPrefix, ...(credential ? { credential } : {}), ...(discoveredTools ? { discoveredTools } : {}) };
  // Re-submitting an unchanged enabled record is the explicit reconnect action.
  const needsConnect = input.enabled && (!unchangedConnection || !prior?.enabled || unchangedSettings);
  if (needsConnect) {
    const definitions = await discoverDefinitions(row);
    if (!definitions.length) throw new Error('research-no-usable-tools');
    discoveredTools = definitions;
    row.discoveredTools = definitions;
  }
  if (unchangedSettings && !needsConnect) return publicRecord(prior!);
  const latest = records(store);
  if (prior) {
    const current = latest.find(existing => existing.id === id);
    if (!current || stableJson(current) !== stableJson(prior)) throw new Error('research-settings-changed');
  } else if (latest.length >= 12) throw new Error('server-limit');
  store.setSetting(settingKey, latest.filter(existing => existing.id !== id).concat(row));
  return publicRecord(row);
}
export function deleteResearchServer(store: SearchStore, id: string): boolean {
  const all = records(store);
  if (!all.some(row => row.id === id)) return false;
  store.setSetting(settingKey, all.filter(row => row.id !== id));
  return true;
}

function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return secrets.some(secret => secret.length > 0 && value.includes(secret));
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secrets));
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => containsSecret(key, secrets) || containsSecret(item, secrets));
}
function validDefinitions(server: StoredServer, tools: ToolDefinition[], secrets: readonly string[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return tools.filter(tool => counts.get(tool.name) === 1 && /^[A-Za-z0-9_-]+$/.test(tool.name)
    && toolPrefix(server).length + tool.name.length <= 64 && !containsSecret(tool, secrets));
}
const blockedMetadataHosts = new Set(['metadata.google.internal', 'metadata.google', 'metadata.azure.internal', 'instance-data.ec2.internal']);
function blockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100) || (a === 192 && b === 0 && c === 0) || address === '168.63.129.16';
  }
  const value = address.toLowerCase().split('%')[0]!;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    const dotted = mapped.includes('.') ? mapped : (() => {
      const parts = mapped.split(':');
      if (parts.length !== 2) return mapped;
      const high = Number.parseInt(parts[0]!, 16), low = Number.parseInt(parts[1]!, 16);
      if (!Number.isFinite(high) || !Number.isFinite(low)) return mapped;
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    })();
    return blockedAddress(dotted);
  }
  return value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
    || value.startsWith('fd00:ec2:');
}
async function resolveResearchEndpoint(endpoint: string) {
  const url = new URL(canonicalEndpoint(endpoint));
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (blockedMetadataHosts.has(hostname)) throw new Error('research-metadata-endpoint-denied');
  let addresses: Array<{address:string;family:number}>;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('research-endpoint-unavailable'); }
  if (!addresses.length || addresses.some(item => blockedAddress(item.address))) throw new Error('research-metadata-endpoint-denied');
  return addresses;
}
export async function assertResearchEndpointSafe(endpoint: string): Promise<void> {
  await resolveResearchEndpoint(endpoint);
}
async function openResearchMcp(server: StoredServer, includeTools: string[], parent?: AbortSignal, deadlineMs = connectTimeoutMs) {
  const timeout = new AbortController();
  const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), deadlineMs);
  const resolveWithinDeadline = async () => {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('research-timeout'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([resolveResearchEndpoint(server.url), aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  };
  let lastPostStatus: number | undefined;
  let redirected = false;
  let dispatcher: Agent | undefined;
  const restrictedFetch: typeof fetch = async (input, init) => {
    const requested = input instanceof Request ? input.url : String(input);
    if (requested !== server.url) throw new Error('endpoint-denied');
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const callSignal = researchCall.getStore();
    const signals = [signal, ...(requestSignal ? [requestSignal] : []), ...(callSignal ? [callSignal] : [])];
    // Node's bundled Undici and the standalone package have separate types.
    const options: RequestInit = { ...init, redirect: 'manual', signal: AbortSignal.any(signals), dispatcher: dispatcher as unknown as RequestInit['dispatcher'] };
    const response = await fetch(input, options);
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
    // Pin the validated DNS answers for this SDK connection. Passing only the
    // original hostname to fetch would resolve it again between check and use.
    const addresses = await resolveWithinDeadline();
    dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
      const matching = typeof options.family === 'number' && options.family ? addresses.filter(address => address.family === options.family) : addresses;
      if (options.all) callback(null, matching);
      else if (matching[0]) callback(null, matching[0].address, matching[0].family);
      else callback(Object.assign(new Error('No matching endpoint address'), { code: 'ENOTFOUND' }), '');
    } } });
    const ownedDispatcher = dispatcher;
    const handle = await createMCPTools({
      url: server.url, transport: 'streamableHttp', auth, fetch: restrictedFetch, signal, includeTools,
      toolNamePrefix: toolPrefix(server), resources: false, emitProgress: false, autoRefreshOnListChanged: false,
    });
    return { ...handle, close: async () => { try { await handle.close(); } finally { await ownedDispatcher.destroy(); } } };
  } catch (error) {
    await dispatcher?.destroy().catch(() => {});
    if (parent?.aborted) throw parent.reason;
    if (timeout.signal.aborted) throw new Error('research-timeout');
    if (redirected) throw new Error('research-redirect-denied');
    if (lastPostStatus === 401 || lastPostStatus === 403) throw new Error('research-auth-failed');
    if (error instanceof Error && ['research-metadata-endpoint-denied', 'research-endpoint-unavailable'].includes(error.message)) throw error;
    if (error instanceof MCPError && error.message.startsWith('Duplicate tool name ')) throw new Error('research-duplicate-tools');
    throw new Error('research-mcp-unavailable');
  } finally { clearTimeout(timer); }
}

async function discoverDefinitions(row: StoredServer): Promise<DiscoveredTool[]> {
  // Discover definitions only; do not construct executable wrappers for arbitrary advertised tools.
  const handle = await openResearchMcp(row, []);
  try {
    const { tools } = await handle.serialize();
    if (tools.length > maxToolsPerServer || Buffer.byteLength(JSON.stringify(tools)) > maxToolDefinitionsBytes)
      throw new Error('research-tool-limit');
    const discovered = validDefinitions(row, tools, credentialValues(row.credential)).map(tool => ({
      name: tool.name, description: (tool.description ?? '').slice(0, 1000), fingerprint: fingerprint(tool),
    }));
    return discovered;
  } finally { await handle.close(); }
}

export function enabledResearchServerConfigs(store: SearchStore) {
  return records(store).filter(row => row.enabled && row.discoveredTools?.length);
}

async function openResearchMcpForJob(server: StoredServer, signal: AbortSignal, secrets: readonly string[]) {
  const names = (server.discoveredTools ?? []).map(tool => tool.name);
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

export async function connectResearchTools(
  servers: ReturnType<typeof enabledResearchServerConfigs>,
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
    const label = redactText(server.name);
    try {
      const handle = await openResearchMcpForJob(server, signal, secrets);
      handles.push(handle);
      const { tools: definitions } = await handle.serialize();
      const snapshot = new Map((server.discoveredTools ?? []).map(item => [item.name, item.fingerprint]));
      const names = new Set(validDefinitions(server, definitions, secrets)
        .filter(definition => snapshot.get(definition.name) === fingerprint(definition))
        .map(definition => `${toolPrefix(server)}${definition.name}`));
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
      if (tools.length !== snapshot.size) warn?.(`Some connected tools from ${label} are missing or changed. Reconnect this server in Settings.`);
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
  if (duplicates.size) warn?.('Some research tools have conflicting names. Rename one of the servers in Settings.');
  return { tools: tools.filter(({ name }) => !duplicates.has(name)).map(({ tool }) => tool), close };
}
