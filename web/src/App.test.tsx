import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { JSDOM } from 'jsdom'
import { defaults } from './types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: dom.window.CustomEvent })
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) Object.defineProperty(globalThis, name, { configurable: true, value })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
const { cleanup, fireEvent, render, screen, within, waitFor } = await import('@testing-library/react')
const { default: App } = await import('./App')
const originalFetch = globalThis.fetch
const originalCrypto = globalThis.crypto
const env = { settings: defaults, status: { ready: false, missing: [], monitoringEnabled: false, cycleRunning: false } }
const matched = { searchId: 's1', status: 'matched', createdAt: '2026-11-15T00:00:00Z', prompt: 'Find Example', plan: { version: 1, planId: 'p1', status: 'matched', selections: [{ candidateId: 'c1', targetIds: ['target-1'], reason: 'Best evidence', uncertainty: 'Audio not verified' }], coverage: { covered: ['target-1'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } }, warnings: [] }, candidates: [{ candidateId: 'c1', observations: [{ title: 'Example 1080p', indexer: 'Index', seeders: 20 }] }], events: [], counts: { decisions: 2, searches: 1, candidates: 1 } }

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); sessionStorage.clear(); globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto }) })

const semanticSearch = { ...matched, searchId: 'life', plan: { version: 2, planId: 'plan-life', status: 'matched', selections: [{ candidateId: 'c1', coverage: 'Season one', reason: 'Complete release set', uncertainty: '' }], covered: ['Season one'], gaps: [], deferred: [], scopeGaps: [], extras: [], usefulOverlap: [], broadCoverage: 'complete', coverage: { covered: ['Season one'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } } }, candidates: [{ candidateId: 'c1', observations: [{ title: 'Season One Pack' }] }] }
const preparedConfirmation = { confirmationId: 'confirm-life', expiresAt: '2099-01-01T00:00:00Z', searchId: 'life', planId: 'plan-life', version: 2, client: { id: 8, name: 'qBittorrent', protocol: 'torrent', configuredCategories: [], defaultCategory: 'tv' }, dryRun: true, children: [{ candidateId: 'c1', title: 'Season One Pack', effectiveCategory: 'tv', categoryRouting: 'default', categoryNote: 'Client default category: tv', releaseCategoryIds: [5000] }] }

function lifecycleFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    return handler(url, init)
  }
}

it('prepares and commits the complete semantic v2 release set and shows its receipt', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'v2', prompt: 'Find North Shore', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (url === '/api/v2/searches/v2') return Response.json({ ...matched, searchId: 'v2', plan: { version: 2, planId: 'plan-v2', status: 'matched', selections: [{ candidateId: 'c1', coverage: 'Season one with overlap', reason: 'Useful complete pack', uncertainty: '' }], covered: ['Season one'], gaps: [], deferred: [], scopeGaps: [], extras: ['Bonus episode'], usefulOverlap: ['Episode two'], broadCoverage: 'complete', coverage: { covered: ['Season one'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } } }, receipts: [] })
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json({ confirmationId: 'confirm-1', expiresAt: '2099-01-01T00:00:00Z', searchId: 'v2', planId: 'plan-v2', version: 2, client: { id: 8, name: 'qBittorrent', protocol: 'torrent', configuredCategories: [], defaultCategory: 'tv' }, dryRun: true, children: [{ candidateId: 'c1', title: 'North Shore complete pack', effectiveCategory: 'tv', categoryRouting: 'default', categoryNote: 'Prowlarr client default', releaseCategoryIds: [5000] }] })
    if (url === '/api/v2/executions/commit') return Response.json({ executionId: 'exec-1', searchId: 'v2', planId: 'plan-v2', version: 2, outcome: 'dry-run', updatedAt: '2026-11-15T00:00:00Z', dryRun: true, children: [{ candidateId: 'c1', outcome: 'dry-run', effectiveCategory: 'tv' }] })
    return Response.json({ items: [] })
  }
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="v2" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText(/Season one with overlap/))
  assert.ok(screen.getByText('Bonus episode'))
  assert.equal(screen.queryByText(/target-1/), null)
  fireEvent.click(screen.getByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  assert.ok(await screen.findByRole('dialog', { name: 'Confirm whole release set' }))
  assert.ok(screen.getByText('Client default category').parentElement?.textContent?.includes('tv'))
  assert.ok(screen.getByText('None configured; using the client default.'))
  fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))
  assert.ok(await screen.findByText('Execution receipt'))
  assert.ok(screen.getAllByText('dry-run').length > 0)
  const prepare = calls.find(call => call.url === '/api/v2/executions/prepare')
  assert.deepEqual(JSON.parse(String(prepare?.init?.body)), { searchId: 'v2', planId: 'plan-v2', version: 2, candidateIds: ['c1'], downloadClientId: 8 })
  const commit = calls.find(call => call.url === '/api/v2/executions/commit')
  assert.ok(commit)
  assert.deepEqual(Object.keys(JSON.parse(String(commit.init?.body))).sort(), ['confirmationId', 'idempotencyKey', 'planId', 'searchId', 'version'])
})

