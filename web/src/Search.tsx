import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CircleAlert, LoaderCircle, Search as SearchIcon, ShieldCheck, Waves } from 'lucide-react'
import type { Settings } from './types'

type Candidate = { candidateId: string; observations?: Array<{ title: string; indexer?: string; size?: number | null; seeders?: number | null }>; excluded?: boolean }
type Selection = { candidateId: string; targetIds: string[]; reason: string; uncertainty: string }
type Plan = { version: number; planId: string; status: string; selections: Selection[]; coverage: { covered: string[]; gaps: string[]; deferred: string[]; broad: { status: string; gaps: string[] } }; warnings?: string[]; message?: string }
type SearchResult = { searchId: string; status: string; normalizedRequest?: unknown; plan?: Plan; legacyResult?: unknown; candidates?: Candidate[]; events?: Array<{ type: string; data: Record<string, unknown> }>; counts?: { decisions: number; searches: number; candidates: number }; queuePosition?: number; waitingReason?: string; retryAt?: string; message?: string }
const running = (status?: string) => status === 'queued' || status === 'running'
export function SearchPage({ settings, searchId, searchRevision, onSearchStarted }: { settings: Settings; searchId?: string; searchRevision: number; active?: boolean; onSearchStarted(id: string, startingRevision: number): void }) {
  const [prompt, setPrompt] = useState(''), [advanced, setAdvanced] = useState(false)
  const [context, setContext] = useState(''), [preferences, setPreferences] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const timer = useRef<number>(), controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!searchId) return
    setResult(null)
    setError('')
    void loadResult(searchId)
  }, [searchId, searchRevision])
  useEffect(() => () => { controller.current?.abort(); window.clearTimeout(timer.current) }, [])
  async function loadResult(id: string) {
    window.clearTimeout(timer.current)
    controller.current?.abort()
    const current = new AbortController(); controller.current = current
    try {
      const response = await fetch(`/api/v2/searches/${encodeURIComponent(id)}`, { signal: current.signal })
      if (!response.ok) throw new Error('This search is unavailable. Start a new search or check Activity.')
      const data = await response.json() as SearchResult
      if (current.signal.aborted) return
      setResult(data); setError('')
      if (running(data.status)) timer.current = window.setTimeout(() => void loadResult(id), 1200)
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Search could not be loaded.') }
  }
  async function search(event: FormEvent) {
    event.preventDefault()
    if (!prompt.trim() || busy) return
    const startingRevision = searchRevision
    controller.current?.abort(); window.clearTimeout(timer.current)
    setError(''); setNotice(''); setResult(null); setBusy(true)
    try {
      const parsed: unknown = context.trim() ? JSON.parse(context) : undefined
      const body = { prompt: prompt.trim(), ...(preferences.trim() ? { preferences: { notes: preferences.trim() } } : {}), ...(parsed ? { context: parsed } : {}) }
      const response = await fetch('/api/v2/searches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await response.json() as { searchId?: string; error?: string }
      if (!response.ok || !data.searchId) throw new Error(data.error ?? 'Search could not start. Check your search settings.')
      onSearchStarted(data.searchId, startingRevision)
    } catch (failure) { setError(failure instanceof SyntaxError ? 'Context must be valid JSON.' : failure instanceof Error ? failure.message : 'Search could not start.') }
    finally { setBusy(false) }
  }
   const byId = new Map((result?.candidates ?? []).map(candidate => [candidate.candidateId, candidate]))
   const plan = result?.plan
   const receipts = (result?.events ?? []).filter(event => event.type === 'submission').map(event => event.data)
  const progress = busy
  const searchReady = Boolean(settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey && settings.ai.apiKey)
  return <div className="search-layout"><div className="search-main">
    <div className="page-heading"><div><h1>Search<span className="heading-period">.</span></h1><p className="page-intro">Describe what you’re looking for. Scout researches one best-effort release-set plan.</p></div></div>
    <form className="search-composer" onSubmit={search}>
      <label className="field" htmlFor="search-prompt">What are you looking for?<textarea id="search-prompt" aria-label="What are you looking for?" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Find the film, episode, or season you want…" maxLength={4000}/></label>
      <div className="search-form-actions"><button className="text-button" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide optional details' : 'Add optional details'}</button><button className="button button-primary" type="submit" disabled={progress || !prompt.trim()}>{progress ? <LoaderCircle className="spin" size={16}/> : <SearchIcon size={16}/>}Search releases</button></div>
      {advanced && <div className="search-optional"><label className="field">Preferences<textarea rows={2} value={preferences} onChange={event => setPreferences(event.target.value)} placeholder={settings.ai.preferences || 'Original audio, English or multi-sub, preferably 1080p'}/></label><label className="field">Structured context (JSON, optional)<textarea rows={4} value={context} onChange={event => setContext(event.target.value)} placeholder={'{"kind":"tv","titles":["Example"],"scope":{"type":"episode","seasonNumber":1,"episodeNumber":2}}'}/></label></div>}
      <p className="field-hint">Search never downloads. Model and indexer calls may cost money. Saved preferences apply unless overridden. Don’t include passwords or private links.</p>
    </form>
    {error && <div role="alert" className="notice notice-error">{error}</div>}
    {notice && <div role="status" className="notice">{notice}</div>}
    {result && <section className="search-results" aria-live="polite">
       <div className="search-result-heading"><div><h2>{result.status === 'matched' ? 'Search plan' : result.status === 'queued' ? 'Search queued' : result.status === 'running' ? 'Searching…' : result.status === 'no-match' ? 'No suitable match' : `Search ${result.status}`}</h2><p>{result.message ?? `${result.counts?.candidates ?? 0} candidates · ${result.counts?.searches ?? 0} searches · ${result.counts?.decisions ?? 0} model decisions`}</p></div><span className="ops-status">{result.status}</span></div>
       {(result.events ?? []).some(event => event.type.startsWith('query-')) && <details className="query-trail" open><summary>Search trail</summary><ol>{(result.events ?? []).filter(event => event.type.startsWith('query-')).map((event, index) => <li key={index}><strong>{event.type === 'query-start' ? 'Query' : 'Results'}:</strong> {String(event.data.query ?? 'Indexer query')}{event.data.count !== undefined && ` · ${String(event.data.count)} results`}</li>)}</ol></details>}
       {receipts.length > 0 && <section className="query-trail" aria-labelledby="submission-history"><h3 id="submission-history">Historical submission receipts</h3><p>Read-only records from the previous execution workflow.</p>{receipts.map((receipt, index) => <pre key={index}>{JSON.stringify(receipt, null, 2)}</pre>)}</section>}
        {result.status === 'queued' ? <p role="status" className="ops-state-panel"><LoaderCircle className="spin"/>Queued{result.queuePosition ? ` · ${Math.max(0, result.queuePosition - 1)} ahead` : ''}{result.waitingReason === 'provider-cooldown' && result.retryAt ? ` · Provider cooldown until ${new Date(result.retryAt).toLocaleTimeString()}` : result.waitingReason === 'settings-incomplete' ? ' · Complete Settings to start it' : result.waitingReason === 'capacity' ? ' · Waiting for an execution slot' : ''}. Your search will start automatically.</p> : result.status === 'running' ? <p role="status" className="ops-state-panel"><LoaderCircle className="spin"/>Checking indexers and comparing releases…</p> : result.legacyResult ? <div className="ops-state-panel"><h2>Legacy search record</h2><p>This saved result uses a retired format and is available for inspection only.</p><pre>{JSON.stringify(result.legacyResult, null, 2)}</pre></div> : <><p className="ops-info-box">Plan only. Download execution is unavailable in this version.</p>{(plan?.selections ?? []).map((selection, index) => { const candidate = byId.get(selection.candidateId), evidence = candidate?.observations?.[0]; return <article className="ranked-option" key={`${selection.candidateId}-${index}`}><h3>{evidence?.title ?? 'Selected candidate'}</h3><p>{selection.reason}</p>{selection.uncertainty && <p className="option-uncertainty">Uncertainty: {selection.uncertainty}</p>}<p className="field-hint">Targets: {selection.targetIds.join(', ') || 'Not specified'}</p></article> })}<div className="query-trail"><h3>Coverage</h3><p>Covered: {(plan?.coverage?.covered ?? []).join(', ') || 'None reported'}</p><p>Gaps: {(plan?.coverage?.gaps ?? []).join(', ') || 'None reported'}</p><p>Deferred: {(plan?.coverage?.deferred ?? []).join(', ') || 'None'}</p>{plan?.coverage?.broad && <p>Broad search: {plan.coverage.broad.status} · {plan.coverage.broad.gaps.join(', ')}</p>}{plan?.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}</div></>}
       {!!result.candidates?.length && <details className="all-candidates"><summary>All candidates ({result.candidates.length})</summary><ul>{result.candidates.map(candidate => <li key={candidate.candidateId}>{candidate.observations?.[0]?.title ?? 'Untitled candidate'}{candidate.excluded && ' · Temporarily excluded'}</li>)}</ul></details>}
    </section>}
    </div><aside className="search-rail" aria-label="Search information">
      <section className="rail-card search-rail-status"><div className="search-rail-icon"><Waves size={17}/></div><strong>{searchReady ? 'Search setup complete' : 'Setup needed'}</strong><p>{searchReady ? 'Services are configured. Run a search to test live connections.' : 'Add a Prowlarr URL, API key, and model API key in Settings.'}</p><div className="search-checks"><span className={settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? 'configured' : ''}>{settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? <Check size={14}/> : <CircleAlert size={14}/>} Prowlarr {settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? 'configured' : 'needed'}</span><span className={settings.ai.apiKey ? 'configured' : ''}>{settings.ai.apiKey ? <Check size={14}/> : <CircleAlert size={14}/>} AI model {settings.ai.apiKey ? 'configured' : 'needed'}</span></div></section>
       <section className={`rail-card search-safety ${settings.safety.dryRun ? 'is-dry-run' : 'is-live'}`}><div className="search-rail-icon">{settings.safety.dryRun ? <ShieldCheck size={17}/> : <CircleAlert size={17}/>}</div><strong>{settings.safety.dryRun ? 'Dry-run saved preference: on' : 'Dry-run saved preference: off'}</strong><p>Download execution is unavailable in this version. Search plans are read-only.</p><a href="#settings">Review safety settings</a></section>
      <p className="search-rail-footnote">Searches use live model and indexer calls, which may incur provider costs.</p>
    </aside></div>
}
