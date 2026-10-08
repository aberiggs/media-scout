import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowRight, Check, Clock3, LoaderCircle, Search, ShieldCheck, Sparkles, X, SlidersHorizontal, Square, Plus } from 'lucide-react'
import type { GeneralConversationRelease, GeneralSearchBudgets, GeneralSearchConversationRequest, GeneralSearchConversationResponse, GeneralSearchDiagnostics, GeneralSearchOperationStatus, GeneralSearchProgressEvent, GeneralSearchTurn } from '../../src/types/general-search'

const defaults: GeneralSearchBudgets = { queryCount: 6, candidateCap: 200, aiCalls: 12, batchSize: 20, displayLimit: 40, hideZeroSeeders: true }
const labels: Record<string, string> = { planning: 'Planning search', queries: 'Search terms', searching: 'Searching indexers', results: 'Candidates found', curation: 'Checking relevance', complete: 'Search complete', error: 'Search stopped' }
const stopReasonCopy:Record<string,string>={
  'sufficient-results':'Stopped after enough candidates were found.','no-novelty':'Stopped because searches were no longer finding new candidates.','low-yield':'Stopped because recent searches were returning few new candidates.','budget-exhausted':'Search limits were reached.','deadline':'The search time limit was reached.','proposals-exhausted':'No further search terms were available.','completed':'Search completed.','provider-refusal':'The AI service declined to continue.','source-failure':'One or more searches failed.',
}

