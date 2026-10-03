import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, AlertCircle, ArrowLeft, ArrowRight, Check, Clock3, Film, LoaderCircle,
  RefreshCw, RotateCcw, Search, ShieldAlert, ShieldCheck, Tv, X,
} from 'lucide-react'

const PAGE_SIZE = 50

type WorkAction = { allowed: boolean; reason?: string }
type WorkActions = { retry: WorkAction; reset: WorkAction }
type WorkRow = {
  workKey: string; title: string; mediaType: 'movie' | 'tv'; season?: number; status: string
  missingCount: number; nextSearchAt: string | null; lastSearchAt: string | null; holdReason: string | null
  observedAt: string | null; observationState: 'known' | 'unknown' | 'stale'
  queueObservationKnown?: boolean; queueObservedAt?: string | null
  coverage: { observed: number; reserved: number }; actions: WorkActions
}
type ReviewActionSet = WorkActions & { associate: WorkAction; release: WorkAction }
type ReviewRow = {
  id: number; workKey: string; title: string; reason: string; summary: string; createdAt: string
  resolvedAt: string | null; actions: ReviewActionSet
}
type ActivityRow = {
  id: number; source: 'cycle' | 'manual'; startedAt: string; finishedAt: string | null; query: string
  media: Array<{ workKey: string; title: string }>; resultCount: number | null
  outcome: 'running' | 'success' | 'error'; errorCode?: string
}
type WorkResponse = { items: WorkRow[]; total: number; counts: Record<string, number>; openReviewCount: number; generatedAt: string }
type ReviewResponse = { items: ReviewRow[]; total: number; generatedAt: string }
type ActivityResponse = { items: ActivityRow[]; total: number; generatedAt: string; retention: { days: number; maxEntries: number } }
type PreparedAction = {
  token: string; challenge: string; expiresAt: string; summary: string
  choices: Array<{ workKey: string; title: string }>
  mediaChoices?: Array<{ mediaIndex: number; title: string }>
  targetChoices?: Array<{ workKey: string; title: string; targetIndex: number }>
  queuePreview?: { title: string | null; status: string | null } | null
  targetNames?: string[]
  requiresClientInspection: boolean
}
type OperationsPageName = 'queue' | 'reviews' | 'activity'

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'Media Scout could not complete the request.'
}

async function readJson<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : 'Media Scout could not complete the request.'
    throw new Error(message)
  }
  if (!payload || typeof payload !== 'object') throw new Error('Media Scout returned an incomplete response. Try again.')
  return payload as T
}

function useFocusDialog(open: boolean, onClose: () => void) {
  const dialog = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = dialog.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
    first?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
      if (focusable.length === 0) return
      const firstItem = focusable[0]!
      const lastItem = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus() }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener.current?.focus()
    }
  }, [open])
  return dialog
}

