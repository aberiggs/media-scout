import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server';
import type { Stack } from '../src/compose';
import { defaultSettings } from '../src/settings';

let client: Client | undefined;
let serverTransport: InMemoryTransport | undefined;

afterEach(async () => {
  if (client) await client.close();
  if (serverTransport) await serverTransport.close();
  client = undefined;
  serverTransport = undefined;
});

async function connect(allowOperatorActions: boolean) {
  const prepareReviewAction = vi.fn(async () => ({ token: 'prepared-secret', challenge: 'challenge' }));
  const settings = { ...defaultSettings, safety: { ...defaultSettings.safety, allowOperatorActions } };
  const stack = {
    config: { ALLOW_OPERATOR_ACTIONS: allowOperatorActions, DRY_RUN: true, LLM_MODEL: 'test', CYCLE_INTERVAL_MIN: 5, settings },
    state: { resolveManualReview: vi.fn(() => true), getSettings: () => settings },
    runner: {}, prowlarr: {},
    operatorActions: { prepareReviewAction, associateQueue: vi.fn(), releaseIntentHold: vi.fn() },
  } as unknown as Stack;
  stack.createSnapshot = () => stack;
  const server = createMcpServer(stack);
  const [clientTransport, serverSide] = InMemoryTransport.createLinkedPair();
  serverTransport = serverSide;
  await Promise.all([server.connect(serverSide), clientTransport.start()]);
  client = new Client({ name: 'operator-mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { prepareReviewAction, server, client };
}

describe('operator MCP gate', () => {
  it('rejects administrative I/O before service invocation when the strict opt-in is false', async () => {
    const { prepareReviewAction, client: mcp } = await connect(false);
    const result = await mcp.callTool({ name: 'ma_review_action', arguments: { id: 1, action: 'prepare', operation: 'release_intent_hold' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Operator actions are disabled');
    expect(prepareReviewAction).not.toHaveBeenCalled();
  });

  it('rejects client-supplied snapshots rather than accepting them as trusted completeness proof', async () => {
    const { prepareReviewAction, client: mcp } = await connect(true);
    const result = await mcp.callTool({ name: 'ma_review_action', arguments: { id: 1, action: 'prepare', operation: 'release_intent_hold', snapshot: { complete: true } } });
    expect(result.isError).toBe(true);
    expect(prepareReviewAction).not.toHaveBeenCalled();
  });

  it('marks the combined review tool as destructive so approval-capable hosts can gate every action', async () => {
    const { client: mcp } = await connect(true);
    const tools = await mcp.listTools();
    expect(tools.tools.find((tool) => tool.name === 'ma_review_action')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
});
