import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { SearchRuntime, type RuntimeClients } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';
import { releaseSchema } from '../src/types/prowlarr';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiError, Http } from '../src/http';
import { ProwlarrClient } from '../src/clients/prowlarr';
import { seriesListSchema } from '../src/types/sonarr';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(clientOverride?: RuntimeClients, now?: () => number) {
  let reads = 0, grabs = 0;
  const initialSettings = { ...defaultSettings, ai: { ...defaultSettings.ai, apiKey: 'private-model' }, integrations: { ...defaultSettings.integrations, prowlarr: { ...defaultSettings.integrations.prowlarr, url: 'http://indexer.test', apiKey: 'private-indexer' }, sonarr: { url: 'http://sonarr.test', apiKey: 'private-sonarr' }, radarr: { url: '', apiKey: '' } } };
  const runtime = new SearchRuntime({
    store: openSearchStore(':memory:'), initialSettings, now,
    clients: () => clientOverride ?? ({
      prowlarr: {
         getIndexers: async () => { reads++; return [{ id: 1, name: 'Index', enable: true }]; },
         getIndexerStatuses: async () => { reads++; return []; }, search: async () => { reads++; return []; },
         getDownloadClients: async () => { reads++; return [{ id: 7, name: 'TV', protocol: 'torrent', enable: true, supportsCategories: true, categories: [] }]; },
        grab: async () => { grabs++; },
      },
    } as unknown as RuntimeClients),
  });
  const stack = { runtime, config: { HTTP_HOST: '127.0.0.1', HTTP_PORT: 7877, DB_PATH: ':memory:', LOG_LEVEL: 'silent' }, logger: pino({ level: 'silent' }) } as unknown as Stack;
  const app = await buildApp(stack, { webRoot: '/nonexistent-ui' });
  cleanups.push(async () => { await app.close(); await runtime.close(); });
  return { app, runtime, reads: () => reads, grabs: () => grabs };
}
async function drainScheduled(runtime:SearchRuntime):Promise<void>{await new Promise<void>(resolve=>setImmediate(resolve));await runtime.drain();}