function Dialog({ title, description, children, onClose, className = '' }: {
  title: string; description?: string; children: React.ReactNode; onClose: () => void; className?: string
}) {
  const ref = useFocusDialog(true, onClose)
  return <div className="ops-dialog-backdrop">
    <div className={`ops-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby="ops-dialog-title" aria-describedby={description ? 'ops-dialog-description' : undefined} ref={ref}>
      <div className="ops-dialog-head"><div><h2 id="ops-dialog-title">{title}</h2>{description && <p id="ops-dialog-description">{description}</p>}</div><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
      {children}
    </div>
  </div>
}

function useRemoteData<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    const hasData = data !== null
    setError(null)
    if (hasData) setRefreshing(true); else setLoading(true)
    try {
      const response = await fetch(url)
      const next = await readJson<T>(response)
      if (current === sequence.current) setData(next)
    } catch (cause) {
      if (current === sequence.current) setError(messageFrom(cause))
    } finally {
      if (current === sequence.current) { setLoading(false); setRefreshing(false) }
    }
  }, [url, data])
  useEffect(() => { void refresh(); return () => { sequence.current += 1 } }, [url]) // refresh reads the current page snapshot
  return { data, loading, refreshing, error, refresh }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function statusLabel(value: string): string {
  return value.replace(/-/gu, ' ').replace(/\b\w/gu, (char) => char.toUpperCase())
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return <div className="ops-pagination"><span>Page {page} of {pages} <span className="ops-muted">· {total.toLocaleString()} items</span></span><div>
    <button className="button button-secondary" type="button" onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}><ArrowLeft size={15} /> Previous</button>
    <button className="button button-secondary" type="button" onClick={() => onChange(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}>Next <ArrowRight size={15} /></button>
  </div></div>
}

function ErrorBanner({ message, onRetry, refreshing = false }: { message: string; onRetry: () => void; refreshing?: boolean }) {
  return <div className="ops-error" role="alert"><AlertCircle size={17} /><span>{message}</span><button className="text-button" type="button" onClick={onRetry} disabled={refreshing}>Try again</button></div>
}

function LoadingPanel({ label }: { label: string }) {
  return <div className="ops-state-panel" role="status"><LoaderCircle className="spin" size={21} />{label}</div>
}

function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return <div className="ops-state-panel ops-empty"><span className="ops-empty-mark"><Check size={20} /></span><h2>{title}</h2><p>{detail}</p></div>
}

export function OperationsPage({ page }: { page: OperationsPageName }) {
  if (page === 'queue') return <QueuePage />
  if (page === 'reviews') return <ReviewsPage />
  return <ActivityPage />
}

function QueuePage() {
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [searchText, setSearchText] = useState('')
  const [confirm, setConfirm] = useState<{ row: WorkRow; action: 'retry' | 'reset' } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const url = `/api/operations/work?status=${encodeURIComponent(status === 'all' ? '' : status)}&q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`
  const remote = useRemoteData<WorkResponse>(url)
  const counts = remote.data?.counts ?? {}
  const resetConfirmCopy = 'Clear Scout’s current retry and review state. Missing content may reappear on the next poll. Download reservations and history are retained.'

  const performAction = async () => {
    if (!confirm || actionBusy) return
    setActionBusy(true); setActionNotice(null)
    try {
      const response = await fetch('/api/operations/work/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workKey: confirm.row.workKey, action: confirm.action }) })
      const result = await readJson<{ ok: true; message: string }>(response)
      setConfirm(null); setActionNotice({ kind: 'success', text: result.message }); await remote.refresh()
    } catch (error) { setActionNotice({ kind: 'error', text: messageFrom(error) }) }
    finally { setActionBusy(false) }
  }

  const submitSearch = (event: React.FormEvent) => { event.preventDefault(); setOffset(0); setQuery(searchText.trim()) }
  const title = 'Queue'
  return <>
    <PageHeading eyebrow="SCOUT WORK" title={title} intro="A clear view of what Media Scout is watching, waiting on, and holding." icon={<Activity size={15} />} />
    <div className="ops-page">
      <div className="ops-page-toolbar"><div className="ops-scope-note"><ShieldCheck size={16} /><span>Scout work queue <strong>· not live download-client jobs</strong></span></div><button className="button button-secondary" type="button" onClick={() => void remote.refresh()} disabled={remote.refreshing}><RefreshCw className={remote.refreshing ? 'spin' : ''} size={15} /> Refresh</button></div>
      {remote.error && <ErrorBanner message={remote.error} onRetry={() => void remote.refresh()} refreshing={remote.refreshing} />}
      {actionNotice && <div className={`notice notice-${actionNotice.kind}`} role={actionNotice.kind === 'error' ? 'alert' : 'status'}><span>{actionNotice.text}</span></div>}
      {remote.data && <>
        <div className="ops-summary-grid" aria-label="Queue counts">
          <SummaryCard label="Work items" value={Object.values(counts).reduce((sum, count) => sum + count, 0)} tone="neutral" />
          <SummaryCard label="Needs attention" value={remote.data.openReviewCount} tone={remote.data.openReviewCount ? 'amber' : 'neutral'} href="#reviews" />
          <SummaryCard label="Ready" value={counts.ready ?? 0} tone="mint" />
          <SummaryCard label="Waiting" value={(counts.cooldown ?? 0) + (counts.backoff ?? 0) + (counts['waiting-release'] ?? 0)} tone="amber" />
        </div>
        <div className="ops-list-card">
          <div className="ops-list-head"><div><h2>Tracked media</h2><p>Search timing and holds come from Scout’s latest observation.</p></div><span className="ops-generated">Updated {formatDate(remote.data.generatedAt)}</span></div>
          <form className="ops-controls" onSubmit={submitSearch} role="search"><div className="ops-search"><Search size={16} /><input aria-label="Search queue" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Find a movie or series" /><button className="text-button" type="submit">Search</button></div>
            <label className="sr-only" htmlFor="queue-status">Filter by status</label><select id="queue-status" value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0) }}><option value="all">All statuses</option>{Object.keys(counts).map((key) => <option key={key} value={key}>{statusLabel(key)} · {counts[key]}</option>)}</select>
          </form>
          {remote.refreshing && <div className="ops-refreshing" role="status"><LoaderCircle className="spin" size={14} /> Updating this view…</div>}
          {remote.loading && !remote.data ? <LoadingPanel label="Loading Scout’s work queue…" /> : remote.data.items.length === 0 ? <EmptyPanel title={query || status !== 'all' ? 'No matching work' : 'Nothing in the queue yet'} detail={query || status !== 'all' ? 'Try another search or status filter.' : 'When missing media is found, Scout’s work will appear here.'} /> : <div className="ops-work-list">{remote.data.items.map((row) => <WorkCard key={row.workKey} row={row} onAction={(action) => setConfirm({ row, action })} />)}</div>}
          {remote.data.total > PAGE_SIZE && <Pagination offset={offset} total={remote.data.total} onChange={setOffset} />}
        </div>
      </>}
      {!remote.data && remote.error && <EmptyPanel title="Queue is unavailable" detail="The last view is not available yet. Check the service connection and try again." />}
    </div>
    {confirm && <Dialog title={confirm.action === 'reset' ? 'Reset tracking?' : 'Make this work due?'} description={confirm.row.title} onClose={() => !actionBusy && setConfirm(null)}>
      <div className="ops-dialog-body"><div className={confirm.action === 'reset' ? 'ops-warning-box' : 'ops-info-box'}>{confirm.action === 'reset' ? <><ShieldAlert size={18} /><p>{resetConfirmCopy}</p></> : <><Clock3 size={18} /><p>Mark this item due for the next eligible pass. This does not start a search now.</p></>}</div>
        {actionNotice?.kind === 'error' && <div className="ops-inline-error" role="alert">{actionNotice.text}</div>}
        <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setConfirm(null)} disabled={actionBusy}>Cancel</button><button className={`button ${confirm.action === 'reset' ? 'button-danger' : 'button-primary'}`} type="button" onClick={() => void performAction()} disabled={actionBusy}>{actionBusy ? <LoaderCircle className="spin" size={16} /> : confirm.action === 'reset' ? <RotateCcw size={16} /> : <Clock3 size={16} />}{actionBusy ? 'Working…' : confirm.action === 'reset' ? 'Reset tracking' : 'Mark due'}</button></div>
      </div>
    </Dialog>}
  </>
}

function WorkCard({ row, onAction }: { row: WorkRow; onAction: (action: 'retry' | 'reset') => void }) {
  return <article className="ops-work-row">
    <div className="ops-media-icon">{row.mediaType === 'movie' ? <Film size={18} /> : <Tv size={18} />}</div>
    <div className="ops-work-main"><div className="ops-work-title"><h3>{row.title}</h3><StatusPill value={row.status} /></div><div className="ops-work-meta"><span>{row.mediaType === 'movie' ? 'Movie' : `TV${row.season === undefined ? '' : ` · Season ${row.season}`}`}</span><span>{row.missingCount} missing</span><span>Coverage: {row.coverage.observed} observed · {row.coverage.reserved} reserved</span></div>
      <div className="ops-work-meta"><span>Next search: {formatDate(row.nextSearchAt)}</span><span>Last search: {formatDate(row.lastSearchAt)}</span></div>
      <ObservationPill state={row.observationState} observedAt={row.observedAt} />
      {row.queueObservationKnown !== undefined && <QueueObservation known={row.queueObservationKnown} observedAt={row.queueObservedAt ?? null} />}
      {row.holdReason && <p className="ops-hold-reason"><ShieldAlert size={14} />{statusLabel(row.holdReason)}</p>}
    </div>
    <div className="ops-row-actions"><ActionButton action="retry" available={row.actions.retry} onClick={() => onAction('retry')} /><ActionButton action="reset" available={row.actions.reset} onClick={() => onAction('reset')} /></div>
  </article>
}

function ActionButton({ action, available, onClick }: { action: 'retry' | 'reset'; available: WorkAction; onClick: () => void }) {
  const label = action === 'retry' ? 'Retry' : 'Reset tracking'
  return <span className="ops-action-wrap"><button className="button button-secondary" type="button" disabled={!available.allowed} onClick={onClick} title={!available.allowed ? available.reason : undefined}>{action === 'retry' ? <Clock3 size={14} /> : <RotateCcw size={14} />}{label}</button>{!available.allowed && available.reason && <span className="ops-action-reason">{available.reason}</span>}</span>
}

function ObservationPill({ state, observedAt }: { state: WorkRow['observationState']; observedAt: string | null }) {
  const labels = { known: 'Current observation', stale: 'Observation is stale', unknown: 'Observation unknown' }
  return <span className={`ops-observation obs-${state}`}><span className="tiny-dot" />{labels[state]}{observedAt && <span> · {formatDate(observedAt)}</span>}</span>
}

function QueueObservation({ known, observedAt }: { known: boolean; observedAt: string | null }) {
  return <span className={`ops-observation ${known ? 'obs-known' : 'obs-unknown'}`}><span className="tiny-dot" />{known ? 'Queue observed' : 'Queue observation unknown'}{observedAt && <span> · {formatDate(observedAt)}</span>}</span>
}

function StatusPill({ value }: { value: string }) {
  const tone = ['manual', 'backoff', 'waiting-release'].includes(value) ? 'amber' : value === 'ready' || value === 'searching' ? 'mint' : value === 'fulfilled' ? 'quiet' : 'neutral'
  return <span className={`ops-status status-${tone}`}>{statusLabel(value)}</span>
}

function SummaryCard({ label, value, tone, href }: { label: string; value: number; tone: string; href?: string }) {
  const inner = <><span>{label}</span><strong>{value.toLocaleString()}</strong></>
  return href ? <a className={`ops-summary-card summary-${tone}`} href={href}>{inner}</a> : <div className={`ops-summary-card summary-${tone}`}>{inner}</div>
}

function PageHeading({ eyebrow, title, intro, icon }: { eyebrow: string; title: string; intro: string; icon: React.ReactNode }) {
  return <div className="page-heading ops-page-heading"><div><div className="eyebrow"><span className="eyebrow-mark" />{eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p className="page-intro">{intro}</p></div><div className="heading-stamp">{icon}<span>LOCAL CONTROL</span></div></div>
}

function ReviewsPage() {
  const [resolved, setResolved] = useState(false)
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const [selected, setSelected] = useState<ReviewRow | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const url = `/api/operations/reviews?resolved=${resolved}&q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`
  const remote = useRemoteData<ReviewResponse>(url)
  const search = (event: React.FormEvent) => { event.preventDefault(); setOffset(0); setQuery(searchText.trim()) }
  return <>
    <PageHeading eyebrow="NEEDS A HUMAN" title="Manual review" intro="Review held work and choose only the actions Scout says are available." icon={<ShieldAlert size={15} />} />
    <div className="ops-page">
      <div className="ops-page-toolbar"><div className="ops-scope-note"><ShieldAlert size={16} /><span>Review does not mean complete. No generic dismiss action is available.</span></div><button className="button button-secondary" type="button" onClick={() => void remote.refresh()} disabled={remote.refreshing}><RefreshCw className={remote.refreshing ? 'spin' : ''} size={15} /> Refresh</button></div>
      {remote.error && <ErrorBanner message={remote.error} onRetry={() => void remote.refresh()} refreshing={remote.refreshing} />}
      {notice && <div className="notice notice-success" role="status">{notice}</div>}
      <div className="ops-list-card">
        <div className="ops-list-head"><div><h2>{resolved ? 'Resolved reviews' : 'Open reviews'}</h2><p>{resolved ? 'Past review decisions remain visible.' : 'Only open reviews can offer actions.'}</p></div>{remote.data && <span className="ops-generated">Updated {formatDate(remote.data.generatedAt)}</span>}</div>
        <div className="ops-controls"><div className="ops-filter-tabs" role="group" aria-label="Review status"><button type="button" aria-pressed={!resolved} className={!resolved ? 'selected' : ''} onClick={() => { setResolved(false); setOffset(0) }}>Open</button><button type="button" aria-pressed={resolved} className={resolved ? 'selected' : ''} onClick={() => { setResolved(true); setOffset(0) }}>Resolved</button></div>
          <form className="ops-search" role="search" onSubmit={search}><Search size={16} /><input aria-label="Search reviews" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Find a movie or review reason" /><button className="text-button" type="submit">Search</button></form></div>
        {remote.refreshing && <div className="ops-refreshing" role="status"><LoaderCircle className="spin" size={14} /> Updating this view…</div>}
        {remote.loading && !remote.data ? <LoadingPanel label="Loading reviews…" /> : remote.data && remote.data.items.length === 0 ? <EmptyPanel title={query ? 'No matching reviews' : resolved ? 'No resolved reviews yet' : 'No open reviews'} detail={query ? 'Try another search.' : resolved ? 'Resolved reviews will remain available here.' : 'If Scout needs a decision, the review will appear here.'} /> : remote.data && <div className="ops-review-list">{remote.data.items.map((row) => <article className="ops-review-row" key={row.id}>
          <div className="ops-review-marker"><ShieldAlert size={17} /></div><div className="ops-review-content"><div className="ops-work-title"><h3>{row.title}</h3><span className="ops-status status-amber">{statusLabel(row.reason)}</span></div><p>{row.summary}</p><div className="ops-work-meta"><span>Created {formatDate(row.createdAt)}</span>{row.resolvedAt && <span>Resolved {formatDate(row.resolvedAt)}</span>}</div></div>
          <button className="button button-secondary" type="button" onClick={() => { setSelected(row); setActionError(null) }}>{resolved ? 'View details' : 'Review details'} <ArrowRight size={15} /></button>
        </article>)}</div>}
        {remote.data && remote.data.total > PAGE_SIZE && <Pagination offset={offset} total={remote.data.total} onChange={setOffset} />}
      </div>
      {remote.loading && !remote.data && null}{!remote.data && remote.error && <EmptyPanel title="Reviews are unavailable" detail="Check the service connection and try again." />}
    </div>
    {selected && <ReviewDialog row={selected} onClose={() => setSelected(null)} onSuccess={(text) => { setSelected(null); setNotice(text); void remote.refresh() }} actionError={actionError} setActionError={setActionError} />}
  </>
}

function ReviewDialog({ row, onClose, onSuccess, actionError, setActionError }: {
  row: ReviewRow; onClose: () => void; onSuccess: (message: string) => void
  actionError: string | null; setActionError: (message: string | null) => void
}) {
  const [prepared, setPrepared] = useState<PreparedAction | null>(null)
  const [action, setAction] = useState<'associate' | 'release' | null>(null)
  const [chosenMediaIndex, setChosenMediaIndex] = useState<number | null>(null)
  const [chosenTargetIndices, setChosenTargetIndices] = useState<number[]>([])
  const [challenge, setChallenge] = useState('')
  const [note, setNote] = useState('')
  const [inspectionConfirmed, setInspectionConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [workActionConfirm, setWorkActionConfirm] = useState<'retry' | 'reset' | null>(null)
  const dialog = useFocusDialog(true, () => workActionConfirm ? setWorkActionConfirm(null) : onClose())
  const expired = prepared ? Date.parse(prepared.expiresAt) <= Date.now() : false
  const canCommit = Boolean(prepared && action && !expired && challenge === prepared.challenge && note.trim().length >= 3 && note.trim().length <= 500 && (!prepared.requiresClientInspection || inspectionConfirmed) && (action !== 'associate' || (chosenMediaIndex !== null && chosenTargetIndices.length > 0)))

  const prepare = async (nextAction: 'associate' | 'release') => {
    setAction(nextAction); setPrepared(null); setActionError(null); setChallenge(''); setNote(''); setInspectionConfirmed(false); setChosenMediaIndex(null); setChosenTargetIndices([]); setBusy(true)
    try {
      const response = await fetch(`/api/operations/reviews/${row.id}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: nextAction }) })
      const result = await readJson<PreparedAction>(response)
      setPrepared(result)
    } catch (error) { setActionError(messageFrom(error)) }
    finally { setBusy(false) }
  }

  const commit = async () => {
    if (!prepared || !action || busy) return
    if (Date.parse(prepared.expiresAt) <= Date.now()) { setActionError('Prepared action expired. Prepare fresh evidence before continuing.'); return }
    if (!canCommit) return
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/operations/reviews/${row.id}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token: prepared.token, challenge, note: note.trim(), ...(action === 'associate' ? { workKey: row.workKey, mediaIndex: chosenMediaIndex, targetIndices: chosenTargetIndices } : {}), ...(prepared.requiresClientInspection ? { clientInspectionConfirmed: inspectionConfirmed } : {}) }) })
      const result = await readJson<{ ok: true; message: string }>(response)
      onSuccess(result.message)
    } catch (error) { setActionError(messageFrom(error)) }
    finally { setBusy(false) }
  }

  return <div className="ops-dialog-backdrop">
    <div className="ops-dialog ops-review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title" ref={dialog}>
      <div className="ops-dialog-head"><div><div className="eyebrow"><span className="eyebrow-mark" />REVIEW #{row.id}</div><h2 id="review-dialog-title">{row.title}</h2><p>{row.summary}</p></div><button className="icon-button" type="button" aria-label="Close review details" onClick={onClose}><X size={18} /></button></div>
      <div className="ops-dialog-body ops-review-body">
        <div className="ops-review-facts"><span><strong>Reason</strong>{statusLabel(row.reason)}</span><span><strong>Created</strong>{formatDate(row.createdAt)}</span></div>
        {actionError && <div className="ops-inline-error" role="alert">{actionError}</div>}
        {!prepared && <>
          <div className="ops-scope-note"><ShieldCheck size={17} /><span>Actions depend on fresh evidence. Scout supplies which operations are currently available.</span></div>
          {!row.resolvedAt && <div className="ops-review-work-actions"><div><strong>Manage this work item</strong><span>Retry schedules its next eligible pass. Reset clears only the current retry/review session.</span></div><div className="ops-row-actions"><ActionButton action="retry" available={row.actions.retry} onClick={() => setWorkActionConfirm('retry')} /><ActionButton action="reset" available={row.actions.reset} onClick={() => setWorkActionConfirm('reset')} /></div></div>}
          {!row.resolvedAt && <div className="ops-recovery-actions">
            <RecoveryButton label="Associate queue" action={row.actions.associate} onClick={() => void prepare('associate')} busy={busy} />
            <RecoveryButton label="Release reservation" action={row.actions.release} onClick={() => void prepare('release')} busy={busy} />
          </div>}
        </>}
          {prepared && action && <>
          <div className="ops-prepared-summary"><span className="ops-step-number">PREPARED · {action === 'associate' ? 'ASSOCIATE QUEUE' : 'RELEASE RESERVATION'}</span><p>{prepared.summary}</p><span className={`ops-expiry ${expired ? 'is-expired' : ''}`}><Clock3 size={14} />{expired ? 'Preview expired · prepare again' : `Expires ${formatDate(prepared.expiresAt)}`}</span></div>
          {(prepared.queuePreview !== undefined || prepared.targetNames !== undefined) && <PreparedEvidence prepared={prepared} />}
          {action === 'associate' && <>
            <fieldset className="ops-choice-fieldset"><legend>1. Choose the media item</legend>{prepared.mediaChoices?.length ? prepared.mediaChoices.map((choice) => <label key={choice.mediaIndex} className="ops-choice"><input type="radio" name="review-media-choice" value={choice.mediaIndex} checked={chosenMediaIndex === choice.mediaIndex} onChange={() => setChosenMediaIndex(choice.mediaIndex)} /><span><strong>{choice.title}</strong><small>Media choice {choice.mediaIndex + 1}</small></span></label>) : <p className="ops-muted">No media choices were supplied. This action cannot be committed.</p>}</fieldset>
            <fieldset className="ops-choice-fieldset"><legend>2. Select one or more targets</legend>{prepared.targetChoices?.length ? prepared.targetChoices.map((choice) => <label key={choice.targetIndex} className="ops-choice"><input type="checkbox" value={choice.targetIndex} checked={chosenTargetIndices.includes(choice.targetIndex)} onChange={(event) => setChosenTargetIndices((current) => event.target.checked ? [...new Set([...current, choice.targetIndex])] : current.filter((index) => index !== choice.targetIndex))} /><span><strong>{choice.title}</strong><small>Target {choice.targetIndex + 1}</small></span></label>) : <p className="ops-muted">No target choices were supplied. This action cannot be committed.</p>}</fieldset>
          </>}
          {prepared.requiresClientInspection && <label className="ops-inspection-check"><input type="checkbox" checked={inspectionConfirmed} onChange={(event) => setInspectionConfirmed(event.target.checked)} /><span><strong>I inspected the original submission routing and all relevant download clients. No matching download is active.</strong><small>Check every client the original submission could have routed to. An empty Sonarr/Radarr queue alone is not enough to confirm this.</small></span></label>}
          {expired && <button className="button button-secondary" type="button" onClick={() => void prepare(action)} disabled={busy}>Prepare a fresh preview</button>}
          <div className="ops-challenge"><label htmlFor="recovery-challenge">Type the exact approval text</label><code>{prepared.challenge}</code><input id="recovery-challenge" autoComplete="off" value={challenge} onChange={(event) => setChallenge(event.target.value)} /></div>
          <div className="ops-note-field"><label htmlFor="recovery-note">Audit note <span>3–500 characters</span></label><textarea id="recovery-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why is this action appropriate? Do not include credentials or URLs." /><span className="ops-char-count">{note.length} / 500</span></div>
          {actionError && /expir|stale|changed|fresh|prepare again|current evidence/iu.test(actionError) && <button className="button button-secondary" type="button" onClick={() => void prepare(action)} disabled={busy}>Prepare a fresh preview</button>}
          <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={() => { setPrepared(null); setAction(null); setActionError(null) }} disabled={busy}>Back</button><button className="button button-primary" type="button" onClick={() => void commit()} disabled={!canCommit || busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? 'Submitting…' : 'Confirm action'}</button></div>
        </>}
        {busy && !prepared && <div className="ops-preparing" role="status"><LoaderCircle className="spin" size={17} /> Preparing fresh evidence…</div>}
        {!prepared && <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={onClose}>Close</button></div>}
      </div>
    </div>
    {workActionConfirm && <ReviewWorkActionDialog row={row} action={workActionConfirm} onClose={() => setWorkActionConfirm(null)} onSuccess={onSuccess} />}
  </div>
}

