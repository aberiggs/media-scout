import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const validEnv: Record<string, string> = {
  PROWLARR_URL: 'http://prowlarr:9696',
  PROWLARR_API_KEY: 'prowlarr-key',
  SONARR_URL: 'http://sonarr:8989',
  SONARR_API_KEY: 'sonarr-key',
  RADARR_URL: 'http://radarr:7878',
  RADARR_API_KEY: 'radarr-key',
  PROWLARR_CLIENT_TV: 'qBit-TV',
  PROWLARR_CLIENT_MOVIE: 'qBit-Movies',
  LLM_API_KEY: 'llm-key',
};

describe('loadConfig', () => {
  it('applies the documented defaults when optional vars are unset', () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.DRY_RUN).toBe(true);
    expect(cfg.ALLOW_OPERATOR_ACTIONS).toBe(false);
    expect(cfg.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(cfg.LLM_MODEL).toBe('z-ai/glm-5.3-flash');
    expect(cfg.MEDIA_PREFERENCES).toBe('');
    expect(cfg.CYCLE_INTERVAL_MIN).toBe(5);
    expect(cfg.MIN_RETRY_HOURS).toBe(6);
    expect(cfg.FAILURE_BACKOFF_MIN).toBe(5);
    expect(cfg.FAILURE_BACKOFF_MAX_MIN).toBe(60);
    expect(cfg.QUEUE_GRACE_MIN).toBe(30);
    expect(cfg.DB_PATH).toBe('data/media-agent.db');
    expect(cfg.HTTP_PORT).toBe(7877);
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('parses overrides, including DRY_RUN=false', () => {
    const cfg = loadConfig({
      ...validEnv,
      DRY_RUN: 'false',
      CYCLE_INTERVAL_MIN: '15',
      MIN_RETRY_HOURS: '12',
      FAILURE_BACKOFF_MIN: '7',
      FAILURE_BACKOFF_MAX_MIN: '42',
      QUEUE_GRACE_MIN: '18',
      HTTP_PORT: '8000',
      LOG_LEVEL: 'debug',
      LLM_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(cfg.DRY_RUN).toBe(false);
    expect(cfg.CYCLE_INTERVAL_MIN).toBe(15);
    expect(cfg.MIN_RETRY_HOURS).toBe(12);
    expect(cfg.FAILURE_BACKOFF_MIN).toBe(7);
    expect(cfg.FAILURE_BACKOFF_MAX_MIN).toBe(42);
    expect(cfg.QUEUE_GRACE_MIN).toBe(18);
    expect(cfg.HTTP_PORT).toBe(8000);
    expect(cfg.LOG_LEVEL).toBe('debug');
    expect(cfg.LLM_BASE_URL).toBe('http://localhost:11434/v1');
  });

  it('trims MEDIA_PREFERENCES and accepts the maximum configured length', () => {
    const cfg = loadConfig({ ...validEnv, MEDIA_PREFERENCES: '  Prefer 1080p over 4K.  ' });
    expect(cfg.MEDIA_PREFERENCES).toBe('Prefer 1080p over 4K.');
    expect(loadConfig({ ...validEnv, MEDIA_PREFERENCES: 'x'.repeat(4000) }).MEDIA_PREFERENCES).toHaveLength(4000);
  });

  it('rejects MEDIA_PREFERENCES beyond its configured maximum', () => {
    expect(() => loadConfig({ ...validEnv, MEDIA_PREFERENCES: 'x'.repeat(4001) })).toThrow(/MEDIA_PREFERENCES|4000/);
  });

  it('rejects a missing required var', () => {
    expect(() => loadConfig({ ...validEnv, SONARR_API_KEY: undefined })).toThrow(/SONARR_API_KEY/);
  });

  it('rejects a non-http(s) URL', () => {
    expect(() => loadConfig({ ...validEnv, PROWLARR_URL: 'ftp://prowlarr:9696' })).toThrow(
      /PROWLARR_URL/
    );
  });

  it('rejects an unrecognized DRY_RUN value instead of silently defaulting', () => {
    expect(() => loadConfig({ ...validEnv, DRY_RUN: 'yes' })).toThrow(/DRY_RUN/);
  });

  it('requires an explicit strict boolean opt-in for operator actions', () => {
    expect(loadConfig({ ...validEnv, ALLOW_OPERATOR_ACTIONS: 'true' }).ALLOW_OPERATOR_ACTIONS).toBe(true);
    expect(loadConfig({ ...validEnv, ALLOW_OPERATOR_ACTIONS: 'false' }).ALLOW_OPERATOR_ACTIONS).toBe(false);
    expect(() => loadConfig({ ...validEnv, ALLOW_OPERATOR_ACTIONS: 'yes' })).toThrow(/ALLOW_OPERATOR_ACTIONS/);
  });

  it('rejects failure backoff caps below their base with a descriptive config error', () => {
    expect(() => loadConfig({
      ...validEnv,
      FAILURE_BACKOFF_MIN: '61',
      FAILURE_BACKOFF_MAX_MIN: '60',
    })).toThrow(/FAILURE_BACKOFF_MAX_MIN must be at least FAILURE_BACKOFF_MIN/);
  });

  it.each(['0', '-1', 'not-a-number'])(
    'rejects invalid positive queue timing values (%s)',
    (value) => {
      for (const field of ['FAILURE_BACKOFF_MIN', 'FAILURE_BACKOFF_MAX_MIN', 'QUEUE_GRACE_MIN']) {
        expect(() => loadConfig({ ...validEnv, [field]: value })).toThrow(new RegExp(field));
      }
    },
  );
});