it('retries a transport-uncertain commit with the exact persisted request and idempotency key', async () => {
  const commits: string[] = []
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    if (url === '/api/v2/executions/commit') {
      commits.push(String(init?.body))
      if (commits.length === 1) return Promise.reject(new TypeError('connection lost'))
      return Response.json({ executionId: 'exec-life', searchId: 'life', outcome: 'dry-run', dryRun: true, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'dry-run' }] })
    }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run' }))
  assert.ok(await screen.findByRole('button', { name: 'Retry same confirmation' }))
  await screen.findAllByText(/The exact confirmation and idempotency key are saved/)
  assert.equal(Boolean(screen.queryByRole('dialog')), false, 'Only same-key recovery is offered after transport uncertainty')
  const saved = JSON.parse(sessionStorage.getItem('media-scout-execution-pending:life')!)
  assert.equal(saved.confirmationId, 'confirm-life')
  fireEvent.click(screen.getByRole('button', { name: 'Retry same confirmation' }))
  assert.ok(await screen.findByText('Execution receipt'))
  assert.equal(commits.length, 2)
  assert.deepEqual(JSON.parse(commits[0]!), JSON.parse(commits[1]!))
  assert.equal(JSON.parse(commits[0]!).idempotencyKey, saved.idempotencyKey)
  assert.equal(sessionStorage.getItem('media-scout-execution-pending:life'), null)
})

it('recovers the same pending commit after a page reload without preparing a new confirmation', async () => {
  const request = { confirmationId: 'persisted-confirm', searchId: 'life', planId: 'plan-life', version: 2, idempotencyKey: 'stable-key-from-before-reload' }
  sessionStorage.setItem('media-scout-execution-pending:life', JSON.stringify(request))
  let commitBody = ''
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/executions/commit') { commitBody = String(init?.body); return Response.json({ executionId: 'exec-recovered', searchId: 'life', outcome: 'submitted', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'submitted' }] }) }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={2} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same confirmation' }))
  assert.ok(await screen.findByRole('heading', { name: 'Execution receipt' }))
  assert.deepEqual(JSON.parse(commitBody), request)
})

it('retains the exact commit recovery key when an HTTP-success response body is interrupted', async () => {
  const commits: string[] = []
  lifecycleFetch((url, init) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    if (url === '/api/v2/executions/commit') {
      commits.push(String(init?.body))
      if (commits.length === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('body interrupted')) } }), { status: 200 })
      return Response.json({ executionId: 'body-recovered', searchId: 'life', outcome: 'submitted', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'submitted' }] })
    }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run' }))
  await waitFor(() => assert.equal(Boolean(screen.queryByRole('dialog')), false))
  assert.ok(sessionStorage.getItem('media-scout-execution-pending:life'))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same confirmation' }))
  assert.ok(await screen.findByRole('heading', { name: 'Execution receipt' }))
  assert.equal(commits[0], commits[1])
})

it('rejects an incomplete successful preparation without opening a broken dialog', async () => {
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json({ confirmationId: 'incomplete' })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  assert.ok(await screen.findByText(/Preparation response was incomplete/))
  assert.equal(Boolean(screen.queryByRole('dialog')), false)
})

for (const durable of [true, false]) it(`preserves ${durable ? 'durable' : 'event-only'} submission inspection for retired-format search results`, async () => {
  lifecycleFetch(url => url === '/api/v2/searches/life' ? Response.json({
    ...semanticSearch, plan: undefined, legacyResult: { options: [{ title: 'Retired result' }] },
    legacyReceipts: durable ? [{ searchId: 'life', outcome: 'uncertain', candidateIds: [], outcomes: [] }] : [],
    events: [{ type: 'submission', data: { outcome: durable ? 'EVENT MUST NOT OVERRIDE' : 'submitted' } }],
  }) : Response.json({}))
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByRole('heading', { name: 'Legacy search record' }))
  assert.ok(screen.getByRole('heading', { name: 'Historical submission receipts' }))
  const history = screen.getByRole('heading', { name: 'Historical submission receipts' }).parentElement!
  assert.ok(within(history).getByText(durable ? 'uncertain' : /submitted/))
  assert.equal(Boolean(screen.queryByText(/EVENT MUST NOT OVERRIDE/)), false)
})

it('clears only a definitive stale-confirmation rejection and allows fresh preparation', async () => {
  let preparations = 0
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json({ ...preparedConfirmation, confirmationId: `confirm-${++preparations}` })
    if (url === '/api/v2/executions/commit') return Response.json({ code: 'confirmation-expired', message: 'Confirmation expired.' }, { status: 409 })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run' }))
  assert.ok(await screen.findByText(/Prepare a fresh confirmation/))
  assert.equal(sessionStorage.getItem('media-scout-execution-pending:life'), null)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare confirmation' }))
  assert.ok(await screen.findByRole('dialog', { name: 'Confirm whole release set' }))
  assert.equal(preparations, 2)
})

