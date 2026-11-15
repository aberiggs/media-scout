import { describe, expect, it, vi } from 'vitest';
import { SubmissionService } from '../src/search/submission';
import { openSearchStore } from '../src/search/store';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const release = { guid: 'private-guid', age: 1, size: null, files: null, grabs: null, indexerId: 2, indexer: 'Indexer', subGroup: null, title: 'Example S01E01', tvdbId: null, tmdbId: null, publishDate: '', downloadUrl: 'https://secret.test/a', indexerFlags: [], categories: [], magnetUrl: null, infoHash: 'a'.repeat(40), seeders: 3, leechers: 0, protocol: 'torrent' as const, downloadClientId: null };
function fixture(path = ':memory:') {
  const store = openSearchStore(path);
  store.createSearch({ searchId: 's', prompt: '{}', status: 'matched', createdAt: 1 });
  const result = { searchId: 's', status: 'matched', options: [{ optionId: 'o', rank: 1, releases: [{ candidateId: 'c' }], coveredTargetIds: [], reason: 'fit', uncertainty: '' }] };
  store.finishSearch('s', 'matched', result, 2);
  store.addCandidate({ searchId: 's', candidateId: 'c', safe: {}, privateData: { release, physicalKey: 'physical' }, expiresAt: 100 });
  const prowlarr = { getDownloadClients: vi.fn(async () => [{ id: 7, name: 'Torrent', enable: true, protocol: 'torrent' as const, supportsCategories: true, categories: [{ clientCategory: 'private', categories: [5000] }] }]), grab: vi.fn(async () => {}) };
  return { store, prowlarr, service: new SubmissionService({ prowlarr, store, getPolicy: () => ({ dryRun: false, enabled: true, tvClient: 'Torrent', movieClient: 'Torrent', queueGraceMinutes: 15 }), clock: () => 20 }) };
}

