import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient } from '../clients/llm';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { DownloadClient, Release } from '../types/prowlarr';
import type { GeneralConversationRelease, GeneralSearchBudgets, GeneralSearchConversationResponse, GeneralSearchDiagnostics, GeneralSearchProgressEvent } from '../types/general-search';
import type { Settings } from '../settings';
import type { State } from './state';
import { safeReference } from './general-search';
import { ApiError } from '../http';
import { ADAPTATION_SYSTEM, adaptationJsonSchema, adaptationSchema, compileSearchAdaptation, compileSearchPlan, CURATION_SYSTEM, hasMeaningfulClarification, INTERPRETER_PLANNER_SYSTEM, repairPlanningUser, searchPlanJsonSchema, searchPlanSchema, searchSpaceSchema, type SearchPlan } from './search-planning';
import { chooseStopReason, countFilter, createSearchLedger, constraintFingerprint } from './general-search-policy';

type Cached = { public: GeneralConversationRelease; release: Pick<Release, 'guid' | 'indexerId'>; sourceKey: string; legacySourceKey: string; sourceQuery?: string; identityDigest?: string; availabilityFilter?: 'zero-seeders' };
type Plan = SearchPlan;
type FinalizedPool = { candidates: Cached[]; admitted: Cached[]; pending: Cached[]; snapshotReleases: Cached[]; candidateLedger: Cached[] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const curateSchema = z.object({ items:z.array(z.object({releaseId:z.string(),classification:z.enum(['match','possible-match','clearly-unrelated'])}).strict()) }).strict();
const curateJson = {type:'object',properties:{items:{type:'array',items:{type:'object',properties:{releaseId:{type:'string'},classification:{type:'string',enum:['match','possible-match','clearly-unrelated']}},required:['releaseId','classification'],additionalProperties:false}}},required:['items'],additionalProperties:false};

function safeText(value: unknown, settings: Settings, max = 300): string {
  if (typeof value !== 'string') return '';
  let text = value;
  const secrets = [settings.ai.apiKey,settings.integrations.prowlarr.apiKey,settings.integrations.sonarr.apiKey,settings.integrations.radarr.apiKey].filter(x=>x.trim()).sort((a,b)=>b.length-a.length);
  for (const secret of secrets) text = text.replaceAll(secret,'[removed]');
  return text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi,'[removed]').replace(/\bmagnet:\?[^\s"'<>]*/gi,'[removed]').replace(/(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+/gi,'[removed]').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
}
function sanitizeCached(raw:Cached,s:Settings):Cached|null {
  if(!raw||typeof raw!=='object'||!raw.public||typeof raw.public.releaseId!=='string'||typeof raw.public.title!=='string'||!Number.isFinite(Date.parse(raw.public.expiresAt)))return null;
  const protocol=raw.public.protocol;
  if(protocol!=='torrent'&&protocol!=='usenet')return null;
  const classification=raw.public.relevance?.classification;
  const status=raw.public.assessment?.status;
  const version=typeof raw.public.assessment?.constraintVersion==='string'&&/^[a-f\d]{64}$/i.test(raw.public.assessment.constraintVersion)?raw.public.assessment.constraintVersion:'legacy';
  const safeQuery=typeof raw.sourceQuery==='string'&&!hasPrivateReference(raw.sourceQuery,s)?safeText(raw.sourceQuery,s,300):undefined;
  const guid=typeof raw.release?.guid==='string'&&safeReference(raw.release.guid,s)?raw.release.guid:'';
  const indexerId=Number.isInteger(raw.release?.indexerId)?raw.release.indexerId:0;
  const assessment={status:status==='match'||status==='possible-match'||status==='rejected'||status==='unassessed'?status:'unassessed',constraintVersion:version} as NonNullable<GeneralConversationRelease['assessment']>;
  const viabilityReason=raw.public.viability?.reason;
  const viability=raw.public.viability&&typeof viabilityReason==='string'&&['viable','zero-seeders','stale','unsafe','incompatible','unknown'].includes(viabilityReason)?{viable:!!raw.public.viability.viable,reason:viabilityReason as NonNullable<GeneralConversationRelease['viability']>['reason']}:undefined;
  const unavailableReason=['destination-unavailable','source-reference-required','protocol-incompatible','zero-seeders'].includes(String(raw.public.unavailableReason))?String(raw.public.unavailableReason):null;
  return {public:{releaseId:raw.public.releaseId,title:safeText(raw.public.title,s),indexer:safeText(raw.public.indexer,s),size:Number.isFinite(raw.public.size)?raw.public.size:null,seeders:Number.isFinite(raw.public.seeders)?raw.public.seeders:null,leechers:Number.isFinite(raw.public.leechers)?raw.public.leechers:null,age:Number.isFinite(raw.public.age)?raw.public.age:0,protocol,selectable:!!raw.public.selectable&&!!guid,unavailableReason,expiresAt:raw.public.expiresAt,assessment,...(classification==='match'||classification==='possible-match'?{relevance:{classification}}:{}),...(viability?{viability}:{})},release:{guid,indexerId},sourceKey:typeof raw.sourceKey==='string'&&/^[a-f\d]{64}$/i.test(raw.sourceKey)?raw.sourceKey:'',legacySourceKey:typeof raw.legacySourceKey==='string'&&/^[a-f\d]{64}$/i.test(raw.legacySourceKey)?raw.legacySourceKey:'',...(safeQuery?{sourceQuery:safeQuery}:{}),...(typeof raw.identityDigest==='string'&&/^[a-f\d]{64}$/i.test(raw.identityDigest)?{identityDigest:raw.identityDigest}:{}),...(raw.availabilityFilter==='zero-seeders'?{availabilityFilter:'zero-seeders' as const}:{})};
}
function finalizeCandidatePool(pool:Map<string,Cached>,version:string,now:number,hideZeroSeeders:boolean,destinationProtocol:string|null,settings:Settings):FinalizedPool {
  const candidates=[...pool.values()].filter(x=>Date.parse(x.public.expiresAt)>now&&(!x.release.guid||safeReference(x.release.guid,settings)));
  for(const item of candidates){if(hideZeroSeeders&&item.public.protocol==='torrent'&&item.public.seeders===0)item.availabilityFilter='zero-seeders';else if(item.availabilityFilter==='zero-seeders')delete item.availabilityFilter;}
  const current=(x:Cached)=>x.public.assessment?.constraintVersion===version&&(x.public.assessment.status==='match'||x.public.assessment.status==='possible-match');
  const available=(x:Cached)=>!(hideZeroSeeders&&x.public.protocol==='torrent'&&x.public.seeders===0)&&(!destinationProtocol||x.public.protocol===destinationProtocol);
  const admitted=candidates.filter(x=>current(x)&&available(x));
  for(const item of candidates){
    const safe=!!item.release.guid&&safeReference(item.release.guid,settings);
    const compatible=!!destinationProtocol&&destinationProtocol===item.public.protocol;
    item.public.selectable=!!current(item)&&available(item)&&safe&&compatible;
    item.public.unavailableReason=!safe?'source-reference-required':!destinationProtocol?'destination-unavailable':!compatible?'protocol-incompatible':hideZeroSeeders&&item.public.protocol==='torrent'&&item.public.seeders===0?'zero-seeders':null;
  }
  const pending=candidates.filter(x=>!x.public.assessment||x.public.assessment.status==='unassessed'||x.public.assessment.constraintVersion!==version);
  return {candidates,admitted,pending,snapshotReleases:admitted,candidateLedger:candidates.map(x=>x.public.assessment?.status==='rejected'?{...x,release:{...x.release,guid:''}}:x)};
}
function failure(code: string): Error { return Object.assign(new Error(code), { code }); }

export class GeneralSearchConversationService {
  private readonly settings: Settings;
  constructor(private readonly deps: { llm:LLMClient; prowlarr:ProwlarrClient; state:State; getSettings:()=>Settings; runtimeSettings?:Settings; now?:()=>Date }) {
    this.settings = structuredClone(deps.runtimeSettings ?? deps.getSettings());
  }
  private now() { return (this.deps.now ?? (()=>new Date()))(); }
  private runtimeKey(s:Settings) { return hash(JSON.stringify([s.integrations.prowlarr.url,s.integrations.prowlarr.apiKey,s.integrations.prowlarr.generalClient??'',s.ai.baseUrl,s.ai.apiKey,s.ai.model,s.ai.searchSystemPrompt,s.ai.providerOrder,s.ai.allowProviderFallbacks])); }
  private sourceKey(s:Settings,id:number,guid:string) { const u=new URL(s.integrations.prowlarr.url);u.pathname=u.pathname.replace(/\/+$/,'');u.search='';u.hash='';return hash(JSON.stringify([u.toString(),id,guid])); }
  private legacyKey(s:Settings,id:number,guid:string) { return hash(JSON.stringify([s.integrations.prowlarr.url,s.integrations.prowlarr.apiKey,id,guid])); }
  private check(signal?:AbortSignal) { if(signal?.aborted) throw failure('aborted'); if(this.runtimeKey(this.deps.getSettings())!==this.runtimeKey(this.settings)) throw failure('settings-changed'); }
  private emit(callback:((event:GeneralSearchProgressEvent)=>void)|undefined, sequence:{value:number}, event:Record<string,unknown>,runId:string,stageId:string) { callback?.({...event,runId,stageId,sequence:++sequence.value} as unknown as GeneralSearchProgressEvent); }

  async search(raw:unknown,onEvent?:(event:GeneralSearchProgressEvent)=>void,signal?:AbortSignal):Promise<GeneralSearchConversationResponse> {
    const seq={value:-1};
    const ledger=createSearchLedger();
    const runId=randomUUID();let currentStageId='planning:0',planningStage=0;
    const runController=new AbortController();
    const abortRun=(code:'aborted')=>{if(!runController.signal.aborted)runController.abort(failure(code));};
    const abortFromCaller=()=>abortRun('aborted');
    signal?.addEventListener('abort',abortFromCaller,{once:true});if(signal?.aborted)abortFromCaller();
    const runSignal=runController.signal;
    let candidatePool=new Map<string,Cached>();
    let activeSearchSpace:unknown=null;
    let currentStop:GeneralSearchDiagnostics['stopReason']='completed';
    const diagnostics=(complete:boolean,stopReason=currentStop):GeneralSearchDiagnostics=>{
      const version=activeSearchSpace?constraintFingerprint(activeSearchSpace):'';
      const assessed={match:0,possible:0,unrelated:0,unassessed:0};
      for(const item of candidatePool.values()) {const assessment=item.public.assessment;if(!assessment||assessment.constraintVersion!==version||assessment.status==='unassessed')assessed.unassessed++;else if(assessment.status==='match')assessed.match++;else if(assessment.status==='possible-match')assessed.possible++;else assessed.unrelated++;}
      return {complete,stopReason,sourceInventory:'not-reported',ledger:{raw:ledger.raw,added:ledger.added,duplicates:ledger.duplicates,reactivated:ledger.reactivated,reassessed:ledger.reassessed,filtered:{...ledger.filtered},assessed,outcomes:ledger.queries.flatMap(({query,outcome,raw,added})=>outcome==='pending'?[]:[{query,outcome,raw,added}])}};
    };
    try {
      const r=this.validateRequest(raw), s=this.settings; this.check(signal);
      if(!s.integrations.prowlarr.url.trim()||!s.integrations.prowlarr.apiKey.trim()||!s.ai.apiKey.trim()||!s.ai.baseUrl.trim()) throw failure('search-unavailable');
      const budgets=this.budgets(r,s), original=safeText(r.originalQuery,s,500), turns=r.turns as Array<{role:'user'|'assistant';content:string}>;
      const turnContext=turns.map(t=>({role:t.role,content:safeText(t.content,s,500)}));
      try { const source=new URL(s.integrations.prowlarr.url); if(!['http:','https:'].includes(source.protocol)||source.username||source.password)throw new Error(); }
      catch { throw failure('search-unavailable'); }
       let prior:Cached[]=[];let executed:string[]=[];let rejectedKeys:string[]=[];let continuationCount=0;let previousExpiry:string|null=null;let previousSearchSpace:unknown=null;let priorLedger:unknown=null;
      let priorRouting:{clientName:string;clientProtocol:string;clientId:number|null;routingDigest:string}|null=null;
      if(r.previousSearchId) {
        const snapshot=this.deps.state.getGeneralSearchSnapshot(r.previousSearchId);
        if(!snapshot||Date.parse(snapshot.expiresAt)<=this.now().getTime()||typeof r.confirmationToken!=='string'||hash(r.confirmationToken)!==snapshot.tokenDigest) throw failure('search-expired');
        if(snapshot.fingerprint!==this.searchFingerprint(s)||snapshot.clientName!==safeText(s.integrations.prowlarr.generalClient??'',s,100)) throw failure('settings-changed');
          const payload=snapshot.payload as {releases?:Cached[];candidateLedger?:Cached[];queries?:string[];rejectedKeys?:string[];continuationCount?:number;originalDigest?:string;runtimeFingerprint?:string;destinationResolved?:boolean;constraintVersion?:string;searchSpace?:unknown;ledger?:unknown}|null;
         if(!Array.isArray(payload?.releases)||payload.candidateLedger!==undefined&&!Array.isArray(payload.candidateLedger)) throw failure('search-expired');
        if(payload.destinationResolved!==false)priorRouting={clientName:snapshot.clientName,clientProtocol:snapshot.clientProtocol,clientId:snapshot.clientId,routingDigest:snapshot.routingDigest};
        if(payload.originalDigest!==hash(original))throw failure('invalid-request');
         if(payload.runtimeFingerprint!==this.runtimeKey(s))throw failure('settings-changed');
         continuationCount=payload.continuationCount??0;if(continuationCount>=5)throw failure('follow-up-limit');
          previousSearchSpace=payload.searchSpace===undefined?null:assertSearchSpaceSafe(payload.searchSpace,s);
          activeSearchSpace=previousSearchSpace;
         priorLedger=sanitizePriorLedger(payload.ledger,s);
        previousExpiry=snapshot.expiresAt;
          const activeById=new Map(payload.releases.filter(x=>!x.release.guid||safeReference(x.release.guid,s)).map(x=>[x.public.releaseId,x]));
          prior=structuredClone(payload.candidateLedger??payload.releases).filter(x=>!x.release.guid||safeReference(x.release.guid,s)).map(x=>activeById.get(x.public.releaseId)??(x.public.assessment?.status==='rejected'?{...x,release:{...x.release,guid:''}}:x)).map(x=>sanitizeCached(x,s)).filter((x):x is Cached=>!!x&&Date.parse(x.public.expiresAt)>this.now().getTime());
          const legacySnapshot=!payload.candidateLedger||!previousSearchSpace||payload.constraintVersion!==constraintFingerprint(previousSearchSpace);
          prior=prior.map(x=>{const identityDigest=x.identityDigest??(x.release.guid?hash(`${x.release.indexerId}:${x.release.guid}`):undefined);const migrated=legacySnapshot||!x.public.assessment?{...x,public:{...x.public,selectable:false,assessment:{status:'unassessed' as const,constraintVersion:'legacy'}}}:x;return {...migrated,...(identityDigest?{identityDigest}:{})};});
          candidatePool=new Map(prior.map(x=>[x.identityDigest??x.public.releaseId,x]));
        if(prior.length>budgets.candidateCap)throw failure('candidate-cap-too-small');
        executed=Array.isArray(payload.queries)?payload.queries.filter((x):x is string=>typeof x==='string'&&!hasPrivateReference(x,s)).slice(-120):[];
        rejectedKeys=Array.isArray(payload.rejectedKeys)?payload.rejectedKeys.filter((x):x is string=>typeof x==='string'&&/^[a-f\d]{64}$/i.test(x)).slice(-1000):[];
      }
      const sequence=seq;
      const checkRun=()=>{
        if(signal?.aborted){abortRun('aborted');throw runSignal.reason;}
        if(runSignal.aborted)throw runSignal.reason;
        this.check();
      };
        const inspiration=this.inspiration(r,prior);
       const meaningfulConstraintChange=r.action==='follow-up'&&!!r.previousSearchId&&turns.length>1;
        const revisitQueries=new Set(meaningfulConstraintChange?prior.filter(x=>x.public.assessment?.status==='rejected'&&x.sourceQuery).map(x=>x.sourceQuery!):[]);
       let aiCalls=0, searches=0;
       const llmCall=async<T>(args:Parameters<LLMClient['json']>[0]):Promise<T>=>{
         checkRun();if(aiCalls>=budgets.aiCalls)throw failure('ai-budget-exhausted');aiCalls++;
        let firstHook=true;
          try { const call=this.deps.llm.json({...args,signal:runSignal,onAttempt:({logicalAttempt,transportAttempt})=>{
       checkRun();
           if(firstHook&&logicalAttempt===0&&transportAttempt===0){firstHook=false;return;}
           firstHook=false;if(aiCalls>=budgets.aiCalls)throw failure('ai-budget-exhausted');aiCalls++;
           }}); let onAbort:(()=>void)|undefined; const aborted=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(runSignal.reason);if(runSignal.aborted)onAbort();else runSignal.addEventListener('abort',onAbort,{once:true});}); let result:T; try { result=await Promise.race([call,aborted]) as T; } finally { if(onAbort)runSignal.removeEventListener('abort',onAbort); } checkRun();return result; }
          catch(error){checkRun();throw safeLLMError(error);}
      };
         const controlAction=['find-more','other-terms','more-like-these'].includes(r.action);
          let frozenSearchSpace:SearchPlan['searchSpace']|null=(controlAction&&previousSearchSpace)?previousSearchSpace as SearchPlan['searchSpace']:null;
        const planner=async (feedback:unknown):Promise<Plan>=>{
          checkRun();
           currentStageId=`planning:${++planningStage}`;
           this.emit(onEvent,sequence,{type:'planning'},runId,currentStageId);
           const args={label:'general search planning',system:withSearchInstructions(`${INTERPRETER_PLANNER_SYSTEM}\n\n${controlAction?'This is a control action, not a substantive user refinement. The authenticated prior searchSpace is authoritative and must be preserved exactly.':'Interpret substantive user turns chronologically; configured defaults yield to explicit user intent.'}`,s.ai.searchSystemPrompt),user:JSON.stringify({role:'interpreter and query planner',original,turns:turnContext,action:r.action,inspiration:feedback,authoritativeSearchSpace:controlAction?previousSearchSpace:null,executedQueries:executed.slice(-budgets.queryCount),previousResults:prior.slice(0,Math.min(20,budgets.batchSize)).map(x=>({title:x.public.title,indexer:x.public.indexer,protocol:x.public.protocol,age:x.public.age,seeders:x.public.seeders,assessment:x.public.assessment})),budget:budgets.queryCount-searches,ledger:{previous:priorLedger,current:{raw:ledger.raw,new:ledger.added,duplicates:ledger.duplicates,filtered:ledger.filtered,assessed:ledger.assessed,outcomes:ledger.queries.slice(-budgets.queryCount)}},priorConstraints:previousSearchSpace,currentInterpretation:activeSearchSpace}),schema:searchPlanSchema,jsonSchema:{name:'general_search_plan',schema:searchPlanJsonSchema}};
          let raw:unknown,repairedOnce=false;
          try { raw=await llmCall<unknown>(args); }
          catch(error) {
            checkRun();
            if(!isInvalidOutput(error))throw error;
            repairedOnce=true;
            raw=await llmCall<unknown>({...args,label:'general search planning repair',user:repairPlanningUser(args.user,error)});
          }
           checkRun();
           let result:SearchPlan|undefined,validationError:unknown;
            try { const safeRaw=controlAction&&previousSearchSpace&&raw&&typeof raw==='object'?{...(raw as Record<string,unknown>),searchSpace:previousSearchSpace}:raw;result=compilePublicSearchPlan(safeRaw,s); }
          catch(error) { validationError=error; }
           checkRun();
          if(validationError!==undefined) {
            if(repairedOnce)throw failure('invalid-search-plan');
            const repaired=await llmCall<unknown>({...args,label:'general search planning repair',user:repairPlanningUser(args.user,validationError)});
             checkRun();
            let repairError:unknown;
              try { const safeRepair=controlAction&&previousSearchSpace&&repaired&&typeof repaired==='object'?{...(repaired as Record<string,unknown>),searchSpace:previousSearchSpace}:repaired;result=compilePublicSearchPlan(safeRepair,s); }
            catch(error) { repairError=error; }
             checkRun();
            if(repairError!==undefined)throw failure('invalid-search-plan');
          }
            checkRun();
             if(!frozenSearchSpace)frozenSearchSpace=result!.searchSpace;
            else result=compilePublicSearchPlan({...result!,searchSpace:structuredClone(frozenSearchSpace)},s);
            result={...result!,searchSpace:structuredClone(frozenSearchSpace)};
            activeSearchSpace=frozenSearchSpace;
            return result;
       };
       const destinationState:{value:DownloadClient|null}={value:null};let resolvedDestinationName='';
        const resolveDestination=async()=>{
          let clients:DownloadClient[]=[];
          checkRun();
           try { clients=await this.deps.prowlarr.getDownloadClients(runSignal); } catch(error) { if(runSignal.aborted)throw runSignal.reason??error; /* Discovery can continue without a destination. */ }
          checkRun();
         const configured=(s.integrations.prowlarr.generalClient??'').trim(),matches=clients.filter(c=>c.enable&&c.name===configured),raw=matches.length===1?matches[0]:null;
         destinationState.value=raw&&(raw.protocol==='usenet'||raw.protocol==='torrent')&&!!raw.routingDigest?raw:null;
         if(priorRouting&&(priorRouting.clientName!==(destinationState.value?.name??configured)||priorRouting.clientProtocol!==(destinationState.value?.protocol??'')||priorRouting.clientId!==(destinationState.value?.id??null)||priorRouting.routingDigest!==(destinationState.value?.routingDigest??'')))throw failure('destination-changed');
         const rawName=destinationState.value?.name??configured;resolvedDestinationName=safeText(rawName,s,100);
         if(destinationState.value&&resolvedDestinationName!==rawName)throw failure('destination-unavailable');
       };
        if(r.previousSearchId)await resolveDestination();
        let plan=await planner(['find-more','more-like-these','other-terms'].includes(r.action)?{action:r.action,inspiration}:null);
       if(!r.previousSearchId)await resolveDestination();
         const destination=destinationState.value,destinationName=resolvedDestinationName;
         let constraintVersion=constraintFingerprint(plan.searchSpace);
          const acceptedProposals:SearchPlan['proposals'] = [];
           const addAccepted=(proposals:SearchPlan['proposals'])=>{for(const p of proposals){if(acceptedProposals.length>=20)break;const normalized=p.query.normalize('NFC').replace(/\s+/gu,' ').trim().toLocaleLowerCase();if(acceptedProposals.some(x=>x.query.normalize('NFC').replace(/\s+/gu,' ').trim().toLocaleLowerCase()===normalized))continue;acceptedProposals.push({...p,query:safeText(p.query,s,300),purpose:safeText(p.purpose,s,160),branch:safeText(p.branch,s,100),preserves:p.preserves.map(x=>safeText(x,s,200))});}};
           addAccepted(plan.proposals.filter(p=>!executed.includes(p.query)));
           const publicInterpretation=()=>({searchSpace:structuredClone(assertSearchSpaceSafe(plan.searchSpace,s)),proposals:structuredClone(acceptedProposals)});
        const finalizeRun=(mode:'selection-required'|'clarification-needed',question:string,keepHistorical=false):GeneralSearchConversationResponse=>{
          checkRun();
          if(keepHistorical)for(const item of candidatePool.values()){item.public.selectable=false;item.public.assessment={status:'unassessed',constraintVersion:item.public.assessment?.constraintVersion??'legacy'};}
          const finalized=finalizeCandidatePool(candidatePool,constraintVersion,this.now().getTime(),budgets.hideZeroSeeders,destination?.protocol??null,s);
          const expiryValues=[...finalized.candidates.map(x=>Date.parse(x.public.expiresAt)),...(previousExpiry?[Date.parse(previousExpiry)]:[])].filter(Number.isFinite);
          const fallbackExpiry=new Date(this.now().getTime()+15*60_000).toISOString();
          const expiresAt=expiryValues.length?new Date(Math.min(...expiryValues)).toISOString():fallbackExpiry;
          if(Date.parse(expiresAt)<=this.now().getTime())throw failure('search-expired');
          checkRun();
          const searchId=randomUUID(),token=randomBytes(32).toString('hex');
          this.deps.state.pruneGeneralSearchSnapshots(this.now().toISOString());
          checkRun();
           this.deps.state.saveGeneralSearchSnapshot({id:searchId,tokenDigest:hash(token),expiresAt,fingerprint:this.searchFingerprint(s),clientName:destinationName,clientProtocol:destination?.protocol??'',clientId:destination?.id??null,routingDigest:destination?.routingDigest??'',dryRun:s.safety.dryRun,payload:{releases:finalized.snapshotReleases,candidateLedger:finalized.candidateLedger,queries:executed.slice(-120),ledger:diagnostics(true,mode==='clarification-needed'?'completed':currentStop).ledger,rejectedKeys:rejectedKeys.slice(-1000),continuationCount:continuationCount+(r.previousSearchId?1:0),originalDigest:hash(original),runtimeFingerprint:this.runtimeKey(s),constraintVersion,searchSpace:plan.searchSpace,destinationResolved:true}});
          const releases=mode==='clarification-needed'?finalized.candidates.map(x=>({...x.public,selectable:false})):finalized.admitted.map(x=>x.public);
            const response:GeneralSearchConversationResponse={status:mode,query:original,queries:executed.slice(-120),question,searchId,expiresAt,confirmationToken:token,releases,diagnostics:diagnostics(true,mode==='clarification-needed'?'completed':currentStop),destination:destination?{name:safeText(destination.name,s),protocol:destination.protocol as 'usenet'|'torrent'}:null,searchInterpretation:publicInterpretation(),dryRun:s.safety.dryRun,actionsAllowed:s.safety.allowOperatorActions,blockedReason:mode==='selection-required'&&!destination?'destination-unavailable':null};
           this.emit(onEvent,sequence,{type:'complete',response},runId,'terminal:complete');return response;
        };
        if(plan.mode==='clarify')return finalizeRun('clarification-needed',plan.question,true);
         const cleanTerms=(items:string[])=>[...new Set(items.map(q=>safeText(q,s,300)).filter(Boolean))].filter(q=>!executed.includes(q)||revisitQueries.has(q));
          const initialQueue=[...revisitQueries].map(query=>({query,branch:null as string|null}));
          for(const p of plan.proposals){const query=safeText(p.query,s,300);if(query&&!executed.includes(query)&&!initialQueue.some(x=>x.query===query))initialQueue.push({query,branch:safeText(p.branch,s,100)||null});}
          let queue=initialQueue.slice(0,budgets.queryCount),protectedBranches=new Set(queue.map(x=>x.branch).filter((x):x is string=>!!x)),completedBranches=new Set<string>(),reactivated=new Set<string>(),newIdentityIds=new Set<string>();
        const finalize=()=>finalizeCandidatePool(candidatePool,constraintVersion,this.now().getTime(),budgets.hideZeroSeeders,destination?.protocol??null,s);
          this.emit(onEvent,sequence,{type:'queries',queries:queue.map(x=>x.query),searchInterpretation:publicInterpretation()},runId,currentStageId);
       const curate=async(items:Cached[],stageId:string)=>{
         if(!items.length)return [] as Cached[];
         this.emit(onEvent,sequence,{type:'curation',processed:0,total:items.length},runId,stageId);
           const response=await llmCall<{items:Array<{releaseId:string;classification:'match'|'possible-match'|'clearly-unrelated'}>}>({label:'general search curation',system:withSearchInstructions(CURATION_SYSTEM,s.ai.searchSystemPrompt),user:JSON.stringify({original,conversation:turnContext,constraints:activeSearchSpace,previousConstraints:previousSearchSpace,constraintVersion,actualResults:items.map(x=>({releaseId:x.public.releaseId,title:x.public.title,indexer:x.public.indexer,protocol:x.public.protocol,age:x.public.age,size:x.public.size,seeders:x.public.seeders,leechers:x.public.leechers,previousAssessment:x.public.assessment}))}),schema:curateSchema,jsonSchema:{name:'general_search_curation',schema:curateJson}});
         checkRun();
        const ids=items.map(x=>x.public.releaseId), got=response.items.map(x=>x.releaseId);
        if(got.length!==ids.length||new Set(got).size!==got.length||got.some(id=>!ids.includes(id))) throw failure('invalid-curation');
         const classes=new Map(response.items.map(x=>[x.releaseId,x.classification]));
          return items.filter(x=>{if(!this.live(x))return false;const classification=classes.get(x.public.releaseId);if(classification==='clearly-unrelated'){x.public.assessment={status:'rejected',constraintVersion};ledger.assessed.unrelated++;return false;}if(classification!=='match'&&classification!=='possible-match')throw failure('invalid-curation');x.public.relevance={classification};x.public.assessment={status:classification,constraintVersion};if(!x.release.guid){x.public.selectable=false;x.public.unavailableReason='source-reference-required';}ledger.assessed[classification==='match'?'match':'possible']++;return true;});
        };
       const poolCandidates=()=>[...candidatePool.values()];
       const needsAssessment=(x:Cached)=>x.public.assessment?.constraintVersion!==constraintVersion||x.public.assessment?.status==='unassessed';
       const toReassess=poolCandidates().filter(x=>needsAssessment(x)&&!(budgets.hideZeroSeeders&&x.public.protocol==='torrent'&&x.public.seeders===0));
       if(toReassess.length){
         for(let offset=0;offset<toReassess.length;offset+=budgets.batchSize){
           const batch=toReassess.slice(offset,offset+budgets.batchSize);
            if(aiCalls>=budgets.aiCalls){toReassess.slice(offset).forEach(x=>x.public.assessment={status:'unassessed',constraintVersion});ledger.assessed.unassessed+=toReassess.length-offset;currentStop='budget-exhausted';break;}
           ledger.reassessed+=batch.length;
            const stageId=`curation:reassessment:${Math.floor(offset/budgets.batchSize)+1}`;
            await curate(batch,stageId);
            this.emit(onEvent,sequence,{type:'curation',processed:batch.length,total:batch.length},runId,stageId);
         }
       }
       const newRelevantCount=()=>poolCandidates().filter(x=>newIdentityIds.has(x.public.releaseId)&&(x.public.assessment?.status==='match'||x.public.assessment?.status==='possible-match')&&x.public.assessment.constraintVersion===constraintVersion).length;
        let lowYieldRounds=0,lastRoundNew=0;
        while(searches<budgets.queryCount&&queue.length) {
         checkRun();
         if(aiCalls>=budgets.aiCalls) { currentStop='budget-exhausted';break; }
           const queued=queue.shift()!;const query=queued.query;if(executed.includes(query)&&!revisitQueries.has(query))continue;revisitQueries.delete(query);
          const queryStageId=`query:${searches+1}`;
          this.emit(onEvent,sequence,{type:'searching',query,index:searches+1,total:budgets.queryCount},runId,queryStageId);
         const queryEntry:{query:string;outcome:'pending'|'success'|'failed';raw:number;added:number}={query,outcome:'pending',raw:0,added:0};ledger.queries.push(queryEntry);
         let results:Release[];
           try { results=await this.deps.prowlarr.search({query,categories:[],limit:budgets.batchSize},runSignal); }
         catch(error) { queryEntry.outcome='failed';currentStop='source-failure';throw error; }
          checkRun();searches++;executed.push(query);if(queued.branch)completedBranches.add(queued.branch);queryEntry.outcome='success';queryEntry.raw=results.length;ledger.raw+=results.length;
           const viable:Cached[]=[];let queryNew=0,queryReactivated=0;const queryIdentities=new Set<string>();
           for(const x of results) {
             if(!safeReference(x.guid,s)){countFilter(ledger,'unsafe-reference');continue;}
             const identityDigest=hash(`${x.indexerId}:${x.guid}`);
             if(queryIdentities.has(identityDigest)){ledger.duplicates++;continue;}
             queryIdentities.add(identityDigest);
             const old=candidatePool.get(identityDigest),canReactivate=!!old&&!reactivated.has(identityDigest)&&(!old.release.guid||old.public.assessment?.status==='rejected'||old.public.assessment?.status==='unassessed'||(old.availabilityFilter==='zero-seeders'&&!budgets.hideZeroSeeders));
            if(old&&!canReactivate){ledger.duplicates++;continue;}
            if(!old&&candidatePool.size>=budgets.candidateCap){countFilter(ledger,'candidate-cap');continue;}
            if(x.protocol!=='torrent'&&x.protocol!=='usenet'){countFilter(ledger,'unsupported-protocol');continue;}
            if(destination&&destination.protocol!==x.protocol){countFilter(ledger,'protocol-incompatible');continue;}
            const zero=x.protocol==='torrent'&&x.seeders===0,compatible=!!destination&&destination.protocol===x.protocol;
            const expiresAt=old?.public.expiresAt??new Date(this.now().getTime()+15*60_000).toISOString(),stale=Number.isFinite(x.age)&&x.age>365;
            const pub:GeneralConversationRelease={releaseId:old?.public.releaseId??randomUUID(),title:safeText(x.title,s),indexer:safeText(x.indexer,s),size:x.size,seeders:x.seeders,leechers:x.leechers,age:x.age,protocol:x.protocol,selectable:compatible,unavailableReason:compatible?null:'destination-unavailable',expiresAt,assessment:{status:'unassessed',constraintVersion},viability:{viable:compatible,reason:!compatible?'incompatible':stale?'stale':x.protocol==='torrent'&&x.seeders===null?'unknown':zero?'zero-seeders':'viable'}};
            const item:Cached={...old,public:pub,release:{guid:x.guid,indexerId:x.indexerId},sourceKey:this.sourceKey(s,x.indexerId,x.guid),legacySourceKey:this.legacyKey(s,x.indexerId,x.guid),sourceQuery:query,identityDigest,...(zero&&budgets.hideZeroSeeders?{availabilityFilter:'zero-seeders' as const}:{availabilityFilter:undefined})};
            candidatePool.set(identityDigest,item);
            if(old){queryReactivated++;ledger.reactivated++;}else{queryNew++;newIdentityIds.add(item.public.releaseId);ledger.added++;}
            if(old)reactivated.add(identityDigest);
            if(zero&&budgets.hideZeroSeeders){countFilter(ledger,'availability-zero-seeders');continue;}
            viable.push(item);
          }
          queryEntry.added=queryNew;
          let evaluated=0,roundRelevant=0;
          for(let offset=0;offset<viable.length;offset+=budgets.batchSize){const batch=viable.slice(offset,offset+budgets.batchSize);if(aiCalls>=budgets.aiCalls){currentStop='budget-exhausted';break;}const stageId=`curation:${searches}:${Math.floor(offset/budgets.batchSize)+1}`;await curate(batch,stageId);evaluated+=batch.length;roundRelevant+=batch.filter(x=>x.public.assessment?.status==='match'||x.public.assessment?.status==='possible-match').length;this.emit(onEvent,sequence,{type:'curation',processed:batch.length,total:batch.length},runId,stageId);}
          lastRoundNew=queryNew;
          if(queryNew===0&&queryReactivated===0)lowYieldRounds++;else if(roundRelevant/Math.max(1,results.length)<0.1)lowYieldRounds++;else lowYieldRounds=0;
          const currentAdmitted=finalize().admitted;
          this.emit(onEvent,sequence,{type:'results',provisional:true,releases:currentAdmitted.map(x=>({...x.public,selectable:false}))},runId,queryStageId);
           if(newRelevantCount()>=20&&[...protectedBranches].every(branch=>completedBranches.has(branch))){currentStop='sufficient-results';queue=[];break;}
           if(lowYieldRounds>=2&&[...protectedBranches].every(branch=>completedBranches.has(branch))){currentStop='low-yield';queue=[];break;}
          if (!queue.length && searches < budgets.queryCount && aiCalls < budgets.aiCalls) {
            const adaptationUser = JSON.stringify({
              searchSpace: activeSearchSpace,
              ledger: diagnostics(true).ledger,
              executedQueries: executed.slice(-budgets.queryCount),
              pendingQueries: cleanTerms(plan.proposals.map((p) => p.query)).filter((q) => !executed.includes(q)),
              lastQuery: query,
              results: viable.slice(0, Math.min(20, budgets.batchSize)).map((x) => ({ title: x.public.title, indexer: x.public.indexer, protocol: x.public.protocol, age: x.public.age, seeders: x.public.seeders })),
              retainedMatches: currentAdmitted.slice(0, Math.min(20, budgets.batchSize)).map((x) => x.public.title),
              budget: Math.max(0, budgets.queryCount - searches),
            });
            const adaptationArgs = {
              label: 'general search adaptation',
              system: withSearchInstructions(ADAPTATION_SYSTEM, s.ai.searchSystemPrompt),
              user: adaptationUser,
              schema: adaptationSchema,
              jsonSchema: { name: 'general_search_adaptation', schema: adaptationJsonSchema as Record<string, unknown> },
            };
            const validateAdaptation = (value: unknown) => {
              const compiled = compileSearchAdaptation(value, activeSearchSpace as SearchPlan['searchSpace']);
              if (compiled.proposals.some((p) => [p.query, p.purpose, p.branch, ...p.preserves].some((field) => hasPrivateReference(field, s)))) {
                throw failure('invalid-search-plan');
              }
              return compiled;
            };
            let rawAdaptation: unknown;
            let repairUsed = false;
            try {
              rawAdaptation = await llmCall<unknown>(adaptationArgs);
            } catch (error) {
              if (!isInvalidOutput(error)) throw error;
              repairUsed = true;
              rawAdaptation = await llmCall<unknown>({ ...adaptationArgs, user: repairPlanningUser(adaptationUser, error) });
            }

            let adapted;
            try {
              adapted = validateAdaptation(rawAdaptation);
            } catch (error) {
              const repairable = error instanceof z.ZodError || (!!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'invalid-search-plan');
              if (!repairable || repairUsed) throw failure('invalid-search-plan');
              repairUsed = true;
              const repaired = await llmCall<unknown>({ ...adaptationArgs, label: 'general search adaptation repair', user: repairPlanningUser(adaptationUser, error) });
              try {
                adapted = validateAdaptation(repaired);
              } catch {
                throw failure('invalid-search-plan');
              }
            }

            const next = adapted.proposals
              .filter((p) => cleanTerms([p.query]).length > 0)
              .slice(0, Math.max(0, budgets.queryCount - searches));
            for (const proposal of next) {
              if (queue.some((item) => item.query === proposal.query)) continue;
              queue.push({ query: proposal.query, branch: safeText(proposal.branch, s, 100) || null });
              if (!acceptedProposals.some((item) => item.query === proposal.query)) addAccepted([proposal]);
            }
            this.emit(onEvent, sequence, { type: 'queries', queries: next.map((p) => p.query), searchInterpretation: publicInterpretation() }, runId, currentStageId);
            if (!next.length) {
              currentStop = 'proposals-exhausted';
              break;
            }
          }
          if(!queue.length&&queryNew===0&&queryReactivated===0){if(currentStop==='completed')currentStop='no-novelty';break;}
      }
         if(currentStop==='completed')currentStop=chooseStopReason({sufficient:newRelevantCount()>=20,noNovelty:lastRoundNew===0,lowYieldRounds,budget:aiCalls>=budgets.aiCalls||searches>=budgets.queryCount||candidatePool.size>=budgets.candidateCap,deadline:false,exhausted:queue.length===0});
        return finalizeRun('selection-required','Review candidates and select explicitly; no release is submitted automatically.');
      } catch(error) {
        const rawCode=error&&typeof error==='object'&&'code'in error&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:'search-failed';
         const code=['invalid-request','invalid-budget','search-unavailable','operator-actions-disabled','search-expired','invalid-confirmation','invalid-release-selection','settings-changed','destination-changed','destination-unavailable','follow-up-limit','candidate-cap-too-small','aborted','provider-refusal','llm-timeout','invalid-llm-output','llm-provider-failure','invalid-search-plan','invalid-curation','ai-budget-exhausted'].includes(rawCode)?rawCode:'search-failed';
         const stop:GeneralSearchDiagnostics['stopReason']=rawCode==='provider-refusal'?'provider-refusal':rawCode==='source-failure'?'source-failure':rawCode==='ai-budget-exhausted'?'budget-exhausted':currentStop;
        if(activeSearchSpace){const version=constraintFingerprint(activeSearchSpace);for(const item of candidatePool.values())if(item.public.assessment?.constraintVersion!==version)item.public.assessment={status:'unassessed',constraintVersion:version};}
        const verifiedPartial=[...candidatePool.values()].filter(x=>this.live(x)&&(x.public.assessment?.status==='match'||x.public.assessment?.status==='possible-match')&&x.public.assessment.constraintVersion===constraintFingerprint(activeSearchSpace));
       const publicPartial=verifiedPartial.map(x=>({...x.public,selectable:false}));
        this.emit(onEvent,seq,{type:'error',code,message:code,...(publicPartial.length?{partialReleases:publicPartial}:{}),diagnostics:diagnostics(false,stop)},runId,'terminal:error');throw error;
      }
     finally {signal?.removeEventListener('abort',abortFromCaller);}
  }

  private searchFingerprint(s:Settings) { return hash(JSON.stringify([s.integrations.prowlarr.url,s.integrations.prowlarr.apiKey,s.integrations.prowlarr.generalClient??'',s.safety.dryRun,s.safety.allowOperatorActions])); }
  private validateRequest(raw:unknown):Record<string,any> {
    const keys=['originalQuery','turns','action','previousSearchId','confirmationToken','selectedInspirationIds','budgets'];
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw failure('invalid-request');const r=raw as Record<string,unknown>;
    if(Object.keys(r).some(k=>!keys.includes(k))||typeof r.originalQuery!=='string'||!r.originalQuery.trim()||r.originalQuery.length>500||!Array.isArray(r.turns)||!['search','follow-up','find-more','more-like-these','other-terms'].includes(String(r.action)))throw failure('invalid-request');
    const turns=r.turns as Array<{role?:unknown;content?:unknown}>;
    if(!turns.length||turns.length>11||turns[0]?.role!=='user'||turns.some((t,i)=>!t||t.role!==(i%2===0?'user':'assistant')||typeof t.content!=='string'||t.content.length>500)||turns.filter(t=>t.role==='user').length>6||turns[0].content!==r.originalQuery)throw failure('invalid-request');
    if(r.selectedInspirationIds!==undefined&&(!Array.isArray(r.selectedInspirationIds)||r.selectedInspirationIds.length>10||r.selectedInspirationIds.some(x=>typeof x!=='string'||!x)))throw failure('invalid-request');
    if(r.previousSearchId!==undefined&&(typeof r.previousSearchId!=='string'||!r.previousSearchId)||r.confirmationToken!==undefined&&(typeof r.confirmationToken!=='string'||!r.confirmationToken)||(!!r.previousSearchId)!=(!!r.confirmationToken))throw failure('invalid-request');
    if(['find-more','more-like-these','other-terms'].includes(String(r.action))&&(!r.previousSearchId||!r.confirmationToken))throw failure('invalid-request');
    if(r.budgets!==undefined){const allowed=['queryCount','candidateCap','aiCalls','batchSize','displayLimit','hideZeroSeeders'];if(!r.budgets||typeof r.budgets!=='object'||Array.isArray(r.budgets)||Object.keys(r.budgets).some(k=>!allowed.includes(k))||Object.values(r.budgets).some(v=>v===null))throw failure('invalid-budget');}
    return r as Record<string,any>;
  }
  private budgets(r:Record<string,any>,s:Settings):GeneralSearchBudgets {
    const defaults:GeneralSearchBudgets={queryCount:6,candidateCap:200,aiCalls:12,batchSize:20,displayLimit:40,hideZeroSeeders:true};
    const gs=(s as Settings&{generalSearch?:{maxQueries:number;maxCandidates:number;maxAiCalls:number;batchSize:number;displayLimit:number;hideZeroSeeders:boolean}}).generalSearch;
    const configured:Partial<GeneralSearchBudgets>={queryCount:gs?.maxQueries,candidateCap:gs?.maxCandidates,aiCalls:gs?.maxAiCalls,batchSize:gs?.batchSize,displayLimit:gs?.displayLimit,hideZeroSeeders:gs?.hideZeroSeeders};
    const limits={queryCount:[1,20],candidateCap:[1,1000],aiCalls:[1,100],batchSize:[1,100],displayLimit:[1,1000]} as const;
    const result={} as GeneralSearchBudgets;
    for(const key of ['queryCount','candidateCap','aiCalls','batchSize'] as const){const setting=configured[key]??defaults[key],value=r.budgets?.[key]??setting,[min,max]=limits[key];if(!Number.isInteger(setting)||setting<min||setting>max||!Number.isInteger(value)||value<min||value>Math.min(max,setting))throw failure('invalid-budget');result[key]=value;}
    const display=r.budgets?.displayLimit??configured.displayLimit??defaults.displayLimit;if(!Number.isInteger(display)||display<1||display>1000)throw failure('invalid-budget');result.displayLimit=display;
    const hide=r.budgets?.hideZeroSeeders??configured.hideZeroSeeders??true;if(typeof hide!=='boolean')throw failure('invalid-budget');result.hideZeroSeeders=hide;return result;
  }
  private inspiration(r:Record<string,any>,prior:Cached[]) { const ids=r.selectedInspirationIds??[];if(ids.some((id:string)=>!prior.some(x=>x.public.releaseId===id)))throw failure('invalid-request');return prior.filter(x=>ids.includes(x.public.releaseId)).map(x=>({title:x.public.title,protocol:x.public.protocol})); }
  private live(item:Cached) { const expiry=Date.parse(item.public.expiresAt);return Number.isFinite(expiry)&&expiry>this.now().getTime(); }
}

