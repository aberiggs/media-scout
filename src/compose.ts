import { OpenRouter } from '@openrouter/sdk';
import pino from 'pino';
import { OpenRouterLLM, type LLMClient } from './clients/llm';
import { ProwlarrClient } from './clients/prowlarr';
import { RadarrClient } from './clients/radarr';
import { SonarrClient } from './clients/sonarr';
import { ApiError, Http } from './http';
import { Picker } from './core/picker';
import { Planner } from './core/planner';
import { Runner } from './core/runner';
import { QueueAssociator } from './core/queue-association';
import { State } from './core/state';
import { OperatorActions } from './core/operator-actions';
import { GeneralSearchService } from './core/general-search';
import { GeneralSearchConversationService } from './core/general-search-conversation';
import { Watcher } from './core/watcher';
import type { Config } from './config';
import { configWithSettings } from './config';
import type { Settings } from './settings';

const SAFE_WATCHER_ERROR_NAMES = new Set([
  'ApiError',
  'ZodError',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'TimeoutError',
  'AbortError',
]);

export interface Stack {
  config: Config;
  state: State;
  watcher: Watcher;
  sonarr: SonarrClient;
  radarr: RadarrClient;
  prowlarr: ProwlarrClient;
  llm: LLMClient;
  planner: Planner;
  picker: Picker;
  runner: Runner;
  operatorActions: OperatorActions;
  generalSearch: GeneralSearchService;
  generalSearchConversation: GeneralSearchConversationService;
  logger: pino.Logger;
  createSnapshot(settings: Settings): Stack;
}

export interface BuildStackDeps {
  config: Config;
  /** Root logger; components take children. Defaults to pino at config's level. */
  logger?: pino.Logger;
  /** Test seam: inject a FakeLLM; production uses OpenRouterLLM. */
  llm?: LLMClient;
  now?: () => Date;
  state?: State;
}

/** Composition root: the single place the full object graph is wired (DI, no singletons). */
export function buildStack(deps: BuildStackDeps): Stack {
  const { config } = deps;
  const logger = deps.logger ?? pino({ level: config.LOG_LEVEL });
  const now = deps.now ?? (() => new Date());
  const http = (baseUrl: string, apiKey: string) => new Http({ baseUrl, apiKey });

  const sonarr = new SonarrClient(http(config.SONARR_URL, config.SONARR_API_KEY));
  const radarr = new RadarrClient(http(config.RADARR_URL, config.RADARR_API_KEY));
  const prowlarr = new ProwlarrClient(http(config.PROWLARR_URL, config.PROWLARR_API_KEY));
  const state = deps.state ?? State.open(config.DB_PATH);

  const watcherLogger = logger.child({ component: 'watcher' });
  const watcher = new Watcher({
      sonarr,
      radarr,
      now,
      onError: (error, context) => watcherLogger.warn({ ...safeWatcherErrorFields(error), context }, 'watcher fetch failed'),
  });

  const llm =
    deps.llm ??
    new OpenRouterLLM({
      client: new OpenRouter({
        apiKey: config.LLM_API_KEY,
        serverURL: config.LLM_BASE_URL,
        // The LLM client owns cancellable 5xx retries inside one 60s JSON deadline.
        // Disable the SDK retry loop: its backoff sleeps cannot be aborted at that deadline.
        retryConfig: { strategy: 'none' },
      }),
      model: config.LLM_MODEL,
    });

  const planner = new Planner({ llm });
  const picker = new Picker({ llm, mediaPreferences: config.MEDIA_PREFERENCES });
  const associator = new QueueAssociator({ llm });
  const runner = new Runner({
    watcher,
    planner,
    picker,
    associator,
    prowlarr,
    state,
    sonarr,
    radarr,
    config: {
      dryRun: config.DRY_RUN,
      minRetryHours: config.MIN_RETRY_HOURS,
      failureBackoffMin: config.FAILURE_BACKOFF_MIN,
      failureBackoffMaxMin: config.FAILURE_BACKOFF_MAX_MIN,
      queueGraceMin: config.QUEUE_GRACE_MIN,
    },
    clientNames: { tv: config.PROWLARR_CLIENT_TV, movie: config.PROWLARR_CLIENT_MOVIE },
    logger: logger.child({ component: 'runner' }),
    now,
  });

  const operatorActions = new OperatorActions({ enabled: config.ALLOW_OPERATOR_ACTIONS, config, state, watcher, sonarr, radarr, now });
  const generalSearch = new GeneralSearchService({ llm, prowlarr, state, runtimeSettings: structuredClone(config.settings), getSettings: () => state.getSettings(), now });
  const generalSearchConversation = new GeneralSearchConversationService({ llm, prowlarr, state, runtimeSettings: structuredClone(config.settings), getSettings: () => state.getSettings(), now });

  const stack: Stack = { config, state, watcher, sonarr, radarr, prowlarr, llm, planner, picker, runner, operatorActions, generalSearch, generalSearchConversation, logger,
    createSnapshot: (settings) => buildStack({ config: configWithSettings(config, settings), logger, now, state, ...(deps.llm ? { llm: deps.llm } : {}) }),
  };
  return stack;
}

/** Watcher errors can include authenticated upstream URLs and bodies; logs keep only safe diagnostics. */
function safeWatcherErrorFields(error: unknown): { errorType: string; httpStatus?: number } {
  const errorType =
    error instanceof Error && SAFE_WATCHER_ERROR_NAMES.has(error.name)
      ? error.name
      : 'UnknownError';
  return {
    errorType,
    ...(error instanceof ApiError ? { httpStatus: error.status } : {}),
  };
}