describe('search-first HTTP contract', () => {
  it('accepts an idempotent acquisition without upstream calls before durable queueing', async () => {
    const { app, runtime, reads } = await fixture();
    runtime.store.setProviderDeadline('model',Date.now()+60_000);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing daemon listener');
    const base=`http://127.0.0.1:${address.port}`;
    const payload = { prompt: 'Find the film', downloadClientId: 7 };
    const post=(key:string,body=payload)=>fetch(`${base}/api/v2/acquisitions`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    const [first,replay] = await Promise.all([
      post('intake-33'),
      post('intake-33'),
    ]);
    expect(first.status).toBe(202);
    const firstBody=await first.json() as {searchId:string;status:string;statusUrl:string},replayBody=await replay.json() as {searchId:string},searchId=firstBody.searchId;
    expect(firstBody).toMatchObject({ searchId, status: 'queued', statusUrl: `/api/v2/searches/${searchId}` });
    expect(reads()).toBe(0);
    expect(replay.status).toBe(202);
    expect(replayBody.searchId).toBe(searchId);
    expect((await post('intake-33',{...payload,prompt:'Other'})).status).toBe(409);
    expect((await fetch(`${base}/api/v2/acquisitions`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'bad'},body:JSON.stringify({...payload,extra:true})})).status).toBe(400);
    expect((await fetch(`${base}/api/v2/acquisitions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).status).toBe(400);
    expect((await post('bad key')).status).toBe(400);
    expect((await post('bad-client',{...payload,downloadClientId:0})).status).toBe(400);
    await runtime.drain();
    const detail=await fetch(`${base}${firstBody.statusUrl}`);
    expect(await detail.json()).toMatchObject({ source: 'manual', manualExecutionEligible: false, acquisition: { downloadClientId: 7 } });
  });
  it('deduplicates before requiring configuration and never turns a durable acceptance into an error',async()=>{
    const {app,runtime}=await fixture();
    runtime.store.setProviderDeadline('model',Date.now()+60_000);
    await app.listen({host:'127.0.0.1',port:0});
    const runtimeInternals=runtime as unknown as {dispatchQueued:()=>void};
    const dispatch=runtimeInternals.dispatchQueued;
    runtimeInternals.dispatchQueued=()=>{throw new Error('simulated dispatch failure');};
    const payload={prompt:'Same request',downloadClientId:7},headers={'idempotency-key':'settings-independent-key'};
    const accepted=await app.inject({method:'POST',url:'/api/v2/acquisitions',headers,payload});
    await new Promise<void>(resolve=>setImmediate(resolve));
    runtimeInternals.dispatchQueued=dispatch;
    expect(accepted.statusCode).toBe(202);
    const {searchId}=accepted.json();
    const settings=runtime.getSettings();
    runtime.saveSettings({...settings,integrations:{...settings.integrations,prowlarr:{...settings.integrations.prowlarr,url:'',apiKey:'',tvClientId:null,movieClientId:null}}});
    expect((await app.inject({method:'POST',url:'/api/v2/acquisitions',headers,payload})).json().searchId).toBe(searchId);
    expect((await app.inject({method:'POST',url:'/api/v2/acquisitions',headers,payload:{...payload,prompt:'Different'}})).statusCode).toBe(409);
  });
  it('accepts a socket burst into the shared three-worker FIFO and dispatches the durable tail',async()=>{
    let started=0,releaseFirst!:()=>void,releaseTail!:()=>void,firstThree!:()=>void,allFive!:()=>void;
    const firstGate=new Promise<void>(resolve=>{releaseFirst=resolve;}),tailGate=new Promise<void>(resolve=>{releaseTail=resolve;});
    const firstStarted=new Promise<void>(resolve=>{firstThree=resolve;}),tailStarted=new Promise<void>(resolve=>{allFive=resolve;});
    const startedPrompts:string[]=[];
    const model=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString()) as {input:string};
      started++;startedPrompts.push(body.input);
      if(started===3)firstThree();if(started===5)allFive();
      await(started<=3?firstGate:tailGate);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:`burst-${started}`,object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:`final-${started}`,type:'function_call',call_id:`final-${started}`,name:'finalize_release_set',arguments:JSON.stringify({status:'no-match',selections:[],covered:[],gaps:['No release observed'],deferred:[],broadCoverage:'none',scopeGaps:[]}),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const modelAddress=model.address();if(!modelAddress||typeof modelAddress==='string')throw new Error('No gated model listener');
    const {app,runtime}=await fixture();
    try{
      runtime.saveSettings({...runtime.getSettings(),ai:{...runtime.getSettings().ai,baseUrl:`http://127.0.0.1:${modelAddress.port}`}});
      await app.listen({host:'127.0.0.1',port:0});const listener=app.server.address();if(!listener||typeof listener==='string')throw new Error('No daemon listener');
      const base=`http://127.0.0.1:${listener.port}`;
      const ids:string[]=[];
      for(let i=0;i<5;i++){
        // Order HTTP acceptance, but don't release any of the search workers.
        const response=await fetch(`${base}/api/v2/acquisitions`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':`burst-${i}`},body:JSON.stringify({prompt:`Burst prompt ${i}`,downloadClientId:7})});
        expect(response.status).toBe(202);
        ids.push((await response.json() as {searchId:string}).searchId);
      }
      await Promise.race([firstStarted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('first three workers did not start')),10_000))]);
      const before=await Promise.all(ids.map(async id=>(await (await fetch(`${base}/api/v2/searches/${id}`)).json() as {status:string}).status));
      expect(before.filter(status=>status==='running')).toHaveLength(3);
      expect(before.filter(status=>status==='queued')).toHaveLength(2);
      expect(before.slice(0,3)).toEqual(['running','running','running']);
      expect(before.slice(3)).toEqual(['queued','queued']);
      expect(new Set(startedPrompts)).toEqual(new Set(['Burst prompt 0','Burst prompt 1','Burst prompt 2']));
      releaseFirst();
      await Promise.race([tailStarted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('queued tail did not dispatch')),10_000))]);
      expect(new Set(startedPrompts)).toEqual(new Set(ids.map((_,i)=>`Burst prompt ${i}`)));
      const duringTail=await Promise.all(ids.map(async id=>(await (await fetch(`${base}/api/v2/searches/${id}`)).json() as {status:string}).status));
      expect(duringTail.filter(status=>status==='running')).toHaveLength(2);
      expect(duringTail.filter(status=>status==='no-match')).toHaveLength(3);
      expect(duringTail.slice(0,3)).toEqual(['no-match','no-match','no-match']);
      expect(duringTail.slice(3)).toEqual(['running','running']);
      releaseTail();await runtime.drain();
    }finally{
      releaseFirst();releaseTail();await app.close();await runtime.close();await new Promise<void>(resolve=>model.close(()=>resolve()));
    }
  },30_000);
  it.each([true,false])('acquisition executes the entire selected set with dryRun=%s', async dryRun => {
    let runtimeRef:SearchRuntime|undefined,calls=0,grabs=0;
    const releases=[0,1].map(i=>releaseSchema.parse({guid:`acq-${i}`,age:1,size:100,files:null,grabs:null,indexerId:1,indexer:'Index',subGroup:null,title:`Film 2020 part ${i}`,tvdbId:null,tmdbId:null,publishDate:'',downloadUrl:null,indexerFlags:[],categories:[],magnetUrl:null,infoHash:String(i+1).repeat(40),seeders:1,leechers:0,protocol:'torrent',downloadClientId:null}));
    const model=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString()) as {tools?:Array<{name?:string}>};calls++;
      const searchId=runtimeRef!.activity().items[0]!.searchId,ids=runtimeRef!.store.listCandidates(searchId).map(x=>x.candidateId);
      const name=calls===1?(body.tools?.find(t=>t.name?.includes('prowlarr_search'))?.name??'prowlarr_search'):'finalize_release_set';
      const args=name.includes('prowlarr_search')?{query:'Film'}:{status:'matched',selections:ids.map(candidateId=>({candidateId,coverage:'The requested films',reason:'Observed in Prowlarr',uncertainty:''})),covered:['The requested films'],gaps:[],deferred:[],broadCoverage:'complete',scopeGaps:[]};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:`acquisition-${calls}`,object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:`call-${calls}`,type:'function_call',call_id:`call-${calls}`,name,arguments:JSON.stringify(args),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const address=model.address();if(!address||typeof address==='string')throw new Error('No model fixture');
    const {app,runtime}=await fixture({prowlarr:{getIndexers:async()=>[{id:1,name:'Index',enable:true}],getIndexerStatuses:async()=>[],search:async()=>releases,getDownloadClients:async()=>[{id:7,name:'TV',protocol:'torrent',enable:true,supportsCategories:true,categories:[]}],grab:async()=>{grabs++;}}});
    runtimeRef=runtime;
    try{
      runtime.saveSettings({...runtime.getSettings(),ai:{...runtime.getSettings().ai,baseUrl:`http://127.0.0.1:${address.port}`},safety:{dryRun}});
      await app.listen({host:'127.0.0.1',port:0});
      const accepted=await app.inject({method:'POST',url:'/api/v2/acquisitions',headers:{'idempotency-key':`acq-${dryRun}`},payload:{prompt:'Find two films',downloadClientId:7}});
      expect(accepted.statusCode).toBe(202);
      await drainScheduled(runtime);
      const detail=(await app.inject(accepted.json().statusUrl)).json();
      expect(detail).toMatchObject({status:'matched',manualExecutionEligible:false,acquisition:{downloadClientId:7,status:dryRun?'dry-run':'submitted'},receipts:[{children:[{outcome:dryRun?'dry-run':'submitted'},{outcome:dryRun?'dry-run':'submitted'}]}]});
      const manualPrepare=await app.inject({method:'POST',url:'/api/v2/executions/prepare',payload:{searchId:detail.searchId,planId:detail.plan.planId,version:detail.plan.version,candidateIds:detail.plan.selections.map((item:{candidateId:string})=>item.candidateId),downloadClientId:7}});
      expect(manualPrepare.statusCode).toBe(409);
      expect(grabs).toBe(dryRun?0:2);
    }finally{await app.close();await runtime.close();await new Promise<void>(resolve=>model.close(()=>resolve()));}
  });
  it.each(['submitted','no-match','disabled-client','protocol-mismatch','routing-changed','rate-limited','rate-limited-validation','rate-limited-tail'] as const)('uses the real Prowlarr HTTP adapter for acquisition outcome %s',async scenario=>{
    let runtimeRef:SearchRuntime|undefined,modelCalls=0,clientReads=0;const grabs:Array<{downloadClientId:number;guid:string}>=[];
    const release=releaseSchema.parse({guid:'real-http-grab',age:1,size:100,files:null,grabs:null,indexerId:1,indexer:'Index',subGroup:null,title:'Film 2020',tvdbId:null,tmdbId:null,publishDate:'',downloadUrl:'http://prowlarr.test/download',indexerFlags:[],categories:[],magnetUrl:null,infoHash:'e'.repeat(40),seeders:1,leechers:0,protocol:'torrent',downloadClientId:null});
    const releases=[release,{...release,guid:'real-http-grab-2',title:'Film 2021',infoHash:'f'.repeat(40)}];
    const prowlarrServer=createServer(async(req,res)=>{
      const url=new URL(req.url??'/',`http://${req.headers.host}`);
      if(req.method==='GET'&&url.pathname==='/api/v1/indexer')return res.end(JSON.stringify([{id:1,name:'Index',enable:true}]));
      if(req.method==='GET'&&url.pathname==='/api/v1/indexerstatus')return res.end('[]');
      if(req.method==='GET'&&url.pathname==='/api/v1/search')return res.end(JSON.stringify(releases));
      if(req.method==='GET'&&url.pathname==='/api/v1/downloadclient'){
        clientReads++;
        if(scenario==='rate-limited'||(scenario==='rate-limited-validation'&&clientReads===2)||(scenario==='rate-limited-tail'&&grabs.length)){
          res.writeHead(429,{'retry-after':'37'});return res.end('{"error":"PRIVATE-UPSTREAM-CANARY"}');
        }
        return res.end(JSON.stringify([{id:7,name:'Selected',enable:scenario!=='disabled-client'&&!(scenario==='routing-changed'&&grabs.length),protocol:scenario==='protocol-mismatch'?'usenet':'torrent',supportsCategories:true,categories:[]}]));
      }
      if(req.method==='POST'&&url.pathname==='/api/v1/search'){
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        grabs.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'content-type':'application/json'});return res.end('{}');
      }
      res.writeHead(404);res.end();
    });
    await new Promise<void>(resolve=>prowlarrServer.listen(0,'127.0.0.1',resolve));const pAddress=prowlarrServer.address();if(!pAddress||typeof pAddress==='string')throw new Error('No Prowlarr HTTP fixture');
    const model=createServer(async(req,res)=>{
      for await(const _chunk of req) { /* consume */ }modelCalls++;
      const searchId=runtimeRef!.activity().items[0]!.searchId,candidates=runtimeRef!.store.listCandidates(searchId).map(item=>item.candidateId);
      const name=modelCalls===1?'prowlarr_search':'finalize_release_set';
      const args=name==='prowlarr_search'?{query:'Film'}:scenario==='no-match'?{status:'no-match',selections:[],covered:[],gaps:['No suitable release'],deferred:[],broadCoverage:'none',scopeGaps:[]}:{status:'matched',selections:candidates.map(candidateId=>({candidateId,coverage:'The films',reason:'Observed release',uncertainty:''})),covered:['The films'],gaps:[],deferred:[],broadCoverage:'complete',scopeGaps:[]};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:`http-${modelCalls}`,object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:`call-${modelCalls}`,type:'function_call',call_id:`call-${modelCalls}`,name,arguments:JSON.stringify(args),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const mAddress=model.address();if(!mAddress||typeof mAddress==='string')throw new Error('No model fixture');
    const adapter=new ProwlarrClient(new Http({baseUrl:`http://127.0.0.1:${pAddress.port}`,apiKey:'fixture-key'}));
    const now=Date.now();
    const {app,runtime}=await fixture({prowlarr:adapter as unknown as RuntimeClients['prowlarr']},()=>now);runtimeRef=runtime;
    try{
      runtime.saveSettings({...runtime.getSettings(),ai:{...runtime.getSettings().ai,baseUrl:`http://127.0.0.1:${mAddress.port}`},safety:{dryRun:false}});
      await app.listen({host:'127.0.0.1',port:0});
      const response=await app.inject({method:'POST',url:'/api/v2/acquisitions',headers:{'idempotency-key':`real-${scenario}`},payload:{prompt:'Find Film',downloadClientId:7}});
      expect(response.statusCode).toBe(202);await drainScheduled(runtime);
      const detail=await runtime.getSearch(response.json().searchId);
      if(scenario==='rate-limited'||scenario==='rate-limited-validation'||scenario==='rate-limited-tail'){
        if(scenario!=='rate-limited-tail'){
          expect(detail).toMatchObject({status:'matched',acquisition:{status:'not-attempted',code:'prowlarr-rate-limited'},receipts:[]});
          expect(grabs).toHaveLength(0);
        }else{
          expect(detail).toMatchObject({status:'matched',acquisition:{status:'partial'},receipts:[{children:[
            {outcome:'submitted'}, {outcome:'not-attempted',message:expect.stringMatching(/Prowlarr rate-limited/)}
          ]}]});
          expect(grabs).toEqual([{indexerId:1,downloadClientId:7,guid:release.guid}]);
        }
        expect(JSON.stringify(detail)).not.toContain('PRIVATE-UPSTREAM-CANARY');
        const next=await app.inject({method:'POST',url:'/api/v2/acquisitions',headers:{'idempotency-key':'queued-during-prowlarr-cooldown'},payload:{prompt:'Find another film',downloadClientId:7}});
        expect(next.statusCode).toBe(202);
        await drainScheduled(runtime);
        expect((await app.inject(next.json().statusUrl)).json()).toMatchObject({status:'queued',waitingReason:'provider-cooldown',retryAt:new Date(now+37_000).toISOString()});
        expect(modelCalls).toBe(2);
      }else if(scenario==='no-match'){
        expect(detail).toMatchObject({status:'no-match',acquisition:{status:'not-attempted'}});
        expect(grabs).toHaveLength(0);
      }else if(scenario==='disabled-client'||scenario==='protocol-mismatch'){
        expect(detail).toMatchObject({status:'matched',acquisition:{status:'not-attempted',code:scenario==='disabled-client'?'download-client-unavailable':'download-client-protocol-mismatch'}});
        expect(grabs).toHaveLength(0);
      }else if(scenario==='routing-changed'){
        expect(detail).toMatchObject({status:'matched',acquisition:{status:'partial'},receipts:[{children:[{outcome:'submitted'},{outcome:'not-attempted'}]}]});
        expect(grabs).toEqual([{indexerId:1,downloadClientId:7,guid:release.guid}]);
      }else{
        expect(detail).toMatchObject({status:'matched',acquisition:{status:'submitted'},receipts:[{children:[{outcome:'submitted'},{outcome:'submitted'}]}]});
        expect(grabs).toEqual(releases.map(item=>({indexerId:1,downloadClientId:7,guid:item.guid})));
      }
    }finally{
      await app.close();await runtime.close();
      await Promise.all([new Promise<void>(resolve=>model.close(()=>resolve())),new Promise<void>(resolve=>prowlarrServer.close(()=>resolve()))]);
    }
  });
  it.each(['dry-run','prowlarr-source'] as const)('stops an accepted acquisition before research when %s changes while queued', async change=>{
    let now=Date.now();const {app,runtime,reads}=await fixture(undefined,()=>now);
    runtime.store.setProviderDeadline('model',now+100);
    await app.listen({host:'127.0.0.1',port:0});
    const accepted=await app.inject({method:'POST',url:'/api/v2/acquisitions',headers:{'idempotency-key':'queued-settings-change'},payload:{prompt:'Find a title',downloadClientId:7}});
    expect(accepted.statusCode).toBe(202);
    if(change==='dry-run')runtime.saveSettings({...runtime.getSettings(),safety:{dryRun:false}});
    else {
      const current=runtime.getSettings();
      runtime.saveSettings({...current,integrations:{...current.integrations,prowlarr:{...current.integrations.prowlarr,url:'http://changed-indexer.test',apiKey:'changed-key'}}});
    }
    now+=101;
    runtime.setInternalMcpUrl('http://127.0.0.1:1/internal/mcp/prowlarr');
    await runtime.drain();
    const detail=(await app.inject(accepted.json().statusUrl)).json();
    expect(detail).toMatchObject({status:'failed',acquisition:{status:'not-attempted',code:change==='dry-run'?'safety-changed':'source-changed'}});
    expect(reads()).toBe(0);
  });
  it('dispatches unclaimed acquisitions but does not replay started acquisitions after a listener restart',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'acquisition-restart-')),path=join(directory,'state.sqlite');
    let modelCalls=0;
    const model=createServer(async(req,res)=>{
      for await(const _chunk of req) { /* consume */ }modelCalls++;
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:'restart-no-match',object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:'restart-finalize',type:'function_call',call_id:'restart-finalize',name:'finalize_release_set',arguments:JSON.stringify({status:'no-match',selections:[],covered:[],gaps:['No suitable release observed'],deferred:[],broadCoverage:'none',scopeGaps:[]}),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const modelAddress=model.address();if(!modelAddress||typeof modelAddress==='string')throw new Error('No restart model fixture');
    const settings={...defaultSettings,ai:{...defaultSettings.ai,apiKey:'fixture-model',baseUrl:`http://127.0.0.1:${modelAddress.port}`},integrations:{...defaultSettings.integrations,prowlarr:{...defaultSettings.integrations.prowlarr,url:'http://indexer.test',apiKey:'fixture-indexer'}}};
    const sourceFingerprint=createHash('sha256').update(`prowlarr\0${settings.integrations.prowlarr.url}\0${settings.integrations.prowlarr.apiKey}`).digest('hex');
    const seeded=openSearchStore(path);
    const now=Date.now(),startedAt=now-60_000;
    const seedRequest=(key:string,prompt:string,at:number)=>seeded.acceptAcquisition({key,hash:createHash('sha256').update(JSON.stringify({prompt,downloadClientId:7})).digest('hex'),now:at,snapshot:()=>({prompt,clientId:7,sourceFingerprint,dryRun:true})});
    const matched=seedRequest('before-journal','Matched before crash',startedAt);
    expect(seeded.claimNextSearch('worker',startedAt,5_000)?.searchId).toBe(matched.searchId);
    expect(seeded.finishOwnedSearch(matched.searchId,'worker','matched',{version:1},startedAt+1,true)).toBe(true);
    const sending=seedRequest('sending','Sending before crash',startedAt+2);
    expect(seeded.claimNextSearch('worker-2',startedAt+3,5_000)?.searchId).toBe(sending.searchId);
    expect(seeded.finishOwnedSearch(sending.searchId,'worker-2','matched',{version:1},startedAt+4,true)).toBe(true);
    expect(seeded.createExecution({id:'sending-execution',key:`!acquisition:${sending.searchId}`,hash:'execution',searchId:sending.searchId,planId:'plan',version:2,payload:{dryRun:false},children:[{candidateId:'release',physicalKey:'release',state:'prepared'}],owner:'sender',now:startedAt+5,leaseUntil:startedAt+5_000})).toBe('created');
    expect(seeded.updateExecutionChild('sending-execution','sender',startedAt+6,0,'sending')).toBe(true);
    const accepted=seedRequest('survives-restart','Search after restart',now);
    expect(seeded.getSearch(accepted.searchId)?.status).toBe('queued');
    seeded.setSetting('application-settings',settings);seeded.close();
    let grabs=0;
    const runtime=new SearchRuntime({databasePath:path,clients:()=>({prowlarr:{getIndexers:async()=>[],getIndexerStatuses:async()=>[],search:async()=>[],getDownloadClients:async()=>[],grab:async()=>{grabs++;}}}),initialSettings:settings});
    const stack={runtime,config:{HTTP_HOST:'127.0.0.1',HTTP_PORT:7877,DB_PATH:path,LOG_LEVEL:'silent'},logger:pino({level:'silent'})} as unknown as Stack;
    const app=await buildApp(stack,{webRoot:'/nonexistent-ui'});
    try{
      const base=await app.listen({host:'127.0.0.1',port:0});
      const replay=async(key:string,prompt:string)=>{
        const response=await fetch(`${base}/api/v2/acquisitions`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({prompt,downloadClientId:7})});
        expect(response.status).toBe(202);
        return response.json();
      };
      expect(await replay('before-journal','Matched before crash')).toMatchObject({searchId:matched.searchId});
      expect(await replay('sending','Sending before crash')).toMatchObject({searchId:sending.searchId});
      await drainScheduled(runtime);
      expect(modelCalls).toBe(1);
      expect(await runtime.getSearch(accepted.searchId)).toMatchObject({status:'no-match',acquisition:{status:'not-attempted'},receipts:[]});
      expect(await runtime.getSearch(matched.searchId)).toMatchObject({acquisition:{status:'interrupted'},receipts:[]});
      expect(await runtime.getSearch(sending.searchId)).toMatchObject({acquisition:{status:'uncertain'},receipts:[{outcome:'uncertain',children:[{outcome:'uncertain'}]}]});
      expect(grabs).toBe(0);
    }finally{
      await app.close();await runtime.close();await new Promise<void>(resolve=>model.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});
    }
  },15_000);
  it('bounds activity prompt previews without losing tail search or detail', async () => {
    const { app, runtime } = await fixture();
    const prefix = `${'x'.repeat(238)}🧪`;
    const long = `${prefix}\nDistinctive-tail`;
    const now = Date.now();
    runtime.store.createSearch({ searchId: 'long', prompt: JSON.stringify({ version: 3, prompt: long, kind: 'tv' }), status: 'no-match', createdAt: now });
    runtime.store.setSetting('search-source:long', 'automation');
    runtime.store.createSearch({ searchId: 'short', prompt: JSON.stringify({ version: 1, request: { prompt: 'Short legacy title' } }), status: 'no-match', createdAt: now - 1 });
    const response = await app.inject({ method: 'GET', url: '/api/v2/activity?q=distinctive-tail&source=automation&kind=tv' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, items: [{ searchId: 'long', prompt: `${prefix}…` }] });
    const page = await app.inject({ method: 'GET', url: '/api/v2/activity?limit=1&offset=1' });
    expect(page.json()).toMatchObject({ total: 2, items: [{ searchId: 'short', prompt: 'Short legacy title' }] });
    const detail = await app.inject({ method: 'GET', url: '/api/v2/searches/long' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().prompt).toBe(long);
  });
  it('keeps research MCP credentials out of API reads and stores disabled connections without probing', async () => {
    const store = openSearchStore(':memory:');
    const runtime = new SearchRuntime({ store });
    const stack = { runtime, config: {}, logger: pino({ level: 'silent' }) } as unknown as Stack;
    const app = await buildApp(stack, { webRoot: '/nonexistent-ui' });
    cleanups.push(async () => { await app.close(); await runtime.close(); });
    const created = await app.inject({ method: 'POST', url: '/api/research-mcp', payload: { name: 'Local', url: 'http://127.0.0.1:4141/mcp', enabled: false, credential: { mode: 'replace', header: 'X-Key', value: 'never-echo-this' } } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('never-echo-this');
    const read = await app.inject({ method: 'GET', url: '/api/research-mcp' });
    expect(read.json()).toMatchObject({ servers: [{ id: created.json().id, name: 'Local', url: 'http://127.0.0.1:4141/mcp', enabled: false, credentialConfigured: true, toolNames: [] }] });
    expect(read.body).not.toContain('never-echo-this');
  });

  it('keeps scheduled automation disabled until explicitly activated', async () => {
    const { runtime, reads } = await fixture();
    await expect(runtime.runAutomation()).resolves.toMatchObject({ ran: false, reason: 'automation-disabled' });
    expect(reads()).toBe(0);
  });
  it('does not apply saved automation preferences to an explicit manual search', async () => {
    const { app, runtime } = await fixture();
    await app.listen({ host: '127.0.0.1', port: 0 });
    runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, preferences: 'automation-only-note' } });
    runtime.store.setProviderDeadline('model', Date.now() + 60_000);
    const started = await runtime.startSearch({ prompt: 'Manual preference scope\nPrefer HEVC; omit private-sonarr' });
    const status = await runtime.getSearch(started.searchId);
    expect(status?.prompt).toBe('Manual preference scope\nPrefer HEVC; omit [redacted]');
    expect(status).not.toHaveProperty('normalizedRequest');
    await app.close(); await runtime.close();
  });
  it('scheduled pass observes complete state under the shared lease but does not create work when nothing is missing', async () => {
    const { app, runtime } = await fixture({
      sonarr: {
        getSeries: async () => [{ id: 4, tvdbId: 44, title: 'Owned Show', titleSlug: 'owned-show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] }],
        getEpisodes: async () => [{ id: 40, seriesId: 4, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1, title: 'Owned', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: true }],
        getQueue: async () => [],
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    runtime.saveSettings({ ...runtime.getSettings(), monitoring: { ...runtime.getSettings().monitoring, enabled: true } });
    await expect(runtime.runAutomation()).resolves.toMatchObject({ ran: false, reason: 'no-actionable-target' });
    expect(runtime.activity().items).toHaveLength(0);
    expect(runtime.store.hasLiveLease('automation-pass', Date.now())).toBe(false);
    await app.close(); await runtime.close();
  });
  it('schedules one canonical show workload as an automation-owned search', async () => {
    let calls = 0;
    const modelPrompts: string[] = [];
    const responses = createServer(async (request, response) => {
      calls++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      modelPrompts.push(JSON.parse(Buffer.concat(chunks).toString()).input);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'scheduled-fixture', object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: 'scheduled-call', type: 'function_call', call_id: 'scheduled-call', name: 'finalize_release_set',
          arguments: JSON.stringify({ status: 'no-match', selections: [], covered: [], gaps: ['No suitable release observed'], deferred: [], broadCoverage: 'none', scopeGaps: [] }), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const upstream = responses.address();
    if (!upstream || typeof upstream === 'string') throw new Error('Missing scheduled Responses fixture');
    const { app, runtime } = await fixture({
      sonarr: {
        getSeries: async () => seriesListSchema.parse([4, 5].map(id => ({ id, tvdbId: id * 10, title: `Show ${id}`, titleSlug: `show-${id}`, seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [{ title: `Show ${id} S2` }, { title: `Show ${id} Cour Two`, seasonNumber: 2 }] }))),
        getEpisodes: async id => [1, 2, 3, 4].map(n => ({ id: id * 10 + n, seriesId: id, seasonNumber: n === 4 ? 2 : 1, episodeNumber: n === 4 ? 1 : n, absoluteEpisodeNumber: n, title: `Episode ${n}`, airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: n !== 4, hasFile: n === 2 })),
        getQueue: async () => [],
      },
    });
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, preferences: 'Original audio, 1080p', baseUrl: `http://127.0.0.1:${upstream.port}` }, monitoring: { ...runtime.getSettings().monitoring, enabled: true } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const pass = await runtime.runAutomation();
      const search = runtime.activity().items[0] && await runtime.getSearch(runtime.activity().items[0]!.searchId);
      expect({ pass, search }).toMatchObject({ pass: { ran: true, reason: 'no-match' }, search: { status: 'no-match' } });
      await expect(runtime.runAutomation()).resolves.toMatchObject({ ran: true, reason: 'no-match' });
      expect(calls).toBe(2);
      expect(runtime.activity().items).toHaveLength(2);
      const searches=await Promise.all(runtime.activity().items.map(item=>runtime.getSearch(item.searchId)));
      expect(searches.every(item=>item?.source==='automation'&&!item.manualExecutionEligible&&item.status==='no-match')).toBe(true);
      expect(searches.map(item => item?.prompt).sort()).toEqual(modelPrompts.sort());
      for (const prompt of modelPrompts) {
        expect(prompt).toMatch(/\["Show [45]","Show [45] S2",\{"title":"Show [45] Cour Two","providerSeasons":\[2\]\}\]/);
        expect(prompt).toContain('{"season":1,"episode":1,"absoluteEpisode":1,"title":"Episode 1"}');
        expect(prompt).toContain('{"season":1,"episode":3,"absoluteEpisode":3,"title":"Episode 3"}');
        expect(prompt.match(/Original audio, 1080p/g)).toHaveLength(1);
        expect(prompt).toContain('S1+S2 and S2+S3');
        expect(prompt).not.toMatch(/Episode [24]|"season":2|2020-01-01|tvdb|targetId|unmonitored/i);
      }
      expect(runtime.store.getSetting(`search-source:${runtime.activity().items[0]!.searchId}`)).toBe('automation');
    } finally {
      await app.close(); await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it('internally executes only the persisted automation selection as an automation receipt', async () => {
    let calls=0,runtimeRef:SearchRuntime|undefined,autoGrabs=0, newlyAired=false, arrCaughtUp=false, clock=Date.now();
    const release=releaseSchema.parse({guid:'scheduled-release',age:1,size:100,files:null,grabs:null,indexerId:1,indexer:'Index',subGroup:null,title:'Show 4 S01 1080p',tvdbId:40,tmdbId:null,publishDate:'',downloadUrl:null,indexerFlags:[],categories:[],magnetUrl:null,infoHash:'a'.repeat(40),seeders:1,leechers:0,protocol:'torrent',downloadClientId:null});
    const responses=createServer(async(request,response)=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString()) as {tools?:Array<{name?:string}>};
      calls++;
      const name=calls===1?(body.tools?.find(tool=>tool.name?.includes('prowlarr_search'))?.name??'prowlarr_search'):'finalize_release_set';
      const candidate=runtimeRef?.store.listCandidates(runtimeRef.activity().items[0]?.searchId??'')[0]?.candidateId;
      const args=calls>2?{status:'no-match',selections:[],covered:[],gaps:['Still missing'],deferred:[],broadCoverage:'none',scopeGaps:[]}:name==='prowlarr_search'?{query:'Show 4'}:{status:'matched',selections:[{candidateId:candidate,coverage:'The requested episodes',reason:'The release covers the requested episodes',uncertainty:''}],covered:['The requested episodes'],gaps:[],deferred:[],broadCoverage:'complete',scopeGaps:[]};
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({id:`scheduled-${calls}`,object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:`call-${calls}`,type:'function_call',call_id:`call-${calls}`,name,arguments:JSON.stringify(args),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>responses.listen(0,'127.0.0.1',resolve));
    const address=responses.address(); if(!address||typeof address==='string')throw new Error('Missing automation execution fixture');
    const {app,runtime,grabs}=await fixture({
      prowlarr:{getIndexers:async()=>[{id:1,name:'Index',enable:true}],getIndexerStatuses:async()=>[],search:async()=>[release],getDownloadClients:async()=>[{id:7,name:'TV',protocol:'torrent',enable:true,supportsCategories:true,categories:[]}],grab:async()=>{autoGrabs++;}},
      sonarr:{getSeries:async()=>[{id:4,tvdbId:40,title:'Show 4',titleSlug:'show-4',seriesType:'standard',monitored:true,seasons:[],alternateTitles:[]}],getEpisodes:async id=>(newlyAired?[1,2,3]:[1,2]).map(n=>({id:40+n,seriesId:id,seasonNumber:n,episodeNumber:n,absoluteEpisodeNumber:n,title:`Episode ${n}`,airDate:'2020-01-01',airDateUtc:null,finaleType:null,monitored:true,hasFile:arrCaughtUp&&n===2})),getQueue:async()=>arrCaughtUp?[{seriesId:4,episodeId:41,status:'downloading'}]:[]},
    },()=>clock);
    runtimeRef=runtime;
    try{
      runtime.saveSettings({...runtime.getSettings(),ai:{...runtime.getSettings().ai,baseUrl:`http://127.0.0.1:${address.port}`,preferences:'Prefer 1080p, never send private-sonarr'},integrations:{...runtime.getSettings().integrations,prowlarr:{...runtime.getSettings().integrations.prowlarr,tvClientId:7}},monitoring:{...runtime.getSettings().monitoring,enabled:true,allowDownloads:true},safety:{dryRun:false}});
      await app.listen({host:'127.0.0.1',port:0});
      await expect(runtime.runAutomation()).resolves.toMatchObject({ran:true,reason:'matched'});
      const searchId=runtime.activity().items[0]!.searchId;
      expect(await runtime.getSearch(searchId)).toMatchObject({source:'automation',manualExecutionEligible:false,status:'matched',receipts:[{outcome:'submitted',children:[{outcome:'submitted'}]}]});
      expect(autoGrabs).toBe(1);
      newlyAired=true;
      await expect(runtime.runAutomation()).resolves.toMatchObject({ran:false,reason:'no-actionable-target'});
      expect(runtime.automationStatus().items.find(item=>item.seasonNumber===3)).toMatchObject({status:'grace',eligible:false});
      expect(JSON.stringify(await runtime.getSearch(searchId))).not.toContain('private-sonarr');
      expect(calls).toBe(2);
      arrCaughtUp=true;clock+=30*60_000;
      await expect(runtime.runAutomation()).resolves.toMatchObject({ran:true,reason:'no-match'});
      const next=await runtime.getSearch(runtime.activity().items[0]!.searchId);
      expect(next?.prompt).toContain('{"season":3,"episode":3,"absoluteEpisode":3,"title":"Episode 3"}');
      expect(next?.prompt).not.toMatch(/Episode [12]|observed-in-queue|already-owned/);
      expect(autoGrabs).toBe(1);
      expect(grabs()).toBe(0);
    }finally{
      await app.close();await runtime.close();
      await new Promise<void>((resolve,reject)=>responses.close(error=>error?reject(error):resolve()));
    }
  });
  it.each(['route','route-during-arr','new-queue','late-queue','stale-observation','same-plan-tail','external-tail','identity-mismatch-same-title','grab-429','dry-run'] as const)('fences automatic sending at the %s boundary', async mode => {
    let calls=0,lists=0,runtimeRef:SearchRuntime|undefined,grabs=0,queued=false,categoryChanged=false;
    let now = Date.now();
    const release=releaseSchema.parse({guid:'client-race-release',age:1,size:100,files:null,grabs:null,indexerId:1,indexer:'Index',subGroup:null,title:'Show 4 S01 1080p',tvdbId:40,tmdbId:null,publishDate:'',downloadUrl:null,indexerFlags:[],categories:[],magnetUrl:null,infoHash:'b'.repeat(40),seeders:1,leechers:0,protocol:'torrent',downloadClientId:null});
    const tail=mode==='same-plan-tail'||mode==='external-tail'||mode==='identity-mismatch-same-title';
    const responses=createServer(async(request,response)=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString()) as {tools?:Array<{name?:string}>};
      calls++;
      const name=calls===1?(body.tools?.find(tool=>tool.name?.includes('prowlarr_search'))?.name??'prowlarr_search'):'finalize_release_set';
      const candidates=runtimeRef?.store.listCandidates(runtimeRef.activity().items[0]?.searchId??'')??[];
      if(mode==='dry-run'&&name==='finalize_release_set')runtimeRef!.saveSettings({...runtimeRef!.getSettings(),safety:{dryRun:false}});
      const args=name==='prowlarr_search'?{query:'Show 4'}:{status:'matched',selections:candidates.map(({candidateId})=>({candidateId,coverage:'The requested episode',reason:'Observed release',uncertainty:''})),covered:['The requested episode'],gaps:[],deferred:[],broadCoverage:'complete',scopeGaps:[]};
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({id:`client-race-${calls}`,object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:`call-${calls}`,type:'function_call',call_id:`call-${calls}`,name,arguments:JSON.stringify(args),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>responses.listen(0,'127.0.0.1',resolve));
    const address=responses.address();if(!address||typeof address==='string')throw new Error('Missing client race Responses fixture');
    const {app,runtime}=await fixture({
      prowlarr:{getIndexers:async()=>[{id:1,name:'Index',enable:true}],getIndexerStatuses:async()=>[],search:async()=>tail?[(mode==='identity-mismatch-same-title'?{...release,infoHash:null}:release),{...release,guid:'tail-release',infoHash:'c'.repeat(40),title:'Show 4 E02 1080p'}]:[release],getDownloadClients:async()=>{
        lists++;
        if(lists===3&&mode==='route')runtimeRef!.saveSettings({...runtimeRef!.getSettings(),integrations:{...runtimeRef!.getSettings().integrations,prowlarr:{...runtimeRef!.getSettings().integrations.prowlarr,tvClientId:8}}});
        if(lists===3&&mode==='new-queue')queued=true;
        if(lists===4&&mode==='late-queue')queued=true;
        if(lists===4&&mode==='stale-observation')now+=16_000;
        if(mode==='route-during-arr'&&categoryChanged)return [{id:7,name:'TV',protocol:'torrent',enable:true,supportsCategories:true,categories:[{clientCategory:'changed',categories:[5000]}]}];
        return [{id:7,name:'TV',protocol:'torrent',enable:true,supportsCategories:true,categories:[]}];
      },grab:async()=>{grabs++;if(mode==='grab-429')throw new ApiError(429,'http://indexer.test/api/v1/indexer/grab','rate limited',37);if(tail)queued=true;}},
       sonarr:{getSeries:async()=>[{id:4,tvdbId:40,title:'Show 4',titleSlug:'show-4',seriesType:'standard',monitored:true,seasons:[],alternateTitles:[]}],getEpisodes:async id=>(tail?[1,2]:[1]).map(n=>({id:40+n,seriesId:id,seasonNumber:n,episodeNumber:n,absoluteEpisodeNumber:n,title:'Episode',airDate:'2020-01-01',airDateUtc:null,finaleType:null,monitored:true,hasFile:false})),getQueue:async()=>{if(mode==='route-during-arr'&&calls>=2)categoryChanged=true;return queued?[{seriesId:4,status:'downloading',downloadId:mode==='same-plan-tail'?release.infoHash:mode==='identity-mismatch-same-title'?'c'.repeat(40):'d'.repeat(40),...(mode==='identity-mismatch-same-title'?{title:release.title}:{})}]:[];}},
    },()=>now);
    runtimeRef=runtime;
    try{
      runtime.saveSettings({...runtime.getSettings(),ai:{...runtime.getSettings().ai,baseUrl:`http://127.0.0.1:${address.port}`,model:'fixture-model'},integrations:{...runtime.getSettings().integrations,prowlarr:{...runtime.getSettings().integrations.prowlarr,tvClientId:7}},monitoring:{...runtime.getSettings().monitoring,enabled:true,allowDownloads:true},safety:{dryRun:mode==='dry-run'}});
      await app.listen({host:'127.0.0.1',port:0});
      await expect(runtime.poll()).resolves.toMatchObject({ran:false,reason:'observation-only'});
      expect(calls).toBe(0);
      await expect(runtime.runAutomation()).resolves.toMatchObject({ran:true,reason:mode==='grab-429'?'rejected':'matched'});
      const search=await runtime.getSearch(runtime.activity().items[0]!.searchId);
      if(mode==='route-during-arr') expect(categoryChanged).toBe(true);
      expect(grabs).toBe(mode==='same-plan-tail'?2:mode==='external-tail'||mode==='identity-mismatch-same-title'||mode==='grab-429'?1:0);
      expect(search?.receipts?.map(receipt=>receipt.outcome)).toEqual(mode==='dry-run'?[]:[mode==='same-plan-tail'?'submitted':mode==='external-tail'||mode==='identity-mismatch-same-title'?'partial':mode==='grab-429'?'rejected':'not-attempted']);
      if(mode==='grab-429')expect(runtime.store.getProviderDeadline('prowlarr')).toBeGreaterThan(Date.now());
      expect(search?.automationPending).toBeUndefined();
    }finally{
      await app.close();await runtime.close();
      await new Promise<void>((resolve,reject)=>responses.close(error=>error?reject(error):resolve()));
    }
  });
  it.each([false, true])('canonicalizes a fresh Radarr movie despite older invalid work (invalid=%s)', async (invalidFirst) => {
    let now = Date.now();
    const responses=createServer(async(_request,response)=>{
      for await(const _chunk of _request) { /* consume */ }
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({id:'movie-schedule',object:'response',created_at:1,completed_at:1,status:'completed',error:null,incomplete_details:null,instructions:null,model:'fixture/model',output:[{id:'movie-final',type:'function_call',call_id:'movie-final',name:'finalize_release_set',arguments:JSON.stringify({status:'no-match',selections:[],covered:[],gaps:['No suitable movie release observed'],deferred:[],broadCoverage:'none',scopeGaps:[]}),status:'completed'}],parallel_tool_calls:false,tool_choice:'auto',tools:[],usage:null,metadata:null,frequency_penalty:null,presence_penalty:null,temperature:null,top_p:null}));
    });
    await new Promise<void>(resolve=>responses.listen(0,'127.0.0.1',resolve));
    const address=responses.address();if(!address||typeof address==='string')throw new Error('Missing movie automation fixture');
    const {app,runtime}=await fixture({radarr:{
      getMovies:async()=>[{id:77,tmdbId:770,title:'Observed Movie',titleSlug:'observed-movie',year:2020,monitored:true,hasFile:false,isAvailable:true,sizeOnDisk:0,qualityProfileId:1,tags:[]},
        ...(invalidFirst ? [{id:11,tmdbId:110,title:'Too large '.repeat(5000),titleSlug:'oversize-movie',year:0,monitored:true,hasFile:false,isAvailable:true,sizeOnDisk:0,qualityProfileId:1,tags:[]}] : [])],
      getQueue:async()=>[],
    }},()=>now);
    try{
      runtime.saveSettings({...runtime.getSettings(),ai:{...runtime.getSettings().ai,baseUrl:`http://127.0.0.1:${address.port}`},integrations:{...runtime.getSettings().integrations,radarr:{url:'http://radarr.test',apiKey:'private-radarr'}},monitoring:{...runtime.getSettings().monitoring,enabled:true}});
      await app.listen({host:'127.0.0.1',port:0});
      if (invalidFirst) {
        await expect(runtime.runAutomation()).resolves.toMatchObject({ran:false,reason:'workload-deferred'});
        now+=5*60_000;
      }
      await expect(runtime.runAutomation()).resolves.toMatchObject({ran:true,reason:'no-match'});
      const search=await runtime.getSearch(runtime.activity().items[0]!.searchId);
      expect(search).toMatchObject({source:'automation',prompt:expect.stringContaining('the movie "Observed Movie" (2020)')});
      expect(search?.prompt).not.toMatch(/tmdb|770|pack|episodes|preferences/i);
    }finally{
      await app.close();await runtime.close();
      await new Promise<void>((resolve,reject)=>responses.close(error=>error?reject(error):resolve()));
    }
  });

  it('contains no retired engine modules or operator CLI compatibility stub', () => {
    for (const path of [
      'core/runner.ts', 'core/state.ts', 'core/work-queue.ts', 'core/operations.ts', 'core/operator-actions.ts', 'operator-cli.ts',
      'search/service.ts', 'search/selection.ts', 'clients/llm.ts', '../scripts/evaluate-search.ts',
      '../scripts/evaluate-anime-search.ts', '../scripts/compare-anime-models.ts',
    ]) {
      expect(existsSync(new URL(`../src/${path}`, import.meta.url)), path).toBe(false);
    }
  });
  it('disables submission while retaining read-only Activity', async () => {
    const { app, runtime, grabs } = await fixture(), now = Date.now();
    runtime.store.createSearch({ searchId: 'match', prompt: '{"prompt":"Example"}', status: 'matched', createdAt: now, finishedAt: now, result: { options: [{ optionId: 'option', rank: 1, releases: [{ candidateId: 'candidate' }], coveredTargetIds: [], reason: 'Fit', uncertainty: '' }] } });
    runtime.store.addCandidate({ searchId: 'match', candidateId: 'candidate', safe: {}, privateData: { release: releaseSchema.parse({ guid: 'private', indexerId: 1, indexer: 'Index', title: 'Example', publishDate: '', protocol: 'torrent' }), physicalKey: 'private-key' }, expiresAt: now - 1 });
    const confirm = (key: string) => app.inject({ method: 'POST', url: '/api/v2/submissions', payload: { searchId: 'match', optionId: 'option', downloadClientId: 7, idempotencyKey: key } });
    expect((await confirm('expired')).statusCode).toBe(410);
    expect((await app.inject('/api/v2/activity?status=dry-run')).json()).toMatchObject({ total: 0 });
    expect(grabs()).toBe(0);
    const settings = runtime.getSettings();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...settings, monitoring: { ...settings.monitoring, searchRetryMinutes: 1e15 } } })).statusCode).toBe(400);
  });
  it('requires the daemon MCP listener before accepting a search', async () => {
    const { app, runtime } = await fixture();
    const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Find a film' } });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toMatchObject({ code: 'operation-unavailable' });
    expect(runtime.activity().items).toHaveLength(0);
  });
  it('projects historical saved model input through prompt without exposing the old field', async () => {
    const { runtime } = await fixture();
    runtime.store.createSearch({
      searchId: 'historical-model-input',
      prompt: JSON.stringify({ version: 1, request: { prompt: 'Old title', kind: 'tv' } }),
      status: 'matched',
      createdAt: Date.now(),
      result: { version: 1, status: 'matched', modelPrompt: 'Old multiline input\nprivate-model', counts: { decisions: 1, searches: 0, candidates: 0 } },
    });
    runtime.store.setSetting('search-source:historical-model-input', 'manual');
    const result = await runtime.getSearch('historical-model-input');
    expect(result?.prompt).toBe('Old multiline input\n[redacted]');
    expect(result).not.toHaveProperty('modelPrompt');
    expect(JSON.stringify(result)).not.toContain('private-model');
    await runtime.close();
  });
  it('fails previously queued v2 manual and v1 Arr work during normal startup dispatch without upstream calls', async () => {
    let modelCalls = 0, providerCalls = 0;
    const sentinel = createServer((_request, response) => {
      modelCalls++;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"model must not be called"}');
    });
    await new Promise<void>(resolve => sentinel.listen(0, '127.0.0.1', resolve));
    const address = sentinel.address();
    if (!address || typeof address === 'string') throw new Error('Missing sentinel model server');
    const { app, runtime } = await fixture({
      prowlarr: {
        getIndexers: async () => { providerCalls++; return []; },
        getIndexerStatuses: async () => { providerCalls++; return []; },
        search: async () => { providerCalls++; return []; },
      },
    });
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}/v1` } });
      const now = Date.now();
      runtime.store.enqueueSearch({
        searchId: 'queued-old-manual-v2',
        prompt: JSON.stringify({ version: 2, prompt: 'Previously rendered structured request', kind: 'tv' }),
        now,
      });
      runtime.store.enqueueSearch({
        searchId: 'queued-old-arr',
        prompt: JSON.stringify({ version: 1, request: { prompt: 'legacy', arrTargetIds: ['must-not-resolve'] } }),
        source: 'arr',
        now: now + 1,
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      await runtime.drain();
      const manual = await runtime.getSearch('queued-old-manual-v2');
      const arr = await runtime.getSearch('queued-old-arr');
      expect(manual).toMatchObject({
        status: 'failed',
        source: 'manual',
        message: 'This saved search uses a retired request format; resubmit it as a prompt-only search.',
      });
      expect(arr).toMatchObject({
        status: 'failed',
        source: 'arr',
        manualExecutionEligible: false,
        message: 'This saved search uses a retired request format; resubmit it as a prompt-only search.',
      });
      expect(arr?.prompt).toBe('legacy');
      expect(JSON.stringify(arr)).not.toContain('must-not-resolve');
      expect(modelCalls).toBe(0);
      expect(providerCalls).toBe(0);
    } finally {
      await app.close(); await runtime.close();
      await new Promise<void>(resolve => { sentinel.close(() => resolve()); sentinel.closeAllConnections(); });
    }
  });
  it.each(['empty', 'outage', 'cooldown'] as const)('distinguishes successful empty results from unavailable Prowlarr research (%s)', async (scenario) => {
    let responseCalls = 0;
    const modelInputs: Array<{ input: unknown; instructions: unknown; tools: unknown }> = [];
    const responses = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()) as { tools?: Array<{ name?: string }>; input?: unknown; instructions?: unknown };
      modelInputs.push({ input: body.input, instructions: body.instructions, tools: body.tools });
      responseCalls++;
      const name = (responseCalls === 1 ? body.tools?.find(tool => tool.name?.includes(scenario === 'cooldown' ? 'prowlarr_indexers' : 'prowlarr_search'))?.name : undefined) ?? 'finalize_release_set';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `fixture-${Date.now()}`, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'z-ai/glm-5.3-flash',
        output: [{ id: `call-${Date.now()}`, type: 'function_call', call_id: `call-${Date.now()}`, name,
          arguments: name?.includes('prowlarr_search') ? JSON.stringify({ query: 'Find a film' }) : name.includes('prowlarr_indexers') ? '{}'
            : JSON.stringify({ status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150, cost: 0.004 }, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const upstream = responses.address();
    if (!upstream || typeof upstream === 'string') throw new Error('Missing scripted Responses address');
    const { app, runtime, grabs } = await fixture(scenario !== 'empty' ? {
      prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Fixture', enable: true, implementation: 'Fixture', protocol: 'torrent' }],
        getIndexerStatuses: async () => scenario === 'cooldown' ? [{ indexerId: 1, disabledTill: '2099-01-01T00:00:00Z', mostRecentFailure: null, initialFailure: null }] : [],
        search: async () => { throw new Error('PRIVATE-UPSTREAM-CANARY'); },
      },
    } : undefined);
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${upstream.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const exactPrompt = '  {"version":1,\n"request":{"prompt":"Find a film"}}  ';
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: exactPrompt } });
      expect(start.statusCode).toBe(202);
      const { searchId } = start.json() as { searchId: string };
      expect((await runtime.getSearch(searchId))?.prompt).toBe(exactPrompt);
      await runtime.drain();
      const instruction = JSON.stringify(modelInputs);
      expect(instruction).toContain('typed finalize_release_set');
      expect(instruction).toContain('Never redefine requested scope');
      expect(instruction).toContain('no fixed number of queries is required');
      expect(instruction).toContain('Extras are not gaps');
      expect(instruction).toContain('plain language, not IDs');
      expect(JSON.stringify(modelInputs.flatMap(request => request.tools)).match(/targetIds/g)).toBeNull();
      expect(modelInputs).toHaveLength(2);
      for (const request of modelInputs) {
        expect(request.instructions).toEqual(expect.stringContaining('Treat clear, internally consistent release names and indexer metadata as sufficient working evidence'));
        expect(request.instructions).toEqual(expect.stringContaining('Do not add boilerplate uncertainty solely because file contents were not inspected'));
        expect(request.instructions).toEqual(expect.stringContaining('use an empty uncertainty string when none remains'));
      }
      const status = await app.inject(`/api/v2/searches/${searchId}`);
      expect(status.statusCode).toBe(200);
      expect(modelInputs[0]?.input).toBe(status.json().prompt);
      expect(modelInputs[0]?.input).toBe(exactPrompt);
      if (scenario !== 'empty') {
        expect(instruction).toContain(scenario === 'outage' ? 'Prowlarr search unavailable' : 'coolingUntil');
        expect(status.json()).toMatchObject({ searchId, status: 'failed', message: 'Prowlarr research failed before a search could complete' });
        expect(status.json()).not.toHaveProperty('plan');
        expect(status.body).not.toContain('PRIVATE-UPSTREAM-CANARY');
        return;
      }
      expect(status.json(), JSON.stringify(status.json())).toMatchObject({
        searchId, status: 'no-match', diagnostics: { modelTurns: 2, stopReason: 'release-set-finalized', elapsedMs: expect.any(Number), usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.004 } },
        counts: { decisions: 2, searches: 1 },
        plan: { version: 2, status: 'no-match', selections: [], coverage: { broad: { status: 'none' } } },
      });
      expect(status.body).not.toContain('private-model');
      expect(grabs()).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each([
    { name: 'zero then conflicting positive identity', identities: [0, 999], expected: 'matched' },
    { name: 'conflicting positive then zero identity', identities: [999, 0], expected: 'matched' },
    { name: 'unknown zero identity only', identities: [0, 0], expected: 'matched' },
  ])('does not use candidate identity IDs as a finalization veto ($name)', async ({ identities, expected }) => {
    let runtimeRef: SearchRuntime | undefined, responseCalls = 0, searchCall = 0;
    const responses = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      responseCalls++;
      if (responseCalls > 3) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'CANARY-RESPONSE-BODY-DO-NOT-LEAK' }));
        return;
      }
      const requestBody = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ name?: string }> };
      const searchName = requestBody.tools?.find(tool => tool.name?.includes('prowlarr_search'))?.name;
      const name = responseCalls <= 2 ? searchName ?? 'prowlarr_search' : 'finalize_release_set';
      let args: unknown;
      if (responseCalls <= 2) { searchCall++; args = { query: `identity-${searchCall}` }; }
      else {
        const candidateId = runtimeRef!.store.listCandidates(runtimeRef!.activity().items[0]!.searchId)[0]?.candidateId;
        args = { status: 'matched', selections: [{ candidateId, coverage: 'The requested film', reason: 'private-model observed candidate', uncertainty: '' }], covered: ['The requested film'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `identity-${responseCalls}`, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: `call-${responseCalls}`, type: 'function_call', call_id: `call-${responseCalls}`, name, arguments: JSON.stringify(args), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const address = responses.address();
    if (!address || typeof address === 'string') throw new Error('No fixture Responses listener');
    const { app, runtime, grabs } = await fixture({
      prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Index', enable: true }],
        getIndexerStatuses: async () => [],
        search: async () => [releaseSchema.parse({
          guid: `guid-${searchCall}`, age: 1, size: 100, files: null, grabs: null, indexerId: 1, indexer: 'Index', subGroup: null,
          title: 'Film 2020', tvdbId: null, tmdbId: identities[searchCall - 1] ?? 0, publishDate: '', downloadUrl: null,
          indexerFlags: [], categories: [], magnetUrl: null, infoHash: 'a'.repeat(40), seeders: 1, leechers: 0, protocol: 'torrent', downloadClientId: null,
        })],
      },
    });
    runtimeRef = runtime;
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Find film' } });
      const { searchId } = start.json() as { searchId: string };
      await runtime.drain();
      const result = await runtime.getSearch(searchId);
      expect(result?.status, JSON.stringify(result)).toBe(expected);
      expect(result?.plan?.selections.length ?? 0).toBe(expected === 'matched' ? 1 : 0);
      expect(result?.candidates).toMatchObject([{ observations: [{ title: 'Film 2020' }] }]);
      expect(JSON.stringify(result?.candidates)).not.toMatch(/"tmdbId"|"tvdbId"/);
      expect(result?.message ?? '').not.toContain('CANARY-RESPONSE-BODY-DO-NOT-LEAK');
      if (expected === 'failed') expect(result?.message).toBe('Search provider request failed (HTTP 500)');
      expect(result?.counts.decisions).toBeGreaterThan(0);
      if (expected === 'matched') {
        expect(JSON.stringify(result?.plan)).not.toContain('private-model');
        runtime.store.expireCandidatesAt(searchId, Date.now() - 1);
        expect(runtime.store.listCandidates(searchId)).toHaveLength(0);
        const historical = await runtime.getSearch(searchId);
        expect(historical?.candidates).toMatchObject([{ observations: [{ title: 'Film 2020' }] }]);
        expect(JSON.stringify(historical)).not.toContain('guid-');
      }
      expect(grabs()).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each([{ header: '30', minSeconds: 29 }, { header: null, minSeconds: 59 }])('sanitizes model 429 bodies, applies Retry-After/fallback, and pauses queued work', async ({ header, minSeconds }) => {
    let modelCalls = 0;
    const responses = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume */ }
      modelCalls++;
      response.writeHead(429, { 'content-type': 'application/json', ...(header ? { 'retry-after': header } : {}) });
      response.end(JSON.stringify({ error: 'MODEL-CANARY-PRIVATE-BODY' }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const address = responses.address();
    if (!address || typeof address === 'string') throw new Error('No fixture Responses listener');
    const { app, runtime } = await fixture();
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const before = Date.now();
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'First' } });
      const { searchId } = start.json() as { searchId: string };
      await runtime.drain();
      const status = await runtime.getSearch(searchId);
      expect(status).toMatchObject({ status: 'failed', message: 'Model provider rate limited the search' });
      expect(JSON.stringify(status)).not.toContain('MODEL-CANARY-PRIVATE-BODY');
      expect(runtime.store.getProviderDeadline('model')).toBeGreaterThanOrEqual(before + minSeconds * 1000);
      await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Queued behind cooldown' } });
      expect(modelCalls).toBe(1);
      expect(runtime.activity().items[0]?.status).toBe('queued');
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it('aborts the active model request on quiesce and never persists a staged plan', async () => {
    let seenRequest!: () => void, responseClosed!: () => void;
    const seen = new Promise<void>(resolve => { seenRequest = resolve; });
    const closed = new Promise<void>(resolve => { responseClosed = resolve; });
    const responses = createServer((request, response) => {
      request.resume();
      response.once('close', responseClosed);
      seenRequest();
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const address = responses.address();
    if (!address || typeof address === 'string') throw new Error('No fixture Responses listener');
    const { app, runtime, grabs } = await fixture();
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Stop during model call' } });
      const { searchId } = start.json() as { searchId: string };
      await seen;
      runtime.quiesce();
      await runtime.drain();
      await closed;
      expect(await runtime.getSearch(searchId)).toMatchObject({ status: 'interrupted' });
      expect((await runtime.getSearch(searchId))?.plan).toBeUndefined();
      expect(grabs()).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>(resolve => responses.close(() => resolve()));
    }
  }, 15_000);
  it('never contacts providers when reading Activity or Automation', async () => {
    const { app, reads } = await fixture();
    expect((await app.inject('/api/v2/activity')).statusCode).toBe(200);
    expect((await app.inject('/api/v2/automation')).json()).toMatchObject({ enabled: false, dryRun: true, items: [] });
    expect(reads()).toBe(0);
  });
  it('validates bounded Activity media/time filters and rejects reversed ranges', async () => {
    const { app, runtime } = await fixture(), now = Date.now();
    runtime.store.createSearch({ searchId: 'tv', prompt: '{"prompt":"Example","context":{"kind":"tv"}}', status: 'no-match', createdAt: now });
    runtime.store.createSearch({ searchId: 'movie', prompt: '{"prompt":"Example","context":{"kind":"movie"}}', status: 'no-match', createdAt: now + 1 });
    runtime.store.appendEvent('tv', { type: 'submission', data: { outcome: 'partial' } });
    runtime.store.appendEvent('movie', { type: 'submission', data: { outcome: 'not-attempted' } });
    expect((await app.inject(`/api/v2/activity?kind=tv&createdAtFrom=${encodeURIComponent(new Date(now).toISOString())}&createdAtTo=${encodeURIComponent(new Date(now).toISOString())}`)).json()).toMatchObject({ total: 1, items: [{ kind: 'tv' }] });
    expect((await app.inject('/api/v2/activity?kind=bogus')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?createdAtFrom=not-a-date')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?createdAtFrom=2026-02-01T00%3A00%3A00Z&createdAtTo=2026-01-01T00%3A00%3A00Z')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?status=partial')).json()).toMatchObject({items:[{searchId:'tv',submission:{outcome:'partial'}}]});
    expect((await app.inject('/api/v2/activity?status=not-attempted')).json()).toMatchObject({items:[{searchId:'movie',submission:{outcome:'not-attempted'}}]});
  });
  it('requires valid input and rejects cross-origin mutations without network work', async () => {
    const { app, reads } = await fixture();
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Find', preferredDownloadClientId: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', headers: { origin: 'http://evil.test' }, payload: { prompt: 'Find' } })).statusCode).toBe(403);
    expect((await app.inject('/api/v2/activity?limit=999')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/searches/unknown')).statusCode).toBe(404);
    expect(reads()).toBe(0);
  });
  it('uses v2 settings with optional Arr and omits all legacy mutation routes', async () => {
    const { app, grabs } = await fixture();
    expect((await app.inject('/api/settings')).json()).toMatchObject({ settings: { version: 5, monitoring: { allowDownloads: false } }, status: { ready: true } });
    expect((await app.inject({ method: 'POST', url: '/cycle' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { action: 'reset' } })).statusCode).toBe(404);
    expect(grabs()).toBe(0);
  });
});
