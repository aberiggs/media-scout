import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver })) Object.defineProperty(globalThis, name, { configurable: true, value })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const { Benchmarks } = await import('./Benchmarks')
const originalFetch = globalThis.fetch
const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
after(() => dom.window.close())
let activeRun = true

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
const catalog = { datasets: [{ id: 'pilot', revision: 1, labelStatus: 'reviewed', cases: 2, hash: 'a'.repeat(64), notes: 'Reviewed pilot' }], profiles: [{ id: 'profile', label: 'Home profile', models: ['vendor/model'], ready: true }], prompts: ['production-v1', 'benchmark-data-only-v1'], tracks: ['plan-single', 'pick-single'], limits: { maxAttempts: 500, maxSeconds: 1800, maxDollars: 25, concurrency: 1, maxFiles: 100, maxBytes: 100000000 }, accounting: 'Hard-dollar mode reserves full advertised context and bounded output per transport attempt; provider price ceilings required. Missing cost remains unknown and keeps its reservation. No automatic paid restart.' }
const summary = { completedCases: 0, plannedCases: 2, attempts: 0, knownCost: 0, totalCost: 0, unknownCostAttempts: 0, inputTokens: 0, outputTokens: 0, attemptLatencyMs: 0, retries: 0, correct: 0, unsafeProposals: 0, validatorRejections: 0, providerFailures: 0, justifiedAbstentions: 0, avoidableAbstentions: 0, unsupportedRetrieval: 0, stages: [] }
const config = { requestId: 'request-1', datasetId: 'pilot', datasetRevision: 1, profileId: 'profile', model: 'vendor/model', prompt: 'production-v1', tracks: ['plan-single'], split: 'all', repeats: 1, maxAttempts: 100, maxTokens: 128000000, maxOutputTokens: 1024, maxSeconds: 1800, maxDollars: 2, disclosureApproved: true }
const run = { schemaVersion: 1, id: 'run-1', datasetId: 'pilot', datasetRevision: 1, status: 'running', attempts: [], config, createdAt: '2026-10-01T00:00:00.000Z', finishedAt: null, results: [], plannedCases: 2 }

