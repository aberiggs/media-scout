import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('reads only bootstrap values; integrations are empty and monitoring safely disabled by default', () => {
    const cfg = loadConfig({});
    expect(cfg.settings.safety.dryRun).toBe(true);
    expect(cfg.settings.safety.allowOperatorActions).toBe(false);
    expect(cfg.settings.ai.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.settings.ai.model).toBe('z-ai/glm-5.3-flash');
    expect(cfg.settings.ai.preferences).toBe('');
    expect(cfg.settings.monitoring.enabled).toBe(false);
    expect(cfg.settings.monitoring.intervalMinutes).toBe(5);
    expect(cfg.settings.monitoring.minRetryHours).toBe(6);
    expect(cfg.settings.monitoring.failureBackoffMinMinutes).toBe(5);
    expect(cfg.settings.monitoring.failureBackoffMaxMinutes).toBe(60);
    expect(cfg.settings.monitoring.queueGraceMinutes).toBe(30);
    expect(cfg.settings.integrations.prowlarr.apiKey).toBe('');
    expect(cfg.DB_PATH).toBe('data/media-agent.db');
    expect(cfg.HTTP_PORT).toBe(7877);
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('parses bootstrap overrides and ignores integration environment variables', () => {
    const cfg = loadConfig({
      HTTP_PORT: '8000',
      HTTP_HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      PROWLARR_API_KEY: 'must-not-be-read',
    });
    expect(cfg.HTTP_PORT).toBe(8000);
    expect(cfg.HTTP_HOST).toBe('127.0.0.1');
    expect(cfg.LOG_LEVEL).toBe('debug');
    expect(cfg.settings.integrations.prowlarr.apiKey).toBe('');
  });
});
