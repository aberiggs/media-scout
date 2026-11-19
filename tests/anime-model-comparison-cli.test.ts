import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path,{recursive:true,force:true})));

const validOutput = JSON.stringify({action:'finish',query:null,categories:null,indexerIds:null,status:'matched',message:null,options:[{optionId:'one',rank:1,releases:[{candidateId:'c1',coveredTargetIds:['t1'],coverageReason:'observed candidate',uncertainty:'exactly one observed episode'}],reason:'useful partial plan',uncertainty:'partial coverage only'}]});
const completion = (content:string, finish='stop') => JSON.stringify({
  id:'fake-response',created:1,object:'chat.completion',model:'returned-model',provider:'fake-provider',system_fingerprint:'test-fingerprint',
  choices:[{index:0,message:{role:'assistant',content},finish_reason:finish}],
  usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20,cost:0.001,prompt_tokens_details:{cached_tokens:3},completion_tokens_details:{reasoning_tokens:2}},
});

function bodyOf(req:IncomingMessage):Promise<any> {
  return new Promise((resolveBody,reject)=>{let data='';req.setEncoding('utf8');req.on('data',x=>data+=x);req.on('end',()=>{try{resolveBody(JSON.parse(data));}catch(e){reject(e);}});req.on('error',reject);});
}
function respond(res:ServerResponse,status:number,body:string) {
  res.writeHead(status,{'content-type':'application/json'});res.end(body);
}
async function closeServer(server:Server) { await new Promise<void>((resolveClose,reject)=>server.close(e=>e?reject(e):resolveClose())); }
function launch(db:string,out:string,input:string,repeat:number) {
  return new Promise<{code:number|null;stdout:string;stderr:string}>((resolveRun,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',resolve('scripts/compare-anime-models.ts'),'--db',db,'--out',out,'--comparator','fake/comparator','--repeat',String(repeat),'--input',input],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',x=>stdout+=x);child.stderr.setEncoding('utf8').on('data',x=>stderr+=x);
    const safety=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('comparison CLI exceeded 20-second test safety bound'));},20_000);
    child.on('error',e=>{clearTimeout(safety);reject(e);});
    child.on('close',code=>{clearTimeout(safety);resolveRun({code,stdout,stderr});});
  });
}
function prepare() {
  const root=mkdtempSync(join(tmpdir(),'anime-model-cli-'));roots.push(root);
  const db=join(root,'settings.sqlite'),out=join(root,'external-output'),input=join(root,'frozen-input.json');
  const store=openSearchStore(db);
  store.setSetting('application-settings',{...defaultSettings,ai:{...defaultSettings.ai,apiKey:'test-only-key',model:'fake/baseline',baseUrl:'',preferences:''}});
  store.close();
  const user={request:{prompt:'Find the observed episode',context:{kind:'tv',scope:{type:'episode-set'},targets:[{targetId:'t1',seasonNumber:1,episodeNumber:1,absoluteEpisodeNumber:1}]}},enabledIndexers:[],transcript:[],candidates:[{candidateId:'c1',excluded:false,excludedTargetIds:[],observations:[{title:'Observed episode release',tvdbId:null,tmdbId:null}]}],remaining:{decisions:0,searches:0}};
  writeFileSync(input,JSON.stringify({decisions:[{input:{system:'Use observed evidence.',user}}]}));
  return {root,db,out,input,user};
}
async function serverFor(handler:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>) {
  const server=createServer((req,res)=>void Promise.resolve(handler(req,res)).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();}));
  await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  const address=server.address();if(!address || typeof address==='string')throw new Error('local fake server did not bind');
  return {server,url:`http://127.0.0.1:${address.port}`};
}
function reportIn(out:string) {
  const filename=readdirSync(out).find(name=>name.startsWith('comparison-')&&name.endsWith('.json'));
  if(!filename)throw new Error('manifest was not persisted before request');
  return {path:join(out,filename),value:JSON.parse(readFileSync(join(out,filename),'utf8'))};
}