it('does not show an old confirmation after selecting another search while prepare is pending', async () => {
  let resolvePrepare!: (response: Response) => void
  let started!: () => void
  const wasStarted = new Promise<void>(resolve => { started = resolve })
  lifecycleFetch((url) => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/searches/other') return Response.json({ ...semanticSearch, searchId: 'other' })
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') { started(); return new Promise<Response>(resolve => { resolvePrepare = resolve }) }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  const view = render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  await wasStarted
  view.rerender(<SearchPage settings={defaults} searchId="other" searchRevision={2} onSearchStarted={() => {}} />)
  resolvePrepare(Response.json({ ...preparedConfirmation, searchId: 'life' }))
  await waitFor(() => assert.ok(screen.getByText('Selected release set')))
  assert.equal(screen.queryByRole('dialog'), null)
})

it('ignores a delayed receipt poll for the previously selected search', async () => {
  let resolvePoll!: (response: Response) => void
  let polled!: () => void
  const pollStarted = new Promise<void>(resolve => { polled = resolve })
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json({ ...semanticSearch, receipts: [{ executionId: 'old-exec', searchId: 'life', outcome: 'running', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'sending' }] }] })
    if (url === '/api/v2/searches/other') return Response.json({ ...semanticSearch, searchId: 'other', receipts: [] })
    if (url === '/api/v2/executions/old-exec') { polled(); return new Promise<Response>(resolve => { resolvePoll = resolve }) }
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  const view = render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  await pollStarted
  view.rerender(<SearchPage settings={defaults} searchId="other" searchRevision={2} onSearchStarted={() => {}} />)
  resolvePoll(Response.json({ executionId: 'old-exec', searchId: 'life', outcome: 'uncertain', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'uncertain', message: 'OLD SEARCH RECEIPT' }] }))
  await screen.findByText('Search plan')
  assert.equal(screen.queryByText('OLD SEARCH RECEIPT'), null)
})

it('shows child progress from a polled receipt instead of the older history snapshot', async () => {
  const initial = { executionId: 'progress', searchId: 'life', outcome: 'running', dryRun: false, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'sending' }] }
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json({ ...semanticSearch, receipts: [initial] })
    if (url === '/api/v2/executions/progress') return Response.json({ ...initial, children: [{ candidateId: 'c1', outcome: 'submitted', message: 'Freshly recorded child progress' }] })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByText('Freshly recorded child progress'))
})

it('traps confirmation focus and restores focus to the actual prepare action', async () => {
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  const prepare = await screen.findByRole('button', { name: 'Prepare confirmation' })
  fireEvent.click(prepare)
  const dialog = await screen.findByRole('dialog', { name: 'Confirm whole release set' })
  assert.equal(document.activeElement?.textContent, 'Cancel')
  const buttons = within(dialog).getAllByRole('button')
  const close = buttons.find(button => button.getAttribute('aria-label') === 'Close confirmation')!
  const confirm = buttons.find(button => button.textContent === 'Run dry-run')!
  confirm.focus()
  fireEvent.keyDown(document, { key: 'Tab' })
  assert.equal(document.activeElement, close)
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, confirm)
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(screen.queryByRole('dialog'), null)
  await new Promise(resolve => window.setTimeout(resolve, 5))
  assert.equal(document.activeElement, prepare)
})

it('keeps the whole-set dialog open while a commit request is pending', async () => {
  let releaseCommit!: (response: Response) => void
  lifecycleFetch(url => {
    if (url === '/api/v2/searches/life') return Response.json(semanticSearch)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent', categoryMap: [] }] })
    if (url === '/api/v2/executions/prepare') return Response.json(preparedConfirmation)
    if (url === '/api/v2/executions/commit') return new Promise<Response>(resolve => { releaseCommit = resolve })
    return Response.json({})
  })
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Prowlarr client' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare confirmation' }))
  const confirm = await screen.findByRole('button', { name: 'Run dry-run' })
  fireEvent.click(confirm)
  await new Promise(resolve => window.setTimeout(resolve, 5))
  assert.ok(screen.getByRole('button', { name: 'Recording receipt…' }).hasAttribute('disabled'))
  const dialog = screen.getByRole('dialog')
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.mouseDown(dialog.parentElement!, { target: dialog.parentElement })
  assert.ok(screen.getByRole('dialog'))
  releaseCommit(Response.json({ executionId: 'exec-pending', searchId: 'life', outcome: 'dry-run', dryRun: true, updatedAt: new Date().toISOString(), children: [{ candidateId: 'c1', outcome: 'dry-run' }] }))
  assert.ok(await screen.findByRole('heading', { name: 'Execution receipt' }))
})

it('starts with Search, submits a prompt without downloading, and displays ranked evidence', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: 's1', status: 'running' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json({ searchId: 's1', status: 'matched', createdAt: '2026-11-15T00:00:00Z', prompt: 'Find North Shore', plan: { version: 1, planId: 'p1', status: 'matched', selections: [{ candidateId: 'c1', targetIds: ['target-1'], reason: 'Best evidence', uncertainty: 'Audio not verified' }], coverage: { covered: ['target-1'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } }, warnings: [] }, candidates: [{ candidateId: 'c1', observations: [{ title: 'North Shore 1080p', indexer: 'Example', size: 1000, seeders: 20, leechers: 2 }] }], events: [{ type: 'query-result', data: { query: 'North Shore', count: 4 } }], counts: { decisions: 2, searches: 1, candidates: 4 } })
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: /Search/ }))
  assert.equal(screen.queryByRole('link', { name: 'Queue' }), null)
  const nav = screen.getByRole('navigation', { name: 'Workspace' })
  for (const label of ['Search', 'Activity', 'Automation', 'Settings']) assert.ok(within(nav).getByRole('link', { name: label }))
  assert.equal(screen.getByLabelText('What are you looking for?').getAttribute('aria-label'), 'What are you looking for?')
  assert.ok(screen.getByRole('complementary', { name: 'Search information' }))
  assert.ok(screen.getAllByText(/Dry-run saved preference: on/)[0])
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find North Shore' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByText('Best evidence')
  assert.ok(screen.getAllByText(/Audio not verified/).length > 0)
  assert.deepEqual(JSON.parse(String(calls.find((call) => call.url === '/api/v2/searches' && call.init?.method === 'POST')?.init?.body)), { prompt: 'Find North Shore' })
  assert.equal(calls.some((call) => call.url === '/api/v2/submissions'), false)
})

