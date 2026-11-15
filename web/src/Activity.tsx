import { useEffect, useState } from 'react'
import type { Settings } from './types'

type ActivityItem = { searchId: string; prompt: string; status: string; createdAt: string; source: 'manual' | 'automation'; kind?: 'tv' | 'movie'; counts?: { candidates: number }; submission?: { outcome: string } }
type AutomationItem = { targetId: string; title: string; kind: 'tv' | 'movie'; seriesId?: string; seasonNumber?: number; episodeNumber?: number; status: string; eligible: boolean; observedAt?: string; nextAttemptAt?: string; lastAttemptAt?: string }
type Automation = { enabled: boolean; dryRun: boolean; running: boolean; providers: Array<{ provider: string; known: boolean; observedAt?: string; error?: string; unidentifiedQueueRows: number; unknownSeriesIds?: string[] }>; items: AutomationItem[] }
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not observed yet'

export function ActivityPage({ onOpenSearch }: { onOpenSearch(id: string): void }) {
  const [items, setItems] = useState<ActivityItem[]>([]), [total, setTotal] = useState(0)
  const [q, setQ] = useState(''), [source, setSource] = useState(''), [status, setStatus] = useState('')
  const [kind, setKind] = useState(''), [createdAtFrom, setCreatedAtFrom] = useState(''), [createdAtTo, setCreatedAtTo] = useState('')
  const [offset, setOffset] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [retention, setRetention] = useState({ days: 30, maxEntries: 10000 })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const params = new URLSearchParams({ limit: '50', offset: String(offset) })
    for (const [key, value] of Object.entries({ q, source, status, kind, createdAtFrom: createdAtFrom ? new Date(`${createdAtFrom}T00:00:00`).toISOString() : '', createdAtTo: createdAtTo ? new Date(`${createdAtTo}T23:59:59.999`).toISOString() : '' })) if (value) params.set(key, value)
    fetch(`/api/v2/activity?${params}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Activity could not be loaded.')
      const data = await response.json()
      if (controller.signal.aborted) return
      setItems(data.items); setTotal(data.total); setRetention(data.retention ?? { days: 30, maxEntries: 10000 }); setError('')
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [q, source, status, kind, createdAtFrom, createdAtTo, offset])
  return <>
    <Heading title="Activity" intro="What Scout searched, recommended and submitted."/>
    <div className="ops-list-card">
      <div className="ops-controls">
        <label className="field">Filter searches<input value={q} onChange={event => { setQ(event.target.value); setOffset(0) }} placeholder="Search request"/></label>
        <label className="field">Source<select value={source} onChange={event => { setSource(event.target.value); setOffset(0) }}><option value="">All sources</option><option value="manual">Manual</option><option value="automation">Automation</option></select></label>
        <label className="field">Media<select value={kind} onChange={event => { setKind(event.target.value); setOffset(0) }}><option value="">All media</option><option value="tv">TV</option><option value="movie">Movie</option><option value="other">Other / no context</option></select></label>
        <label className="field">Created from<input type="date" value={createdAtFrom} onChange={event => { setCreatedAtFrom(event.target.value); setOffset(0) }}/></label>
        <label className="field">Created through<input type="date" value={createdAtTo} onChange={event => { setCreatedAtTo(event.target.value); setOffset(0) }}/></label>
        <label className="field">Status<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="">All statuses</option>{['queued', 'running', 'matched', 'no-match', 'needs-input', 'budget-exhausted', 'failed', 'interrupted', 'dry-run', 'submitted', 'rejected', 'uncertain', 'deferred', 'expired'].map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {loading ? <p role="status" className="ops-state-panel">Loading activity…</p> : !items.length && !error ? <div className="ops-state-panel ops-empty"><h2>No matching activity</h2><p>Search attempts will appear here, including unsuccessful searches.</p></div> : <div className="ops-activity-list">{items.map(item => <article className="ops-activity-row" key={item.searchId}>
        <div className="ops-activity-top"><strong>{item.prompt}</strong><span className="ops-status">{item.status}</span></div>
        <div className="ops-activity-date">{date(item.createdAt)} · {item.kind ?? 'other'} · {item.source}{item.counts && ` · ${item.counts.candidates} candidates`}{item.submission && ` · Submission: ${item.submission.outcome}`}</div>
        <button className="text-button" onClick={() => onOpenSearch(item.searchId)}>View search details</button>
      </article>)}</div>}
      <div className="ops-pagination"><span>{total} searches · kept up to {retention.days} days / {retention.maxEntries.toLocaleString()} entries</span><div><button className="button button-secondary" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="button button-secondary" disabled={offset + 50 >= total || loading} onClick={() => setOffset(offset + 50)}>Next</button></div></div>
    </div>
  </>
}

export function AutomationPage({ settings, onOpenSearch, onToggle }: { settings: Settings; onOpenSearch(id: string): void; onToggle?(): Promise<void> }) {
  const [data, setData] = useState<Automation | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  async function refresh() {
    try { const response = await fetch('/api/v2/automation'); if (!response.ok) throw new Error('Saved Arr observations are unavailable.'); setData(await response.json()); setError('') }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Automation status unavailable.') }
  }
  useEffect(() => { void refresh() }, [])
  async function poll() {
    setBusy(true); setNotice('')
    try {
      const response = await fetch('/api/v2/automation/poll', { method: 'POST' }), result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Poll could not run.')
      setNotice(result.reason === 'disabled' ? 'Arr observations refreshed. Automation remains paused.' : result.ran ? 'Poll completed.' : `No search started: ${result.reason ?? 'nothing due'}.`)
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Poll failed.') }
    finally { setBusy(false) }
  }
  async function search(id: string) {
    setBusy(true)
    try {
      const response = await fetch('/api/v2/automation/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: id }) }), result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Search could not start. Check current queue and retry timing.')
      onOpenSearch(result.searchId)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Search failed.') }
    finally { setBusy(false) }
  }
  const groups = new Map<string, AutomationItem[]>()
  for (const item of data?.items ?? []) { const key = `${item.kind}:${item.seriesId ?? item.targetId}`; groups.set(key, [...(groups.get(key) ?? []), item]) }
  return <>
    <Heading title="Automation" intro="Arr decides what is missing and downloading. Scout handles the search."/>
    <div className="ops-page-toolbar"><p className="ops-scope-note">Automation is {data?.enabled ? 'enabled' : 'paused'} · {settings.safety.dryRun ? 'Dry-run on' : 'Downloads enabled'} · {data?.running ? 'A poll is running' : 'No poll running'}</p><div>
      {onToggle && <button className="button button-secondary" disabled={busy} onClick={() => { setBusy(true); void onToggle().then(refresh).catch(() => setError('Could not change automation settings.')).finally(() => setBusy(false)) }}>{data?.enabled ? 'Pause automation' : 'Enable automation'}</button>}{' '}
      <button className="button button-secondary" onClick={() => void refresh()}>Refresh saved view</button>{' '}<button className="button button-primary" disabled={busy} onClick={() => void poll()}>{busy ? 'Working…' : 'Poll now'}</button>
    </div></div>
    {error && <p role="alert" className="notice notice-error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!data ? <p role="status" className="ops-state-panel">Loading saved observations…</p> : <>
      <section className="settings-card"><div className="section-heading"><div className="section-title"><h2>Arr observations</h2><p>Refreshing this view does not contact Arr. Poll now explicitly reads upstream.</p></div></div><div className="section-body field-grid">{data.providers.map(provider => <div key={provider.provider}><h3>{provider.provider}</h3><p>{!provider.known ? 'Unknown' : provider.observedAt && Date.now() - Date.parse(provider.observedAt) > 86_400_000 ? 'Stale observation' : 'Known'} · observed {date(provider.observedAt)}</p>{provider.error && <p>{provider.error}</p>}{!!provider.unknownSeriesIds?.length && <p>Some episode inventories are unknown ({provider.unknownSeriesIds.join(', ')}).</p>}<p>{provider.unidentifiedQueueRows} unidentified queue rows</p></div>)}</div></section>
      <section className="settings-card"><div className="section-heading"><div className="section-title"><h2>Observed missing work</h2></div></div>{!data.items.length ? <div className="ops-state-panel ops-empty"><h2>No observed work</h2><p>Use Poll now to read Arr. Unknown observations are not proof that nothing is missing.</p></div> : [...groups].map(([key, items]) => <details className="automation-group" key={key} open><summary>{items[0]?.title} <span className="field-hint">{items.length} {items[0]?.kind === 'tv' ? 'episode(s)' : 'movie'}</span></summary><div className="ops-work-list">{items.map(item => <article className="ops-work-row" key={item.targetId}><div className="ops-work-main"><div className="ops-work-title"><h3>{item.kind === 'tv' ? `Season ${item.seasonNumber ?? '?'} · Episode ${item.episodeNumber ?? '?'}` : item.title}</h3><span className="ops-status">{item.status}</span></div><p className="ops-work-meta">Observed {date(item.observedAt)} · {item.eligible ? 'Eligible' : 'Not currently eligible'}</p><p className="ops-work-meta">Next attempt: {item.nextAttemptAt ? date(item.nextAttemptAt) : item.eligible ? 'Next eligible poll' : 'Waiting for Arr'}{item.lastAttemptAt && ` · Last attempt ${date(item.lastAttemptAt)}`}</p></div><button className="button button-secondary" disabled={busy || !(item.eligible || item.status === 'cooldown')} onClick={() => void search(item.targetId)}>Search this item</button></article>)}</div></details>)}</section>
    </>}
  </>
}
function Heading({ title, intro }: { title: string; intro: string }) { return <div className="page-heading"><div><h1>{title}<span className="heading-period">.</span></h1><p className="page-intro">{intro}</p></div></div> }
