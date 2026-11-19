import type { ActivityQuery, ArrObservationPass, PublicSearchStatus } from '../search/runtime';
import type { SearchDomain } from '../search/mcp';

export function daemonOrigin(host: string, port: number): string {
  const connectHost = host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
  return `http://${connectHost.includes(':') && !connectHost.startsWith('[') ? `[${connectHost}]` : connectHost}:${port}`;
}

export function createHttpSearchDomain(origin: string, fetcher: typeof fetch = fetch): SearchDomain {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try { response = await fetcher(new URL(path, origin), { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }); }
    catch { throw new Error('daemon-mcp-unavailable'); }
    if (!response.ok) {
      if (response.status === 503) throw new Error('daemon-mcp-unavailable');
      if (response.status === 404) return null as T;
      throw new Error('Operation failed');
    }
    try { return await response.json() as T; }
    catch { throw new Error('Operation failed'); }
  };
  return {
    async missingSettings() { return (await request<{ missing: string[] }>('/api/v2/status')).missing; },
    async automationStatus() { return request('/api/v2/automation'); },
    async startSearch(input) { return request('/api/v2/searches', { method: 'POST', body: JSON.stringify(input) }); },
    async getSearch(id): Promise<PublicSearchStatus | null> { return request(`/api/v2/searches/${encodeURIComponent(id)}`); },
    async activity(query: ActivityQuery) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      return request(`/api/v2/activity${params.size ? `?${params}` : ''}`);
    },
    async poll(): Promise<ArrObservationPass> { return request('/api/v2/automation/poll', { method: 'POST', body: '{}' }); },
    async startArrSearch(targetId) { return request('/api/v2/automation/search', { method: 'POST', body: JSON.stringify({ targetId }) }); },
  };
}
