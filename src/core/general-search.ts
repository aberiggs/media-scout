import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient } from '../clients/llm';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { DownloadClient, Release } from '../types/prowlarr';
import type { GeneralRelease, GeneralSearchResponse, GeneralGrabResponse } from '../types/general-search';
import type { State } from './state';
import type { Settings } from '../settings';

const planSchema = z.object({ mode: z.enum(['search', 'clarify']), queries: z.array(z.string().trim().min(1).max(300)).max(3), question: z.string().max(500) }).strict().refine((v) => v.mode === 'clarify' ? v.question.length > 0 && v.queries.length === 0 : v.queries.length >= 1, 'invalid search plan');
const planJsonSchema = { type: 'object', properties: { mode: { type: 'string', enum: ['search', 'clarify'] }, queries: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, maxItems: 3 }, question: { type: 'string', maxLength: 500 } }, required: ['mode', 'queries', 'question'], additionalProperties: false };
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
type Cached = { public: GeneralRelease; release: Pick<Release, 'guid' | 'indexerId'>; sourceKey: string; legacySourceKey: string };

export class GeneralSearchService {
  private readonly capturedSettings: Settings;
  constructor(private deps: { llm: LLMClient; prowlarr: ProwlarrClient; state: State; getSettings: () => Settings; runtimeSettings?: Settings; now?: () => Date }) {
    this.capturedSettings = structuredClone(deps.runtimeSettings ?? deps.getSettings());
  }
  private runtimeSettings(): Settings { return this.capturedSettings; }
  private runtimeFingerprint(s: Settings) { return sha(JSON.stringify([s.integrations.prowlarr.url, s.integrations.prowlarr.apiKey, s.integrations.prowlarr.generalClient ?? '', s.ai.baseUrl, s.ai.apiKey, s.ai.model])); }
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
    const plan = await this.deps.llm.json({ label: 'general search planning', system: 'Plan a general-purpose media search. Return mode search with one to three concise Prowlarr query strings (each <=300 characters), or mode clarify with a concise question and no queries. Never choose or recommend a release. Do not include URLs, credentials, or secrets.', user: cleanQuery, schema: planSchema, jsonSchema: { name: 'general_search_plan', schema: planJsonSchema } });
    if (this.runtimeFingerprint(this.deps.getSettings()) !== this.runtimeFingerprint(s)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    const cleanQueries = [...new Set(plan.queries.map((q) => safeText(q, s)).filter(Boolean))].slice(0, 3);
    const safeQuestion = safeText(plan.question, s);
    if (plan.mode === 'clarify' || !cleanQueries.length) return { status: 'clarification-needed', query: cleanQuery, queries: [], question: safeQuestion || 'What would you like to search for?', searchId: null, expiresAt: null, confirmationToken: null, releases: [], destination: null, dryRun: s.safety.dryRun, actionsAllowed: s.safety.allowOperatorActions, blockedReason: null };
    const dest = await this.destination(s).catch(() => ({ client: null as never, error: 'destination-unavailable' }));
    if (this.runtimeFingerprint(this.deps.getSettings()) !== this.runtimeFingerprint(s)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    const groups = await Promise.all(cleanQueries.map((q) => this.deps.prowlarr.search({ query: q, categories: [] })));
    const seen = new Set<string>(); const cached: Cached[] = [];
    for (const r of groups.flat()) {
      const key = `${r.indexerId}:${r.guid}`; if (seen.has(key)) continue; seen.add(key);
      if (cached.length >= 100) break;
      const id = randomUUID();
      const compatible = !!dest.client && (dest.client.protocol === r.protocol);
      const sourceKey = this.stableSubmissionKey(s, r.indexerId, r.guid);
      const legacySourceKey = this.legacySubmissionKey(s, r.indexerId, r.guid);
      this.deps.state.migrateLegacyGeneralSearchReceipt(sourceKey, legacySourceKey);
      cached.push({ public: { releaseId: id, title: safeText(r.title, s), indexer: safeText(r.indexer, s), size: r.size, seeders: r.seeders, leechers: r.leechers, age: r.age, protocol: r.protocol, selectable: compatible, unavailableReason: compatible ? null : (dest.error ?? 'protocol-mismatch') }, release: { guid: r.guid, indexerId: r.indexerId }, sourceKey, legacySourceKey });
    }
    const searchId = randomUUID(), token = randomBytes(32).toString('hex'), expiresAt = new Date(this.now().getTime() + 15 * 60_000).toISOString();
    this.deps.state.pruneGeneralSearchSnapshots(this.now().toISOString());
    this.deps.state.saveGeneralSearchSnapshot({ id: searchId, tokenDigest: sha(token), expiresAt, fingerprint: this.fingerprint(s), clientName: dest.client?.name ?? s.integrations.prowlarr.generalClient ?? '', clientProtocol: dest.client?.protocol ?? '', clientId: dest.client?.id ?? null, routingDigest: dest.client?.routingDigest ?? '', dryRun: s.safety.dryRun, payload: { releases: cached } });
    const blockedReason = !s.safety.allowOperatorActions ? 'operator-actions-disabled' : dest.error ?? (cached.length > 0 && cached.every(({ public: release }) => !release.selectable) ? 'destination-protocol-mismatch' : null);
    return { status: 'selection-required', query: cleanQuery, queries: cleanQueries, question: 'Which release or releases would you like to download? Select explicitly, then confirm.', searchId, expiresAt, confirmationToken: token, releases: cached.map(({public:p})=>p), destination: dest.client ? { name: safeText(dest.client.name, s), protocol: dest.client.protocol as 'usenet'|'torrent' } : null, dryRun: s.safety.dryRun, actionsAllowed: s.safety.allowOperatorActions, blockedReason };
  }
  async grab(searchId: string, raw: unknown): Promise<GeneralGrabResponse> {
    const body = raw as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).some((k)=>!['confirmationToken','releaseIds','confirmed'].includes(k)) || typeof body.confirmationToken !== 'string' || !Array.isArray(body.releaseIds) || body.releaseIds.length < 1 || body.releaseIds.length > 10 || !body.releaseIds.every((x)=>typeof x==='string') || new Set(body.releaseIds).size!==body.releaseIds.length || body.confirmed !== true) throw Object.assign(new Error('invalid-request'), {code:'invalid-request'});
    const snapshot = this.deps.state.getGeneralSearchSnapshot(searchId);
    const expiresAt = snapshot ? Date.parse(snapshot.expiresAt) : Number.NaN;
    if (!snapshot || !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) throw Object.assign(new Error('search-expired'), {code:'search-expired'});
    if (sha(body.confirmationToken) !== snapshot.tokenDigest) throw Object.assign(new Error('invalid-confirmation'), {code:'invalid-confirmation'});
    const runtimeSettings = this.runtimeSettings();
    const initialSettings = this.deps.getSettings();
    if (this.prowlarrFingerprint(initialSettings) !== this.prowlarrFingerprint(runtimeSettings)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    this.assertCurrent(snapshot, initialSettings);
    const dest = await this.destination(runtimeSettings);
    const s = this.deps.getSettings();
    if (this.prowlarrFingerprint(s) !== this.prowlarrFingerprint(runtimeSettings)) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
    this.assertCurrent(snapshot, s);
    if (dest.error || dest.client.name !== snapshot.clientName || dest.client.protocol !== snapshot.clientProtocol || dest.client.id !== snapshot.clientId || dest.client.routingDigest !== snapshot.routingDigest) throw Object.assign(new Error('destination-changed'), {code:'destination-changed'});
    const cached = (snapshot.payload as { releases?: Cached[] })?.releases;
    if (!Array.isArray(cached)) throw Object.assign(new Error('search-expired'), {code:'search-expired'});
    const byId = new Map(cached.map((c)=>[c.public.releaseId,c]));
    if (body.releaseIds.some((id)=>!byId.has(id))) throw Object.assign(new Error('invalid-release-selection'), {code:'invalid-release-selection'});
    const results: GeneralGrabResponse['results'] = [];
    for (let i=0;i<body.releaseIds.length;i++) {
      const id = body.releaseIds[i] as string; const item = byId.get(id)!;
      if (!item.public.selectable) { results.push({releaseId:id,status:'not-attempted',code:'release-unavailable'}); for (const rest of body.releaseIds.slice(i+1) as string[]) results.push({releaseId:rest,status:'not-attempted',code:'previous-selection-unavailable'}); break; }
      try { this.assertCurrent(snapshot, this.deps.getSettings()); }
      catch (error) { results.push({releaseId:id,status:'not-attempted',code:this.errorCode(error)}); for (const rest of body.releaseIds.slice(i+1) as string[]) results.push({releaseId:rest,status:'not-attempted',code:this.errorCode(error)}); break; }
      if (s.safety.dryRun) { results.push({releaseId:id,status:'dry-run',code:null}); continue; }
      const reserved = this.deps.state.reserveGeneralSearchRelease(searchId,id,this.now().toISOString(),item.sourceKey,item.legacySourceKey);
      if (!reserved.reserved) {
        results.push({releaseId:id,status:reserved.status as GeneralGrabResponse['results'][number]['status'],code:reserved.code});
        if (reserved.status !== 'submitted') { for (const rest of body.releaseIds.slice(i+1) as string[]) results.push({releaseId:rest,status:'not-attempted',code:'previous-submission-failed'}); break; }
        continue;
      }
      try { this.assertCurrent(snapshot, this.deps.getSettings()); }
      catch (error) {
        this.deps.state.cancelGeneralSearchReservation(searchId, id, item.sourceKey);
        const code = this.errorCode(error);
        results.push({releaseId:id,status:'not-attempted',code});
        for (const rest of body.releaseIds.slice(i+1) as string[]) results.push({releaseId:rest,status:'not-attempted',code});
        break;
      }
      try { await this.deps.prowlarr.grabGeneral(item.release, dest.client.id); this.deps.state.finishGeneralSearchRelease(searchId,id,'submitted',null,this.now().toISOString()); results.push({releaseId:id,status:'submitted',code:null}); }
      catch (error) { const api = error as {status?:number}; const uncertain = !api || !Number.isInteger(api.status) || api.status === 0 || ((api.status ?? 0) >= 200 && (api.status ?? 0) < 300) || (api.status ?? 0) >= 500; const status = uncertain ? 'uncertain' : 'failed'; const code = uncertain ? 'upstream-uncertain' : `upstream-${api.status}`; this.deps.state.finishGeneralSearchRelease(searchId,id,status,code,this.now().toISOString()); results.push({releaseId:id,status,code}); for (const rest of body.releaseIds.slice(i+1) as string[]) results.push({releaseId:rest,status:'not-attempted',code:'previous-submission-failed'}); break; }
    }
    return {searchId,dryRun:s.safety.dryRun,results};
  }
  private assertCurrent(snapshot: NonNullable<ReturnType<State['getGeneralSearchSnapshot']>>, settings: Settings): void {
    const expiry = Date.parse(snapshot.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now().getTime()) throw Object.assign(new Error('search-expired'), { code: 'search-expired' });
    if (!settings.safety.allowOperatorActions) throw Object.assign(new Error('operator-actions-disabled'), { code: 'operator-actions-disabled' });
    if (this.fingerprint(settings) !== snapshot.fingerprint || settings.safety.dryRun !== snapshot.dryRun) throw Object.assign(new Error('settings-changed'), { code: 'settings-changed' });
  }
  private errorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'settings-changed'; }
}
