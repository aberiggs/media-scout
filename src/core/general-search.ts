import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient } from '../clients/llm';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { DownloadClient, Release } from '../types/prowlarr';
import type { GeneralRelease, GeneralSearchResponse, GeneralGrabResponse, GeneralSearchOperationCreateRequest, GeneralSearchOperationStatus } from '../types/general-search';
import type { State } from './state';
import type { Settings } from '../settings';
import { ApiError } from '../http';
import { compileSearchPlan, hasMeaningfulClarification, INTERPRETER_PLANNER_SYSTEM, repairPlanningUser, searchPlanJsonSchema, searchPlanSchema } from './search-planning';

const safeText = (value: string, s: Settings, maxLength = 300) => {
  let result = value;
  const secrets = [s.ai.apiKey, s.integrations.prowlarr.apiKey, s.integrations.sonarr.apiKey, s.integrations.radarr.apiKey]
    .filter((secret) => secret.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) result = result.replaceAll(secret, '[removed]');
  return result
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '[removed]')
    .replace(/\bmagnet:\?[^\s"'<>]*/gi, '[removed]')
    .replace(/(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+/gi, '[removed]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const safeReference = (value: string, s: Settings) => {
  const secrets = [s.integrations.prowlarr.apiKey, s.integrations.sonarr.apiKey, s.integrations.radarr.apiKey, s.ai.apiKey].filter((item) => item.trim()).sort((a,b)=>b.length-a.length);
  return !!value && !/[a-z][a-z\d+.-]*:\/\/|magnet:\?|(?:api[_ -]?key|token|password|secret)\s*[:=]|[\w.%+-]+:[^/\s@]+@/i.test(value) && !secrets.some((secret) => value.includes(secret));
};
type Cached = { public: GeneralRelease; release: Pick<Release, 'guid' | 'indexerId'>; sourceKey: string; legacySourceKey: string };

export class GeneralSearchService {
  private readonly capturedSettings: Settings;
  constructor(private deps: { llm: LLMClient; prowlarr: ProwlarrClient; state: State; getSettings: () => Settings; runtimeSettings?: Settings; now?: () => Date }) {
    this.capturedSettings = structuredClone(deps.runtimeSettings ?? deps.getSettings());
  }
  private runtimeSettings(): Settings { return this.capturedSettings; }
  private runtimeFingerprint(s: Settings) { return sha(JSON.stringify([s.integrations.prowlarr.url, s.integrations.prowlarr.apiKey, s.integrations.prowlarr.generalClient ?? '', s.ai.baseUrl, s.ai.apiKey, s.ai.model, s.ai.searchSystemPrompt])); }
  private prowlarrFingerprint(s: Settings) { return sha(JSON.stringify([s.integrations.prowlarr.url, s.integrations.prowlarr.apiKey, s.integrations.prowlarr.generalClient ?? ''])); }
  private now() { return (this.deps.now ?? (() => new Date()))(); }
  private fingerprint(s: Settings) { return sha(JSON.stringify([s.integrations.prowlarr.url, s.integrations.prowlarr.apiKey, s.integrations.prowlarr.generalClient ?? '', s.safety.dryRun, s.safety.allowOperatorActions])); }
  private stableSubmissionKey(s: Settings, indexerId: number, guid: string) {
    const base = new URL(s.integrations.prowlarr.url);
    base.pathname = base.pathname.replace(/\/+$/, '');
    base.search = '';
    base.hash = '';
    return sha(JSON.stringify([base.toString(), indexerId, guid]));
  }
  private legacySubmissionKey(s: Settings, indexerId: number, guid: string) { return sha(JSON.stringify([s.integrations.prowlarr.url, s.integrations.prowlarr.apiKey, indexerId, guid])); }
  private async destination(s: Settings): Promise<{ client: DownloadClient; error: string | null }> {
    const name = (s.integrations.prowlarr.generalClient ?? '').trim();
    if (!name) return { client: null as never, error: 'destination-not-configured' };
    const matches = (await this.deps.prowlarr.getDownloadClients()).filter((c) => c.enable && c.name === name);
    if (matches.length !== 1) return { client: null as never, error: matches.length ? 'destination-ambiguous' : 'destination-unavailable' };
    const client = matches[0]!;
    if (client.protocol !== 'usenet' && client.protocol !== 'torrent') return { client: null as never, error: 'destination-protocol-unknown' };
    if (!client.routingDigest) return { client: null as never, error: 'routing-metadata-unavailable' };
    return { client, error: null };
  }
  async search(raw: unknown): Promise<GeneralSearchResponse> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'query') || typeof (raw as {query?:unknown}).query !== 'string') throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
    const query = (raw as {query:string}).query.trim();
    if (query.length < 1 || query.length > 500) throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
    const s = this.runtimeSettings();
    if (this.runtimeFingerprint(this.deps.getSettings()) !== this.runtimeFingerprint(s)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    if (!s.ai.baseUrl.trim() || !s.ai.apiKey.trim() || !s.integrations.prowlarr.url.trim() || !s.integrations.prowlarr.apiKey.trim()) throw Object.assign(new Error('search-unavailable'), { code: 'search-unavailable' });
    const cleanQuery = safeText(query, s, 500);
    const system = withSearchInstructions(INTERPRETER_PLANNER_SYSTEM, s.ai.searchSystemPrompt);
    const planningArgs = { label: 'general search planning', system, user: JSON.stringify({ role: 'interpreter and initial query planner', request: cleanQuery, retrieval: { previousQueries: [], budget: s.generalSearch?.maxQueries ?? 6 } }), schema: searchPlanSchema, jsonSchema: { name: 'general_search_plan', schema: searchPlanJsonSchema } };
    const maxAiCalls=s.generalSearch?.maxAiCalls??12;
    let aiCalls=0;
    const checkRuntime=()=>{if(this.runtimeFingerprint(this.deps.getSettings())!==this.runtimeFingerprint(s))throw Object.assign(new Error('settings-changed'),{code:'settings-changed'});};
    const llmCall=async<T>(args:Parameters<LLMClient['json']>[0]):Promise<T>=>{
      checkRuntime();
      if(aiCalls>=maxAiCalls)throw Object.assign(new Error('ai-budget-exhausted'),{code:'ai-budget-exhausted'});
      aiCalls++;
      let firstHook=true;
      try {
        const result=await this.deps.llm.json({...args,onAttempt:()=>{
          checkRuntime();
          if(firstHook){firstHook=false;return;}
          if(aiCalls>=maxAiCalls)throw Object.assign(new Error('ai-budget-exhausted'),{code:'ai-budget-exhausted'});
          aiCalls++;
        }}) as T;
        checkRuntime();
        return result;
      } catch(error) { checkRuntime(); throw safeSearchLLMError(error); }
    };
    let rawPlan: unknown;
    let repairedOnce = false;
    try { rawPlan = await llmCall<unknown>(planningArgs); }
    catch (error) {
      if (!isInvalidLLMOutput(error)) throw error;
      repairedOnce = true;
      rawPlan = await llmCall<unknown>({ ...planningArgs, label: 'general search planning repair', user: repairPlanningUser(planningArgs.user,error) });
    }
    checkRuntime();
    let plan;
    let validationError:unknown;
    try { plan = assertPlanSafe(compilePublicSearchPlan(rawPlan,s), s); }
    catch(error) { validationError=error; }
    checkRuntime();
    if(validationError!==undefined) {
      if(repairedOnce)throw Object.assign(new Error('invalid-search-plan'),{code:'invalid-search-plan'});
      const repaired=await llmCall<unknown>({...planningArgs,label:'general search planning repair',user:repairPlanningUser(planningArgs.user,validationError)});
      checkRuntime();
      let repairError:unknown;
      try { plan=assertPlanSafe(compilePublicSearchPlan(repaired,s),s); }
      catch(error) { repairError=error; }
      checkRuntime();
      if(repairError!==undefined)throw Object.assign(new Error('invalid-search-plan'),{code:'invalid-search-plan'});
    }
    if(!plan)throw Object.assign(new Error('invalid-search-plan'),{code:'invalid-search-plan'});
    checkRuntime();
    const cleanQueries = [...new Set(plan.proposals.map((proposal) => proposal.query).filter(Boolean))].slice(0, 3);
    const safeQuestion = plan.question;
    if (plan.mode === 'clarify') return { status: 'clarification-needed', query: cleanQuery, queries: [], question: safeQuestion, searchId: null, expiresAt: null, confirmationToken: null, releases: [], destination: null, dryRun: s.safety.dryRun, actionsAllowed: s.safety.allowOperatorActions, blockedReason: null };
    const dest = await this.destination(s).catch(() => ({ client: null as never, error: 'destination-unavailable' }));
    if (this.runtimeFingerprint(this.deps.getSettings()) !== this.runtimeFingerprint(s)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    const groups = await Promise.all(cleanQueries.map((q) => this.deps.prowlarr.search({ query: q, categories: [] })));
    if (this.runtimeFingerprint(this.deps.getSettings()) !== this.runtimeFingerprint(s)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    const seen = new Set<string>(); const cached: Cached[] = [];
    for (const r of groups.flat()) {
      const key = `${r.indexerId}:${r.guid}`; if (seen.has(key)) continue; seen.add(key);
      if (!safeReference(r.guid, s)) continue;
      if (cached.length >= (s.generalSearch?.maxCandidates ?? 200)) break;
      const id = randomUUID();
      const compatible = !!dest.client && (dest.client.protocol === r.protocol);
      const sourceKey = this.stableSubmissionKey(s, r.indexerId, r.guid);
      const legacySourceKey = this.legacySubmissionKey(s, r.indexerId, r.guid);
      this.deps.state.migrateLegacyGeneralSearchReceipt(sourceKey, legacySourceKey);
      cached.push({ public: { releaseId: id, title: safeText(r.title, s), indexer: safeText(r.indexer, s), size: r.size, seeders: r.seeders, leechers: r.leechers, age: r.age, protocol: r.protocol, selectable: compatible, unavailableReason: compatible ? null : (dest.error ?? 'protocol-mismatch') }, release: { guid: r.guid, indexerId: r.indexerId }, sourceKey, legacySourceKey });
    }
    const searchId = randomUUID(), token = randomBytes(32).toString('hex'), expiresAt = new Date(this.now().getTime() + 15 * 60_000).toISOString();
    if (this.runtimeFingerprint(this.deps.getSettings()) !== this.runtimeFingerprint(s)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    this.deps.state.pruneGeneralSearchSnapshots(this.now().toISOString());
    const rawClientName = dest.client?.name ?? s.integrations.prowlarr.generalClient ?? '';
    this.deps.state.saveGeneralSearchSnapshot({ id: searchId, tokenDigest: sha(token), expiresAt, fingerprint: this.fingerprint(s), clientName: safeText(rawClientName, s), clientNameDigest: sha(rawClientName), clientProtocol: dest.client?.protocol ?? '', clientId: dest.client?.id ?? null, routingDigest: dest.client?.routingDigest ?? '', dryRun: s.safety.dryRun, payload: { releases: cached } });
    const blockedReason = !s.safety.allowOperatorActions ? 'operator-actions-disabled' : dest.error ?? (cached.length > 0 && cached.every(({ public: release }) => !release.selectable) ? 'destination-protocol-mismatch' : null);
    return { status: 'selection-required', query: cleanQuery, queries: cleanQueries, question: 'Which release or releases would you like to download? Select explicitly, then confirm.', searchId, expiresAt, confirmationToken: token, releases: cached.map(({public:p})=>p), destination: dest.client ? { name: safeText(dest.client.name, s), protocol: dest.client.protocol as 'usenet'|'torrent' } : null, dryRun: s.safety.dryRun, actionsAllowed: s.safety.allowOperatorActions, blockedReason };
  }

  /** Freeze an entire selected manifest before any upstream mutation. */
  async createOperation(searchId: string, raw: unknown): Promise<GeneralSearchOperationStatus> {
    const body = raw as Partial<GeneralSearchOperationCreateRequest> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['operationId','confirmationToken','releaseIds','confirmed'].includes(key)) ||
      typeof body.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId) ||
      typeof body.confirmationToken !== 'string' || !Array.isArray(body.releaseIds) || body.releaseIds.length < 1 || body.releaseIds.length > 1000 ||
      !body.releaseIds.every((id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(body.releaseIds).size !== body.releaseIds.length || body.confirmed !== true) {
      throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
    }
    const requestDigest = sha(JSON.stringify({ searchId, tokenDigest: sha(body.confirmationToken), releaseIds: body.releaseIds }));
    const existing = this.deps.state.getGeneralSearchOperation(body.operationId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw Object.assign(new Error('operation-id-conflict'), { code: 'operation-id-conflict' });
      return existing.status as GeneralSearchOperationStatus;
    }
    const maxCandidates = Math.min(1000, this.runtimeSettings().generalSearch?.maxCandidates ?? 200);
    if (body.releaseIds.length > maxCandidates) throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
    const snapshot = this.deps.state.getGeneralSearchSnapshot(searchId);
    if (!snapshot || !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= this.now().getTime()) throw Object.assign(new Error('search-expired'), { code: 'search-expired' });
    if (sha(body.confirmationToken) !== snapshot.tokenDigest) throw Object.assign(new Error('invalid-confirmation'), { code: 'invalid-confirmation' });
    const releases = (snapshot.payload as { releases?: Cached[] } | null)?.releases;
    if (!Array.isArray(releases)) throw Object.assign(new Error('search-expired'), { code: 'search-expired' });
    const byId = new Map(releases.map((item) => [item.public.releaseId, item]));
    const selected = body.releaseIds.map((id) => byId.get(id));
    // Validate all IDs and selectability before persisting any operation state.
    if (selected.some((item) => !item || !item.public.selectable)) throw Object.assign(new Error('invalid-release-selection'), { code: 'invalid-release-selection' });
    const manifest = selected.map((item) => item!);
    const expiresAtOf = (item: Cached) => {
      const publicExpiry = (item.public as GeneralRelease & { expiresAt?: string }).expiresAt;
      const expiry = publicExpiry === undefined ? Date.parse(snapshot.expiresAt) : Date.parse(publicExpiry);
      if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) throw Object.assign(new Error('search-expired'), { code: 'search-expired' });
      return expiry;
    };
    const itemExpiries = manifest.map(expiresAtOf);
    if (manifest.some(({ release }) => !safeReference(release.guid, this.runtimeSettings()))) throw Object.assign(new Error('invalid-release-selection'), { code: 'invalid-release-selection' });
    const current = this.deps.getSettings();
    if (this.prowlarrFingerprint(current) !== this.prowlarrFingerprint(this.runtimeSettings()) || this.fingerprint(current) !== snapshot.fingerprint || !current.safety.allowOperatorActions) throw Object.assign(new Error(!current.safety.allowOperatorActions ? 'operator-actions-disabled' : 'settings-changed'), { code: !current.safety.allowOperatorActions ? 'operator-actions-disabled' : 'settings-changed' });
    let destination: { client: DownloadClient; error: string | null };
    try { destination = await this.destination(this.runtimeSettings()); }
    catch { destination = { client: null as never, error: 'destination-unavailable' }; }
    const afterLookup = this.deps.getSettings();
    if (this.prowlarrFingerprint(afterLookup) !== this.prowlarrFingerprint(this.runtimeSettings()) || this.fingerprint(afterLookup) !== snapshot.fingerprint || !afterLookup.safety.allowOperatorActions) throw Object.assign(new Error(!afterLookup.safety.allowOperatorActions ? 'operator-actions-disabled' : 'settings-changed'), { code: !afterLookup.safety.allowOperatorActions ? 'operator-actions-disabled' : 'settings-changed' });
    if (body.releaseIds.length > Math.min(1000, afterLookup.generalSearch?.maxCandidates ?? 200)) throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
    if (destination.error || !destination.client || destination.client.id !== snapshot.clientId || destination.client.protocol !== snapshot.clientProtocol || destination.client.routingDigest !== snapshot.routingDigest || sha(destination.client.name) !== snapshot.clientNameDigest) throw Object.assign(new Error('destination-changed'), { code: 'destination-changed' });
    for (const expiry of itemExpiries) if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) throw Object.assign(new Error('search-expired'), { code: 'search-expired' });
    const now = this.now().toISOString();
    const operationExpiry = new Date(Math.min(Date.parse(snapshot.expiresAt), ...itemExpiries)).toISOString();
    const status: GeneralSearchOperationStatus = {
      operationId: body.operationId,
      releases: manifest.map(({ public: item }) => ({ releaseId: item.releaseId, status: 'pending' as const, code: null })),
      mode: snapshot.dryRun ? 'dry-run' : 'live',
      destination: { name: safeText(snapshot.clientName, this.runtimeSettings()), protocol: snapshot.clientProtocol as 'usenet' | 'torrent' },
      expiresAt: operationExpiry,
      nextOrdinal: 0,
      stopped: false,
      complete: false,
    };
    const created = this.deps.state.createGeneralSearchOperation({ operationId: body.operationId, searchId, requestDigest, status, privatePayload: { manifest, fingerprint: snapshot.fingerprint, sourceFingerprint: this.prowlarrFingerprint(this.runtimeSettings()), dryRun: snapshot.dryRun, clientId: snapshot.clientId, routingDigest: snapshot.routingDigest, clientNameDigest: snapshot.clientNameDigest }, now });
    return created.status as GeneralSearchOperationStatus;
  }

  async operationStatus(operationId: string): Promise<GeneralSearchOperationStatus> {
    const operation = this.deps.state.getGeneralSearchOperation(operationId);
    if (!operation) throw Object.assign(new Error('operation-not-found'), { code: 'operation-not-found' });
    return operation.status as GeneralSearchOperationStatus;
  }

  /** Execute exactly one frozen manifest entry. The SQLite claim is durable before any await. */
  async stepOperation(operationId: string, raw: unknown, expectedOrdinal?: number): Promise<GeneralSearchOperationStatus> {
    const body = raw as { expectedOrdinal?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'expectedOrdinal') || !Number.isSafeInteger(body.expectedOrdinal) || Number(body.expectedOrdinal) < 0 || (expectedOrdinal !== undefined && expectedOrdinal !== body.expectedOrdinal)) throw Object.assign(new Error('invalid-request'), { code: 'invalid-request' });
    const initial = this.deps.state.getGeneralSearchOperation(operationId);
    if (!initial) throw Object.assign(new Error('operation-not-found'), { code: 'operation-not-found' });
    const initialStatus = initial.status as GeneralSearchOperationStatus;
    const privateData = initial.privatePayload as { manifest: Cached[]; fingerprint: string; sourceFingerprint: string; dryRun: boolean; clientId: number | null; routingDigest: string; clientNameDigest: string };
    const ordinal = Number(body.expectedOrdinal);
    const item = privateData.manifest?.[ordinal];
    if (!item) return initialStatus;
    const claim = this.deps.state.claimGeneralSearchOperationStep({ operationId, expectedOrdinal: ordinal, now: this.now().toISOString(), releaseId: item.public.releaseId, sourceKey: item.sourceKey, legacySourceKey: item.legacySourceKey, reserveReceipt: !privateData.dryRun });
    if (!claim) throw Object.assign(new Error('operation-not-found'), { code: 'operation-not-found' });
    if (!claim.claimed) return claim.status as GeneralSearchOperationStatus;

    const finish = (status: string, code: string | null, stop: boolean, stopCode?: string | null) => this.deps.state.finishGeneralSearchOperationStep({ operationId, releaseId: item.public.releaseId, status, code, now: this.now().toISOString(), stop, stopCode }) as GeneralSearchOperationStatus;
    const check = (): string | null => {
      const currentOperation = this.deps.state.getGeneralSearchOperation(operationId);
      if (!currentOperation) return 'operation-not-found';
      const currentStatus = currentOperation.status as GeneralSearchOperationStatus;
      if (currentStatus.stopped) return 'operation-stopped';
      const now = this.now().getTime();
      const expiry = Math.min(Date.parse(currentStatus.expiresAt), Date.parse((item.public as GeneralRelease & { expiresAt?: string }).expiresAt ?? currentStatus.expiresAt));
      if (!Number.isFinite(expiry) || expiry <= now) return 'search-expired';
      const current = this.deps.getSettings();
      if (this.prowlarrFingerprint(current) !== privateData.sourceFingerprint || this.prowlarrFingerprint(this.runtimeSettings()) !== privateData.sourceFingerprint) return 'settings-changed';
      if (!current.safety.allowOperatorActions) return 'operator-actions-disabled';
      if (current.safety.dryRun !== privateData.dryRun || this.fingerprint(current) !== privateData.fingerprint) return 'settings-changed';
      return null;
    };
    const before = check();
    if (before) return finish('not-attempted', before, true);

    let destination: { client: DownloadClient; error: string | null };
    try { destination = await this.destination(this.runtimeSettings()); }
    catch { return finish('not-attempted', 'destination-unavailable', true); }
    const afterLookup = check();
    if (afterLookup) return finish('not-attempted', afterLookup, true);
    const statusDest = initialStatus.destination;
    if (destination.error || !destination.client || sha(destination.client.name) !== privateData.clientNameDigest || destination.client.protocol !== statusDest.protocol ||
      destination.client.id !== privateData.clientId || destination.client.routingDigest !== privateData.routingDigest || sha(destination.client.name) !== privateData.clientNameDigest) return finish('not-attempted', 'destination-changed', true);
    if (privateData.dryRun) return finish('dry-run', null, false);
    const immediatelyBeforePost = check();
    if (immediatelyBeforePost) return finish('not-attempted', immediatelyBeforePost, true);

    let outcome: { status: 'submitted' | 'failed' | 'uncertain'; code: string | null };
    try {
      await this.deps.prowlarr.grabGeneral(item.release, destination.client.id);
    } catch (error) {
      const api = error as { status?: number };
      const uncertain = !api || !Number.isInteger(api.status) || api.status === 0 || ((api.status ?? 0) >= 200 && (api.status ?? 0) < 300) || (api.status ?? 0) >= 500;
      outcome = { status: uncertain ? 'uncertain' : 'failed', code: uncertain ? 'upstream-uncertain' : `upstream-${api.status}` };
      return finish(outcome.status, outcome.code, true);
    }
    // The POST result is authoritative even if configuration changes while it was in flight.
    const changedAfterPost = check();
    outcome = { status: 'submitted', code: null };
    return finish(outcome.status, outcome.code, !!changedAfterPost, changedAfterPost);
  }

  async stopOperation(operationId: string): Promise<GeneralSearchOperationStatus> {
    const stopped = this.deps.state.stopGeneralSearchOperation(operationId);
    if (!stopped) throw Object.assign(new Error('operation-not-found'), { code: 'operation-not-found' });
    return stopped as GeneralSearchOperationStatus;
  }
  async grab(searchId: string, raw: unknown): Promise<GeneralGrabResponse> {
    const body = raw as Record<string, unknown> | null;
    const max = Math.min(1000, this.runtimeSettings().generalSearch?.maxCandidates ?? 200);
    if (!body || Array.isArray(body) || Object.keys(body).some((k)=>!['confirmationToken','releaseIds','confirmed'].includes(k)) || typeof body.confirmationToken !== 'string' || !Array.isArray(body.releaseIds) || body.releaseIds.length < 1 || body.releaseIds.length > max || !body.releaseIds.every((x)=>typeof x==='string') || new Set(body.releaseIds).size!==body.releaseIds.length || body.confirmed !== true) throw Object.assign(new Error('invalid-request'), {code:'invalid-request'});
    const snapshot = this.deps.state.getGeneralSearchSnapshot(searchId);
    if (!snapshot || !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= this.now().getTime()) throw Object.assign(new Error('search-expired'), {code:'search-expired'});
    if (sha(body.confirmationToken) !== snapshot.tokenDigest) throw Object.assign(new Error('invalid-confirmation'), {code:'invalid-confirmation'});
    const initialSettings = this.deps.getSettings();
    if (this.prowlarrFingerprint(initialSettings) !== this.prowlarrFingerprint(this.runtimeSettings())) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    this.assertCurrent(snapshot, initialSettings);
    const cached = (snapshot.payload as { releases?: Cached[] })?.releases;
    if (!Array.isArray(cached)) throw Object.assign(new Error('search-expired'), {code:'search-expired'});
    const byId = new Map(cached.map((c)=>[c.public.releaseId,c]));
    if (body.releaseIds.some((id)=>!byId.has(id) || !byId.get(id)!.public.selectable || !safeReference(byId.get(id)!.release.guid, this.runtimeSettings()))) throw Object.assign(new Error('invalid-release-selection'), {code:'invalid-release-selection'});
    const ids = body.releaseIds as string[];
    const beforeLookup = this.deps.getSettings();
    if (this.prowlarrFingerprint(beforeLookup) !== this.prowlarrFingerprint(this.runtimeSettings())) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    this.assertCurrent(snapshot, beforeLookup);
    const preflightDestination = await this.destination(this.runtimeSettings());
    const afterLookup = this.deps.getSettings();
    if (this.prowlarrFingerprint(afterLookup) !== this.prowlarrFingerprint(this.runtimeSettings())) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    this.assertCurrent(snapshot, afterLookup);
    if (preflightDestination.error || !preflightDestination.client || sha(preflightDestination.client.name) !== snapshot.clientNameDigest || preflightDestination.client.protocol !== snapshot.clientProtocol || preflightDestination.client.id !== snapshot.clientId || preflightDestination.client.routingDigest !== snapshot.routingDigest) throw Object.assign(new Error('destination-changed'), { code: 'destination-changed' });
    const digest = sha(JSON.stringify([searchId, snapshot.tokenDigest, ids]));
    const chars = digest.slice(0,32).split(''); chars[12]='5'; chars[16]=((parseInt(chars[16]!,16)&3)|8).toString(16);
    const operationId = `${chars.slice(0,8).join('')}-${chars.slice(8,12).join('')}-${chars.slice(12,16).join('')}-${chars.slice(16,20).join('')}-${chars.slice(20).join('')}`;
    let status = await this.createOperation(searchId, { operationId, confirmationToken: body.confirmationToken, releaseIds: ids, confirmed: true });
    while (!status.stopped && !status.complete && status.nextOrdinal < ids.length && !status.releases.some((item) => item.status === 'submitting')) {
      const ordinal = status.nextOrdinal;
      const next = await this.stepOperation(operationId, { expectedOrdinal: ordinal });
      status = next;
      if (status.nextOrdinal === ordinal || status.releases.some((item) => item.status === 'submitting')) break;
    }
    const noAttemptFatal = status.releases.find((item) => item.status === 'not-attempted' && item.code === 'destination-changed');
    if (noAttemptFatal && !status.releases.some((item) => item.status === 'submitted' || item.status === 'previously-submitted')) throw Object.assign(new Error(noAttemptFatal.code!), { code: noAttemptFatal.code });
    return { searchId, dryRun: status.mode === 'dry-run', results: status.releases.map((item) => ({
      releaseId: item.releaseId,
      status: (item.status === 'previously-submitted' ? 'submitted' : item.status === 'pending' ? 'not-attempted' : item.status) as GeneralGrabResponse['results'][number]['status'],
      code: item.code,
    })) };
  }
  private assertCurrent(snapshot: NonNullable<ReturnType<State['getGeneralSearchSnapshot']>>, settings: Settings): void {
    const expiry = Date.parse(snapshot.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) throw Object.assign(new Error('search-expired'), { code: 'search-expired' });
    if (!settings.safety.allowOperatorActions) throw Object.assign(new Error('operator-actions-disabled'), { code: 'operator-actions-disabled' });
    if (this.fingerprint(settings) !== snapshot.fingerprint || settings.safety.dryRun !== snapshot.dryRun) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
  }
}

