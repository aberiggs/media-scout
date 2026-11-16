import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { JSDOM } from 'jsdom'
import { defaults } from './types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: dom.window.CustomEvent })
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) Object.defineProperty(globalThis, name, { configurable: true, value })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
const { cleanup, fireEvent, render, screen, within, waitFor } = await import('@testing-library/react')
const { default: App } = await import('./App')
const originalFetch = globalThis.fetch
const originalCrypto = globalThis.crypto
const env = { settings: defaults, status: { ready: false, missing: [], monitoringEnabled: false, cycleRunning: false } }
const matched = { searchId: 's1', status: 'matched', createdAt: '2026-11-15T00:00:00Z', prompt: 'Find Example', options: [{ optionId: 'o1', rank: 1, releases: [{ candidateId: 'c1' }], coveredTargetIds: [], reason: 'Best evidence', uncertainty: 'Audio not verified' }], candidates: [{ candidateId: 'c1', observations: [{ title: 'Example 1080p', indexer: 'Index', seeders: 20 }] }], events: [], counts: { decisions: 2, searches: 1, candidates: 1 } }

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto }) })

it('starts with Search, submits a prompt without downloading, and displays ranked evidence', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches' && init?.method === 'POST') return Response.json({ searchId: 's1', status: 'running' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json({ searchId: 's1', status: 'matched', createdAt: '2026-11-15T00:00:00Z', prompt: 'Find North Shore', options: [{ optionId: 'o1', rank: 1, releases: [{ candidateId: 'c1' }], coveredTargetIds: [], reason: 'Best evidence', uncertainty: 'Audio not verified' }], candidates: [{ candidateId: 'c1', observations: [{ title: 'North Shore 1080p', indexer: 'Example', size: 1000, seeders: 20, leechers: 2 }] }], events: [{ type: 'query-result', data: { query: 'North Shore', count: 4 } }], counts: { decisions: 2, searches: 1, candidates: 4 } })
    return Response.json({ items: [] })
  }
  render(<App />)
  assert.ok(await screen.findByRole('heading', { name: /Search/ }))
  assert.equal(screen.queryByRole('link', { name: 'Queue' }), null)
  const nav = screen.getByRole('navigation', { name: 'Workspace' })
  for (const label of ['Search', 'Activity', 'Automation', 'Settings']) assert.ok(within(nav).getByRole('link', { name: label }))
  assert.equal(screen.getByLabelText('What are you looking for?').getAttribute('aria-label'), 'What are you looking for?')
  assert.ok(screen.getByRole('complementary', { name: 'Search information' }))
  assert.ok(screen.getByText('Dry-run is on'))
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find North Shore' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByText('Best evidence')
  assert.ok(screen.getByText('Audio not verified'))
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
  assert.ok(await screen.findByRole('heading', { name: 'Search could not complete' }))
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
  for (const name of ['queued', 'rejected', 'deferred', 'expired']) assert.ok(statuses.queryByRole('option', { name }), `${name} is filterable`)
})

it('shows per-release submission history in saved search details', async () => {
  window.history.replaceState(null, '', '/#activity')
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url.startsWith('/api/v2/activity')) return Response.json({ items: [{ searchId: 's1', prompt: 'Saved request', status: 'matched', source: 'manual', createdAt: matched.createdAt }], total: 1 })
    return Response.json({ ...matched, events: [{ type: 'submission', data: { outcome: 'uncertain', outcomes: [{ candidateId: 'c1', outcome: 'submitted' }, { candidateId: 'c2', outcome: 'uncertain' }] } }] })
  }
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'View search details' }))
  assert.ok(await screen.findByRole('heading', { name: 'Submission history' }))
  assert.ok(screen.getByText('Example 1080p: submitted'))
  assert.ok(screen.getByText('Release 2: uncertain'))
  assert.equal(screen.queryByText('Submission is not proof of downloading or import.'), null)
})

