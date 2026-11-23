import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SearchStatus } from './contracts';
import { defaultSettings, settingsSchema } from './settings';

export const LEGACY_DATABASE_ERROR = 'Unsupported database format. Set DB_PATH to a new file; the existing database was not modified.';
const DATABASE_VERSION = 2;
const schema = `
CREATE TABLE IF NOT EXISTS search_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS searches (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT);
CREATE TABLE IF NOT EXISTS search_work (search_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, source TEXT NOT NULL, context_json TEXT NOT NULL, owner TEXT, lease_expires_at INTEGER, started_at INTEGER);
CREATE TABLE IF NOT EXISTS acquisitions (idem_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, search_id TEXT NOT NULL UNIQUE, client_id INTEGER NOT NULL, source_fingerprint TEXT NOT NULL, dry_run INTEGER NOT NULL, created_at INTEGER NOT NULL, stop_code TEXT, archived_outcome TEXT);
CREATE TABLE IF NOT EXISTS candidates (search_id TEXT NOT NULL, id TEXT NOT NULL, safe_json TEXT NOT NULL, private_json TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(search_id,id));
CREATE TABLE IF NOT EXISTS search_events (id INTEGER PRIMARY KEY, search_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_deadlines (provider TEXT PRIMARY KEY, deadline INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grace (kind TEXT NOT NULL, identity TEXT NOT NULL, submission_key TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(kind,identity));
CREATE TABLE IF NOT EXISTS observations (source TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, complete INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_attempts (target TEXT PRIMARY KEY, last_attempt INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL DEFAULT 0, grace_until INTEGER NOT NULL DEFAULT 0, physical_key TEXT);
CREATE TABLE IF NOT EXISTS execution_preparations (id TEXT PRIMARY KEY, search_id TEXT NOT NULL, expires_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, search_id TEXT NOT NULL, outcome TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, physical_json TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS execution_holds (physical_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS execution_idempotency (idem_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS search_events_by_search ON search_events(search_id,id);
CREATE INDEX IF NOT EXISTS searches_by_time ON searches(created_at);
CREATE INDEX IF NOT EXISTS candidates_by_expiry ON candidates(expires_at);
INSERT INTO search_meta(version) SELECT ${DATABASE_VERSION} WHERE NOT EXISTS (SELECT 1 FROM search_meta);
`;
const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;

export interface SearchRecord { searchId: string; prompt: string; status: SearchStatus; createdAt: number; finishedAt?: number; result?: unknown }
export interface SearchWork { searchId: string; prompt: string; source: 'manual' | 'automation' | 'arr'|'acquisition'; context: unknown; owner: string }
export interface CandidateRecord { searchId: string; candidateId: string; safe: unknown; privateData: unknown; expiresAt: number }
export interface ExecutionChild { candidateId: string; physicalKey: string; state: 'prepared'|'sending'|'submitted'|'rejected'|'uncertain'|'not-attempted'|'dry-run'; effectiveCategory?:string|null; categoryRouting?:'direct'|'configured-mapping'|'default-category'; categoryNote?:string; releaseCategoryIds?:number[]; message?: string }
export interface ExecutionRecord { id:string; key:string; hash:string; searchId:string; planId:string; version:number; outcome:string; owner:string; leaseUntil:number; children:ExecutionChild[]; receipt:unknown; payload:unknown; updatedAt:number }
type AutomationGrace = { mediaKey:string; graceUntil:number; passOwner?:string; attempt?:{startedAt:number;targetKeys:string[];failureBackoffMinMs:number;failureBackoffMaxMs:number} };
type AutomationSendUndo = {
  mediaKey:string; priorGraceUntil:number|undefined; provisionalUntil:number;
  attempts?: {startedAt:number; deadlines:Array<{target:string;deadline:number}>};
};