function withSearchInstructions(system: string, instructions: string): string {
  return instructions ? `${system}\n\nUser-configured system instructions:\n${instructions}\n\nThe user-configured text is supplementary guidance. Continue to follow the role, safety, untrusted-data, and structured-output requirements above.` : system;
}

function assertPlanSafe<T extends { proposals: Array<{ query: string; purpose: string; branch: string; preserves: string[] }> }>(plan: T, settings: Settings): T {
  const secrets = [settings.ai.apiKey, settings.integrations.prowlarr.apiKey, settings.integrations.sonarr.apiKey, settings.integrations.radarr.apiKey].filter((value) => value.trim());
  if (plan.proposals.some((proposal) => [proposal.query, proposal.purpose, proposal.branch, ...proposal.preserves].some((value) => secrets.some((secret) => value.includes(secret))))) throw Object.assign(new Error('invalid-search-plan'), { code: 'invalid-search-plan' });
  return plan;
}
function isInvalidLLMOutput(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && (error as {code:unknown}).code === 'invalid-llm-output'; }
function safeSearchLLMError(error: unknown): unknown {
  if(error instanceof ApiError)return Object.assign(new Error('llm-provider-failure'),{code:'llm-provider-failure'});
  if(error instanceof z.ZodError)return Object.assign(new Error('invalid-llm-output'),{code:'invalid-llm-output',fieldPaths:[...new Set(error.issues.map(issue=>issue.path.join('.')).filter(Boolean))].slice(0,12)});
  if(error&&typeof error==='object'&&'code'in error&&['provider-refusal','llm-timeout','invalid-llm-output','llm-provider-failure','settings-changed','ai-budget-exhausted'].includes(String((error as {code?:unknown}).code)))return error;
  if(error instanceof Error&&error.name==='TimeoutError')return Object.assign(new Error('llm-timeout'),{code:'llm-timeout'});
  if(error instanceof Error&&(/unparseable JSON after retry|LLM completion had no string|LLM returned a stream/.test(error.message)))return Object.assign(new Error('invalid-llm-output'),{code:'invalid-llm-output'});
  return Object.assign(new Error('llm-provider-failure'),{code:'llm-provider-failure'});
}
function compilePublicSearchPlan(raw:unknown,settings:Settings) {
  const plan=compileSearchPlan(raw);
  if(plan.mode==='clarify') { const question=safeText(plan.question,settings,500);if(!hasMeaningfulClarification(question))throw Object.assign(new Error('invalid-search-plan'),{code:'invalid-search-plan'});return {...plan,question}; }
  return plan;
}
