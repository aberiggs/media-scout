import { useEffect, useRef, useState } from 'react'
import { Activity as ActivityIcon, ArrowRight, CheckCircle2, Clock3, Database, Film, Radio, RefreshCw, Search as SearchIcon, ShieldCheck, Tv } from 'lucide-react'
import type { Settings } from './types'

type ActivityItem = { searchId: string; prompt: string; status: string; createdAt: string; source: 'manual' | 'automation'; kind?: 'tv' | 'movie'; counts?: { candidates: number }; submission?: { outcome: string } }
type AutomationItem = { targetId: string; titleId: string; title: string; kind: 'tv' | 'movie'; seasonNumber?: number; episodeNumber?: number; status: string; eligible: boolean; observedAt?: string; metadataAirDate?: string; eligibleAt?: string; nextAttemptAt?: string; lastAttemptAt?: string }
type Automation = { enabled: boolean; allowDownloads?: boolean; dryRun: boolean; running: boolean; executionBlocked?: boolean; executionBlockedReason?: 'automation-disabled' | 'downloads-not-activated' | 'dry-run' | string; providers: Array<{ provider: string; known: boolean; observedAt?: string; error?: string; unidentifiedQueueRows: number; unknownSeriesIds?: string[] }>; items: AutomationItem[]; airingOffsets: Array<{ titleId: string; title: string; hoursEarly: number }> }
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not observed yet'
const automationStatusLabel: Record<string, string> = {
  missing: 'Missing', downloading: 'Downloading', grace: 'Waiting for import', cooldown: 'Retry cooldown',
  backoff: 'Retry backoff', upcoming: 'Upcoming', 'no-air-date': 'No air date', 'waiting-for-radarr': 'Waiting for Radarr',
}

