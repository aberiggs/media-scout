import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationOutputDirectory, safe, searchFixtureReleases, syntheticRequest } from '../scripts/evaluate-anime-search';
import { searchRequestSchema } from '../src/search/contracts';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('search-only anime evaluation inputs', () => {
  it('respects requested indexer and category scopes in fixture searches', () => {
    const television = searchFixtureReleases('kaiju', { query: 'Kaiju', categories: [5000], indexerIds: [1] });
    expect(television.length).toBeGreaterThan(0);
    expect(television.every(release => release.indexerId === 1 && release.categories.some(category => category.id === 5000))).toBe(true);
    expect(searchFixtureReleases('kaiju', { query: 'Kaiju', categories: [5000], indexerIds: [2] })).toEqual([]);
    const books = searchFixtureReleases('kaiju', { query: 'Kaiju', categories: [7000], indexerIds: [2] });
    expect(books).toHaveLength(1);
    expect(books[0]?.title).toMatch(/manga/);
  });
  it('removes sensitive values rather than only renaming their properties', () => {
    const result = safe({ nested: { apiKey: 'do-not-persist-me', authorization: 'Bearer sensitive', title: 'Public release' } });
    expect(JSON.stringify(result)).not.toMatch(/do-not-persist-me|Bearer sensitive/);
    expect(result).toEqual({ nested: { apiKey: '[redacted]', authorization: '[redacted]', title: 'Public release' } });
  });
  it.each([['rezero', 85], ['kaiju', 23]] as const)('constructs a valid full collapsed-season %s workload with context-only extras', (show, count) => {
    const request = searchRequestSchema.parse(syntheticRequest(show));
    expect(request.context?.targets).toHaveLength(count);
    expect(request.context?.targets?.map(target => target.absoluteEpisodeNumber)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(request.context?.targets?.every(target => target.seasonNumber === 1 && target.title === undefined)).toBe(true);
    expect(request.context?.relatedEpisodes?.map(episode => [episode.seasonNumber, episode.contextReason])).toEqual([
      [1, 'not-yet-available'], [0, 'already-owned'], [0, 'observed-in-queue'],
    ]);
    const targetIds = new Set(request.context?.targets?.map(target => target.targetId));
    expect(request.context?.relatedEpisodes?.some(episode => targetIds.has(episode.episodeRef))).toBe(false);
  });
  it('rejects hidden in-repository and symlinked output directories but accepts an external sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'anime-evaluation-')); directories.push(root);
    const repository = join(root, 'repository');
    mkdirSync(repository);
    expect(() => evaluationOutputDirectory(join(repository, '..hidden'), repository)).toThrow(/outside/);
    const linked = join(root, 'linked-output');
    symlinkSync(repository, linked, 'dir');
    expect(() => evaluationOutputDirectory(linked, repository)).toThrow(/outside/);
    const external = join(root, 'output');
    expect(evaluationOutputDirectory(external, repository)).toBe(realpathSync(external));
  });
});
