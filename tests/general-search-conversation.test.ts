import { describe, expect, it, vi } from 'vitest';
import { State } from '../src/core/state';
import { GeneralSearchConversationService } from '../src/core/general-search-conversation';
import { defaultSettings } from '../src/settings';
import type { Release } from '../src/types/prowlarr';

const release=(overrides:Partial<Release>={}):Release=>({guid:'guid-safe',age:4,size:123,files:null,grabs:null,indexerId:4,indexer:'Indexer',subGroup:null,title:'Example film',tvdbId:null,tmdbId:null,publishDate:'',downloadUrl:'https://private.test/key',indexerFlags:[],categories:[],magnetUrl:'magnet:?xt=x',infoHash:'hash',seeders:2,leechers:1,protocol:'torrent',downloadClientId:null,...overrides});
function fixture(results=[release()]) {const state=State.open(':memory:');const settings=structuredClone(defaultSettings);settings.integrations.prowlarr={url:'http://prowlarr.test',apiKey:'p-secret',tvClient:'',movieClient:'',generalClient:'General'};settings.ai.apiKey='a-secret';const destination={id:1,name:'General',enable:true,protocol:'torrent' as const,supportsCategories:true,categories:[],routingDigest:'a'.repeat(64)};const llm={json:vi.fn(async(args:{label:string;user:string})=>args.label.includes('planning')?{mode:'search',queries:['film term','film term'],question:''}:{items:(JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>}).actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))})};const prowlarr={getDownloadClients:vi.fn(async()=>[destination]),search:vi.fn(async()=>results)};const rebuild=()=>new GeneralSearchConversationService({llm:llm as never,prowlarr:prowlarr as never,state,getSettings:()=>settings});return {state,settings,llm,prowlarr,rebuild,service:rebuild()};}
const request={originalQuery:'find a film',turns:[{role:'user',content:'find a film'}] as const,action:'search' as const};

