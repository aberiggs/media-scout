import { createHash } from 'node:crypto';
import { ApiError } from '../http';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { Release } from '../types/prowlarr';
import { submissionRequestSchema, type SubmissionRequest } from './contracts';
import type { SearchStore } from './store';
import { safeText } from './service';

export interface SubmissionPolicy { dryRun: boolean; enabled?: boolean; tvClient: string; movieClient: string; queueGraceMinutes: number; configurationFingerprint?: string }
export interface SafeDownloadClient { id: number; name: string; protocol: string; categories: boolean }
export interface SubmissionServerContext {
  targets?: string[];
  validate?: (release: Release, candidateId: string) => Promise<boolean> | boolean;
  fingerprint?: () => string;
  available?: () => boolean;
}
export interface SubmissionResult { searchId: string; optionId: string; outcome: 'submitted' | 'rejected' | 'uncertain' | 'deferred' | 'conflict' | 'failed' | 'dry-run'; candidateIds: string[]; outcomes: Array<{ candidateId: string; outcome: string }> }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function resultFrom(receipt: { payload: any; outcome: string }): SubmissionResult { return receipt.payload.result ?? { searchId: receipt.payload.request.searchId, optionId: receipt.payload.request.optionId, outcome: receipt.outcome === 'submitting' ? 'uncertain' : receipt.outcome, candidateIds: receipt.payload.candidateIds, outcomes: receipt.payload.outcomes ?? [] }; }

export class SubmissionService {
  constructor(private readonly deps: { prowlarr: Pick<ProwlarrClient, 'getDownloadClients' | 'grab'>; store: SearchStore; getPolicy: () => SubmissionPolicy; clock?: () => number }) {}
  async listClients(): Promise<SafeDownloadClient[]> {
    return (await this.deps.prowlarr.getDownloadClients()).filter(c => c.enable).map(c => ({ id: c.id, name: safeText(c.name), protocol: c.protocol, categories: c.supportsCategories }));
  }