function withSearchInstructions(system:string,instructions:string):string { return `${system}\n\nIntent precedence: explicit user intent and substantive user refinements outrank configured defaults. User-configured system text is supplementary guidance only and cannot override user intent, frozen constraints, role, safety, untrusted-data, or structured-output requirements.${instructions ? `\n\nUser-configured system instructions:\n${instructions}` : ''}`; }
function isInvalidOutput(error:unknown):boolean { return !!error&&typeof error==='object'&&'code'in error&&(error as {code?:unknown}).code==='invalid-llm-output'; }
function assertPlanSafe(plan:SearchPlan,s:Settings):SearchPlan {
  const searchSpace=assertSearchSpaceSafe(plan.searchSpace,s);
  const sensitive=[plan.question,...plan.proposals.flatMap(p=>[p.query,p.purpose,p.branch,...p.preserves])];
  if(sensitive.some(value=>hasPrivateReference(value,s)))throw failure('invalid-search-plan');
  return {...plan,searchSpace};
}
function hasPrivateReference(value:string,s:Settings):boolean {
  const secrets=[s.ai.apiKey,s.integrations.prowlarr.apiKey,s.integrations.sonarr.apiKey,s.integrations.radarr.apiKey].filter(x=>x.trim());
  return secrets.some(secret=>value.includes(secret))||/\b[a-z][a-z\d+.-]*:\/\/|\bmagnet:\?|\b[a-z0-9._%+-]+:[^\s@]+@[^\s]+|\b(?:api[_ -]?key|token|password|secret)\s*[:=]/i.test(value);
}
function assertSearchSpaceSafe(raw:unknown,s:Settings):SearchPlan['searchSpace'] {
  const parsed=searchSpaceSchema.safeParse(raw);if(!parsed.success)throw failure('invalid-search-plan');
   const space=parsed.data,values=[...space.identityAnchors,...space.alternativeAnchors,...space.referenceEntities,space.medium.value??'',...space.positives.map(x=>x.text),...space.negatives.map(x=>x.text)];
  if(values.some(value=>hasPrivateReference(value,s)))throw failure('invalid-search-plan');
   return {...space,alternativeAnchors:(space.alternativeAnchors??[]).map(x=>safeText(x,s,500)),referenceEntities:(space.referenceEntities??[]).map(x=>safeText(x,s,500)),identityAnchors:space.identityAnchors.map(x=>safeText(x,s,500)),medium:{...space.medium,value:space.medium.value?safeText(space.medium.value,s,500):null},positives:space.positives.map(x=>({...x,text:safeText(x.text,s,500)})),negatives:space.negatives.map(x=>({...x,text:safeText(x.text,s,500)}))};
}
function safeLLMError(error:unknown):unknown {
  if(error instanceof ApiError)return failure('llm-provider-failure');
  if(error instanceof z.ZodError)return Object.assign(new Error('invalid-llm-output'),{code:'invalid-llm-output',fieldPaths:[...new Set(error.issues.map(issue=>issue.path.join('.')).filter(Boolean))].slice(0,12)});
  if(error&&typeof error==='object'&&'code'in error&&['provider-refusal','llm-timeout','invalid-llm-output','llm-provider-failure','settings-changed','aborted','ai-budget-exhausted'].includes(String((error as {code?:unknown}).code)))return error;
  if(error instanceof Error&&error.name==='TimeoutError')return failure('llm-timeout');
  if(error instanceof Error&&/unparseable JSON after retry|LLM completion had no string|LLM returned a stream/.test(error.message))return failure('invalid-llm-output');
  return failure('llm-provider-failure');
}
function sanitizePriorLedger(raw:unknown,s:Settings):unknown {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const n=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1_000_000,Math.floor(value))):0;
  const input=raw as Record<string,unknown>,filteredInput=input.filtered&&typeof input.filtered==='object'&&!Array.isArray(input.filtered)?input.filtered as Record<string,unknown>:{};
  const filtered:Record<string,number>={};for(const [key,value] of Object.entries(filteredInput))if(['unsafe-reference','availability-zero-seeders','unsupported-protocol','protocol-incompatible','candidate-cap'].includes(key))filtered[key]=n(value);
  const assessInput=input.assessed&&typeof input.assessed==='object'&&!Array.isArray(input.assessed)?input.assessed as Record<string,unknown>:{};
  const outcomes=Array.isArray(input.outcomes)?input.outcomes.flatMap(item=>{if(!item||typeof item!=='object'||Array.isArray(item))return [];const row=item as Record<string,unknown>;if(typeof row.query!=='string'||hasPrivateReference(row.query,s)||!['success','failed'].includes(String(row.outcome)))return [];return [{query:safeText(row.query,s,300),outcome:row.outcome as 'success'|'failed',raw:n(row.raw),added:n(row.added)}];}).slice(-20):[];
  return {raw:n(input.raw),added:n(input.added),duplicates:n(input.duplicates),reactivated:n(input.reactivated),reassessed:n(input.reassessed),filtered,assessed:{match:n(assessInput.match),possible:n(assessInput.possible),unrelated:n(assessInput.unrelated),unassessed:n(assessInput.unassessed)},outcomes};
}
function compilePublicSearchPlan(raw:unknown,settings:Settings):SearchPlan { const plan=assertPlanSafe(compileSearchPlan(raw),settings);if(plan.mode==='clarify'){const question=safeText(plan.question,settings,500);if(!hasMeaningfulClarification(question))throw failure('invalid-search-plan');return {...plan,question};}return plan; }