it('sends numeric configured client IDs and reuses a submission key after transport failure', async () => {
  const bodies: Array<Record<string, unknown>> = []
  let randomCalls = 0
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(++randomCalls); return bytes } } })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches') return Response.json({ searchId: 's1' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json(matched)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 7, name: 'TV category', protocol: 'torrent', categories: true }] })
    if (url === '/api/v2/submissions') { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? Response.json({ error: 'Temporary failure' }, { status: 503 }) : Response.json({ outcome: 'dry-run' }) }
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Preview submission' }))
  await screen.findByRole('option', { name: /TV category/ })
  assert.ok(screen.getByText('Dry-run is on. No download will be submitted.'))
  assert.equal(screen.queryByText(/Scout does not cancel existing jobs/), null)
  fireEvent.change(screen.getByLabelText('Download client (optional)'), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm option' }))
  await screen.findByText('Temporary failure')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm option' }))
  await waitFor(() => assert.equal(bodies.length, 2))
  assert.equal(bodies[0]?.downloadClientId, 7)
  assert.equal(bodies[0]?.idempotencyKey, bodies[1]?.idempotencyKey)
  assert.match(String(bodies[0]?.idempotencyKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(randomCalls, 1, 'a retry reuses its idempotency key instead of generating a new one')
  assert.ok(await screen.findByText('Submission outcome: dry-run'))
  assert.equal(screen.queryByText(/Submitted does not mean imported/), null)
})

it('keeps live confirmation focused on the configured route without extra caveats', async () => {
  const settings = structuredClone(defaults)
  settings.safety.dryRun = false
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json({ ...env, settings })
    if (url === '/api/v2/searches') return Response.json({ searchId: 's1' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json(matched)
    if (url === '/api/v2/download-clients') return Response.json({ items: [] })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Choose and confirm download' }))
  const dialog = await screen.findByRole('dialog', { name: 'Confirm this option' })
  assert.ok(within(dialog).getByText('Choose the configured client and category route.'))
  assert.equal(within(dialog).queryByText(/Confirming may start a download/), null)
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
  const search = await screen.findByRole('button', { name: 'Search this item' })
  assert.ok(screen.getByRole('complementary', { name: 'Automation guidance' }))
  assert.ok(screen.getByText('Poll is explicit'))
  assert.equal(search.hasAttribute('disabled'), false)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved view' }))
  assert.equal(calls.some(c => c.url.endsWith('/poll')), false)
  fireEvent.click(screen.getByRole('button', { name: 'Poll now' }))
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
  assert.ok(await screen.findByRole('status'))
  assert.match(screen.getByRole('status').textContent ?? '', /clipboard.*unavailable.*copy it manually/i)
})

it('explains that expired results require a new search', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches') return Response.json({ searchId: 's1' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json(matched)
    if (url === '/api/v2/download-clients') return Response.json({ items: [] })
    if (url === '/api/v2/submissions') return Response.json({ outcome: 'expired', message: 'Search results expired; start a new search.' })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Preview submission' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm option' }))
  assert.ok(await screen.findByText('Search results expired. Start a new search before submitting.'))
})

it('manages confirmation focus for keyboard users and restores the option trigger', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/settings') return Response.json(env)
    if (url === '/api/v2/searches') return Response.json({ searchId: 's1' }, { status: 202 })
    if (url === '/api/v2/searches/s1') return Response.json(matched)
    if (url === '/api/v2/download-clients') return Response.json({ items: [{ id: 7, name: 'TV category', protocol: 'torrent', categories: true }] })
    return Response.json({ items: [] })
  }
  render(<App />)
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find Example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  const trigger = await screen.findByRole('button', { name: 'Preview submission' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: 'Confirm this option' })
  const close = within(dialog).getByRole('button', { name: 'Close confirmation' })
  assert.equal(document.activeElement, close)
  await screen.findByRole('option', { name: /TV category/ })
  const confirm = within(dialog).getByRole('button', { name: 'Confirm option' })
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  assert.ok(document.activeElement === confirm, 'reverse Tab wraps to the final control')
  confirm.focus()
  fireEvent.keyDown(document, { key: 'Tab' })
  assert.equal(document.activeElement, close)
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
  assert.ok(document.activeElement === trigger, 'focus returns to the option trigger')
})