describe('SubmissionService', () => {
  it('never posts if durable receipt storage fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'submission-audit-'));
    const path = join(directory, 'state.sqlite'), f = fixture(path);
    const writer = new Database(path);
    writer.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    writer.close();
    try {
      await expect(f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'audit' })).rejects.toThrow('audit unavailable');
      expect(f.prowlarr.grab).not.toHaveBeenCalled();
      expect(f.store.getSubmission('audit')).toBeNull();
    } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('rejects expired candidate capability and a client disabled during validation', async () => {
    const f = fixture();
    try {
      f.store.expireCandidatesAt('s', 20);
      expect((await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'expired' })).outcome).toBe('expired');
      f.store.expireCandidatesAt('s', 100);
      f.prowlarr.getDownloadClients.mockResolvedValueOnce([{ id: 7, name: 'Torrent', enable: true, protocol: 'torrent', supportsCategories: true, categories: [] }]).mockResolvedValueOnce([]);
      expect((await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'disabled-client' })).outcome).toBe('failed');
      expect(f.prowlarr.grab).not.toHaveBeenCalled();
    } finally { f.store.close(); }
  });
  it('does not POST if validation outlives the submission ownership lease', async () => {
    const f = fixture();
    let clock = 20;
    const service = new SubmissionService({ prowlarr: f.prowlarr, store: f.store, getPolicy: () => ({ dryRun: false, tvClient: 'Torrent', movieClient: 'Torrent', queueGraceMinutes: 30 }), clock: () => clock });
    try {
      const result = await service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'stale' }, { validate: async () => { clock += 1_000_000; return true; } });
      expect(result.outcome).toBe('failed');
      expect(f.prowlarr.grab).not.toHaveBeenCalled();
    } finally { f.store.close(); }
  });
  it('serializes overlapping live workers even after short appearance grace expires', async () => {
    const f = fixture();
    let clock = 20, releaseValidation!: () => void;
    const policy = { dryRun: false, tvClient: 'Torrent', movieClient: 'Torrent', queueGraceMinutes: 1 };
    const service = new SubmissionService({ prowlarr: f.prowlarr, store: f.store, getPolicy: () => policy, clock: () => clock });
    const pending = service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'first' }, { targets: ['target'], validate: () => new Promise(resolve => { releaseValidation = () => resolve(true); }) });
    try {
      await vi.waitFor(() => expect(releaseValidation).toBeTypeOf('function'));
      clock += 61_000;
      f.store.expireCandidatesAt('s', clock + 1000);
      const overlapping = await service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'second' }, { targets: ['target'] });
      expect(overlapping.outcome).toBe('deferred');
      releaseValidation();
      expect((await pending).outcome).toBe('submitted');
      expect(f.prowlarr.grab).toHaveBeenCalledTimes(1);
    } finally { releaseValidation?.(); await pending; f.store.close(); }
  });
  it('rechecks dry-run and client enablement after an asynchronous fresh validation', async () => {
    const f = fixture();
    const policy = { dryRun: false, tvClient: 'Torrent', movieClient: 'Torrent', queueGraceMinutes: 30 };
    const service = new SubmissionService({ prowlarr: f.prowlarr, store: f.store, getPolicy: () => policy, clock: () => 20 });
    try {
      const result = await service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'paused' }, { validate: async () => { policy.dryRun = true; return true; } });
      expect(result.outcome).toBe('failed');
      expect(f.prowlarr.grab).not.toHaveBeenCalled();
    } finally { f.store.close(); }
  });
  it('records a finite target-scoped exclusion after a definite rejected grab', async () => {
    const f = fixture();
    try {
      f.prowlarr.grab.mockRejectedValueOnce(new (await import('../src/http')).ApiError(404, 'prowlarr', '', undefined));
      const result = await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'bad' }, { targets: ['episode:1'] });
      expect(result.outcome).toBe('rejected');
      expect(f.store.isExcluded('episode:1', 'physical', 1000)).toBe(true);
      expect(f.store.isExcluded('episode:1', 'physical', 86_400_021)).toBe(false);
    } finally { f.store.close(); }
  });
  it('routes the explicit matched candidate and replays the durable full outcome without another POST', async () => {
    const f = fixture();
    try {
      const request = { searchId: 's', optionId: 'o', idempotencyKey: 'k' };
      const first = await f.service.submit(request);
      const replay = await f.service.submit(request);
      expect(f.prowlarr.grab).toHaveBeenCalledTimes(1);
      expect(first).toEqual(replay);
      expect(JSON.stringify(first)).not.toContain('private-guid');
    } finally { f.store.close(); }
  });

  it('lists enabled download clients without returning category or credential details', async () => {
    const f = fixture();
    try {
      expect(await f.service.listClients()).toEqual([{ id: 7, name: 'Torrent', protocol: 'torrent', categories: true }]);
    } finally { f.store.close(); }
  });
  it('chooses an explicitly listed client and rejects unknown routing overrides', async () => {
    const f = fixture();
    try {
      f.prowlarr.getDownloadClients.mockResolvedValue([{ id: 8, name: 'Other category', enable: true, protocol: 'torrent', supportsCategories: true, categories: [] }]);
      expect((await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'bad-client', downloadClientId: 99 })).outcome).toBe('rejected');
      expect(f.prowlarr.grab).not.toHaveBeenCalled();
      expect((await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'chosen', downloadClientId: 8 })).outcome).toBe('submitted');
      expect(f.prowlarr.grab).toHaveBeenCalledWith(release, 8);
      expect((await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'another', downloadClientId: 8 })).outcome).toBe('deferred');
      expect(f.prowlarr.grab).toHaveBeenCalledTimes(1);
    } finally { f.store.close(); }
  });
  it('stops a partial season submission at the first failed POST', async () => {
    const f = fixture();
    try {
      for (const candidateId of ['second', 'third']) f.store.addCandidate({ searchId: 's', candidateId, safe: {}, privateData: { release: { ...release, guid: candidateId }, physicalKey: candidateId }, expiresAt: 100 });
      f.store.finishSearch('s', 'matched', { options: [{ optionId: 'o', releases: [{ candidateId: 'c' }, { candidateId: 'second' }, { candidateId: 'third' }] }] }, 2);
      f.prowlarr.grab.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network'));
      const result = await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'partial' });
      expect(result.outcomes).toEqual([{ candidateId: 'c', outcome: 'submitted' }, { candidateId: 'second', outcome: 'uncertain' }]);
      expect(f.prowlarr.grab).toHaveBeenCalledTimes(2);
      expect(await f.service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'partial' })).toEqual(result);
    } finally { f.store.close(); }
  });

  it('does not reserve or POST in dry-run mode', async () => {
    const f = fixture();
    try {
      const service = new SubmissionService({ prowlarr: f.prowlarr, store: f.store, getPolicy: () => ({ dryRun: true, enabled: true, tvClient: 'Torrent', movieClient: 'Torrent', queueGraceMinutes: 15 }), clock: () => 20 });
      expect((await service.submit({ searchId: 's', optionId: 'o', idempotencyKey: 'dry' })).outcome).toBe('dry-run');
      expect(f.prowlarr.grab).not.toHaveBeenCalled();
      expect(f.store.getSubmission('dry')).toBeNull();
    } finally { f.store.close(); }
  });

  it('replays an ambiguous network outcome rather than repeating a possibly accepted POST', async () => {
    const f = fixture();
    try {
      f.prowlarr.grab.mockRejectedValueOnce(new Error('connection lost'));
      const request = { searchId: 's', optionId: 'o', idempotencyKey: 'ambiguous' };
      const first = await f.service.submit(request);
      const replay = await f.service.submit(request);
      expect(first.outcome).toBe('uncertain');
      expect(replay).toEqual(first);
      expect(f.prowlarr.grab).toHaveBeenCalledTimes(1);
    } finally { f.store.close(); }
  });
});
