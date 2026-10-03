import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  Activity, AlertCircle, ArrowLeft, ArrowRight, Check, Clock3, Film, LoaderCircle,
  RefreshCw, RotateCcw, Search, ShieldAlert, ShieldCheck, Tv, X,
} from 'lucide-react'

const PAGE_SIZE = 50
const WORK_STATUSES = ['ready', 'waiting-release', 'searching', 'cooldown', 'backoff', 'manual', 'fulfilled', 'inactive'] as const

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
type OperationsScope = 'active' | 'all'
type ReviewRow = {
  id: number; workKey: string; title: string; reason: string; summary: string; createdAt: string
  resolvedAt: string | null; mediaType: 'movie' | 'tv' | 'unknown'; season?: number; actions: ReviewActionSet
}
type ActivityRow = {
  id: number; source: 'cycle' | 'manual'; startedAt: string; finishedAt: string | null; query: string
  media: Array<{ workKey: string; title: string }>; resultCount: number | null
  outcome: 'running' | 'success' | 'error'; errorCode?: string
}
type WorkResponse = {
  items: WorkRow[]; total: number; counts: Record<string, number>; openReviewCount: number; generatedAt: string
  scope: OperationsScope; countScope: OperationsScope; freshness: { staleAfterHours: number }
}
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

const dialogStack: HTMLElement[] = []

function syncDialogStack() {
  const top = dialogStack[dialogStack.length - 1]
  for (const element of dialogStack) {
    if (element === top) {
      element.removeAttribute('inert')
      element.removeAttribute('aria-hidden')
    } else {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }
  }
}

function useFocusDialog(open: boolean, onClose: () => void) {
  const dialog = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const element = dialog.current
    if (!element) return
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogStack.push(element)
    syncDialogStack()
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((candidate) => !candidate.closest('[inert]') && !candidate.matches(':disabled'))
    const first = focusable()[0]
    first?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== element) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) { event.preventDefault(); element.focus(); return }
      const firstItem = items[0]!
      const lastItem = items[items.length - 1]!
      if (!element.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? lastItem : firstItem).focus() }
      else if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus() }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = dialogStack.lastIndexOf(element)
      if (index >= 0) dialogStack.splice(index, 1)
      syncDialogStack()
      if (opener.current?.isConnected) opener.current.focus()
    }
  }, [open])
  return dialog
}

