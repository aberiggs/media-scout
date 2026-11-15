import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { Http } from '../src/http';
import { SonarrClient } from '../src/clients/sonarr';
import { RadarrClient } from '../src/clients/radarr';
import { summarizeProfile } from '../src/types/quality-profile';
afterEach(() => nock.cleanAll());
describe('read-only Arr profile context', () => {
  it.each([SonarrClient, RadarrClient])('reads nested allowed qualities and scored format names', async Client => {
    const endpoint = nock('http://arr.test').get('/api/v3/qualityprofile').matchHeader('X-Api-Key', 'test-key').reply(200, [{ id: 7, name: 'HD', items: [{ allowed: true, items: [{ quality: { name: 'WEB1080p' }, allowed: true }, { quality: { name: 'SD' }, allowed: false }] }], formatItems: [{ name: 'Multi-sub', score: 100 }], privateField: 'never forward' }]);
    const profiles = await new Client(new Http({ baseUrl: 'http://arr.test', apiKey: 'test-key' })).getQualityProfiles();
    expect(endpoint.isDone()).toBe(true);
    expect(summarizeProfile(profiles[0])).toEqual({ qualities: ['WEB1080p'], customFormats: ['Multi-sub (100)'], unknown: false });
    expect(JSON.stringify(profiles)).not.toContain('never forward');
  });
});
