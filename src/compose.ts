import pino from 'pino';
import { SearchRuntime, type SearchRuntimeOptions } from './search/runtime';
import type { Config } from './config';

export interface Stack { config: Config; runtime: SearchRuntime; logger: pino.Logger }
export type BuildStackDeps = SearchRuntimeOptions & { config: Config; logger?: pino.Logger };

/** One modular runtime, not two acquisition engines. */
export function buildStack(deps: BuildStackDeps): Stack {
  const { RESEARCH_MCP_ENDPOINTS, ...runtimeOptions } = deps.config;
  return { config: deps.config, logger: deps.logger ?? pino({ level: deps.config.LOG_LEVEL }), runtime: new SearchRuntime({ ...deps, ...runtimeOptions, researchMcpEndpoints: RESEARCH_MCP_ENDPOINTS.split(',').filter(Boolean), databasePath: deps.config.DB_PATH }) };
}