it('labels failed searches as an operational error and shows the actionable cause', async () => {
  window.history.replaceState(null, '', '/#search')
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: 'busy-search', status: 'running' }, { status: 202 })
    if (url === '/api/v2/searches/busy-search') return Response.json({ searchId: 'busy-search', status: 'failed', prompt: 'Find Example', options: [], candidates: [], events: [{ type: 'error', data: { code: 'search-busy' } }], counts: { decisions: 0, searches: 0, candidates: 0 }, message: 'Another search is already running. Please retry after it finishes.' })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByRole('heading', { name: 'Search failed' }))
  assert.ok(screen.getAllByText(/another search is already running/i).length > 0)
})

it('shows a queued search and lets another request be submitted', async () => {
  window.history.replaceState(null, '', '/#search')
  let posts = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: `queued-${++posts}`, status: 'queued' }, { status: 202 })
    if (url.startsWith('/api/v2/searches/')) return Response.json({ searchId: url.split('/').at(-1), status: 'queued', prompt: 'Find Example', options: [], candidates: [], events: [], counts: { decisions: 0, searches: 0, candidates: 0 }, queuePosition: 2 })
    return Response.json({ items: [] })
  }
  render(<App />)
  const input = await screen.findByLabelText('What are you looking for?')
  fireEvent.change(input, { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByText(/queued · 1 ahead/i))
  fireEvent.change(input, { target: { value: 'Find Another' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByText(/queued · 1 ahead/i)
  assert.equal(posts, 2)
})

it('opens saved search details from Activity after navigating to Search', async () => {
  window.history.replaceState(null, '', '/#activity')
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (url === '/api/v2/searches/s1') return Response.json(matched)
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('Best evidence'))
})

it('retains an unsent search draft and optional details while navigating away and back', async () => {
  window.history.replaceState(null, '', '/#search')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [], total: 0 })
  render(<App />)
  const prompt = await screen.findByLabelText('What are you looking for?')
  fireEvent.change(prompt, { target: { value: 'Find a film' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add optional details' }))
  fireEvent.change(screen.getByLabelText('Preferences'), { target: { value: 'Original audio' } })
  fireEvent.change(screen.getByLabelText(/Structured context/), { target: { value: '{"kind":"movie"}' } })
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  assert.equal(document.querySelector('#search-workspace')?.hasAttribute('hidden'), true)
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.equal(await screen.findByLabelText('What are you looking for?'), prompt)
  assert.equal((prompt as HTMLTextAreaElement).value, 'Find a film')
  assert.equal((screen.getByLabelText('Preferences') as HTMLTextAreaElement).value, 'Original audio')
  assert.equal((screen.getByLabelText(/Structured context/) as HTMLTextAreaElement).value, '{"kind":"movie"}')
})

it('keeps the current result through navigation and lets Activity replace it with an older result', async () => {
  window.history.replaceState(null, '', '/#search')
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' ) return Response.json({ searchId: 'new-search' }, { status: 202 })
    if (url.startsWith('/api/v2/searches/')) {
      const id = url.split('/').at(-1)
      return Response.json({ ...matched, searchId: id, prompt: id === 'new-search' ? 'New search' : 'Old search', plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: id === 'new-search' ? 'New evidence' : 'Old evidence' }] } })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'old-search', prompt: 'Old search', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'New search' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByRole('heading', { name: 'Search plan' }))
  assert.ok(screen.getByText('New evidence'))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.ok(await screen.findByText('New evidence'))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' })); fireEvent(window, new dom.window.Event('hashchange'))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('Old evidence'))
  assert.equal(calls.filter(url => url === '/api/v2/searches').length, 1)
  assert.equal(calls.filter(url => url === '/api/v2/searches/new-search').length, 1)
})

it('continues polling a running search while its workspace is hidden', async () => {
  window.history.replaceState(null, '', '/#search')
  let reads = 0
  let posts = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' ) { posts++; return Response.json({ searchId: 'live-search' }, { status: 202 }) }
    if (url === '/api/v2/searches/live-search') {
      reads++
      return Response.json({ ...matched, searchId: 'live-search', status: reads === 1 ? 'running' : 'matched', plan: reads === 1 ? undefined : matched.plan })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [], total: 0 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  assert.ok(await screen.findByText(/Checking indexers and comparing releases/))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' })); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  await waitFor(() => assert.ok(reads >= 2), { timeout: 2500 })
  assert.equal(posts, 1)
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.ok(await screen.findByText('Best evidence'))
})

it('ignores a delayed manual-search response after a newer history selection', async () => {
  window.history.replaceState(null, '', '/#search')
  let finishPost!: (response: Response) => void
  const latePost = new Promise<Response>(resolve => { finishPost = resolve })
  const reads: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return latePost
    if (url.startsWith('/api/v2/searches/')) {
      const id = url.split('/').at(-1)!
      reads.push(id)
      return Response.json({ ...matched, searchId: id, plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: id === 'history-a' ? 'History A evidence' : 'Late manual evidence' }] } })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'history-a', prompt: 'Saved A', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Manual request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('History A evidence'))
  finishPost(Response.json({ searchId: 'late-manual' }, { status: 202 }))
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Search releases' }) as HTMLButtonElement).disabled, false))
  assert.deepEqual(reads, ['history-a'])
})

