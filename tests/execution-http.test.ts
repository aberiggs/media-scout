import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { SearchRuntime } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';
import { releaseSchema } from '../src/types/prowlarr';
import { physicalRelease } from '../src/search/release-observation';
import { Http } from '../src/http';
import { ProwlarrClient } from '../src/clients/prowlarr';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});

async function fixture(postMode:'accept'|'reject'|'timeout'|'hang'|'second-reject'|'delay-first'='accept',dryRun=false,disableGrab=false,options:{databasePath?:string;httpTimeoutMs?:number}={}) {
  const posts:Array<unknown>=[];
  let clientName='TV client',defaultCategory='tv',categoryMappings:Array<{clientCategory:string;categories:number[]}>=[{clientCategory:'tv',categories:[5000]},{clientCategory:'anime',categories:[5010]}];
  let currentTime=Date.now(), releaseDelayedPost:(()=>void)|undefined, signalPost!:()=>void;
  const postSeen=new Promise<void>(resolve=>signalPost=resolve);
  let runtime:SearchRuntime;
  let changeSourceOnNextClientList=false;
  const upstream:Server=createServer((req,res)=>{
    if(req.method==='GET'&&req.url==='/api/v1/downloadclient') {if(changeSourceOnNextClientList){changeSourceOnNextClientList=false;runtime.saveSettings({...runtime.getSettings(),integrations:{...runtime.getSettings().integrations,prowlarr:{...runtime.getSettings().integrations.prowlarr,url:'http://127.0.0.1:1'}}});}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([{id:7,name:clientName,enable:true,protocol:'torrent',supportsCategories:true,categories:categoryMappings,fields:[{name:'category',value:defaultCategory},{name:'host',value:'private-host-canary'}]}]));return;}
    if(req.method==='GET'&&req.url==='/api/v1/indexer'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([{id:5,name:'Indexer',enable:true,supportsSearch:true}]));return;}
    if(req.method==='GET'&&req.url==='/api/v1/indexerstatus'){res.writeHead(200,{'content-type':'application/json'});res.end('[]');return;}
    if(req.method==='GET'&&req.url?.startsWith('/api/v1/search?')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([releaseSchema.parse({guid:'research-guid',indexerId:5,indexer:'Indexer',title:'Research result',publishDate:'2026-01-01T00:00:00Z',protocol:'torrent',downloadUrl:'https://private.invalid/research'})]));return;}
    if(req.method==='POST'&&req.url==='/api/v1/search') {
      let body='';req.on('data',part=>body+=part);req.on('end',()=>{posts.push(JSON.parse(body));signalPost();if(postMode==='timeout'){res.destroy();return;}if(postMode==='hang'){res.writeHead(202,{'content-type':'application/json'});return;}const finish=()=>{const reject=postMode==='reject'||(postMode==='second-reject'&&posts.length===2);res.writeHead(reject?400:200,{'content-type':'application/json'});res.end('{}');};if(postMode==='delay-first'&&posts.length===1)releaseDelayedPost=finish;else finish();});return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const address=upstream.address();if(!address||typeof address==='string')throw new Error('no upstream address');
  const url=`http://127.0.0.1:${address.port}`;
  const settings={...defaultSettings,safety:{dryRun},integrations:{...defaultSettings.integrations,prowlarr:{...defaultSettings.integrations.prowlarr,url,apiKey:'private-key'}}};
  runtime=new SearchRuntime({store:openSearchStore(options.databasePath??':memory:'),initialSettings:settings,now:()=>currentTime,...(disableGrab?{clients:()=>({prowlarr:{getDownloadClients:async()=>[{id:7,name:'TV client',enable:true,protocol:'torrent',supportsCategories:true,categories:[{clientCategory:'tv',categories:[5000]}]}]}} as never)}:options.httpTimeoutMs?{clients:()=>({prowlarr:new ProwlarrClient(new Http({baseUrl:url,apiKey:'private-key',timeoutMs:options.httpTimeoutMs}))}) as never}:{})});
  const app=await buildApp({runtime,config:{HTTP_HOST:'127.0.0.1',HTTP_PORT:0,DB_PATH:':memory:',LOG_LEVEL:'silent'},logger:pino({level:'silent'})} as unknown as Stack,{webRoot:'/nonexistent-ui'});
  cleanups.push(async()=>{await app.close();await runtime.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const searchId='search-one',candidateIds=['candidate-a','candidate-b'];
  const plan={version:2,planId:'plan-one',status:'matched',selections:candidateIds.map(candidateId=>({candidateId,coverage:'Observed release',reason:'Useful observed pack',uncertainty:''})),covered:['Observed release'],gaps:[],deferred:[],broadCoverage:'complete',scopeGaps:[],coverage:{covered:['Observed release'],gaps:[],deferred:[],broad:{status:'complete',gaps:[]}}};
  runtime.store.createSearch({searchId,prompt:JSON.stringify({request:{prompt:'Find a release',kind:'movie'}}),status:'matched',createdAt:Date.now(),result:{version:1,status:'matched',plan,counts:{decisions:1,searches:1,candidates:2}}});
  runtime.store.setSetting(`search-source:${searchId}`,'manual');
  const source=createHash('sha256').update(`prowlarr\0${url}\0private-key`).digest('hex');
  candidateIds.forEach((candidateId,index)=>{
    const release=releaseSchema.parse({guid:`guid-${index}`,indexerId:5,indexer:'Indexer',title:`Title ${index} guid-${index}`,publishDate:'2026-01-01T00:00:00Z',protocol:'torrent',downloadUrl:`https://private.invalid/${index}`,size:1000,age:0,categories:[{id:index===0?5000:5999,name:index===0?'TV':'Anime'}]});
    runtime.store.addCandidate({searchId,candidateId,safe:{candidateId,observations:[]},privateData:{release,physicalKey:physicalRelease(release),sourceFingerprint:source},expiresAt:Date.now()+300_000});
  });
  return {app,runtime,posts,searchId,candidateIds,setClientName:(name:string)=>{clientName=name;},setDefaultCategory:(category:string)=>{defaultCategory=category;},setCategoryMappings:(mappings:typeof categoryMappings)=>{categoryMappings=mappings;},changeSourceOnNextClientList:()=>{changeSourceOnNextClientList=true;},postSeen,releaseDelayedPost:()=>releaseDelayedPost?.(),advance:(ms:number)=>{currentTime+=ms;},now:()=>currentTime};
}

describe('execution API through real Prowlarr HTTP adapter',()=>{
  it('confirms a whole set, routes explicit client ID, records durable receipt, and idempotently replays',async()=>{
    const f=await fixture('accept');const confirmation=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:[...f.candidateIds].reverse(),downloadClientId:7});
    expect(confirmation).toMatchObject({client:{id:7,protocol:'torrent',configuredCategories:[{clientCategory:'tv',categories:[5000]},{clientCategory:'anime',categories:[5010]}]},dryRun:false,children:[{candidateId:'candidate-a',effectiveCategory:'tv',categoryRouting:'direct'},{candidateId:'candidate-b',effectiveCategory:null,categoryRouting:'configured-mapping',categoryNote:'Prowlarr configured mapping may apply parent-category fallback; final category is unknown.'}]});
    expect(JSON.stringify(confirmation)).not.toContain('guid-0');
    const body={confirmationId:confirmation.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'request-1'};
    const first=await f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:body});
    expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({outcome:'submitted',client:{id:7,protocol:'torrent'},dryRun:false,children:[{outcome:'submitted',effectiveCategory:'tv'},{outcome:'submitted',effectiveCategory:null,categoryRouting:'configured-mapping'}]});
    expect(f.runtime.store.getExecutionPreparation(confirmation.confirmationId)).toBeNull();
    expect(f.posts).toEqual([{indexerId:5,guid:'guid-0',downloadClientId:7},{indexerId:5,guid:'guid-1',downloadClientId:7}]);
    f.runtime.store.appendEvent(f.searchId,{type:'submission',data:{outcome:'rejected',candidateIds:[],outcomes:[]}});
    f.runtime.saveSettings({...f.runtime.getSettings(),safety:{dryRun:true}});
    const replay=await f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:body});
    expect(replay.json()).toEqual(first.json());expect(f.posts).toHaveLength(2);
    expect(JSON.stringify(first.json())).not.toContain('private.invalid');
    expect((await f.app.inject(`/api/v2/searches/${f.searchId}`)).json().receipts).toHaveLength(1);
    expect((await f.app.inject('/api/v2/activity')).json().items[0].submission.outcome).toBe('submitted');
  });

  it('uses and displays the configured default category when direct category mappings are absent',async()=>{
    const f=await fixture();
    f.setCategoryMappings([]);
    const clients=await f.app.inject('/api/v2/download-clients');
    expect(clients.json()).toMatchObject({items:[{id:7,defaultCategory:'tv'}]});
    expect(clients.body).not.toContain('private-host-canary');
    const confirmation=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    expect(confirmation.client).toMatchObject({defaultCategory:'tv'});
    expect(confirmation.children).toEqual(expect.arrayContaining([{candidateId:'candidate-a',title:'Title 0 [redacted]',effectiveCategory:'tv',categoryRouting:'default-category',categoryNote:'Configured qBittorrent default category.',releaseCategoryIds:[5000]}]));
    const receipt=await f.runtime.commitExecution({confirmationId:confirmation.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'default-category-receipt'});
    expect(receipt.client).toMatchObject({defaultCategory:'tv'});
  });

  it('requires reconfirmation if the configured default category changes after preparation',async()=>{
    const f=await fixture();
    f.setCategoryMappings([]);
    const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    f.setDefaultCategory('tv-updated');
    await expect(f.runtime.commitExecution({confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'default-category-change'})).rejects.toThrow('client-changed');
    expect(f.posts).toHaveLength(0);
  });

  it('stops the release tail when the configured default category changes after a send',async()=>{
    const f=await fixture('delay-first');
    f.setCategoryMappings([]);
    const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const commit=f.runtime.commitExecution({confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'default-category-between'});
    await f.postSeen;
    f.setDefaultCategory('tv-updated');
    f.releaseDelayedPost();
    expect(await commit).toMatchObject({outcome:'partial',children:[{outcome:'submitted'},{outcome:'not-attempted'}]});
    expect(f.posts).toHaveLength(1);
  });

  it('preserves a successful child when a later child is rejected',async()=>{
    const f=await fixture('second-reject');const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const response=await f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:{confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'reject-key'}});
    expect(response.json()).toMatchObject({outcome:'partial',children:[{outcome:'submitted'},{outcome:'rejected'}]});expect(f.posts).toHaveLength(2);
  });
  it('fails closed when the Prowlarr adapter cannot grab',async()=>{
    const f=await fixture('accept',false,true);
    await expect(f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7})).rejects.toThrow('grab-adapter-unavailable');
    expect(f.runtime.store.executionsForSearch(f.searchId)).toHaveLength(0);expect(f.posts).toHaveLength(0);
  });
  it('rejects caller-supplied category overrides; categories come from release and client mapping',async()=>{
    const f=await fixture();
    const response=await f.app.inject({method:'POST',url:'/api/v2/executions/prepare',payload:{searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7,category:'not-the-configured-category'}});
    expect(response.statusCode).toBe(400);expect(f.posts).toHaveLength(0);
  });
  it('rechecks source after client discovery and does not send with a stale settings snapshot',async()=>{
    const f=await fixture();const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    f.changeSourceOnNextClientList();
    await expect(f.runtime.commitExecution({confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'source-race'})).rejects.toThrow('source-changed');
    expect(f.posts).toHaveLength(0);
  });
  it('stores candidate source identity from the capability snapshot during in-flight research',async()=>{
    const f=await fixture();
    const token=f.runtime.createProwlarrMcpCapability(f.searchId).token;
    const original=f.runtime.getSettings();
    const originalFingerprint=createHash('sha256').update(`prowlarr\0${original.integrations.prowlarr.url}\0${original.integrations.prowlarr.apiKey}`).digest('hex');
    f.runtime.saveSettings({...original,integrations:{...original.integrations,prowlarr:{...original.integrations.prowlarr,url:'http://127.0.0.1:1'}}});
    const found=await f.runtime.prowlarrSearch(token,{query:'Example'});
    const id=(found[0] as {candidateId:string}).candidateId;
    const stored=f.runtime.store.getCandidate(f.searchId,id)!;
    expect((stored.privateData as {sourceFingerprint:string}).sourceFingerprint).toBe(originalFingerprint);
    f.runtime.revokeProwlarrMcpCapability(token);
  });
  it('does not close the database under a blocked POST and stops the tail after shutdown starts',async()=>{
    const f=await fixture('delay-first');const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const commit=f.runtime.commitExecution({confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'close-drain'});
    await f.postSeen;
    const closing=f.runtime.close();
    expect(()=>f.runtime.store.getSearch(f.searchId)).not.toThrow();
    f.releaseDelayedPost();
    const receipt=await commit;
    await closing;
    expect(receipt).toMatchObject({outcome:'partial',children:[{outcome:'submitted'},{outcome:'not-attempted'}]});
    expect(f.posts).toHaveLength(1);
  });
  it('fences lease loss during a POST and leaves a durable uncertain receipt without sending the tail',async()=>{
    const f=await fixture('delay-first');const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const body={confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'lost-owner'};
    const commit=f.runtime.commitExecution(body);
    await f.postSeen;
    const row=f.runtime.store.executionByKey(body.idempotencyKey)!;
    f.advance(31_000);expect(f.runtime.store.recoverExecutions(Date.now()+31_000)).toBe(1);
    f.releaseDelayedPost();
    await expect(commit).rejects.toThrow('execution-ownership-lost');
    const recovered=f.runtime.executionReceipt(row.id)!;
    expect(recovered).toMatchObject({outcome:'uncertain',children:[{outcome:'uncertain'},{outcome:'not-attempted'}]});
    expect(f.posts).toHaveLength(1);
  });
  it('revalidates settings before the next child after an accepted first send',async()=>{
    const f=await fixture('delay-first');const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const commit=f.runtime.commitExecution({confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'settings-between'});
    await f.postSeen;
    f.runtime.saveSettings({...f.runtime.getSettings(),safety:{dryRun:true}});
    f.releaseDelayedPost();
    const receipt=await commit;
    expect(receipt).toMatchObject({outcome:'partial',children:[{outcome:'submitted'},{outcome:'not-attempted'}]});
    expect(f.posts).toHaveLength(1);
  });
  it('serializes concurrent same-key commit requests to one physical send set',async()=>{
    const f=await fixture();const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const body={confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'concurrent-key'};
    const [one,two]=await Promise.all([f.runtime.commitExecution(body),f.runtime.commitExecution(body)]);
    expect((one as {outcome:string}).outcome).toMatch(/running|submitted/);
    expect((two as {outcome:string}).outcome).toMatch(/running|submitted/);
    expect(f.posts).toHaveLength(2);
  });

  it('allows only one concurrent execution with different keys over the same physical release set',async()=>{
    const f=await fixture('delay-first');
    const first=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const second=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const firstCommit=f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:{confirmationId:first.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'different-key-one'}});
    await f.postSeen;
    const secondCommit=await f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:{confirmationId:second.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'different-key-two'}});
    expect(secondCommit.statusCode).toBe(409);
    f.releaseDelayedPost();
    expect((await firstCommit).statusCode).toBe(200);
    expect(f.posts).toHaveLength(2);
    expect(f.posts.map(post=>(post as {guid:string}).guid)).toEqual(['guid-0','guid-1']);
  });

  it('conflicts when an idempotency key is reused with a different confirmation',async()=>{
    const f=await fixture();
    const first=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const second=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const body=(confirmationId:string)=>({confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'same-key-different-confirmation'});
    expect((await f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:body(first.confirmationId)})).statusCode).toBe(200);
    const conflict=await f.app.inject({method:'POST',url:'/api/v2/executions/commit',payload:body(second.confirmationId)});
    expect(conflict.statusCode).toBe(409);
    expect(f.posts).toHaveLength(2);
  });

  it('treats accepted-but-timeout as uncertain and makes dry-run zero POSTs',async()=>{
    const uncertain=await fixture('timeout');const c=await uncertain.runtime.prepareExecution({searchId:uncertain.searchId,planId:'plan-one',version:2,candidateIds:uncertain.candidateIds,downloadClientId:7});
    const receipt=await uncertain.runtime.commitExecution({confirmationId:c.confirmationId,searchId:uncertain.searchId,planId:'plan-one',version:2,idempotencyKey:'timeout-key'});
    expect(receipt).toMatchObject({outcome:'uncertain',children:[{outcome:'uncertain'},{outcome:'not-attempted'}]});expect(uncertain.posts).toHaveLength(1);
    const dry=await fixture('accept',true);const d=await dry.runtime.prepareExecution({searchId:dry.searchId,planId:'plan-one',version:2,candidateIds:dry.candidateIds,downloadClientId:7});
    expect(await dry.runtime.commitExecution({confirmationId:d.confirmationId,searchId:dry.searchId,planId:'plan-one',version:2,idempotencyKey:'dry-key'})).toMatchObject({outcome:'dry-run',children:[{outcome:'dry-run'},{outcome:'dry-run'}]});
    expect(dry.posts).toHaveLength(0);
  });

  it('records a real HTTP timeout after Prowlarr receives the POST as uncertain and never retries the tail',async()=>{
    const f=await fixture('hang',false,false,{httpTimeoutMs:50});
    const c=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const body={confirmationId:c.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'real-http-timeout'};
    const receipt=await f.runtime.commitExecution(body);
    expect(receipt).toMatchObject({outcome:'uncertain',children:[{outcome:'uncertain'},{outcome:'not-attempted'}]});
    expect(f.posts).toHaveLength(1);
    expect(await f.runtime.commitExecution(body)).toEqual(receipt);
    expect(f.posts).toHaveLength(1);
  });

  it('automatically recovers an expired execution after runtime restart and replays uncertainty without a resend',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'media-scout-recovery-')),databasePath=join(directory,'search.db');
    const f=await fixture('accept',false,false,{databasePath});
    const confirmation=await f.runtime.prepareExecution({searchId:f.searchId,planId:'plan-one',version:2,candidateIds:f.candidateIds,downloadClientId:7});
    const requestHash=createHash('sha256').update(JSON.stringify({confirmationId:confirmation.confirmationId,searchId:f.searchId,planId:'plan-one',version:2})).digest('hex');
    f.runtime.store.createExecution({id:'restart-operation',key:'restart-key',hash:requestHash,searchId:f.searchId,planId:'plan-one',version:2,payload:{confirmationId:confirmation.confirmationId,client:{id:7,name:'TV client',protocol:'torrent'},clientName:'TV client',dryRun:false},children:[{candidateId:f.candidateIds[0]!,physicalKey:'physical-restart',state:'sending'},{candidateId:f.candidateIds[1]!,physicalKey:'physical-restart-tail',state:'prepared'}],owner:'crashed-owner',now:f.now(),leaseUntil:f.now()+30_000});
    const settings=f.runtime.getSettings();
    await f.runtime.close();
    let restartNow=f.now();
    const restarted=new SearchRuntime({store:openSearchStore(databasePath),initialSettings:settings,now:()=>restartNow});
    try {
      expect((await restarted.getSearch(f.searchId))?.receipts).toMatchObject([{outcome:'running',children:[{outcome:'sending'},{outcome:'prepared'}]}]);
      restartNow+=31_000;
      const recovered=await restarted.getSearch(f.searchId);
      expect(recovered?.receipts).toMatchObject([{outcome:'uncertain',children:[{outcome:'uncertain'},{outcome:'not-attempted'}]}]);
      const replay=await restarted.commitExecution({confirmationId:confirmation.confirmationId,searchId:f.searchId,planId:'plan-one',version:2,idempotencyKey:'restart-key'});
      expect(replay).toMatchObject({outcome:'uncertain'});
      expect(f.posts).toHaveLength(0);
    } finally {await restarted.close();rmSync(directory,{recursive:true,force:true});}
  });

  it('requires fresh confirmation after source or safety changes and rejects expired candidates',async()=>{
    const changed=await fixture();const c=await changed.runtime.prepareExecution({searchId:changed.searchId,planId:'plan-one',version:2,candidateIds:changed.candidateIds,downloadClientId:7});
    const settings=changed.runtime.getSettings();changed.runtime.saveSettings({...settings,safety:{dryRun:true}});
    await expect(changed.runtime.commitExecution({confirmationId:c.confirmationId,searchId:changed.searchId,planId:'plan-one',version:2,idempotencyKey:'safety-change'})).rejects.toThrow('safety-changed');
    const sourceChanged=await fixture();const p=await sourceChanged.runtime.prepareExecution({searchId:sourceChanged.searchId,planId:'plan-one',version:2,candidateIds:sourceChanged.candidateIds,downloadClientId:7});
    sourceChanged.runtime.saveSettings({...sourceChanged.runtime.getSettings(),integrations:{...sourceChanged.runtime.getSettings().integrations,prowlarr:{...sourceChanged.runtime.getSettings().integrations.prowlarr,url:'http://127.0.0.1:1'}}});
    await expect(sourceChanged.runtime.commitExecution({confirmationId:p.confirmationId,searchId:sourceChanged.searchId,planId:'plan-one',version:2,idempotencyKey:'source-change'})).rejects.toThrow('source-changed');
    const clientChanged=await fixture();const clientPrep=await clientChanged.runtime.prepareExecution({searchId:clientChanged.searchId,planId:'plan-one',version:2,candidateIds:clientChanged.candidateIds,downloadClientId:7});
    clientChanged.setClientName('Renamed client');
    await expect(clientChanged.runtime.commitExecution({confirmationId:clientPrep.confirmationId,searchId:clientChanged.searchId,planId:'plan-one',version:2,idempotencyKey:'client-change'})).rejects.toThrow('client-changed');
    const expired=await fixture();const e=await expired.runtime.prepareExecution({searchId:expired.searchId,planId:'plan-one',version:2,candidateIds:expired.candidateIds,downloadClientId:7});
    expired.runtime.store.expireCandidatesAt(expired.searchId,0);
    await expect(expired.runtime.commitExecution({confirmationId:e.confirmationId,searchId:expired.searchId,planId:'plan-one',version:2,idempotencyKey:'expired'})).rejects.toThrow('candidate-expired');
    expect(changed.posts).toHaveLength(0);expect(sourceChanged.posts).toHaveLength(0);expect(clientChanged.posts).toHaveLength(0);expect(expired.posts).toHaveLength(0);
  });
});