describe('comparison CLI against the real SDK and local HTTP boundary',()=>{
  it('runs four bounded requests with frozen protocol, telemetry, and incremental report persistence',async()=>{
    const f=prepare(), requests:any[]=[],paths:string[]=[], perModel=new Map<string,number>(), pending=new Set<ServerResponse>(), manifestReadFailures:string[]=[];
    let inFlight=0,maxInFlight=0,maxPerModel=0,firstPairReleased=false;
    let releasePair!:()=>void;const firstPair=new Promise<void>(resolvePair=>releasePair=resolvePair);
    let serverInfo:{server:Server;url:string}|undefined;
    try {
      serverInfo=await serverFor(async(req,res)=>{
        expect(req.method).toBe('POST');paths.push(req.url??'');
        expect(req.headers.authorization).toBe('Bearer test-only-key');
        const body=await bodyOf(req);requests.push(body);
        const model=String(body.model);const count=(perModel.get(model)??0)+1;perModel.set(model,count);
        inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);maxPerModel=Math.max(maxPerModel,count);
        let current:ReturnType<typeof reportIn>;
        try { current=reportIn(f.out); }
        catch (error) { manifestReadFailures.push(error instanceof Error ? error.message : String(error)); throw error; }
        expect(current.value.inputs).toHaveLength(1);
        expect(current.value.inputs[0]).toMatchObject({system:expect.stringContaining('Use observed evidence.'),user:f.user});
        expect(current.value.inputs[0].jsonSchema.required).toContain('options');
        expect(current.value.attempts.some((a:any)=>a.outcome==='pending')).toBe(true);
        if(requests.length<=2&&!firstPairReleased) { pending.add(res);if(pending.size===2){firstPairReleased=true;releasePair();}await firstPair; }
        respond(res,200,completion(`\`\`\`json\n${validOutput}\n\`\`\``));
        res.on('finish',()=>{inFlight--;perModel.set(model,(perModel.get(model)??1)-1);});
      });
      const store=openSearchStore(f.db);store.setSetting('application-settings',{...defaultSettings,ai:{...defaultSettings.ai,apiKey:'test-only-key',model:'fake/baseline',baseUrl:serverInfo.url,preferences:''}});store.close();
      const result=await launch(f.db,f.out,f.input,2);
      expect(result.code,result.stderr).toBe(0);expect(requests).toHaveLength(4);expect(maxInFlight).toBeLessThanOrEqual(2);expect(maxPerModel).toBe(1);
      expect(paths.every(p=>p.endsWith('/chat/completions'))).toBe(true);
      expect(requests.map(r=>r.model).sort()).toEqual(['fake/baseline','fake/baseline','fake/comparator','fake/comparator']);
      for(const req of requests) {
        expect(req.max_tokens).toBe(16_384);
        expect(req.provider).toMatchObject({require_parameters:true});
        expect(req.messages[0].content).toContain('Finalization only: finish now');
      }
      expect(requests[0].messages).toEqual(requests[1].messages);
      expect(requests[0].response_format).toEqual(requests[1].response_format);
      expect(requests[0].messages).toEqual(requests[2].messages);
      expect(requests[0].response_format).toEqual(requests[2].response_format);
      const artifact=reportIn(f.out);
      expect(artifact.value.complete).toBe(true);expect(artifact.value.attempts).toHaveLength(4);
      expect(artifact.value.protocol).toMatchObject({id:'one-plan-production-text-bounds-v1',responseCodec:'production stripFences then JSON/schema validation',outputTokens:16_384,timeoutMs:600_000,textBounds:{releaseCoverageReason:1000,releaseUncertainty:1000,planReason:2000,planUncertainty:2000,message:2000}});
      expect(manifestReadFailures, 'the server must never observe a partially-written persisted report').toEqual([]);
      for(const [index,attempt] of artifact.value.attempts.entries()) {
        expect(attempt,`attempt ${index+1} telemetry and outcome`).toMatchObject({outcome:'success',usage:{promptTokens:12,completionTokens:8,reasoningTokens:2,cachedTokens:3,cost:0.001}});
      }
      expect(statSync(artifact.path).mode&0o777).toBe(0o600);
    } finally {if(serverInfo)await closeServer(serverInfo.server);}
  });

  it('stops scheduling and persists remaining calls after a real SDK 401 response',async()=>{
    const f=prepare(),requests:any[]=[];let serverInfo:{server:Server;url:string}|undefined;
    try {
      serverInfo=await serverFor(async(req,res)=>{requests.push(await bodyOf(req));respond(res,401,JSON.stringify({error:{code:401,message:'invalid test authorization'}}));});
      const store=openSearchStore(f.db);store.setSetting('application-settings',{...defaultSettings,ai:{...defaultSettings.ai,apiKey:'test-only-key',model:'fake/baseline',baseUrl:serverInfo.url,preferences:''}});store.close();
      const result=await launch(f.db,f.out,f.input,2);
      expect(result.code).not.toBe(0);expect(requests.length).toBeLessThanOrEqual(2);
      const {value}=reportIn(f.out);expect(value.blocked).toBe(true);
      expect(value.attempts.some((a:any)=>a.failure==='account_or_authorization_http_401')).toBe(true);
      expect(value.attempts.some((a:any)=>a.outcome==='not_run'&&a.failure==='account_or_authorization_block')).toBe(true);
      expect(JSON.stringify(value)).not.toContain('test-only-key');
    } finally {if(serverInfo)await closeServer(serverInfo.server);}
  });

  it('retains token-limit truncation as the primary failure if truncated JSON also fails parsing',async()=>{
    const f=prepare(),requests:any[]=[];let serverInfo:{server:Server;url:string}|undefined;
    try {
      serverInfo=await serverFor(async(req,res)=>{requests.push(await bodyOf(req));respond(res,200,completion('{','length'));});
      const store=openSearchStore(f.db);store.setSetting('application-settings',{...defaultSettings,ai:{...defaultSettings.ai,apiKey:'test-only-key',model:'fake/baseline',baseUrl:serverInfo.url,preferences:''}});store.close();
      const result=await launch(f.db,f.out,f.input,1);
      expect(result.code).not.toBe(0);expect(requests).toHaveLength(2);
      const {value}=reportIn(f.out);expect(value.attempts).toHaveLength(2);
      expect(value.attempts.every((a:any)=>a.finishReason==='length'&&a.failure==='output_token_limit_truncation'&&a.outcome==='failure')).toBe(true);
    } finally {if(serverInfo)await closeServer(serverInfo.server);}
  });
});