it('makes a delayed manual search discoverable after ordinary navigation', async () => {
  window.history.replaceState(null, '', '/#search')
  let finishPost!: (response: Response) => void
  const latePost = new Promise<Response>(resolve => { finishPost = resolve })
  const reads: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return latePost
    if (url === '/api/v2/searches/late-manual') {
      reads.push('late-manual')
      return Response.json({ ...matched, searchId: 'late-manual', plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: 'Late manual evidence' }] } })
    }
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [], total: 0 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Manual request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  await screen.findByText('A record of searches, recommendations, and per-release submission outcomes.')
  finishPost(Response.json({ searchId: 'late-manual' }, { status: 202 }))
  await waitFor(() => assert.deepEqual(reads, ['late-manual']))
  fireEvent.click(screen.getByRole('link', { name: 'Search' })); fireEvent(window, new dom.window.Event('hashchange'))
  assert.ok(await screen.findByText('Late manual evidence'))
})

it('reloads an explicitly reopened history result when its ID is already selected', async () => {
  window.history.replaceState(null, '', '/#activity')
  let historyReads = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 'history-a', prompt: 'Saved A', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (url === '/api/v2/searches/history-a') {
      historyReads++
      return Response.json({ ...matched, searchId: 'history-a', plan: { ...matched.plan!, selections: [{ ...matched.plan!.selections[0]!, reason: 'History A evidence' }] } })
    }
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ error: 'Manual request failed' }, { status: 503 })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('History A evidence'))
  fireEvent.change(await screen.findByLabelText('What are you looking for?'), { target: { value: 'Manual request' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByRole('alert')
  assert.equal(screen.queryByText('History A evidence'), null)
  fireEvent.click(document.querySelector('a[href="#activity"]')!); fireEvent(window, new dom.window.Event('hashchange'))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('History A evidence'))
  assert.equal(historyReads, 2)
})

it('filters Activity by media and inclusive local dates and offers every submission outcome', async () => {
  window.history.replaceState(null, '', '/#activity')
  const queries: URLSearchParams[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    queries.push(new URL(url, 'http://localhost').searchParams)
    return Response.json({ items: [], total: 0 })
  }
  render(<App />)
  await screen.findByText('No matching activity')
  assert.ok(screen.getByRole('complementary', { name: 'Activity information' }))
  fireEvent.change(screen.getByLabelText('Media'), { target: { value: 'tv' } })
  fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '2026-11-01' } })
  fireEvent.change(screen.getByLabelText('Created through'), { target: { value: '2026-11-15' } })
  await waitFor(() => {
    const query = queries.at(-1)!
    assert.equal(query.get('kind'), 'tv')
    assert.equal(query.get('createdAtFrom'), new Date('2026-11-01T00:00:00').toISOString())
    assert.equal(query.get('createdAtTo'), new Date('2026-11-15T23:59:59.999').toISOString())
    assert.equal(query.get('offset'), '0')
  })
  const statuses = within(screen.getByLabelText('Status'))
  for (const name of ['queued', 'rejected', 'partial', 'not-attempted', 'deferred', 'expired']) assert.ok(statuses.queryByRole('option', { name }), `${name} is filterable`)
})

it('renders all durable receipt children and suppresses unsafe event fallback when legacy receipts exist', async () => {
  const result = { ...semanticSearch, receipts: [
    { executionId: 'exec-partial', searchId: 'life', outcome: 'partial', dryRun: false, updatedAt: '2026-11-19T12:00:00.000Z', client: { name: 'Client A', defaultCategory: 'tv' }, children: [{ candidateId: 'c1', outcome: 'submitted', categoryRouting: 'default', categoryNote: 'Client default: tv' }, { candidateId: 'c2', outcome: 'not-attempted', message: 'Stopped after prior rejection.' }] },
    { executionId: 'exec-rejected', searchId: 'life', outcome: 'rejected', dryRun: false, updatedAt: '2026-11-19T12:01:00.000Z', children: [{ candidateId: 'c1', outcome: 'rejected', categoryRouting: 'configured-mapping' }] },
  ], legacyReceipts: [{ searchId: 'life', optionId: 'legacy-option', outcome: 'uncertain', candidateIds: ['c1'], outcomes: [{ candidateId: 'c1', outcome: 'submitted' }] }], events: [{ type: 'submission', data: { secret: 'SHOULD-NOT-RENDER' } }] }
  lifecycleFetch(url => url === '/api/v2/searches/life' ? Response.json(result) : Response.json({}))
  const { SearchPage } = await import('./Search')
  render(<SearchPage settings={defaults} searchId="life" searchRevision={1} onSearchStarted={() => {}} />)
  assert.ok(await screen.findByRole('heading', { name: 'Durable execution receipts' }))
  assert.equal(screen.getAllByRole('heading', { name: 'Execution receipt' }).length, 2)
  assert.ok(screen.getByText('not-attempted'))
  assert.ok(screen.getByText(/Prowlarr client default/))
  assert.ok(screen.getByText(/Configured category mapping/))
  assert.ok(screen.getByRole('heading', { name: 'Historical submission receipts' }))
  assert.equal(screen.queryByText('SHOULD-NOT-RENDER'), null)
})