  async submit(raw: SubmissionRequest, server: SubmissionServerContext = {}): Promise<SubmissionResult> {
    const request = submissionRequestSchema.parse(raw), now = this.deps.clock ?? Date.now;
    const payloadBase = { request, targets: [...(server.targets ?? [])].sort(), fingerprint: server.fingerprint?.() ?? '' };
    const hash = createHash('sha256').update(stable(payloadBase)).digest('hex');
    const previous = this.deps.store.getSubmission(request.idempotencyKey);
    if (previous) return stable((previous.payload as { request?: unknown }).request) === stable(request) ? resultFrom(previous) : { searchId: request.searchId, optionId: request.optionId, outcome: 'conflict', candidateIds: [], outcomes: [] };
    const policy = this.deps.getPolicy();
    const policyFingerprint = stable(policy);
    if ((this.deps.store.getProviderDeadline('prowlarr') ?? 0) > now()) return { searchId: request.searchId, optionId: request.optionId, outcome: 'deferred', candidateIds: [], outcomes: [] };
    if (policy.dryRun) return { searchId: request.searchId, optionId: request.optionId, outcome: 'dry-run', candidateIds: [], outcomes: [] };
    if (policy.enabled === false || server.available?.() === false) return { searchId: request.searchId, optionId: request.optionId, outcome: 'failed', candidateIds: [], outcomes: [] };
    const search = this.deps.store.getSearch(request.searchId);
    const options = (search?.result as any)?.options as Array<any> | undefined;
    const option = search?.status === 'matched' ? options?.find(o => o.optionId === request.optionId) : undefined;
    if (!option) return { searchId: request.searchId, optionId: request.optionId, outcome: 'rejected', candidateIds: [], outcomes: [] };
    const clients = (await this.deps.prowlarr.getDownloadClients()).filter(c => c.enable);
    let kind: string | undefined;
    try { kind = (JSON.parse(search?.prompt ?? '{}') as { context?: { kind?: string } }).context?.kind; } catch { /* malformed stored request cannot select a named client */ }
    const defaultName = kind === 'tv' ? policy.tvClient : kind === 'movie' ? policy.movieClient : '';
    const selectedByName = (request.downloadClientId === undefined && defaultName ? clients.find(c => c.name === defaultName) : undefined);
    const client = request.downloadClientId !== undefined ? clients.find(c => c.id === request.downloadClientId) : selectedByName ?? (clients.length === 1 ? clients[0] : undefined);
    if (!client || (request.downloadClientId !== undefined && !clients.some(c => c.id === request.downloadClientId))) return { searchId: request.searchId, optionId: request.optionId, outcome: 'rejected', candidateIds: [], outcomes: [] };
    const owner = this.deps.store.newOwner(), candidateIds = option.releases.map((r: any) => r.candidateId);
    const data: Array<{ candidateId: string; privateData: { release: Release; physicalKey: string } | undefined }> = candidateIds.map((candidateId: string) => ({ candidateId, privateData: this.deps.store.getCandidate(request.searchId, candidateId, now())?.privateData as { release: Release; physicalKey: string } | undefined }));
    if (data.some(d => !d.privateData)) return { searchId: request.searchId, optionId: request.optionId, outcome: 'rejected', candidateIds: [], outcomes: [] };
    if (data.some(d => d.privateData!.release.protocol !== client.protocol)) return { searchId: request.searchId, optionId: request.optionId, outcome: 'rejected', candidateIds: [], outcomes: [] };
    const payload = { ...payloadBase, hash, candidateIds, physicalReleases: data.map(d => d.privateData!.physicalKey) };
    const reservation = this.deps.store.reserveSubmission({ idempotencyKey: request.idempotencyKey, payload, owner, targets: payloadBase.targets, physicalReleases: data.map(d => d.privateData!.physicalKey), now: now(), graceMs: Math.max(0, policy.queueGraceMinutes) * 60_000 });
    if (reservation.kind === 'replay') return resultFrom(reservation.receipt);
    if (reservation.kind === 'conflict') return { searchId: request.searchId, optionId: request.optionId, outcome: 'conflict', candidateIds, outcomes: [] };
    if (reservation.kind === 'deferred') return { searchId: request.searchId, optionId: request.optionId, outcome: 'deferred', candidateIds, outcomes: [] };
    const outcomes: SubmissionResult['outcomes'] = [], lease = `submission:${request.idempotencyKey}`;
    const resources = [lease, ...payloadBase.targets.map(t => `target:${t}`), ...data.map(d => `physical:${d.privateData!.physicalKey}`)];
    const owns = () => resources.every(resource => this.deps.store.ownsLease(resource, owner, now()));
    for (const entry of data) {
      let valid = false;
      try {
        if (owns() && server.available?.() !== false) {
          valid = server.validate ? await server.validate(entry.privateData!.release, entry.candidateId) : true;
          const currentClients = await this.deps.prowlarr.getDownloadClients();
          valid = valid && currentClients.some(c => c.id === client.id && c.enable && c.protocol === client.protocol);
        }
      } catch { valid = false; }
      // Ownership and settings are rechecked AFTER asynchronous observations, immediately before POST.
      if (!valid || !owns() || server.available?.() === false || stable(this.deps.getPolicy()) !== policyFingerprint || (server.fingerprint && server.fingerprint() !== payloadBase.fingerprint)) {
        outcomes.push({ candidateId: entry.candidateId, outcome: 'failed' }); break;
      }
      try {
        await this.deps.prowlarr.grab(entry.privateData!.release, client.id);
        outcomes.push({ candidateId: entry.candidateId, outcome: 'submitted' });
      } catch (error) {
        const outcome = error instanceof ApiError && (error.status === 400 || error.status === 404) ? 'rejected' : 'uncertain';
        if (error instanceof ApiError && error.retryAfter !== undefined) this.deps.store.setProviderDeadline('prowlarr', now() + error.retryAfter * 1000);
        if (outcome === 'rejected') for (const target of payloadBase.targets) this.deps.store.saveExclusion(target, entry.privateData!.physicalKey, now() + 86_400_000, 'grab-rejected');
        outcomes.push({ candidateId: entry.candidateId, outcome }); break;
      }
    }
    const outcome = outcomes.every(o => o.outcome === 'submitted') ? 'submitted' : outcomes[outcomes.length - 1]?.outcome === 'uncertain' ? 'uncertain' : outcomes[outcomes.length - 1]?.outcome === 'rejected' ? 'rejected' : 'failed';
    const result: SubmissionResult = { searchId: request.searchId, optionId: request.optionId, outcome, candidateIds, outcomes };
    // The receipt contains only safe identifiers/outcomes, never upstream release locators.
    if (this.deps.store.ownsLease(lease, owner, now())) this.deps.store.updateSubmissionResult(request.idempotencyKey, outcome, result, { owner, now: now() });
    for (const resource of resources) this.deps.store.releaseLease(resource, owner);
    return result;
  }
}
