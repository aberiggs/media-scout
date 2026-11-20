import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SearchStatus } from './contracts';

export const LEGACY_DATABASE_ERROR = 'Existing nonempty database is not a search database. Configure a fresh database path; the legacy database was not modified.';
const schema = `
CREATE TABLE IF NOT EXISTS search_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS searches (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT);
CREATE TABLE IF NOT EXISTS search_work (search_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, source TEXT NOT NULL, context_json TEXT NOT NULL, owner TEXT, lease_expires_at INTEGER, started_at INTEGER);
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
CREATE TABLE IF NOT EXISTS automation_attempts (target TEXT PRIMARY KEY, last_attempt INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL DEFAULT 0, grace_until INTEGER NOT NULL DEFAULT 0, physical_key TEXT);
CREATE TABLE IF NOT EXISTS execution_preparations (id TEXT PRIMARY KEY, search_id TEXT NOT NULL, expires_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, search_id TEXT NOT NULL, outcome TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, physical_json TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS execution_holds (physical_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS execution_idempotency (idem_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS search_events_by_search ON search_events(search_id,id);
CREATE INDEX IF NOT EXISTS searches_by_time ON searches(created_at);
CREATE INDEX IF NOT EXISTS candidates_by_expiry ON candidates(expires_at);
CREATE INDEX IF NOT EXISTS submissions_by_search ON submissions(json_extract(payload_json,'$.request.searchId'),created_at);
INSERT INTO search_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM search_meta);
`;
const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;
const hash = (v: unknown): string => json(v);