function PreparedEvidence({ prepared }: { prepared: PreparedAction }) {
  return <section className="ops-evidence-panel" aria-label="Fresh evidence for this action">
    <h3>Fresh evidence to review</h3>
    {prepared.queuePreview !== undefined && <div className="ops-evidence-queue"><strong>Queue preview</strong>{prepared.queuePreview ? <><span>{prepared.queuePreview.title ?? 'Queue item title unavailable'}</span><span className="ops-evidence-status">Status: {prepared.queuePreview.status ? statusLabel(prepared.queuePreview.status) : 'unknown'}</span></> : <p>No matching *arr queue item was linked in this preview. This does not prove that no download is active.</p>}</div>}
    {prepared.targetNames !== undefined && <div className="ops-evidence-targets"><strong>Affected targets</strong>{prepared.targetNames.length ? <ul>{prepared.targetNames.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}</ul> : <p>No target names were supplied in this preview.</p>}</div>}
  </section>
}

function ReviewWorkActionDialog({ row, action, onClose, onSuccess }: {
  row: ReviewRow; action: 'retry' | 'reset'; onClose: () => void; onSuccess: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resetCopy = 'Clear Scout’s current retry and review state. Missing content may reappear on the next poll. Download reservations and history are retained.'
  const submit = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/operations/work/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workKey: row.workKey, action }) })
      const result = await readJson<{ ok: true; message: string }>(response)
      onSuccess(result.message)
    } catch (cause) { setError(messageFrom(cause)) }
    finally { setBusy(false) }
  }
  return <Dialog title={action === 'retry' ? 'Make this work due?' : 'Reset tracking?'} description={row.title} onClose={() => !busy && onClose()} className="ops-confirm-dialog">
    <div className="ops-dialog-body"><div className={action === 'reset' ? 'ops-warning-box' : 'ops-info-box'}>{action === 'reset' ? <><ShieldAlert size={18} /><p>{resetCopy}</p></> : <><Clock3 size={18} /><p>Mark this item due for the next eligible pass. This does not start a search now.</p></>}</div>
      {error && <div className="ops-inline-error" role="alert">{error}</div>}
      <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className={`button ${action === 'reset' ? 'button-danger' : 'button-primary'}`} type="button" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : action === 'reset' ? <RotateCcw size={16} /> : <Clock3 size={16} />}{busy ? 'Working…' : action === 'reset' ? 'Reset tracking' : 'Mark due'}</button></div>
    </div>
  </Dialog>
}

