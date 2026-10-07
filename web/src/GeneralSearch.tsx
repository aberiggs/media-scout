import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowRight, Check, Clock3, LoaderCircle, Search, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { GeneralConversationRelease, GeneralSearchBudgets, GeneralSearchConversationRequest, GeneralSearchConversationResponse, GeneralSearchOperationStatus, GeneralSearchProgressEvent, GeneralSearchTurn } from '../../src/types/general-search'

const defaults: GeneralSearchBudgets = { queryCount: 6, candidateCap: 200, aiCalls: 12, batchSize: 20, displayLimit: 40, hideZeroSeeders: true }
const labels: Record<string, string> = { planning: 'Understanding your request', queries: 'Search terms ready', searching: 'Searching indexers', results: 'Results received', curation: 'Reviewing relevance', complete: 'Search complete', error: 'Search stopped' }

function eventValue(value: unknown): value is GeneralSearchProgressEvent { return Boolean(value && typeof value === 'object' && 'type' in value) }
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
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [events, setEvents] = useState<GeneralSearchProgressEvent[]>([])
  const [operation, setOperation] = useState<GeneralSearchOperationStatus | null>(null)
  const [operationId, setOperationId] = useState('')
  const [operationUnknownId, setOperationUnknownId] = useState('')
  const [page, setPage] = useState(0)
  const [frozenSelection, setFrozenSelection] = useState<string[]>([])
  const [budget, setBudget] = useState<GeneralSearchBudgets>(defaults)
  const [budgetCeilings, setBudgetCeilings] = useState({ queryCount: 20, candidateCap: 1000, aiCalls: 100, batchSize: 100, displayLimit: 1000 })
  const [now, setNow] = useState(Date.now())
  const sequence = useRef(0), controller = useRef<AbortController | null>(null)
  const stopRequested = useRef(new Set<string>())
  const manifestRef = useRef<string[]>([])
  const unknownContext = useRef<{ id: string; manifest: string[]; mode: 'live'|'dry-run'; destination: { name: string; protocol: 'usenet'|'torrent' } } | null>(null)
  const opener = useRef<HTMLElement | null>(null), dialog = useRef<HTMLElement | null>(null), focusTarget = useRef<HTMLButtonElement | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const releases = result?.releases ?? []
  const pages = Math.max(1, Math.ceil(releases.length / Math.max(1, budget.displayLimit)))
  const visible = releases.slice(page * Math.max(1,budget.displayLimit), (page + 1) * Math.max(1,budget.displayLimit))
  const continuationCount = Math.max(0, turns.filter(t => t.role === 'user').length - 1)
  const continuationLocked = continuationCount >= 5 || busy || dialogOpen || Boolean(operation || operationUnknownId)
  const expired = Boolean(result?.expiresAt && Date.parse(result.expiresAt) <= now)
  const selectedExpired = selected.some(id => { const release=result?.releases.find(r=>r.releaseId===id); return Boolean(release && Date.parse(release.expiresAt)<=now) })
  const blocked = Boolean(!result?.searchId || !result.confirmationToken || !result.actionsAllowed || !result.destination || expired || selectedExpired)
  useEffect(() => () => { sequence.current++; controller.current?.abort() }, [])
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
  useEffect(() => {
    if (!dialogOpen) return
    focusTarget.current?.focus()
    const background = Array.from(document.querySelectorAll<HTMLElement>('.sidebar, .topbar, #search, .page-footer'))
    const prior = background.map(node => node.hasAttribute('inert'))
    background.forEach(node => node.setAttribute('inert', ''))
    return () => { background.forEach((node,i) => { if (!prior[i]) node.removeAttribute('inert') }); opener.current?.focus() }
  }, [dialogOpen])

  async function search(action: GeneralSearchConversationRequest['action'], text?: string) {
    if (busy || (action !== 'search' && !result)) return
    const clean = (text ?? draft).trim()
    if (action === 'search' && !clean) return
    if (action !== 'search' && continuationCount >= 5) return
    const actionCopy: Record<string,string> = { 'find-more':'Find more results', 'more-like-these':'Find releases like my selected examples', 'other-terms':'Try different search terms' }
    const turnText = action === 'search' || action === 'follow-up' ? clean : actionCopy[action]
    const userTurn: GeneralSearchTurn = { role: 'user', content: turnText }
    const nextTurns = action === 'search' ? [userTurn] : [...turns, userTurn]
    const root = action === 'search' ? clean : original
    const req: GeneralSearchConversationRequest = { originalQuery: root, turns: nextTurns, action, budgets: budget, ...(result?.searchId ? { previousSearchId: result.searchId, confirmationToken: result.confirmationToken ?? undefined } : {}), ...(action === 'more-like-these' ? { selectedInspirationIds: selected } : {}) }
    const id = ++sequence.current, aborter = new AbortController(); controller.current?.abort(); controller.current = aborter
    setBusy(true); setError(''); setEvents([]); setSelected([]); setDraft(''); setPage(0)
    if (action === 'search') { setOriginal(clean); setTurns(nextTurns); setResult(null); setOperation(null); setOperationId(''); setOperationUnknownId('') }
    else setTurns(nextTurns)
    try {
      const response = await fetch('/api/search/conversation/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(req), signal: aborter.signal })
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Search could not be completed.') }
      if (response.body && response.headers.get('content-type')?.includes('ndjson')) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', final: GeneralSearchConversationResponse | null = null
        while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
          for (const line of lines) { if (!line.trim()) continue; const event: unknown = JSON.parse(line); if (!eventValue(event)) continue; if (sequence.current !== id) return; setEvents(current => [...current, event]); if (event.type === 'complete') final = event.response; if (event.type === 'error') throw new Error(event.message) }
          if (done) break
        }
        if (buffer.trim()) { const ev: unknown = JSON.parse(buffer); if (eventValue(ev) && ev.type === 'complete') final = ev.response }
        if (!final) throw new Error('The search ended without a complete result.')
        if (sequence.current === id) { setResult(final); setPage(0); setTurns(current => [...current, { role: 'assistant', content: final!.status === 'clarification-needed' ? final!.question : `Found ${final!.releases.length} candidates. Review relevance and availability before selecting.` }]) }
      } else {
        const body = await response.json() as GeneralSearchConversationResponse
        if (sequence.current === id) { setResult(body); setPage(0); setTurns(current => [...current, { role: 'assistant', content: body.status === 'clarification-needed' ? body.question : `Found ${body.releases.length} candidates. Review relevance and availability before selecting.` }]) }
      }
    } catch (e) { if (sequence.current === id && !aborter.signal.aborted) setError(e instanceof Error ? e.message : 'Search could not be completed.') }
    finally { if (sequence.current === id) setBusy(false) }
  }

  function submitComposer(event: FormEvent) { event.preventDefault(); void search(!result ? 'search' : 'follow-up') }
  function newConversation() { sequence.current++; controller.current?.abort(); setBusy(false); setDraft(''); setOriginal(''); setTurns([]); setResult(null); setSelected([]); setEvents([]); setOperation(null); setOperationId(''); setOperationUnknownId(''); setError(''); setPage(0); setFrozenSelection([]); unknownContext.current=null }
  function toggle(id: string) { setSelected(items => items.includes(id) ? items.filter(x => x !== id) : items.length < (budget.candidateCap || 200) ? [...items, id] : items) }
  async function reconcile(id = operationId, manifest = manifestRef.current, mode: 'live'|'dry-run' = result?.dryRun ? 'dry-run':'live', destination: { name: string; protocol: 'usenet'|'torrent' } | null = result?.destination ?? null) {
    if (!id || !destination) return
    try { const r = await fetch(`/api/general-operations/${encodeURIComponent(id)}`); const body: unknown = await r.json(); if (!r.ok || !isStatus(body,{id,manifest,mode,destination})) throw new Error('Operation status is unavailable or does not match the frozen selection. Do not resubmit.'); setOperationId(id); setOperationUnknownId(''); setOperation(body) }
    catch (e) { if (id === operationId || id === operationUnknownId) setError(e instanceof Error ? e.message : 'Status could not be checked.') }
  }
  async function submitOperation() {
    if (!result?.searchId || !result.confirmationToken || !selected.length || blocked || busy) return
    const approvedDestination = result.destination
    if (!approvedDestination) return
    const frozen = [...frozenSelection], opId = uuid(), opSequence = ++sequence.current, approvedMode = result.dryRun ? 'dry-run' : 'live'; manifestRef.current = frozen; unknownContext.current = { id: opId, manifest: frozen, mode: approvedMode, destination: approvedDestination }; setOperationId(opId); setOperationUnknownId(opId); setBusy(true); setError('')
    const base = `/api/search/${encodeURIComponent(result.searchId)}/operations`
    try {
      const create = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: opId, confirmationToken: result.confirmationToken, releaseIds: frozen, confirmed: true }) })
      const created: unknown = await create.json(); if (sequence.current !== opSequence) return
      if (!create.ok || !isStatus(created,{id:opId,manifest:frozen,mode:approvedMode,destination:approvedDestination})) throw new Error('Could not verify the frozen operation manifest. Check status; do not create another operation.')
      setOperationUnknownId('')
      setOperation(created)
      let state = created
      while (!state.complete && !state.stopped && state.nextOrdinal < frozen.length) {
        if (sequence.current !== opSequence || stopRequested.current.has(opId)) return
        const currentOrdinal = state.nextOrdinal
        try {
          const step = await fetch(`/api/general-operations/${encodeURIComponent(opId)}/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedOrdinal: currentOrdinal }) })
          const body: unknown = await step.json(); if (sequence.current !== opSequence) return
          if (!step.ok || !isStatus(body,{id:opId,manifest:frozen,mode:approvedMode,destination:approvedDestination}) || body.nextOrdinal <= currentOrdinal || body.nextOrdinal > currentOrdinal + 1) throw new Error('Step response did not match the next frozen ordinal.')
          state = body; setOperation(body)
          if (body.releases.some(r=>r.status==='uncertain'||r.status==='submitting') || stopRequested.current.has(opId)) break
        } catch { if (sequence.current !== opSequence) return; setOperationUnknownId(opId); await reconcile(opId,frozen,approvedMode,approvedDestination); break }
      }
      setDialogOpen(false)
    } catch (e) { if (sequence.current !== opSequence) return; await reconcile(opId,frozen,approvedMode,approvedDestination); setDialogOpen(false); setError(e instanceof Error ? e.message : 'Operation status is unknown. Check status; do not retry.') }
    finally { if (sequence.current === opSequence) setBusy(false) }
  }
  async function stopOperation() { const c=unknownContext.current;if (!c) return; const seq=sequence.current;stopRequested.current.add(c.id); try { const r = await fetch(`/api/general-operations/${encodeURIComponent(c.id)}/stop`, { method: 'POST' }); const body = await r.json(); if(sequence.current!==seq)return;if (!r.ok||!isStatus(body.operation,c)) throw new Error(); setOperation(body.operation) } catch { if(sequence.current===seq)setError('Could not confirm the stop request. Check operation status.') } }

  return <div className="general-search">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> OPEN-ENDED DISCOVERY</div><h1>General search<span className="heading-period">.</span></h1><p className="page-intro">Explore in your own words. Nothing is sent to a download client without your review.</p></div><div className="heading-stamp"><Sparkles size={15}/><span>YOU STAY IN CONTROL</span></div></div>
    {!original && <section className="conversation-empty"><span className="conversation-orbit"><Search size={21}/></span><p className="eyebrow">A GOOD PLACE TO START</p><h2>What are you in the mood to find?</h2><p>Describe a genre, subject, era, or feeling. You can refine the search together.</p></section>}
    {turns.length > 0 && <><section className="conversation-thread" aria-label="Search conversation">{turns.map((turn, index) => <article className={`chat-turn ${turn.role}`} key={`${index}-${turn.content}`}><span className="turn-label">{turn.role === 'user' ? 'YOU' : 'MEDIA SCOUT'}</span><p>{turn.content}</p></article>)}</section><button type="button" className="text-button new-conversation" disabled={busy||dialogOpen} onClick={newConversation}>Start a new conversation</button></>}
    {events.length > 0 && <section className="search-activity" aria-live="polite" aria-label="Search activity"><div className="activity-title"><span className={busy ? 'activity-pulse' : 'activity-done'} />{busy ? 'Working on your search' : 'Search activity'}</div><ol>{events.map((event, i) => <li key={`${event.sequence}-${i}`} className={event.type}>{labels[event.type]}{event.type === 'queries' && event.queries.length > 0 && <span>{event.queries.join(' · ')}</span>}{event.type === 'searching' && <span>{event.query} · {event.index} of {event.total}</span>}{event.type === 'curation' && <span>{event.processed} of {event.total} reviewed</span>}</li>)}</ol></section>}
    <form className="general-search-form" onSubmit={submitComposer}><label htmlFor="general-query">{!result ? 'Describe what you’re looking for' : result.status === 'clarification-needed' ? 'Your answer' : 'Add a detail or direction'}</label><div className="general-query-wrap"><Search size={19}/><textarea id="general-query" autoComplete="on" value={draft} maxLength={500} disabled={busy||dialogOpen||continuationLocked} onChange={e => setDraft(e.target.value)} placeholder={original ? 'Add a detail, or what you’d like to explore next…' : 'A thoughtful documentary about deep-sea exploration…'} rows={2}/><button className="button button-primary" disabled={busy||dialogOpen||continuationLocked||!draft.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <ArrowRight size={16}/>}<span>{busy ? 'Searching…' : !result ? original ? 'Start a fresh search' : 'Search' : 'Continue'}</span></button></div><span className="field-hint">Searches and selections never send a download. Conversations stay in this page.</span></form>
     <details className="search-preferences"><summary>Search controls <span>Budgets & availability</span></summary><div className="budget-grid">{([['queryCount','Queries'],['candidateCap','Candidate cap'],['aiCalls','AI calls'],['batchSize','Prompt batch'],['displayLimit','Visible per page']] as const).map(([key,label])=><label key={key}>{label}<input disabled={busy||dialogOpen} type="number" min="1" max={budgetCeilings[key]} value={budget[key]} onChange={e=>setBudget(b=>({...b,[key]:Math.min(budgetCeilings[key],Math.max(1,Number(e.target.value)||1))}))}/></label>)}<label className="zero-toggle"><input disabled={busy||dialogOpen} type="checkbox" checked={!budget.hideZeroSeeders} onChange={e=>setBudget(b=>({...b,hideZeroSeeders:!e.target.checked}))}/> Include torrents with zero seeders</label></div></details>
    {error && <div className="notice notice-error" role="alert"><AlertCircle size={17}/><p>{error}</p></div>}
    {result && result.status === 'clarification-needed' && <section className="clarification-card"><Sparkles size={18}/><div><h2>A quick question</h2><p>{result.question}</p></div></section>}
    {result?.status === 'selection-required' && <section className="general-results" aria-live="polite"><div className="general-query-summary"><span className="eyebrow">CANDIDATES FOR</span><h2>{original}</h2>{result.queries.length>0&&<p>Search terms: {result.queries.join(' · ')}</p>}</div>
      <div className="search-destination"><span><ShieldCheck size={16}/> Destination</span><strong>{result.destination ? `${result.destination.name} · ${result.destination.protocol}` : 'Not configured'}</strong><b className={result.dryRun?'dry':'live'}>{result.dryRun?'DRY RUN · no download sent':'LIVE · explicit confirmation required'}</b></div>
      {expired&&<div className="blocked-note" role="status"><Clock3 size={16}/>This result set has expired. You can explore again, but it cannot be submitted.</div>}
      <div className="results-heading"><div><h2>Releases to review</h2><p>Match quality is a suggestion, not a guarantee. Choose any number up to the candidate cap.</p></div><span>{selected.length} selected</span></div>
      {releases.length===0?<div className="empty-search"><Search size={22}/><h2>No matching releases</h2><p>Try a broader description or another search direction.</p></div>:<div className="release-list">{visible.map((release: GeneralConversationRelease)=>{const releaseExpired=Date.parse(release.expiresAt)<=now;return <label className={`release-row ${!release.selectable?'unavailable':''}`} key={release.releaseId}><input type="checkbox" aria-label={`Select ${release.title}`} checked={selected.includes(release.releaseId)} disabled={busy||dialogOpen||blocked||releaseExpired||!release.selectable||Boolean(operation)||(!selected.includes(release.releaseId)&&selected.length>=budget.candidateCap)} onChange={()=>toggle(release.releaseId)}/><span className="release-copy"><strong>{release.title}</strong><span>{release.indexer} · {release.protocol} · {release.size===null?'Size unknown':`${(release.size/1024**3).toFixed(1)} GB`}{release.protocol==='torrent'&&release.seeders!==null?` · ${release.seeders} seeders`:''}</span><span className="release-badges">{release.relevance&&<em className={`relevance-${release.relevance.classification}`}>{release.relevance.classification==='match'?'Match':'Possible match'}</em>}{release.viability&&<em className={`viability-${release.viability.reason}`}>{release.viability.reason==='viable'?'Viability signals look good':release.viability.reason==='unknown'?'Availability unknown':release.viability.reason==='zero-seeders'?'Zero seeders':release.viability.reason==='stale'?'Stale result':release.viability.reason}</em>}</span>{release.relevance?.explanation&&<span className="release-explanation">{release.relevance.explanation}</span>}{release.unavailableReason&&<em>{release.unavailableReason}</em>}{releaseExpired&&<em>Selection expired</em>}</span><span className="release-age"><Clock3 size={13}/>{release.age}d</span></label>})}</div>}
      {pages>1&&<nav className="release-pagination" aria-label="Result pages"><button type="button" className="button button-secondary" disabled={page===0} onClick={()=>setPage(n=>Math.max(0,n-1))}>Previous</button><span>Page {page+1} of {pages} · {releases.length} total releases</span><button type="button" className="button button-secondary" disabled={page>=pages-1} onClick={()=>setPage(n=>Math.min(pages-1,n+1))}>Next</button></nav>}
      <p className="display-note">{selected.length} selected across all pages. Display limit changes visibility only.</p>
      <div className="discovery-actions"><button type="button" className="button button-secondary" disabled={continuationLocked} onClick={()=>void search('find-more')}>Find more</button><button type="button" className="button button-secondary" disabled={continuationLocked||!selected.length} onClick={()=>void search('more-like-these')}>More like these</button><button type="button" className="button button-secondary" disabled={continuationLocked} onClick={()=>void search('other-terms')}>Try other terms</button></div>
      {continuationCount>=5&&<p className="limit-note" role="status">You’ve reached the five follow-up limit. Start a new search to keep exploring.</p>}
      {!operation&&!operationUnknownId&&<button className="button button-primary review-button" disabled={busy||dialogOpen||!selected.length||blocked} onClick={e=>{opener.current=e.currentTarget;setFrozenSelection([...selected]);setDialogOpen(true)}}>Review {selected.length} selected <ArrowRight size={16}/></button>}
    </section>}
    {operationUnknownId&&<section className="outcome-card" role="status"><div className="operation-heading"><div><span className="eyebrow">OPERATION {operationUnknownId.slice(0,8)}</span><h2>Outcome not confirmed</h2></div><button type="button" className="button button-secondary" onClick={()=>{const c=unknownContext.current;if(c)void reconcile(c.id,c.manifest,c.mode,c.destination)}}>Check status</button></div><p>Media Scout could not verify the operation response. It will not create or submit the selection again. Check the saved status before taking further action.</p></section>}
     {operation&&<section className="outcome-card" aria-live="polite"><div className="operation-heading"><div><span className="eyebrow">OPERATION {operationId.slice(0,8)}</span><h2>{operation.releases.some(r=>r.status==='uncertain')?'Outcome unknown':operation.stopped?'Stopped':operation.complete?'Operation complete':'Submission progress'}</h2></div><button type="button" className="button button-secondary" onClick={()=>{const c=unknownContext.current;if(c)void reconcile(c.id,c.manifest,c.mode,c.destination)}}>Check status</button></div><p>{operation.mode==='dry-run'?'Dry run: no download was sent.':'Submitted means accepted by the download client, not completed or imported.'} Destination: {operation.destination.name} · {operation.mode}.</p><div className="operation-list">{operation.releases.map(item=><div className="outcome-row" key={item.releaseId}><strong>{result?.releases.find(r=>r.releaseId===item.releaseId)?.title||'Selected release'}</strong><span className={`outcome-${item.status}`}>{item.status==='previously-submitted'?'Previously submitted':item.status==='submitted'?'Submitted · not completed':item.status==='dry-run'?'Dry run · not sent':item.status==='uncertain'?'Unknown · check client':item.status}</span></div>)}</div>{!operation.complete&&!operation.stopped&&<button className="button button-secondary" type="button" onClick={()=>void stopOperation()}>Stop future steps</button>}{operation.releases.some(r=>r.status==='uncertain')&&<p className="unknown-note">Check your download client before taking any further action. This operation will not retry an uncertain step.</p>}</section>}
   {dialogOpen&&result&&createPortal(<div className="search-modal-backdrop"><section ref={dialog} className="search-modal" role="dialog" aria-modal="true" aria-labelledby="search-review-title" aria-describedby="search-review-description" onKeyDown={(e:KeyboardEvent<HTMLElement>)=>{if(e.key==='Escape'&&!busy){e.preventDefault();setDialogOpen(false);return}if(e.key!=='Tab')return;const all=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled])')??[]);if(!all.length){e.preventDefault();return}if(e.shiftKey&&document.activeElement===all[0]){e.preventDefault();all.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===all.at(-1)){e.preventDefault();all[0].focus()}}}><button className="modal-close" type="button" aria-label="Close review" onClick={()=>setDialogOpen(false)} disabled={busy}><X size={18}/></button><span className="eyebrow">FINAL CHECK</span><h2 id="search-review-title">Review your selection</h2><p id="search-review-description">This is the complete frozen selection. No release will be added or removed after you confirm.</p><div className="search-confirm-destination"><strong>{result.dryRun?'DRY RUN':'LIVE'}</strong><span>{result.destination?.name||'No destination'} · {result.destination?.protocol}</span></div><ul className="manifest-list">{frozenSelection.map(id=><li key={id}>{result.releases.find(r=>r.releaseId===id)?.title||id}</li>)}</ul>{(expired||selectedExpired)&&<p role="alert">{expired?'These results have expired.':'A selected release has expired.'} Close this review and search again.</p>}<div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>setDialogOpen(false)}>Cancel</button><button ref={focusTarget} type="button" className="button button-primary" disabled={busy||blocked} onClick={()=>void submitOperation()}>{busy?<><LoaderCircle className="spin" size={16}/> Working…</>:<><Check size={16}/> Confirm full selection</>}</button></div></section></div>,document.body)}
  </div>
}
