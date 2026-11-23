import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CircleAlert, LoaderCircle, Search as SearchIcon, ShieldCheck, Waves, X } from 'lucide-react'
import type { Settings } from './types'

type Candidate = { candidateId: string; observations?: Array<{ title: string; indexer?: string; size?: number | null; seeders?: number | null }> }
type Selection = { candidateId: string; coverage: string; reason: string; uncertainty: string }
type Plan = { version: number; planId: string; status: string; selections: Selection[]; covered?: string[]; gaps?: string[]; deferred?: string[]; scopeGaps?: string[]; extras?: string[]; usefulOverlap?: string[]; broadCoverage?: string; coverage?: { covered?: string[]; gaps?: string[]; deferred?: string[]; broad?: { status: string; gaps?: string[] } }; warnings?: string[]; message?: string }
type Child = { candidateId: string; title: string; effectiveCategory: string | null; categoryRouting: string; categoryNote: string; releaseCategoryIds: number[] }
type Receipt = { executionId: string; searchId: string; planId?: string; outcome: string; dryRun: boolean; updatedAt: string; client?: { name: string }; children: Array<{ candidateId: string; outcome: string; message?: string; effectiveCategory?: string | null; categoryRouting?: string; categoryNote?: string }> ; message?: string }
type Confirmation = { confirmationId: string; expiresAt: string; searchId: string; planId: string; version: number; client: { id: number; name: string; protocol: string; defaultCategory?: string | null; configuredCategories: Array<{ clientCategory: string | null; categories: number[] | null }> }; dryRun: boolean; children: Child[] }
type DownloadClient = { id: number; name: string; protocol: string; defaultCategory?: string | null; categoryMap: Array<{ clientCategory: string | null; categories: number[] | null }> }
type CommitRequest = { confirmationId: string; searchId: string; planId: string; version: number; idempotencyKey: string }
type SearchResult = { searchId: string; status: string; source?: 'manual' | 'arr' | 'automation'; manualExecutionEligible?: boolean; manualExecutionBlockedReason?: string; automationPending?: boolean; automationWorkload?: { deferredTargets: number }; acquisition?: { status: string; code?: string }; prompt?: string; plan?: Plan; candidates?: Candidate[]; events?: Array<{ type: string; data: Record<string, unknown> }>; receipts?: Receipt[]; counts?: { decisions: number; searches: number; candidates: number }; queuePosition?: number; waitingReason?: string; retryAt?: string; message?: string; researchWarnings?: string[]; diagnostics?: { modelTurns: number; stopReason: string; elapsedMs?: number; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number } } }
const running = (status?: string) => status === 'queued' || status === 'running'
const MAX_SEARCH_PROMPT_LENGTH = 4000
const readSignal = (controller: AbortController) => AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
const safeBody = async (response: Response) => { try { return await response.json() } catch { return {} } }
const idempotencyKey = () => {
  const bytes = new Uint8Array(20)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
function readPending(searchId: string): CommitRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`media-scout-execution-pending:${searchId}`) ?? 'null')
    return value && value.searchId === searchId && typeof value.confirmationId === 'string' && typeof value.planId === 'string' && typeof value.idempotencyKey === 'string' ? value as CommitRequest : null
  } catch { return null }
}
function savePending(request: CommitRequest) { try { sessionStorage.setItem(`media-scout-execution-pending:${request.searchId}`, JSON.stringify(request)); return true } catch { return false } }
function clearPending(searchId: string) { try { sessionStorage.removeItem(`media-scout-execution-pending:${searchId}`) } catch { /* no-op */ } }
const SAFE_RECONFIRM_CODES = new Set(['plan-unavailable', 'plan-changed', 'whole-plan-selection-required', 'dry-run-enabled', 'search-source-not-manual', 'prowlarr-source-unavailable', 'source-changed', 'candidate-not-selected', 'candidate-expired', 'candidate-source-unverified', 'invalid-candidate-set', 'download-client-unavailable', 'download-client-protocol-mismatch', 'grab-adapter-unavailable', 'confirmation-expired', 'safety-changed', 'client-changed'])
const AUTOMATION_CONFIRMATION_BLOCKS = new Set(['automation-pass-active', 'execution-active', 'execution-send-risk'])
function errorMessage(payload: any, fallback: string) { return typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : fallback }
function validReceipt(value: any): value is Receipt {
  return Boolean(value && typeof value.executionId === 'string' && typeof value.searchId === 'string'
    && ['running', 'submitted', 'partial', 'rejected', 'uncertain', 'dry-run', 'not-attempted'].includes(value.outcome)
    && typeof value.dryRun === 'boolean' && typeof value.updatedAt === 'string'
    && (!value.client || typeof value.client.name === 'string')
    && Array.isArray(value.children) && value.children.every((child: any) => child
      && typeof child.candidateId === 'string' && typeof child.outcome === 'string'))
}
function validConfirmation(value: any): value is Confirmation {
  return Boolean(value && typeof value.confirmationId === 'string' && typeof value.searchId === 'string'
    && typeof value.planId === 'string' && Number.isInteger(value.version)
    && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))
    && typeof value.dryRun === 'boolean' && value.client && typeof value.client.name === 'string'
    && typeof value.client.protocol === 'string' && Array.isArray(value.client.configuredCategories)
    && value.client.configuredCategories.every((item: any) => item
      && (item.clientCategory === null || typeof item.clientCategory === 'string')
      && (item.categories === null || Array.isArray(item.categories)))
    && Array.isArray(value.children) && value.children.length > 0
    && value.children.every((child: any) => child && typeof child.candidateId === 'string'
      && typeof child.title === 'string' && typeof child.categoryNote === 'string'))
}
function items(values?: string[]) { return values?.length ? <ul className="semantic-list">{values.map((value, i) => <li key={`${value}-${i}`}>{value}</li>)}</ul> : <p className="field-hint">None reported</p> }