describe('benchmark page', () => {
  beforeEach(() => { requests.length = 0; activeRun = true; globalThis.fetch = async (input, init) => { requests.push({ input, init }); const url = new URL(String(input), 'http://localhost'); if (url.pathname === '/api/benchmarks') return response(catalog); if (url.pathname === '/api/benchmarks/runs' && init?.method === 'POST') return response(run, 202); if (url.pathname === '/api/benchmarks/runs') return response({ runs: [{ ...run, status: activeRun ? 'running' : 'completed' }], total: 1 }); if (url.pathname === '/api/benchmarks/runs/run-1') return response({ run: { ...run, status: activeRun ? 'running' : 'completed' }, summary, totalResults: 0, totalAttempts: 0, offset: 0, limit: 50 }); if (url.pathname.endsWith('/cancel')) return response({ id: 'run-1', status: 'cancelled', cancelRequested: true }); return response({ error: 'unexpected' }, 404) } })
  afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); globalThis.fetch = originalFetch })

  it('launches only after disclosure and explicit paid confirmation with the exact bounded config', async () => {
    activeRun = false
    render(<Benchmarks />)
    await screen.findByRole('heading', { name: 'Configure a run' })
    assert.ok(screen.getByText(/reserves full advertised context/))
    const acknowledge = screen.getByLabelText(/I have read the provider disclosure/)
    fireEvent.click(acknowledge)
    fireEvent.click(screen.getByLabelText(/I understand this run can spend up to/))
    fireEvent.click(screen.getByRole('button', { name: 'Launch paid run' }))
    const confirmation = await screen.findByRole('dialog', { name: 'Confirm paid benchmark' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Start benchmark' }))
    await waitFor(() => assert.ok(requests.some(({ init }) => init?.method === 'POST')))
    const post = requests.find(({ init }) => init?.method === 'POST')!
    assert.equal(post.input, '/api/benchmarks/runs')
    const body = JSON.parse(String(post.init?.body))
    assert.deepEqual({ ...body, requestId: 'request-1' }, { ...config, requestId: 'request-1' })
  })

  it('loads active runs after navigation and supports cancellation without resuming them', async () => {
    render(<Benchmarks />)
    await screen.findByRole('button', { name: 'Cancel run' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    await waitFor(() => assert.ok(requests.some(({ input, init }) => String(input).endsWith('/run-1/cancel') && init?.method === 'POST')))
    assert.equal(requests.some(({ input, init }) => String(input).endsWith('/runs') && init?.method === 'POST'), false)
  })

  it('keeps the selected result page when requesting the next page', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ caseId: `case-${i}`, track: 'plan-single', status: 'correct', unsafe: false, validatorRejected: false, selectedIds: [], queries: [], supportedQueryCount: 1, unsupportedQueryCount: 0, admittedIds: [], retrievedIds: [], cappedIds: [], admissionLossIds: [], capLossIds: [], reviewedCandidates: 1, uncertainCandidates: 0 }))
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init }); const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/benchmarks') return response(catalog)
      if (url.pathname === '/api/benchmarks/runs') return response({ runs: [{ ...run, status: 'completed', datasetHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), summary }], total: 1 })
      if (url.pathname === '/api/benchmarks/runs/run-1') { const offset = Number(url.searchParams.get('offset')); return response({ run: { ...run, status: 'completed', results: many.slice(offset, offset + 50), attempts: [] }, summary, totalResults: 51, totalAttempts: 0, offset, limit: 50 }) }
      return response({ error: 'unexpected' }, 404)
    }
    render(<Benchmarks />)
    fireEvent.click(await screen.findByRole('button', { name: /run-1/ }))
    await screen.findByText('case-0')
    fireEvent.click(screen.getByRole('button', { name: 'Next cases' }))
    await screen.findByText('case-50')
    assert.ok(requests.some(({ input }) => String(input).includes('offset=50')))
  })

  it('retries a network-failed launch with the same idempotency request ID', async () => {
    activeRun = false
    let postCount = 0
    globalThis.fetch = async (input, init) => { requests.push({ input, init }); const url = new URL(String(input), 'http://localhost'); if (url.pathname === '/api/benchmarks') return response(catalog); if (url.pathname === '/api/benchmarks/runs' && init?.method === 'POST') { postCount++; if (postCount === 1) throw new TypeError('offline'); return response({ ...run, id: 'run-2', status: 'running' }, 202) }; if (url.pathname === '/api/benchmarks/runs') return response({ runs: [], total: 0 }); return response({ ...run, id: 'run-2', status: 'running', results: [], attempts: [] }) }
    render(<Benchmarks />)
    const launch = await screen.findByRole('button', { name: 'Launch paid run' })
    fireEvent.click(screen.getByLabelText(/I have read the provider disclosure/)); fireEvent.click(screen.getByLabelText(/I understand this run can spend up to/)); fireEvent.click(launch)
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Confirm paid benchmark' })).getByRole('button', { name: 'Start benchmark' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Launch paid run' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Confirm paid benchmark' })).getByRole('button', { name: 'Start benchmark' }))
    await waitFor(() => assert.equal(requests.filter(({ init }) => init?.method === 'POST').length, 2))
    const ids = requests.filter(({ init }) => init?.method === 'POST').map(({ init }) => JSON.parse(String(init?.body)).requestId)
    assert.equal(ids[0], ids[1])
  })

  it('traps modal focus, closes on Escape, and restores focus to the launcher', async () => {
    activeRun = false
    render(<Benchmarks />)
    const launch = await screen.findByRole('button', { name: 'Launch paid run' })
    fireEvent.click(screen.getByLabelText(/I have read the provider disclosure/)); fireEvent.click(screen.getByLabelText(/I understand this run can spend up to/)); fireEvent.click(launch)
    const dialog = await screen.findByRole('dialog', { name: 'Confirm paid benchmark' })
    assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Close confirmation' }))
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Start benchmark' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
    assert.equal(document.activeElement, launch)
  })

  it('refuses comparison when hashes are absent even if the remaining config matches', async () => {
    const complete = { ...run, status: 'completed', results: [], attempts: [], summary, config: { ...config, requestId: 'id-1' } }
    globalThis.fetch = async (input, init) => { requests.push({ input, init }); const url = new URL(String(input), 'http://localhost'); if (url.pathname === '/api/benchmarks') return response(catalog); if (url.pathname === '/api/benchmarks/runs') return response({ runs: [complete, { ...complete, id: 'run-2', config: { ...config, requestId: 'id-2' } }], total: 2 }); return response({ run: complete, summary, totalResults: 0, totalAttempts: 0, offset: 0, limit: 50 }) }
    render(<Benchmarks />)
    fireEvent.click(await screen.findByLabelText('Compare run run-1'))
    fireEvent.click(screen.getByLabelText('Compare run run-2'))
    assert.ok(await screen.findByText('Not comparable'))
  })

  it('marks completed runs not comparable when their dataset content hashes differ', async () => {
    const complete = { ...run, status: 'completed', results: [], attempts: [], summary, config: { ...config, requestId: 'id-1' }, datasetHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) }
    globalThis.fetch = async (input, init) => { requests.push({ input, init }); const url = new URL(String(input), 'http://localhost'); if (url.pathname === '/api/benchmarks') return response(catalog); if (url.pathname === '/api/benchmarks/runs') return response({ runs: [complete, { ...complete, id: 'run-2', config: { ...config, requestId: 'id-2' }, datasetHash: 'c'.repeat(64) }], total: 2 }); return response({ run: complete, summary, totalResults: 0, totalAttempts: 0, offset: 0, limit: 50 }) }
    render(<Benchmarks />)
    fireEvent.click(await screen.findByLabelText('Compare run run-1'))
    fireEvent.click(screen.getByLabelText('Compare run run-2'))
    assert.ok(await screen.findByText('Not comparable'))
  })
  it('permits model and prompt comparisons when evaluation-critical settings match', async () => {
    const complete = { ...run, status: 'completed', summary, datasetHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) }
    globalThis.fetch = async (input) => { const url = new URL(String(input), 'http://localhost'); if (url.pathname === '/api/benchmarks') return response(catalog); if (url.pathname === '/api/benchmarks/runs') return response({ runs: [complete, { ...complete, id: 'run-2', config: { ...config, model: 'other/model', prompt: 'benchmark-data-only-v1', requestId: 'id-2' } }], total: 2 }); return response({ run: complete, summary, totalResults: 0, totalAttempts: 0, offset: 0, limit: 50 }) }
    render(<Benchmarks />)
    fireEvent.click(await screen.findByLabelText('Compare run run-1'))
    fireEvent.click(screen.getByLabelText('Compare run run-2'))
    assert.ok(await screen.findByText('Comparable'))
  })
  it('makes unknown local compute cost explicit and launches only call/token mode', async () => {
    activeRun = false
    const previous = globalThis.fetch
    globalThis.fetch = async (input, init) => new URL(String(input), 'http://localhost').pathname === '/api/benchmarks' ? response({ ...catalog, profiles: [{ id: 'local', label: 'Local model', models: ['local/model'], ready: true, costModes: ['local-call-token'] }] }) : previous(input, init)
    render(<Benchmarks />)
    await screen.findByRole('button', { name: 'Launch local run' })
    assert.equal((screen.getByLabelText('Hard-dollar ceiling (USD)') as HTMLInputElement).disabled, true)
    fireEvent.click(screen.getByLabelText(/I have read the provider disclosure/))
    fireEvent.click(screen.getByLabelText(/I understand local compute cost is unknown/))
    fireEvent.click(screen.getByRole('button', { name: 'Launch local run' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Confirm local benchmark' })).getByRole('button', { name: 'Start benchmark' }))
    await waitFor(() => assert.ok(requests.some(({ init }) => init?.method === 'POST')))
    assert.equal(JSON.parse(String(requests.find(({ init }) => init?.method === 'POST')?.init?.body)).spendPolicy, 'local-call-token')
  })

  it('refreshes selected active-run details as polling reports newer progress', async () => {
    let listReads = 0, detailReads = 0
    globalThis.fetch = async (input, init) => { requests.push({ input, init }); const url = new URL(String(input), 'http://localhost'); if (url.pathname === '/api/benchmarks') return response(catalog); if (url.pathname === '/api/benchmarks/runs') { listReads++; return response({ runs: [{ ...run, status: 'running', summary: { ...summary, completedCases: listReads > 1 ? 1 : 0 } }], total: 1 }) }; if (url.pathname.endsWith('/run-1')) { detailReads++; return response({ run: { ...run, status: 'running', results: [], attempts: [] }, summary: { ...summary, completedCases: 0 }, totalResults: 0, totalAttempts: 0, offset: 0, limit: 50 }) }; return response({}) }
    render(<Benchmarks />)
    await waitFor(() => assert.ok(screen.getByText('1 / 2')), { timeout: 3500 })
    await waitFor(() => assert.ok(detailReads >= 2), { timeout: 2500 })
    assert.ok(listReads >= 2)
  })
})