it('shows an unknown count while the initial Activity request is pending', async () => {
  window.history.replaceState(null, '', '/#activity')
  let finishRequest!: (response: Response) => void
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') return Response.json(env)
    return new Promise<Response>(resolve => { finishRequest = resolve })
  }
  render(<App />)
  await screen.findByText('Loading activity…')
  const rail = screen.getByRole('complementary', { name: 'Activity information' })
  assert.ok(within(rail).getByText('—'))
  assert.ok(within(rail).getByText('Count unavailable'))
  assert.ok(screen.getByText(/— searches · Count unavailable/))
  assert.ok(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'))
  finishRequest(Response.json({ items: [], total: 0 }))
  await waitFor(() => assert.ok(within(rail).getByText('0')))
})

it('offers retry after initial Activity failure and displays the recovered count', async () => {
  window.history.replaceState(null, '', '/#activity')
  let attempts = 0
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') return Response.json(env)
    if (++attempts === 1) return Response.json({ error: 'Unavailable' }, { status: 503 })
    return Response.json({ items: [], total: 7 })
  }
  render(<App />)
  await screen.findByRole('alert')
  const rail = screen.getByRole('complementary', { name: 'Activity information' })
  assert.ok(within(rail).getByText('—'))
  assert.ok(within(rail).getByText('Count unavailable'))
  assert.ok(screen.getByText(/— searches · Count unavailable/))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => assert.ok(within(rail).getByText('7')))
  assert.ok(within(rail).getByText('recorded searches'))
  assert.equal(attempts, 2)
})

it('shows a real zero count after a successful empty Activity response', async () => {
  window.history.replaceState(null, '', '/#activity')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [], total: 0 })
  render(<App />)
  await screen.findByText('No matching activity')
  const rail = screen.getByRole('complementary', { name: 'Activity information' })
  assert.ok(within(rail).getByText('0'))
  assert.ok(within(rail).getByText('recorded searches'))
  assert.equal(within(rail).queryByText('Count unavailable'), null)
})

it('hides stale Activity rows and disables pagination when a filtered request fails', async () => {
  window.history.replaceState(null, '', '/#activity')
  let activityRequests = 0
  const queries: URLSearchParams[] = []
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') return Response.json(env)
    queries.push(new URL(String(input), 'http://localhost').searchParams)
    activityRequests++
    if (activityRequests === 1) return Response.json({ items: [{ searchId: 'old', prompt: 'Old result', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 51 })
    if (activityRequests === 2) return Response.json({ error: 'Filter request failed' }, { status: 503 })
    return Response.json({ items: [{ searchId: 'fresh', prompt: 'Filtered result', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
  }
  render(<App />)
  assert.ok(await screen.findByText('Old result'))
  assert.equal(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'), false)
  const query = screen.getByRole('textbox', { name: 'Filter searches' })
  fireEvent.change(query, { target: { value: 'new filter' } })
  await screen.findByRole('alert')
  assert.equal((query as HTMLInputElement).value, 'new filter')
  assert.equal(screen.queryByText('Old result'), null)
  assert.equal(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled'), true)
  assert.equal(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled'), true)
  assert.ok(screen.getByText('Count unavailable'))
  assert.ok(screen.getByText(/— searches · Count unavailable/))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  assert.ok(await screen.findByText('Filtered result'))
  assert.equal(queries.at(-1)?.get('q'), 'new filter')
  assert.equal(queries.at(-1)?.get('offset'), '0')
})

it('renders a nested read-only plan without acquisition controls or submission requests', async () => {
  window.history.replaceState(null, '', '/#activity')
  const requests: string[] = []
  globalThis.fetch = async input => { const url = String(input); requests.push(url); if (url === '/api/settings') return Response.json(env); if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 }); return Response.json(matched) }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByText('Best evidence'))
  assert.ok(screen.getByText('target-1'))
  assert.ok(screen.getAllByText(/Audio not verified/).length > 0)
  assert.ok(screen.getAllByText(/execution is unavailable/i)[0])
  assert.equal(screen.queryByRole('button', { name: /^(run dry-run|confirm and submit set|prepare confirmation|choose prowlarr client)$/i }), null)
  assert.equal(requests.some(url => /submissions|download-clients/.test(url)), false)
})

it('keeps historical submission receipts inspectable without offering execution', async () => {
  window.history.replaceState(null, '', '/#activity')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : String(input).startsWith('/api/v2/activity') ? Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 }) : Response.json({ ...matched, events: [{ type: 'submission', data: { outcome: 'uncertain', outcomes: [{ candidateId: 'c1', outcome: 'submitted' }] } }] })
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByRole('heading', { name: 'Historical submission receipts' }))
  assert.ok(screen.getAllByText(/uncertain/).length > 0)
  assert.equal(screen.queryByRole('button', { name: /^(run dry-run|confirm and submit set|prepare confirmation|choose prowlarr client)$/i }), null)
})

it('keeps search available in dry-run and distinguishes a saved refresh from a live poll', async () => {
  window.history.replaceState(null, '', '/#automation')
  const calls: Array<{ url: string; method?: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method })
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/automation') return Response.json({ enabled: false, dryRun: true, running: false, providers: [], items: [{ targetId: 'one', title: 'Example', kind: 'tv', seasonNumber: 1, episodeNumber: 1, status: 'missing', eligible: true }] })
    if (url === '/api/v2/automation/poll') return Response.json({ ran: false, reason: 'disabled' })
    return Response.json({ searchId: 's1' }, { status: 202 })
  }
  render(<App />)
  await screen.findByText(/Items to watch/)
  assert.ok(screen.getByRole('complementary', { name: 'Automation guidance' }))
  assert.ok(screen.getByText('Poll is explicit'))
  assert.equal(screen.queryByRole('button', { name: 'Search this item' }), null)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved view' }))
  assert.equal(calls.some(c => c.url.endsWith('/poll')), false)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Arr observations' }))
  await waitFor(() => assert.equal(calls.filter(c => c.url.endsWith('/poll')).length, 1))
})

