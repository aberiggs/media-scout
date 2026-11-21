import { describe, expect, it } from 'vitest';
import { assertResearchEndpointSafe, canonicalEndpoint, enabledResearchServerConfigs, safeHeaderName } from '../src/search/research-mcp';
import { deleteResearchServer, listResearchServers, saveResearchServer } from '../src/search/research-mcp';
import { openSearchStore } from '../src/search/store';

describe('research MCP endpoint safety', () => {
  it('accepts only canonical exact HTTP endpoints and rejects URL components that can redirect identity', () => {
    expect(canonicalEndpoint('http://127.0.0.1:8080/mcp')).toBe('http://127.0.0.1:8080/mcp');
    for (const value of ['http://example.test/mcp?x=1', 'http://example.test/#x', 'http://u:p@example.test/mcp', 'file:///tmp/mcp']) {
      expect(() => canonicalEndpoint(value)).toThrow();
    }
    expect(canonicalEndpoint('HTTP://example.test/mcp')).toBe('http://example.test/mcp');
  });

  it('rejects protocol and hop-by-hop custom credential headers', () => {
    expect(safeHeaderName('X-Api-Key')).toBe('X-Api-Key');
    for (const value of ['Host', 'Connection', 'Transfer-Encoding', 'Content-Length', 'Cookie', 'Authorization']) {
      expect(() => safeHeaderName(value)).toThrow();
    }
  });
  it('preserves IDs and credentials on rename/disable, clears credentials on URL change, and derives unique tool names', async () => {
    const store = openSearchStore(':memory:');
    try {
      const saved = await saveResearchServer(store, undefined, { name: 'One', url: 'http://one.test/mcp', enabled: false, credential: { mode: 'replace', header: 'X-Key', value: 'secret' } });
      const renamed = await saveResearchServer(store, saved.id, { name: 'Renamed', url: saved.url, enabled: false });
      expect(renamed).toMatchObject({ id: saved.id, name: 'Renamed', credentialConfigured: true, toolNames: [] });
      const changed = await saveResearchServer(store, saved.id, { name: 'Renamed', url: 'http://two.test/mcp', enabled: false });
      expect(changed).toMatchObject({ id: saved.id, url: 'http://two.test/mcp', credentialConfigured: false, toolNames: [] });
      expect(JSON.stringify(listResearchServers(store))).not.toContain('secret');
      expect(store.getSetting('application-settings')).toBeNull();
      expect(deleteResearchServer(store, saved.id)).toBe(true);
    } finally { store.close(); }
  });
  it('blocks metadata and link-local literal endpoints but permits local and private LAN addresses', async () => {
    await expect(assertResearchEndpointSafe('http://169.254.169.254/latest/meta-data')).rejects.toThrow('research-metadata-endpoint-denied');
    await expect(assertResearchEndpointSafe('http://[fe80::1]/mcp')).rejects.toThrow('research-metadata-endpoint-denied');
    await expect(assertResearchEndpointSafe('http://metadata.google.internal/mcp')).rejects.toThrow('research-metadata-endpoint-denied');
    await expect(assertResearchEndpointSafe('http://127.0.0.1:8080/mcp')).resolves.toBeUndefined();
    await expect(assertResearchEndpointSafe('http://192.168.1.2/mcp')).resolves.toBeUndefined();
  });
  it('reads legacy records under the existing setting key without exposing credentials or changing IDs', async () => {
    const store = openSearchStore(':memory:');
    const id = 'legacy-server-id';
    store.setSetting('research-mcp-servers-v1', [{
      id, name: 'Legacy', namespace: 'old-name', url: 'http://127.0.0.1:1234/mcp', enabled: false,
      credential: { header: 'authorization', value: 'Bearer old-secret' }, approvedTools: [],
    }]);
    try {
      expect(listResearchServers(store)).toEqual([{
        id, name: 'Legacy', url: 'http://127.0.0.1:1234/mcp', enabled: false,
        credentialConfigured: true, toolNames: [],
      }]);
      const renamed = await saveResearchServer(store, id, { name: 'Legacy renamed', url: 'http://127.0.0.1:1234/mcp', enabled: false });
      expect(renamed.id).toBe(id);
      expect(store.getSetting('research-mcp-servers-v1')).toMatchObject([{ id, credential: { value: 'Bearer old-secret' } }]);
      expect(JSON.stringify(renamed)).not.toContain('old-secret');
    } finally { store.close(); }
  });
  it('does not trust tools that were discovered but not approved under the previous contract', async () => {
    const store = openSearchStore(':memory:');
    const url = 'http://127.0.0.1:1234/mcp';
    const allowed = { name: 'lookup', fingerprint: 'a'.repeat(64) };
    const discoveredTools = [{ ...allowed, description: '' }, { name: 'unapproved', description: '', fingerprint: 'b'.repeat(64) }];
    store.setSetting('research-mcp-servers-v1', [
      { id: 'legacy-partial', name: 'Partial', url, enabled: true, discoveredTools, approvedTools: [allowed] },
      { id: 'legacy-unapproved', name: 'Unapproved', url, enabled: true, discoveredTools, approvedTools: [] },
    ]);
    try {
      expect(enabledResearchServerConfigs(store).map(server => [server.id, server.discoveredTools?.map(tool => tool.name)])).toEqual([
        ['legacy-partial', ['lookup']],
      ]);
      const renamed = await saveResearchServer(store, 'legacy-partial', { name: 'Renamed', url, enabled: true });
      expect(renamed.toolNames).toEqual([expect.stringMatching(/_lookup$/)]);
      const stillUntrusted = await saveResearchServer(store, 'legacy-unapproved', { name: 'Also Renamed', url, enabled: true });
      expect(stillUntrusted.toolNames).toEqual([]);
    } finally { store.close(); }
  });
});
