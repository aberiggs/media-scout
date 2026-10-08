const SAFE_GENERAL_SEARCH_CODES = new Set([
  'invalid-request','invalid-budget','search-unavailable','operator-actions-disabled','search-expired',
  'invalid-confirmation','invalid-release-selection','settings-changed','destination-changed',
  'operation-not-found','operation-stopped','aborted','provider-refusal','llm-timeout',
  'invalid-llm-output','llm-provider-failure','invalid-search-plan','ai-budget-exhausted',
]);

export function safeGeneralSearchErrorCode(error: unknown): string | null {
  const code=error&&typeof error==='object'&&'code'in error?(error as {code?:unknown}).code:null;
  return typeof code==='string'&&SAFE_GENERAL_SEARCH_CODES.has(code)?code:null;
}