it('distinguishes a known empty actionable list from unavailable Arr observations', async () => {
  window.history.replaceState(null, '', '/#automation')
  let known = true
  let partialInventory = false
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/automation') return Response.json({ enabled: false, dryRun: true, running: false, providers: ['sonarr', 'radarr'].map(provider => ({ provider, known, observedAt: '2026-11-15T00:00:00Z', unidentifiedQueueRows: 0, ...(partialInventory && provider === 'sonarr' ? { unknownSeriesIds: ['42'] } : {}) })), items: [] })
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'No items to watch right now' }))
  cleanup()
  partialInventory = true
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'No items to show' }))
  assert.ok(screen.getByText(/could not be fully checked/i))
  cleanup()
  partialInventory = false
  known = false
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'No items to show' }))
  assert.ok(screen.getByText(/list may be incomplete/i))
})

it('keeps Settings sections scannable and distinguishes required from optional services', async () => {
  window.history.replaceState(null, '', '/#settings')
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [] })
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: 'Search services' }))
  assert.ok(screen.getByRole('complementary', { name: 'Instance information' }))
  assert.equal(screen.getAllByText('Optional').length, 2)
  assert.ok(screen.getByRole('button', { name: 'Reveal Prowlarr API key' }))
  assert.ok(screen.getByRole('spinbutton', { name: /Search-only retry \(minutes\)/ }))
})

it('places automation defaults and client choices in Automation and saves download permission only on explicit save', async () => {
  window.history.replaceState(null, '', '/#settings')
  const saved: any[] = []
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && init?.method === 'PUT') {
      const settings = JSON.parse(String(init.body)); saved.push(settings)
      return Response.json({ settings, status: env.status })
    }
    if (String(input) === '/api/settings') return Response.json({ ...env, settings: { ...defaults, version: 4, monitoring: { ...defaults.monitoring, allowDownloads: false }, integrations: { ...defaults.integrations, prowlarr: { ...defaults.integrations.prowlarr, tvClient: 'old-client' } } } })
    if (String(input) === '/api/v2/download-clients') return Response.json({ items: [{ id: 8, name: 'qBittorrent', protocol: 'torrent' }] })
    return Response.json({ items: [] })
  }
  render(<App />)
  await screen.findByRole('heading', { name: 'Search services' })
  const permission = await screen.findByRole('switch', { name: 'Allow automatic downloads' })
  assert.equal(screen.getByRole('textbox', { name: 'Automation media preferences' }).closest('section')?.querySelector('h2')?.textContent, 'Automation and retries')
  assert.equal(permission.getAttribute('aria-checked'), 'false')
  assert.ok(screen.getByRole('textbox', { name: 'Automation media preferences' }))
  assert.ok(screen.getByRole('combobox', { name: /TV download client/ }).textContent?.includes('old-client'))
  fireEvent.click(permission)
  assert.equal(saved.length, 0)
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => assert.equal(saved.at(-1)?.monitoring.allowDownloads, true))
  assert.equal(saved.at(-1)?.monitoring.enabled, false)
})

it('shows gated automation state and links to recent automation receipts without enabling execution controls', async () => {
  window.history.replaceState(null, '', '/#automation')
  let activityUrl = ''
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json({ ...env, settings: { ...defaults, version: 4, monitoring: { ...defaults.monitoring, allowDownloads: false } } })
    if (url === '/api/v2/automation') return Response.json({ enabled: true, allowDownloads: false, dryRun: true, running: false, executionBlocked: true, executionBlockedReason: 'downloads-not-activated', providers: [], items: [] })
    if (url.startsWith('/api/v2/activity')) { activityUrl = url; return Response.json({ items: [{ searchId: 'auto-1', prompt: 'Automated search', status: 'matched', source: 'automation', createdAt: matched.createdAt }], total: 1 }) }
    if (url === '/api/v2/searches/auto-1') return Response.json({ ...semanticSearch, searchId: 'auto-1', source: 'automation', manualExecutionEligible: false })
    return Response.json({})
  }
  render(<App />)
  assert.ok(await screen.findByText(/Monitoring: on/))
  assert.ok(screen.getAllByText(/automatic downloads are not allowed/i).length)
  fireEvent.click(screen.getByRole('button', { name: 'View search details' }))
  await screen.findByText('Search plan')
  assert.match(activityUrl, /source=automation/)
  assert.equal(screen.queryByRole('button', { name: /prepare confirmation|search this item|confirm and submit/i }), null)
})

