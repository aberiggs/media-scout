import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../src/clients/llm';
import { Planner, plannedQueriesSchema } from '../src/core/planner';
import type { WorkUnit } from '../src/core/watcher';

/** Scripted LLM seam: queued outputs, captured prompt arguments. No network. */
class FakeLLM implements LLMClient {
  readonly calls: {
    system: string;
    user: string;
    label: string;
    jsonSchema?: { name: string; schema: Record<string, unknown> };
  }[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async json<T>(args: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    label: string;
    jsonSchema?: { name: string; schema: Record<string, unknown> };
  }): Promise<T> {
    this.calls.push({
      system: args.system,
      user: args.user,
      label: args.label,
      jsonSchema: args.jsonSchema,
    });
    const output = this.outputs.shift();
    if (output === undefined) throw new Error('FakeLLM: no scripted output');
    return args.schema.parse(output);
  }
}

const tvUnit: WorkUnit = {
  key: 'sonarr:42:s1',
  kind: 'tv',
  arr: 'sonarr',
  serviceId: 42,
  externalId: 1234,
  title: 'Frieren: Beyond Journey’s End',
  altTitles: ['Sousou no Frieren'],
  seriesType: 'anime',
  season: {
    seasonNumber: 1,
    missing: [
      { episodeId: 501, episodeNumber: 3, absoluteEpisodeNumber: 3, title: 'KillerMove' },
      { episodeId: 502, episodeNumber: 4, absoluteEpisodeNumber: 4, title: 'The Land Where the Soul Sleeps' },
    ],
  },
};

const movieUnit: WorkUnit = {
  key: 'radarr:7',
  kind: 'movie',
  arr: 'radarr',
  serviceId: 7,
  externalId: 603,
  title: 'Arrival',
  year: 2016,
  altTitles: ['Story of Your Life'],
};

const yearlessMovieUnit: WorkUnit = {
  key: 'radarr:8',
  kind: 'movie',
  arr: 'radarr',
  serviceId: 8,
  externalId: 604,
  title: 'Old Movie',
  altTitles: [],
};

const dailyUnit: WorkUnit = {
  key: 'sonarr:9:s3',
  kind: 'tv',
  arr: 'sonarr',
  serviceId: 9,
  externalId: 77,
  title: 'Evening News',
  altTitles: [],
  seriesType: 'daily',
  season: {
    seasonNumber: 3,
    missing: [{ episodeId: 901, episodeNumber: 12, absoluteEpisodeNumber: null, title: 'March 4, 2026' }],
  },
};

function planWith(outputs: unknown[], unit: WorkUnit) {
  const llm = new FakeLLM(outputs);
  return { llm, result: new Planner({ llm }).plan(unit) };
}

