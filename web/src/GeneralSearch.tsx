import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowRight, Check, Clock3, LoaderCircle, Search, ShieldCheck, Sparkles } from 'lucide-react'
import type { GeneralGrabResponse, GeneralSearchResponse } from '../../src/types/general-search'

const grabStatuses = new Set(['submitted', 'dry-run', 'submitting', 'failed', 'uncertain', 'not-attempted'])

function isGrabResponse(value: unknown, expected: { searchId: string; dryRun: boolean; releaseIds: string[] }): value is GeneralGrabResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<GeneralGrabResponse>
  if (candidate.searchId !== expected.searchId || candidate.dryRun !== expected.dryRun || !Array.isArray(candidate.results)) return false
  const returned = new Set<string>()
  for (const item of candidate.results) {
    if (!item || typeof item !== 'object') return false
    const result = item as GeneralGrabResponse['results'][number]
    if (typeof result.releaseId !== 'string' || !expected.releaseIds.includes(result.releaseId) || returned.has(result.releaseId)) return false
    if (typeof result.status !== 'string' || !grabStatuses.has(result.status) || !(result.code === null || typeof result.code === 'string')) return false
    returned.add(result.releaseId)
  }
  return returned.size === expected.releaseIds.length && expected.releaseIds.every(id => returned.has(id))
}

