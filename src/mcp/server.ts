import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { buildStack, type Stack } from '../compose';
import { loadConfig } from '../config';
import { createSearchMcpServer } from '../search/mcp';

export const createMcpServer = (stack: Stack) => createSearchMcpServer(stack.runtime);
export async function runMcpServer(stack: Stack): Promise<void> {
  const server = createMcpServer(stack);
  await server.connect(new StdioServerTransport());
  await new Promise<void>(resolve => { server.server.onclose = resolve; });
  await stack.runtime.close();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  await runMcpServer(buildStack({ config, logger: pino({ level: config.LOG_LEVEL }, pino.destination({ dest: 2, sync: true })) }));
}
