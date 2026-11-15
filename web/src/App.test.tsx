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
const env = { settings: defaults, status: { ready: false, missing: [], monitoringEnabled: false, cycleRunning: false } }
const matched = { searchId: 's1', status: 'matched', createdAt: '2026-11-15T00:00:00Z', prompt: 'Find Example', options: [{ optionId: 'o1', rank: 1, releases: [{ candidateId: 'c1' }], coveredTargetIds: [], reason: 'Best evidence', uncertainty: 'Audio not verified' }], candidates: [{ candidateId: 'c1', observations: [{ title: 'Example 1080p', indexer: 'Index', seeders: 20 }] }], events: [], counts: { decisions: 2, searches: 1, candidates: 1 } }

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); globalThis.fetch = originalFetch })

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
  fireEvent.change(screen.getByLabelText('What are you looking for?'), { target: { value: 'Find North Shore' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search releases' }))
  await screen.findByText('Best evidence')
  assert.ok(screen.getByText('Audio not verified'))
  assert.deepEqual(JSON.parse(String(calls.find((call) => call.url === '/api/v2/searches' && call.init?.method === 'POST')?.init?.body)), { prompt: 'Find North Shore' })
  assert.equal(calls.some((call) => call.url === '/api/v2/submissions'), false)
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

it('sends numeric configured client IDs and reuses a submission key after transport failure', async () => {
  const bodies: Array<Record<string, unknown>> = []
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
  fireEvent.change(screen.getByLabelText('Download client (optional)'), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm option' }))
  await screen.findByText('Temporary failure')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm option' }))
  await waitFor(() => assert.equal(bodies.length, 2))
  assert.equal(bodies[0]?.downloadClientId, 7)
  assert.equal(bodies[0]?.idempotencyKey, bodies[1]?.idempotencyKey)
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
  assert.equal(search.hasAttribute('disabled'), false)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved view' }))
  assert.equal(calls.some(c => c.url.endsWith('/poll')), false)
  fireEvent.click(screen.getByRole('button', { name: 'Poll now' }))
  await waitFor(() => assert.equal(calls.filter(c => c.url.endsWith('/poll')).length, 1))
})
