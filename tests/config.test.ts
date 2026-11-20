import { expect, it } from 'vitest';
import { loadConfig } from '../src/config';
it('uses a fresh search database and loopback listener by default', () => {
  expect(loadConfig({})).toMatchObject({ DB_PATH: 'data/media-scout-search.db', HTTP_HOST: '127.0.0.1', HTTP_PORT: 7877 });
  expect(loadConfig({ HTTP_HOST: '0.0.0.0', HTTP_PORT: '8080', DB_PATH: '/isolated/search.sqlite' })).toMatchObject({ HTTP_HOST: '0.0.0.0', HTTP_PORT: 8080, DB_PATH: '/isolated/search.sqlite' });
  expect(() => loadConfig({ HTTP_PORT: 'bad' })).toThrow('Invalid bootstrap');
  expect(loadConfig({ RESEARCH_MCP_ENDPOINTS: 'http://127.0.0.1:5000/mcp' }).RESEARCH_MCP_ENDPOINTS).toBe('http://127.0.0.1:5000/mcp');
  expect(() => loadConfig({ RESEARCH_MCP_ENDPOINTS: 'http://user:pass@example.test/mcp' })).toThrow('Invalid bootstrap configuration');
});