describe('GeneralSearchConversationService',()=>{
  it('searches bounded unique terms and emits truthful ordered progress',async()=>{const f=fixture();const events:string[]=[];const result=await f.service.search(request,e=>events.push(e.type));expect(f.prowlarr.search).toHaveBeenCalledTimes(1);expect(result.releases).toHaveLength(1);expect(events[0]).toBe('planning');expect(events.at(-1)).toBe('complete');expect(events).toContain('results');});
  it('rejects credential-bearing references from every prompt, event, snapshot, and response',async()=>{
    const refs=['https://secret.example/api?token=abc','alice:hunter2@private-host','magnet:?xt=urn:btih:privatehash','p-secret'];
    const f=fixture(refs.map((guid,i)=>release({guid:`${i}-${guid}`,downloadUrl:`${i}-${guid}`})));
    const events:unknown[]=[];const result=await f.service.search(request,e=>events.push(e));
    const snapshot=f.state.getGeneralSearchSnapshot(result.searchId!)!;
    const data=JSON.stringify({prompts:f.llm.json.mock.calls,events,snapshot:snapshot.payload,response:result});
    expect(result.releases).toHaveLength(0);for(const raw of refs)expect(data).not.toContain(raw);
    expect(data).not.toContain('hunter2');expect(data).not.toContain('privatehash');expect(data).not.toContain('secret.example');
  });
  it('hides zero-seeder torrents while preserving unknown, stale, and protocol-specific signals',async()=>{const f=fixture([release({guid:'zero',title:'Zero',seeders:0}),release({guid:'unknown-seeds',title:'Unknown seeds',seeders:null}),release({guid:'stale',title:'Stale',age:500}),release({guid:'usenet',title:'Usenet',protocol:'usenet',seeders:0})]);const result=await f.service.search(request);expect(result.releases.some(x=>x.title==='Zero')).toBe(false);expect(result.releases.find(x=>x.title==='Unknown seeds')?.selectable).toBe(true);expect(result.releases.find(x=>x.title==='Usenet')?.viability?.reason).not.toBe('zero-seeders');expect(result.releases.find(x=>x.title==='Stale')?.viability?.reason).toBe('stale');});
  it('returns and snapshots admitted candidates beyond displayLimit',async()=>{const f=fixture(Array.from({length:45},(_,i)=>release({guid:`guid-${i}`,title:`Film ${i}`})));f.settings.generalSearch={maxQueries:1,maxCandidates:100,maxAiCalls:10,batchSize:50,displayLimit:40,hideZeroSeeders:true};f.service=f.rebuild();const result=await f.service.search({...request,budgets:{displayLimit:3,candidateCap:100,batchSize:50,aiCalls:10,queryCount:1}});expect(result.releases).toHaveLength(45);const snapshot=f.state.getGeneralSearchSnapshot(result.searchId!);expect((snapshot?.payload as {releases:unknown[]}).releases).toHaveLength(45);});
  it('find-more uses action and prior sanitized results, creates a new selectable cumulative snapshot and preserves prior expiry',async()=>{
    const f=fixture([release({guid:'first-guid',title:'First title'})]);
    f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:5,batchSize:20,displayLimit:1,hideZeroSeeders:true};f.service=f.rebuild();
    let planning=0;
    f.llm.json=vi.fn(async(args:{label:string;user:string})=>{
      if(args.label.includes('planning')) { planning++; const input=JSON.parse(args.user) as {action:string;previousResults:Array<{title:string}>};
        if(input.action==='find-more') { expect(input.previousResults[0]?.title).toBe('First title'); return {mode:'search',queries:['fresh term'],question:''}; }
        return {mode:'search',queries:['first term'],question:''}; }
      const data=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};return {items:data.actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))};
    }) as never;
    const first=await f.service.search({...request,budgets:{queryCount:1,aiCalls:4}});
    const firstExpiry=first.releases[0]!.expiresAt;
    f.prowlarr.search=vi.fn(async({query}:{query:string})=>[release({guid:query==='fresh term'?'second-guid':'first-guid',title:query==='fresh term'?'Second title':'First title'})]) as never;
    const next=await f.service.search({...request,action:'find-more',previousSearchId:first.searchId!,confirmationToken:first.confirmationToken!,budgets:{queryCount:1,aiCalls:4}});
    expect(planning).toBe(2);expect(next.searchId).not.toBe(first.searchId);expect(next.releases.map(x=>x.releaseId)).toContain(first.releases[0]!.releaseId);expect(next.releases.find(x=>x.title==='First title')?.expiresAt).toBe(firstExpiry);expect(next.releases.find(x=>x.title==='Second title')?.selectable).toBe(true);
    const saved=f.state.getGeneralSearchSnapshot(next.searchId!);expect((saved?.payload as {releases:unknown[]}).releases).toHaveLength(2);expect(next.queries).toContain('fresh term');
  });
  it('uses actual results for iterative refinement and never emits an uncurated candidate',async()=>{
    const f=fixture([release({guid:'iter-1',title:'First batch'})]);f.settings.generalSearch={maxQueries:2,maxCandidates:20,maxAiCalls:8,batchSize:20,displayLimit:20,hideZeroSeeders:true};f.service=f.rebuild();
    let calls=0;f.llm.json=vi.fn(async(args:{label:string;user:string})=>{if(args.label.includes('planning')){const input=JSON.parse(args.user) as {inspiration?:{lastQuery?:string;results?:Array<{title:string}>}};if(input.inspiration?.lastQuery){expect(input.inspiration.results?.[0]?.title).toBe('First batch');return {mode:'search',queries:['second term'],question:''};}return {mode:'search',queries:['first term'],question:''};}const data=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};calls++;return {items:data.actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))};}) as never;
    f.prowlarr.search=vi.fn(async({query}:{query:string})=>[release({guid:query,title:query==='first term'?'First batch':'Second batch'})]) as never;
    const emitted: string[]=[];const result=await f.service.search({...request,budgets:{queryCount:2,aiCalls:8}},e=>{if(e.type==='results')emitted.push(...e.releases.map(x=>x.title));});
    expect(f.prowlarr.search).toHaveBeenCalledTimes(2);expect(result.queries).toEqual(['first term','second term']);expect(calls).toBe(2);expect(emitted).toContain('First batch');expect(emitted).toContain('Second batch');
  });
  it('does not search or persist when the planner exhausts the AI budget',async()=>{const f=fixture();const result=await f.service.search({...request,budgets:{aiCalls:1,queryCount:4}});expect(f.prowlarr.search).not.toHaveBeenCalled();expect(result.releases).toEqual([]);expect(f.state.getGeneralSearchSnapshot(result.searchId!)?.payload).toBeTruthy();});
  it('charges correction and transport attempts before each provider send',async()=>{
    for(const retry of ['correction','transport']) {
      const f=fixture();f.llm.json=vi.fn(async(args:{onAttempt?:(a:{logicalAttempt:number;transportAttempt:number})=>void})=>{
        args.onAttempt?.({logicalAttempt:0,transportAttempt:0});
        args.onAttempt?.(retry==='correction'?{logicalAttempt:1,transportAttempt:0}:{logicalAttempt:0,transportAttempt:1});
        return {mode:'search',queries:['should-not-run'],question:''};
      }) as never;
      await expect(f.service.search({...request,budgets:{aiCalls:1,queryCount:1}})).rejects.toMatchObject({code:'ai-budget-exhausted'});
      expect(f.prowlarr.search).not.toHaveBeenCalled();
    }
  });
  it('counts planner and every curation batch against AI budget and candidate cap',async()=>{
    const f=fixture(Array.from({length:8},(_,i)=>release({guid:`batch-${i}`,title:`Batch ${i}`})));
    const result=await f.service.search({...request,budgets:{queryCount:1,candidateCap:5,batchSize:2,aiCalls:4,displayLimit:1}});
    expect(f.llm.json).toHaveBeenCalledTimes(4); // planner + three bounded curation batches
    expect(result.releases).toHaveLength(5);expect((f.state.getGeneralSearchSnapshot(result.searchId!)?.payload as {releases:unknown[]}).releases).toHaveLength(5);
    const capped=fixture(Array.from({length:8},(_,i)=>release({guid:`cap-${i}`})));
    const capResult=await capped.service.search({...request,budgets:{queryCount:1,candidateCap:3,batchSize:2,aiCalls:3}});
    expect(capResult.releases).toHaveLength(3);
  });
  it('fails closed on unknown, duplicate, or missing curation classifications',async()=>{
    for(const mode of ['unknown','duplicate','missing']) {
      const f=fixture();
      f.llm.json=vi.fn(async(args:{label:string;user:string})=>{
        if(args.label.includes('planning')) return {mode:'search',queries:['term'],question:''};
        const data=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};
        const id=data.actualResults[0]!.releaseId;
        const items=mode==='unknown'?[{releaseId:'invented',classification:'match'}]:mode==='duplicate'?[{releaseId:id,classification:'match'},{releaseId:id,classification:'possible-match'}]:[];
        return {items};
      }) as never;
      await expect(f.service.search({...request,budgets:{queryCount:1,aiCalls:2}})).rejects.toMatchObject({code:'invalid-curation'});
    }
  });
  it('remembers rejected release identities across new snapshots without persisting raw metadata',async()=>{
    const f=fixture([release({guid:'repeat-guid',title:'Unrelated candidate'})]);f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:5,batchSize:20,displayLimit:20,hideZeroSeeders:true};f.service=f.rebuild();
    let plans=0;f.llm.json=vi.fn(async(args:{label:string;user:string})=>{if(args.label.includes('planning')){plans++;return {mode:'search',queries:[plans===1?'first term':'second term'],question:''};}const d=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};return {items:d.actualResults.map(x=>({releaseId:x.releaseId,classification:'clearly-unrelated'}))};}) as never;
    const progress:number[]=[];const first=await f.service.search({...request,budgets:{queryCount:1,aiCalls:3}},e=>{if(e.type==='curation')progress.push(e.processed);});expect(first.releases).toHaveLength(0);expect(progress).toContain(0);expect(progress).toContain(1);
    const second=await f.service.search({...request,action:'find-more',previousSearchId:first.searchId!,confirmationToken:first.confirmationToken!,budgets:{queryCount:1,aiCalls:3}});
    expect(f.prowlarr.search).toHaveBeenCalledTimes(2);expect(second.releases).toHaveLength(0);expect(JSON.stringify(f.state.getGeneralSearchSnapshot(second.searchId!)?.payload)).not.toContain('repeat-guid');
  });
  it('enforces snapshot continuation limits and immutable original-query identity',async()=>{
    const f=fixture();f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:12,batchSize:20,displayLimit:20,hideZeroSeeders:true};f.service=f.rebuild();let term=0;
    f.llm.json=vi.fn(async(args:{label:string;user:string})=>{if(args.label.includes('planning'))return {mode:'search',queries:[`continued-${++term}`],question:''};const d=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};return {items:d.actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))};}) as never;
    f.prowlarr.search=vi.fn(async({query}:{query:string})=>[release({guid:query,title:query})]) as never;
    let response=await f.service.search({...request,budgets:{queryCount:1,aiCalls:12}});
    for(let i=0;i<5;i++)response=await f.service.search({...request,action:'find-more',previousSearchId:response.searchId!,confirmationToken:response.confirmationToken!,budgets:{queryCount:1,aiCalls:12}});
    await expect(f.service.search({...request,action:'find-more',previousSearchId:response.searchId!,confirmationToken:response.confirmationToken!,budgets:{queryCount:1,aiCalls:12}})).rejects.toMatchObject({code:'follow-up-limit'});
    await expect(f.service.search({...request,originalQuery:'different',turns:[{role:'user',content:'different'}],action:'find-more',previousSearchId:response.searchId!,confirmationToken:response.confirmationToken!,budgets:{queryCount:1,aiCalls:12}})).rejects.toMatchObject({code:'invalid-request'});
  });
  it('rejects unknown budget keys and incompatible or unknown protocols before curation',async()=>{
    const f=fixture([release({guid:'news',protocol:'usenet'}),release({guid:'unknown',protocol:'unknown'})]);
    await expect(f.service.search({...request,budgets:{queryCount:1,unexpected:2}})).rejects.toMatchObject({code:'invalid-budget'});
    const result=await f.service.search({...request,budgets:{queryCount:1,aiCalls:3}});
    expect(result.releases).toHaveLength(0);expect(f.llm.json).toHaveBeenCalledTimes(1);
  });
  it('keeps known safe releases visible but nonselectable for ambiguous or incomplete routing',async()=>{
    const routingCases=[[],[{id:1,name:'General',enable:true,protocol:'torrent',supportsCategories:true,categories:[],routingDigest:''}],[1,2].map(id=>({id,name:'General',enable:true,protocol:'torrent',supportsCategories:true,categories:[],routingDigest:'a'.repeat(64)}))];
    for(const clients of routingCases){const f=fixture();f.prowlarr.getDownloadClients=vi.fn(async()=>clients) as never;const result=await f.service.search({...request,budgets:{queryCount:1,aiCalls:2}});expect(result.releases).toHaveLength(1);expect(result.releases[0]?.selectable).toBe(false);expect(result.blockedReason).toBe('destination-unavailable');}
  });
  it('carries clarification turns into planning and curation and enforces five follow-ups',async()=>{
    const f=fixture();f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:4,batchSize:20,displayLimit:20,hideZeroSeeders:true};f.service=f.rebuild();
    const evidence:string[]=[];
    f.llm.json=vi.fn(async(args:{label:string;user:string})=>{evidence.push(args.user);if(args.label.includes('planning'))return {mode:'search',queries:['answer-specific term'],question:''};const data=JSON.parse(args.user) as {conversation:Array<{content:string}>;actualResults:Array<{releaseId:string}>};expect(data.conversation.some(x=>x.content.includes('prefer documentaries'))).toBe(true);return {items:data.actualResults.map(x=>({releaseId:x.releaseId,classification:'possible-match'}))};}) as never;
    const turns=[{role:'user',content:'find a film'},{role:'assistant',content:'Which style?'},{role:'user',content:'prefer documentaries'}] as const;
    await f.service.search({...request,turns,action:'follow-up',budgets:{queryCount:1,aiCalls:4}});
    expect(evidence).toHaveLength(2);expect(evidence[0]).toContain('prefer documentaries');
    const over={...request,turns:Array.from({length:13},(_,i)=>({role:(i%2?'assistant':'user') as 'assistant'|'user',content:i===0?'find a film':'clarification '.repeat(1)}))};
    await expect(f.service.search(over)).rejects.toMatchObject({code:'invalid-request'});
  });
  it('clarification responses retain authenticated result metadata without storing transcript turns',async()=>{
    const f=fixture();const first=await f.service.search({...request,budgets:{queryCount:1,aiCalls:3}}),expiry=first.releases[0]!.expiresAt;
    f.llm.json=vi.fn(async()=>({mode:'clarify',queries:[],question:'Which decade?'})) as never;
    const clarification=await f.service.search({...request,action:'follow-up',previousSearchId:first.searchId!,confirmationToken:first.confirmationToken!});
    expect(clarification.status).toBe('clarification-needed');expect(clarification.releases[0]?.releaseId).toBe(first.releases[0]?.releaseId);expect(clarification.releases[0]?.expiresAt).toBe(expiry);expect(clarification.destination?.name).toBe('General');
    const payload=f.state.getGeneralSearchSnapshot(clarification.searchId!)?.payload as Record<string,unknown>;expect(payload.originalDigest).toBeDefined();expect(payload.turns).toBeUndefined();
  });
  it('checks cancellation and AI/source drift after upstream awaits before further work or saving',async()=>{
    const f=fixture();let finish!:()=>void, entered!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    f.prowlarr.search=vi.fn(async()=>{entered();await gate;return [release()];}) as never;
    const pending=f.service.search({...request,budgets:{queryCount:1,aiCalls:4}});await started;f.settings.ai.apiKey='rotated-key';finish();await expect(pending).rejects.toMatchObject({code:'settings-changed'});expect(f.llm.json).toHaveBeenCalledTimes(1);
  });
  it('keeps discovery visible but nonselectable without a destination and sanitizes destination names',async()=>{
    const f=fixture();f.prowlarr.getDownloadClients=vi.fn(async()=>[]) as never;
    const result=await f.service.search({...request,budgets:{queryCount:1,aiCalls:2}});
    expect(result.releases).toHaveLength(1);expect(result.releases[0]?.selectable).toBe(false);expect(result.blockedReason).toBe('destination-unavailable');
    const privateDestination=fixture();privateDestination.settings.integrations.prowlarr.generalClient='private-token=destination-secret';privateDestination.service=privateDestination.rebuild();privateDestination.prowlarr.getDownloadClients=vi.fn(async()=>[{id:1,name:'private-token=destination-secret',enable:true,protocol:'torrent',supportsCategories:true,categories:[],routingDigest:'a'.repeat(64)}]) as never;
    await expect(privateDestination.service.search({...request,budgets:{queryCount:1,aiCalls:2}})).rejects.toMatchObject({code:'destination-unavailable'});
  });
  it('rejects request budgets above configured settings and emits each refined query proposal',async()=>{
    const f=fixture();f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:4,batchSize:20,displayLimit:20,hideZeroSeeders:true};f.service=f.rebuild();
    await expect(f.service.search({...request,budgets:{queryCount:2}})).rejects.toMatchObject({code:'invalid-budget'});
    f.settings.generalSearch.maxQueries=2;f.service=f.rebuild();
    let planning=0;f.llm.json=vi.fn(async(args:{label:string;user:string})=>{if(args.label.includes('planning')){planning++;return planning===1?{mode:'search',queries:['first'],question:''}:{mode:'search',queries:['second'],question:''};}const data=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};return {items:data.actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))};}) as never;
    f.prowlarr.search=vi.fn(async({query}:{query:string})=>[release({guid:query})]) as never;
    const proposed:string[][]=[];await f.service.search({...request,budgets:{queryCount:2,aiCalls:4}},e=>{if(e.type==='queries')proposed.push(e.queries);});expect(proposed).toEqual([['first'],['second']]);
  });
  it('honors cancellation before any planner or upstream request',async()=>{const f=fixture();const controller=new AbortController();controller.abort();await expect(f.service.search(request,undefined,controller.signal)).rejects.toMatchObject({code:'aborted'});expect(f.llm.json).not.toHaveBeenCalled();expect(f.prowlarr.getDownloadClients).not.toHaveBeenCalled();});
  it('rejects prior snapshots when the destination routing identity changes',async()=>{
    const f=fixture();f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:4,batchSize:20,displayLimit:20,hideZeroSeeders:true};f.service=f.rebuild();
    const first=await f.service.search({...request,budgets:{queryCount:1,aiCalls:4}});
    const llmCalls=f.llm.json.mock.calls.length;f.llm.json=vi.fn(async()=>({mode:'clarify',queries:[],question:'Which?'})) as never;
    f.prowlarr.getDownloadClients=vi.fn(async()=>[{id:99,name:'General',enable:true,protocol:'torrent',supportsCategories:true,categories:[],routingDigest:'b'.repeat(64)}]) as never;
    await expect(f.service.search({...request,action:'find-more',previousSearchId:first.searchId!,confirmationToken:first.confirmationToken!,budgets:{queryCount:1,aiCalls:4}})).rejects.toMatchObject({code:'destination-changed'});
    expect(f.prowlarr.search).toHaveBeenCalledTimes(1);expect(f.llm.json).not.toHaveBeenCalled();expect(llmCalls).toBeGreaterThan(0);
  });
  it('rechecks runtime identity after planner and curation awaits',async()=>{
    const plannerFixture=fixture();let finishPlan!:()=>void,enteredPlan!:()=>void;const planGate=new Promise<void>(resolve=>{finishPlan=resolve;}),planStarted=new Promise<void>(resolve=>{enteredPlan=resolve;});
    plannerFixture.llm.json=vi.fn(async()=>{enteredPlan();await planGate;return {mode:'search',queries:['term'],question:''};}) as never;
    const planning=plannerFixture.service.search(request);await planStarted;plannerFixture.settings.integrations.prowlarr.apiKey='rotated-source';finishPlan();await expect(planning).rejects.toMatchObject({code:'settings-changed'});expect(plannerFixture.prowlarr.search).not.toHaveBeenCalled();expect(plannerFixture.llm.json).toHaveBeenCalledTimes(1);
    const curationFixture=fixture();let finishCuration!:()=>void,enteredCuration!:()=>void;const curationGate=new Promise<void>(resolve=>{finishCuration=resolve;}),curationStarted=new Promise<void>(resolve=>{enteredCuration=resolve;});
    curationFixture.llm.json=vi.fn(async(args:{label:string;user:string})=>{if(args.label.includes('planning'))return {mode:'search',queries:['term'],question:''};enteredCuration();await curationGate;const input=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};return {items:input.actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))};}) as never;
    const curating=curationFixture.service.search({...request,budgets:{queryCount:1,aiCalls:4}});await curationStarted;curationFixture.settings.ai.apiKey='changed-ai-key';finishCuration();await expect(curating).rejects.toMatchObject({code:'settings-changed'});
  });
  it('rejects a previous snapshot after AI identity drift before another paid call',async()=>{
    const f=fixture();const first=await f.service.search({...request,budgets:{queryCount:1,aiCalls:3}});const before=f.llm.json.mock.calls.length;f.settings.ai.model='different-model';
    await expect(f.service.search({...request,action:'find-more',previousSearchId:first.searchId!,confirmationToken:first.confirmationToken!})).rejects.toMatchObject({code:'settings-changed'});expect(f.llm.json).toHaveBeenCalledTimes(before);
  });
  it('drops candidates that expire while curation awaits',async()=>{
    let now=new Date('2026-10-06T12:00:00.000Z');const f=fixture();f.settings.generalSearch={maxQueries:1,maxCandidates:20,maxAiCalls:3,batchSize:20,displayLimit:20,hideZeroSeeders:true};
    f.service=new GeneralSearchConversationService({llm:f.llm as never,prowlarr:f.prowlarr as never,state:f.state,getSettings:()=>f.settings,now:()=>now});
    f.llm.json=vi.fn(async(args:{label:string;user:string})=>{if(args.label.includes('planning'))return {mode:'search',queries:['term'],question:''};now=new Date(now.getTime()+16*60_000);const d=JSON.parse(args.user) as {actualResults:Array<{releaseId:string}>};return {items:d.actualResults.map(x=>({releaseId:x.releaseId,classification:'match'}))};}) as never;
    const visible:string[]=[];const result=await f.service.search({...request,budgets:{queryCount:1,aiCalls:3}},e=>{if(e.type==='results')visible.push(...e.releases.map(x=>x.title));});expect(result.releases).toHaveLength(0);expect(visible).not.toContain('Example film');
  });
  it('keeps event sequence local across overlapping requests',async()=>{const f=fixture();const gate=new Promise<void>(resolve=>setTimeout(resolve,5));const a:number[]=[],b:number[]=[];const p1=f.service.search(request,e=>a.push(e.sequence));const p2=f.service.search(request,e=>b.push(e.sequence));await Promise.all([p1,p2,gate]);expect(a[0]).toBe(0);expect(b[0]).toBe(0);expect(a).toEqual(a.map((_,i)=>i));expect(b).toEqual(b.map((_,i)=>i));});
  it('rejects overlong conversation turns',async()=>{const f=fixture();await expect(f.service.search({...request,turns:[{role:'user',content:'x'.repeat(501)}]})).rejects.toMatchObject({code:'invalid-request'});});
});