export function GeneralSearchPage() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<GeneralSearchResponse | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState(false)
  const [outcomes, setOutcomes] = useState<GeneralGrabResponse | null>(null)
  const [unknownSubmission, setUnknownSubmission] = useState<string[]>([])
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const dialog = useRef<HTMLElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => () => { sequence.current++; controller.current?.abort() }, [])
  useEffect(() => {
    if (!result?.expiresAt) return
    const expiresAt = Date.parse(result.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_000_000, expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [result?.expiresAt, now])
  useEffect(() => {
    if (!review) return
    confirmButton.current?.focus()
    return () => { opener.current?.focus() }
  }, [review])
  const search = async (event: FormEvent) => {
    event.preventDefault()
    const clean = query.trim()
    if (!clean || busy) return
    const id = ++sequence.current
    controller.current?.abort()
    const aborter = new AbortController(); controller.current = aborter
    setBusy(true); setError(''); setResult(null); setSelected([]); setReview(false); setOutcomes(null); setUnknownSubmission([])
    try {
      const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: clean }), signal: aborter.signal })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Search could not be completed.')
      if (sequence.current === id) { setNow(Date.now()); setResult(body as GeneralSearchResponse) }
    } catch (e) { if (sequence.current === id && !aborter.signal.aborted) setError(e instanceof Error ? e.message : 'Search could not be completed.') }
    finally { if (sequence.current === id) setBusy(false) }
  }
  const submit = async () => {
    if (!result?.searchId || !result.confirmationToken || !result.actionsAllowed || !selected.length || busy) return
    const id = ++sequence.current
    const submittedIds = [...selected]
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/search/${encodeURIComponent(result.searchId)}/grab`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmationToken: result.confirmationToken, releaseIds: selected, confirmed: true }) })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'Selected releases could not be submitted.')
      if (!isGrabResponse(body, { searchId: result.searchId, dryRun: result.dryRun, releaseIds: submittedIds })) throw new Error('The submission response was incomplete or did not match this selection.')
      if (sequence.current === id) { setOutcomes(body); setReview(false) }
    } catch {
      if (sequence.current === id) {
        setUnknownSubmission(submittedIds)
        setReview(false)
        setError('We couldn’t confirm whether these releases reached the download client. Check the client before taking any further action; this screen will not retry them.')
      }
    }
    finally { if (sequence.current === id) setBusy(false) }
  }
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(x => x !== id) : current.length < 10 ? [...current, id] : current)
  const expired = Boolean(result?.expiresAt && Date.parse(result.expiresAt) <= now)
  const blocked = result && (!result.actionsAllowed || !result.destination || !result.confirmationToken || !result.searchId || expired || unknownSubmission.length > 0)
  return <div className="general-search">
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> OPEN-ENDED DISCOVERY</div><h1>General search<span className="heading-period">.</span></h1><p className="page-intro">Describe what you’re looking for. You choose what, if anything, gets sent to a download client.</p></div><div className="heading-stamp"><Sparkles size={15}/><span>YOU STAY IN CONTROL</span></div></div>
    <form className="general-search-form" onSubmit={search}><label htmlFor="general-query">What would you like to find?</label><div className="general-query-wrap"><Search size={19}/><input id="general-query" value={query} maxLength={500} disabled={busy || review} onChange={e => setQuery(e.target.value)} placeholder="A thoughtful documentary about deep-sea exploration…"/><button className="button button-primary" disabled={busy || review || !query.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <ArrowRight size={16}/>}<span>{busy ? 'Working…' : 'Search'}</span></button></div><span className="field-hint">Use your own words. No download is started by searching or selecting.</span></form>
    {error && <div className="notice notice-error" role="alert"><AlertCircle size={17}/><p>{error}</p></div>}
    {busy && !result && <div className="loading-view" role="status"><LoaderCircle className="spin" size={21}/><span>Searching indexers…</span></div>}
    {result && <section className="general-results" aria-live="polite">
      <div className="general-query-summary"><span className="eyebrow">SEARCHING FOR</span><h2>{result.query}</h2>{result.queries.length > 0 && <p>Search terms: {result.queries.join(' · ')}</p>}</div>
      {result.status === 'clarification-needed' && <form className="clarification-card" onSubmit={search}><Sparkles size={18}/><div><h2>A quick question</h2><p>{result.question}</p><label htmlFor="refined-query">Refine your search</label><textarea id="refined-query" rows={2} value={query} disabled={busy || review} onChange={e => setQuery(e.target.value)} maxLength={500}/><button className="button button-primary" disabled={busy || review || !query.trim()}>Search with this detail <ArrowRight size={15}/></button></div></form>}
      {result.status === 'selection-required' && <>
        <div className="search-destination"><span><ShieldCheck size={16}/> Destination</span><strong>{result.destination ? `${result.destination.name} · ${result.destination.protocol}` : 'Not configured'}</strong><b className={result.dryRun ? 'dry' : 'live'}>{result.dryRun ? 'DRY RUN · no download sent' : 'LIVE · explicit confirmation required'}</b></div>
        {blocked && <div className="blocked-note" role="status"><AlertCircle size={17}/><span>{unknownSubmission.length ? 'Submission status is unknown. Check your download client before taking further action; a fresh search will not show whether these releases were received.' : expired ? 'These results have expired. Search again to get a fresh selection.' : result.blockedReason || (!result.destination ? 'Configure a general download client in Settings before submitting a release.' : !result.actionsAllowed ? 'Enable Allow operator actions in Settings before submitting a release.' : 'This selection cannot be submitted. Search again for a fresh selection.')} Search results remain available to review.</span></div>}
        {result.releases.length === 0 ? <div className="empty-search"><Search size={22}/><h2>No matching releases</h2><p>Try a broader description or different wording.</p></div> : <>
          <div className="results-heading"><div><h2>Releases to review</h2><p>Nothing is selected yet. Choose up to 10 releases.</p></div><span>{selected.length} / 10 selected</span></div>
          <div className="release-list">{result.releases.map(release => <label className={`release-row ${!release.selectable ? 'unavailable' : ''}`} key={release.releaseId}><input type="checkbox" aria-label={`Select ${release.title}`} checked={selected.includes(release.releaseId)} disabled={busy || review || !release.selectable || (selected.length >= 10 && !selected.includes(release.releaseId)) || Boolean(outcomes) || unknownSubmission.length > 0} onChange={() => toggle(release.releaseId)}/><span className="release-copy"><strong>{release.title}</strong><span>{release.indexer} · {release.protocol} · {release.size === null ? 'Size unknown' : `${(release.size / 1024 ** 3).toFixed(1)} GB`}{release.protocol === 'torrent' && release.seeders !== null ? ` · ${release.seeders} seeders` : ''}</span>{release.unavailableReason && <em>{release.unavailableReason}</em>}</span><span className="release-age"><Clock3 size={13}/>{release.age}d</span></label>)}</div>
          {!outcomes && !unknownSubmission.length && <button className="button button-primary review-button" disabled={busy || !selected.length || Boolean(blocked)} onClick={e => { opener.current = e.currentTarget; setReview(true) }}>Review {selected.length || 'selected'} release{selected.length === 1 ? '' : 's'} <ArrowRight size={16}/></button>}
        </>}
      </>}
      {outcomes && <div className="outcome-card"><h2>Submission results</h2><p>{outcomes.dryRun ? 'Dry run: no downloads were sent.' : 'A submitted status means sent to the client, not finished downloading.'}</p>{outcomes.results.map(outcome => { const release = result.releases.find(item => item.releaseId === outcome.releaseId); const labels: Record<typeof outcome.status, string> = { submitted: 'Submitted · not completed', 'dry-run': 'Dry run · not sent', submitting: 'Submitting', failed: 'Failed', uncertain: 'Uncertain · not retried', 'not-attempted': 'Not attempted' }; const explanations: Record<string, string> = { 'client-unavailable': 'Download client was unavailable', 'client-rejected': 'Download client did not accept this release', 'request-timeout': 'The request timed out; whether it was received is unknown', 'upstream-error': 'The download service reported an error', 'configuration-missing': 'A required download setting is missing', 'operator-actions-disabled': 'Operator actions are disabled in Settings', 'search-expired': 'The search selection expired before submission' }; return <div className="outcome-row" key={outcome.releaseId}><strong>{release?.title || 'Selected release'}</strong><span className={`outcome-${outcome.status}`}>{labels[outcome.status]}</span>{outcome.code && <small>{explanations[outcome.code] || 'More detail is available in the application logs.'}</small>}</div> })}</div>}
      {unknownSubmission.length > 0 && <div className="outcome-card" role="status"><h2>Submission status unknown</h2><p>Media Scout did not receive a clear result. Check your download client before taking any further action. These releases will not be retried from this screen.</p>{unknownSubmission.map(id => <div className="outcome-row" key={id}><strong>{result.releases.find(release => release.releaseId === id)?.title || 'Selected release'}</strong><span className="outcome-uncertain">Unknown · check client</span></div>)}</div>}
    </section>}
    {review && result && <div className="search-modal-backdrop"><section ref={dialog} className="search-modal" role="dialog" aria-modal="true" aria-labelledby="search-review-title" onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); setReview(false); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])') ?? [])
      if (!focusable.length) { event.preventDefault(); return }
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}><span className="eyebrow">FINAL CHECK</span><h2 id="search-review-title">Review selected releases</h2><p>Only these {selected.length} releases will be submitted. This is a deliberate action; searching and selecting did not contact your download client.</p><div className="search-confirm-destination"><strong>{result.dryRun ? 'DRY RUN' : 'LIVE DOWNLOAD'}</strong><span>{result.destination?.name || 'No destination'}</span></div>{expired && <p role="alert">These results have expired. Close this review and search again.</p>}<ul>{selected.map(id => <li key={id}>{result.releases.find(r => r.releaseId === id)?.title}</li>)}</ul><div className="modal-actions">{!busy && <button type="button" className="button button-secondary" onClick={() => setReview(false)}>Cancel</button>}<button ref={confirmButton} type="button" className="button button-primary" disabled={busy || Boolean(blocked)} onClick={() => void submit()}>{busy ? <><LoaderCircle className="spin" size={16}/> Submitting…</> : <><Check size={16}/> Confirm and submit</>}</button></div></section></div>}
  </div>
}
