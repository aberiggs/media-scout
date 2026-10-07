import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  downloadClientListSchema,
  downloadClientSchema,
  grabRequestSchema,
  indexerStatusListSchema,
  releaseSchema,
} from '../src/types/prowlarr';
import { episodeListSchema, seriesListSchema } from '../src/types/sonarr';
import { movieListSchema } from '../src/types/radarr';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));

const subspleaseRelease = fixture('prowlarr-release.json') as Record<string, unknown>;
const seriesFixture = fixture('sonarr-series.json') as Record<string, unknown>;

describe('prowlarr release schema', () => {
  it('parses the fixture release with its consumed fields intact', () => {
    const r = releaseSchema.parse(subspleaseRelease);
    expect(r.guid).toBe('a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    expect(r.indexerId).toBe(5);
    expect(r.title).toContain('[SubsPlease]');
    expect(r.categories.map((c) => c.id)).toContain(5070);
    expect(r.protocol).toBe('torrent');
    expect(r.seeders).toBe(421);
    expect(r.infoHash).toBe('FIXTUREHASH0000000000000000000000000');
  });

  it('tolerates null numerics and unknown fields (I8) instead of failing the boundary', () => {
    const r = releaseSchema.parse({
      ...subspleaseRelease,
      seeders: null,
      leechers: null,
      files: null,
      grabs: null,
      subGroup: null,
      indexerFlags: null,
      someFutureProwlarrField: 'x',
    });
    expect(r.seeders).toBeNull();
    expect(r.leechers).toBeNull();
    expect(r.files).toBeNull();
    expect(r.grabs).toBeNull();
    expect(r.indexerFlags).toEqual([]);
  });

  it('rejects an out-of-enum protocol loudly', () => {
    expect(() => releaseSchema.parse({ ...subspleaseRelease, protocol: 'nzb' })).toThrow();
  });

  it('parses size null and coerces garbage size to null (I8 — numerics may be null)', () => {
    expect(releaseSchema.parse({ ...subspleaseRelease, size: null }).size).toBeNull();
    expect(releaseSchema.parse({ ...subspleaseRelease, size: 'many' }).size).toBeNull();
  });

  it('parses a LIVE-recorded row shape: omitted nullables coerce to null (P7, 2026-10-01)', () => {
    const live = { ...subspleaseRelease };
    // Live Prowlarr omits null fields entirely — never sends JSON null.
    delete live.infoHash;
    delete live.magnetUrl;
    delete live.files;
    delete live.grabs;
    delete live.subGroup;
    delete live.downloadClientId;
    const r = releaseSchema.parse(live);
    expect(r.infoHash).toBeNull();
    expect(r.magnetUrl).toBeNull();
    expect(r.subGroup).toBeNull();
    // downloadUrl always present live — the row stays grabbable (Q2).
    expect(r.downloadUrl).not.toBeNull();
  });
});

describe('prowlarr grab request schema', () => {
  it('accepts the grab body with an explicit downloadClientId override (D6)', () => {
    const body = grabRequestSchema.parse({
      indexerId: 5,
      guid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      downloadClientId: 1,
    });
    expect(body).toEqual({
      indexerId: 5,
      guid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      downloadClientId: 1,
    });
  });

  it('rejects a grab without downloadClientId — unrouted grabs are a bug, not a default', () => {
    expect(() =>
      grabRequestSchema.parse({ indexerId: 5, guid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' })
    ).toThrow();
  });
});

describe('prowlarr indexer status schema', () => {
  it('parses disabled and healthy rows; disabledTill null means not backed off', () => {
    const rows = indexerStatusListSchema.parse(fixture('prowlarr-indexerstatus.json'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.indexerId).toBe(5);
    expect(rows[0]!.disabledTill).toBe('2026-09-29T21:00:00Z');
    expect(rows[1]!.disabledTill).toBeNull();
  });
});

describe('prowlarr download client schema', () => {
  it('resolves entries by name with their *arr routing categories', () => {
    const clients = downloadClientListSchema.parse(fixture('prowlarr-downloadclients.json'));
    const tv = clients.find((c) => c.name === 'qBit-TV');
    const movie = clients.find((c) => c.name === 'qBit-Movies');
    expect(tv?.id).toBe(1);
    expect(tv?.categories[0]?.clientCategory).toBe('tv-sonarr');
    expect(movie?.id).toBe(2);
    expect(movie?.categories[0]?.clientCategory).toBe('radarr');
    expect(tv?.routingDigest).toBeNull();
    expect(tv).not.toHaveProperty('fields');
    expect(tv).not.toHaveProperty('implementation');
  });

  it('canonicalizes routing fields independent of field/object order and hashes routing changes only', () => {
    const client = {
      id: 41, name: 'General', enable: true, protocol: 'torrent', supportsCategories: true,
      categories: [{ clientCategory: 'general', categories: [2000, 5000] }],
      implementation: 'QBittorrent', configContract: 'QBittorrentSettings', implementationName: 'qBittorrent',
      fields: [
        { name: 'Host', value: 'qbit-a', label: 'Host', helpText: 'Connect to this server' },
        { name: 'Options', value: { port: 8080, urlBase: '/api', enabled: true } },
        { name: 'Password', value: 'provider-password-secret' },
      ],
      infoLink: 'https://help.invalid/a', message: null,
    };
    const digest = downloadClientSchema.parse(client).routingDigest;
    const reordered = downloadClientSchema.parse({
      ...client, infoLink: 'https://help.invalid/b', implementationName: 'renamed label',
      categories: [{ clientCategory: 'general', categories: [5000, 2000] }],
      fields: [
        { helpText: 'different help', label: 'Different label', value: 'provider-password-secret', name: 'Password' },
        { value: { enabled: true, urlBase: '/api', port: 8080 }, name: 'Options' },
        { helpText: 'other help', label: 'Other', value: 'qbit-a', name: 'Host' },
      ],
    }).routingDigest;
    expect(reordered).toBe(digest);
    for (const changed of [
      { ...client, fields: [{ ...client.fields[0], value: 'qbit-b' }, ...client.fields.slice(1)] },
      { ...client, fields: [client.fields[0], { ...client.fields[1], value: { ...client.fields[1]!.value as object, port: 9000 } }, client.fields[2]] },
      { ...client, fields: [client.fields[0], { ...client.fields[1], value: { ...client.fields[1]!.value as object, urlBase: '/other' } }, client.fields[2]] },
      { ...client, fields: [client.fields[0], { name: 'Category', value: 'tv-sonarr' }, client.fields[1], client.fields[2]] },
      { ...client, implementation: 'OtherClient' },
      { ...client, configContract: 'OtherSettings' },
      { ...client, categories: [{ clientCategory: 'tv-sonarr', categories: [5000] }] },
    ]) expect(downloadClientSchema.parse(changed).routingDigest).not.toBe(digest);
    const parsed = downloadClientSchema.parse(client);
    expect(parsed.routingDigest).not.toContain('provider-password-secret');
    expect(parsed).not.toHaveProperty('fields');
    expect(parsed).not.toHaveProperty('configContract');
  });

  it('marks routing fingerprint unavailable when provider configuration fields are omitted', () => {
    const { fields: _fields, ...raw } = {
      id: 41, name: 'General', enable: true, protocol: 'torrent', supportsCategories: true,
      categories: [], implementation: 'QBittorrent', configContract: 'QBittorrentSettings', fields: [],
    };
    expect(downloadClientSchema.parse(raw).routingDigest).toBeNull();
    expect(downloadClientSchema.parse({ ...raw, fields: [] }).routingDigest).toBeNull();
  });

  it('normalizes omitted provider values to null while retaining usable routing evidence', () => {
    const base = {
      id: 41, name: 'General', enable: true, protocol: 'torrent', supportsCategories: true,
      categories: [{ clientCategory: 'general', categories: [2000] }],
      implementation: 'QBittorrent', configContract: 'QBittorrentSettings',
      fields: [
        { name: 'host', value: 'qbit' }, { name: 'port', value: 8080 },
        { name: 'category', value: 'general' }, { name: 'urlBase' }, { name: 'apiKey' },
        { name: 'enabled', value: false }, { name: 'retries', value: 0 }, { name: 'empty', value: '' },
      ],
    };
    const omitted = downloadClientSchema.parse(base).routingDigest;
    const explicitNull = downloadClientSchema.parse({ ...base, fields: base.fields.map((field) => ('value' in field ? field : { ...field, value: null })) }).routingDigest;
    expect(omitted).toMatch(/^[a-f0-9]{64}$/);
    expect(explicitNull).toBe(omitted);
  });
});

describe('sonarr series schema', () => {
  it('parses the anime series fixture with seasons and alternate titles', () => {
    const series = seriesListSchema.parse([
      seriesFixture,
      { ...seriesFixture, seriesType: 'daily', seasons: undefined },
    ]);
    expect(series[0]!.seriesType).toBe('anime');
    expect(series[0]!.tvdbId).toBe(368013);
    expect(series[0]!.seasons[0]!.seasonNumber).toBe(1);
    expect(series[0]!.seasons[0]!.statistics?.totalEpisodeCount).toBe(28);
    expect(series[0]!.alternateTitles[0]!.title).toBe('Sousou no Frieren');
    expect(series[1]!.seriesType).toBe('daily');
    expect(series[1]!.seasons).toEqual([]);
  });

  it('rejects an out-of-enum seriesType', () => {
    expect(() => seriesListSchema.parse([{ ...seriesFixture, seriesType: 'ova' }])).toThrow();
  });
});

describe('sonarr episode schema', () => {
  it('parses episodes; missing absoluteEpisodeNumber coerces to null, not 0 (I1)', () => {
    const episodes = episodeListSchema.parse(fixture('sonarr-episodes.json'));
    expect(episodes).toHaveLength(3);
    expect(episodes[0]!.absoluteEpisodeNumber).toBe(7);
    expect(episodes[1]!.hasFile).toBe(true);
    // Episode 103 has no absoluteEpisodeNumber field at all — must land null.
    expect(episodes[2]!.absoluteEpisodeNumber).toBeNull();
    expect(episodes[2]!.airDate).toBeNull();
    expect(episodes[2]!.hasFile).toBe(false);
  });
});

describe('radarr movie schema', () => {
  it('parses a monitored, missing, available movie', () => {
    const movies = movieListSchema.parse([fixture('radarr-movie.json')]);
    expect(movies[0]!.tmdbId).toBe(671);
    expect(movies[0]!.year).toBe(2001);
    expect(movies[0]!.monitored).toBe(true);
    expect(movies[0]!.hasFile).toBe(false);
    expect(movies[0]!.isAvailable).toBe(true);
    expect(movies[0]!.sizeOnDisk).toBe(0);
  });
});
