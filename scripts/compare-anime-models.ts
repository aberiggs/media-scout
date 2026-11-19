import { OpenRouter } from '@openrouter/sdk';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { evaluationOutputDirectory } from './evaluate-anime-search';
import { settingsSchema } from '../src/search/settings';
import { searchRequestSchema } from '../src/search/contracts';
import { validateRankedOptions } from '../src/search/selection';
import { stripFences } from '../src/clients/llm';

const MAX_CALLS = 16, DEADLINE_MS = 600_000, OUTPUT_TOKENS = 16_384;
const FINALIZATION_INSTRUCTION = '\n\nFinalization only: finish now from the already observed candidates. Return exactly ONE best useful plan when possible (partial is acceptable), otherwise no-match or needs-input. Do not invent all-series coverage from a year. Give concise reasons. Do not call tools.';
const nonempty = z.string().trim().min(1);
const TEXT_BOUNDS = { releaseCoverageReason:1000, releaseUncertainty:1000, planReason:2000, planUncertainty:2000, message:2000 } as const;
const release = z.object({ candidateId: nonempty, coveredTargetIds: z.array(nonempty).min(1), coverageReason: nonempty.max(TEXT_BOUNDS.releaseCoverageReason), uncertainty: z.string().max(TEXT_BOUNDS.releaseUncertainty) }).strict();
const option = z.object({ optionId: nonempty, rank: z.literal(1), releases: z.array(release).min(1).max(24), reason: nonempty.max(TEXT_BOUNDS.planReason), uncertainty: z.string().max(TEXT_BOUNDS.planUncertainty) }).strict();
export const finalizationSchema = z.object({
  action: z.literal('finish'), query: z.null(), categories: z.null(), indexerIds: z.null(),
  status: z.enum(['matched','no-match','needs-input']), options: z.array(option).max(1).nullable(), message: z.string().max(TEXT_BOUNDS.message).nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.status === 'matched' && v.options?.length !== 1) ctx.addIssue({ code:'custom', path:['options'], message:'matched requires one plan' });
  if (v.status !== 'matched' && v.options !== null) ctx.addIssue({ code:'custom', path:['options'], message:'non-match must have null options' });
});
type FrozenInput = { system: string; user: Record<string, any> };
export function inputFromArtifact(value: any): FrozenInput {
  const input = value?.decisions?.at(-1)?.input;
  if (!input || typeof input.system !== 'string' || !input.user || typeof input.user !== 'object') throw new Error('Artifact has no final model input.');
  const req = searchRequestSchema.parse(input.user.request);
  if (req.context?.scope?.type !== 'episode-set' || !Array.isArray(input.user.candidates)) throw new Error('Artifact is not a final episode-set input.');
  const candidateIds = new Set<string>();
  for (const candidate of input.user.candidates) {
    if (!candidate || typeof candidate.candidateId !== 'string' || !candidate.candidateId.trim() || candidateIds.has(candidate.candidateId) || !Array.isArray(candidate.observations) || candidate.excluded !== undefined && typeof candidate.excluded !== 'boolean' || candidate.excludedTargetIds !== undefined && !Array.isArray(candidate.excludedTargetIds))
      throw new Error('Artifact has malformed candidate observations.');
    candidateIds.add(candidate.candidateId);
    if (candidate.observations.some((o:any) => !o || typeof o.title !== 'string' || !o.title.trim())) throw new Error('Artifact has malformed candidate observations.');
  }
  return { system: input.system, user: input.user };
}
const { $schema: _schemaMeta, ...wireSchema } = z.toJSONSchema(finalizationSchema);
export function inputHash(input: FrozenInput): string { return createHash('sha256').update(JSON.stringify({ system:input.system+FINALIZATION_INSTRUCTION, user:input.user, jsonschema:wireSchema })).digest('hex'); }
export function safeTelemetry(v: any): any {
  const names = ['promptTokens','completionTokens','reasoningTokens','cachedTokens','totalTokens','cost'] as const;
  const usage = { ...v?.usage,
    reasoningTokens: v?.usage?.completionTokensDetails?.reasoningTokens ?? v?.usage?.reasoningTokens,
    cachedTokens: v?.usage?.promptTokensDetails?.cachedTokens ?? v?.usage?.cachedTokens };
  const out: Record<string, number|null> = {};
  for (const name of names) out[name] = typeof usage[name] === 'number' && Number.isFinite(usage[name]) && usage[name] >= 0 ? usage[name] : null;
  return { usage:out };
}
export function coverageReport(user: any, options: z.infer<typeof option>[]) {
  const targetIds = new Set<string>((user.request?.context?.targets ?? []).map((t: any) => t.targetId));
  const candidates = new Map<string, any>((user.candidates ?? []).map((c: any) => [c.candidateId, c]));
  const forbidden = new Map<string, Set<string>>((user.candidates ?? []).map((c: any) => [c.candidateId, new Set(c.excludedTargetIds ?? c.excludedTargets ?? [])]));
  let valid = options.length > 0;
  for (const o of options) for (const r of o.releases) if (!candidates.has(r.candidateId) || r.coveredTargetIds.some(t => !targetIds.has(t) || forbidden.get(r.candidateId)?.has(t))) valid = false;
  const candidateIds = new Set(candidates.keys());
  const candidateIdsObserved: Record<string, Array<{tvdb:number|null;tmdb:number|null}>> = {};
  for (const c of user.candidates ?? []) candidateIdsObserved[c.candidateId] = (c.observations ?? []).map((o:any) => ({tvdb:typeof o.tvdbId==='number'?o.tvdbId:null,tmdb:typeof o.tmdbId==='number'?o.tmdbId:null}));
  const expectedIds = user.request?.context?.externalIds ?? {};
  const validated = validateRankedOptions(options as any, candidateIds, targetIds, { type:'episode-set', expectedIds, candidateIds:candidateIdsObserved });
  valid &&= validated.valid;
  return {
    valid, covered: [...new Set(options.flatMap(o => o.releases.flatMap(r => r.coveredTargetIds)))].length,
    targetCount: targetIds.size,
    selected: options.flatMap(o => o.releases.map(r => ({ candidateId:r.candidateId, titles:(candidates.get(r.candidateId)?.observations ?? []).map((x: any) => x.title), coveredTargetIds:r.coveredTargetIds, coverageReason:r.coverageReason, uncertainty:r.uncertainty }))),
    validatorError: validated.error ?? null,
  };
}
interface Cli { db:string; out:string; comparator:string; inputs:string[]; repeat:number }
function parseArgs(argv: string[]): Cli {
  const vals: Record<string,string[]> = {};
  for (let i=0;i<argv.length;i++) {
    const key=argv[i]!;
    if (!key.startsWith('--')) throw new Error('Expected named options.');
    if (key === '--input') (vals[key] ??= []).push(argv[++i] ?? '');
    else { const value=argv[++i]; if (!value) throw new Error(`Missing value for ${key}`); (vals[key] ??= []).push(value); }
  }
  const one=(k:string)=>vals[k]?.at(-1);
  const db=one('--db'),out=one('--out'), comparator=one('--comparator') ?? 'openai/gpt-6.1-sol';
  const inputs=[...(vals['--input'] ?? []), ...(one('--inputs')?.split(',') ?? [])].filter(Boolean);
  const repeat=Number(one('--repeat') ?? 2);
  if (!db || !out || !inputs.length || !Number.isInteger(repeat) || repeat<1 || repeat>3 || inputs.length>8 || inputs.length*repeat*2>MAX_CALLS)
    throw new Error('Usage: --db <settings.sqlite> --out <external-dir> --comparator <provider/model> --repeat 1..3 --input <artifact.json> [--input ...] (maximum 16 calls).');
  return { db:resolve(db),out:resolve(out),comparator,inputs:inputs.map(p=>resolve(p)),repeat };
}
function savedSettings(path:string) {
  const db=new Database(path,{readonly:true,fileMustExist:true});
  try { const row=db.prepare("SELECT value_json FROM settings WHERE key='application-settings'").get() as {value_json:string}|undefined; if(!row) throw new Error('Saved settings missing.'); return settingsSchema.parse(JSON.parse(row.value_json)); }
  finally { db.close(); }
}
function main() {
  const cli=parseArgs(process.argv.slice(2)); cli.out=evaluationOutputDirectory(cli.out,fileURLToPath(new URL('..',import.meta.url)));
  const settings=savedSettings(cli.db); if(!settings.ai.apiKey || !settings.ai.model) throw new Error('Configured model and key required.');
  if(settings.ai.model===cli.comparator) throw new Error('Comparator must differ from the configured baseline model.');
  const cases=cli.inputs.map(path=>({path,input:inputFromArtifact(JSON.parse(readFileSync(path,'utf8')))}));
  const runId=`comparison-${new Date().toISOString().replace(/[:.]/gu,'-')}`, path=resolve(cli.out,`${runId}.json`);
  const calls=cases.flatMap((_c,i)=>Array.from({length:cli.repeat},(_,r)=>({caseIndex:i,repeat:r}))).flatMap(x=>[
    { ...x, model:settings.ai.model }, { ...x, model:cli.comparator },
  ]);
  const report:any={runId,models:[settings.ai.model,cli.comparator],protocol:{id:'one-plan-production-text-bounds-v1',responseCodec:'production stripFences then JSON/schema validation',purpose:'evaluation-only finalization; no tools; same frozen user and system input; append identical finalization instruction',reasoningParameters:'provider defaults; unspecified',outputTokens:OUTPUT_TOKENS,timeoutMs:DEADLINE_MS,maxConcurrency:2,retries:0,textBounds:TEXT_BOUNDS},inputs:cases.map(c=>({artifact:c.path,sha256:inputHash(c.input),system:c.input.system+FINALIZATION_INSTRUCTION,user:c.input.user,jsonSchema:wireSchema})),attempts:[],complete:false};
  const persist=()=>{ const temporaryPath=`${path}.${process.pid}.tmp`; writeFileSync(temporaryPath,JSON.stringify(report,null,2)+'\n',{mode:0o600}); renameSync(temporaryPath,path); };
  persist();
  const client=new OpenRouter({apiKey:settings.ai.apiKey,serverURL:settings.ai.baseUrl});
  const controller=new AbortController(); let cancelled=false, blocked=false;
  const abort=()=>{cancelled=true;controller.abort(new Error('Cancelled by signal'));}; process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const worker=async(model:string)=>{ const modelCalls=calls.filter(call=>call.model===model); let next=0; while(!cancelled && !blocked) {
    const spec=modelCalls[next++]; if(!spec)return; const c=cases[spec.caseIndex]!;
    const attempt:any={model:spec.model,inputSha256:inputHash(c.input),repeat:spec.repeat+1,outcome:'pending'}; report.attempts.push(attempt); persist();
    const localController=new AbortController();
    const abortLocal=()=>localController.abort(controller.signal.reason);
    controller.signal.addEventListener('abort',abortLocal,{once:true});
    const started=Date.now(); let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const completion:any=await Promise.race([
        client.chat.send({chatRequest:{model:spec.model,messages:[{role:'system',content:c.input.system+FINALIZATION_INSTRUCTION},{role:'user',content:JSON.stringify(c.input.user)}],maxTokens:OUTPUT_TOKENS,responseFormat:{type:'json_schema',jsonSchema:{name:'episode_set_finalization',strict:true,schema:wireSchema as any}},provider:{requireParameters:true}}},{signal:localController.signal,retries:{strategy:'none'}}),
        new Promise((_,reject)=>{timer=setTimeout(()=>{const e=new Error('Timed out');e.name='TimeoutError';localController.abort(e);reject(e);},DEADLINE_MS);})
      ]);
      if(timer) clearTimeout(timer);
      const choice=completion.choices?.[0], content=choice?.message?.content;
      attempt.elapsedMs=Date.now()-started; attempt.finishReason=choice?.finishReason ?? null; attempt.returnedModel=completion.model ?? null; attempt.returnedProvider=completion.provider ?? null;
      attempt.outputTokenLimit=OUTPUT_TOKENS;
      attempt.usage=safeTelemetry({usage:completion.usage}).usage;
      if (String(attempt.finishReason).toLowerCase()==='length') attempt.failure='output_token_limit_truncation';
      if(typeof content!=='string') throw new Error('missing-content');
      let parsed; try { parsed=finalizationSchema.parse(JSON.parse(stripFences(content))); } catch { attempt.failure ??='schema_or_json_failure'; throw Object.assign(new Error('schema-or-json'),{recorded:true}); }
      attempt.output=parsed;
      if(parsed.status==='matched') { const coverage=coverageReport(c.input.user,parsed.options!); attempt.validation=coverage; if(!coverage.valid) attempt.failure ??='selection_validation_failure'; }
      attempt.outcome=attempt.failure?'failure':'success';
      console.info(`${spec.model} input ${spec.caseIndex+1} repeat ${spec.repeat+1}: ${attempt.outcome}`);
    } catch(e:any) {
      attempt.elapsedMs=Date.now()-started;
      const code=Number(e?.statusCode ?? e?.status);
      if([401,402,403].includes(code)) { attempt.failure=`account_or_authorization_http_${code}`; blocked=true; }
      else attempt.failure ??= localController.signal.reason?.name==='TimeoutError'?'timeout':cancelled?'cancelled':'http_or_request_failure';
      attempt.outcome='failure';
    } finally { if(timer) clearTimeout(timer); controller.signal.removeEventListener('abort',abortLocal);persist(); }
  }};
  return Promise.all([worker(settings.ai.model),worker(cli.comparator)]).then(()=>{for(const model of [settings.ai.model,cli.comparator]) { const completed=report.attempts.filter((a:any)=>a.model===model).length; for(const spec of calls.filter(call=>call.model===model).slice(completed))report.attempts.push({model:spec.model,inputSha256:inputHash(cases[spec.caseIndex]!.input),repeat:spec.repeat+1,outcome:'not_run',failure:blocked?'account_or_authorization_block':'cancelled'}); }report.complete=true;report.cancelled=cancelled;report.blocked=blocked;report.failed=report.attempts.filter((a:any)=>a.outcome==='failure').length;persist();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);console.info(`Comparison report: ${path}`);if(report.attempts.every((a:any)=>a.outcome!=='success'))process.exitCode=1;});
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{console.error('Model comparison failed; inspect secured report if created.');process.exitCode=1;});
