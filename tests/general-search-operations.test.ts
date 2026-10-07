import { describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { State } from '../src/core/state';
import { GeneralSearchService } from '../src/core/general-search';
import { defaultSettings } from '../src/settings';
import { Http } from '../src/http';
import { ProwlarrClient } from '../src/clients/prowlarr';
import { downloadClientSchema } from '../src/types/prowlarr';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(statePath = ':memory:') {
  const state = State.open(statePath);
  const settings = structuredClone(defaultSettings);
  settings.integrations.prowlarr = { url: 'http://prowlarr.test', apiKey: 'private-key', tvClient: '', movieClient: '', generalClient: 'Download' };
  settings.ai.apiKey = 'private-ai-key';
  settings.safety.allowOperatorActions = true;
  settings.safety.dryRun = false;
  state.saveSettings(settings);
  const releases = Array.from({ length: 12 }, (_, i) => ({
    public: { releaseId: randomUUID(), title: `Title ${i}`, indexer: 'Indexer', size: 1, seeders: 1, leechers: 0, age: 1, protocol: 'torrent' as const, selectable: true, unavailableReason: null, expiresAt: '2026-10-06T00:00:10.000Z' },
    release: { guid: `private-guid-${i}`, indexerId: 7 }, sourceKey: `source-${i}`, legacySourceKey: `legacy-${i}`,
  }));
  const token = 'a'.repeat(64);
  const fingerprint = digest(JSON.stringify([settings.integrations.prowlarr.url, settings.integrations.prowlarr.apiKey, settings.integrations.prowlarr.generalClient, settings.safety.dryRun, settings.safety.allowOperatorActions]));
  state.saveGeneralSearchSnapshot({ id: 'search', tokenDigest: digest(token), expiresAt: '2026-10-07T00:00:00.000Z', fingerprint, clientName: 'Download', clientProtocol: 'torrent', clientId: 1, routingDigest: 'private-routing', dryRun: false, payload: { releases } });
  const client = { id: 1, name: 'Download', enable: true, protocol: 'torrent' as const, routingDigest: 'private-routing', supportsCategories: true, categories: [] };
  const prowlarr = { getDownloadClients: vi.fn(async () => [client]), grabGeneral: vi.fn(async () => {}) };
  let clock = new Date('2026-10-06T00:00:00.000Z');
  const service = new GeneralSearchService({ llm: {} as never, prowlarr: prowlarr as never, state, getSettings: () => state.getSettings(), now: () => new Date(clock) });
  return { state, service, token, releases, client, prowlarr, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, now: () => new Date(clock) };
}

async function create(f: ReturnType<typeof fixture>) {
  const operationId = randomUUID();
  const releaseIds = f.releases.map(({ public: item }) => item.releaseId);
  const status = await f.service.createOperation('search', { operationId, confirmationToken: f.token, releaseIds, confirmed: true });
  return { operationId, releaseIds, status };
}

describe('durable general-search operation creation/status', () => {
  it('freezes the entire >10 manifest before any mutation and reads after snapshot prune', async () => {
    const f = fixture();
    const operationId = randomUUID();
    const releaseIds = f.releases.map(({ public: item }) => item.releaseId);
    const status = await f.service.createOperation('search', { operationId, confirmationToken: f.token, releaseIds, confirmed: true });
    expect(status.releases).toHaveLength(12);
    expect(status.nextOrdinal).toBe(0);
    expect(await f.service.operationStatus(operationId)).toEqual(status);
    f.state.pruneGeneralSearchSnapshots('2026-10-08T00:00:00.000Z');
    expect(await f.service.operationStatus(operationId)).toEqual(status);
    const settings = f.state.getSettings(); settings.generalSearch!.maxCandidates = 1; f.state.saveSettings(settings);
    expect(await f.service.createOperation('search', { operationId, confirmationToken: f.token, releaseIds, confirmed: true })).toEqual(status);
    expect(JSON.stringify(status)).not.toContain('private-guid');
    expect(JSON.stringify(status)).not.toContain('private-routing');
    f.state.close();
  });

  it('validates the last manifest ID before persisting, and treats UUID retries idempotently/conflicting payloads distinctly', async () => {
    const f = fixture();
    const operationId = randomUUID();
    const releaseIds = f.releases.map(({ public: item }) => item.releaseId);
    await expect(f.service.createOperation('search', { operationId, confirmationToken: f.token, releaseIds: [...releaseIds.slice(0, -1), 'missing'], confirmed: true })).rejects.toThrow();
    expect(f.state.getGeneralSearchOperation(operationId)).toBeNull();
    const request = { operationId, confirmationToken: f.token, releaseIds, confirmed: true };
    const first = await f.service.createOperation('search', request);
    expect(await f.service.createOperation('search', request)).toEqual(first);
    await expect(f.service.createOperation('search', { ...request, releaseIds: releaseIds.slice(0, -1) })).rejects.toMatchObject({ code: 'operation-id-conflict' });
    f.state.close();
  });

  it('rejects an expired final selected release before creating any operation', async () => {
    const f = fixture(); const operationId = randomUUID();
    const releaseIds = f.releases.map(({ public: item }) => item.releaseId);
    const snapshot = f.state.getGeneralSearchSnapshot('search')!;
    const payload = snapshot.payload as { releases: Array<{ public: Record<string, unknown> }> };
    payload.releases.at(-1)!.public.expiresAt = '2026-10-05T23:59:59.000Z';
    const db = (f.state as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare('UPDATE general_search_snapshots SET payload_json=? WHERE id=?').run(JSON.stringify(payload), 'search');
    await expect(f.service.createOperation('search', { operationId, confirmationToken: f.token, releaseIds, confirmed: true })).rejects.toMatchObject({ code: 'search-expired' });
    expect(f.state.getGeneralSearchOperation(operationId)).toBeNull();
    f.state.close();
  });

  it('advances serially across the full manifest; duplicate/stale ordinals never advance it', async () => {
    const f = fixture(); const { operationId } = await create(f);
    const currentSettings = f.state.getSettings();
    expect(f.state.getGeneralSearchSnapshot('search')!.fingerprint).toBe(digest(JSON.stringify([currentSettings.integrations.prowlarr.url, currentSettings.integrations.prowlarr.apiKey, currentSettings.integrations.prowlarr.generalClient ?? '', currentSettings.safety.dryRun, currentSettings.safety.allowOperatorActions])));
    expect((f.state.getGeneralSearchOperation(operationId)!.privatePayload as { sourceFingerprint: string }).sourceFingerprint).toBe(digest(JSON.stringify([currentSettings.integrations.prowlarr.url, currentSettings.integrations.prowlarr.apiKey, currentSettings.integrations.prowlarr.generalClient])));
    const first = await f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    expect(first.releases[0]).toEqual({ releaseId: f.releases[0]!.public.releaseId, status: 'submitted', code: null });
    expect(first.nextOrdinal).toBe(1);
    expect(await f.service.stepOperation(operationId, { expectedOrdinal: 0 })).toEqual(first);
    let current = first;
    for (let ordinal = 1; ordinal < 12; ordinal++) current = await f.service.stepOperation(operationId, { expectedOrdinal: ordinal });
    expect(current.complete).toBe(true);
    expect(current.releases).toHaveLength(12);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(12);
    f.state.close();
  });

  it('stops future steps when fresh destination routing changes', async () => {
    const f = fixture(); const { operationId } = await create(f);
    await f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    f.client.routingDigest = 'changed-routing';
    const status = await f.service.stepOperation(operationId, { expectedOrdinal: 1 });
    expect(status.stopped).toBe(true);
    expect(status.releases[1]).toMatchObject({ status: 'not-attempted', code: 'destination-changed' });
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('records 429 and unknown outcomes durably and never retries or advances later items', async () => {
    const f = fixture(); const { operationId } = await create(f);
    f.prowlarr.grabGeneral.mockImplementation(async () => { throw Object.assign(new Error('limited'), { status: 429 }); });
    const failed = await f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    expect(failed.releases[0]).toMatchObject({ status: 'failed', code: 'upstream-429' });
    expect(failed.releases[1]).toMatchObject({ status: 'not-attempted' });
    expect(await f.service.stepOperation(operationId, { expectedOrdinal: 1 })).toEqual(failed);
    f.state.close();
  });

  it('advances past a previously-submitted source receipt and can submit later explicitly selected releases', async () => {
    const f = fixture(); const { releaseIds } = await create(f);
    const prior = f.releases[0]!;
    expect(f.state.reserveGeneralSearchRelease('older-operation', prior.public.releaseId, '2026-10-05T00:00:00.000Z', prior.sourceKey).reserved).toBe(true);
    f.state.finishGeneralSearchRelease('older-operation', prior.public.releaseId, 'submitted', null, '2026-10-05T00:00:01.000Z');
    // Recreate the operation with the prior receipt as its first ordinal.
    const nextOperationId = randomUUID();
    await f.service.createOperation('search', { operationId: nextOperationId, confirmationToken: f.token, releaseIds: releaseIds.slice(0, 4), confirmed: true });
    const priorStatus = await f.service.stepOperation(nextOperationId, { expectedOrdinal: 0 });
    expect(priorStatus.releases[0]?.status).toBe('previously-submitted');
    expect(priorStatus.stopped).toBe(false);
    expect(priorStatus.nextOrdinal).toBe(1);
    let next = priorStatus;
    for (let ordinal = 1; ordinal <= 3; ordinal++) next = await f.service.stepOperation(nextOperationId, { expectedOrdinal: ordinal });
    expect(next.releases.slice(1).every((item) => item.status === 'submitted')).toBe(true);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(3);
    f.state.close();
  });

  it('stops a new manifest at a prior uncertain source receipt', async () => {
    const f = fixture(); const { releaseIds } = await create(f);
    const prior = f.releases[0]!;
    f.state.reserveGeneralSearchRelease('older-operation', prior.public.releaseId, '2026-10-05T00:00:00.000Z', prior.sourceKey);
    f.state.finishGeneralSearchRelease('older-operation', prior.public.releaseId, 'uncertain', 'upstream-uncertain', '2026-10-05T00:00:01.000Z');
    const operationId = randomUUID();
    await f.service.createOperation('search', { operationId, confirmationToken: f.token, releaseIds: releaseIds.slice(0, 2), confirmed: true });
    const status = await f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    expect(status.releases[0]).toMatchObject({ status: 'uncertain', code: 'upstream-uncertain' });
    expect(status.releases[1]).toMatchObject({ status: 'not-attempted', code: 'upstream-uncertain' });
    expect(status.stopped).toBe(true);
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('holds unknown outcomes and exposes them by read-only status without retry', async () => {
    const f = fixture(); const { operationId } = await create(f);
    f.prowlarr.grabGeneral.mockImplementation(async () => { throw new Error('connection lost'); });
    const uncertain = await f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    expect(uncertain.releases[0]).toMatchObject({ status: 'uncertain', code: 'upstream-uncertain' });
    expect(await f.service.operationStatus(operationId)).toEqual(uncertain);
    expect(await f.service.stepOperation(operationId, { expectedOrdinal: 0 })).toEqual(uncertain);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('checks current permission and operation expiry before attempting upstream work', async () => {
    const f = fixture(); const { operationId } = await create(f);
    const changed = f.state.getSettings(); changed.safety.allowOperatorActions = false; f.state.saveSettings(changed);
    const denied = await f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    expect(denied.releases[0]).toMatchObject({ status: 'not-attempted', code: 'operator-actions-disabled' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();

    const expired = fixture(); const second = await create(expired);
    expired.advance(24 * 60 * 60_000);
    const stale = await expired.service.stepOperation(second.operationId, { expectedOrdinal: 0 });
    expect(stale.releases[0]).toMatchObject({ status: 'not-attempted', code: 'search-expired' });
    expect(expired.prowlarr.grabGeneral).not.toHaveBeenCalled();
    expired.state.close();
  });

  it('does not call upstream when the atomic claim/persist step fails before POST', async () => {
    const f = fixture(); const { operationId } = await create(f);
    vi.spyOn(f.state, 'claimGeneralSearchOperationStep').mockImplementationOnce(() => { throw new Error('database unavailable'); });
    await expect(f.service.stepOperation(operationId, { expectedOrdinal: 0 })).rejects.toThrow('database unavailable');
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    const status = await f.service.operationStatus(operationId);
    expect(status.nextOrdinal).toBe(0);
    expect(status.releases[0]?.status).toBe('pending');
    f.state.close();
  });

  it('rolls back receipt update with operation-status failure and leaves both held', async () => {
    const f = fixture(); const { operationId } = await create(f);
    const db = (f.state as unknown as { db: import('better-sqlite3').Database }).db;
    const originalPrepare = db.prepare.bind(db); let operationWrites = 0;
    const failure = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith('UPDATE general_search_operations SET status_json') && ++operationWrites === 2) throw new Error('operation status write failed');
      return originalPrepare(sql);
    }) as typeof db.prepare);
    await expect(f.service.stepOperation(operationId, { expectedOrdinal: 0 })).rejects.toThrow('operation status write failed');
    failure.mockRestore();
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    expect((await f.service.operationStatus(operationId)).releases[0]?.status).toBe('submitting');
    expect(f.state.reserveGeneralSearchRelease('other-operation', f.releases[0]!.public.releaseId, '2026-10-06T00:00:02.000Z', f.releases[0]!.sourceKey)).toMatchObject({ reserved: false, status: 'submitting' });
    expect(await f.service.stepOperation(operationId, { expectedOrdinal: 1 })).toMatchObject({ nextOrdinal: 1 });
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('stop marks remaining work without undoing an in-flight owner claim', async () => {
    const f = fixture(); const { operationId } = await create(f);
    const stopped = await f.service.stopOperation(operationId);
    expect(stopped.stopped).toBe(true);
    expect(stopped.releases.every((item) => item.status === 'not-attempted')).toBe(true);
    expect(await f.service.stepOperation(operationId, { expectedOrdinal: 0 })).toEqual(stopped);
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('stop during destination resolution prevents the pending POST', async () => {
    const f = fixture(); const { operationId } = await create(f);
    let releaseLookup!: (clients: typeof f.client[]) => void;
    f.prowlarr.getDownloadClients.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const pending = f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    await Promise.resolve();
    expect(f.prowlarr.getDownloadClients).toHaveBeenCalled();
    await f.service.stopOperation(operationId);
    releaseLookup([f.client]);
    const stopped = await pending;
    expect(stopped.releases[0]).toMatchObject({ status: 'not-attempted', code: 'operation-stopped' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('stop during an issued POST preserves the accepted receipt and marks later releases not-attempted', async () => {
    const f = fixture(); const { operationId } = await create(f);
    let accept!: () => void;
    f.prowlarr.grabGeneral.mockImplementationOnce(() => new Promise<void>((resolve) => { accept = resolve; }));
    const pending = f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    while (!accept) await Promise.resolve();
    await f.service.stopOperation(operationId);
    accept();
    const status = await pending;
    expect(status.releases[0]).toMatchObject({ status: 'submitted', code: null });
    expect(status.releases[1]).toMatchObject({ status: 'not-attempted', code: 'operation-stopped' });
    f.state.close();
  });

  it.each(['source', 'mode', 'expiry', 'item-expiry'] as const)('rechecks %s changes made during operation destination lookup', async (change) => {
    const f = fixture(); const { operationId } = await create(f);
    let releaseLookup!: (clients: typeof f.client[]) => void;
    f.prowlarr.getDownloadClients.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const pending = f.service.stepOperation(operationId, { expectedOrdinal: 0 });
    await Promise.resolve();
    if (change === 'expiry') f.advance(24 * 60 * 60_000);
    else if (change === 'item-expiry') f.advance(11_000);
    else {
      const settings = f.state.getSettings();
      if (change === 'source') settings.integrations.prowlarr.apiKey = 'rotated-before-post';
      else settings.safety.dryRun = true;
      f.state.saveSettings(settings);
    }
    releaseLookup([f.client]);
    const status = await pending;
    expect(status.releases[0]?.status).toBe('not-attempted');
    expect(status.releases[0]?.code).toBe(change === 'expiry' || change === 'item-expiry' ? 'search-expired' : 'settings-changed');
    expect(status.stopped).toBe(true);
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('serializes two independently spawned SQLite claimants and never reclaims the abandoned claim after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'general-operation-race-'));
    const path = join(dir, 'state.sqlite'); const operationId = randomUUID(); const releaseId = randomUUID();
    const state = State.open(path);
    state.createGeneralSearchOperation({ operationId, searchId: 'search', requestDigest: 'digest', now: '2026-10-06T00:00:00.000Z',
      status: { operationId, releases: [{ releaseId, status: 'pending', code: null }], mode: 'live', destination: { name: 'Download', protocol: 'torrent' }, expiresAt: '2026-10-07T00:00:00.000Z', nextOrdinal: 0, stopped: false, complete: false }, privatePayload: {} });
    state.close();
    const source = `import { State } from './src/core/state.ts';
const state = State.open(${JSON.stringify(path)}); const input = {operationId:${JSON.stringify(operationId)},expectedOrdinal:0,now:'2026-10-06T00:00:01.000Z',releaseId:${JSON.stringify(releaseId)},sourceKey:'shared-source-key',legacySourceKey:'legacy'};
console.log('READY'); process.stdin.once('data', () => { const result = state.claimGeneralSearchOperationStep(input); console.log(JSON.stringify(result)); state.close(); process.exit(0); });`;
    const start = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; }); child.stderr.on('data', (chunk: string) => { errors += chunk; });
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`child readiness timeout: ${errors}`)), 10_000);
        child.stdout.on('data', () => { if (output.includes('READY')) { clearTimeout(timeout); resolve(); } });
        child.once('error', reject);
      });
      const result = new Promise<{ claimed: boolean; status: { releases: Array<{status:string}> } }>((resolve, reject) => {
        child.once('close', (code) => {
          if (code !== 0) return reject(new Error(`claim child failed (${code}): ${errors}`));
          try { resolve(JSON.parse(output.split('\n').filter((line) => line.startsWith('{')).at(-1)!) as { claimed:boolean;status:{releases:Array<{status:string}>} }); }
          catch (error) { reject(error); }
        });
      });
      return { child, ready, result };
    };
    try {
      const a = start(); const b = start();
      await Promise.all([a.ready, b.ready]);
      a.child.stdin.write('go'); b.child.stdin.write('go');
      const claims = await Promise.all([a.result, b.result]);
      expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1);
      expect(claims.filter(({ claimed }) => !claimed)).toHaveLength(1);
      const restored = State.open(path);
      expect((restored.getGeneralSearchOperation(operationId)!.status as { releases: Array<{status:string}> }).releases[0]!.status).toBe('submitting');
      expect(restored.claimGeneralSearchOperationStep({ operationId, expectedOrdinal: 1, now: '2026-10-06T00:01:00.000Z', releaseId, sourceKey: 'shared-source-key', legacySourceKey: 'legacy' })?.claimed).toBe(false);
      restored.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('serializes different operations in spawned services against one local Prowlarr POST endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'general-operation-real-race-'));
    const path = join(dir, 'state.sqlite');
    const token = 'b'.repeat(64); const releaseId = randomUUID(); const guid = 'one-shared-safe-guid'; const indexerId = 44;
    const rawClient = { id: 1, name: 'Download', enable: true, protocol: 'torrent', supportsCategories: true, categories: [], implementation: 'LocalFake', configContract: 'LocalFakeSettings', fields: [{ name: 'Host', value: 'local-only' }] };
    const client = downloadClientSchema.parse(rawClient);
    let postCount = 0; let postedBody: unknown;
    let markPostSeen!: () => void; const postSeen = new Promise<void>((resolve) => { markPostSeen = resolve; });
    let releasePost!: () => void; const heldPost = new Promise<void>((resolve) => { releasePost = resolve; });
    const server = createServer(async (request, response) => {
      if (request.headers['x-api-key'] !== 'race-private-key') { response.writeHead(401).end('{}'); return; }
      if (request.method === 'GET' && request.url?.startsWith('/api/v1/downloadclient')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([rawClient])); return;
      }
      if (request.method === 'POST' && request.url === '/api/v1/search') {
        postCount++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        postedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        markPostSeen();
        await heldPost;
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return;
      }
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local fake server did not bind');
    const sourceUrl = `http://127.0.0.1:${address.port}`;
    const state = State.open(path);
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: sourceUrl, apiKey: 'race-private-key', tvClient: '', movieClient: '', generalClient: 'Download' };
    settings.ai.apiKey = 'private-ai-key'; settings.safety.allowOperatorActions = true; settings.safety.dryRun = false;
    state.saveSettings(settings);
    const base = new URL(sourceUrl); base.pathname = base.pathname.replace(/\/+$/, ''); base.search = ''; base.hash = '';
    const sourceKey = digest(JSON.stringify([base.toString(), indexerId, guid]));
    const legacySourceKey = digest(JSON.stringify([sourceUrl, settings.integrations.prowlarr.apiKey, indexerId, guid]));
    const now = new Date(); const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const tokenDigest = digest(token);
    const fingerprint = digest(JSON.stringify([sourceUrl, settings.integrations.prowlarr.apiKey, 'Download', false, true]));
    const entry = { public: { releaseId, title: 'Race release', indexer: 'Local indexer', size: 1, seeders: 4, leechers: 0, age: 1, protocol: 'torrent' as const, selectable: true, unavailableReason: null, expiresAt }, release: { guid, indexerId }, sourceKey, legacySourceKey };
    state.saveGeneralSearchSnapshot({ id: 'race-search', tokenDigest, expiresAt, fingerprint, clientName: 'Download', clientNameDigest: digest('Download'), clientProtocol: 'torrent', clientId: client.id, routingDigest: client.routingDigest!, dryRun: false, payload: { releases: [entry] } });
    const createClient = () => new ProwlarrClient(new Http({ baseUrl: sourceUrl, apiKey: 'race-private-key', timeoutMs: 5000 }));
    const service = new GeneralSearchService({ llm: {} as never, prowlarr: createClient(), state, getSettings: () => state.getSettings() });
    const operationIds = [randomUUID(), randomUUID()];
    for (const operationId of operationIds) await service.createOperation('race-search', { operationId, confirmationToken: token, releaseIds: [releaseId], confirmed: true });
    state.close();

    const childSource = (operationId: string) => `import { State } from './src/core/state.ts';
import { GeneralSearchService } from './src/core/general-search.ts';
import { Http } from './src/http.ts'; import { ProwlarrClient } from './src/clients/prowlarr.ts';
const state=State.open(${JSON.stringify(path)}); const settings=state.getSettings(); const prowlarr=new ProwlarrClient(new Http({baseUrl:settings.integrations.prowlarr.url,apiKey:settings.integrations.prowlarr.apiKey,timeoutMs:5000}));
const service=new GeneralSearchService({llm:{},prowlarr,state,getSettings:()=>state.getSettings()}); console.log('READY');
process.stdin.once('data',()=>{ void service.stepOperation(${JSON.stringify(operationId)},{expectedOrdinal:0}).then(status=>{process.stdout.write(JSON.stringify(status)+'\\n',()=>{state.close();process.exit(0);});}).catch(error=>{process.stderr.write(String(error?.stack??error));state.close();process.exit(1);}); });`;
    type ChildResult = { operationId: string; releases: Array<{ releaseId: string; status: string; code: string | null }>; nextOrdinal: number; stopped: boolean };
    const startChild = (operationId: string) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource(operationId)], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; }); child.stderr.on('data', (chunk: string) => { errors += chunk; });
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`service child readiness timeout: ${errors}`)), 10_000);
        child.stdout.on('data', () => { if (output.includes('READY')) { clearTimeout(timeout); resolve(); } }); child.once('error', reject);
      });
      const result = new Promise<ChildResult>((resolve, reject) => child.once('close', (code) => {
        if (code !== 0) return reject(new Error(`service child failed (${code}): ${errors}`));
        try { resolve(JSON.parse(output.split('\n').filter((line) => line.startsWith('{')).at(-1)!) as ChildResult); } catch (error) { reject(error); }
      }));
      return { child, ready, result };
    };
    const children = operationIds.map(startChild);
    try {
      expect(children).toHaveLength(2);
      await Promise.all(children.map(({ ready }) => ready));
      children.forEach(({ child }) => child.stdin.write('go'));
      await postSeen;
      const contender = await Promise.race(children.map(({ result }) => result));
      expect(contender.releases[0]?.status).toBe('uncertain');
      expect(postCount).toBe(1);
      releasePost();
      const results = await Promise.all(children.map(({ result }) => result));
      expect(new Set(results.map(({ operationId: id }) => id))).toEqual(new Set(operationIds));
      expect(results.flatMap(({ releases }) => releases).map(({ status }) => status).sort()).toEqual(['submitted', 'uncertain']);
      expect(results.map(({ nextOrdinal }) => nextOrdinal)).toEqual([1, 1]);
      expect(postCount).toBe(1);
      expect(postedBody).toEqual({ indexerId, guid, downloadClientId: client.id });
      const restored = State.open(path);
      expect(restored.reserveGeneralSearchRelease('receipt-probe', releaseId, new Date().toISOString(), sourceKey, legacySourceKey)).toMatchObject({ reserved: false, status: 'submitted' });
      restored.close();
    } finally {
      releasePost();
      for (const { child } of children) if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('restart cannot take over an abandoned submitting ordinal zero even after expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'general-operation-abandoned-')); const path = join(dir, 'state.sqlite');
    const first = fixture(path); const { operationId } = await create(first); const item = first.releases[0]!;
    const claim = first.state.claimGeneralSearchOperationStep({ operationId, expectedOrdinal: 0, now: first.now().toISOString(), releaseId: item.public.releaseId, sourceKey: item.sourceKey, legacySourceKey: item.legacySourceKey });
    expect(claim?.claimed).toBe(true);
    first.state.close();
    first.advance(24 * 60 * 60_000);
    const state = State.open(path);
    const getClientsCalls = first.prowlarr.getDownloadClients.mock.calls.length;
    const restored = new GeneralSearchService({ llm: {} as never, prowlarr: first.prowlarr as never, state, getSettings: () => state.getSettings(), runtimeSettings: state.getSettings(), now: first.now });
    try {
      const status = await restored.stepOperation(operationId, { expectedOrdinal: 0 });
      expect(status.nextOrdinal).toBe(1);
      expect(status.releases[0]).toMatchObject({ status: 'submitting' });
      expect(await restored.operationStatus(operationId)).toEqual(status);
      expect(first.prowlarr.getDownloadClients).toHaveBeenCalledTimes(getClientsCalls);
      expect(first.prowlarr.grabGeneral).not.toHaveBeenCalled();
      expect(state.reserveGeneralSearchRelease('probe', item.public.releaseId, first.now().toISOString(), item.sourceKey, item.legacySourceKey)).toMatchObject({ reserved: false, status: 'submitting' });
    } finally { state.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
