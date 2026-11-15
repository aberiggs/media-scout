import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SearchStatus } from './contracts';

export const LEGACY_DATABASE_ERROR = 'Existing nonempty database is not a search database. Configure a fresh database path; the legacy database was not modified.';
const schema = `
CREATE TABLE IF NOT EXISTS search_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS searches (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT);
CREATE TABLE IF NOT EXISTS candidates (search_id TEXT NOT NULL, id TEXT NOT NULL, safe_json TEXT NOT NULL, private_json TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(search_id,id));
CREATE TABLE IF NOT EXISTS search_events (id INTEGER PRIMARY KEY, search_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS target_deadlines (target TEXT PRIMARY KEY, deadline INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provider_deadlines (provider TEXT PRIMARY KEY, deadline INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grace (kind TEXT NOT NULL, identity TEXT NOT NULL, submission_key TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(kind,identity));
CREATE TABLE IF NOT EXISTS exclusions (target TEXT NOT NULL, release TEXT NOT NULL, expires_at INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(target,release));
CREATE TABLE IF NOT EXISTS observations (source TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, complete INTEGER NOT NULL, payload_json TEXT NOT NULL);
INSERT INTO search_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM search_meta);
`;
const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;
const hash = (v: unknown): string => json(v);

export interface SearchRecord { searchId: string; prompt: string; status: SearchStatus; createdAt: number; finishedAt?: number; result?: unknown }
export interface CandidateRecord { searchId: string; candidateId: string; safe: unknown; privateData: unknown; expiresAt: number }
export interface SubmissionReceipt { idempotencyKey: string; payload: unknown; outcome: string; createdAt: number }
export type BeginSubmission = { kind: 'created' } | { kind: 'replay'; receipt: SubmissionReceipt } | { kind: 'conflict' };
export type Reservation = { kind: 'reserved' } | { kind: 'deferred'; reason: 'target' | 'physical-release' } | { kind: 'replay'; receipt: SubmissionReceipt } | { kind: 'conflict' };

export function openSearchStore(path: string): SearchStore {
  if (path !== ':memory:' && existsSync(path)) {
    const probe = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>).map(r => r.name);
      if (names.length && !names.includes('search_meta')) throw new Error(LEGACY_DATABASE_ERROR);
    } finally { probe.close(); }
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return new SearchStore(db);
}