export function ActivityPage({ onOpenSearch }: { onOpenSearch(id: string): void }) {
  const [items, setItems] = useState<ActivityItem[]>([]), [total, setTotal] = useState<number | null>(null)
  const [q, setQ] = useState(''), [source, setSource] = useState(''), [status, setStatus] = useState('')
  const [kind, setKind] = useState(''), [createdAtFrom, setCreatedAtFrom] = useState(''), [createdAtTo, setCreatedAtTo] = useState('')
  const [offset, setOffset] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [retryVersion, setRetryVersion] = useState(0)
  const [retention, setRetention] = useState({ days: 30, maxEntries: 10000 })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setTotal(null)
    const params = new URLSearchParams({ limit: '50', offset: String(offset) })
    for (const [key, value] of Object.entries({ q, source, status, kind, createdAtFrom: createdAtFrom ? new Date(`${createdAtFrom}T00:00:00`).toISOString() : '', createdAtTo: createdAtTo ? new Date(`${createdAtTo}T23:59:59.999`).toISOString() : '' })) if (value) params.set(key, value)
    fetch(`/api/v2/activity?${params}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Activity could not be loaded.')
      const data = await response.json()
      if (controller.signal.aborted) return
      setItems(data.items); setTotal(data.total); setRetention(data.retention ?? { days: 30, maxEntries: 10000 }); setError('')
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Activity could not be loaded.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [q, source, status, kind, createdAtFrom, createdAtTo, offset, retryVersion])
  return <>
     <Heading title="Activity" intro="A record of searches, recommendations, and per-release submission outcomes." eyebrow="SEARCH RECORD" icon={<ActivityIcon size={15}/>}/>
    <div className="activity-layout"><div className="ops-page"><div className="ops-list-card">
      <div className="ops-controls activity-filters">
        <label className="field">Filter searches<input value={q} onChange={event => { setQ(event.target.value); setOffset(0) }} placeholder="Search request"/></label>
        <label className="field">Source<select value={source} onChange={event => { setSource(event.target.value); setOffset(0) }}><option value="">All sources</option><option value="manual">Manual</option><option value="automation">Automation</option></select></label>
        <label className="field">Media<select value={kind} onChange={event => { setKind(event.target.value); setOffset(0) }}><option value="">All media</option><option value="tv">TV</option><option value="movie">Movie</option><option value="other">Other / no context</option></select></label>
        <label className="field">Created from<input type="date" value={createdAtFrom} onChange={event => { setCreatedAtFrom(event.target.value); setOffset(0) }}/></label>
        <label className="field">Created through<input type="date" value={createdAtTo} onChange={event => { setCreatedAtTo(event.target.value); setOffset(0) }}/></label>
         <label className="field">Status<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="">All statuses</option>{['queued', 'running', 'matched', 'no-match', 'needs-input', 'budget-exhausted', 'failed', 'interrupted', 'dry-run', 'submitted', 'partial', 'rejected', 'uncertain', 'not-attempted', 'deferred'].map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      {error && <div role="alert" className="notice notice-error"><span>{error}</span><button className="text-button activity-open" type="button" onClick={() => setRetryVersion(version => version + 1)}>Retry</button></div>}
      {loading ? <p role="status" className="ops-state-panel">Loading activity…</p> : error ? null : !items.length ? <div className="ops-state-panel ops-empty"><span className="ops-empty-mark"><SearchIcon size={19}/></span><h2>No matching activity</h2><p>Search attempts will appear here, including unsuccessful searches.</p></div> : <div className="ops-activity-list">{items.map(item => <article className="ops-activity-row" key={item.searchId}>
         <div className="ops-activity-top"><div className="activity-request"><SearchIcon size={15}/><strong className="prompt-preview">{item.prompt}</strong></div><span className={`ops-status ${item.status === 'matched' ? 'status-mint' : item.status === 'failed' ? 'status-amber' : 'status-quiet'}`}>{item.status}</span></div>
        <div className="activity-meta"><span><Clock3 size={14}/>{date(item.createdAt)}</span><span>{item.kind === 'tv' ? <Tv size={14}/> : item.kind === 'movie' ? <Film size={14}/> : <Database size={14}/>} {item.kind ?? 'Other media'}</span><span>{item.source === 'automation' ? <Radio size={14}/> : <SearchIcon size={14}/>} {item.source === 'automation' ? 'Automation' : 'Manual search'}</span>{item.counts && <span>{item.counts.candidates} candidates</span>}{item.submission && <span>Submission: {item.submission.outcome}</span>}</div>
        <button className="text-button activity-open" onClick={() => onOpenSearch(item.searchId)}>View search details <ArrowRight size={15}/></button>
      </article>)}</div>}
      <div className="ops-pagination"><span>{total === null ? '— searches · Count unavailable' : `${total.toLocaleString()} searches`} · kept up to {retention.days} days / {retention.maxEntries.toLocaleString()} entries</span><div><button className="button button-secondary" disabled={!offset || loading || !!error} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="button button-secondary" disabled={total === null || offset + 50 >= total || loading || !!error} onClick={() => setOffset(offset + 50)}>Next</button></div></div>
    </div></div><aside className="right-rail activity-rail" aria-label="Activity information">
      <div className="rail-card"><div className="rail-overline">SEARCH HISTORY</div><div className="activity-total"><strong>{total === null ? '—' : total.toLocaleString()}</strong><span>{total === null ? 'Count unavailable' : 'recorded searches'}</span></div><div className="rail-rule"/><p>History is kept for up to {retention.days} days or {retention.maxEntries.toLocaleString()} entries.</p></div>
      <div className="rail-card activity-key"><div className="rail-icon"><ShieldCheck size={17}/></div><strong>Private by design</strong><p>Search terms can reveal what you watch. This history stays on your Media Scout instance.</p></div>
       <div className="rail-card activity-key"><div className="rail-icon"><RefreshCw size={17}/></div><strong>Need the full result?</strong><p>Open any search to review its saved request, recommendations, and every durable release outcome—including partial and not attempted.</p></div>
    </aside></div>
  </>
}

export function AutomationPage({ settings, onOpenSearch }: { settings: Settings; onOpenSearch?: (id: string) => void; onToggle?: () => Promise<void> }) {
  const [data, setData] = useState<Automation | null>(null), [error, setError] = useState('')
  const [history, setHistory] = useState<ActivityItem[]>([]), [historyError, setHistoryError] = useState(''), [historyLoading, setHistoryLoading] = useState(true)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const viewVersion = useRef(0)
  async function refresh() {
    const version = ++viewVersion.current
    try { const response = await fetch('/api/v2/automation'); if (!response.ok) throw new Error('Saved Arr observations are unavailable.'); const result = await response.json(); if (version === viewVersion.current) { setData(result); setError('') } }
    catch (failure) { if (version === viewVersion.current) setError(failure instanceof Error ? failure.message : 'Automation status unavailable.') }
  }
  useEffect(() => {
    void refresh()
    fetch('/api/v2/activity?source=automation&limit=5').then(async response => { if (!response.ok) throw new Error(); const result = await response.json(); setHistory(result.items ?? []) }).catch(() => setHistoryError('Recent automation history is unavailable.')).finally(() => setHistoryLoading(false))
  }, [])
  async function poll() {
    setBusy(true); setNotice('')
    try {
      const response = await fetch('/api/v2/automation/poll', { method: 'POST' }), result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Poll could not run.')
      setNotice(result.reason === 'already-running' ? 'An Arr check is already in progress. Try refreshing again after it finishes.'
        : result.reason === 'runtime-closing' ? 'The server is stopping; Arr observations were not refreshed.'
        : 'Arr observations refreshed. Observation-only; no searches or downloads were started.')
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Poll failed.') }
    finally { setBusy(false) }
  }
  async function saveOffset(titleId: string, hoursEarly: number) {
    ++viewVersion.current
    setSaving(true)
    try {
      const response = await fetch(`/api/v2/automation/airing-offsets/${encodeURIComponent(titleId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hoursEarly }) })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(typeof body.error === 'string' ? body.error : 'Could not save the airing offset. Try again.')
      }
      const result: Automation = await response.json()
      setData(result)
    } finally { setSaving(false) }
  }
  const groups = new Map<string, { title: string; kind: 'tv' | 'movie'; items: AutomationItem[]; hoursEarly: number }>()
  for (const item of data?.items ?? []) {
    const group = groups.get(item.titleId) ?? { title: item.title, kind: item.kind, items: [], hoursEarly: 0 }
    group.items.push(item); groups.set(item.titleId, group)
  }
  for (const offset of data?.airingOffsets ?? []) {
    const group = groups.get(offset.titleId) ?? { title: offset.title, kind: 'tv' as const, items: [], hoursEarly: 0 }
    group.hoursEarly = offset.hoursEarly; groups.set(offset.titleId, group)
  }
  const orderedGroups = [...groups].sort(([, a], [, b]) => Number(b.items.some(item => item.eligible)) - Number(a.items.some(item => item.eligible)) || a.title.localeCompare(b.title))
  const configuredProviders = data?.providers.filter(provider => provider.error !== 'not-configured') ?? []
  const observationsComplete = configuredProviders.length > 0 && configuredProviders.every(provider => provider.known && !provider.unknownSeriesIds?.length && provider.unidentifiedQueueRows === 0)
  return <>
    <Heading title="Automation" intro="Monitor Arr libraries, review observations, and follow automated searches." eyebrow="LIBRARY MONITORING" icon={<Radio size={15}/>}/>
    <div className="automation-layout"><div className="ops-page">
      <div className="ops-page-toolbar"><p className="ops-scope-note"><ShieldCheck size={16}/><span>Monitoring: {data?.enabled ? 'on' : 'off'} · Automatic downloads: {data?.allowDownloads ? 'allowed' : 'not allowed'} · Dry-run: {data?.dryRun ?? settings.safety.dryRun ? 'on' : 'off'}{data?.running ? ' · Cycle running' : ''}{data?.executionBlocked ? ` · Execution paused: ${blockReason(data.executionBlockedReason)}` : ''}</span></p><div>
      <button className="button button-secondary" disabled={saving || busy} onClick={() => void refresh()}><RefreshCw size={15}/> Refresh saved view</button>{' '}<button className="button button-primary" disabled={busy || saving} onClick={() => void poll()}>{busy ? <RefreshCw className="spin" size={15}/> : <ActivityIcon size={15}/>} {busy ? 'Reading…' : 'Refresh Arr observations'}</button><p className="field-hint">Reads Arr observations only. Does not start searches or submit downloads.</p>
    </div></div>
    {error && <p role="alert" className="notice notice-error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
     {data && !data.enabled && <p className="field-hint">Item eligibility reflects Arr state. Nothing is scheduled while monitoring is off.</p>}
    {!data ? <p role="status" className="ops-state-panel">Loading saved observations…</p> : <>
      <section className="settings-card"><div className="section-heading"><div className="section-icon"><Database size={17}/></div><div className="section-title"><h2>Arr observations</h2><p>Refresh saved view reads local data. Refresh Arr observations explicitly reads upstream without searching or downloading.</p></div></div><div className="section-body provider-grid">{data.providers.map(provider => { const stale = Boolean(provider.observedAt && Date.now() - Date.parse(provider.observedAt) > 86_400_000); return <article className="provider-card" key={provider.provider}><div className={`provider-icon ${provider.known && !stale ? 'known' : 'unknown'}`}>{provider.provider.toLowerCase().includes('sonarr') ? <Tv size={17}/> : <Film size={17}/>}</div><div className="provider-main"><div className="provider-heading"><h3>{provider.provider}</h3><span className={`ops-status ${!provider.known || stale ? 'status-amber' : 'status-mint'}`}>{!provider.known ? 'Unknown' : stale ? 'Stale' : 'Current'}</span></div><p>Observed {date(provider.observedAt)}</p>{provider.error && <p className="provider-error">{provider.error}</p>}{!!provider.unknownSeriesIds?.length && <p>Some episode inventories are unknown ({provider.unknownSeriesIds.join(', ')}).</p>}<p>{provider.unidentifiedQueueRows} unidentified queue rows</p></div></article> })}</div></section>
      <section className="settings-card"><div className="section-heading"><div className="section-icon"><Film size={17}/></div><div className="section-title"><h2>Items to watch</h2><p>Arr observation list. Search and download execution follows the saved permissions above.</p></div></div>
        {!observationsComplete && orderedGroups.length > 0 && <p className="automation-incomplete field-hint">One or more sources could not be fully checked, so this list may be incomplete. Check Arr observations or Settings, then refresh observations.</p>}
        {!orderedGroups.length ? <div className="ops-state-panel ops-empty"><span className="ops-empty-mark"><CheckCircle2 size={19}/></span><h2>{observationsComplete ? 'No items to watch right now' : 'No items to show'}</h2><p>{observationsComplete ? 'No missing items or pending checks in the saved observations. Refresh observations later.' : 'One or more sources could not be fully checked, so this list may be incomplete. Check Arr observations or Settings, then poll again.'}</p></div> : orderedGroups.map(([id, group]) => {
          const ordered = [...group.items].sort((a, b) => Number(b.eligible) - Number(a.eligible) || (a.nextAttemptAt ?? a.eligibleAt ?? '9999').localeCompare(b.nextAttemptAt ?? b.eligibleAt ?? '9999'))
          const futureOnly = ordered.length > 0 && ordered.every(item => item.status === 'upcoming' || item.status === 'no-air-date')
          const next = ordered.find(item => item.eligible) ? 'Next eligible poll' : ordered.map(item => item.nextAttemptAt ?? (item.status === 'upcoming' ? item.eligibleAt : undefined)).filter((value): value is string => !!value).sort()[0]
          return <article className="automation-group" key={id}>
            <details open={!futureOnly}>
              <summary><span className="automation-group-title">{group.kind === 'tv' ? <Tv size={17}/> : <Film size={17}/>}<strong>{group.title}</strong></span><span className="field-hint">{ordered.length} {group.kind === 'tv' ? 'episode(s)' : 'movie'}{next ? ` · ${next === 'Next eligible poll' ? next : `Next: ${date(next)}`}` : futureOnly ? ' · Waiting for air date' : ''}</span></summary>
              {!ordered.length ? <p className="automation-incomplete field-hint">No missing episodes in the saved observations.</p> : <div className="ops-work-list">{ordered.map(item => <article className="ops-work-row" key={item.targetId}><div className="ops-media-icon">{item.kind === 'tv' ? <Tv size={16}/> : <Film size={16}/>}</div><div className="ops-work-main"><div className="ops-work-title"><h3>{item.kind === 'tv' ? `Season ${item.seasonNumber ?? '?'} · Episode ${item.episodeNumber ?? '?'}` : item.title}</h3><span className={`ops-status ${item.eligible ? 'status-mint' : 'status-amber'}`}>{automationStatusLabel[item.status] ?? item.status}</span></div><p className="ops-work-meta">Observed {date(item.observedAt)} · {item.eligible ? 'Eligible' : 'Not currently eligible'}</p>
                {item.kind === 'tv' && (item.status === 'upcoming' || group.hoursEarly > 0) && (item.metadataAirDate || item.eligibleAt) && <p className="ops-work-meta">
                  {item.metadataAirDate && `Provider air date: ${/^\d{4}-\d{2}-\d{2}$/.test(item.metadataAirDate) ? item.metadataAirDate : date(item.metadataAirDate)}`}
                  {item.eligibleAt && `${item.metadataAirDate ? ' · ' : ''}Scout eligibility: ${date(item.eligibleAt)}`}
                </p>}
                <p className="ops-work-meta">Next attempt: {item.nextAttemptAt ? date(item.nextAttemptAt) : item.eligible ? 'Next eligible poll' : item.status === 'upcoming' && item.eligibleAt ? `After ${date(item.eligibleAt)}` : item.status === 'no-air-date' ? 'Waiting for air date' : item.status === 'waiting-for-radarr' ? 'Waiting for Radarr' : item.status === 'downloading' ? 'In Arr queue' : 'Waiting for next check'}{item.lastAttemptAt && ` · Last attempt ${date(item.lastAttemptAt)}`}</p></div></article>)}</div>}
            </details>
            {group.kind === 'tv' && <AiringOffset title={group.title} saved={group.hoursEarly} disabled={saving || busy} onSave={hours => saveOffset(id, hours)}/>}
          </article>
        })}
      </section>
       <section className="settings-card"><div className="section-heading"><div className="section-icon"><ActivityIcon size={17}/></div><div className="section-title"><h2>Recent automated searches</h2><p>Open a saved search to inspect its plan and durable receipt.</p></div></div>{historyLoading ? <p role="status" className="ops-state-panel">Loading automated search history…</p> : historyError ? <p role="alert" className="ops-state-panel">{historyError}</p> : history.length ? <div className="ops-activity-list">{history.map(item => <article className="ops-activity-row" key={item.searchId}><div className="ops-activity-top"><strong className="prompt-preview">{item.prompt}</strong><span className="ops-status">{item.status}</span></div><button className="text-button activity-open" type="button" onClick={() => onOpenSearch?.(item.searchId)}>View search details</button></article>)}</div> : <p className="ops-state-panel">No automated searches recorded yet.</p>}</section>
    </>}
    </div><aside className="right-rail automation-rail" aria-label="Automation guidance">
      <div className="rail-card"><div className="rail-overline">EXECUTION STATE</div><div className="cycle-title"><strong>{data?.enabled ? 'Monitoring on' : 'Monitoring off'}</strong><span className={data?.executionBlocked ? 'state-off' : 'state-on'}><span className="tiny-dot"/>{data?.executionBlocked ? 'Paused' : 'Available'}</span></div><p>{data?.executionBlocked ? `Execution is paused: ${blockReason(data.executionBlockedReason)}.` : 'Monitoring and permitted execution are active.'} Automatic downloads {data?.allowDownloads ? 'allowed' : 'not allowed'}; dry-run {data?.dryRun ? 'on' : 'off'}.</p></div>
      <div className="rail-card activity-key"><div className="rail-icon"><Clock3 size={17}/></div><strong>Poll is explicit</strong><p>Refresh saved view only rereads local observations. Poll now contacts Sonarr and Radarr.</p></div>
    </aside></div>
  </>
}
function AiringOffset({ title, saved, disabled, onSave }: { title: string; saved: number; disabled: boolean; onSave(hours: number): Promise<void> }) {
  const [edited, setDraft] = useState<string | null>(null), [error, setError] = useState('')
  const draft = edited ?? String(saved)
  async function submit(hours: number) {
    if (!Number.isInteger(hours) || hours < 0 || hours > 168) { setError('Enter a whole number from 0 to 168 hours.'); return }
    setError('')
    try { await onSave(hours); setDraft(null) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the airing offset. Try again.') }
  }
  return <div className="airing-offset">
    <label className="field">Treat episodes as aired N hours early <span className="sr-only">for {title}</span>
      <input aria-label={`Treat episodes as aired hours early for ${title}`} type="number" min="0" max="168" step="1" value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)}/>
    </label>
    <div className="airing-offset-actions"><button type="button" className="button button-secondary" aria-label={`Save airing offset for ${title}`} disabled={disabled} onClick={() => void submit(draft.trim() === '' ? NaN : Number(draft))}>Save</button>
      <button type="button" className="button button-secondary" aria-label={`Reset airing offset for ${title}`} disabled={disabled || saved === 0} onClick={() => void submit(0)}>Reset</button></div>
    <p className="field-hint">Saved: {saved} hours early. Changes local eligibility only; no Arr refresh or search is started.</p>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
  </div>
}
function blockReason(reason?: string) { return reason === 'automation-disabled' ? 'monitoring is off' : reason === 'downloads-not-activated' ? 'automatic downloads are not allowed' : reason === 'dry-run' ? 'dry-run is on' : reason ?? 'execution is blocked' }
function Heading({ title, intro, eyebrow, icon }: { title: string; intro: string; eyebrow: string; icon: React.ReactNode }) { return <div className="page-heading ops-page-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/>{eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p className="page-intro">{intro}</p></div><div className="heading-stamp">{icon}<span>LOCAL CONTROL</span></div></div> }