export function openSearchStore(path: string): SearchStore {
  if (path !== ':memory:' && existsSync(path)) {
    const probe = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>).map(r => r.name);
      if (names.length) {
        if (!names.includes('search_meta')) throw new Error(LEGACY_DATABASE_ERROR);
        const versions = probe.prepare('SELECT version FROM search_meta').all() as Array<{version: unknown}>;
        if (versions.length !== 1 || versions[0]?.version !== DATABASE_VERSION) throw new Error(LEGACY_DATABASE_ERROR);
      }
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
  acceptAcquisition(input:{key:string;hash:string;now:number;snapshot:()=>{prompt:string;clientId:number;sourceFingerprint:string;dryRun:boolean}}):{status:'created'|'replay'|'conflict';searchId:string} {
    return this.db.transaction(()=>{
      const prior=this.db.prepare('SELECT payload_hash,search_id FROM acquisitions WHERE idem_key=?').get(input.key) as {payload_hash:string;search_id:string}|undefined;
      if(prior)return {status:prior.payload_hash===input.hash?'replay' as const:'conflict' as const,searchId:prior.search_id};
      const snapshot=input.snapshot(),searchId=randomUUID();
      this.enqueueSearchInTransaction({searchId,prompt:json({version:3,prompt:snapshot.prompt}),now:input.now,source:'acquisition',context:{}});
      this.db.prepare('INSERT INTO acquisitions(idem_key,payload_hash,search_id,client_id,source_fingerprint,dry_run,created_at) VALUES(?,?,?,?,?,?,?)').run(input.key,input.hash,searchId,snapshot.clientId,snapshot.sourceFingerprint,+snapshot.dryRun,input.now);
      return {status:'created' as const,searchId};
    }).immediate();
  }
  acquisition(searchId:string):{clientId:number;sourceFingerprint:string;dryRun:boolean;stopCode:string|null;archivedOutcome:string|null}|null {
    const r=this.db.prepare('SELECT client_id,source_fingerprint,dry_run,stop_code,archived_outcome FROM acquisitions WHERE search_id=?').get(searchId) as {client_id:number;source_fingerprint:string;dry_run:number;stop_code:string|null;archived_outcome:string|null}|undefined;
    return r?{clientId:r.client_id,sourceFingerprint:r.source_fingerprint,dryRun:!!r.dry_run,stopCode:r.stop_code,archivedOutcome:r.archived_outcome}:null;
  }
  stopAcquisition(searchId:string,code:string,at:number):boolean {
    return this.db.transaction(()=>{
      const changed=this.db.prepare(`UPDATE acquisitions SET stop_code=? WHERE search_id=? AND stop_code IS NULL AND archived_outcome IS NULL
        AND EXISTS(SELECT 1 FROM searches WHERE searches.id=acquisitions.search_id)
        AND NOT EXISTS(SELECT 1 FROM executions WHERE executions.search_id=acquisitions.search_id)`).run(code,searchId).changes;
      if(changed)this.db.prepare('INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)').run(searchId,json({type:'acquisition-stopped',data:{code}}),at);
      return changed===1;
    }).immediate();
  }
  releaseSearch(searchId:string,owner:string):void { this.db.prepare('UPDATE search_work SET owner=NULL,lease_expires_at=NULL WHERE search_id=? AND owner=?').run(searchId,owner); }
  saveExecutionPreparation(id:string,searchId:string,expiresAt:number,payload:unknown):void { this.db.prepare('INSERT INTO execution_preparations VALUES(?,?,?,?)').run(id,searchId,expiresAt,json(payload)); }
  getExecutionPreparation(id:string):{searchId:string;expiresAt:number;payload:any}|null { const r=this.db.prepare('SELECT * FROM execution_preparations WHERE id=?').get(id) as any; return r?{searchId:r.search_id,expiresAt:r.expires_at,payload:parse(r.payload_json)}:null; }
  automationManualBlock(searchId:string,planId:string,version:number,now:number):'automation-pass-active'|'execution-active'|'execution-send-risk'|'plan-changed'|null {
    const search=this.getSearch(searchId), plan=(search?.result as {plan?:{planId?:string;version?:number;status?:string}}|undefined)?.plan;
    const context=this.searchWorkContext(searchId) as {passOwner?:string;manualSendRisk?:string[]}|undefined;
    if(!search || search.status!=='matched' || plan?.status!=='matched' || plan.planId!==planId || plan.version!==version || !context?.passOwner || this.getSetting(`search-source:${searchId}`)!=='automation') return 'plan-changed';
    if(this.ownsLease('automation-pass',context.passOwner,now)) return 'automation-pass-active';
    if(context.manualSendRisk?.includes(JSON.stringify([planId,version]))) return 'execution-send-risk';
    const executions=this.executionsForSearch(searchId);
    if(executions.some(item=>item.outcome==='running')) return 'execution-active';
    const prior=executions.filter(item=>item.planId===planId&&item.version===version);
    if(prior.some(item=>item.children.some(child=>['sending','submitted','uncertain'].includes(child.state)))) return 'execution-send-risk';
    return null;
  }
  createExecution(input:{id:string;key:string;hash:string;searchId:string;planId:string;version:number;payload:any;children:ExecutionChild[];owner:string;now:number;leaseUntil:number;guardAutomationManual?:boolean}, claimTime:()=>number=()=>input.now):'created'|'replay'|'busy'|'conflict'|'confirmation-expired'|'automation-pass-active'|'execution-active'|'execution-send-risk'|'plan-changed' {
    return this.db.transaction(() => {
      const prior=this.executionByKey(input.key);
      if(prior) return prior.hash===input.hash?'replay':'conflict';
      if(this.db.prepare('SELECT 1 FROM execution_idempotency WHERE idem_key=?').get(input.key)) return 'conflict';
      if(input.guardAutomationManual) {
        const blocked=this.automationManualBlock(input.searchId,input.planId,input.version,claimTime());
        if(blocked)return blocked;
      }
      const physical=[...new Set(input.children.map(c=>c.physicalKey))];
      if(physical.length!==input.children.length) return 'conflict';
      this.db.prepare('DELETE FROM execution_holds WHERE expires_at<=?').run(input.now);
      if(physical.some(key=>this.db.prepare('SELECT 1 FROM execution_holds WHERE physical_key=?').get(key))) return 'busy';
      // A preparation can expire during discovery or while waiting for the write lock.
      const confirmationId=(input.payload as {confirmationId?:string}).confirmationId;
      if(confirmationId && this.db.prepare('DELETE FROM execution_preparations WHERE id=? AND search_id=? AND expires_at>?').run(confirmationId,input.searchId,claimTime()).changes!==1)
        return 'confirmation-expired';
      const record:ExecutionRecord={id:input.id,key:input.key,hash:input.hash,searchId:input.searchId,planId:input.planId,version:input.version,outcome:'running',owner:input.owner,leaseUntil:input.leaseUntil,children:input.children,receipt:null,payload:input.payload,updatedAt:input.now};
      this.db.prepare('INSERT INTO executions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.id,input.key,input.hash,input.searchId,'running',input.owner,input.leaseUntil,json(physical),json(record),input.now,input.now);
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
  beginAutomationSend(id:string,owner:string,index:number,clock:()=>number,freshUntil:number,guard:(now:number)=>string|undefined,grace:(now:number)=>AutomationGrace):{started:AutomationSendUndo}|'stale'|'lost'|{blocked:string} {
    return this.db.transaction(()=>{
      const now=clock();
      if(!this.ownsExecution(id,owner,now))return 'lost';
      if(now>freshUntil)return 'stale';
      const blocked=guard(now);
      if(blocked)return {blocked};
      const marker=grace(now);
      const prior = this.db.prepare("SELECT expires_at FROM grace WHERE kind='media' AND identity=? AND submission_key=?").get(marker.mediaKey,id) as {expires_at:number}|undefined;
      const attempt=marker.attempt;
      const deadlines=attempt ? this.db.prepare('SELECT target, deadline FROM automation_attempts WHERE last_attempt=? AND target IN (SELECT value FROM json_each(?))').all(attempt.startedAt,json(attempt.targetKeys)) as Array<{target:string;deadline:number}> : [];
      if(!this.transitionExecutionChild(id,owner,now,index,'sending',undefined,marker))return 'lost';
      return {started:{mediaKey:marker.mediaKey,priorGraceUntil:prior?.expires_at,provisionalUntil:marker.graceUntil,...(attempt?{attempts:{startedAt:attempt.startedAt,deadlines}}:{})}};
    }).immediate();
  }
  /** Only before calling grab; retain the hold. An orphaned sending intent is still uncertain. */
  resetUnsentAutomationChild(id:string,owner:string,index:number,clock:()=>number,undo:AutomationSendUndo):boolean {
    return this.db.transaction(()=>{
      if(!this.transitionExecutionChild(id,owner,clock(),index,'prepared',undefined,undefined,true))return false;
      if(undo.priorGraceUntil===undefined) {
        this.db.prepare("DELETE FROM grace WHERE kind='media' AND identity=? AND submission_key=? AND expires_at=?").run(undo.mediaKey,id,undo.provisionalUntil);
      } else {
        this.db.prepare("UPDATE grace SET expires_at=? WHERE kind='media' AND identity=? AND submission_key=? AND expires_at=?").run(undo.priorGraceUntil,undo.mediaKey,id,Math.max(undo.priorGraceUntil,undo.provisionalUntil));
      }
      if(undo.attempts?.deadlines.length) {
        const restore=this.db.prepare('UPDATE automation_attempts SET deadline=? WHERE target=? AND last_attempt=? AND deadline=?');
        for(const {target,deadline} of undo.attempts.deadlines) restore.run(deadline,target,undo.attempts.startedAt,undo.provisionalUntil);
      }
      return true;
    }).immediate();
  }
  updateExecutionChild(id:string,owner:string,now:number,index:number,state:ExecutionChild['state'],message?:string,grace?:AutomationGrace):boolean {
    return this.db.transaction(()=>this.transitionExecutionChild(id,owner,now,index,state,message,grace)).immediate();
  }
  private transitionExecutionChild(id:string,owner:string,now:number,index:number,state:ExecutionChild['state'],message?:string,grace?:AutomationGrace,resetUnsent=false):boolean {
      const prior=this.execution(id), child=prior?.children[index];
      if(!prior||!child||prior.owner!==owner||prior.leaseUntil<=now||prior.outcome!=='running')return false;
      const legal=resetUnsent ? child.state==='sending' && state==='prepared'
        : (child.state==='prepared'&&['sending','not-attempted','dry-run'].includes(state))||(child.state==='sending'&&['submitted','rejected','uncertain'].includes(state));
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
  enqueueSearch(input: { searchId: string; prompt: string; now: number; source?: 'manual' | 'automation' | 'arr'|'acquisition'; context?: unknown }): void {
    this.db.transaction(() => this.enqueueSearchInTransaction(input)).immediate();
  }
  private enqueueSearchInTransaction(input:{searchId:string;prompt:string;now:number;source?:'manual'|'automation'|'arr'|'acquisition';context?:unknown}):void {
    const source=input.source??'manual';
    this.db.prepare("INSERT INTO searches(id,prompt,status,created_at) VALUES(?,?,'queued',?)").run(input.searchId,input.prompt,input.now);
    this.db.prepare('INSERT INTO search_work(search_id,sequence,source,context_json) VALUES(?,?,?,?)').run(input.searchId,Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM search_work').get() as {n:number}).n),source,json(input.context??{}));
    this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(input.searchId,json({type:'queued',data:{source}}),input.now);
    this.setSetting(`search-source:${input.searchId}`,source);
  }
  claimNextSearch(owner: string, now: number, ttl: number): SearchWork | null {
    return this.db.transaction((): SearchWork | null => {
      this.recoverExpiredSearchWork(now);
      if (this.activeForegroundSearchCount(now) >= this.savedSearchCap()) return null;
       const row = this.db.prepare("SELECT w.search_id,w.source,w.context_json,s.prompt FROM search_work w JOIN searches s ON s.id=w.search_id WHERE s.status='queued' AND w.owner IS NULL AND w.source!='automation' ORDER BY CASE w.source WHEN 'manual' THEN 0 WHEN 'acquisition' THEN 0 ELSE 1 END,w.sequence LIMIT 1").get() as {search_id:string;source:'manual'|'automation'|'arr'|'acquisition';context_json:string;prompt:string}|undefined;
      if (!row) return null;
      const changed = this.db.prepare("UPDATE searches SET status='running' WHERE id=? AND status='queued'").run(row.search_id).changes;
      if (!changed) return null;
      this.db.prepare('UPDATE search_work SET owner=?,lease_expires_at=?,started_at=? WHERE search_id=? AND owner IS NULL').run(owner,now+ttl,now,row.search_id);
      this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(row.search_id,json({type:'started',data:{source:row.source}}),now);
      return {searchId:row.search_id,prompt:row.prompt,source:row.source,context:parse(row.context_json),owner};
  }).immediate();
  }
  claimAutomationSearchById(searchId:string,owner:string,now:number,ttl:number):SearchWork|null {
    return this.db.transaction(():SearchWork|null=>{
      this.recoverExpiredSearchWork(now);
      if(this.activeForegroundSearchCount(now)>=this.savedSearchCap() || this.hasQueuedForeground())return null;
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
    const row = this.db.prepare("SELECT sequence,source FROM search_work WHERE search_id=? AND owner IS NULL AND (SELECT status FROM searches WHERE id=search_id)='queued'").get(searchId) as {sequence:number;source:'manual'|'automation'|'arr'|'acquisition'}|undefined;
     return row ? (this.db.prepare("SELECT COUNT(*) AS n FROM search_work w JOIN searches s ON s.id=w.search_id WHERE s.status='queued' AND (CASE w.source WHEN 'manual' THEN 0 WHEN 'acquisition' THEN 0 ELSE 1 END < CASE ? WHEN 'manual' THEN 0 WHEN 'acquisition' THEN 0 ELSE 1 END OR (CASE w.source WHEN 'manual' THEN 0 WHEN 'acquisition' THEN 0 ELSE 1 END=CASE ? WHEN 'manual' THEN 0 WHEN 'acquisition' THEN 0 ELSE 1 END AND w.sequence<=?))").get(row.source,row.source,row.sequence) as {n:number}).n : null;
  }
  activeForegroundSearchCount(now:number): number { return (this.db.prepare("SELECT COUNT(*) AS n FROM search_work WHERE source!='automation' AND owner IS NOT NULL AND lease_expires_at>?").get(now) as {n:number}).n; }
  private savedSearchCap():number {
    return settingsSchema.parse(this.getSetting('application-settings') ?? defaultSettings).search.concurrentSearches;
  }
  hasQueuedForeground(): boolean { return !!this.db.prepare("SELECT 1 FROM search_work w JOIN searches s ON s.id=w.search_id WHERE w.source IN ('manual','acquisition') AND w.owner IS NULL AND s.status='queued' LIMIT 1").get(); }
  ownsSearch(searchId:string,owner:string,now:number):boolean { return !!this.db.prepare('SELECT 1 FROM search_work WHERE search_id=? AND owner=? AND lease_expires_at>?').get(searchId,owner,now); }
  renewSearchWork(searchId:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('UPDATE search_work SET lease_expires_at=? WHERE search_id=? AND owner=? AND lease_expires_at>?').run(now+ttl,searchId,owner,now).changes===1; }
  renewLease(resource:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('UPDATE leases SET expires_at=? WHERE resource=? AND owner=? AND expires_at>?').run(now+ttl,resource,owner,now).changes===1; }
  recoverExpiredSearchWork(now:number):number {
    return this.db.transaction(() => {
      const expired=this.db.prepare("SELECT s.id FROM searches s JOIN search_work w ON w.search_id=s.id WHERE s.status='running' AND w.lease_expires_at<=?").all(now) as Array<{id:string}>;
      for(const {id} of expired) {
        const message='Search was interrupted after its worker ownership lease expired.';
        const result={version:1,status:'interrupted',message,counts:{decisions:0,searches:0,candidates:0}};
        this.db.prepare("UPDATE searches SET status='interrupted',finished_at=?,result_json=? WHERE id=? AND status='running'").run(now,json(result),id);
        this.db.prepare("INSERT INTO search_events(search_id,event_json,created_at) VALUES(?,?,?)").run(id,json({type:'error',data:{code:'worker-lease-expired',message}}),now);
      }
      this.db.prepare('UPDATE search_work SET owner=NULL,lease_expires_at=NULL WHERE lease_expires_at<=?').run(now);
      return expired.length;
    }).immediate();
  }
  finishOwnedSearch(searchId:string,owner:string,status:SearchStatus,result:unknown,at:number,keepOwner=false):boolean {
    return this.db.transaction(() => {
      const changed=this.db.prepare("UPDATE searches SET status=?,finished_at=?,result_json=? WHERE id=? AND status='running' AND EXISTS (SELECT 1 FROM search_work WHERE search_id=? AND owner=? AND lease_expires_at>?)").run(status,at,json(result),searchId,searchId,owner,at).changes;
      if (changed&&!keepOwner) this.db.prepare('UPDATE search_work SET owner=NULL,lease_expires_at=NULL WHERE search_id=? AND owner=?').run(searchId,owner);
      return changed===1;
    }).immediate();
  }
  createSearch(r: SearchRecord): void { this.db.prepare('INSERT INTO searches(id,prompt,status,created_at,finished_at,result_json) VALUES(?,?,?,?,?,?)').run(r.searchId,r.prompt,r.status,r.createdAt,r.finishedAt ?? null,r.result === undefined ? null : json(r.result)); }
  getSearch(id: string): SearchRecord | null { const r = this.db.prepare('SELECT * FROM searches WHERE id=?').get(id) as {id:string;prompt:string;status:SearchStatus;created_at:number;finished_at:number|null;result_json:string|null}|undefined; return r ? {searchId:r.id,prompt:r.prompt,status:r.status,createdAt:r.created_at,...(r.finished_at === null ? {} : {finishedAt:r.finished_at}),...(r.result_json === null ? {} : {result:parse(r.result_json)})} : null; }
  searchWorkContext(id:string):unknown { const row=this.db.prepare('SELECT context_json FROM search_work WHERE search_id=?').get(id) as {context_json:string}|undefined;return row?parse(row.context_json):undefined; }
  searchWorkLive(id:string,now:number):boolean { return !!this.db.prepare('SELECT 1 FROM search_work WHERE search_id=? AND owner IS NOT NULL AND lease_expires_at>?').get(id,now); }
  listSearches(limit=100, full=true): SearchRecord[] {
    if (full) return (this.db.prepare('SELECT id FROM searches ORDER BY created_at DESC LIMIT ?').all(Math.max(0,limit)) as Array<{id:string}>).map(r=>this.getSearch(r.id)!).filter(Boolean);
    const rows = this.db.prepare(`SELECT id,prompt,status,created_at,finished_at,json_extract(result_json,'$.counts') AS counts
      FROM searches WHERE result_json IS NULL OR (json_extract(result_json,'$.version')=1 AND COALESCE(json_extract(result_json,'$.plan.version'),2)=2)
      ORDER BY created_at DESC LIMIT ?`).all(Math.max(0,limit)) as Array<{id:string;prompt:string;status:SearchStatus;created_at:number;finished_at:number|null;counts:string|null}>;
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
  setProviderDeadline(provider:string,deadline:number):void { this.db.prepare('INSERT INTO provider_deadlines VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET deadline=MAX(deadline,excluded.deadline)').run(provider,deadline); }
  getProviderDeadline(provider:string):number|null { return (this.db.prepare('SELECT deadline FROM provider_deadlines WHERE provider=?').get(provider) as {deadline:number}|undefined)?.deadline ?? null; }
  getMediaGrace(identity: string, now: number): number | null { return (this.db.prepare("SELECT expires_at FROM grace WHERE kind='media' AND identity=? AND expires_at>?").get(identity, now) as { expires_at: number } | undefined)?.expires_at ?? null; }
  activeMediaGrace(now:number):Set<string> { return new Set((this.db.prepare("SELECT identity FROM grace WHERE kind='media' AND expires_at>?").all(now) as Array<{identity:string}>).map(row=>row.identity)); }
  acquireLease(resource:string,owner:string,now:number,ttl:number):boolean { return this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=? OR leases.owner=excluded.owner').run(resource,owner,now+ttl,now).changes===1; }
  ownsLease(resource: string, owner: string, now: number): boolean { return !!this.db.prepare('SELECT 1 FROM leases WHERE resource=? AND owner=? AND expires_at>?').get(resource, owner, now); }
  hasLiveLease(resource: string, now: number): boolean { return !!this.db.prepare('SELECT 1 FROM leases WHERE resource=? AND expires_at>?').get(resource, now); }
  releaseLease(resource: string, owner: string): void { this.db.prepare('DELETE FROM leases WHERE resource=? AND owner=?').run(resource, owner); }
  expireCandidatesAt(searchId: string, expiresAt: number): void { this.db.prepare('UPDATE candidates SET expires_at=? WHERE search_id=?').run(expiresAt, searchId); }
  expireCandidateAt(searchId:string,id:string,expiresAt:number):void { this.db.prepare('UPDATE candidates SET expires_at=MIN(expires_at,?) WHERE search_id=? AND id=?').run(expiresAt,searchId,id); }
  maintain(now: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM grace WHERE kind='media' AND expires_at<=?").run(now);
      this.db.prepare('DELETE FROM execution_preparations WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM execution_holds WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM execution_idempotency WHERE expires_at<=?').run(now);
      const oldExecutions=this.db.prepare("SELECT id,search_id,outcome,idem_key,payload_hash,created_at FROM executions WHERE outcome!='running' ORDER BY created_at DESC,rowid DESC").all() as Array<{id:string;search_id:string;outcome:string;idem_key:string;payload_hash:string;created_at:number}>;
      const archiveKey=this.db.prepare('INSERT OR REPLACE INTO execution_idempotency VALUES(?,?,?)');
      const archiveOutcome=this.db.prepare('UPDATE acquisitions SET archived_outcome=? WHERE search_id=?');
      const deleteHolds=this.db.prepare('DELETE FROM execution_holds WHERE execution_id=?');
      const deleteExecution=this.db.prepare('DELETE FROM executions WHERE id=?');
      for(const [index,row] of oldExecutions.entries()){
        if(index<10_000&&row.created_at>=now-30*86_400_000)continue;
        if(row.idem_key===`!acquisition:${row.search_id}`)archiveOutcome.run(row.outcome,row.search_id);
        const execution=this.execution(row.id);
        if(execution && execution.children.some(child=>['sending','submitted','uncertain'].includes(child.state))) {
          const context=this.searchWorkContext(row.search_id) as Record<string,unknown>|undefined;
          if(context && this.getSetting(`search-source:${row.search_id}`)==='automation') {
            const key=JSON.stringify([execution.planId,execution.version]);
            const risks=Array.isArray(context.manualSendRisk)?context.manualSendRisk.filter((item):item is string=>typeof item==='string'):[];
            if(!risks.includes(key))this.db.prepare('UPDATE search_work SET context_json=? WHERE search_id=?').run(json({...context,manualSendRisk:[...risks,key]}),row.search_id);
          }
        }
        archiveKey.run(row.idem_key,row.payload_hash,now+30*86_400_000);
        deleteHolds.run(row.id);
        deleteExecution.run(row.id);
      }
      this.db.prepare('DELETE FROM candidates WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM acquisitions WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM searches WHERE searches.id=acquisitions.search_id)').run(now-60*86_400_000);
      const records = this.db.prepare(`SELECT s.id, CASE WHEN w.source='acquisition' THEN COALESCE(s.finished_at,s.created_at) ELSE s.created_at END AS retention_at
        FROM searches s LEFT JOIN search_work w ON w.search_id=s.id
        WHERE s.status NOT IN ('queued','running') AND (w.owner IS NULL OR w.lease_expires_at<=?)
        ORDER BY retention_at DESC,s.rowid DESC`).all(now) as Array<{id:string;retention_at:number}>;
      const remove = records.filter((row, index) => index >= 10_000 || row.retention_at < now - 30 * 86_400_000);
      for (const row of remove) {
        this.db.prepare('DELETE FROM candidates WHERE search_id=?').run(row.id);
        this.db.prepare('DELETE FROM search_events WHERE search_id=?').run(row.id);
        this.db.prepare('DELETE FROM search_work WHERE search_id=?').run(row.id);
        this.db.prepare('DELETE FROM searches WHERE id=?').run(row.id);
         for (const prefix of ['search-source:', 'search-arr-bindings-v1:']) this.db.prepare('DELETE FROM settings WHERE key=?').run(`${prefix}${row.id}`);
      }
    })();
  }
  getAutomationAttempt(target:string):{lastAttempt:number;failCount:number;deadline:number;graceUntil:number;physicalKey:string|null}|null { const r=this.db.prepare('SELECT * FROM automation_attempts WHERE target=?').get(target) as {last_attempt:number;fail_count:number;deadline:number;grace_until:number;physical_key:string|null}|undefined; return r?{lastAttempt:r.last_attempt,failCount:r.fail_count,deadline:r.deadline,graceUntil:r.grace_until,physicalKey:r.physical_key}:null; }
  setAutomationAttempt(target:string,value:{lastAttempt:number;failCount:number;deadline:number;graceUntil:number;physicalKey?:string|null}):void { this.db.prepare('INSERT INTO automation_attempts VALUES(?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET last_attempt=excluded.last_attempt,fail_count=excluded.fail_count,deadline=excluded.deadline,grace_until=excluded.grace_until,physical_key=excluded.physical_key').run(target,value.lastAttempt,value.failCount,value.deadline,value.graceUntil,value.physicalKey??null); }
  deleteAutomationAttempt(target:string):void { this.db.prepare('DELETE FROM automation_attempts WHERE target=?').run(target); }
  saveObservation(source:string,observation:{observedAt:number;complete:boolean;payload:unknown}):void { this.db.prepare('INSERT INTO observations VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET observed_at=excluded.observed_at,complete=excluded.complete,payload_json=excluded.payload_json').run(source,observation.observedAt,+observation.complete,json(observation.payload)); }
  getObservation(source:string):{observedAt:number;complete:boolean;payload:unknown}|null { const r=this.db.prepare('SELECT * FROM observations WHERE source=?').get(source) as any; return r?{observedAt:r.observed_at,complete:!!r.complete,payload:parse(r.payload_json)}:null; }
  newOwner():string { return randomUUID(); }
}