function eventValue(value: unknown): value is GeneralSearchProgressEvent { return Boolean(value && typeof value === 'object' && 'type' in value) }
const stopReasons = new Set(['sufficient-results','no-novelty','low-yield','budget-exhausted','deadline','proposals-exhausted','completed','provider-refusal','source-failure'])
const protocols = new Set(['unknown','usenet','torrent'])
const finiteCount=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0
function validDiagnostics(value:unknown):value is GeneralSearchDiagnostics {
  if(!value||typeof value!=='object')return false
  const d=value as any,l=d.ledger,a=l?.assessed
  return typeof d.complete==='boolean'&&stopReasons.has(d.stopReason)&&d.sourceInventory==='not-reported'&&finiteCount(l?.raw)&&finiteCount(l?.added)&&finiteCount(l?.duplicates)&&finiteCount(l?.reactivated)&&finiteCount(l?.reassessed)&&Boolean(l?.filtered&&typeof l.filtered==='object'&&!Array.isArray(l.filtered)&&Object.values(l.filtered).every(finiteCount))&&Boolean(a&&finiteCount(a.match)&&finiteCount(a.possible)&&finiteCount(a.unrelated)&&finiteCount(a.unassessed))&&Array.isArray(l?.outcomes)&&l.outcomes.every((o:unknown)=>Boolean(o&&typeof o==='object'&&typeof (o as any).query==='string'&&['success','failed'].includes((o as any).outcome)&&finiteCount((o as any).raw)&&finiteCount((o as any).added)))
}
function validRelease(value:unknown):value is GeneralConversationRelease {
  if(!value||typeof value!=='object')return false
  const r=value as any
  if(['apiKey','password','credentials','authorization'].some(key=>key in r))return false
  if(typeof r.releaseId!=='string'||!r.releaseId||typeof r.title!=='string'||!r.title.trim()||typeof r.indexer!=='string'||!(r.size===null||finiteCount(r.size))||!(r.seeders===null||finiteCount(r.seeders))||!(r.leechers===null||finiteCount(r.leechers))||!finiteCount(r.age)||!protocols.has(r.protocol)||typeof r.selectable!=='boolean'||!(r.unavailableReason===null||typeof r.unavailableReason==='string')||typeof r.expiresAt!=='string'||!Number.isFinite(Date.parse(r.expiresAt)))return false
  if(r.relevance!==undefined&&(!r.relevance||!['match','possible-match'].includes(r.relevance.classification)||(r.relevance.explanation!==undefined&&typeof r.relevance.explanation!=='string')))return false
  if(r.viability!==undefined&&(!r.viability||typeof r.viability.viable!=='boolean'||!['viable','zero-seeders','stale','unsafe','incompatible','unknown'].includes(r.viability.reason)))return false
  if(r.assessment!==undefined&&(!r.assessment||!['match','possible-match','rejected','unassessed'].includes(r.assessment.status)||typeof r.assessment.constraintVersion!=='string'))return false
  return true
}
function validResponse(value:unknown):value is GeneralSearchConversationResponse {
  if(!value||typeof value!=='object')return false
  const r=value as any
  if(!['clarification-needed','selection-required'].includes(r.status)||typeof r.query!=='string'||!Array.isArray(r.queries)||!r.queries.every((q:unknown)=>typeof q==='string'&&q.length<=2000)||typeof r.question!=='string'||!(r.searchId===null||typeof r.searchId==='string')||!(r.expiresAt===null||(typeof r.expiresAt==='string'&&Number.isFinite(Date.parse(r.expiresAt))))||!(r.confirmationToken===null||typeof r.confirmationToken==='string')||!Array.isArray(r.releases)||!r.releases.every(validRelease)||!(r.destination===null||(r.destination&&typeof r.destination.name==='string'&&r.destination.name.length>0&&['usenet','torrent'].includes(r.destination.protocol)))||typeof r.dryRun!=='boolean'||typeof r.actionsAllowed!=='boolean'||!(r.blockedReason===null||typeof r.blockedReason==='string'))return false
  return r.diagnostics===undefined||validDiagnostics(r.diagnostics)
}
function validEvent(value: unknown): value is GeneralSearchProgressEvent {
  if(!eventValue(value)) return false
  const e=value as any
  if(!Number.isSafeInteger(e.sequence)||e.sequence<0) return false
  if(e.runId!==undefined&&typeof e.runId!=='string') return false
  if(e.stageId!==undefined&&typeof e.stageId!=='string') return false
  if(e.type==='planning') return e.message===undefined||typeof e.message==='string'
  if(e.type==='queries') return Array.isArray(e.queries)&&e.queries.length<=100&&e.queries.every((x:unknown)=>typeof x==='string'&&x.length<=2000)
  if(e.type==='searching') return typeof e.query==='string'&&e.query.length<=2000&&Number.isSafeInteger(e.index)&&e.index>=0&&Number.isSafeInteger(e.total)&&e.total>=e.index
  if(e.type==='results') return Array.isArray(e.releases)&&e.releases.every(validRelease)&&(e.provisional===undefined||e.provisional===true)
  if(e.type==='curation') return Number.isSafeInteger(e.processed)&&e.processed>=0&&Number.isSafeInteger(e.total)&&e.total>=e.processed
  if(e.type==='complete') return validResponse(e.response)
  if(e.type==='error') return typeof e.message==='string'&&e.message.length<=4000&&typeof e.code==='string'&&e.code.length<=200&&(e.diagnostics===undefined||validDiagnostics(e.diagnostics))&&(e.partialReleases===undefined||(Array.isArray(e.partialReleases)&&e.partialReleases.every(validRelease)))
  return false
}
const releaseStatuses = new Set(['pending','submitting','submitted','previously-submitted','dry-run','failed','uncertain','not-attempted'])
function isStatus(value: unknown, expected: { id: string; manifest: string[]; mode: 'live'|'dry-run'; destination: { name: string; protocol: 'usenet'|'torrent' } }): value is GeneralSearchOperationStatus {
  if (!value || typeof value !== 'object') return false
  const x = value as Partial<GeneralSearchOperationStatus>
  if (x.operationId !== expected.id || !Array.isArray(x.releases) || x.releases.length !== expected.manifest.length || x.mode !== expected.mode || !x.destination || x.destination.name !== expected.destination.name || x.destination.protocol !== expected.destination.protocol || typeof x.expiresAt !== 'string' || !Number.isFinite(Date.parse(x.expiresAt)) || !Number.isSafeInteger(x.nextOrdinal) || (x.nextOrdinal as number) < 0 || (x.nextOrdinal as number) > expected.manifest.length || typeof x.stopped !== 'boolean' || typeof x.complete !== 'boolean') return false
  if (x.releases.some((r,i) => !r || r.releaseId !== expected.manifest[i] || !releaseStatuses.has(r.status as string) || !(r.code === null || typeof r.code === 'string'))) return false
   const ordinal = x.nextOrdinal as number
   const stopped = x.stopped
   if (!x.releases.every((r,i) => {
     if (i < ordinal) {
       if (r.status === 'submitting') return i === ordinal - 1 && !stopped && !x.complete
       return ['submitted','previously-submitted','dry-run','failed','uncertain','not-attempted'].includes(r.status)
     }
     return stopped ? r.status === 'not-attempted' : r.status === 'pending'
   })) return false
  if (x.releases.some(r => r.status === 'uncertain') && ordinal < expected.manifest.length && !x.stopped && !x.complete) return false
  return true
}
function uuid() { return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}` }

export function GeneralSearchPage() {
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [turns, setTurns] = useState<readonly GeneralSearchTurn[]>([])
  const [result, setResult] = useState<GeneralSearchConversationResponse | null>(null)
  const [snapshotCurrent, setSnapshotCurrent] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState('')
  const [operationError, setOperationError] = useState('')
  const [events, setEvents] = useState<GeneralSearchProgressEvent[]>([])
  const [operation, setOperation] = useState<GeneralSearchOperationStatus | null>(null)
  const [operationId, setOperationId] = useState('')
  const [operationUnknownId, setOperationUnknownId] = useState('')
  const [page, setPage] = useState(0)
  const [frozenSelection, setFrozenSelection] = useState<string[]>([])
  const [budget, setBudget] = useState<GeneralSearchBudgets>(defaults)
  const [budgetCeilings, setBudgetCeilings] = useState({ queryCount: 20, candidateCap: 1000, aiCalls: 100, batchSize: 100, displayLimit: 1000 })
  const [now, setNow] = useState(Date.now())
  const sequence = useRef(0), operationSequence = useRef(0), controller = useRef<AbortController | null>(null)
  const searchRun = useRef(0)
  const backendRunId = useRef<string|null>(null), lastEventSequence=useRef(-1)
  const pendingRun=useRef<{id:number;action:GeneralSearchConversationRequest['action']}|null>(null)
  const searchAuth=useRef<{searchId:string;confirmationToken:string}|null>(null)
  const [provisional, setProvisional] = useState<GeneralConversationRelease[]>([])
  const [errorDiagnostics,setErrorDiagnostics]=useState<GeneralSearchDiagnostics|null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activityStage, setActivityStage] = useState('')
  const [activityQueries, setActivityQueries] = useState<string[]>([])
  const [curation, setCuration] = useState<{processed:number;total:number}|null>(null)
  const stopRequested = useRef(new Set<string>())
  const manifestRef = useRef<string[]>([])
  const unknownContext = useRef<{ id: string; manifest: string[]; mode: 'live'|'dry-run'; destination: { name: string; protocol: 'usenet'|'torrent' } } | null>(null)
  const opener = useRef<HTMLElement | null>(null), dialog = useRef<HTMLElement | null>(null), focusTarget = useRef<HTMLButtonElement | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const releases = result?.releases ?? provisional
  const pages = Math.max(1, Math.ceil(releases.length / Math.max(1, budget.displayLimit)))
  const visible = releases.slice(page * Math.max(1,budget.displayLimit), (page + 1) * Math.max(1,budget.displayLimit))
  const continuationCount = Math.max(0, turns.filter(t => t.role === 'user').length - 1)
  const continuationLocked = continuationCount >= 5 || searchBusy || dialogOpen
  const operationResolved=Boolean(operation&&(operation.complete||operation.stopped)&&!operation.releases.some(r=>r.status==='uncertain'||r.status==='submitting'))
  const operationLocksSubmit=Boolean(busy||operationUnknownId||(operation&&!operationResolved))
  const expired = Boolean(result?.expiresAt && Date.parse(result.expiresAt) <= now)
  const selectedExpired = selected.some(id => { const release=result?.releases.find(r=>r.releaseId===id); return Boolean(release && Date.parse(release.expiresAt)<=now) })
  const blocked = Boolean(!snapshotCurrent || !result?.searchId || !result.confirmationToken || !result.actionsAllowed || !result.destination || expired || selectedExpired || operationLocksSubmit)
  const diagnostics=errorDiagnostics??(snapshotCurrent?result?.diagnostics:undefined)
  useEffect(() => () => { sequence.current++; searchRun.current++; operationSequence.current++; controller.current?.abort() }, [])
  useEffect(() => {
    let active = true
    void fetch('/api/settings').then(r => r.ok ? r.json() : null).then((payload: unknown) => {
      if (!active || !payload || typeof payload !== 'object') return
      const raw = (payload as { settings?: { generalSearch?: Record<string, unknown> } }).settings?.generalSearch
      if (!raw) return
      const ceiling = (key: string, fallback: number, hardMax: number) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? Math.max(1, Math.min(hardMax, Math.floor(raw[key] as number))) : fallback
      const next = { queryCount: ceiling('maxQueries', 6, 20), candidateCap: ceiling('maxCandidates', 200, 1000), aiCalls: ceiling('maxAiCalls', 12, 100), batchSize: ceiling('batchSize', 20, 100), displayLimit: ceiling('displayLimit', 40, 1000) }
      setBudgetCeilings(next)
      setBudget(current => ({ ...current, queryCount: Math.min(current.queryCount,next.queryCount), candidateCap: Math.min(current.candidateCap,next.candidateCap), aiCalls: Math.min(current.aiCalls,next.aiCalls), batchSize: Math.min(current.batchSize,next.batchSize), displayLimit: Math.min(current.displayLimit,next.displayLimit), hideZeroSeeders: typeof raw.hideZeroSeeders === 'boolean' ? raw.hideZeroSeeders : current.hideZeroSeeders }))
    }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => { if (!result?.expiresAt) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [result?.expiresAt])
  useEffect(()=>{const area=document.getElementById('general-query') as HTMLTextAreaElement|null;if(!area)return;area.style.height='auto';area.style.height=`${Math.min(area.scrollHeight||42,180)}px`;area.style.overflowY=area.scrollHeight>180?'auto':'hidden'},[draft])
  useEffect(() => {
    if (!dialogOpen) return
    focusTarget.current?.focus()
    const background = Array.from(document.querySelectorAll<HTMLElement>('.sidebar, .topbar, #search, .page-footer'))
    const prior = background.map(node => node.hasAttribute('inert'))
    background.forEach(node => node.setAttribute('inert', ''))
    return () => { background.forEach((node,i) => { if (!prior[i]) node.removeAttribute('inert') }); opener.current?.focus() }
  }, [dialogOpen])

  async function search(action: GeneralSearchConversationRequest['action'], text?: string) {
    if (searchBusy || dialogOpen || (action !== 'search' && !result)) return
    if (action !== 'search' && action !== 'follow-up' && !searchAuth.current) return
    const clean = (text ?? draft).trim()
    if (action === 'search' && !clean) return
    if (action !== 'search' && continuationCount >= 5) return
    const actionCopy: Record<string,string> = { 'find-more':'Find more results', 'more-like-these':'Find releases like my selected examples', 'other-terms':'Try different search terms' }
    const turnText = action === 'search' || action === 'follow-up' ? clean : actionCopy[action]
    const userTurn: GeneralSearchTurn = { role: 'user', content: turnText }
    const nextTurns = action === 'search' ? [userTurn] : [...turns, userTurn]
    const root = action === 'search' ? clean : original
    const req: GeneralSearchConversationRequest = { originalQuery: root, turns: nextTurns, action, budgets: budget, ...(action!=='search'&&searchAuth.current ? { previousSearchId: searchAuth.current.searchId, confirmationToken: searchAuth.current.confirmationToken } : {}), ...(action === 'more-like-these' ? { selectedInspirationIds: selected } : {}) }
    const id = ++searchRun.current, aborter = new AbortController(); controller.current?.abort(); controller.current = aborter;pendingRun.current={id,action}
    setSearchBusy(true); setStopped(false); setError('');setErrorDiagnostics(null); setEvents([]); backendRunId.current=null;lastEventSequence.current=-1;setProvisional([]); setActivityStage('Planning search'); setActivityQueries([]); setCuration(null); setSelected([]); setDraft(''); setPage(0)
    setSnapshotCurrent(false)
    if (action === 'search') { searchAuth.current=null;setOriginal(clean); setTurns(nextTurns); setResult(null) }
    else setTurns(nextTurns)
    try {
      const response = await fetch('/api/search/conversation/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(req), signal: aborter.signal });if(searchRun.current!==id)return
      if (!response.ok) { const body = await response.json().catch(() => ({}));if(searchRun.current!==id)return;throw new Error(body.error || 'Search could not be completed.') }
      let final:GeneralSearchConversationResponse|null=null, terminal:'complete'|'error'|null=null,terminalErrorMessage='Search could not be completed.'
      const handleEvent=(raw:unknown)=>{
        if(!eventValue(raw)||!['planning','queries','searching','results','curation','complete','error'].includes(String((raw as {type?:unknown}).type)))return
        if(searchRun.current!==id)return
        if(!validEvent(raw))throw new Error('Search activity was incomplete. Try again.')
        const item=raw as GeneralSearchProgressEvent&{runId?:string;stageId?:string}
        if(item.runId){if(backendRunId.current&&item.runId!==backendRunId.current)return;backendRunId.current??=item.runId}
        if(item.sequence<=lastEventSequence.current)return
        if((item.type==='complete'||item.type==='error')&&terminal)throw new Error('Search sent conflicting completion updates. Any unconfirmed results are not selectable.')
        lastEventSequence.current=item.sequence
        setEvents(current=>{const index=item.stageId?current.findIndex(x=>(x as GeneralSearchProgressEvent&{stageId?:string}).stageId===item.stageId):-1;if(index>=0){const next=[...current];next[index]=item;return next}return [...current,item]})
        if(item.type==='planning')setActivityStage(labels.planning)
        if(item.type==='queries'){setActivityStage('Search terms ready');setActivityQueries(item.queries)}
        if(item.type==='searching')setActivityStage(`Searching · term ${item.index} · limit ${item.total}`)
        if(item.type==='curation'){setActivityStage('Checking relevance');setCuration({processed:item.processed,total:item.total})}
        if(item.type==='results'&&item.provisional)setProvisional(item.releases.map(r=>({...r,selectable:false,unavailableReason:r.unavailableReason||'Still searching'})))
        if(item.type==='complete'){terminal='complete';final=item.response}
        if(item.type==='error'){terminal='error';terminalErrorMessage=item.message||terminalErrorMessage;if(item.partialReleases)setProvisional(item.partialReleases.map(r=>({...r,selectable:false,unavailableReason:r.unavailableReason||'Search did not complete'})));if(item.diagnostics)setErrorDiagnostics(item.diagnostics)}
      }
      if (response.body && response.headers.get('content-type')?.includes('ndjson')) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
        while (true) { const { value, done } = await reader.read();if(searchRun.current!==id)return;buffer += decoder.decode(value, { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
          for (const line of lines) { if (!line.trim()) continue; let event: unknown; try { event = JSON.parse(line) } catch { throw new Error('Search activity could not be read. Try again.') };handleEvent(event) }
          if (done) break
        }
        if(buffer.trim()){let ev:unknown;try{ev=JSON.parse(buffer)}catch{throw new Error('Search activity could not be read. Try again.')};handleEvent(ev)}
        if(terminal==='error')throw new Error(terminalErrorMessage)
        if (!final) throw new Error('The search ended without a complete result.')
      } else {
        const body:unknown=await response.json();if(searchRun.current!==id)return;if(!validResponse(body))throw new Error('Search returned incomplete results. Try again.');final=body
      }
      if(searchRun.current!==id)return
      if(final){const complete=final.diagnostics?.complete!==false;const authoritative={...final,confirmationToken:complete?final.confirmationToken:null,actionsAllowed:complete?final.actionsAllowed:false,releases:complete?final.releases:final.releases.map(r=>({...r,selectable:false,unavailableReason:r.unavailableReason||'Search did not complete'}))};if(complete&&final.searchId&&final.confirmationToken)searchAuth.current={searchId:final.searchId,confirmationToken:final.confirmationToken};setResult(authoritative);setSnapshotCurrent(complete);if(!complete)setErrorDiagnostics(final.diagnostics??null);setProvisional([]);setPage(0);setActivityStage(complete?'Search complete':'Search ended early');setTurns(current=>[...current,{role:'assistant',content:authoritative.status==='clarification-needed'?authoritative.question:complete?`Found ${authoritative.releases.length} candidates.`:'Search ended early. Results cannot be selected.'}]);pendingRun.current=null}
    } catch (e) { if (searchRun.current === id && !aborter.signal.aborted) {const message=e instanceof Error ? e.message : 'Search could not be completed.';setError(message);setActivityStage('Search could not be completed');if(pendingRun.current?.id===id){setTurns(current=>[...current,{role:'assistant',content:`Search did not complete: ${message}`}]);pendingRun.current=null}} }
    finally { if (searchRun.current === id) setSearchBusy(false) }
  }

  function submitComposer(event: FormEvent) { event.preventDefault(); void search(!result ? 'search' : 'follow-up') }
  function stopSearch() { if (!searchBusy) return;const pending=pendingRun.current;searchRun.current++; controller.current?.abort(); setSearchBusy(false); setStopped(true); setActivityStage('Search stopped');setSnapshotCurrent(false);setTurns(current=>pending? [...current,{role:'assistant',content:'Search stopped. Any early results are not confirmed.'}]:current);pendingRun.current=null;setProvisional(current=>current.map(r=>({...r,selectable:false,unavailableReason:'Search stopped before results were confirmed'}))) }
  function newConversation() { searchRun.current++; controller.current?.abort();searchAuth.current=null; setSearchBusy(false); setStopped(false); setDialogOpen(false); setDraft(''); setOriginal(''); setTurns([]); setResult(null);setSnapshotCurrent(false); setProvisional([]); setSelected([]); setEvents([]); setActivityStage(''); setActivityQueries([]); setCuration(null); setError('');setErrorDiagnostics(null); setPage(0) }
  function toggle(id: string) { setSelected(items => items.includes(id) ? items.filter(x => x !== id) : items.length < (budget.candidateCap || 200) ? [...items, id] : items) }
  async function reconcile(id = operationId, manifest = manifestRef.current, mode: 'live'|'dry-run' = unknownContext.current?.mode??(result?.dryRun ? 'dry-run':'live'), destination: { name: string; protocol: 'usenet'|'torrent' } | null = unknownContext.current?.destination??result?.destination??null) {
    if (!id || !destination) return
    const opGeneration=operationSequence.current
    try { const r = await fetch(`/api/general-operations/${encodeURIComponent(id)}`);if(operationSequence.current!==opGeneration)return;const body: unknown = await r.json();if(operationSequence.current!==opGeneration)return; if (!r.ok || !isStatus(body,{id,manifest,mode,destination})) throw new Error('Operation status is unavailable or does not match the frozen selection. Do not resubmit.'); setOperationId(id); setOperationUnknownId(''); setOperation(body);setOperationError('') }
    catch (e) { if (operationSequence.current===opGeneration&&(id === operationId || id === operationUnknownId)) setOperationError(e instanceof Error ? e.message : 'Status could not be checked.') }
  }
  async function submitOperation() {
    if (!result?.searchId || !result.confirmationToken || !selected.length || blocked || operationLocksSubmit) return
    const approvedDestination = result.destination
    if (!approvedDestination) return
    const frozen = [...frozenSelection], opId = uuid(), opSequence = ++operationSequence.current, approvedMode = result.dryRun ? 'dry-run' : 'live'; manifestRef.current = frozen; unknownContext.current = { id: opId, manifest: frozen, mode: approvedMode, destination: approvedDestination }; setOperationId(opId); setOperationUnknownId(opId); setBusy(true); setOperationError('')
    const base = `/api/search/${encodeURIComponent(result.searchId)}/operations`
    try {
      const create = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: opId, confirmationToken: result.confirmationToken, releaseIds: frozen, confirmed: true }) });if(operationSequence.current!==opSequence)return
      const created: unknown = await create.json(); if (operationSequence.current !== opSequence) return
      if (!create.ok || !isStatus(created,{id:opId,manifest:frozen,mode:approvedMode,destination:approvedDestination})) throw new Error('Could not verify the frozen operation manifest. Check status; do not create another operation.')
      setOperationUnknownId('')
      setOperation(created)
      let state = created
      while (!state.complete && !state.stopped && state.nextOrdinal < frozen.length) {
        if (operationSequence.current !== opSequence || stopRequested.current.has(opId)) return
        const currentOrdinal = state.nextOrdinal
        try {
          const step = await fetch(`/api/general-operations/${encodeURIComponent(opId)}/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedOrdinal: currentOrdinal }) });if(operationSequence.current!==opSequence)return
          const body: unknown = await step.json(); if (operationSequence.current !== opSequence) return
          if (!step.ok || !isStatus(body,{id:opId,manifest:frozen,mode:approvedMode,destination:approvedDestination}) || body.nextOrdinal <= currentOrdinal || body.nextOrdinal > currentOrdinal + 1) throw new Error('Step response did not match the next frozen ordinal.')
          state = body; setOperation(body)
          if (body.releases.some(r=>r.status==='uncertain'||r.status==='submitting') || stopRequested.current.has(opId)) break
        } catch { if (operationSequence.current !== opSequence) return; setOperationUnknownId(opId); await reconcile(opId,frozen,approvedMode,approvedDestination); break }
      }
      setDialogOpen(false)
    } catch (e) { if (operationSequence.current !== opSequence) return; await reconcile(opId,frozen,approvedMode,approvedDestination); if(operationSequence.current!==opSequence)return; setDialogOpen(false); setOperationError(e instanceof Error ? e.message : 'Operation status is unknown. Check status; do not retry.') }
    finally { if (operationSequence.current === opSequence) setBusy(false) }
  }
   async function stopOperation() { const c=unknownContext.current;if (!c) return; const seq=operationSequence.current;stopRequested.current.add(c.id); try { const r = await fetch(`/api/general-operations/${encodeURIComponent(c.id)}/stop`, { method: 'POST' });if(operationSequence.current!==seq)return;const body = await r.json();if(operationSequence.current!==seq)return;if (!r.ok||!isStatus(body.operation,c)) throw new Error(); setOperation(body.operation) } catch { if(operationSequence.current===seq)setOperationError('Could not confirm the stop request. Check operation status.') } }

  return <div className="general-search">
    <div className="search-title-row"><h1>General search</h1></div><div className="search-toolbar"><span>Search in your own words. Nothing is sent without your review.</span><div><button type="button" className="button button-secondary" onClick={newConversation}><Plus size={15}/> New search</button>{searchBusy&&<button type="button" className="button button-secondary stop-search" onClick={stopSearch}><Square size={14}/> Stop search</button>}</div></div>
    <form className="general-search-form" onSubmit={submitComposer}><label htmlFor="general-query">{result?.status==='clarification-needed'?'Your answer':original?'Refine your search':'Describe what you’re looking for'}</label><div className="general-query-wrap"><Search size={19} aria-hidden="true"/><textarea id="general-query" autoComplete="off" value={draft} maxLength={500} disabled={searchBusy||dialogOpen||continuationLocked} onChange={e=>{setDraft(e.target.value);e.currentTarget.style.height='auto';e.currentTarget.style.height=`${Math.min(e.currentTarget.scrollHeight,180)}px`}} placeholder={original?'Add a detail or direction…':'A title, an episode, or something you’d like to explore…'} rows={1}/><button className="button button-primary" disabled={searchBusy||dialogOpen||continuationLocked||!draft.trim()}>{searchBusy?<LoaderCircle className="spin" size={16}/>:<ArrowRight size={16}/>}<span>{result?.status==='clarification-needed'?'Continue':original?'Update search':'Search'}</span></button></div><span className="field-hint">Search titles, episodes, topics, or moods. No download is sent by searching.</span></form>
       <details className="search-preferences" open={settingsOpen} onToggle={e=>setSettingsOpen(e.currentTarget.open)}><summary><SlidersHorizontal size={16}/> Search settings</summary><p className="settings-explainer">Advanced limits for this search. Values stay within the configured maximums.</p><div className="budget-grid">{([['queryCount','Search terms'],['candidateCap','Candidate cap'],['aiCalls','AI calls'],['batchSize','Prompt batch'],['displayLimit','Visible per page']] as const).map(([key,label])=><label key={key}>{label}<input disabled={searchBusy||dialogOpen} type="number" min="1" max={budgetCeilings[key]} value={budget[key]} onChange={e=>setBudget(b=>({...b,[key]:Math.min(budgetCeilings[key],Math.max(1,Number(e.target.value)||1))}))}/></label>)}<label className="zero-toggle"><input disabled={searchBusy||dialogOpen} type="checkbox" checked={!budget.hideZeroSeeders} onChange={e=>setBudget(b=>({...b,hideZeroSeeders:!e.target.checked}))}/> Include torrents with zero seeders</label></div></details>
     {error && <div className="notice notice-error" role="alert"><AlertCircle size={17}/><p>{error}</p></div>}
     {(searchBusy||stopped||events.length>0)&&<section className="search-activity" aria-label="Search progress"><div className="activity-current" role="status"><span className={searchBusy?'activity-pulse':'activity-done'}/><strong>{activityStage||'Preparing search'}</strong>{searchBusy&&curation&&<span>{curation.processed} of {curation.total} reviewed</span>}</div>{activityQueries.length>0&&<div className="query-chips" aria-label="Search terms">{activityQueries.map((q,i)=><span key={`${i}-${q}`}>{q}</span>)}</div>}{(events.length>0||activityQueries.length>0)&&<details className="activity-details" open={activityOpen} onToggle={e=>setActivityOpen(e.currentTarget.open)}><summary>Search activity</summary><ol>{events.map((event,i)=><li key={`${event.sequence}-${i}`}>{labels[event.type]||'Search update'}{event.type==='searching'&&<span>{event.query} · term {event.index} · limit {event.total}</span>}{event.type==='curation'&&<span>{event.processed} of {event.total} reviewed</span>}</li>)}</ol></details>}</section>}
     {provisional.length>0&&<section className="provisional-results" aria-label="Provisional search results"><div><strong>{searchBusy?'Early matches · still searching':'Partial results · search stopped'}</strong><p>These results are not confirmed and cannot be selected.</p></div><ul>{provisional.slice(0,8).map(r=><li key={r.releaseId}>{r.title}</li>)}</ul></section>}
     {result && result.status === 'clarification-needed' && <section className="clarification-card"><Sparkles size={18}/><div><h2>A quick question</h2><p>{result.question}</p></div></section>}
     {result&&!snapshotCurrent&&<p className="prior-results-note" role="status">{searchBusy?'Earlier results are shown for context while this search runs. They cannot be selected.':'These earlier results are shown for context only. They cannot be selected until a new search completes.'}</p>}
     {diagnostics&&<details className={`search-diagnostics ${diagnostics.complete?'':'diagnostics-incomplete'}`}><summary>{diagnostics.complete?'Search summary':'Search ended early'}</summary><p>{stopReasonCopy[diagnostics.stopReason]} {diagnostics.ledger.raw} {diagnostics.ledger.raw===1?'candidate':'candidates'} received; {diagnostics.ledger.added} added; {diagnostics.ledger.duplicates} duplicates.</p><p>Assessment: {diagnostics.ledger.assessed.match} matches, {diagnostics.ledger.assessed.possible} possible matches, {diagnostics.ledger.assessed.unrelated} unrelated, {diagnostics.ledger.assessed.unassessed} unassessed.</p>{Object.keys(diagnostics.ledger.filtered).length>0&&<p>Filtered: {Object.entries(diagnostics.ledger.filtered).map(([reason,count])=>`${reason} ${count}`).join(' · ')}.</p>}{diagnostics.ledger.outcomes.map((outcome,i)=><p key={`${i}-${outcome.query}`}>{outcome.query}: {outcome.outcome==='success'?`${outcome.raw} ${outcome.raw===1?'candidate':'candidates'} received`:'search failed'}{outcome.added>0?`, ${outcome.added} added`:''}.</p>)}</details>}
     {operationError&&<div className="notice notice-error operation-error" role="alert"><AlertCircle size={17}/><p>{operationError}</p></div>}
     {result?.status === 'selection-required' && <section className="general-results" aria-live="polite"><div className="general-query-summary"><span className="eyebrow">RESULTS FOR</span><h2>{original}</h2></div>
      <div className="search-destination"><span><ShieldCheck size={16}/> Destination</span><strong>{result.destination ? `${result.destination.name} · ${result.destination.protocol}` : 'Not configured'}</strong><b className={result.dryRun?'dry':'live'}>{result.dryRun?'DRY RUN · no download sent':'LIVE · explicit confirmation required'}</b></div>
      {expired&&<div className="blocked-note" role="status"><Clock3 size={16}/>This result set has expired. You can explore again, but it cannot be submitted.</div>}
      <div className="results-heading"><div><h2>Releases to review</h2><p>Match quality is a suggestion, not a guarantee. Choose any number up to the candidate cap.</p></div><span>{selected.length} selected</span></div>
       {releases.length===0?<div className="empty-search"><Search size={22}/><h2>{diagnostics?.ledger.outcomes.some(x=>x.outcome==='success')?'No releases to review':'No results to show'}</h2><p>{diagnostics?.ledger.outcomes.some(x=>x.outcome==='success')?'Completed searches returned no releases to review. Check the search summary for filtering or availability details.':'No completed search returned results. Check the search summary for failed terms or limits, or try another direction.'}</p></div>:<div className="release-list">{visible.map((release: GeneralConversationRelease)=>{const releaseExpired=Date.parse(release.expiresAt)<=now;return <label className={`release-row ${!release.selectable?'unavailable':''}`} key={release.releaseId}><input type="checkbox" aria-label={`Select ${release.title}`} checked={selected.includes(release.releaseId)} disabled={operationLocksSubmit||searchBusy||dialogOpen||blocked||releaseExpired||!release.selectable||(!selected.includes(release.releaseId)&&selected.length>=budget.candidateCap)} onChange={()=>toggle(release.releaseId)}/><span className="release-copy"><strong>{release.title}</strong><span>{release.indexer} · {release.protocol} · {release.size===null?'Size unknown':`${(release.size/1024**3).toFixed(1)} GB`}{release.protocol==='torrent'&&release.seeders!==null?` · ${release.seeders} seeders`:''}</span><span className="release-badges">{release.relevance&&<em className={`relevance-${release.relevance.classification}`}>{release.relevance.classification==='match'?'Match':'Possible match'}</em>}{release.viability&&<em className={`viability-${release.viability.reason}`}>{release.viability.reason==='viable'?'Viability signals look good':release.viability.reason==='unknown'?'Availability unknown':release.viability.reason==='zero-seeders'?'Zero seeders':release.viability.reason==='stale'?'Stale result':release.viability.reason}</em>}</span>{release.relevance?.explanation&&<span className="release-explanation">{release.relevance.explanation}</span>}{release.unavailableReason&&<em>{release.unavailableReason}</em>}{releaseExpired&&<em>Selection expired</em>}</span><span className="release-age"><Clock3 size={13}/>{release.age}d</span></label>})}</div>}
      {pages>1&&<nav className="release-pagination" aria-label="Result pages"><button type="button" className="button button-secondary" disabled={page===0} onClick={()=>setPage(n=>Math.max(0,n-1))}>Previous</button><span>Page {page+1} of {pages} · {releases.length} total releases</span><button type="button" className="button button-secondary" disabled={page>=pages-1} onClick={()=>setPage(n=>Math.min(pages-1,n+1))}>Next</button></nav>}
      <p className="display-note">{selected.length} selected across all pages. Display limit changes visibility only.</p>
       <div className="discovery-actions"><button type="button" className="button button-secondary" disabled={continuationLocked||!searchAuth.current} onClick={()=>void search('find-more')}>Find more</button><button type="button" className="button button-secondary" disabled={continuationLocked||!selected.length||!searchAuth.current} onClick={()=>void search('more-like-these')}>More like these</button><button type="button" className="button button-secondary" disabled={continuationLocked||!searchAuth.current} onClick={()=>void search('other-terms')}>Try other terms</button></div>
      {continuationCount>=5&&<p className="limit-note" role="status">You’ve reached the five follow-up limit. Start a new search to keep exploring.</p>}
       {!operationLocksSubmit&&<button className="button button-primary review-button" disabled={dialogOpen||!selected.length||blocked} onClick={e=>{opener.current=e.currentTarget;setFrozenSelection([...selected]);setDialogOpen(true)}}>Review {selected.length} selected <ArrowRight size={16}/></button>}
    </section>}
    {operationUnknownId&&<section className="outcome-card" role="status"><div className="operation-heading"><div><span className="eyebrow">OPERATION {operationUnknownId.slice(0,8)}</span><h2>Outcome not confirmed</h2></div><button type="button" className="button button-secondary" onClick={()=>{const c=unknownContext.current;if(c)void reconcile(c.id,c.manifest,c.mode,c.destination)}}>Check status</button></div><p>Media Scout could not verify the operation response. It will not create or submit the selection again. Check the saved status before taking further action.</p></section>}
     {operation&&<section className="outcome-card" aria-live="polite"><div className="operation-heading"><div><span className="eyebrow">OPERATION {operationId.slice(0,8)}</span><h2>{operation.releases.some(r=>r.status==='uncertain')?'Outcome unknown':operation.stopped?'Stopped':operation.complete?'Operation complete':'Submission progress'}</h2></div><button type="button" className="button button-secondary" onClick={()=>{const c=unknownContext.current;if(c)void reconcile(c.id,c.manifest,c.mode,c.destination)}}>Check status</button></div><p>{operation.mode==='dry-run'?'Dry run: no download was sent.':'Submitted means accepted by the download client, not completed or imported.'} Destination: {operation.destination.name} · {operation.mode}.</p><div className="operation-list">{operation.releases.map(item=><div className="outcome-row" key={item.releaseId}><strong>{result?.releases.find(r=>r.releaseId===item.releaseId)?.title||'Selected release'}</strong><span className={`outcome-${item.status}`}>{item.status==='previously-submitted'?'Previously submitted':item.status==='submitted'?'Submitted · not completed':item.status==='dry-run'?'Dry run · not sent':item.status==='uncertain'?'Unknown · check client':item.status}</span></div>)}</div>{!operation.complete&&!operation.stopped&&<button className="button button-secondary" type="button" onClick={()=>void stopOperation()}>Stop future steps</button>}{operation.releases.some(r=>r.status==='uncertain')&&<p className="unknown-note">Check your download client before taking any further action. This operation will not retry an uncertain step.</p>}</section>}
   {dialogOpen&&result&&createPortal(<div className="search-modal-backdrop"><section ref={dialog} className="search-modal" role="dialog" aria-modal="true" aria-labelledby="search-review-title" aria-describedby="search-review-description" onKeyDown={(e:KeyboardEvent<HTMLElement>)=>{if(e.key==='Escape'&&!busy){e.preventDefault();setDialogOpen(false);return}if(e.key!=='Tab')return;const all=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled])')??[]);if(!all.length){e.preventDefault();return}if(e.shiftKey&&document.activeElement===all[0]){e.preventDefault();all.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===all.at(-1)){e.preventDefault();all[0].focus()}}}><button className="modal-close" type="button" aria-label="Close review" onClick={()=>setDialogOpen(false)} disabled={busy}><X size={18}/></button><span className="eyebrow">FINAL CHECK</span><h2 id="search-review-title">Review your selection</h2><p id="search-review-description">This is the complete frozen selection. No release will be added or removed after you confirm.</p><div className="search-confirm-destination"><strong>{result.dryRun?'DRY RUN':'LIVE'}</strong><span>{result.destination?.name||'No destination'} · {result.destination?.protocol}</span></div><ul className="manifest-list">{frozenSelection.map(id=><li key={id}>{result.releases.find(r=>r.releaseId===id)?.title||id}</li>)}</ul>{(expired||selectedExpired)&&<p role="alert">{expired?'These results have expired.':'A selected release has expired.'} Close this review and search again.</p>}<div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>setDialogOpen(false)}>Cancel</button><button ref={focusTarget} type="button" className="button button-primary" disabled={busy||blocked} onClick={()=>void submitOperation()}>{busy?<><LoaderCircle className="spin" size={16}/> Working…</>:<><Check size={16}/> Confirm full selection</>}</button></div></section></div>,document.body)}
  </div>
}