export function SearchPage({ settings, searchId, searchRevision, active = true, onSearchStarted }: { settings: Settings; searchId?: string; searchRevision: number; active?: boolean; onSearchStarted(id: string, startingRevision: number): void }) {
  const [prompt, setPrompt] = useState('')
  const promptTooLong = prompt.length > MAX_SEARCH_PROMPT_LENGTH
  const [result, setResult] = useState<SearchResult | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [startError, setStartError] = useState(''), [notice, setNotice] = useState('')
  const [searchMissing, setSearchMissing] = useState(false)
  const [clients, setClients] = useState<DownloadClient[]>([]), [clientId, setClientId] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [execError, setExecError] = useState('')
  const [pendingCommit, setPendingCommit] = useState<CommitRequest | null>(null)
  const [execBusy, setExecBusy] = useState(false), [receipt, setReceipt] = useState<Receipt | null>(null)
  const timer = useRef<number>(), receiptTimer = useRef<number>(), controller = useRef<AbortController | null>(null), receiptController = useRef<AbortController | null>(null), opLock = useRef(false)
  const opener = useRef<HTMLButtonElement | null>(null), dialog = useRef<HTMLDivElement>(null), firstFocus = useRef<HTMLButtonElement>(null), prepareButton = useRef<HTMLButtonElement>(null)
  const promptInput = useRef<HTMLTextAreaElement>(null), receiptPollingId = useRef<string | null>(null)
  const generation = useRef(0), currentSearch = useRef(searchId), activeNow = useRef(active)
  currentSearch.current = searchId; activeNow.current = active
  const isCurrent = (id: string, token: number) => generation.current === token && currentSearch.current === id

  useEffect(() => {
    const token = ++generation.current
    window.clearTimeout(timer.current); window.clearTimeout(receiptTimer.current)
    controller.current?.abort(); receiptController.current?.abort(); receiptPollingId.current = null
    setResult(null); setError(''); setStartError(''); setSearchMissing(false); setNotice(''); setConfirmation(null); setReceipt(null); setExecError(''); setPendingCommit(searchId ? readPending(searchId) : null); setClients([]); setClientId('')
    if (searchId) void loadResult(searchId, token)
    return () => { ++generation.current; window.clearTimeout(timer.current); window.clearTimeout(receiptTimer.current); controller.current?.abort(); receiptController.current?.abort() }
  }, [searchId, searchRevision])
  useEffect(() => {
    if (active) return
    setConfirmation(null)
    setExecError('')
  }, [active, searchId])
  useEffect(() => {
    if (!confirmation) return
    firstFocus.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!execBusy) closeConfirmation() }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),[href],input:not(:disabled)')]
      if (!focusable.length) return
      const first = focusable[0]!, last = focusable.at(-1)!
      if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmation, execBusy])
  async function loadResult(id: string, token = generation.current) {
    if (!isCurrent(id, token)) return
    window.clearTimeout(timer.current); controller.current?.abort()
    const current = new AbortController(); controller.current = current
    const signal = readSignal(current)
    try {
      const response = await fetch(`/api/v2/searches/${encodeURIComponent(id)}`, { signal })
      if (response.status === 404) {
        if (!current.signal.aborted && isCurrent(id, token)) {
          window.clearTimeout(receiptTimer.current); receiptController.current?.abort(); receiptPollingId.current = null
          setResult(null); setReceipt(null); setSearchMissing(true); setError('Search not found. Check Activity or start a new search.')
        }
        return
      }
      if (response.status >= 500) throw new Error('temporary')
      if (!response.ok) {
        if (!current.signal.aborted && isCurrent(id, token)) setError('Search status could not be loaded.')
        return
      }
      const data = await response.json() as SearchResult
      if (!data || data.searchId !== id || typeof data.status !== 'string') throw new Error('Invalid search status')
      if (current.signal.aborted || !isCurrent(id, token)) return
      setResult(data); setError(''); setSearchMissing(false)
      setPendingCommit(readPending(id))
      const durable = data.receipts?.at(-1)
      if (durable) setReceipt(previous => previous?.executionId === durable.executionId && (Date.parse(previous.updatedAt) > Date.parse(durable.updatedAt) || (previous.outcome !== 'running' && durable.outcome === 'running')) ? previous : durable)
      const automationAwaitingReceipt = data.manualExecutionBlockedReason === 'execution-active' && durable?.outcome !== 'running'
      if (running(data.status) || data.automationPending || data.manualExecutionBlockedReason === 'automation-pass-active' || automationAwaitingReceipt || data.acquisition?.status === 'pending') timer.current = window.setTimeout(() => void loadResult(id, token), 1200)
      if (durable?.outcome === 'running' && receiptPollingId.current !== durable.executionId) void pollReceipt(durable.executionId, id, token)
    } catch {
      if (!current.signal.aborted && isCurrent(id, token) && controller.current === current) {
        setError('Search status is temporarily unavailable. Retrying…')
        timer.current = window.setTimeout(() => void loadResult(id, token), 3000)
      }
    }
  }
  async function pollReceipt(executionId: string, id: string, token = generation.current) {
    if (!isCurrent(id, token)) return
    receiptPollingId.current = executionId
    window.clearTimeout(receiptTimer.current)
    receiptController.current?.abort()
    const current = new AbortController(); receiptController.current = current
    try {
      const response = await fetch(`/api/v2/executions/${encodeURIComponent(executionId)}`, { signal: readSignal(current) })
      if (!response.ok) throw new Error()
      const next = await response.json() as Receipt
      if (!validReceipt(next) || next.searchId !== id) throw new Error('Receipt response was incomplete')
      if (current.signal.aborted || !isCurrent(id, token)) return
      setReceipt(next)
      if (next.outcome === 'running') receiptTimer.current = window.setTimeout(() => void pollReceipt(executionId, id, token), 1200)
      else { receiptPollingId.current = null; void loadResult(id, token) }
    } catch { if (!current.signal.aborted && isCurrent(id, token)) receiptTimer.current = window.setTimeout(() => void pollReceipt(executionId, id, token), 3000) }
  }
  async function search(event: FormEvent) {
    event.preventDefault()
    if (!prompt.trim() || promptTooLong || busy) return
    const startingRevision = searchRevision, token = generation.current
    setStartError(''); setBusy(true)
    try {
      const body = { prompt }
      const response = await fetch('/api/v2/searches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await safeBody(response)
      if (response.status >= 400 && response.status < 500) {
        if (generation.current === token) setStartError(errorMessage(data, 'Search could not start. Check your search settings.'))
        return
      }
      if (!response.ok || typeof data.searchId !== 'string' || !data.searchId) throw new Error('Search acceptance not confirmed')
      onSearchStarted(data.searchId, startingRevision)
    } catch {
      if (generation.current === token) setStartError('Could not confirm the new search was accepted. Check Activity before submitting it again.')
    }
    finally { setBusy(false) }
  }
  async function prepare() {
    if (!result?.plan || result.plan.version !== 2 || opLock.current || !activeNow.current || readPending(result.searchId)) {
      if (result && readPending(result.searchId)) setExecError('A previous confirmation has an unresolved outcome. Retry that same confirmation or inspect its durable receipt before preparing another.')
      return
    }
    const id = result.searchId, token = generation.current
    opLock.current = true; setExecBusy(true); setExecError('')
    try {
      const response = await fetch('/api/v2/download-clients')
      const data = await safeBody(response)
      if (!response.ok) throw new Error(errorMessage(data, 'Download clients could not be loaded.'))
      if (!isCurrent(id, token) || !activeNow.current) return
      const available = (data.items ?? []) as DownloadClient[]
      setClients(available)
      setConfirmation(null)
      setExecError(available.length ? '' : 'No enabled download clients are available in Prowlarr.')
      setClientId('')
      setNotice('Choose a Prowlarr download client, then prepare this complete release set.')
    } catch (failure) { if (isCurrent(id, token) && activeNow.current) setExecError(failure instanceof Error ? failure.message : 'Download clients could not be loaded.') }
    finally { opLock.current = false; setExecBusy(false) }
  }
  async function prepareConfirmation() {
    if (!result?.plan || !clientId || opLock.current || !activeNow.current) return
    if (readPending(result.searchId)) { setPendingCommit(readPending(result.searchId)); setExecError('A previous confirmation has an unresolved outcome. Retry that same confirmation or inspect its durable receipt before preparing another.'); return }
    const id = result.searchId, token = generation.current
    opener.current = prepareButton.current
    opLock.current = true; setExecBusy(true); setExecError('')
    try {
      const body = { searchId: result.searchId, planId: result.plan.planId, version: result.plan.version, candidateIds: result.plan.selections.map(selection => selection.candidateId), downloadClientId: Number(clientId) }
      const response = await fetch('/api/v2/executions/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await safeBody(response)
      if (!response.ok) {
        if (data.code === 'candidate-expired' || AUTOMATION_CONFIRMATION_BLOCKS.has(data.code)) void loadResult(id, token)
        throw new Error(errorMessage(data, 'The plan could not be prepared. Review current client and safety settings.'))
      }
      if (!validConfirmation(data) || data.searchId !== id || data.planId !== result.plan.planId || data.version !== result.plan.version) throw new Error('Preparation response was incomplete. No download was sent; prepare again.')
      if (!isCurrent(id, token) || !activeNow.current) return
      const confirmation = data as Confirmation
      setConfirmation(confirmation); setNotice('')
    } catch (failure) { if (isCurrent(id, token) && activeNow.current) setExecError(failure instanceof Error ? failure.message : 'The plan could not be prepared.') }
    finally { opLock.current = false; setExecBusy(false) }
  }
  function closeConfirmation() { if (execBusy) return; setConfirmation(null); requestAnimationFrame(() => opener.current?.focus()) }
  async function sendCommit(request: CommitRequest, token = generation.current) {
    if (opLock.current) return
    opLock.current = true; setExecBusy(true); setExecError('')
    setPendingCommit(request)
    if (!savePending(request)) {
      if (isCurrent(request.searchId, token)) setExecError('This browser cannot save a recovery key for the confirmation. Enable session storage before submitting; no request was sent.')
      opLock.current = false; setExecBusy(false)
      return
    }
    try {
      const response = await fetch('/api/v2/executions/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      const data = await safeBody(response)
      if (!response.ok) {
        const code = typeof data.code === 'string' ? data.code : ''
        if (SAFE_RECONFIRM_CODES.has(code) || AUTOMATION_CONFIRMATION_BLOCKS.has(code)) {
          clearPending(request.searchId)
          if (isCurrent(request.searchId, token)) {
            setPendingCommit(null); setConfirmation(null)
            const message = errorMessage(data, 'The confirmation is no longer valid.')
            const refresh = code === 'candidate-expired' || AUTOMATION_CONFIRMATION_BLOCKS.has(code)
            setExecError(refresh ? message : `${message} Prepare a fresh confirmation to continue.`)
            if (refresh) void loadResult(request.searchId, token)
          }
          return
        }
        throw new Error(errorMessage(data, 'Submission could not be confirmed. Check Activity before trying again.'))
      }
      if (!validReceipt(data) || data.searchId !== request.searchId) throw new Error('Receipt response was incomplete or interrupted.')
      clearPending(request.searchId)
      if (!isCurrent(request.searchId, token)) return
      setPendingCommit(null); setReceipt(data as Receipt); setConfirmation(null); requestAnimationFrame(() => opener.current?.focus()); setNotice(`Receipt recorded: ${data.outcome}. Submitted means accepted by Prowlarr, not downloaded or imported.`)
      if (data.outcome === 'running') void pollReceipt(data.executionId, request.searchId, token)
      else void loadResult(request.searchId, token)
    } catch (failure) {
      if (isCurrent(request.searchId, token)) {
        setConfirmation(null)
        setExecError(`${failure instanceof Error ? failure.message : 'The response was interrupted.'} The exact confirmation and idempotency key are saved. Retry this same request to recover its durable outcome; do not prepare a new confirmation.`)
      }
    } finally { opLock.current = false; setExecBusy(false) }
  }
  async function commit() {
    if (!confirmation || opLock.current || !activeNow.current) return
    const request: CommitRequest = readPending(confirmation.searchId) ?? { confirmationId: confirmation.confirmationId, searchId: confirmation.searchId, planId: confirmation.planId, version: confirmation.version, idempotencyKey: idempotencyKey() }
    await sendCommit(request)
  }
  const byId = new Map((result?.candidates ?? []).map(candidate => [candidate.candidateId, candidate]))
  const plan = result?.plan
  const receipts = (result?.receipts ?? []).map(item => receipt?.executionId === item.executionId ? receipt : item)
  if (receipt && !receipts.some(item => item.executionId === receipt.executionId)) receipts.push(receipt)
  const localAutomationBlock = result?.source === 'automation' ? result.automationPending ? 'automation-pass-active' : receipts.some(item => item.outcome === 'running') ? 'execution-active' : receipts.some(item => ['submitted','uncertain','partial'].includes(item.outcome) || item.children.some(child => ['sending','submitted','uncertain'].includes(child.outcome))) ? 'execution-send-risk' : undefined : undefined
  const manualBlock = localAutomationBlock ?? result?.manualExecutionBlockedReason
  const searchReady = Boolean(settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey && settings.ai.apiKey)
  const coverage = plan?.coverage
  return <div className="search-layout"><div className="search-main">
    <div className="page-heading"><div><h1>Search<span className="heading-period">.</span></h1><p className="page-intro">Describe what you’re looking for. Scout researches one best-effort release-set plan.</p></div></div>
     <form className="search-composer" onSubmit={search}>
       <label className="field" htmlFor="search-prompt">What are you looking for?<textarea ref={promptInput} id="search-prompt" aria-label="What are you looking for?" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={'Describe a film, episode, or season. Add preferences in the same prompt, e.g. “original audio, English subtitles, preferably 1080p.”'} maxLength={MAX_SEARCH_PROMPT_LENGTH}/><span className="field-hint">Include media preferences or useful context in the same message.</span></label>
       {promptTooLong && <p role="status" className="field-hint">This saved prompt exceeds the 4,000-character manual search limit. Shorten it before starting a new search.</p>}
       <div className="search-form-actions"><button className="button button-primary" type="submit" disabled={busy || promptTooLong || !prompt.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <SearchIcon size={16}/>}Search releases</button></div>
      <p className="field-hint">Searching can incur model and indexer costs. Search never downloads automatically. Don’t include passwords or private links.</p>
    </form>
    {startError && <div role="alert" className="notice notice-error">{startError}</div>}
    {error && <div role="alert" className="notice notice-error">{error}{!searchMissing && <button className="text-button" onClick={() => searchId && void loadResult(searchId)}>Retry</button>}</div>}
    {execError && <div role="alert" className="notice notice-error">{execError}</div>}
    {notice && <div role="status" className="notice">{notice}</div>}
    {pendingCommit && pendingCommit.searchId === searchId && <div className="ops-warning-box pending-execution" role="status"><strong>Confirmation outcome not yet reconciled</strong><p>Retrying sends the same saved confirmation and idempotency key. It will not create a new submission identity.</p><button className="button button-secondary" type="button" disabled={execBusy || !active} onClick={() => void sendCommit(pendingCommit)}>{execBusy ? 'Checking saved confirmation…' : 'Retry same confirmation'}</button></div>}
    {result && <section className="search-results" aria-live="polite">
        <div className="search-result-heading"><div><h2>{result.status === 'matched' ? 'Search plan' : result.status === 'queued' ? 'Search queued' : result.status === 'running' ? 'Searching…' : result.status === 'no-match' ? 'No suitable match' : `Search ${result.status}`}</h2>{result.prompt && <p className="result-title prompt-preview">{result.prompt}</p>}{result.message && <p>{result.message}</p>}</div><span className="ops-status">{result.status}</span></div>
       {!!result.researchWarnings?.length && <div className="research-result-warnings" role="status"><strong>Research service notice</strong>{result.researchWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      {result.automationPending && <p role="status" className="ops-info-box">Automation is checking whether it can submit this set.</p>}
      {result.acquisition?.status === 'pending' && <p role="status" className="ops-info-box">Checking the download client for this acquisition.</p>}
      {result.acquisition?.code === 'prowlarr-rate-limited' && <p role="status" className="ops-info-box">Prowlarr rate-limited the download-client check. No releases were submitted.</p>}
      {!!result.automationWorkload?.deferredTargets && <p className="ops-info-box">{result.automationWorkload.deferredTargets} other due episodes were outside this search. They remain unsearched for a later pass.</p>}
      {result.prompt && <details className="saved-prompt"><summary>Saved search prompt</summary><pre tabIndex={0} aria-label="Exact saved search prompt">{result.prompt}</pre></details>}
      {result.status === 'queued' ? <p role="status" className="ops-state-panel"><LoaderCircle className="spin"/>{result.waitingReason === 'capacity' ? 'Waiting for search capacity' : result.waitingReason === 'settings-incomplete' ? 'Waiting for required settings' : result.waitingReason === 'provider-cooldown' ? `Provider cooldown${result.retryAt ? ` · retry after ${new Date(result.retryAt).toLocaleString()}` : ''}` : 'Search queued'}{result.queuePosition ? ` · ${Math.max(0, result.queuePosition - 1)} ahead` : ''}. It has not started yet.</p> : result.status === 'running' ? <p role="status" className="ops-state-panel"><LoaderCircle className="spin"/>Checking indexers and comparing releases…</p> : <>
         {plan?.status === 'matched' && <section className="release-set" aria-labelledby="selected-set"><div className="release-section-heading"><div><h3 id="selected-set">Selected release set</h3><p>{plan.selections.length} release{plan.selections.length === 1 ? '' : 's'} · whole set only</p></div>{receipt && <span className={`ops-status status-${receipt.outcome === 'submitted' ? 'mint' : receipt.outcome === 'uncertain' || receipt.outcome === 'partial' ? 'amber' : 'quiet'}`}>{receipt.outcome}</span>}</div>
          {plan.selections.map((selection, index) => { const evidence = byId.get(selection.candidateId)?.observations?.[0]; return <article className="ranked-option" key={`${selection.candidateId}-${index}`}><h4>{evidence?.title ?? `Selected release ${index + 1}`}</h4><p>{selection.reason}</p><p className="field-hint">{selection.coverage ?? 'Coverage is inferred from release metadata.'}{evidence?.indexer ? ` · ${evidence.indexer}` : ''}{evidence?.size ? ` · ${formatSize(evidence.size)}` : ''}{evidence?.seeders != null ? ` · ${evidence.seeders} seeders` : ''}</p>{selection.uncertainty && <p className="option-uncertainty">Worth checking: {selection.uncertainty}</p>}</article> })}
          <div className="coverage-grid"><Coverage title="Covered" values={plan.covered ?? coverage?.covered}/><Coverage title="Gaps" values={plan.gaps ?? coverage?.gaps}/><Coverage title="Deferred" values={plan.deferred ?? coverage?.deferred}/><Coverage title="Requested scope not covered" values={plan.scopeGaps ?? coverage?.broad?.gaps}/><Coverage title="Extras" values={plan.extras}/><Coverage title="Useful overlap" values={plan.usefulOverlap}/></div>
          <p className="coverage-note">Coverage is inferred from release names and indexer metadata, not verified file contents.</p>
          {!!plan.warnings?.length && <div className="plan-warnings">{plan.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
             {(!!localAutomationBlock || result.manualExecutionEligible === false || (result.source === 'automation' && result.manualExecutionEligible !== true)) ? (
               <div className="ops-info-box"><p>{manualBlock === 'candidate-expired' ? 'The selected releases have expired. Reuse the saved prompt to search again.' : manualBlock === 'automation-pass-active' ? 'The automation pass is still active; wait for it to finish.' : manualBlock === 'execution-active' ? 'An execution is still running; review its receipt.' : manualBlock === 'execution-send-risk' ? 'A prior submission was accepted or may have been accepted; this set cannot be submitted again.' : manualBlock === 'source-changed' ? 'The Prowlarr source changed; search again for current releases.' : `This ${result.source === 'arr' ? 'Arr-backed' : 'automated'} search is read-only here and cannot be manually submitted.`}</p>{manualBlock === 'candidate-expired' && result.prompt && <button type="button" className="button button-secondary" onClick={() => { setPrompt(result.prompt!); promptInput.current?.focus() }}>Reuse saved prompt</button>}</div>
             ) : (!pendingCommit && (result.source === 'automation' || !receipts.length)) ? (
              <div className="execution-entry">
                <p>Review the complete set, then explicitly confirm the Prowlarr destination. No download happens from search alone.</p>
                {clients.length === 0 ? (
                  <button className="button button-primary" disabled={!active || execBusy} onClick={event => { opener.current = event.currentTarget; void prepare() }}>{execBusy ? 'Loading clients…' : 'Choose Prowlarr client'}</button>
                ) : (
                  <div className="client-preparation" aria-label="Download client selection">
                    <label className="field">Prowlarr download client
                      <select value={clientId} onChange={event => setClientId(event.target.value)}>
                        <option value="">Choose a client</option>
                        {clients.map(client => <option key={client.id} value={client.id}>{client.name} · {client.protocol}{client.defaultCategory ? ` · default ${client.defaultCategory}` : ''}</option>)}
                      </select>
                    </label>
                    <button ref={prepareButton} className="button button-primary" disabled={!active || !clientId || execBusy} onClick={() => void prepareConfirmation()}>{execBusy ? 'Preparing…' : 'Prepare confirmation'}</button>
                  </div>
                )}
              </div>
            ) : null}
        </section>}
        {plan && plan.status === 'no-match' && <div className="ops-empty"><h3>No suitable release set</h3><p>{plan.message ?? result.message ?? 'Try a broader title or adjust your preferences, then search again.'}</p></div>}
        {plan && plan.status !== 'matched' && plan.status !== 'no-match' && <div className="ops-info-box"><p>{plan.message ?? result.message ?? 'This search needs a different request before a release set can be prepared.'}</p></div>}
        {!!result.diagnostics && <details className="query-trail"><summary>Search diagnostics</summary><p>Model turns: {result.diagnostics.modelTurns} · Stop reason: {result.diagnostics.stopReason}{result.diagnostics.elapsedMs !== undefined ? ` · ${result.diagnostics.elapsedMs} ms` : ''}</p>{result.diagnostics.usage?.cost !== undefined && <p>Estimated provider cost: {result.diagnostics.usage.cost}</p>}</details>}
        {!!result.candidates?.length && <details className="all-candidates"><summary>Other observed candidates ({result.candidates.length})</summary><ul>{result.candidates.slice(0, 40).map(candidate => <li key={candidate.candidateId}>{candidate.observations?.[0]?.title ?? 'Untitled candidate'}</li>)}</ul>{result.candidates.length > 40 && <p className="field-hint">Showing first 40 candidates.</p>}</details>}
       </>}
       {!receipts.length && result.source==='automation' && result.events?.some(event=>event.type==='submission') &&
         <section className="ops-info-box"><h3>Automatic submission</h3>{result.events.filter(event=>event.type==='submission').slice(-1).map((event,index)=><p key={index}>{typeof event.data.message==='string'?event.data.message:'The release set was not submitted.'}</p>)}</section>}
       {!!receipts.length && <section className="execution-receipts"><h3>Durable execution receipts</h3>{receipts.map(item=><ReceiptView key={item.executionId} receipt={item} plan={plan ?? { selections: [] }} candidates={byId}/>)}</section>}
    </section>}
  </div><aside className="search-rail" aria-label="Search information">
    <section className="rail-card search-rail-status"><div className="search-rail-icon"><Waves size={17}/></div><strong>{searchReady ? 'Search setup complete' : 'Setup needed'}</strong><p>{searchReady ? 'Services are configured. Searching uses live connections.' : 'Add a Prowlarr URL, API key, and model API key in Settings.'}</p><div className="search-checks"><span className={settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? 'configured' : ''}>{settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? <Check size={14}/> : <CircleAlert size={14}/>} Prowlarr {settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? 'configured' : 'needed'}</span><span className={settings.ai.apiKey ? 'configured' : ''}>{settings.ai.apiKey ? <Check size={14}/> : <CircleAlert size={14}/>} AI model {settings.ai.apiKey ? 'configured' : 'needed'}</span></div></section>
    <section className={`rail-card search-safety ${settings.safety.dryRun ? 'is-dry-run' : 'is-live'}`}><div className="search-rail-icon">{settings.safety.dryRun ? <ShieldCheck size={17}/> : <CircleAlert size={17}/>}</div><strong>Saved dry-run preference: {settings.safety.dryRun ? 'on' : 'off'}</strong><p>Confirmation uses the saved safety setting shown before commit. Manual confirmation is separate from scheduled automation.</p><a href="#settings">Review safety settings</a></section>
    <p className="search-rail-footnote">A submitted release means Prowlarr accepted it. Download completion and library import happen separately.</p>
  </aside>
  {confirmation && active && <div className="ops-dialog-backdrop" onMouseDown={event => { if (!execBusy && event.target === event.currentTarget) closeConfirmation() }}><div ref={dialog} className="ops-dialog ops-execution-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
     <header className="ops-dialog-head"><div><h2 id="confirm-title">Confirm whole release set</h2><p id="confirm-description">This confirms every release below. No episode assignment is required.</p></div><button className="icon-button" type="button" aria-label="Close confirmation" disabled={execBusy} onClick={closeConfirmation}><X size={17}/></button></header>
    <div className="ops-dialog-body">
      <div className={confirmation.dryRun ? 'ops-info-box' : 'ops-warning-box'}><ShieldCheck size={18}/><p>{confirmation.dryRun ? 'Dry-run is on. No download requests will be sent.' : 'Dry-run is off. Confirming sends these releases to Prowlarr.'} Submission acceptance is not download or import completion.</p></div>
       <div className="confirmation-facts"><p><strong>Client</strong>{confirmation.client.name} · {confirmation.client.protocol}</p>{confirmation.client.defaultCategory && <p><strong>Client default category</strong>{confirmation.client.defaultCategory}</p>}<p><strong>Configured categories</strong>{confirmation.client.configuredCategories.length ? confirmation.client.configuredCategories.map((item, i) => <span key={i}>{item.clientCategory ?? 'Default'}: {item.categories?.join(', ') ?? 'Prowlarr fallback'}</span>) : confirmation.client.defaultCategory ? 'None configured; using the client default.' : 'None configured; Prowlarr controls the default category.'}</p><p><strong>Confirmation expires</strong>{new Date(confirmation.expiresAt).toLocaleString()}</p></div>
      <h3>{confirmation.children.length === 1 ? 'One release' : `All ${confirmation.children.length} releases`}</h3>
      <ul className="confirmation-children">{confirmation.children.map(child => <li key={child.candidateId}><strong>{child.title}</strong><span>{child.effectiveCategory ? `Inferred category: ${child.effectiveCategory}` : 'Final category unknown'}</span><small>{child.categoryNote}</small></li>)}</ul>
      {execError && <p className="ops-inline-error" role="alert">{execError}</p>}
       <div className="ops-dialog-actions"><button ref={firstFocus} className="button button-secondary" disabled={execBusy} onClick={closeConfirmation}>Cancel</button><button className={`button ${confirmation.dryRun ? 'button-primary' : 'button-danger'}`} disabled={execBusy} onClick={() => void commit()}>{execBusy ? 'Recording receipt…' : confirmation.dryRun ? 'Run dry-run' : 'Confirm and submit set'}</button></div>
    </div>
  </div></div>}
  </div>
}
function Coverage({ title, values }: { title: string; values?: string[] }) { return <section className="coverage-group"><h4>{title}</h4>{items(values)}</section> }
function formatSize(value: number) { if (!Number.isFinite(value) || value <= 0) return ''; const units = ['B','KB','MB','GB','TB']; let size = value, unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ } return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}` }
function ReceiptView({ receipt, plan, candidates }: { receipt: Receipt; plan: { selections: Selection[] }; candidates: Map<string,Candidate> }) {
  const label = (value: string) => value === 'default' || value === 'default-category' ? 'Prowlarr client default' : value === 'configured-mapping' ? 'Configured category mapping' : value === 'direct' ? 'Direct category' : value
  return <article className="execution-receipt" aria-label={`Execution receipt: ${receipt.outcome}`}>
    <h4>Execution receipt</h4>
    <p className="receipt-outcome">Outcome: <strong>{receipt.outcome}</strong>{receipt.client && ` · ${receipt.client.name}`}{receipt.dryRun && ' · dry-run'}{receipt.updatedAt && ` · ${new Date(receipt.updatedAt).toLocaleString()}`}</p>
    <p className="field-hint">{receipt.outcome === 'submitted' ? 'Prowlarr accepted the submission; this does not mean it was downloaded or imported.' : receipt.outcome === 'uncertain' ? 'The submission outcome is uncertain. Check this durable receipt before taking any further action.' : receipt.outcome === 'partial' ? 'Some releases were accepted while others were not. Review each release below.' : receipt.message ?? 'Each selected release is listed with its recorded outcome.'}</p>
    <ul className="receipt-children">{receipt.children.map((child, index) => {
      const title = candidates.get(child.candidateId)?.observations?.[0]?.title ?? plan.selections.find(item=>item.candidateId===child.candidateId)?.coverage ?? `Selected release ${index + 1}`
      const tone = ['submitted', 'dry-run'].includes(child.outcome) ? 'mint' : ['rejected', 'uncertain'].includes(child.outcome) ? 'amber' : 'quiet'
      return <li key={`${child.candidateId}-${index}`}><strong>{title}</strong><span className={`ops-status status-${tone}`}>{child.outcome}</span>{child.effectiveCategory && <small>Inferred category: {child.effectiveCategory}</small>}{child.categoryRouting && <small>Routing: {label(child.categoryRouting)}</small>}{child.categoryNote && <small>{child.categoryNote}</small>}{child.message && <small>{child.message}</small>}</li>
    })}</ul>
  </article>
}