it('shows server validation details as an error and preserves the rejected form values', async () => {
  window.history.replaceState(null, '', '/#settings')
  let submitted: Record<string, any> | undefined
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && !init?.method) return Response.json(env)
    if (String(input) === '/api/settings' && init?.method === 'PUT') {
      submitted = JSON.parse(String(init.body))
      return Response.json({ error: 'Invalid settings', issues: [{ path: ['monitoring', 'failureBackoffMaxMinutes'], message: 'must be at least failureBackoffMinMinutes', code: 'custom' }] }, { status: 400 })
    }
    return Response.json({ items: [] })
  }
  render(<App />)
  const minimum = await screen.findByRole('spinbutton', { name: /Initial failure backoff \(minutes\)/ })
  const maximum = screen.getByRole('spinbutton', { name: /Maximum failure backoff \(minutes\)/ })
  fireEvent.change(minimum, { target: { value: '90' } })
  fireEvent.change(maximum, { target: { value: '30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  const error = await screen.findByRole('alert')
  assert.match(error.textContent ?? '', /Maximum failure backoff.*must be at least Initial failure backoff/i)
  assert.equal((maximum as HTMLInputElement).value, '30')
  assert.equal(submitted?.monitoring.failureBackoffMaxMinutes, 30)
})

it('uses committed safety settings across navigation while preserving drafts and failed saves', async () => {
  window.history.replaceState(null, '', '/#settings')
  const committed = structuredClone(defaults)
  committed.safety.dryRun = false
  let putFails = true
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && init?.method === 'PUT') {
      if (putFails) return Response.json({ error: 'no' }, { status: 500 })
      const value = JSON.parse(String(init.body))
      return Response.json({ ...env, settings: value })
    }
    if (String(input) === '/api/settings') return Response.json({ ...env, settings: committed })
    if (String(input).startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (String(input).startsWith('/api/v2/searches/')) return Response.json(matched)
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Dry-run mode' }))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' }))
  assert.ok(await screen.findByText(/unsaved settings/i))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findAllByText(/execution is unavailable/i).then(items => items[0]!))
  assert.ok(screen.getAllByText(/Dry-run saved preference: off/)[0])
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
  assert.equal((await screen.findByRole('switch', { name: 'Dry-run mode' })).getAttribute('aria-checked'), 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByRole('alert')
  assert.ok(screen.getByText(/unsaved settings/i))
  fireEvent.click(screen.getByRole('link', { name: 'Search' }))
  assert.ok(await screen.findAllByText(/execution is unavailable/i).then(items => items[0]!))
})

it('blocks operational search when committed settings cannot be loaded and allows retry', async () => {
  let attempts = 0
  globalThis.fetch = async input => {
    if (String(input) === '/api/settings') {
      if (++attempts === 1) return Response.json({ error: 'offline' }, { status: 503 })
      return Response.json(env)
    }
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByText(/could not load settings/i))
  assert.equal(screen.queryByRole('button', { name: 'Search releases' }), null)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  assert.ok(await screen.findByRole('button', { name: 'Search releases' }))
  assert.equal(attempts, 2)
})

it('uses committed dry-run after a draft turns it off, and save success commits the draft', async () => {
  window.history.replaceState(null, '', '/#settings')
  const committed = structuredClone(defaults)
  committed.safety.dryRun = true
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/settings' && init?.method === 'PUT') return Response.json({ ...env, settings: JSON.parse(String(init.body)) })
    if (String(input) === '/api/settings') return Response.json({ ...env, settings: committed })
    if (String(input).startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    if (String(input).startsWith('/api/v2/searches/')) return Response.json(matched)
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Dry-run mode' }))
  fireEvent.click(screen.getByRole('link', { name: 'Activity' }))
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findAllByText(/execution is unavailable/i).then(items => items[0]!))
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
  await screen.findByText('Settings saved.')
  fireEvent.click(screen.getByRole('link', { name: 'Search' }))
  assert.ok(await screen.findAllByText(/execution is unavailable/i).then(items => items[0]!))
})

it('keeps a cleared numeric field blank instead of silently turning it into zero', async () => {
  window.history.replaceState(null, '', '/#settings')
  const writes: string[] = []
  globalThis.fetch = async (input, init) => { writes.push(`${String(input)}:${init?.method ?? 'GET'}`); return String(input) === '/api/settings' ? Response.json(env) : Response.json({ items: [] }) }
  render(<App />)
  const limit = await screen.findByRole('spinbutton', { name: /Indexer searches/ }) as HTMLInputElement
  fireEvent.change(limit, { target: { value: '' } })
  assert.equal(limit.value, '')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  assert.equal(writes.includes('/api/settings:PUT'), false)
})

it('provides working reveal and copy controls for API keys', async () => {
  window.history.replaceState(null, '', '/#settings')
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  const configured = structuredClone(defaults)
  configured.integrations.prowlarr.apiKey = 'prowlarr-test-key'
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json({ ...env, settings: configured }) : Response.json({ items: [] })
  render(<App />)
  const key = await screen.findByLabelText('Prowlarr API key') as HTMLInputElement
  assert.equal(key.type, 'password')
  fireEvent.click(screen.getByRole('button', { name: 'Reveal Prowlarr API key' }))
  assert.equal(key.type, 'text')
  fireEvent.click(screen.getByRole('button', { name: 'Copy Prowlarr API key' }))
  await waitFor(() => assert.equal(copied, 'prowlarr-test-key'))
})

it('explains when secure clipboard access is unavailable instead of silently ignoring copy', async () => {
  window.history.replaceState(null, '', '/#settings')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('insecure context') } } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  const configured = structuredClone(defaults)
  configured.integrations.prowlarr.apiKey = 'prowlarr-test-key'
  globalThis.fetch = async input => String(input) === '/api/settings' ? Response.json({ ...env, settings: configured }) : Response.json({ items: [] })
  render(<App />)
  await screen.findByLabelText('Prowlarr API key')
  fireEvent.click(screen.getByRole('button', { name: 'Copy Prowlarr API key' }))
  assert.ok(await screen.findByText('Clipboard is unavailable. Reveal the key and copy it manually.'))
})