function RecoveryButton({ label, action, onClick, busy }: { label: string; action: WorkAction; onClick: () => void; busy: boolean }) {
  return <span className="ops-recovery-wrap"><button className="button button-secondary" type="button" onClick={onClick} disabled={!action.allowed || busy} title={!action.allowed ? action.reason : undefined}><ShieldCheck size={15} />{label}</button>{!action.allowed && action.reason && <small>{action.reason}</small>}</span>
}

function ActivityPage() {
  const [outcome, setOutcome] = useState('')
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const url = `/api/operations/activity?q=${encodeURIComponent(query)}&outcome=${encodeURIComponent(outcome)}&limit=${PAGE_SIZE}&offset=${offset}`
  const remote = useRemoteData<ActivityResponse>(url)
  const search = (event: React.FormEvent) => { event.preventDefault(); setOffset(0); setQuery(searchText.trim()) }
  return <>
    <PageHeading eyebrow="SEARCH RECORD" title="Search history" intro="See the queries Scout sent, which media they were for, and how each search ended." icon={<Search size={15} />} />
    <div className="ops-page">
      <div className="ops-page-toolbar"><div className="ops-scope-note"><Activity size={16} /><span>Purpose-built search history <strong>· not raw server logs</strong></span></div><button className="button button-secondary" type="button" onClick={() => void remote.refresh()} disabled={remote.refreshing}><RefreshCw className={remote.refreshing ? 'spin' : ''} size={15} /> Refresh</button></div>
      {remote.error && <ErrorBanner message={remote.error} onRetry={() => void remote.refresh()} refreshing={remote.refreshing} />}
      <div className="ops-list-card">
        <div className="ops-list-head"><div><h2>Searches</h2><p>Search terms may reveal what you are looking for.</p></div>{remote.data && <span className="ops-retention">Retained {remote.data.retention.days} days · up to {remote.data.retention.maxEntries.toLocaleString()} entries</span>}</div>
        <div className="ops-controls"><form className="ops-search" role="search" onSubmit={search}><Search size={16} /><input aria-label="Search history" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search query or media title" /><button className="text-button" type="submit">Search</button></form>
          <label className="sr-only" htmlFor="activity-outcome">Filter by outcome</label><select id="activity-outcome" value={outcome} onChange={(event) => { setOutcome(event.target.value); setOffset(0) }}><option value="">All outcomes</option><option value="running">Running</option><option value="success">Succeeded</option><option value="error">Failed</option></select></div>
        {remote.refreshing && <div className="ops-refreshing" role="status"><LoaderCircle className="spin" size={14} /> Updating this view…</div>}
        {remote.loading && !remote.data ? <LoadingPanel label="Loading search history…" /> : remote.data && remote.data.items.length === 0 ? <EmptyPanel title={query || outcome ? 'No matching searches' : 'No searches recorded yet'} detail={query || outcome ? 'Try another query or outcome filter.' : 'Searches will appear here after Scout makes its next search.'} /> : remote.data && <div className="ops-activity-list">{remote.data.items.map((row) => <ActivityCard key={row.id} row={row} />)}</div>}
        {remote.data && remote.data.total > PAGE_SIZE && <Pagination offset={offset} total={remote.data.total} onChange={setOffset} />}
      </div>
      {!remote.data && remote.error && <EmptyPanel title="Search history is unavailable" detail="Check the service connection and try again." />}
    </div>
  </>
}

function ActivityCard({ row }: { row: ActivityRow }) {
  const tone = row.outcome === 'success' ? 'mint' : row.outcome === 'error' ? 'amber' : 'neutral'
  return <article className="ops-activity-row"><div className="ops-activity-top"><div className="ops-activity-date"><Clock3 size={14} /><span>{formatDate(row.startedAt)}</span><span className="ops-source">{row.source === 'cycle' ? 'Scheduled cycle' : 'Manual search'}</span></div><span className={`ops-status status-${tone}`}>{statusLabel(row.outcome)}</span></div>
    <code className="ops-query">{row.query}</code>
    <div className="ops-activity-bottom"><div className="ops-media-tags">{row.media.length ? row.media.map((media) => <span className="ops-media-tag" key={media.workKey}>{media.title}</span>) : <span className="ops-muted">{row.source === 'manual' ? 'Manual search · target not linked' : 'Media target not included'}</span>}</div><div className="ops-result-meta">{row.resultCount === null ? 'Results unavailable' : `${row.resultCount.toLocaleString()} results`}{row.errorCode && <span className="ops-error-code"> · {row.errorCode}</span>}{row.finishedAt && <span> · Finished {formatDate(row.finishedAt)}</span>}</div></div>
  </article>
}
