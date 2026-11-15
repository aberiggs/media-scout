import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openSearchStore, LEGACY_DATABASE_ERROR } from '../src/search/store';

describe('fresh search database boundary', () => {
  it('creates and reopens a fresh file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-db-'));
    const path = join(dir, 'fresh.sqlite');
    try {
      const first = openSearchStore(path);
      first.createSearch({ searchId: 'persist', prompt: 'x', status: 'running', createdAt: 1 });
      first.close();
      const restarted = openSearchStore(path);
      expect(restarted.getSearch('persist')?.status).toBe('running');
      restarted.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses nonempty legacy databases before changing any bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-db-'));
    const path = join(dir, 'legacy.sqlite');
    const db = new Database(path);
    db.exec('CREATE TABLE work_items (work_key TEXT PRIMARY KEY); INSERT INTO work_items VALUES (\'legacy\')');
    db.close();
    const before = readFileSync(path);
    try {
      expect(() => openSearchStore(path)).toThrow(LEGACY_DATABASE_ERROR);
      expect(readFileSync(path)).toEqual(before);
      expect(new Database(path, { readonly: true }).prepare('SELECT work_key FROM work_items').get()).toEqual({ work_key: 'legacy' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
