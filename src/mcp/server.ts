import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config';
import { createSearchMcpServer } from '../search/mcp';
import { createHttpSearchDomain, daemonOrigin } from './http-domain';

export const createMcpServer = (domain: Parameters<typeof createSearchMcpServer>[0]) => createSearchMcpServer(domain);
export async function runMcpServer(options: { origin: string }): Promise<void> {
  const server = createMcpServer(createHttpSearchDomain(options.origin));
  await server.connect(new StdioServerTransport());
  await new Promise<void>(resolve => { server.server.onclose = resolve; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  await runMcpServer({ origin: daemonOrigin(config.HTTP_HOST, config.HTTP_PORT) });
}