export class SearchStore {
  constructor(private readonly db: Database.Database) {}
  close(): void { this.db.close(); }
  createSearch(r: SearchRecord): void { this.db.prepare('INSERT INTO searches(id,prompt,status,created_at,finished_at,result_json) VALUES(?,?,?,?,?,?)').run(r.searchId,r.prompt,r.status,r.createdAt,r.finishedAt ?? null,r.result === undefined ? null : json(r.result)); }
  getSearch(id: string): SearchRecord | null { const r = this.db.prepare('SELECT * FROM searches WHERE id=?').get(id) as {id:string;prompt:string;status:SearchStatus;created_at:number;finished_at:number|null;result_json:string|null}|undefined; return r ? {searchId:r.id,prompt:r.prompt,status:r.status,createdAt:r.created_at,...(r.finished_at === null ? {} : {finishedAt:r.finished_at}),...(r.result_json === null ? {} : {result:parse(r.result_json)})} : null; }
  finishSearch(id:string,status:SearchStatus,result:unknown,at:number):void { this.db.prepare('UPDATE searches SET status=?,finished_at=?,result_json=? WHERE id=?').run(status,at,json(result),id); }
  addCandidate(c:CandidateRecord):void { this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(c.searchId,c.candidateId,json(c.safe),json(c.privateData),c.expiresAt); }
  getCandidate(searchId:string,id:string,now=Date.now()): Omit<CandidateRecord,'searchId'|'candidateId'>|null { const r=this.db.prepare('SELECT safe_json,private_json,expires_at FROM candidates WHERE search_id=? AND id=? AND expires_at>?').get(searchId,id,now) as {safe_json:string;private_json:string;expires_at:number}|undefined; return r?{safe:parse(r.safe_json),privateData:parse(r.private_json),expiresAt:r.expires_at}:null; }
  appendEvent(searchId:string,event:unknown,at=Date.now()):void { this.db.prepare('INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)').run(searchId,json(event),at); }
  getEvents(searchId:string):unknown[] { return (this.db.prepare('SELECT event_json FROM search_events WHERE search_id=? ORDER BY id').all(searchId) as Array<{event_json:string}>).map(r=>parse(r.event_json)); }
  setSetting(key:string,value:unknown):void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,json(value)); }
  getSetting(key:string):unknown|null { const r=this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as {value_json:string}|undefined; return r?parse(r.value_json):null; }
  setDeadline(target:string,deadline:number):void { this.db.prepare('INSERT INTO target_deadlines VALUES(?,?) ON CONFLICT(target) DO UPDATE SET deadline=excluded.deadline').run(target,deadline); }
  getDeadline(target:string):number|null { return (this.db.prepare('SELECT deadline FROM target_deadlines WHERE target=?').get(target) as {deadline:number}|undefined)?.deadline ?? null; }
  setProviderDeadline(provider:string,deadline:number):void { this.db.prepare('INSERT INTO provider_deadlines VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET deadline=excluded.deadline').run(provider,deadline); }
  getProviderDeadline(provider:string):number|null { return (this.db.prepare('SELECT deadline FROM provider_deadlines WHERE provider=?').get(provider) as {deadline:number}|undefined)?.deadline ?? null; }
  acquireLease(resource:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=? OR leases.owner=excluded.owner').run(resource,owner,now+ttl,now).changes===1; }
  withLease<T>(resource:string,owner:string,work:()=>T):T { return this.db.transaction(()=>{ const r=this.db.prepare('SELECT owner,expires_at FROM leases WHERE resource=?').get(resource) as {owner:string;expires_at:number}|undefined; if(!r || r.owner!==owner || r.expires_at<=Date.now()) throw new Error('stale lease owner'); return work(); })(); }
  beginSubmission(input:{idempotencyKey:string;payload:unknown;createdAt:number}):BeginSubmission { return this.db.transaction(():BeginSubmission=>{ const r=this.db.prepare('SELECT * FROM submissions WHERE key=?').get(input.idempotencyKey) as any; if(r) return r.payload_hash===hash(input.payload)?{kind:'replay',receipt:{idempotencyKey:r.key,payload:parse(r.payload_json),outcome:r.outcome,createdAt:r.created_at}}:{kind:'conflict'}; this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?)').run(input.idempotencyKey,hash(input.payload),json(input.payload),'submitting',input.createdAt); return {kind:'created'}; })(); }
  recordSubmission(input:{idempotencyKey:string;payload:unknown;outcome:string;createdAt:number}):void {
    this.db.transaction(() => {
      const previous = this.getSubmission(input.idempotencyKey);
      if (previous && hash(previous.payload) !== hash(input.payload)) throw new Error('submission payload conflict');
      this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET outcome=excluded.outcome').run(input.idempotencyKey,hash(input.payload),json(input.payload),input.outcome,input.createdAt);
    })();
  }
  getSubmission(key:string):SubmissionReceipt|null { const r=this.db.prepare('SELECT * FROM submissions WHERE key=?').get(key) as any; return r?{idempotencyKey:r.key,payload:parse(r.payload_json),outcome:r.outcome,createdAt:r.created_at}:null; }
  reserveSubmission(input:{idempotencyKey:string;payload:unknown;owner:string;targets:string[];physicalReleases:string[];now:number;graceMs:number}):Reservation {
    return this.db.transaction(():Reservation=>{
      const prior=this.getSubmission(input.idempotencyKey); if(prior) return hash(prior.payload)===hash(input.payload)?{kind:'replay',receipt:prior}:{kind:'conflict'};
      this.db.prepare('DELETE FROM grace WHERE expires_at<=?').run(input.now);
      if(input.targets.some(id=>this.db.prepare('SELECT 1 FROM grace WHERE kind=? AND identity=? AND expires_at>?').get('target',id,input.now))) return {kind:'deferred',reason:'target'};
      if(input.physicalReleases.some(id=>this.db.prepare('SELECT 1 FROM grace WHERE kind=? AND identity=? AND expires_at>?').get('release',id,input.now))) return {kind:'deferred',reason:'physical-release'};
      if(!this.acquireLease(`submission:${input.idempotencyKey}`,input.owner,input.now,15*60_000)) return {kind:'deferred',reason:'target'};
      this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?)').run(input.idempotencyKey,hash(input.payload),json(input.payload),'submitting',input.now);
      const add=this.db.prepare('INSERT INTO grace VALUES(?,?,?,?)'); for(const id of input.targets)add.run('target',id,input.idempotencyKey,input.now+input.graceMs); for(const id of input.physicalReleases)add.run('release',id,input.idempotencyKey,input.now+input.graceMs);
      return {kind:'reserved'};
    })();
  }
  pruneSearches(before:number,limit:number):number { return this.db.transaction(()=>{ const ids=(this.db.prepare('SELECT id FROM searches WHERE created_at<? ORDER BY created_at ASC LIMIT ?').all(before,Math.max(0,limit)) as Array<{id:string}>).map(r=>r.id); const del=this.db.prepare('DELETE FROM searches WHERE id=?'); const cd=this.db.prepare('DELETE FROM candidates WHERE search_id=?'); const ed=this.db.prepare('DELETE FROM search_events WHERE search_id=?'); for(const id of ids){cd.run(id);ed.run(id);del.run(id);} return ids.length; })(); }
  saveExclusion(target:string,release:string,expiresAt:number,reason:string):void { this.db.prepare('INSERT INTO exclusions VALUES(?,?,?,?) ON CONFLICT(target,release) DO UPDATE SET expires_at=excluded.expires_at,reason=excluded.reason').run(target,release,expiresAt,reason); }
  isExcluded(target:string,release:string,now:number):boolean { return !!this.db.prepare('SELECT 1 FROM exclusions WHERE target=? AND release=? AND expires_at>?').get(target,release,now); }
  saveObservation(source:string,observation:{observedAt:number;complete:boolean;payload:unknown}):void { this.db.prepare('INSERT INTO observations VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at,complete=excluded.complete,payload_json=excluded.payload_json').run(source,observation.observedAt,+observation.complete,json(observation.payload)); }
  getObservation(source:string):{observedAt:number;complete:boolean;payload:unknown}|null { const r=this.db.prepare('SELECT * FROM observations WHERE source=?').get(source) as any; return r?{observedAt:r.observed_at,complete:!!r.complete,payload:parse(r.payload_json)}:null; }
  newOwner():string { return randomUUID(); }
}
