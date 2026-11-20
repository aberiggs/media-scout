import { describe, expect, it } from 'vitest';
import { canonicalEndpoint, safeHeaderName } from '../src/search/research-mcp';
import { deleteResearchServer, listResearchServers, saveResearchServer } from '../src/search/research-mcp';
import { openSearchStore } from '../src/search/store';

describe('research MCP endpoint safety', () => {
  it('accepts only canonical exact HTTP endpoints and rejects URL components that can redirect identity', () => {
    expect(canonicalEndpoint('http://127.0.0.1:8080/mcp')).toBe('http://127.0.0.1:8080/mcp');
    for (const value of ['http://example.test/mcp?x=1', 'http://example.test/#x', 'http://u:p@example.test/mcp', 'file:///tmp/mcp', 'HTTP://example.test/mcp']) {
      expect(() => canonicalEndpoint(value)).toThrow();
    }
  });

  it('rejects protocol and hop-by-hop custom credential headers', () => {
    expect(safeHeaderName('X-Api-Key')).toBe('X-Api-Key');
    for (const value of ['Host', 'Connection', 'Transfer-Encoding', 'Content-Length', 'Cookie', 'Authorization']) {
      expect(() => safeHeaderName(value)).toThrow();
    }
  });
  it('persists credentials separately, enforces namespace uniqueness and clears approval on URL change', () => {
    const store = openSearchStore(':memory:');
    try {
      const allowed = ['http://one.test/mcp', 'http://two.test/mcp'];
      const saved = saveResearchServer(store, allowed, undefined, { name: 'One', namespace: 'one', url: allowed[0]!, enabled: true, approvedTools: [], credential: { mode: 'replace', header: 'X-Key', value: 'secret' } });
      saveResearchServer(store, allowed, saved.id, { name: 'One', namespace: 'one', url: allowed[0]!, enabled: true, approvedTools: [{ name: 'lookup', fingerprint: 'a'.repeat(64) }] });
      expect(() => saveResearchServer(store, allowed, undefined, { name: 'Two', namespace: 'ONE', url: allowed[0]!, enabled: true, approvedTools: [] })).toThrow('namespace-conflict');
      const changed = saveResearchServer(store, allowed, saved.id, { name: 'One', namespace: 'one', url: allowed[1]!, enabled: true, approvedTools: [{ name: 'lookup', fingerprint: 'a'.repeat(64) }] });
      expect(changed).toMatchObject({ url: allowed[1], credentialConfigured: false, approvedTools: [] });
      expect(JSON.stringify(listResearchServers(store))).not.toContain('secret');
      expect(deleteResearchServer(store, saved.id)).toBe(true);
    } finally { store.close(); }
  });
});