export interface SearchRecord { searchId: string; prompt: string; status: SearchStatus; createdAt: number; finishedAt?: number; result?: unknown }
export interface SearchWork { searchId: string; prompt: string; source: 'manual' | 'automation' | 'arr'; context: unknown; owner: string }
export interface CandidateRecord { searchId: string; candidateId: string; safe: unknown; privateData: unknown; expiresAt: number }
export interface SubmissionReceipt { idempotencyKey: string; payload: unknown; outcome: string; createdAt: number }
export type BeginSubmission = { kind: 'created' } | { kind: 'replay'; receipt: SubmissionReceipt } | { kind: 'conflict' };
export type Reservation = { kind: 'reserved' } | { kind: 'deferred'; reason: 'target' | 'physical-release' } | { kind: 'replay'; receipt: SubmissionReceipt } | { kind: 'conflict' };
export interface ExecutionChild { candidateId: string; physicalKey: string; state: 'prepared'|'sending'|'submitted'|'rejected'|'uncertain'|'not-attempted'|'dry-run'; effectiveCategory?:string|null; categoryRouting?:'direct'|'configured-mapping'|'default-category'; categoryNote?:string; releaseCategoryIds?:number[]; message?: string }
export interface ExecutionRecord { id:string; key:string; hash:string; searchId:string; planId:string; version:number; outcome:string; owner:string; leaseUntil:number; children:ExecutionChild[]; receipt:unknown; payload:unknown; updatedAt:number }

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
  saveExecutionPreparation(id:string,searchId:string,expiresAt:number,payload:unknown):void { this.db.prepare('INSERT INTO execution_preparations VALUES(?,?,?,?)').run(id,searchId,expiresAt,json(payload)); }
  getExecutionPreparation(id:string):{searchId:string;expiresAt:number;payload:any}|null { const r=this.db.prepare('SELECT * FROM execution_preparations WHERE id=?').get(id) as any; return r?{searchId:r.search_id,expiresAt:r.expires_at,payload:parse(r.payload_json)}:null; }
  createExecution(input:{id:string;key:string;hash:string;searchId:string;planId:string;version:number;payload:any;children:ExecutionChild[];owner:string;now:number;leaseUntil:number}):'created'|'replay'|'busy'|'conflict' {
    return this.db.transaction(() => {
      const prior=this.executionByKey(input.key);
      if(prior) return prior.hash===input.hash?'replay':'conflict';
      if(this.db.prepare('SELECT 1 FROM execution_idempotency WHERE idem_key=?').get(input.key)) return 'conflict';
      const physical=[...new Set(input.children.map(c=>c.physicalKey))];
      if(physical.length!==input.children.length) return 'conflict';
      this.db.prepare('DELETE FROM execution_holds WHERE expires_at<=?').run(input.now);
      if(physical.some(key=>this.db.prepare('SELECT 1 FROM execution_holds WHERE physical_key=?').get(key))) return 'busy';
      const record:ExecutionRecord={id:input.id,key:input.key,hash:input.hash,searchId:input.searchId,planId:input.planId,version:input.version,outcome:'running',owner:input.owner,leaseUntil:input.leaseUntil,children:input.children,receipt:null,payload:input.payload,updatedAt:input.now};
      this.db.prepare('INSERT INTO executions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.id,input.key,input.hash,input.searchId,'running',input.owner,input.leaseUntil,json(physical),json(record),input.now,input.now);
      const confirmationId=(input.payload as {confirmationId?:string}).confirmationId;
      if(confirmationId) this.db.prepare('DELETE FROM execution_preparations WHERE id=?').run(confirmationId);
      const hold=this.db.prepare('INSERT INTO execution_holds VALUES(?,?,?)'); for(const key of physical) hold.run(key,input.id,input.now+3_600_000);
      return 'created';
    }).immediate();
  }
  execution(id:string):ExecutionRecord|null { const r=this.db.prepare('SELECT payload_json FROM executions WHERE id=?').get(id) as {payload_json:string}|undefined; return r?parse(r.payload_json):null; }
  executionByKey(key:string):ExecutionRecord|null { const r=this.db.prepare('SELECT payload_json FROM executions WHERE idem_key=?').get(key) as {payload_json:string}|undefined; return r?parse(r.payload_json):null; }
  executionsForSearch(searchId:string):ExecutionRecord[] { return (this.db.prepare('SELECT payload_json FROM executions WHERE search_id=? ORDER BY created_at,rowid').all(searchId) as Array<{payload_json:string}>).map(r=>parse(r.payload_json)); }
  ownsExecution(id:string,owner:string,now:number):boolean { const row=this.execution(id);return !!row&&row.owner===owner&&row.leaseUntil>now&&row.outcome==='running'; }
  updateExecution(id:string,owner:string,now:number,change:(r:ExecutionRecord)=>ExecutionRecord):boolean { return this.db.transaction(()=>{const prior=this.execution(id); if(!prior || prior.owner!==owner || prior.leaseUntil<=now) return false; const next=change(prior); this.db.prepare('UPDATE executions SET outcome=?,lease_until=?,payload_json=?,updated_at=? WHERE id=?').run(next.outcome,next.leaseUntil,json(next),now,id); return true; }).immediate(); }
  renewExecution(id:string,owner:string,now:number,ttl:number):boolean { return this.db.transaction(()=>{const prior=this.execution(id); if(!prior||prior.owner!==owner||prior.leaseUntil<=now)return false; prior.leaseUntil=now+ttl; prior.updatedAt=now; this.db.prepare('UPDATE executions SET lease_until=?,payload_json=?,updated_at=? WHERE id=?').run(prior.leaseUntil,json(prior),now,id); this.db.prepare('UPDATE execution_holds SET expires_at=? WHERE execution_id=?').run(now+3_600_000,id); return true; }).immediate(); }
  updateExecutionChild(id:string,owner:string,now:number,index:number,state:ExecutionChild['state'],message?:string,grace?:{mediaKey:string;graceUntil:number;passOwner?:string;attempt?:{startedAt:number;targetKeys:string[];failureBackoffMinMs:number;failureBackoffMaxMs:number}}):boolean {
    return this.db.transaction(()=>{
      const prior=this.execution(id), child=prior?.children[index];
      if(!prior||!child||prior.owner!==owner||prior.leaseUntil<=now||prior.outcome!=='running')return false;
      const legal=(child.state==='prepared'&&['sending','not-attempted','dry-run'].includes(state))||(child.state==='sending'&&['submitted','rejected','uncertain'].includes(state));
      if(!legal||(state==='sending'&&grace?.passOwner&&!this.ownsLease('automation-pass',grace.passOwner,now)))return false;
      prior.children[index]={...child,state,...(message?{message}:{})}; prior.updatedAt=now;
      this.db.prepare('UPDATE executions SET payload_json=?,updated_at=? WHERE id=?').run(json(prior),now,id);
      if(['rejected','not-attempted','dry-run'].includes(state)) this.db.prepare('DELETE FROM execution_holds WHERE execution_id=? AND physical_key=?').run(id,child.physicalKey);
      if(state==='submitted'||state==='uncertain') this.db.prepare('UPDATE execution_holds SET expires_at=? WHERE execution_id=? AND physical_key=?').run(now+3_600_000,id,child.physicalKey);
      if(grace&&['sending','submitted','uncertain'].includes(state)) {
        this.db.prepare("INSERT INTO grace VALUES('media',?,?,?) ON CONFLICT(kind,identity) DO UPDATE SET submission_key=excluded.submission_key,expires_at=MAX(grace.expires_at,excluded.expires_at) WHERE grace.submission_key=excluded.submission_key OR grace.expires_at<=?").run(grace.mediaKey,id,grace.graceUntil,now);
        if(grace.attempt) this.db.prepare('UPDATE automation_attempts SET deadline=? WHERE last_attempt=? AND target IN (SELECT value FROM json_each(?))').run(grace.graceUntil,grace.attempt.startedAt,json(grace.attempt.targetKeys));
      }
      if(grace&&state==='rejected'&&!prior.children.some(c=>c.state==='submitted'||c.state==='uncertain')) {
        this.db.prepare("DELETE FROM grace WHERE kind='media' AND submission_key=?").run(id);
        if(grace.attempt) {
          const attempt=grace.attempt;
          this.db.prepare('UPDATE automation_attempts SET fail_count=fail_count+1, deadline=?+MIN(?,?*(1 << MIN(20,fail_count))) WHERE last_attempt=? AND target IN (SELECT value FROM json_each(?))')
            .run(now,attempt.failureBackoffMaxMs,attempt.failureBackoffMinMs,attempt.startedAt,json(attempt.targetKeys));
        }
      }
      return true;
    }).immediate();
  }
  finishExecution(id:string,owner:string,now:number,outcome:string,receipt:unknown):boolean { return this.db.transaction(()=>{const prior=this.execution(id); if(!prior||prior.owner!==owner||prior.leaseUntil<=now)return false; prior.outcome=outcome; prior.receipt=receipt; prior.updatedAt=now; const payload=prior.payload as Record<string,unknown>; delete payload.boundReleases; prior.payload=payload; if(typeof payload.confirmationId==='string')this.db.prepare('DELETE FROM execution_preparations WHERE id=?').run(payload.confirmationId); this.db.prepare('UPDATE executions SET outcome=?,payload_json=?,updated_at=? WHERE id=?').run(outcome,json(prior),now,id); if(typeof payload.automationMediaKey==='string')this.alignAutomationHolds(id,payload.automationMediaKey,now); return true; }).immediate(); }
  private alignAutomationHolds(executionId:string,key:string,now:number):void {
    const grace=this.db.prepare("SELECT expires_at FROM grace WHERE kind='media' AND identity=? AND submission_key=?").get(key,executionId) as {expires_at:number}|undefined;
    this.db.prepare('UPDATE execution_holds SET expires_at=? WHERE execution_id=?').run(grace?.expires_at??now,executionId);
  }
  recoverExecutions(now:number):number {
    return this.db.transaction(()=>{
      const rows=this.db.prepare("SELECT id,payload_json FROM executions WHERE outcome='running' AND lease_until<=?").all(now) as Array<{id:string;payload_json:string}>;
      for(const row of rows) {
        const r=parse<ExecutionRecord>(row.payload_json);
        const uncertain=r.children.some(c=>c.state==='sending'||c.state==='uncertain');
        r.children=r.children.map(c=>c.state==='sending'?{...c,state:'uncertain'}:c.state==='prepared'?{...c,state:'not-attempted'}:c);
        const submitted=r.children.some(c=>c.state==='submitted'), rejected=r.children.some(c=>c.state==='rejected');
        r.outcome=uncertain?'uncertain':r.children.every(c=>c.state==='dry-run')?'dry-run':submitted?(rejected||r.children.some(c=>c.state==='not-attempted')?'partial':'submitted'):rejected?'rejected':'not-attempted';
        r.owner='recovered';r.leaseUntil=now;r.updatedAt=now;
        const payload=r.payload as {boundReleases?:unknown;client?:{id?:number;protocol?:string};clientName?:string;defaultCategory?:string|null;configuredCategories?:unknown;dryRun?:boolean;automationMediaKey?:string};
        delete payload.boundReleases;r.payload=payload;
        if(typeof (payload as {confirmationId?:unknown}).confirmationId==='string') this.db.prepare('DELETE FROM execution_preparations WHERE id=?').run((payload as {confirmationId:string}).confirmationId);
        r.receipt={executionId:r.id,searchId:r.searchId,planId:r.planId,version:r.version,outcome:r.outcome,updatedAt:new Date(now).toISOString(),...(payload.client?{client:{id:payload.client.id,name:payload.clientName??'Download client',protocol:payload.client.protocol,defaultCategory:payload.defaultCategory??null,configuredCategories:payload.configuredCategories}}:{}),dryRun:payload.dryRun??true,children:r.children.map(c=>({candidateId:c.candidateId,outcome:c.state,...(c.effectiveCategory!==undefined?{effectiveCategory:c.effectiveCategory}:{}),...(c.categoryRouting?{categoryRouting:c.categoryRouting}:{}),...(c.categoryNote?{categoryNote:c.categoryNote}:{}),...(c.releaseCategoryIds?{releaseCategoryIds:c.releaseCategoryIds}:{})}))};
        this.db.prepare('UPDATE executions SET outcome=?,owner=?,lease_until=?,payload_json=?,updated_at=? WHERE id=?').run(r.outcome,r.owner,now,json(r),now,row.id);
        this.db.prepare("DELETE FROM execution_holds WHERE execution_id=? AND physical_key IN (SELECT value FROM json_each(?))").run(row.id,json(r.children.filter(c=>['not-attempted','rejected','dry-run'].includes(c.state)).map(c=>c.physicalKey)));
        if(payload.automationMediaKey) this.alignAutomationHolds(row.id,payload.automationMediaKey,now);
        else this.db.prepare('UPDATE execution_holds SET expires_at=? WHERE execution_id=?').run(now+3_600_000,row.id);
      }
      return rows.length;
    }).immediate();
  }
  close(): void { this.db.close(); }
  migrateLegacySearchWork(now:number): void {
    this.db.transaction(() => {
      const queued=this.db.prepare("SELECT id,prompt FROM searches WHERE status='queued' AND id NOT IN (SELECT search_id FROM search_work) ORDER BY created_at,rowid").all() as Array<{id:string;prompt:string}>;
      const next=Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM search_work').get() as {n:number}).n);
      const insert=this.db.prepare('INSERT INTO search_work(search_id,sequence,source,context_json) VALUES(?,?,?,?)');
      queued.forEach((row,index)=>insert.run(row.id,next+index,this.getSetting(`search-source:${row.id}`)==='automation'?'automation':'manual',json({targetKeys:[]})));
      const legacy=this.db.prepare("SELECT id FROM searches WHERE status='running' AND id NOT IN (SELECT search_id FROM search_work)").all() as Array<{id:string}>;
      for(const row of legacy) {
        this.db.prepare("UPDATE searches SET status='interrupted',finished_at=? WHERE id=?").run(now,row.id);
        this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(row.id,json({type:'error',data:{code:'worker-restarted',message:'Search was interrupted when the worker restarted.'}}),now);
      }
      this.db.prepare("DELETE FROM leases WHERE resource='search-worker'").run();
    }).immediate();
  }
  enqueueSearch(input: { searchId: string; prompt: string; now: number; source?: 'manual' | 'automation' | 'arr'; context?: unknown }): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO searches(id,prompt,status,created_at) VALUES(?,?,'queued',?)").run(input.searchId,input.prompt,input.now);
      this.db.prepare('INSERT INTO search_work(search_id,sequence,source,context_json) VALUES(?,?,?,?)').run(input.searchId, Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM search_work').get() as {n:number}).n), input.source ?? 'manual', json(input.context ?? {}));
      this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(input.searchId,json({type:'queued',data:{source:input.source ?? 'manual'}}),input.now);
      this.setSetting(`search-source:${input.searchId}`, input.source ?? 'manual');
       const bindings = (input.context as {targetBindings?:Array<unknown>}|undefined)?.targetBindings;
       if (bindings?.length) this.setSetting(`search-arr-bindings-v1:${input.searchId}`, bindings);
    }).immediate();
  }
  claimNextSearch(owner: string, now: number, ttl: number, maxActive = 3): SearchWork | null {
    return this.db.transaction((): SearchWork | null => {
      this.recoverExpiredSearchWork(now);
      const active = (this.db.prepare("SELECT COUNT(*) AS n FROM search_work WHERE owner IS NOT NULL AND lease_expires_at>?").get(now) as {n:number}).n;
      if (active >= maxActive) return null;
       const row = this.db.prepare("SELECT w.search_id,w.source,w.context_json,s.prompt FROM search_work w JOIN searches s ON s.id=w.search_id WHERE s.status='queued' AND w.owner IS NULL AND w.source!='automation' ORDER BY CASE w.source WHEN 'manual' THEN 0 ELSE 1 END,w.sequence LIMIT 1").get() as {search_id:string;source:'manual'|'automation'|'arr';context_json:string;prompt:string}|undefined;
      if (!row) return null;
      const changed = this.db.prepare("UPDATE searches SET status='running' WHERE id=? AND status='queued'").run(row.search_id).changes;
      if (!changed) return null;
      this.db.prepare('UPDATE search_work SET owner=?,lease_expires_at=?,started_at=? WHERE search_id=? AND owner IS NULL').run(owner,now+ttl,now,row.search_id);
      this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(row.search_id,json({type:'started',data:{source:row.source}}),now);
      return {searchId:row.search_id,prompt:row.prompt,source:row.source,context:parse(row.context_json),owner};
  }).immediate();
  }
  claimAutomationSearchById(searchId:string,owner:string,now:number,ttl:number,maxActive=3):SearchWork|null {
    return this.db.transaction(():SearchWork|null=>{
      this.recoverExpiredSearchWork(now);
      if((this.db.prepare("SELECT COUNT(*) AS n FROM search_work WHERE owner IS NOT NULL AND lease_expires_at>?").get(now) as {n:number}).n>=maxActive)return null;
      const row=this.db.prepare("SELECT w.source,w.context_json,s.prompt FROM search_work w JOIN searches s ON s.id=w.search_id WHERE w.search_id=? AND w.source='automation' AND s.status='queued' AND w.owner IS NULL").get(searchId) as {source:'automation';context_json:string;prompt:string}|undefined;
      if(!row)return null;
      if(this.db.prepare("UPDATE searches SET status='running' WHERE id=? AND status='queued'").run(searchId).changes!==1)return null;
      this.db.prepare('UPDATE search_work SET owner=?,lease_expires_at=?,started_at=? WHERE search_id=? AND owner IS NULL').run(owner,now+ttl,now,searchId);
      this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(searchId,json({type:'started',data:{source:'automation'}}),now);
      return {searchId,prompt:row.prompt,source:'automation',context:parse(row.context_json),owner};
  }).immediate();
  }
  interruptAutomationSearch(searchId:string,at:number):void { this.db.transaction(()=>{const changed=this.db.prepare("UPDATE searches SET status='interrupted',finished_at=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM search_work WHERE search_id=? AND source='automation')").run(at,searchId,searchId).changes;if(changed)this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(searchId,json({type:'error',data:{code:'automation-deferred',message:'Automation search was not started because capacity was unavailable.'}}),at);}).immediate(); }
  queuePosition(searchId: string): number | null {
    const row = this.db.prepare("SELECT sequence,source FROM search_work WHERE search_id=? AND owner IS NULL AND (SELECT status FROM searches WHERE id=search_id)='queued'").get(searchId) as {sequence:number;source:'manual'|'automation'|'arr'}|undefined;
    return row ? (this.db.prepare("SELECT COUNT(*) AS n FROM search_work w JOIN searches s ON s.id=w.search_id WHERE s.status='queued' AND (CASE w.source WHEN 'manual' THEN 0 ELSE 1 END < CASE ? WHEN 'manual' THEN 0 ELSE 1 END OR (w.source=? AND w.sequence<=?))").get(row.source,row.source,row.sequence) as {n:number}).n : null;
  }
  activeSearchCount(now:number): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM search_work WHERE owner IS NOT NULL AND lease_expires_at>?').get(now) as {n:number}).n; }
  ownsSearch(searchId:string,owner:string,now:number):boolean { return !!this.db.prepare('SELECT 1 FROM search_work WHERE search_id=? AND owner=? AND lease_expires_at>?').get(searchId,owner,now); }
  renewSearchWork(searchId:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('UPDATE search_work SET lease_expires_at=? WHERE search_id=? AND owner=? AND lease_expires_at>?').run(now+ttl,searchId,owner,now).changes===1; }
  renewLease(resource:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('UPDATE leases SET expires_at=? WHERE resource=? AND owner=? AND expires_at>?').run(now+ttl,resource,owner,now).changes===1; }
  recoverExpiredSearchWork(now:number):number {
    return this.db.transaction(() => {
      const expired=this.db.prepare("SELECT s.id FROM searches s JOIN search_work w ON w.search_id=s.id WHERE s.status='running' AND w.lease_expires_at<=?").all(now) as Array<{id:string}>;
      for(const {id} of expired) {
        const message='Search was interrupted after its worker ownership lease expired.';
        const result={searchId:id,status:'interrupted',message,options:[],candidates:[],counts:{decisions:0,searches:0,candidates:0},events:[{type:'error',data:{code:'worker-lease-expired',message}}],promptVersion:'search-first-1'};
        this.db.prepare("UPDATE searches SET status='interrupted',finished_at=?,result_json=? WHERE id=? AND status='running'").run(now,json(result),id);
        this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(id,json({type:'error',data:{code:'worker-lease-expired',message}}),now);
      }
      this.db.prepare('UPDATE search_work SET owner=NULL,lease_expires_at=NULL WHERE lease_expires_at<=?').run(now);
      return expired.length;
    }).immediate();
  }
  searchWorkOwner(searchId:string):string|null { return (this.db.prepare('SELECT owner FROM search_work WHERE search_id=?').get(searchId) as {owner:string|null}|undefined)?.owner ?? null; }
  finishOwnedSearch(searchId:string,owner:string,status:SearchStatus,result:unknown,at:number):boolean {
    return this.db.transaction(() => {
      const changed=this.db.prepare("UPDATE searches SET status=?,finished_at=?,result_json=? WHERE id=? AND status='running' AND EXISTS (SELECT 1 FROM search_work WHERE search_id=? AND owner=? AND lease_expires_at>?)").run(status,at,json(result),searchId,searchId,owner,at).changes;
      if (changed) this.db.prepare('UPDATE search_work SET owner=NULL,lease_expires_at=NULL WHERE search_id=? AND owner=?').run(searchId,owner);
      return changed===1;
    }).immediate();
  }
  createSearch(r: SearchRecord): void { this.db.prepare('INSERT INTO searches(id,prompt,status,created_at,finished_at,result_json) VALUES(?,?,?,?,?,?)').run(r.searchId,r.prompt,r.status,r.createdAt,r.finishedAt ?? null,r.result === undefined ? null : json(r.result)); }
  getSearch(id: string): SearchRecord | null { const r = this.db.prepare('SELECT * FROM searches WHERE id=?').get(id) as {id:string;prompt:string;status:SearchStatus;created_at:number;finished_at:number|null;result_json:string|null}|undefined; return r ? {searchId:r.id,prompt:r.prompt,status:r.status,createdAt:r.created_at,...(r.finished_at === null ? {} : {finishedAt:r.finished_at}),...(r.result_json === null ? {} : {result:parse(r.result_json)})} : null; }
  searchWorkContext(id:string):unknown { const row=this.db.prepare('SELECT context_json FROM search_work WHERE search_id=?').get(id) as {context_json:string}|undefined;return row?parse(row.context_json):undefined; }
  listSearches(limit=100, full=true): SearchRecord[] {
    if (full) return (this.db.prepare('SELECT id FROM searches ORDER BY created_at DESC LIMIT ?').all(Math.max(0,limit)) as Array<{id:string}>).map(r=>this.getSearch(r.id)!).filter(Boolean);
    const rows = this.db.prepare("SELECT id,prompt,status,created_at,finished_at,json_extract(result_json,'$.counts') AS counts FROM searches ORDER BY created_at DESC LIMIT ?").all(Math.max(0,limit)) as Array<{id:string;prompt:string;status:SearchStatus;created_at:number;finished_at:number|null;counts:string|null}>;
    return rows.map(r => ({searchId:r.id,prompt:r.prompt,status:r.status,createdAt:r.created_at,...(r.finished_at===null?{}:{finishedAt:r.finished_at}),...(r.counts?{result:{counts:parse(r.counts)}}:{})}));
  }
  setRunning(id:string):void { this.db.prepare("UPDATE searches SET status='running' WHERE id=?").run(id); }
  interruptRunning(at=Date.now()):number { return this.db.prepare("UPDATE searches SET status='interrupted',finished_at=? WHERE status IN ('queued','running')").run(at).changes; }
  interruptQueuedAutomation(at:number):number { return this.db.transaction(()=>{const rows=this.db.prepare("SELECT search_id FROM search_work WHERE source='automation' AND owner IS NULL AND (SELECT status FROM searches WHERE id=search_id)='queued'").all() as Array<{search_id:string}>;for(const {search_id} of rows){this.db.prepare("UPDATE searches SET status='interrupted',finished_at=? WHERE id=? AND status='queued'").run(at,search_id);this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(search_id,json({type:'error',data:{code:'automation-recovery',message:'Scheduled automation work was not replayed after restart.'}}),at);}return rows.length;}).immediate(); }
  interruptSearch(id: string, at: number): void { this.db.prepare("UPDATE searches SET status='interrupted',finished_at=? WHERE id=? AND status IN ('queued','running')").run(at,id); }
  activeSearches(): SearchRecord[] { return (this.db.prepare("SELECT id FROM searches WHERE status IN ('queued','running')").all() as Array<{id:string}>).map(row => this.getSearch(row.id)!); }
  finishSearch(id:string,status:SearchStatus,result:unknown,at:number):void { this.db.prepare('UPDATE searches SET status=?,finished_at=?,result_json=? WHERE id=?').run(status,at,json(result),id); }
  addCandidate(c:CandidateRecord):void { this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(c.searchId,c.candidateId,json(c.safe),json(c.privateData),c.expiresAt); }
  updateCandidate(c:CandidateRecord):void { this.db.prepare('UPDATE candidates SET safe_json=?,private_json=?,expires_at=? WHERE search_id=? AND id=?').run(json(c.safe),json(c.privateData),c.expiresAt,c.searchId,c.candidateId); }
  getCandidate(searchId:string,id:string,now=Date.now()): Omit<CandidateRecord,'searchId'|'candidateId'>|null { const r=this.db.prepare('SELECT safe_json,private_json,expires_at FROM candidates WHERE search_id=? AND id=? AND expires_at>?').get(searchId,id,now) as {safe_json:string;private_json:string;expires_at:number}|undefined; return r?{safe:parse(r.safe_json),privateData:parse(r.private_json),expiresAt:r.expires_at}:null; }
  candidateExpiry(searchId: string, id: string): number | null { return (this.db.prepare('SELECT expires_at FROM candidates WHERE search_id=? AND id=?').get(searchId,id) as {expires_at:number}|undefined)?.expires_at ?? null; }
  listCandidates(searchId:string,now=Date.now()):Array<{candidateId:string;safe:unknown;expiresAt:number}> { return (this.db.prepare('SELECT id,safe_json,expires_at FROM candidates WHERE search_id=? AND expires_at>? ORDER BY rowid').all(searchId,now) as Array<{id:string;safe_json:string;expires_at:number}>).map(r=>({candidateId:r.id,safe:parse(r.safe_json),expiresAt:r.expires_at})); }
  appendEvent(searchId:string,event:unknown,at=Date.now()):void { this.db.prepare('INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)').run(searchId,json(event),at); }
  getEvents(searchId:string):unknown[] { return (this.db.prepare('SELECT event_json,created_at FROM search_events WHERE search_id=? ORDER BY id').all(searchId) as Array<{event_json:string;created_at:number}>).map(r=>({...parse<Record<string,unknown>>(r.event_json),recordedAt:r.created_at})); }
  setSetting(key:string,value:unknown):void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,json(value)); }
  getSetting(key:string):unknown|null { const r=this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as {value_json:string}|undefined; return r?parse(r.value_json):null; }
  setDeadline(target:string,deadline:number):void { this.db.prepare('INSERT INTO target_deadlines VALUES(?,?) ON CONFLICT(target) DO UPDATE SET deadline=excluded.deadline').run(target,deadline); }
  getDeadline(target:string):number|null { return (this.db.prepare('SELECT deadline FROM target_deadlines WHERE target=?').get(target) as {deadline:number}|undefined)?.deadline ?? null; }
  migrateLegacySearchDeadlines(now:number,retryMs:number):void {
    this.db.transaction(() => {
      const marker = 'migration:search-only-deadlines-v1';
      if (this.getSetting(marker)) return;
      const rows = this.db.prepare('SELECT * FROM automation_attempts').all() as Array<{target:string;last_attempt:number;fail_count:number;deadline:number;grace_until:number}>;
      const updateAttempt = this.db.prepare('UPDATE automation_attempts SET deadline=? WHERE target=?');
      const updateDeadline = this.db.prepare('UPDATE target_deadlines SET deadline=? WHERE target=?');
      const bindings = this.db.prepare("SELECT key,value_json FROM settings WHERE key LIKE 'search-arr:%'").all() as Array<{key:string;value_json:string}>;
      for (const row of rows) {
        const mirrored = this.getDeadline(row.target);
        if (row.fail_count !== 0 || row.grace_until > 0 || row.deadline <= now || mirrored !== row.deadline ||
          this.hasLiveLease(`target:${row.target}`, now)) continue;
        const hasSearchOnlyOutcome = bindings.some(binding => {
          try {
            if ((parse<Record<string, unknown>>(binding.value_json)).key !== row.target) return false;
            const searchId = binding.key.slice('search-arr:'.length);
            if (this.getSetting(`search-source:${searchId}`) !== 'automation') return false;
            const search = this.db.prepare('SELECT status,created_at FROM searches WHERE id=?').get(searchId) as {status:string;created_at:number}|undefined;
            return !!search && search.created_at >= row.last_attempt - 60_000 && ['matched','no-match','needs-input'].includes(search.status);
          } catch { return false; }
        });
        if (!hasSearchOnlyOutcome) continue;
        const hasReceipt = this.db.prepare("SELECT 1 FROM submissions WHERE outcome IN ('submitted','uncertain','submitting') AND EXISTS (SELECT 1 FROM json_each(submissions.payload_json,'$.targets') WHERE value=?) LIMIT 1").get(row.target);
        if (hasReceipt) continue;
        const shortened = Math.min(row.deadline, row.last_attempt + retryMs);
        updateAttempt.run(shortened, row.target);
        updateDeadline.run(shortened, row.target);
      }
      this.setSetting(marker, { completedAt: now });
    })();
  }
  setProviderDeadline(provider:string,deadline:number):void { this.db.prepare('INSERT INTO provider_deadlines VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET deadline=MAX(deadline,excluded.deadline)').run(provider,deadline); }
  getProviderDeadline(provider:string):number|null { return (this.db.prepare('SELECT deadline FROM provider_deadlines WHERE provider=?').get(provider) as {deadline:number}|undefined)?.deadline ?? null; }
  getGrace(kind: 'target' | 'release' | 'media', identity: string, now: number): number | null { return (this.db.prepare('SELECT expires_at FROM grace WHERE kind=? AND identity=? AND expires_at>?').get(kind, identity, now) as { expires_at: number } | undefined)?.expires_at ?? null; }
  activeMediaGrace(now:number):Set<string> { return new Set((this.db.prepare("SELECT identity FROM grace WHERE kind='media' AND expires_at>?").all(now) as Array<{identity:string}>).map(row=>row.identity)); }
  clearGraceForSubmission(key: string): void { this.db.prepare('DELETE FROM grace WHERE submission_key=?').run(key); }
  listSubmissions(): SubmissionReceipt[] { return (this.db.prepare('SELECT key FROM submissions ORDER BY created_at DESC').all() as Array<{ key: string }>).map(row => this.getSubmission(row.key)!); }
  acquireLease(resource:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=? OR leases.owner=excluded.owner').run(resource,owner,now+ttl,now).changes===1; }
  ownsLease(resource: string, owner: string, now: number): boolean { return !!this.db.prepare('SELECT 1 FROM leases WHERE resource=? AND owner=? AND expires_at>?').get(resource, owner, now); }
  hasLiveLease(resource: string, now: number): boolean { return !!this.db.prepare('SELECT 1 FROM leases WHERE resource=? AND expires_at>?').get(resource, now); }
  releaseLease(resource: string, owner: string): void { this.db.prepare('DELETE FROM leases WHERE resource=? AND owner=?').run(resource, owner); }
  expireCandidatesAt(searchId: string, expiresAt: number): void { this.db.prepare('UPDATE candidates SET expires_at=? WHERE search_id=?').run(expiresAt, searchId); }
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
  latestSubmission(searchId: string): SubmissionReceipt | null { const row = this.db.prepare("SELECT key FROM submissions WHERE json_extract(payload_json,'$.request.searchId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(searchId) as {key:string}|undefined; return row ? this.getSubmission(row.key) : null; }
  submissionsForSearch(searchId:string):SubmissionReceipt[] { const rows=this.db.prepare("SELECT key FROM submissions WHERE json_extract(payload_json,'$.request.searchId')=? ORDER BY created_at DESC,rowid DESC").all(searchId) as Array<{key:string}>;return rows.map(row=>this.getSubmission(row.key)!).filter(Boolean); }
  updateSubmissionOutcome(key:string,outcome:string):void { this.db.prepare('UPDATE submissions SET outcome=? WHERE key=?').run(outcome,key); }
  updateSubmissionResult(key:string,outcome:string,result:unknown, claim?: { owner: string; now: number }):void { this.db.transaction(()=>{ if(claim && !this.ownsLease(`submission:${key}`,claim.owner,claim.now)) throw new Error('stale lease owner'); const prior=this.getSubmission(key); if(!prior) throw new Error('submission receipt missing'); const payload={...(prior.payload as Record<string,unknown>),result}; this.db.prepare('UPDATE submissions SET outcome=?,payload_json=? WHERE key=?').run(outcome,json(payload),key); })(); }
  reserveSubmission(input:{idempotencyKey:string;payload:unknown;owner:string;targets:string[];physicalReleases:string[];now:number;graceMs:number}):Reservation {
    return this.db.transaction(():Reservation=>{
      const prior=this.getSubmission(input.idempotencyKey); if(prior) {
        const stored = this.db.prepare('SELECT payload_hash FROM submissions WHERE key=?').get(input.idempotencyKey) as { payload_hash: string };
        return stored.payload_hash===hash(input.payload)?{kind:'replay',receipt:prior}:{kind:'conflict'};
      }
      this.db.prepare('DELETE FROM grace WHERE expires_at<=?').run(input.now);
      if(input.targets.some(id=>this.db.prepare('SELECT 1 FROM grace WHERE kind=? AND identity=? AND expires_at>?').get('target',id,input.now))) return {kind:'deferred',reason:'target'};
      if(input.physicalReleases.some(id=>this.db.prepare('SELECT 1 FROM grace WHERE kind=? AND identity=? AND expires_at>?').get('release',id,input.now))) return {kind:'deferred',reason:'physical-release'};
      const resources = [`submission:${input.idempotencyKey}`, ...input.targets.map(t => `target:${t}`), ...input.physicalReleases.map(r => `physical:${r}`)];
      for (const resource of resources) {
        if (this.hasLiveLease(resource, input.now) && !this.ownsLease(resource, input.owner, input.now)) return {kind:'deferred',reason:resource.startsWith('physical:')?'physical-release':'target'};
      }
      for (const resource of resources) this.acquireLease(resource, input.owner, input.now,15*60_000);
      this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?)').run(input.idempotencyKey,hash(input.payload),json(input.payload),'submitting',input.now);
      const add=this.db.prepare('INSERT INTO grace VALUES(?,?,?,?)'); for(const id of input.targets)add.run('target',id,input.idempotencyKey,input.now+input.graceMs); for(const id of input.physicalReleases)add.run('release',id,input.idempotencyKey,input.now+input.graceMs);
      return {kind:'reserved'};
    })();
  }
  pruneSearches(before:number,limit:number):number { return this.db.transaction(()=>{ const ids=(this.db.prepare('SELECT id FROM searches WHERE created_at<? ORDER BY created_at ASC LIMIT ?').all(before,Math.max(0,limit)) as Array<{id:string}>).map(r=>r.id); const del=this.db.prepare('DELETE FROM searches WHERE id=?'); const cd=this.db.prepare('DELETE FROM candidates WHERE search_id=?'); const ed=this.db.prepare('DELETE FROM search_events WHERE search_id=?'); const wd=this.db.prepare('DELETE FROM search_work WHERE search_id=?'); for(const id of ids){cd.run(id);ed.run(id);wd.run(id);del.run(id);} return ids.length; })(); }
  maintain(now: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM grace WHERE kind='media' AND expires_at<=?").run(now);
      this.db.prepare('DELETE FROM execution_preparations WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM execution_holds WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM execution_idempotency WHERE expires_at<=?').run(now);
      const oldExecutions=this.db.prepare("SELECT id,idem_key,payload_hash FROM executions WHERE outcome!='running' ORDER BY created_at DESC,rowid DESC").all() as Array<{id:string;idem_key:string;payload_hash:string}>;
      const prunable=oldExecutions.slice(10_000);
      const archiveKey=this.db.prepare('INSERT OR REPLACE INTO execution_idempotency VALUES(?,?,?)');
      const deleteHolds=this.db.prepare('DELETE FROM execution_holds WHERE execution_id=?');
      const deleteExecution=this.db.prepare('DELETE FROM executions WHERE id=?');
      for(const row of prunable){archiveKey.run(row.idem_key,row.payload_hash,now+30*86_400_000);deleteHolds.run(row.id);deleteExecution.run(row.id);}
      const expiredExecutions=this.db.prepare("SELECT id,idem_key,payload_hash FROM executions WHERE outcome!='running' AND created_at<?").all(now-30*86_400_000) as Array<{id:string;idem_key:string;payload_hash:string}>;
      for(const row of expiredExecutions){archiveKey.run(row.idem_key,row.payload_hash,now+30*86_400_000);deleteHolds.run(row.id);deleteExecution.run(row.id);}
      this.db.prepare('DELETE FROM candidates WHERE expires_at<=?').run(now);
         const records = this.db.prepare("SELECT id,created_at FROM searches WHERE status NOT IN ('queued','running') ORDER BY created_at DESC,rowid DESC").all() as Array<{id:string;created_at:number}>;
      const remove = records.filter((row, index) => index >= 10_000 || row.created_at < now - 30 * 86_400_000);
      for (const row of remove) {
        this.db.prepare('DELETE FROM candidates WHERE search_id=?').run(row.id);
        this.db.prepare('DELETE FROM search_events WHERE search_id=?').run(row.id);
        this.db.prepare('DELETE FROM search_work WHERE search_id=?').run(row.id);
        this.db.prepare('DELETE FROM searches WHERE id=?').run(row.id);
         for (const prefix of ['search-source:', 'search-owner:', 'search-arr:', 'search-arr-bindings-v1:']) this.db.prepare('DELETE FROM settings WHERE key=?').run(`${prefix}${row.id}`);
      }
    })();
  }
  saveExclusion(target:string,release:string,expiresAt:number,reason:string):void { this.db.prepare('INSERT INTO exclusions VALUES(?,?,?,?) ON CONFLICT(target,release) DO UPDATE SET expires_at=excluded.expires_at,reason=excluded.reason').run(target,release,expiresAt,reason); }
  isExcluded(target:string,release:string,now:number):boolean { return !!this.db.prepare('SELECT 1 FROM exclusions WHERE target=? AND release=? AND expires_at>?').get(target,release,now); }
  getAutomationAttempt(target:string):{lastAttempt:number;failCount:number;deadline:number;graceUntil:number;physicalKey:string|null}|null { const r=this.db.prepare('SELECT * FROM automation_attempts WHERE target=?').get(target) as {last_attempt:number;fail_count:number;deadline:number;grace_until:number;physical_key:string|null}|undefined; return r?{lastAttempt:r.last_attempt,failCount:r.fail_count,deadline:r.deadline,graceUntil:r.grace_until,physicalKey:r.physical_key}:null; }
  setAutomationAttempt(target:string,value:{lastAttempt:number;failCount:number;deadline:number;graceUntil:number;physicalKey?:string|null}):void { this.db.prepare('INSERT INTO automation_attempts VALUES(?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET last_attempt=excluded.last_attempt,fail_count=excluded.fail_count,deadline=excluded.deadline,grace_until=excluded.grace_until,physical_key=excluded.physical_key').run(target,value.lastAttempt,value.failCount,value.deadline,value.graceUntil,value.physicalKey??null); }
  deleteAutomationAttempt(target:string):void { this.db.prepare('DELETE FROM automation_attempts WHERE target=?').run(target); }
  saveObservation(source:string,observation:{observedAt:number;complete:boolean;payload:unknown}):void { this.db.prepare('INSERT INTO observations VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at,complete=excluded.complete,payload_json=excluded.payload_json').run(source,observation.observedAt,+observation.complete,json(observation.payload)); }
  getObservation(source:string):{observedAt:number;complete:boolean;payload:unknown}|null { const r=this.db.prepare('SELECT * FROM observations WHERE source=?').get(source) as any; return r?{observedAt:r.observed_at,complete:!!r.complete,payload:parse(r.payload_json)}:null; }
  newOwner():string { return randomUUID(); }
}