function Dialog({ title, description, children, onClose, className = '', closeDisabled = false }: {
  title: string; description?: string; children: React.ReactNode; onClose: () => void; className?: string; closeDisabled?: boolean
}) {
  const ref = useFocusDialog(true, onClose)
  return <div className="ops-dialog-backdrop">
    <div className={`ops-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby="ops-dialog-title" aria-describedby={description ? 'ops-dialog-description' : undefined} ref={ref}>
      <div className="ops-dialog-head"><div><h2 id="ops-dialog-title">{title}</h2>{description && <p id="ops-dialog-description">{description}</p>}</div><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose} disabled={closeDisabled}><X size={18} /></button></div>
      {children}
    </div>
  </div>
}

function useRemoteData<T>(url: string) {
  const [snapshot, setSnapshot] = useState<{ url: string; value: T } | null>(null)
  const snapshotRef = useRef<{ url: string; value: T } | null>(null)
  const [errorState, setErrorState] = useState<{ url: string; message: string } | null>(null)
  const [refreshingUrl, setRefreshingUrl] = useState<string | null>(null)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const currentUrl = useRef(url)
  currentUrl.current = url
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    const requestUrl = url
    setErrorState(null)
    setRefreshingUrl(snapshotRef.current?.url === requestUrl ? requestUrl : null)
    try {
      const response = await fetch(requestUrl, { signal: requestController.signal })
      const next = await readJson<T>(response)
      if (current === sequence.current && currentUrl.current === requestUrl) {
        const nextSnapshot = { url: requestUrl, value: next }
        snapshotRef.current = nextSnapshot
        setSnapshot(nextSnapshot)
        setErrorState(null)
      }
    } catch (cause) {
      if (current === sequence.current && currentUrl.current === requestUrl && !requestController.signal.aborted) setErrorState({ url: requestUrl, message: messageFrom(cause) })
    } finally {
      if (current === sequence.current) { controller.current = null; setRefreshingUrl(null) }
    }
  }, [url])
  useEffect(() => {
    void refresh()
    return () => {
      sequence.current += 1
      controller.current?.abort()
      controller.current = null
    }
  }, [refresh])
  const data = snapshot?.url === url ? snapshot.value : null
  const error = errorState?.url === url ? errorState.message : null
  return { data, previousData: snapshot?.value ?? null, loading: data === null && error === null, refreshing: data !== null && refreshingUrl === url, error, refresh }
}

function lastPageOffset(total: number): number {
  return total <= 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE
}

function isTerminalStatus(status: string): boolean {
  return status === 'fulfilled' || status === 'inactive'
}

function reviewMediaLabel(row: Pick<ReviewRow, 'mediaType' | 'season'>): string {
  if (row.mediaType === 'movie') return 'Movie'
  if (row.mediaType === 'tv') return row.season === undefined ? 'TV' : `TV · Season ${row.season}`
  return 'Media details unavailable'
}

function formatDate(value: string | null | undefined, markClockAhead = false): string {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Time unavailable'
  const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  return markClockAhead && date.getTime() > Date.now() + 60_000 ? `${formatted} (clock ahead)` : formatted
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    'waiting-release': 'Waiting for queue', cooldown: 'Cooling down', backoff: 'Retry delayed', searching: 'Searching',
    ready: 'Ready', manual: 'Manual review', fulfilled: 'Complete', inactive: 'Inactive',
  }
  const fallback = value.replace(/-/gu, ' ')
  return labels[value] ?? fallback.charAt(0).toLocaleUpperCase() + fallback.slice(1)
}

function holdReasonLabel(value: string): string {
  const labels: Record<string, string> = {
    'queue-unknown': 'Queue status is unknown',
    'queue-active': 'A matching download is active',
    'queue-ambiguous': 'Queue coverage needs review',
    'active-intent': 'A download reservation is still active',
    'waiting-release': 'Waiting for the submitted release to appear in the queue',
    'manual-review': 'A human review is needed',
    'content-identity-changed': 'Library details changed; review is needed',
    'queue-review': 'Queue coverage needs review',
    'library-unknown': 'Library status is unknown',
    blocked: 'Held for safety',
  }
  return labels[value] ?? 'Held for safety'
}

function actionReasonLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    'work-not-found': 'This work item is no longer available.',
    'work-held': 'This item is held for a separate safety reason.',
    'queue-observation-unknown': 'Actions need a known library and queue observation.',
    'queue-observation-stale': 'Actions need a current observation. Scout marks observations stale after 24 hours.',
    'review-not-eligible': 'The open review does not allow this action.',
    'work-not-retryable': 'Retry is not available for this status.',
    'work-not-resettable': 'Reset is not available for this status.',
    'work-claimed': 'Another Scout task is working on this item.',
    'reservation-open': 'A download reservation is still active.',
    'queue-coverage-unknown': 'Queue coverage could not be verified.',
    'queue-coverage-held': 'Queue coverage is still holding this item.',
    'rate-limited': 'Wait until the provider retry window ends.',
    'operator-actions-disabled': 'Enable operator actions in Settings before using Retry or Reset tracking.',
  }
  return value ? labels[value] ?? 'This action is currently unavailable.' : 'This action is currently unavailable.'
}

function isSameTime(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

function formatObservationTime(value: string | null | undefined): string | null {
  if (!value) return null
  return formatDate(value, true)
}

function activityFinishLabel(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 'Finish time unavailable'
  if (finish < start) return `Finish time precedes start · ${formatDate(finishedAt)}`
  const elapsedSeconds = Math.round((finish - start) / 1000)
  if (elapsedSeconds < 60) return `Finished in ${elapsedSeconds} ${elapsedSeconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  if (minutes < 60) return `Finished in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}${seconds ? ` ${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : ''}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `Finished in ${hours} ${hours === 1 ? 'hour' : 'hours'}${remainingMinutes ? ` ${remainingMinutes} ${remainingMinutes === 1 ? 'minute' : 'minutes'}` : ''}`
  return `Finished ${formatDate(finishedAt)}`
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.ceil(total / PAGE_SIZE)
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
  const [scope, setScope] = useState<OperationsScope>('active')
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [searchText, setSearchText] = useState('')
  const [confirm, setConfirm] = useState<{ row: WorkRow; action: 'retry' | 'reset' } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const url = `/api/operations/work?scope=${scope}&status=${encodeURIComponent(status === 'all' ? '' : status)}&q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${offset}`
  const remote = useRemoteData<WorkResponse>(url)
  const counts = remote.data?.counts ?? {}
  const controlData = remote.data ?? remote.previousData
  const controlCounts = controlData?.counts ?? {}
  const statusOptions = Object.keys(controlCounts).length ? Object.keys(controlCounts) : [...WORK_STATUSES]
  const countScope = remote.data?.countScope ?? remote.data?.scope ?? scope
  const freshnessHours = (remote.data ?? remote.previousData)?.freshness.staleAfterHours ?? 24
  const correctionOffset = remote.data ? lastPageOffset(remote.data.total) : 0
  const pageNeedsCorrection = Boolean(remote.data && offset > correctionOffset)
  useEffect(() => {
    if (remote.data && offset > lastPageOffset(remote.data.total)) setOffset(lastPageOffset(remote.data.total))
  }, [remote.data?.total, offset])
  const resetConfirmCopy = 'Clear Scout’s current retry and review state. Missing content may reappear on the next poll. Download reservations and history are retained.'

  const performAction = async () => {
    if (!confirm || actionBusy) return
    const activeConfirmation = confirm
    setActionBusy(true); setActionNotice(null)
    try {
      const response = await fetch('/api/operations/work/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workKey: activeConfirmation.row.workKey, action: activeConfirmation.action }) })
      const result = await readJson<{ ok: true; message: string }>(response)
      await remote.refresh()
      setActionNotice({ kind: 'success', text: result.message })
      setConfirm((current) => current === activeConfirmation ? null : current)
    } catch (error) { setActionNotice({ kind: 'error', text: messageFrom(error) }) }
    finally { setActionBusy(false) }
  }

  const submitSearch = (event: React.FormEvent) => { event.preventDefault(); setOffset(0); setQuery(searchText.trim()) }
  const changeScope = (nextScope: OperationsScope) => {
    setScope(nextScope)
    if (nextScope === 'active' && isTerminalStatus(status)) setStatus('all')
    setOffset(0)
  }
  const changeStatus = (nextStatus: string) => {
    setStatus(nextStatus)
    if (isTerminalStatus(nextStatus)) setScope('all')
    setOffset(0)
  }
  const title = 'Queue'
  return <>
    <PageHeading eyebrow="SCOUT WORK" title={title} intro="A clear view of what Media Scout is watching, waiting on, and holding." icon={<Activity size={15} />} />
    <div className="ops-page">
      <div className="ops-page-toolbar"><div className="ops-scope-note"><ShieldCheck size={16} /><span>Scout work queue <strong>· not live download-client jobs</strong></span></div><button className="button button-secondary" type="button" onClick={() => void remote.refresh()} disabled={remote.refreshing}><RefreshCw className={remote.refreshing ? 'spin' : ''} size={15} /> Refresh view</button></div>
      <p className="ops-freshness-note" id="queue-freshness-note"><Clock3 size={14} /><span>Freshness uses Scout’s saved library and queue observations. A known observation older than {freshnessHours} hours is stale. Refresh view reloads saved status; it does not start a poll. Automatic monitoring is configured in <a href="#settings" aria-label="Monitoring settings">Settings</a>.</span></p>
      {remote.error && <ErrorBanner message={remote.error} onRetry={() => void remote.refresh()} refreshing={remote.refreshing} />}
      {actionNotice && <div className={`notice notice-${actionNotice.kind}`} role={actionNotice.kind === 'error' ? 'alert' : 'status'}><span>{actionNotice.text}</span></div>}
      {remote.data && <>
        <div className="ops-summary-grid" aria-label="Queue counts">
          <SummaryCard label="Work items" value={Object.values(counts).reduce((sum, count) => sum + count, 0)} tone="neutral" />
          <SummaryCard label="Open reviews" value={remote.data.openReviewCount} tone={remote.data.openReviewCount ? 'amber' : 'neutral'} href="#reviews" />
          <SummaryCard label="Ready status" value={counts.ready ?? 0} tone="mint" hint="Scheduling state, not a promise that a search will run." />
          <SummaryCard label="Waiting" value={(counts.cooldown ?? 0) + (counts.backoff ?? 0) + (counts['waiting-release'] ?? 0)} tone="amber" />
        </div>
        <ScopeCountsNote scope={countScope} />
      </>}
      {controlData && !remote.data && remote.loading && <p className="ops-filter-refresh-note" role="status">Updating this filter. Previous rows are hidden until matching results arrive; status counts are from the last loaded view.</p>}
      <div className="ops-list-card">
        <div className="ops-list-head"><div><h2>Tracked media</h2><p>Search timing and holds come from Scout’s latest observation.</p></div>{remote.data && <span className="ops-generated">View updated {formatDate(remote.data.generatedAt, true)}</span>}</div>
        <div className="ops-controls"><div className="ops-filter-tabs" role="group" aria-label="Work scope"><button type="button" aria-pressed={scope === 'active'} className={scope === 'active' ? 'selected' : ''} title="Hide completed and inactive work" onClick={() => changeScope('active')}>Active work</button><button type="button" aria-pressed={scope === 'all'} className={scope === 'all' ? 'selected' : ''} title="Include completed and inactive work" onClick={() => changeScope('all')}>All work</button></div>
          <form className="ops-search" onSubmit={submitSearch} role="search"><Search size={16} /><input aria-label="Search queue" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Find a movie or series" /><button className="text-button" type="submit">Search</button></form>
          <label className="sr-only" htmlFor="queue-status">Filter by status</label><select id="queue-status" value={status} onChange={(event) => changeStatus(event.target.value)}><option value="all">All statuses</option>{statusOptions.filter((key) => scope === 'all' || !isTerminalStatus(key)).map((key) => <option key={key} value={key}>{statusLabel(key)} · {controlCounts[key] ?? 0}</option>)}</select>
        </div>
        {remote.refreshing && <div className="ops-refreshing" role="status"><LoaderCircle className="spin" size={14} /> Updating this view…</div>}
        {pageNeedsCorrection && <div className="ops-correction-note" role="status">The list changed. Returning to the last available page…</div>}
        {remote.loading && !remote.data ? <LoadingPanel label="Loading Scout’s work queue…" /> : remote.error && !remote.data && remote.previousData ? <EmptyPanel title="This queue view couldn’t load" detail="Previous rows are hidden because they don’t match the current filters. Try again or adjust the filters." /> : remote.data && !pageNeedsCorrection ? (remote.data.items.length === 0 ? <EmptyPanel title={query || status !== 'all' ? 'No matching work' : 'Nothing in the queue yet'} detail={query || status !== 'all' ? 'Try another search or status filter.' : 'When missing media is found, Scout’s work will appear here.'} /> : <div className="ops-work-list">{remote.data.items.map((row) => <WorkCard key={row.workKey} row={row} onAction={(action) => setConfirm({ row, action })} />)}</div>) : null}
        {remote.data && !pageNeedsCorrection && (remote.data.total > PAGE_SIZE || offset > 0) && <Pagination offset={offset} total={remote.data.total} onChange={setOffset} />}
      </div>
      {!remote.data && remote.error && !remote.previousData && <EmptyPanel title="Queue is unavailable" detail="The last view is not available yet. Check the service connection and try again." />}
    </div>
    {confirm && <Dialog title={confirm.action === 'reset' ? 'Reset tracking?' : 'Make this work due?'} description={confirm.row.title} onClose={() => !actionBusy && setConfirm(null)} closeDisabled={actionBusy}>
      <div className="ops-dialog-body"><div className={confirm.action === 'reset' ? 'ops-warning-box' : 'ops-info-box'}>{confirm.action === 'reset' ? <><ShieldAlert size={18} /><p>{resetConfirmCopy}</p></> : <><Clock3 size={18} /><p>Mark this item due for the next eligible pass. This does not start a search now.</p></>}</div>
        {actionNotice?.kind === 'error' && <div className="ops-inline-error" role="alert">{actionNotice.text}</div>}
        <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setConfirm(null)} disabled={actionBusy}>Cancel</button><button className={`button ${confirm.action === 'reset' ? 'button-danger' : 'button-primary'}`} type="button" onClick={() => void performAction()} disabled={actionBusy}>{actionBusy ? <LoaderCircle className="spin" size={16} /> : confirm.action === 'reset' ? <RotateCcw size={16} /> : <Clock3 size={16} />}{actionBusy ? 'Working…' : confirm.action === 'reset' ? 'Reset tracking' : 'Mark due'}</button></div>
      </div>
    </Dialog>}
  </>
}

function WorkCard({ row, onAction }: { row: WorkRow; onAction: (action: 'retry' | 'reset') => void }) {
  const terminal = row.status === 'fulfilled' || row.status === 'inactive'
  const idSuffix = useId()
  const holdCopy = row.holdReason && !((row.status === 'waiting-release' && row.holdReason === 'waiting-release') || (row.status === 'manual' && row.holdReason === 'manual-review') || (row.holdReason === 'queue-unknown' && row.queueObservationKnown === false))
    ? holdReasonLabel(row.holdReason) : null
  const holdId = holdCopy ? `work-hold-${idSuffix}` : undefined
  const observationId = `work-observation-${idSuffix}`
  return <article className="ops-work-row">
    <div className="ops-media-icon">{row.mediaType === 'movie' ? <Film size={18} /> : <Tv size={18} />}</div>
    <div className="ops-work-main"><div className="ops-work-title"><h3>{row.title}</h3><StatusPill value={row.status} /></div><div className="ops-work-meta"><span>{row.mediaType === 'movie' ? 'Movie' : `TV${row.season === undefined ? '' : ` · Season ${row.season}`}`}</span><span>{row.missingCount} missing</span><span>Coverage: {row.coverage.observed} observed · {row.coverage.reserved} reserved</span></div>
      <WorkSchedule row={row} terminal={terminal} />
      <ObservationSummary row={row} id={observationId} />
      {holdCopy && <p className="ops-hold-reason" id={holdId}><ShieldAlert size={14} />{holdCopy}</p>}
    </div>
    <ActionControls actions={row.actions} onAction={onAction} observationState={row.observationState} observationId={observationId} holdCopy={holdCopy} holdId={holdId} terminalStatus={row.status === 'fulfilled' ? 'fulfilled' : row.status === 'inactive' ? 'inactive' : undefined} />
  </article>
}

function WorkSchedule({ row, terminal }: { row: WorkRow; terminal: boolean }) {
  const entries = [
    ...(!terminal && row.nextSearchAt ? [`Next eligible pass · ${formatDate(row.nextSearchAt)}`] : []),
    ...(row.lastSearchAt ? [`Last search · ${formatDate(row.lastSearchAt, true)}`] : []),
  ]
  return entries.length ? <div className="ops-work-schedule">{entries.map((entry) => <span key={entry}>{entry}</span>)}</div> : null
}

function ObservationSummary({ row, id }: { row: WorkRow; id: string }) {
  const libraryTime = formatObservationTime(row.observedAt)
  const queueTime = formatObservationTime(row.queueObservedAt)
  let sources: string[]
  if (row.queueObservationKnown === false) {
    sources = [
      `Library · ${libraryTime ?? 'time unavailable'}`,
      row.queueObservedAt ? `Queue unknown · last complete observation ${queueTime ?? 'time unavailable'}` : 'Queue · unknown',
    ]
  } else if (row.queueObservationKnown === true && libraryTime && queueTime && isSameTime(row.observedAt, row.queueObservedAt)) {
    sources = [`Library + queue · ${libraryTime}`]
  } else if (row.queueObservationKnown === true) {
    sources = [`Library · ${libraryTime ?? 'time unavailable'}`, `Queue · ${queueTime ?? 'time unavailable'}`]
  } else {
    sources = [`Library · ${libraryTime ?? 'time unavailable'}`]
  }
  const labels = { known: 'Current observations', stale: 'Stale observations', unknown: 'Observation status unknown' }
  return <div className="ops-observation-summary" id={id}>
    <span className={`ops-observation-status obs-${row.observationState}`}><span className="tiny-dot" />{labels[row.observationState]}</span>
    <div className="ops-observation-sources">{sources.map((source, index) => <span key={`${index}-${source}`}>{source}</span>)}</div>
  </div>
}

function ActionControls({ actions, onAction, observationState, observationId, holdCopy, holdId, terminalStatus }: {
  actions: WorkActions; onAction: (action: 'retry' | 'reset') => void
  observationState?: WorkRow['observationState']; observationId?: string; holdCopy?: string | null; holdId?: string
  terminalStatus?: 'fulfilled' | 'inactive'
}) {
  const id = useId()
  if (terminalStatus) return null
  const blocked = [actions.retry, actions.reset].filter((action) => !action.allowed)
  const blockedReasons = [...new Set(blocked.map(({ reason }) => reason).filter((reason): reason is string => Boolean(reason)))]
  const freshnessBlocked = observationState === 'stale' && blockedReasons.every((reason) => reason === 'queue-observation-stale')
    || observationState === 'unknown' && blockedReasons.length > 0 && blockedReasons.every((reason) => reason === 'queue-observation-unknown')
  const holdBlocked = Boolean(holdCopy && blockedReasons.length > 0 && blockedReasons.every((reason) => reason === 'work-held'))
  const reasonId = `work-action-reason-${id}`
  let message = ''
  if (!freshnessBlocked && !holdBlocked && blockedReasons.length) {
    if (blockedReasons.includes('work-not-retryable') && blockedReasons.includes('work-not-resettable')) message = 'Retry and reset are not available for this status.'
    else message = [...new Set(blockedReasons.map(actionReasonLabel))].join(' ')
  }
  const descriptionId = message ? reasonId : freshnessBlocked ? 'queue-freshness-note' : holdBlocked ? holdId : observationId
  return <div className="ops-work-actions">
    <div className="ops-row-actions" role="group" aria-label="Work actions">
      <button className="button button-secondary" type="button" disabled={!actions.retry.allowed} onClick={() => onAction('retry')} aria-describedby={!actions.retry.allowed && descriptionId ? descriptionId : undefined}><Clock3 size={14} />Retry</button>
      <button className="button button-secondary" type="button" disabled={!actions.reset.allowed} onClick={() => onAction('reset')} aria-describedby={!actions.reset.allowed && descriptionId ? descriptionId : undefined}><RotateCcw size={14} />Reset tracking</button>
    </div>
    {message && <p className="ops-action-reason" id={reasonId}>{message}</p>}
  </div>
}

function StatusPill({ value }: { value: string }) {
  const tone = ['manual', 'backoff', 'waiting-release'].includes(value) ? 'amber' : value === 'ready' || value === 'searching' ? 'mint' : ['fulfilled', 'inactive'].includes(value) ? 'quiet' : 'neutral'
  return <span className={`ops-status status-${tone}`}>{statusLabel(value)}</span>
}

function SummaryCard({ label, value, tone, href, hint }: { label: string; value: number; tone: string; href?: string; hint?: string }) {
  const inner = <><span>{label}</span><strong>{value.toLocaleString()}</strong>{hint && <small className="ops-summary-hint">{hint}</small>}</>
  return href ? <a className={`ops-summary-card summary-${tone}`} href={href}>{inner}</a> : <div className={`ops-summary-card summary-${tone}`}>{inner}</div>
}

function PageHeading({ eyebrow, title, intro, icon }: { eyebrow: string; title: string; intro: string; icon: React.ReactNode }) {
  return <div className="page-heading ops-page-heading"><div><div className="eyebrow"><span className="eyebrow-mark" />{eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p className="page-intro">{intro}</p></div><div className="heading-stamp">{icon}<span>LOCAL CONTROL</span></div></div>
}

function ScopeCountsNote({ scope }: { scope: OperationsScope }) {
  return <p className="ops-count-context">Summary counts cover <strong>{scope === 'active' ? 'active work' : 'all work, including completed and inactive items'}</strong>. Search and status filters only narrow the list.</p>
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
  const correctionOffset = remote.data ? lastPageOffset(remote.data.total) : 0
  const pageNeedsCorrection = Boolean(remote.data && offset > correctionOffset)
  useEffect(() => {
    if (remote.data && offset > lastPageOffset(remote.data.total)) setOffset(lastPageOffset(remote.data.total))
  }, [remote.data?.total, offset])
  const search = (event: React.FormEvent) => { event.preventDefault(); setOffset(0); setQuery(searchText.trim()) }
  return <>
    <PageHeading eyebrow="NEEDS A HUMAN" title="Manual review" intro="Review held work and choose only the actions Scout says are available." icon={<ShieldAlert size={15} />} />
    <div className="ops-page">
      <div className="ops-page-toolbar"><div className="ops-scope-note"><ShieldAlert size={16} /><span>Review does not mean complete. No generic dismiss action is available.</span></div><button className="button button-secondary" type="button" onClick={() => void remote.refresh()} disabled={remote.refreshing}><RefreshCw className={remote.refreshing ? 'spin' : ''} size={15} /> Refresh view</button></div>
      {remote.error && <ErrorBanner message={remote.error} onRetry={() => void remote.refresh()} refreshing={remote.refreshing} />}
      {notice && <div className="notice notice-success" role="status">{notice}</div>}
      <div className="ops-list-card">
        <div className="ops-list-head"><div><h2>{resolved ? 'Resolved reviews' : 'Open reviews'}</h2><p>{resolved ? 'Past review decisions remain visible.' : 'Only open reviews can offer actions.'}</p></div>{remote.data && <span className="ops-generated">View updated {formatDate(remote.data.generatedAt, true)}</span>}</div>
        <div className="ops-controls"><div className="ops-filter-tabs" role="group" aria-label="Review status"><button type="button" aria-pressed={!resolved} className={!resolved ? 'selected' : ''} onClick={() => { setResolved(false); setOffset(0) }}>Open</button><button type="button" aria-pressed={resolved} className={resolved ? 'selected' : ''} onClick={() => { setResolved(true); setOffset(0) }}>Resolved</button></div>
          <form className="ops-search" role="search" onSubmit={search}><Search size={16} /><input aria-label="Search reviews" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Find a movie or review reason" /><button className="text-button" type="submit">Search</button></form></div>
        {remote.refreshing && <div className="ops-refreshing" role="status"><LoaderCircle className="spin" size={14} /> Updating this view…</div>}
        {pageNeedsCorrection && <div className="ops-correction-note" role="status">The review list changed. Returning to the last available page…</div>}
        {remote.loading && !remote.data ? <LoadingPanel label="Loading reviews…" /> : remote.data && !pageNeedsCorrection && remote.data.items.length === 0 ? <EmptyPanel title={query ? 'No matching reviews' : resolved ? 'No resolved reviews yet' : 'No open reviews'} detail={query ? 'Try another search.' : resolved ? 'Resolved reviews will remain available here.' : 'If Scout needs a decision, the review will appear here.'} /> : remote.data && !pageNeedsCorrection && <div className="ops-review-list">{remote.data.items.map((row) => <article className="ops-review-row" key={row.id}>
          <div className="ops-review-marker"><ShieldAlert size={17} /></div><div className="ops-review-content"><div className="ops-work-title"><h3>{row.title}</h3><span className={`ops-status ${row.resolvedAt ? 'status-quiet' : 'status-amber'}`}>{row.resolvedAt ? 'Resolved' : 'Open'}</span></div><p>{row.summary}</p><div className="ops-work-meta"><span>{reviewMediaLabel(row)}</span><span>Created {formatDate(row.createdAt, true)}</span>{row.resolvedAt && <span>Resolved {formatDate(row.resolvedAt, true)}</span>}</div></div>
          <button className="button button-secondary" type="button" onClick={() => { setSelected(row); setActionError(null) }}>{resolved ? 'View details' : 'Review details'} <ArrowRight size={15} /></button>
        </article>)}</div>}
        {remote.data && !pageNeedsCorrection && (remote.data.total > PAGE_SIZE || offset > 0) && <Pagination offset={offset} total={remote.data.total} onChange={setOffset} />}
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
  const [now, setNow] = useState(Date.now())
  const closeReview = useCallback(() => {
    if (workActionConfirm) setWorkActionConfirm(null)
    else if (!busy) onClose()
  }, [workActionConfirm, busy, onClose])
  const dialog = useFocusDialog(true, closeReview)
  useEffect(() => {
    if (!prepared) return
    const expiresAt = Date.parse(prepared.expiresAt)
    const remaining = expiresAt - Date.now()
    if (!Number.isFinite(expiresAt) || remaining <= 0) { setNow(Date.now()); return }
    // Operator observations have a short (120 second) lifetime. Avoid enormous timers
    // for malformed/future fixtures; the commit path independently rechecks the clock.
    if (remaining > 120_000) return
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 1)
    return () => window.clearTimeout(timer)
  }, [prepared?.token, prepared?.expiresAt])
  const expiry = prepared ? Date.parse(prepared.expiresAt) : Number.NaN
  const expired = prepared ? !Number.isFinite(expiry) || expiry <= now : false
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
    if (!Number.isFinite(Date.parse(prepared.expiresAt)) || Date.parse(prepared.expiresAt) <= Date.now()) { setNow(Date.now()); setActionError('Prepared action expired. Prepare fresh evidence before continuing.'); return }
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
      <div className="ops-dialog-head"><div><div className="eyebrow"><span className="eyebrow-mark" />REVIEW #{row.id}</div><h2 id="review-dialog-title">{row.title}</h2><p>{row.summary}</p></div><button className="icon-button" type="button" aria-label="Close review details" onClick={closeReview} disabled={busy || workActionConfirm !== null}><X size={18} /></button></div>
      <div className="ops-dialog-body ops-review-body">
        <div className="ops-review-facts"><span><strong>Media</strong>{reviewMediaLabel(row)}</span><span><strong>Created</strong>{formatDate(row.createdAt, true)}</span>{row.resolvedAt && <span><strong>Resolved</strong>{formatDate(row.resolvedAt, true)}</span>}</div>
        {actionError && <div className="ops-inline-error" role="alert">{actionError}</div>}
        {!prepared && <>
          <div className="ops-scope-note"><ShieldCheck size={17} /><span>Actions depend on fresh evidence. Scout supplies which operations are currently available.</span></div>
          {!row.resolvedAt && <div className="ops-review-work-actions"><div><strong>Manage this work item</strong><span>Retry schedules its next eligible pass. Reset clears only the current retry/review session.</span></div><ActionControls actions={row.actions} onAction={setWorkActionConfirm} /></div>}
          {!row.resolvedAt && <div className="ops-recovery-actions">
            <RecoveryButton label="Associate queue" action={row.actions.associate} onClick={() => void prepare('associate')} busy={busy} />
            <RecoveryButton label="Release reservation" action={row.actions.release} onClick={() => void prepare('release')} busy={busy} />
          </div>}
        </>}
          {prepared && action && <>
          <div className="ops-prepared-summary"><span className="ops-step-number">PREPARED · {action === 'associate' ? 'ASSOCIATE QUEUE' : 'RELEASE RESERVATION'}</span><p>{prepared.summary}</p><span className={`ops-expiry ${expired ? 'is-expired' : ''}`}><Clock3 size={14} />{expired ? 'Preview expired · prepare again' : `Expires ${formatDate(prepared.expiresAt)}`}</span></div>
          {(prepared.queuePreview !== undefined || prepared.targetNames !== undefined) && <PreparedEvidence prepared={prepared} />}
          {action === 'associate' && <>
            <fieldset className="ops-choice-fieldset" disabled={busy}><legend>1. Choose the media item</legend>{prepared.mediaChoices?.length ? prepared.mediaChoices.map((choice) => <label key={choice.mediaIndex} className="ops-choice"><input type="radio" name="review-media-choice" value={choice.mediaIndex} checked={chosenMediaIndex === choice.mediaIndex} onChange={() => setChosenMediaIndex(choice.mediaIndex)} /><span><strong>{choice.title}</strong><small>Media choice {choice.mediaIndex + 1}</small></span></label>) : <p className="ops-muted">No media choices were supplied. This action cannot be committed.</p>}</fieldset>
            <fieldset className="ops-choice-fieldset" disabled={busy}><legend>2. Select one or more targets</legend>{prepared.targetChoices?.length ? prepared.targetChoices.map((choice) => <label key={choice.targetIndex} className="ops-choice"><input type="checkbox" value={choice.targetIndex} checked={chosenTargetIndices.includes(choice.targetIndex)} onChange={(event) => setChosenTargetIndices((current) => event.target.checked ? [...new Set([...current, choice.targetIndex])] : current.filter((index) => index !== choice.targetIndex))} /><span><strong>{choice.title}</strong><small>Target {choice.targetIndex + 1}</small></span></label>) : <p className="ops-muted">No target choices were supplied. This action cannot be committed.</p>}</fieldset>
          </>}
          {prepared.requiresClientInspection && <label className="ops-inspection-check"><input type="checkbox" checked={inspectionConfirmed} onChange={(event) => setInspectionConfirmed(event.target.checked)} disabled={busy} /><span><strong>I inspected the original submission routing and all relevant download clients. No matching download is active.</strong><small>Check every client the original submission could have routed to. An empty Sonarr/Radarr queue alone is not enough to confirm this.</small></span></label>}
          {expired && <button className="button button-secondary" type="button" onClick={() => void prepare(action)} disabled={busy}>Prepare a fresh preview</button>}
          <div className="ops-challenge"><label htmlFor="recovery-challenge">Type the exact approval text</label><code>{prepared.challenge}</code><input id="recovery-challenge" autoComplete="off" value={challenge} onChange={(event) => setChallenge(event.target.value)} disabled={busy} /></div>
          <div className="ops-note-field"><label htmlFor="recovery-note">Audit note <span>3–500 characters</span></label><textarea id="recovery-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} placeholder="Why is this action appropriate? Do not include credentials or URLs." /><span className="ops-char-count">{note.length} / 500</span></div>
          {actionError && /expir|stale|changed|fresh|prepare again|current evidence/iu.test(actionError) && <button className="button button-secondary" type="button" onClick={() => void prepare(action)} disabled={busy}>Prepare a fresh preview</button>}
          <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={() => { setPrepared(null); setAction(null); setActionError(null) }} disabled={busy}>Back</button><button className="button button-primary" type="button" onClick={() => void commit()} disabled={!canCommit || busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? 'Submitting…' : 'Confirm action'}</button></div>
        </>}
        {busy && !prepared && <div className="ops-preparing" role="status"><LoaderCircle className="spin" size={17} /> Preparing fresh evidence…</div>}
        {!prepared && <div className="ops-dialog-actions"><button className="button button-secondary" type="button" onClick={closeReview} disabled={busy || workActionConfirm !== null}>Close</button></div>}
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
  return <Dialog title={action === 'retry' ? 'Make this work due?' : 'Reset tracking?'} description={row.title} onClose={() => !busy && onClose()} className="ops-confirm-dialog" closeDisabled={busy}>
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
  const correctionOffset = remote.data ? lastPageOffset(remote.data.total) : 0
  const pageNeedsCorrection = Boolean(remote.data && offset > correctionOffset)
  useEffect(() => {
    if (remote.data && offset > lastPageOffset(remote.data.total)) setOffset(lastPageOffset(remote.data.total))
  }, [remote.data?.total, offset])
  const search = (event: React.FormEvent) => { event.preventDefault(); setOffset(0); setQuery(searchText.trim()) }
  return <>
    <PageHeading eyebrow="SEARCH RECORD" title="Search history" intro="See the queries Scout sent, which media they were for, and how each search ended." icon={<Search size={15} />} />
    <div className="ops-page">
      <div className="ops-page-toolbar"><div className="ops-scope-note"><Activity size={16} /><span>Purpose-built search history <strong>· not raw server logs</strong></span></div><button className="button button-secondary" type="button" onClick={() => void remote.refresh()} disabled={remote.refreshing}><RefreshCw className={remote.refreshing ? 'spin' : ''} size={15} /> Refresh view</button></div>
      {remote.error && <ErrorBanner message={remote.error} onRetry={() => void remote.refresh()} refreshing={remote.refreshing} />}
      <div className="ops-list-card">
        <div className="ops-list-head"><div><h2>Searches</h2><p>Search terms may reveal what you are looking for.</p></div>{remote.data && <span className="ops-retention">Retained {remote.data.retention.days} days · up to {remote.data.retention.maxEntries.toLocaleString()} entries</span>}</div>
        <div className="ops-controls"><form className="ops-search" role="search" onSubmit={search}><Search size={16} /><input aria-label="Search history" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search query or media title" /><button className="text-button" type="submit">Search</button></form>
          <label className="sr-only" htmlFor="activity-outcome">Filter by outcome</label><select id="activity-outcome" value={outcome} onChange={(event) => { setOutcome(event.target.value); setOffset(0) }}><option value="">All outcomes</option><option value="running">Running</option><option value="success">Succeeded</option><option value="error">Failed</option></select></div>
        {remote.refreshing && <div className="ops-refreshing" role="status"><LoaderCircle className="spin" size={14} /> Updating this view…</div>}
        {pageNeedsCorrection && <div className="ops-correction-note" role="status">Search history changed. Returning to the last available page…</div>}
        {remote.loading && !remote.data ? <LoadingPanel label="Loading search history…" /> : remote.data && !pageNeedsCorrection && remote.data.items.length === 0 ? <EmptyPanel title={query || outcome ? 'No matching searches' : 'No searches recorded yet'} detail={query || outcome ? 'Try another query or outcome filter.' : 'Searches will appear here after Scout makes its next search.'} /> : remote.data && !pageNeedsCorrection && <div className="ops-activity-list">{remote.data.items.map((row) => <ActivityCard key={row.id} row={row} />)}</div>}
        {remote.data && !pageNeedsCorrection && (remote.data.total > PAGE_SIZE || offset > 0) && <Pagination offset={offset} total={remote.data.total} onChange={setOffset} />}
      </div>
      {!remote.data && remote.error && <EmptyPanel title="Search history is unavailable" detail="Check the service connection and try again." />}
    </div>
  </>
}

function ActivityCard({ row }: { row: ActivityRow }) {
  const tone = row.outcome === 'success' ? 'mint' : row.outcome === 'error' ? 'amber' : 'neutral'
  const finished = activityFinishLabel(row.startedAt, row.finishedAt)
  const outcome = row.outcome === 'running' ? 'Completion not recorded' : statusLabel(row.outcome)
  return <article className="ops-activity-row"><div className="ops-activity-top"><div className="ops-activity-date"><Clock3 size={14} /><span>Started {formatDate(row.startedAt, true)}</span><span className="ops-source">{row.source === 'cycle' ? 'Scout cycle' : 'Manual search'}</span></div><span className={`ops-status status-${tone}`}>{outcome}</span></div>
    <code className="ops-query">{row.query}</code>
    <div className="ops-activity-bottom"><div className="ops-media-tags">{row.media.length ? row.media.map((media) => <span className="ops-media-tag" key={media.workKey}>{media.title}</span>) : <span className="ops-muted">{row.source === 'manual' ? 'Manual search · target not linked' : 'Media target not included'}</span>}</div><div className="ops-result-meta">{row.resultCount === null ? 'Results unavailable' : `${row.resultCount.toLocaleString()} results`}{row.errorCode && <span className="ops-error-code"> · {row.errorCode}</span>}{finished && <span> · {finished}</span>}</div></div>
  </article>
}
