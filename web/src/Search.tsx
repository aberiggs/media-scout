import { useEffect, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, Search as SearchIcon } from 'lucide-react'
import type { Settings } from './types'

type Option = { optionId: string; rank: number; releases: Array<{ candidateId: string }>; coveredTargetIds: string[]; reason: string; uncertainty: string }
type Candidate = { candidateId: string; observations: Array<{ title: string; indexer?: string; size?: number | null; seeders?: number | null }>; excluded?: boolean }
type SearchResult = { searchId: string; status: string; prompt: string; options: Option[]; candidates: Candidate[]; events: Array<{ type: string; data: Record<string, unknown> }>; counts: { decisions: number; searches: number; candidates: number }; message?: string }
type Client = { id: number; name: string; protocol: string; categories: boolean }
const running = (status?: string) => status === 'queued' || status === 'running'

export function SearchPage({ settings, searchId }: { settings: Settings; searchId?: string }) {
  const [prompt, setPrompt] = useState(''), [advanced, setAdvanced] = useState(false)
  const [context, setContext] = useState(''), [preferences, setPreferences] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<Option | null>(null), [confirm, setConfirm] = useState(false)
  const [clients, setClients] = useState<Client[]>([]), [client, setClient] = useState('')
  const [submitting, setSubmitting] = useState(false), [clientError, setClientError] = useState('')
  const timer = useRef<number>(), controller = useRef<AbortController | null>(null)
  const opener = useRef<HTMLElement | null>(null), dialog = useRef<HTMLElement | null>(null)
  const submissionKeys = useRef(new Map<string, string>())

  useEffect(() => { if (searchId) void loadResult(searchId) }, [searchId])
  useEffect(() => () => { controller.current?.abort(); window.clearTimeout(timer.current) }, [])
  useEffect(() => {
    if (!confirm) return
    opener.current = document.activeElement as HTMLElement
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirm(false)
      if (event.key !== 'Tab') return
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)') ?? [])]
      if (!items.length) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); opener.current?.focus() }
  }, [confirm])

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
    if (!prompt.trim() || busy || running(result?.status)) return
    controller.current?.abort(); window.clearTimeout(timer.current)
    setError(''); setNotice(''); setResult(null); setBusy(true)
    try {
      const parsed: unknown = context.trim() ? JSON.parse(context) : undefined
      const body = { prompt: prompt.trim(), ...(preferences.trim() ? { preferences: { notes: preferences.trim() } } : {}), ...(parsed ? { context: parsed } : {}) }
      const response = await fetch('/api/v2/searches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await response.json() as { searchId?: string; error?: string }
      if (!response.ok || !data.searchId) throw new Error(data.error ?? 'Search could not start. Check your search settings.')
      await loadResult(data.searchId)
    } catch (failure) { setError(failure instanceof SyntaxError ? 'Context must be valid JSON.' : failure instanceof Error ? failure.message : 'Search could not start.') }
    finally { setBusy(false) }
  }
  async function choose(option: Option) {
    setSelected(option); setConfirm(true); setNotice(''); setClientError(''); setClients([])
    try {
      const response = await fetch('/api/v2/download-clients')
      if (!response.ok) throw new Error('Could not load configured clients. Check Prowlarr and try again.')
      setClients(((await response.json()) as { items: Client[] }).items)
    } catch (failure) { setClientError(failure instanceof Error ? failure.message : 'Clients unavailable.') }
  }
  async function submitOption() {
    if (!result || !selected || submitting) return
    const identity = `${result.searchId}:${selected.optionId}:${client}`
    const key = submissionKeys.current.get(identity) ?? crypto.randomUUID()
    submissionKeys.current.set(identity, key)
    setSubmitting(true)
    try {
      const response = await fetch('/api/v2/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchId: result.searchId, optionId: selected.optionId, idempotencyKey: key, ...(client ? { downloadClientId: Number(client) } : {}) }) })
      const data = await response.json() as { outcome: string; error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Submission status is uncertain. Retry this confirmation to check the same submission, not create another.')
      setConfirm(false); setNotice(`Submission outcome: ${data.outcome}. Submitted does not mean imported.`)
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : 'Submission status is uncertain. Retry to check the same submission.') }
    finally { setSubmitting(false) }
  }

  const byId = new Map((result?.candidates ?? []).map(candidate => [candidate.candidateId, candidate]))
  const progress = busy || running(result?.status)
  return <>
    <div className="page-heading"><div><h1>Search<span className="heading-period">.</span></h1><p className="page-intro">Describe what you’re looking for. Scout compares releases; you choose what to download.</p></div></div>
    <form className="search-composer" onSubmit={search}>
      <label className="field" htmlFor="search-prompt">What are you looking for?<textarea id="search-prompt" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Find the film, episode, or season you want…" maxLength={4000}/></label>
      <div className="search-form-actions"><button className="text-button" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide optional details' : 'Add optional details'}</button><button className="button button-primary" type="submit" disabled={progress || !prompt.trim()}>{progress ? <LoaderCircle className="spin" size={16}/> : <SearchIcon size={16}/>}Search releases</button></div>
      {advanced && <div className="search-optional"><label className="field">Preferences<textarea rows={2} value={preferences} onChange={event => setPreferences(event.target.value)} placeholder={settings.ai.preferences || 'Original audio, English or multi-sub, preferably 1080p'}/></label><label className="field">Structured context (JSON, optional)<textarea rows={4} value={context} onChange={event => setContext(event.target.value)} placeholder={'{"kind":"tv","titles":["Example"],"scope":{"type":"episode","seasonNumber":1,"episodeNumber":2}}'}/></label></div>}
      <p className="field-hint">Search never downloads. Model and indexer calls may cost money. Saved preferences apply unless overridden. Don’t include passwords or private links.</p>
    </form>
    {error && <div role="alert" className="notice notice-error">{error}</div>}
    {notice && <div role="status" className="notice">{notice}</div>}
    {result && <section className="search-results" aria-live="polite">
      <div className="search-result-heading"><div><h2>{result.status === 'matched' ? 'Ranked options' : running(result.status) ? 'Searching…' : result.status === 'no-match' ? 'No suitable match' : `Search ${result.status}`}</h2><p>{result.message ?? `${result.counts.candidates} candidates · ${result.counts.searches} searches · ${result.counts.decisions} model decisions`}</p></div><span className="ops-status">{result.status}</span></div>
      {result.events.some(event => event.type.startsWith('query-')) && <details className="query-trail" open><summary>Search trail</summary><ol>{result.events.filter(event => event.type.startsWith('query-')).map((event, index) => <li key={index}><strong>{event.type === 'query-start' ? 'Query' : 'Results'}:</strong> {String(event.data.query ?? 'Indexer query')}{event.data.count !== undefined && ` · ${String(event.data.count)} results`}</li>)}</ol></details>}
      {running(result.status) ? <p role="status" className="ops-state-panel"><LoaderCircle className="spin"/>Checking indexers and comparing releases…</p> : !result.options.length ? <div className="ops-state-panel ops-empty"><h2>{result.status === 'no-match' ? 'No suitable releases found' : 'Search did not produce a recommendation'}</h2><p>{result.message ?? 'Try an alternate title or add more context.'}</p></div> : <div className="ranked-options">{result.options.map(option => <article className="ranked-option" key={option.optionId}>
        <div className="option-title"><h3>{option.rank === 1 ? 'Best match' : `Alternative ${option.rank - 1}`}</h3><span>Option {option.rank}</span></div>
        <p className="option-reason">{option.reason}</p>{option.uncertainty && <p className="option-uncertainty">{option.uncertainty}</p>}
        <ul className="option-releases">{option.releases.map(release => { const candidate = byId.get(release.candidateId), evidence = candidate?.observations[0]; return <li key={release.candidateId}><strong>{evidence?.title ?? 'Release details unavailable'}</strong>{evidence && <span>{[evidence.indexer, evidence.size ? `${(evidence.size / 1e9).toFixed(1)} GB` : null, evidence.seeders != null ? `${evidence.seeders} seeders` : 'Seeders unknown'].filter(Boolean).join(' · ')}</span>}{candidate?.excluded && <span>Temporarily excluded after a previous attempt</span>}</li> })}</ul>
        {option.coveredTargetIds.length > 0 && <p className="field-hint">Covers {option.coveredTargetIds.length} requested target(s); coverage is not proof of imported files.</p>}
        <button className="button button-primary" type="button" onClick={() => void choose(option)} disabled={result.status !== 'matched'}>{settings.safety.dryRun ? 'Preview submission' : 'Choose and confirm download'}</button>
      </article>)}</div>}
      {!!result.candidates.length && <details className="all-candidates"><summary>All candidates ({result.candidates.length})</summary><ul>{result.candidates.map(candidate => <li key={candidate.candidateId}>{candidate.observations[0]?.title ?? 'Untitled candidate'}{candidate.excluded && ' · Temporarily excluded'}</li>)}</ul></details>}
    </section>}
    {confirm && selected && <div className="ops-dialog-backdrop"><section ref={dialog} className="ops-dialog search-confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div className="ops-dialog-head"><div><h2 id="confirm-title">Confirm this option</h2><p>Choose the configured client and category route.</p></div><button className="icon-button" aria-label="Close confirmation" disabled={submitting} onClick={() => setConfirm(false)}>×</button></div><div className="ops-dialog-body"><p>{selected.reason}</p><p className={settings.safety.dryRun ? 'ops-info-box' : 'ops-warning-box'}>{settings.safety.dryRun ? 'Dry-run is on. No download will be submitted.' : 'Confirming may start a download. Scout does not cancel existing jobs.'}</p>{clientError && <p role="alert">{clientError}</p>}<label className="field">Download client (optional)<select value={client} disabled={submitting} onChange={event => setClient(event.target.value)}><option value="">Use configured default route</option>{clients.map(item => <option key={item.id} value={item.id}>{item.name} · {item.protocol}{item.categories ? ' · categories' : ''}</option>)}</select></label><div className="ops-dialog-actions"><button className="button button-secondary" disabled={submitting} onClick={() => setConfirm(false)}>Cancel</button><button className="button button-primary" disabled={submitting || !!clientError} onClick={() => void submitOption()}>{submitting ? 'Submitting…' : 'Confirm option'}</button></div></div></section></div>}
  </>
}