describe('Planner', () => {
  it('returns scripted queries verbatim', async () => {
    const scripted = {
      queries: [
        { query: 'Frieren S01', categories: [5070, 5000] },
        { query: 'Sousou no Frieren - 03-04', categories: [5070] },
      ],
    };
    const { result } = planWith([scripted], tvUnit);
    await expect(result).resolves.toEqual(scripted.queries);
  });

  it('requests a strict canonical queries object in its prompt', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Arrival (2016)', categories: [2000] }] }]);
    await new Planner({ llm: capturing }).plan(movieUnit);
    expect(capturing.calls[0]!.system).toMatch(/JSON object only/i);
    expect(capturing.calls[0]!.system).toContain('{"queries":[{"query":');
    expect(capturing.calls[0]!.jsonSchema).toEqual({
      name: 'planner_queries',
      schema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                query: { type: 'string', minLength: 1, maxLength: 300 },
                categories: {
                  type: 'array',
                  items: { type: 'integer' },
                  minItems: 1,
                  maxItems: 4,
                },
              },
              required: ['query', 'categories'],
              additionalProperties: false,
            },
          },
        },
        required: ['queries'],
        additionalProperties: false,
      },
    });
  });

  it('embeds unit data in the user prompt, never in the system prompt', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Arrival (2016)', categories: [2000] }] }]);
    await new Planner({ llm: capturing }).plan(movieUnit);
    const { system, user } = capturing.calls[0]!;
    expect(user).toContain('Arrival');
    expect(user).toContain('2016'); // movie year embedded
    expect(user).toContain('Story of Your Life'); // altTitle
    expect(system).not.toContain('Arrival');
    expect(system).not.toContain('Story of Your Life');
  });

  it('embeds the movie year only when the unit has one', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Old Movie', categories: [2000] }] }]);
    await new Planner({ llm: capturing }).plan(yearlessMovieUnit);
    const user = capturing.calls[0]!.user;
    const description = JSON.parse(user) as { year?: number };
    expect('year' in description).toBe(false);
    expect(user).not.toContain('2016'); // no stray invented year
  });

  it('serializes a daily episode with null absoluteEpisodeNumber visibly', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Evening News E12', categories: [5070] }] }]);
    await new Planner({ llm: capturing }).plan(dailyUnit);
    const user = capturing.calls[0]!.user;
    expect(user).toContain('"absoluteEpisodeNumber":null');
    expect(JSON.parse(user).seriesType).toBe('daily');
    expect(capturing.calls[0]!.system).toMatch(/season-pack/i);
    expect(capturing.calls[0]!.system).toMatch(/do not restrict resolution/i);
  });

  it('keeps broad title, alias, season-pack, and episode fallbacks in planner guidance', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Evening News S03', categories: [5000] }] }]);
    await new Planner({ llm: capturing }).plan(dailyUnit);
    expect(capturing.calls[0]!.system).toMatch(/season-pack/i);
    expect(capturing.calls[0]!.system).toMatch(/alternate title/i);
    expect(capturing.calls[0]!.system).toMatch(/episode-specific/i);
    expect(capturing.calls[0]!.system).toMatch(/do not restrict .*resolution/i);
  });

  it('serializes an empty altTitles list', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Old Movie', categories: [2000] }] }]);
    await new Planner({ llm: capturing }).plan(yearlessMovieUnit);
    expect(JSON.parse(capturing.calls[0]!.user).altTitles).toEqual([]);
  });

  it('labels calls planner:<unit.key>', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Arrival (2016)', categories: [2000] }] }]);
    await new Planner({ llm: capturing }).plan(movieUnit);
    expect(capturing.calls[0]!.label).toBe('planner:radarr:7');
  });

  it('never puts magnet links or apikeys in any prompt', async () => {
    const capturing = new FakeLLM([{ queries: [{ query: 'Arrival (2016)', categories: [2000] }] }]);
    await new Planner({ llm: capturing }).plan(movieUnit);
    for (const { system, user } of capturing.calls) {
      expect(system).not.toContain('magnet:');
      expect(user).not.toContain('magnet:');
      expect(system + user).not.toContain('apikey');
    }
  });

  it.each([
    ['four queries', { queries: [1, 2, 3, 4].map((n) => ({ query: `q${n}`, categories: [2000] })) }],
    ['empty query string', { queries: [{ query: '', categories: [2000] }] }],
    ['empty categories', { queries: [{ query: 'q', categories: [] }] }],
  ])('rejects schema-invalid output (%s)', async (_name, output) => {
    const { result } = planWith([output], movieUnit);
    await expect(result).rejects.toBeInstanceOf(z.ZodError);
  });

  it('propagates LLMClient errors', async () => {
    const llm: LLMClient = {
      async json() {
        throw new Error('LLM planner: unparseable JSON after retry');
      },
    };
    await expect(new Planner({ llm }).plan(tvUnit)).rejects.toThrow('unparseable JSON');
  });

  it('describes movie and anime units differently', async () => {
    const anime = new FakeLLM([{ queries: [{ query: 'Frieren - 03-04', categories: [5070, 5000] }] }]);
    const movie = new FakeLLM([{ queries: [{ query: 'Arrival (2016)', categories: [2000] }] }]);
    await new Planner({ llm: anime }).plan(tvUnit);
    await new Planner({ llm: movie }).plan(movieUnit);
    const animeUser = anime.calls[0]!.user;
    const movieUser = movie.calls[0]!.user;
    // anime description carries absolute episode numbers
    expect(animeUser).toContain('absolute');
    expect(animeUser).toContain('3');
    expect(animeUser).toContain('Sousou no Frieren');
    // movie description carries the movie id, the year, and no episode data
    expect(movieUser).toContain(String(movieUnit.externalId));
    expect(JSON.parse(movieUser).year).toBe(2016);
    expect(movieUser).not.toContain('absolute');
    expect(movieUser).not.toContain('seasonNumber');
    expect(JSON.parse(animeUser).title).toBe(tvUnit.title);
    expect(JSON.parse(movieUser).externalId).toBe(603);
  });

  it('pins the schema edges: exactly 3 queries and a 300-char query parse; 301 chars throws', () => {
    const three = { queries: Array.from({ length: 3 }, (_, i) => ({ query: `q${i}`, categories: [2000] })) };
    expect(plannedQueriesSchema.parse(three)).toEqual(three);
    expect(plannedQueriesSchema.parse({ queries: [{ query: 'a'.repeat(300), categories: [2000] }] })).toBeDefined();
    expect(() =>
      plannedQueriesSchema.parse({ queries: [{ query: 'a'.repeat(301), categories: [2000] }] }),
    ).toThrow(z.ZodError);
  });

  it('accepts the model\'s bare query array without the {queries} envelope (live P7 retry shape)', async () => {
    const bare = [
      { query: 'Frieren S01', categories: [5070] },
      { query: 'Sousou no Frieren - 03-04', categories: [5070, 5000] },
    ];
    const planner = new Planner({ llm: new FakeLLM([bare]) });
    await expect(planner.plan(tvUnit)).resolves.toEqual(bare);
  });

  it('still accepts the {queries} envelope (compat)', async () => {
    const envelope = { queries: [{ query: 'Arrival (2016)', categories: [2000] }] };
    const planner = new Planner({ llm: new FakeLLM([envelope]) });
    await expect(planner.plan(movieUnit)).resolves.toEqual(envelope.queries);
  });
});
