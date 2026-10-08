import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'
import { defaults, type SettingsEnvelope } from './types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value })
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const { StrictMode } = await import('react')
const { default: App } = await import('./App')

const envelope: SettingsEnvelope = {
  settings: defaults,
  status: { ready: false, missing: ['Prowlarr', 'Sonarr', 'Radarr', 'OpenRouter'], monitoringEnabled: false, cycleRunning: false },
}

let requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
let operationRequests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
const originalFetch = globalThis.fetch

const workItem = {
  workKey: 'sonarr:18:season:1', title: 'North Shore', mediaType: 'tv' as const, season: 1,
  status: 'manual', missingCount: 3, nextSearchAt: null, lastSearchAt: '2026-09-29T12:00:00.000Z',
  holdReason: 'manual-review', observedAt: '2026-09-29T12:00:00.000Z', observationState: 'stale' as const,
  queueObservationKnown: true, queueObservedAt: '2026-09-29T12:00:00.000Z',
  coverage: { observed: 1, reserved: 2 }, actions: { retry: { allowed: true }, reset: { allowed: true } },
}
const reviewItem = {
  id: 7, workKey: workItem.workKey, title: 'North Shore', reason: 'queue-review', summary: 'Scout needs a human to check this work.',
  createdAt: '2026-09-29T12:00:00.000Z', resolvedAt: null, mediaType: 'tv' as const, season: 1,
  actions: { retry: { allowed: false, reason: 'Resolve the queue review first.' }, reset: { allowed: true }, associate: { allowed: true }, release: { allowed: true } },
}
const activityItem = {
  id: 23, source: 'cycle' as const, startedAt: '2026-09-29T12:00:00.000Z', finishedAt: '2026-09-29T12:00:02.000Z',
  query: 'North Shore S01', media: [{ workKey: workItem.workKey, title: 'North Shore' }], resultCount: 12, outcome: 'success' as const,
}

function defaultOperationResponse(input: RequestInfo | URL): Response {
  const url = new URL(String(input), 'http://localhost')
  if (url.pathname === '/api/operations/work') return workResponse({ items: [workItem], total: 1, counts: { manual: 1, ready: 0, fulfilled: 0, inactive: 0 }, openReviewCount: 1, generatedAt: '2026-09-29T12:01:00.000Z', scope: url.searchParams.get('scope') === 'all' ? 'all' : 'active' })
  if (url.pathname === '/api/operations/reviews') return jsonResponse({ items: [reviewItem], total: 1, generatedAt: '2026-09-29T12:01:00.000Z' })
  if (url.pathname === '/api/operations/activity') return jsonResponse({ items: [activityItem], total: 1, generatedAt: '2026-09-29T12:01:00.000Z', retention: { days: 7, maxEntries: 2000 } })
  if (url.pathname.endsWith('/prepare')) return jsonResponse({ token: 'token-value', challenge: 'I approve this action.', expiresAt: '2099-01-01T00:00:00.000Z', summary: 'Fresh queue evidence is ready.', choices: [{ workKey: workItem.workKey, title: workItem.title }], mediaChoices: [{ mediaIndex: 0, title: workItem.title }], targetChoices: [{ workKey: workItem.workKey, title: 'Season 1 · all missing episodes', targetIndex: 0 }], requiresClientInspection: url.pathname.includes('release') })
  if (url.pathname.endsWith('/commit') || url.pathname.endsWith('/action')) return jsonResponse({ ok: true, message: 'Action completed.' })
  return jsonResponse({ error: 'Unexpected test request' }, 404)
}

function renderSettings() {
  render(<App />)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Settings' }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function workResponse(input: { items: unknown[]; total: number; counts: Record<string, number>; openReviewCount: number; generatedAt: string; scope?: 'active' | 'all'; countScope?: 'active' | 'all'; staleAfterHours?: number }): Response {
  return jsonResponse({ ...input, scope: input.scope ?? 'active', countScope: input.countScope ?? input.scope ?? 'active', freshness: { staleAfterHours: input.staleAfterHours ?? 24 } })
}

function envelopeWithModel(model: string): SettingsEnvelope {
  const next = JSON.parse(JSON.stringify(envelope)) as SettingsEnvelope
  next.settings.ai.model = model
  return next
}

function parsedJsonResponse(body: unknown): { response: Response; parsed: Promise<void> } {
  const response = jsonResponse(body)
  let markParsed!: () => void
  const parsed = new Promise<void>((resolve) => { markParsed = resolve })
  const readJson = response.json.bind(response)
  response.json = async () => {
    const value = await readJson()
    markParsed()
    return value
  }
  return { response, parsed }
}

describe('settings experience', () => {
  beforeEach(() => {
    requests = []
    operationRequests = []
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') {
        requests.push({ input, init })
        return jsonResponse(envelope)
      }
      operationRequests.push({ input, init })
      return Promise.resolve(defaultOperationResponse(input))
    }
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
    globalThis.fetch = originalFetch
  })

  it('loads an empty instance with secrets hidden and monitoring off', async () => {
    renderSettings()

    const key = await screen.findByLabelText('OpenRouter API key')
    assert.equal(key.getAttribute('type'), 'password')
    assert.equal(screen.getByRole('switch', { name: 'Automatic monitoring' }).getAttribute('aria-checked'), 'false')
    assert.equal(screen.getByRole('switch', { name: 'Dry-run mode' }).getAttribute('aria-checked'), 'true')
    assert.equal(screen.getAllByRole('button', { name: 'All changes saved' })[0].hasAttribute('disabled'), true)
    assert.equal(screen.getAllByText('Use http(s); don’t include a username or password in the URL.').length, 4)
    assert.equal((screen.getByLabelText('Release preferences') as HTMLTextAreaElement).placeholder, 'Prefer 1080p, English audio, and smaller files.')
    assert.ok(screen.getByText(/These preferences guide release ranking/))
  })

  it('loads, saves, and clears the search system prompt exactly', async () => {
    const saved = envelopeWithModel(envelope.settings.ai.model)
    saved.settings.ai.searchSystemPrompt = 'Use precise episode numbering.\nKeep the search terms concise.'
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings' && init?.method === 'PUT') {
        requests.push({ input, init })
        return jsonResponse({ ...saved, settings: JSON.parse(String(init.body)) })
      }
      if (String(input) === '/api/settings') { requests.push({ input, init }); return jsonResponse(saved) }
      return Promise.resolve(defaultOperationResponse(input))
    }
    renderSettings()
    const prompt = await screen.findByLabelText('Search system prompt') as HTMLTextAreaElement
    assert.equal(prompt.value, saved.settings.ai.searchSystemPrompt)
    assert.ok(screen.getByText(/not release ranking/))

    const edited = 'Treat an exact episode request literally.\nDo not broaden it.'
    fireEvent.change(prompt, { target: { value: edited } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])
    await waitFor(() => assert.ok(requests.some(({ init }) => init?.method === 'PUT')))
    let payload = JSON.parse(String(requests.find(({ init }) => init?.method === 'PUT')?.init?.body))
    assert.equal(payload.ai.searchSystemPrompt, edited)

    fireEvent.change(screen.getByLabelText('Search system prompt'), { target: { value: '' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])
    await waitFor(() => assert.equal(requests.filter(({ init }) => init?.method === 'PUT').length, 2))
    payload = JSON.parse(String(requests.filter(({ init }) => init?.method === 'PUT')[1].init?.body))
    assert.equal(payload.ai.searchSystemPrompt, '')
  })

  it('caps the monitoring check interval at the backend limit', async () => {
    renderSettings()
    await screen.findByLabelText('OpenRouter API key')
    fireEvent.click(screen.getByText('Advanced monitoring settings'))

    const interval = screen.getByLabelText('Check interval') as HTMLInputElement
    assert.equal(interval.max, '35791')
    fireEvent.change(interval, { target: { value: '40000' } })
    assert.equal(interval.value, '35791')
  })

  it('ignores an obsolete StrictMode settings response after the user edits', async () => {
    const deferred: Array<{ resolve: (response: Response) => void; signal?: AbortSignal }> = []
    globalThis.fetch = (input, init) => {
      if (String(input) !== '/api/settings') { operationRequests.push({ input, init }); return Promise.resolve(defaultOperationResponse(input)) }
      requests.push({ input, init })
      return new Promise((resolve) => deferred.push({ resolve, signal: init?.signal as AbortSignal | undefined }))
    }
    render(<StrictMode><App /></StrictMode>)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Settings' }))
    await waitFor(() => assert.equal(deferred.length, 2))
    assert.equal(deferred[0].signal?.aborted, true)

    deferred[1].resolve(jsonResponse(envelopeWithModel('current/model')))
    const model = await screen.findByLabelText('Model') as HTMLInputElement
    assert.equal(model.value, 'current/model')
    fireEvent.change(model, { target: { value: 'my unsaved edit' } })
    assert.equal(screen.getAllByRole('button', { name: 'Save changes' })[0].hasAttribute('disabled'), false)

    const stale = parsedJsonResponse(envelopeWithModel('obsolete/model'))
    deferred[0].resolve(stale.response)
    await stale.parsed
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.equal(model.value, 'my unsaved edit')
    assert.equal(screen.getAllByRole('button', { name: 'Save changes' })[0].hasAttribute('disabled'), false)
  })

  it('does not let a stale StrictMode failure end the current loading state', async () => {
    const deferred: Array<{ resolve: (response: Response) => void; reject: (error: unknown) => void }> = []
    globalThis.fetch = (input, init) => {
      if (String(input) !== '/api/settings') { operationRequests.push({ input, init }); return Promise.resolve(defaultOperationResponse(input)) }
      requests.push({ input, init })
      return new Promise((resolve, reject) => deferred.push({ resolve, reject }))
    }
    render(<StrictMode><App /></StrictMode>)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Settings' }))
    await waitFor(() => assert.equal(deferred.length, 2))

    await act(async () => {
      deferred[0].reject(new TypeError('old request failed'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    assert.ok(screen.getByText('Loading your settings…'))
    assert.equal(screen.queryByRole('heading', { name: 'Settings aren’t available yet' }), null)

    deferred[1].resolve(jsonResponse(envelopeWithModel('current/model')))
    const model = await screen.findByLabelText('Model') as HTMLInputElement
    assert.equal(model.value, 'current/model')
    assert.equal(screen.queryByText('Loading your settings…'), null)
  })

  it('sends the complete settings object and confirms the save', async () => {
    renderSettings()
    await screen.findByLabelText('OpenRouter API key')

    fireEvent.click(screen.getByRole('switch', { name: 'Automatic monitoring' }))
    fireEvent.click(screen.getByText('Advanced monitoring settings'))
    fireEvent.change(screen.getByLabelText('Check interval'), { target: { value: '12' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])

    await screen.findByRole('status')
    assert.ok(screen.getByText('Settings saved. Changes apply on the next cycle.'))
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input, '/api/settings')
    assert.equal(requests[1].init?.method, 'PUT')
    const saved = JSON.parse(String(requests[1].init?.body))
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.integrations.prowlarr, { url: '', apiKey: '', tvClient: '', movieClient: '', generalClient: '' })
    assert.deepEqual(saved.ai, defaults.ai)
    assert.deepEqual(saved.monitoring, { enabled: true, intervalMinutes: 12, minRetryHours: 6, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 })
    assert.deepEqual(saved.safety, defaults.safety)
  })

  it('keeps edits after a rejected save', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) !== '/api/settings') { operationRequests.push({ input, init }); return defaultOperationResponse(input) }
      requests.push({ input, init })
      return requests.length === 1 ? jsonResponse(envelope) : jsonResponse({
        error: 'Invalid settings',
        issues: [
          { path: ['integrations', 'prowlarr', 'url'], message: 'URL credentials are not allowed (TOPSECRET-KEY).', code: 'invalid_url' },
          { path: 'monitoring.intervalMinutes', message: 'Use a value no greater than 35791.', code: 'too_big' },
        ],
      }, 400)
    }
    renderSettings()
    await screen.findByLabelText('Model')

    const key = screen.getAllByLabelText('API key')[0] as HTMLInputElement
    fireEvent.change(key, { target: { value: 'TOPSECRET-KEY' } })
    const model = screen.getByLabelText('Model') as HTMLInputElement
    fireEvent.change(model, { target: { value: 'example/new-model' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])

    const alert = await screen.findByRole('alert')
    assert.equal(model.value, 'example/new-model')
    assert.equal(key.value, 'TOPSECRET-KEY')
    assert.match(alert.textContent ?? '', /Prowlarr service URL: URL credentials are not allowed \(\[redacted\]\)\./)
    assert.match(alert.textContent ?? '', /Check interval: Use a value no greater than 35791\./)
    assert.doesNotMatch(alert.textContent ?? '', /TOPSECRET-KEY/)
    assert.ok(screen.getByText(/Your edits are still here/))
    await waitFor(() => assert.equal(screen.getAllByRole('button', { name: 'Save changes' })[0].hasAttribute('disabled'), false))
  })
})

describe('operations dashboard', () => {
  beforeEach(() => {
    operationRequests = []
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      return defaultOperationResponse(input)
    }
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
    globalThis.fetch = originalFetch
  })

  it('opens on the Scout work queue and keeps every destination available in navigation', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Tracked media' })
    assert.ok(screen.getByRole('heading', { name: /Queue/ }))
    assert.ok(screen.getByText(/Scout work queue/))
    assert.ok(screen.getByText('Stale observations'))
    assert.ok(screen.getByText(/Library \+ queue/))
    assert.ok(screen.getByText('Coverage: 1 observed · 2 reserved'))
    const navigation = screen.getByRole('navigation', { name: 'Workspace' })
    for (const label of ['Queue', 'Reviews', 'Search history', 'Settings']) assert.ok(within(navigation).getByRole('link', { name: label }))
    assert.equal(screen.getByRole('link', { name: 'Queue' }).getAttribute('aria-current'), 'page')
  })

  it('shows the initial loading state until the first queue response arrives', async () => {
    let resolveQueue!: (response: Response) => void
    globalThis.fetch = (input, init) => {
      if (String(input) === '/api/settings') return Promise.resolve(jsonResponse(envelope))
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return new Promise((resolve) => { resolveQueue = resolve })
      return Promise.resolve(defaultOperationResponse(input))
    }
    render(<App />)
    await screen.findByText('Loading Scout’s work queue…')
    assert.equal(screen.queryByRole('heading', { name: 'Nothing in the queue yet' }), null)
    resolveQueue(workResponse({ items: [workItem], total: 1, counts: { manual: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' }))
    await screen.findByRole('heading', { name: 'Tracked media' })
    assert.ok(screen.getByRole('heading', { name: 'North Shore' }))
  })

  it('does not leave open reviews visible under the resolved filter after that request fails', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/operations/reviews' && url.searchParams.get('resolved') === 'true') return jsonResponse({ error: 'Synthetic resolved-filter failure' }, 503)
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    await screen.findByRole('button', { name: 'Review details' })
    assert.ok(screen.getByText('Scout needs a human to check this work.'))
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }))
    await screen.findByText('Synthetic resolved-filter failure')
    assert.ok(screen.getByRole('heading', { name: 'Resolved reviews' }))
    assert.equal(screen.queryByText('Scout needs a human to check this work.'), null)
    assert.equal(screen.queryByRole('button', { name: 'Review details' }), null)
  })

  it('clamps a shrunken second queue page back to the last available page after an action', async () => {
    let total = 51
    const rowAt = (number: number) => ({ ...workItem, workKey: `radarr:${number}`, title: `Work ${number}`, mediaType: 'movie' as const, season: undefined, status: 'cooldown', holdReason: null, missingCount: 1, nextSearchAt: null, lastSearchAt: '2026-09-29T12:00:00.000Z', actions: { retry: { allowed: true }, reset: { allowed: true } } })
    const rowsFor = (offset: number, limit: number) => Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => rowAt(offset + index + 1))
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work?')) {
        const url = new URL(String(input), 'http://localhost')
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return workResponse({ items: rowsFor(offset, limit), total, counts: { cooldown: total, fulfilled: 0, inactive: 0 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' })
      }
      if (String(input).endsWith('/work/action') && init?.method === 'POST') { total = 50; return jsonResponse({ ok: true, message: 'Tracking reset.' }) }
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'Work 1' })
    await screen.findByText('Page 1 of 2')
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    await screen.findByRole('heading', { name: 'Work 51' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset tracking' }))
    const confirmation = screen.getByRole('dialog', { name: 'Reset tracking?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Reset tracking' }))
    await screen.findByRole('heading', { name: 'Work 1' })
    assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('offset') === '0' && new URL(String(input), 'http://localhost').searchParams.get('limit') === '50'))
    assert.equal(screen.queryByRole('heading', { name: 'Nothing in the queue yet' }), null)
    assert.equal(screen.queryByRole('heading', { name: 'Work 51' }), null)
    assert.ok(screen.getByText('Tracking reset.'))
  })

  it('shows an explicit empty state instead of treating unknown data as an empty queue', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return workResponse({ items: [], total: 0, counts: {}, openReviewCount: 0, generatedAt: '2026-09-29T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'Nothing in the queue yet' })
    assert.equal(screen.queryByText('Observation unknown'), null)
  })

  it('labels unknown observations separately from stale observations and empty results', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return workResponse({ items: [{ ...workItem, observationState: 'unknown', observedAt: null, queueObservationKnown: false, queueObservedAt: '2026-09-28T12:00:00.000Z' }], total: 1, counts: { manual: 1 }, openReviewCount: 0, generatedAt: '2026-09-29T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByText('Observation status unknown')
    assert.ok(screen.getByText(/Queue unknown · last complete observation/))
    assert.ok(screen.getByText('North Shore'))
    assert.equal(screen.queryByText('Nothing in the queue yet'), null)
  })

  it('removes duplicate wait reasons and equal observation times from a stale waiting-release row', async () => {
    const observedAt = '2026-10-01T23:04:00.000Z'
    const odyssey = {
      ...workItem, workKey: 'radarr:315', title: 'The Odyssey', mediaType: 'movie' as const, season: undefined,
      status: 'waiting-release', holdReason: 'waiting-release', missingCount: 1, nextSearchAt: null, lastSearchAt: null,
      observedAt, queueObservationKnown: true, queueObservedAt: observedAt, observationState: 'stale' as const,
      actions: { retry: { allowed: false, reason: 'queue-observation-stale' }, reset: { allowed: false, reason: 'queue-observation-stale' } },
    }
    const reviewWaiting = {
      ...odyssey, workKey: 'radarr:316', title: 'Unmonitored movie', status: 'manual',
    }
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return workResponse({ items: [odyssey, reviewWaiting], total: 2, counts: { 'waiting-release': 1, manual: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'The Odyssey' })
    assert.equal(screen.getByText('Waiting for release').textContent, 'Waiting for release')
    const waitingReleaseRow = screen.getByRole('heading', { name: 'The Odyssey' }).closest('.ops-work-row') as HTMLElement
    assert.equal(waitingReleaseRow.querySelector('.ops-hold-reason'), null)
    assert.equal(within(screen.getByRole('heading', { name: 'Unmonitored movie' }).closest('.ops-work-row')!).getByText('Waiting for the movie to become available or the requested episodes to air.').textContent, 'Waiting for the movie to become available or the requested episodes to air.')
    const sourceLine = document.querySelector('.ops-observation-sources')
    assert.ok(sourceLine?.textContent?.includes('Library + queue'))
    assert.equal((sourceLine?.textContent?.match(/Oct 1/gu) ?? []).length, 1)
    assert.equal(screen.queryByText(/Next eligible pass|Last search/u), null)
    assert.equal(within(waitingReleaseRow).getAllByRole('button', { name: 'Retry' }).length, 1)
    assert.equal((within(waitingReleaseRow).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled, true)
    assert.equal((within(waitingReleaseRow).getByRole('button', { name: 'Reset tracking' }) as HTMLButtonElement).disabled, true)
    assert.equal(screen.queryByText(/queue-observation-stale|waiting-release/), null)
    assert.equal(document.querySelectorAll('.ops-action-reason').length, 0)
    assert.ok(screen.getByText(/Refresh view reloads saved status; it does not start a poll/))
    assert.equal(screen.getByText(/Refresh view reloads saved status; it does not start a poll/).textContent?.includes('24 hours'), true)
  })

  it('keeps terminal work visible but removes ineligible retry/reset controls', async () => {
    const fulfilled = { ...workItem, workKey: 'radarr:42', title: "Kiki's Delivery Service", mediaType: 'movie' as const, status: 'fulfilled', missingCount: 0, nextSearchAt: null, holdReason: null, actions: { retry: { allowed: false, reason: 'work-not-retryable' }, reset: { allowed: false, reason: 'work-not-resettable' } } }
    const inactive = { ...workItem, workKey: 'sonarr:9:season:4', title: 'The Boys', status: 'inactive', missingCount: 0, nextSearchAt: null, holdReason: null, actions: { retry: { allowed: false, reason: 'work-not-retryable' }, reset: { allowed: false, reason: 'work-not-resettable' } } }
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) {
        const scope = new URL(String(input), 'http://localhost').searchParams.get('scope')
        return scope === 'all'
          ? workResponse({ items: [fulfilled, inactive], total: 2, counts: { fulfilled: 1, inactive: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z', scope: 'all', countScope: 'all' })
          : workResponse({ items: [], total: 0, counts: { fulfilled: 0, inactive: 0 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z', scope: 'active', countScope: 'active' })
      }
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'Nothing in the queue yet' })
    assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('scope') === 'active'))
    fireEvent.click(screen.getByRole('button', { name: 'All work' }))
    await screen.findByRole('heading', { name: "Kiki's Delivery Service" })
    assert.ok(screen.getByRole('heading', { name: 'The Boys' }))
    assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('scope') === 'all'))
    assert.ok(screen.getByText(/all work, including completed and inactive items/))
    assert.equal(document.querySelectorAll('.ops-work-row').length, 2)
    assert.equal(screen.queryByRole('button', { name: 'Retry' }), null)
    assert.equal(screen.queryByRole('button', { name: 'Reset tracking' }), null)
    fireEvent.click(screen.getByRole('button', { name: 'Active work' }))
    await screen.findByRole('heading', { name: 'Nothing in the queue yet' })
    assert.equal(screen.queryByRole('heading', { name: "Kiki's Delivery Service" }), null)
  })

  it('labels distinct, invalid, null, and future timestamps without placeholder dashes', async () => {
    const row = { ...workItem, observedAt: 'not-a-date', queueObservationKnown: true, queueObservedAt: null, lastSearchAt: 'not-a-date', nextSearchAt: null }
    const future = { ...workItem, workKey: 'radarr:900', title: 'Far Future', mediaType: 'movie' as const, status: 'ready', holdReason: null, observationState: 'known' as const, observedAt: '2099-06-01T12:00:00.000Z', queueObservationKnown: true, queueObservedAt: '2099-06-01T12:00:00.000Z', nextSearchAt: null, lastSearchAt: null }
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return workResponse({ items: [row, future], total: 2, counts: { manual: 1, ready: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'North Shore' })
    assert.ok(screen.getByText(/Library · Time unavailable/))
    assert.ok(screen.getByText(/Queue · time unavailable/))
    assert.ok(screen.getByText('Last search · Time unavailable'))
    assert.ok(screen.getByText('Far Future'))
    assert.ok(screen.getByText(/clock ahead/))
    assert.equal(screen.queryByText(/—/), null)
  })

  it('shows separate library and queue observation times when they differ', async () => {
    const row = { ...workItem, observedAt: '2026-10-01T23:04:00.000Z', queueObservationKnown: true, queueObservedAt: '2026-10-02T00:04:00.000Z' }
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return workResponse({ items: [row], total: 1, counts: { manual: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T01:00:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'North Shore' })
    const sourceLine = document.querySelector('.ops-observation-sources')
    assert.ok(sourceLine?.textContent?.includes('Library ·'))
    assert.ok(sourceLine?.textContent?.includes('Queue ·'))
    assert.equal(sourceLine?.textContent?.includes('Library + queue'), false)
  })

  it('sends status and search filters and paginates large queue results', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return workResponse({ items: [workItem], total: 51, counts: { manual: 1, ready: 50, fulfilled: 0, inactive: 0 }, openReviewCount: 1, generatedAt: '2026-09-29T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByText('North Shore')
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'ready' } })
    await waitFor(() => assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('status') === 'ready')))
    fireEvent.change(screen.getByLabelText('Search queue'), { target: { value: 'North Shore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('q') === 'North Shore')))
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('offset') === '50')))
  })

  it('aborts and ignores a late queue response from an earlier filter', async () => {
    let resolveManual!: (response: Response) => void
    let manualSignal: AbortSignal | undefined
    const readyRow = { ...workItem, title: 'Ready Result', status: 'ready', holdReason: null, nextSearchAt: null, actions: { retry: { allowed: true }, reset: { allowed: true } } }
    const manualRow = { ...workItem, title: 'Stale Manual Result' }
    globalThis.fetch = (input, init) => {
      if (String(input) === '/api/settings') return Promise.resolve(jsonResponse(envelope))
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/operations/work' && url.searchParams.get('status') === 'manual') {
        manualSignal = init?.signal as AbortSignal | undefined
        return new Promise((resolve) => { resolveManual = resolve })
      }
      if (url.pathname === '/api/operations/work' && url.searchParams.get('status') === 'ready') return Promise.resolve(workResponse({ items: [readyRow], total: 1, counts: { ready: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' }))
      return Promise.resolve(defaultOperationResponse(input))
    }
    render(<App />)
    await screen.findByText('North Shore')
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'manual' } })
    await waitFor(() => assert.ok(resolveManual))
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'ready' } })
    await screen.findByRole('heading', { name: 'Ready Result' })
    assert.equal(manualSignal?.aborted, true)
    await act(async () => { resolveManual(workResponse({ items: [manualRow], total: 1, counts: { manual: 1 }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' })) })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.ok(screen.getByRole('heading', { name: 'Ready Result' }))
    assert.equal(screen.queryByRole('heading', { name: 'Stale Manual Result' }), null)
  })

  it('does not show the prior queue rows under a changed status after the request fails', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/operations/work' && url.searchParams.get('status') === 'ready') return jsonResponse({ error: 'Synthetic ready-filter failure' }, 503)
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'North Shore' })
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'ready' } })
    await screen.findByText('Synthetic ready-filter failure')
    assert.equal((screen.getByLabelText('Filter by status') as HTMLSelectElement).value, 'ready')
    assert.equal(screen.queryByRole('heading', { name: 'North Shore' }), null)
    assert.ok(screen.getByRole('heading', { name: 'This queue view couldn’t load' }))
    assert.ok(screen.getByText(/Previous rows are hidden because they don’t match/))
  })

  it('clamps a shrunken second queue page back to the last available page after an action', async () => {
    let total = 51
    const rowAt = (number: number) => ({ ...workItem, workKey: `radarr:${number}`, title: `Work ${number}`, mediaType: 'movie' as const, season: undefined, status: 'cooldown', holdReason: null, missingCount: 1, nextSearchAt: null, lastSearchAt: '2026-09-29T12:00:00.000Z', actions: { retry: { allowed: true }, reset: { allowed: true } } })
    const rowsFor = (offset: number, limit: number) => Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => rowAt(offset + index + 1))
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work?')) {
        const url = new URL(String(input), 'http://localhost')
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return workResponse({ items: rowsFor(offset, limit), total, counts: { cooldown: total }, openReviewCount: 0, generatedAt: '2026-10-02T00:00:00.000Z' })
      }
      if (String(input).endsWith('/work/action') && init?.method === 'POST') { total = 50; return jsonResponse({ ok: true, message: 'Tracking reset.' }) }
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByRole('heading', { name: 'Work 1' })
    await screen.findByText('Page 1 of 2')
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    await screen.findByRole('heading', { name: 'Work 51' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset tracking' }))
    const confirmation = screen.getByRole('dialog', { name: 'Reset tracking?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Reset tracking' }))
    await screen.findByRole('heading', { name: 'Work 1' })
    assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('offset') === '0' && new URL(String(input), 'http://localhost').searchParams.get('limit') === '50'))
    assert.equal(screen.queryByRole('heading', { name: 'Nothing in the queue yet' }), null)
    assert.equal(screen.queryByRole('heading', { name: 'Work 51' }), null)
    assert.ok(screen.getByText('Tracking reset.'))
  })

  it('retains the last queue rows when refresh fails and labels the error', async () => {
    render(<App />)
    await screen.findByText('North Shore')
    let fail = true
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (fail && String(input).startsWith('/api/operations/work')) throw new TypeError('offline')
      return defaultOperationResponse(input)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh view' }))
    await screen.findByRole('alert')
    assert.ok(screen.getByText('North Shore'))
    assert.ok(screen.getByRole('button', { name: 'Try again' }))
    fail = false
  })

  it('confirms a reset with the approved copy and posts only after confirmation', async () => {
    render(<App />)
    await screen.findByText('North Shore')
    fireEvent.click(screen.getByRole('button', { name: 'Reset tracking' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset tracking?' })
    assert.ok(within(dialog).getByText('Clear Scout’s current retry and review state. Missing content may reappear on the next poll. Download reservations and history are retained.'))
    assert.equal(operationRequests.some(({ init }) => init?.method === 'POST'), false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset tracking' }))
    await screen.findByRole('status')
    const request = operationRequests.find(({ input, init }) => String(input).endsWith('/work/action') && init?.method === 'POST')
    assert.ok(request)
    assert.deepEqual(JSON.parse(String(request.init?.body)), { workKey: workItem.workKey, action: 'reset' })
  })

  it('labels retry as next eligible pass and lets the user cancel without a request', async () => {
    render(<App />)
    await screen.findByText('North Shore')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const dialog = screen.getByRole('dialog', { name: 'Make this work due?' })
    assert.ok(within(dialog).getByText('Mark this item due for the next eligible pass. This does not start a search now.'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    assert.equal(operationRequests.some(({ input, init }) => String(input).endsWith('/work/action') && init?.method === 'POST'), false)
  })

  it('closes action confirmation from the keyboard and restores focus to its opener', async () => {
    render(<App />)
    await screen.findByText('North Shore')
    const opener = screen.getByRole('button', { name: 'Retry' })
    opener.focus()
    fireEvent.click(opener)
    assert.ok(screen.getByRole('dialog', { name: 'Make this work due?' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
    assert.equal(document.activeElement, opener)
  })

  it('shows search history with media mapping, result count, and retention', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Search history' }))
    await screen.findByText('North Shore S01')
    assert.ok(screen.getByRole('heading', { name: /Search history/ }))
    assert.ok(screen.getByText('North Shore'))
    assert.ok(screen.getByText('12 results'))
    assert.ok(screen.getByText(/Finished in 2 seconds/))
    assert.equal(screen.queryByText(/Finished Sep/), null)
    assert.ok(screen.getByText('Scout cycle'))
    assert.equal(screen.queryByText('Scheduled cycle'), null)
    assert.ok(screen.getByText('Retained 7 days · up to 2,000 entries'))
    const request = operationRequests.find(({ input }) => String(input).startsWith('/api/operations/activity'))
    assert.ok(request)
  })

  it('shows an empty search-history state when the bounded history has no entries', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/activity')) return jsonResponse({ items: [], total: 0, generatedAt: '2026-09-29T12:01:00.000Z', retention: { days: 7, maxEntries: 2000 } })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Search history' }))
    await screen.findByRole('heading', { name: 'No searches recorded yet' })
  })

  it('filters reviews to resolved items using the backend resolved flag', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/operations/reviews' && url.searchParams.get('resolved') === 'true') return jsonResponse({ items: [{ ...reviewItem, resolvedAt: '2026-09-30T12:00:00.000Z' }], total: 1, generatedAt: '2026-09-30T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    await screen.findByRole('button', { name: 'Review details' })
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }))
    await screen.findByText(/Resolved Sep/)
    assert.ok(operationRequests.some(({ input }) => new URL(String(input), 'http://localhost').searchParams.get('resolved') === 'true'))
  })

  it('shows media type and season for same-title reviews in the list and detail', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/reviews')) return jsonResponse({ items: [
        { ...reviewItem, id: 11, workKey: 'sonarr:18:season:1', mediaType: 'tv', season: 1 },
        { ...reviewItem, id: 12, workKey: 'sonarr:18:season:2', mediaType: 'tv', season: 2 },
      ], total: 2, generatedAt: '2026-09-29T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    await screen.findByRole('heading', { name: 'Open reviews' })
    await screen.findByText('TV · Season 1')
    assert.ok(screen.getByText('TV · Season 2'))
    const firstRow = document.querySelectorAll('.ops-review-row')[0] as HTMLElement
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Review details' }))
    const firstDialog = screen.getByRole('dialog', { name: 'North Shore' })
    assert.ok(within(firstDialog).getByText('TV · Season 1'))
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close review details' }))
    const secondRow = document.querySelectorAll('.ops-review-row')[1] as HTMLElement
    fireEvent.click(within(secondRow).getByRole('button', { name: 'Review details' }))
    assert.ok(within(screen.getByRole('dialog', { name: 'North Shore' })).getByText('TV · Season 2'))
  })

  it('does not call a persisted running search a live operation', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/activity')) return jsonResponse({ items: [{ ...activityItem, outcome: 'running', finishedAt: null, resultCount: null }], total: 1, generatedAt: '2026-09-29T12:01:00.000Z', retention: { days: 7, maxEntries: 2000 } })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Search history' }))
    await screen.findByText('Completion not recorded')
    assert.equal(document.querySelector('.ops-activity-row .ops-status')?.textContent, 'Completion not recorded')
    assert.ok(screen.getByText('Scout cycle'))
  })

  it('prepares a release and requires inspection, exact challenge, and note before commit', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/prepare')) return jsonResponse({ token: 'single-use-token', challenge: 'I inspected the download client.', expiresAt: '2099-01-01T00:00:00.000Z', summary: 'The reservation may be released after inspection.', choices: [], queuePreview: null, targetNames: ['North Shore · Season 1', 'South Ridge · Season 3'], requiresClientInspection: true })
      if (url.pathname.endsWith('/commit')) return jsonResponse({ ok: true, message: 'Reservation released.' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Release reservation' }))
    const challenge = await screen.findByLabelText('Type the exact approval text')
    const dialog = screen.getByRole('dialog', { name: 'North Shore' })
    assert.ok(within(dialog).getByText(/An empty Sonarr\/Radarr queue alone is not enough/))
    assert.ok(within(dialog).getByText(/No matching \*arr queue item was linked/))
    assert.ok(within(dialog).getByText('North Shore · Season 1'))
    assert.ok(within(dialog).getByText('South Ridge · Season 3'))
    assert.ok(within(dialog).getByText(/original submission routing and all relevant download clients/))
    const commit = within(dialog).getByRole('button', { name: 'Confirm action' }) as HTMLButtonElement
    assert.equal(commit.disabled, true)
    fireEvent.change(challenge, { target: { value: 'I inspected the download client.' } })
    fireEvent.change(screen.getByLabelText(/Audit note/), { target: { value: 'Checked all routed download jobs.' } })
    assert.equal(commit.disabled, true)
    fireEvent.click(screen.getByRole('checkbox'))
    assert.equal(commit.disabled, false)
    fireEvent.click(commit)
    await screen.findByText('Reservation released.')
    const request = operationRequests.find(({ input, init }) => String(input).endsWith('/commit') && init?.method === 'POST')
    assert.ok(request)
    assert.deepEqual(JSON.parse(String(request.init?.body)), { action: 'release', token: 'single-use-token', challenge: 'I inspected the download client.', note: 'Checked all routed download jobs.', clientInspectionConfirmed: true })
  })

  it('requires explicit media and target choices and commits their exact indices', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/prepare')) return jsonResponse({
        token: 'association-token', challenge: 'Confirm this exact queue association.', expiresAt: '2099-01-01T00:00:00.000Z',
        summary: 'Select the media item and the target coverage explicitly.', choices: [{ workKey: workItem.workKey, title: workItem.title }],
        mediaChoices: [{ mediaIndex: 3, title: 'North Shore (2024)' }, { mediaIndex: 8, title: 'North Shore — alternate match' }],
        targetChoices: [{ workKey: workItem.workKey, title: 'Season 1 · episodes 1–4', targetIndex: 2 }, { workKey: workItem.workKey, title: 'Season 1 · episodes 5–8', targetIndex: 6 }],
        requiresClientInspection: false,
      })
      if (url.pathname.endsWith('/commit')) return jsonResponse({ ok: true, message: 'Queue association recorded.' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Associate queue' }))
    const dialog = await screen.findByRole('dialog', { name: 'North Shore' })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm action' }) as HTMLButtonElement
    assert.equal(confirm.disabled, true)
    fireEvent.click(within(dialog).getByRole('radio', { name: /North Shore \(2024\)/ }))
    assert.equal(confirm.disabled, true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /episodes 5–8/ }))
    fireEvent.change(within(dialog).getByLabelText('Type the exact approval text'), { target: { value: 'Confirm this exact queue association.' } })
    fireEvent.change(within(dialog).getByLabelText(/Audit note/), { target: { value: 'Matched the supplied series and scope.' } })
    assert.equal(confirm.disabled, false)
    fireEvent.click(confirm)
    await screen.findByText('Queue association recorded.')
    const request = operationRequests.find(({ input, init }) => String(input).endsWith('/commit') && init?.method === 'POST')
    assert.ok(request)
    assert.deepEqual(JSON.parse(String(request.init?.body)), { action: 'associate', token: 'association-token', challenge: 'Confirm this exact queue association.', note: 'Matched the supplied series and scope.', workKey: workItem.workKey, mediaIndex: 3, targetIndices: [6] })
  })

  it('supports the approved reset action from review details without a generic dismiss', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset tracking' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset tracking?' })
    assert.ok(within(dialog).getByText('Clear Scout’s current retry and review state. Missing content may reappear on the next poll. Download reservations and history are retained.'))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Reset tracking?' }), null))
    assert.ok(screen.getByRole('dialog', { name: 'North Shore' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset tracking' }))
    fireEvent.click(screen.getByRole('dialog', { name: 'Reset tracking?' }).querySelector('button.button-danger')!)
    await screen.findByText('Action completed.')
    const request = operationRequests.find(({ input, init }) => String(input).endsWith('/work/action') && init?.method === 'POST')
    assert.ok(request)
    assert.deepEqual(JSON.parse(String(request.init?.body)), { workKey: workItem.workKey, action: 'reset' })
  })

  it('keeps nested confirmation and its parent inert while a work action is in flight', async () => {
    let resolveAction!: (response: Response) => void
    globalThis.fetch = (input, init) => {
      if (String(input) === '/api/settings') return Promise.resolve(jsonResponse(envelope))
      operationRequests.push({ input, init })
      if (String(input).endsWith('/work/action') && init?.method === 'POST') return new Promise((resolve) => { resolveAction = resolve })
      return Promise.resolve(defaultOperationResponse(input))
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    const parentDialog = document.querySelector('[aria-labelledby="review-dialog-title"]') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: 'Reset tracking' }))
    const confirmDialog = screen.getByRole('dialog', { name: 'Reset tracking?' })
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Reset tracking' }))
    await waitFor(() => assert.ok(resolveAction))
    assert.equal(parentDialog.getAttribute('inert'), '')
    assert.equal(parentDialog.getAttribute('aria-hidden'), 'true')
    assert.equal((within(confirmDialog).getByRole('button', { name: 'Close dialog' }) as HTMLButtonElement).disabled, true)
    fireEvent.keyDown(document, { key: 'Escape' })
    assert.ok(screen.getByRole('dialog', { name: 'Reset tracking?' }))
    assert.equal(parentDialog.isConnected, true)
    assert.equal(parentDialog.getAttribute('inert'), '')
    await act(async () => { resolveAction(jsonResponse({ ok: true, message: 'Work action completed.' })) })
    await screen.findByText('Work action completed.')
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
  })

  it('blocks expired recovery previews and offers a fresh prepare step', async () => {
    let prepares = 0
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/prepare')) {
        prepares += 1
        return jsonResponse({ token: `token-${prepares}`, challenge: 'Associate this queue item.', expiresAt: prepares === 1 ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z', summary: 'Previewed association.', choices: [{ workKey: workItem.workKey, title: workItem.title }], requiresClientInspection: false })
      }
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Associate queue' }))
    const refresh = await screen.findByRole('button', { name: 'Prepare a fresh preview' })
    assert.ok(screen.getByText('Preview expired · prepare again'))
    assert.equal(screen.getByRole('button', { name: 'Confirm action' }).hasAttribute('disabled'), true)
    fireEvent.click(refresh)
    await waitFor(() => assert.equal(prepares, 2))
    assert.ok(screen.getByText('Associate this queue item.'))
  })

  it('expires an idle prepared action without waiting for another input change', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/prepare')) return jsonResponse({
        token: 'short-lived-token', challenge: 'Confirm this exact queue association.', expiresAt: new Date(Date.now() + 700).toISOString(),
        summary: 'Fresh evidence expires shortly.', choices: [{ workKey: workItem.workKey, title: workItem.title }],
        mediaChoices: [{ mediaIndex: 0, title: 'North Shore (2024)' }],
        targetChoices: [{ workKey: workItem.workKey, title: 'Season 1 · episodes 1–4', targetIndex: 2 }],
        requiresClientInspection: false,
      })
      if (url.pathname.endsWith('/commit')) return jsonResponse({ ok: true, message: 'Should not commit expired evidence.' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Associate queue' }))
    const dialog = await screen.findByRole('dialog', { name: 'North Shore' })
    const scoped = within(dialog)
    fireEvent.click(scoped.getByRole('radio', { name: /North Shore \(2024\)/ }))
    fireEvent.click(scoped.getByRole('checkbox', { name: /episodes 1–4/ }))
    fireEvent.change(scoped.getByLabelText('Type the exact approval text'), { target: { value: 'Confirm this exact queue association.' } })
    fireEvent.change(scoped.getByLabelText(/Audit note/), { target: { value: 'Prepared while the evidence was fresh.' } })
    assert.equal((scoped.getByRole('button', { name: 'Confirm action' }) as HTMLButtonElement).disabled, false)
    await screen.findByText('Preview expired · prepare again')
    assert.equal((scoped.getByRole('button', { name: 'Confirm action' }) as HTMLButtonElement).disabled, true)
    assert.ok(scoped.getByRole('button', { name: 'Prepare a fresh preview' }))
    assert.equal(operationRequests.some(({ input, init }) => String(input).endsWith('/commit') && init?.method === 'POST'), false)
  })

  it('does not offer an action when the backend says it is unavailable', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/reviews')) return jsonResponse({ items: [{ ...reviewItem, actions: { ...reviewItem.actions, associate: { allowed: false, reason: 'No stable queue row.' }, release: { allowed: false, reason: 'Not eligible.' } } }], total: 1, generatedAt: '2026-09-29T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review details' }))
    assert.equal((screen.getByRole('button', { name: 'Associate queue' }) as HTMLButtonElement).disabled, true)
    assert.equal((screen.getByRole('button', { name: 'Release reservation' }) as HTMLButtonElement).disabled, true)
    assert.ok(screen.getByText('No stable queue row.'))
    assert.equal(document.querySelector('button[aria-label="Resolve review"]'), null)
  })
})

describe('general search conversation', () => {
  beforeEach(() => {
    operationRequests = []
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      return defaultOperationResponse(input)
    }
  })
  afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); globalThis.fetch = originalFetch })
  const release = (id: string, title: string) => ({ releaseId: id, title, indexer: 'Index', size: null, seeders: 4, leechers: 0, age: 2, protocol: 'torrent', selectable: true, unavailableReason: null, expiresAt: '2099-01-01T00:00:00.000Z', relevance: { classification: 'possible-match', explanation: 'Related subject' }, viability: { viable: true, reason: 'viable' } })
  const response = (releases = [release('r1', 'A Space Documentary')], status = 'selection-required') => ({ status, query: 'space documentary', queries: ['space documentary'], question: status === 'clarification-needed' ? 'What period?' : '', searchId: 'snap-1', expiresAt: '2099-01-01T00:00:00.000Z', confirmationToken: 'confirm-1', destination: { name: 'General Client', protocol: 'torrent' }, dryRun: true, actionsAllowed: true, blockedReason: null, releases })
  it('sends immutable initial context and retains distinct turns through clarification', async () => {
    const calls: any[] = []
    let count = 0
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      calls.push({ input, init }); count++
      return jsonResponse(response(count === 1 ? [] : [release('r1', 'A Space Documentary')], count === 1 ? 'clarification-needed' : 'selection-required'))
    }
    window.history.replaceState(null, '', '/#search'); render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'), { target: { value: 'space documentaries' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await screen.findAllByText('What period?')
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'early spaceflight' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Releases to review' })
    const first = JSON.parse(String(calls[0].init.body)), second = JSON.parse(String(calls[1].init.body))
    assert.equal(first.originalQuery, 'space documentaries'); assert.equal(second.originalQuery, 'space documentaries')
    assert.deepEqual(second.turns.map((x: any) => x.content), ['space documentaries', 'What period?', 'early spaceflight'])
    assert.equal(second.action, 'follow-up')
    assert.equal(screen.getAllByText('space documentaries').length, 1); assert.equal(screen.queryByLabelText('Search conversation'), null)
    assert.ok(screen.getByText('Possible match'))
  })
  it('renders truthful NDJSON progress and preserves suggestions when finding more', async () => {
    const calls: any[] = []
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      calls.push({ input, init })
      const next = calls.length === 1 ? response() : response([release('r1', 'A Space Documentary'), release('r2', 'A New Space Film')])
      const events = [{ type: 'planning', sequence: 0 }, { type: 'queries', sequence: 1, queries: ['deep space'] }, { type: 'searching', sequence: 2, query: 'deep space', index: 1, total: 1 }, { type: 'curation', sequence: 3, processed: 1, total: 1 }, { type: 'complete', sequence: 4, response: next }]
      return new Response(events.map(x => JSON.stringify(x)).join('\n')+'\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
    window.history.replaceState(null, '', '/#search'); render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'), { target: { value: 'space documentary' } }); fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await screen.findByRole('heading', { name: 'Releases to review' }); fireEvent.click(screen.getByRole('button', { name: 'Find more' }))
    await screen.findByRole('checkbox', { name: 'Select A New Space Film' })
    assert.ok(screen.getByRole('checkbox', { name: 'Select A Space Documentary' }))
    assert.ok(screen.getByText('deep space'))
    assert.equal(JSON.parse(String(calls[1].init.body)).action, 'find-more')
  })
  it('uses a multiline auto-growing prompt and keyboard-focusable search settings', async () => {
    window.history.replaceState(null,'','/#search');render(<App />)
    const prompt=await screen.findByLabelText('Describe what you’re looking for') as HTMLTextAreaElement
    assert.equal(prompt.rows,1)
    Object.defineProperty(prompt,'scrollHeight',{configurable:true,value:100})
    fireEvent.change(prompt,{target:{value:'first line\nsecond line'}})
    assert.equal(prompt.style.height,'100px')
    Object.defineProperty(prompt,'scrollHeight',{configurable:true,value:360})
    fireEvent.change(prompt,{target:{value:'many lines\n'.repeat(20)}})
    assert.equal(prompt.style.height,'180px')
    assert.equal(prompt.style.overflowY,'auto')
    const settings=screen.getByText('Search settings').closest('summary')!
    settings.focus();assert.equal(document.activeElement,settings)
    fireEvent.click(settings)
    assert.ok(screen.getByLabelText('Search terms'))
  })
  it('keeps New search and Stop search separate and ignores a late result from the prior run', async () => {
    let resolveFirst!: (r:Response)=>void
    let stopStream!: ReadableStreamDefaultController<Uint8Array>
    let calls=0
    globalThis.fetch=async(input)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      calls++
      if(calls===1)return new Promise<Response>(resolve=>{resolveFirst=resolve})
      if(calls===2)return jsonResponse(response([release('new','New run release')]))
      const early=release('early','Early stop candidate')
      return new Response(new ReadableStream<Uint8Array>({start(controller){stopStream=controller;controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'results',sequence:0,runId:'stop-run',provisional:true,releases:[early]})+'\n'))}}),{headers:{'Content-Type':'application/x-ndjson'}})
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    const query=await screen.findByLabelText('Describe what you’re looking for')
    fireEvent.change(query,{target:{value:'first run'}});fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(screen.getByRole('button',{name:'Stop search'}))
    fireEvent.click(screen.getByRole('button',{name:'New search'}))
    fireEvent.change(screen.getByLabelText('Describe what you’re looking for'),{target:{value:'second run'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByText('New run release')
    resolveFirst(jsonResponse(response([release('old','Stale run release')])))
    await new Promise(resolve=>setTimeout(resolve,0))
    assert.equal(screen.queryByRole('heading',{name:'Stale run release'}),null)
    fireEvent.click(screen.getByRole('button',{name:'New search'}))
    fireEvent.change(screen.getByLabelText('Describe what you’re looking for'),{target:{value:'stoppable'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByText('Early stop candidate')
    fireEvent.click(screen.getByRole('button',{name:'Stop search'}))
    assert.ok(screen.getByText('Search stopped'))
    assert.ok(screen.getByText('Partial results · search stopped'))
    assert.equal(screen.queryByRole('checkbox',{name:'Select Early stop candidate'}),null)
    stopStream.close()
    assert.ok(screen.getByRole('button',{name:'New search'}))
  })
  it('upserts curation progress and keeps partial error results nonselectable', async () => {
    const partial=release('partial','Early candidate')
    const diagnostics={complete:false,stopReason:'source-failure',sourceInventory:'not-reported',ledger:{raw:1,added:1,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:0,possible:0,unrelated:0,unassessed:1},outcomes:[{query:'neutral query',outcome:'failed',raw:0,added:0}]}}
    const events=[
      {type:'planning',sequence:0,runId:'run-1',stageId:'planning'},
      {type:'curation',sequence:1,runId:'run-1',stageId:'curation:batch-1',processed:0,total:1},
      {type:'curation',sequence:2,runId:'run-1',stageId:'curation:batch-1',processed:1,total:1},
      {type:'results',sequence:3,runId:'run-1',stageId:'results',provisional:true,releases:[partial]},
      {type:'error',sequence:4,runId:'run-1',stageId:'error',code:'source-failure',message:'Search ended before completion.',partialReleases:[partial],diagnostics},
    ]
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response(events.map(x=>JSON.stringify(x)).join('\n'),{headers:{'Content-Type':'application/x-ndjson'}})
    window.history.replaceState(null,'','/#search');const view=render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'neutral query'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByText('Early candidate')
    assert.equal(screen.queryByRole('checkbox',{name:'Select Early candidate'}),null)
    fireEvent.click(await screen.findByText('Search ended early'))
    await screen.findByText(/One or more searches failed/)
    assert.ok(screen.getByText(/neutral query: search failed/))
    assert.ok(screen.getByText(/Assessment: 0 matches, 0 possible matches/))
    const curationRows=view.container.querySelectorAll('.activity-details li')
    assert.equal([...curationRows].filter(row=>row.textContent?.includes('Checking relevance')).length,1)
  })
  it('reads fragmented and unterminated NDJSON while ignoring duplicate sequence numbers', async () => {
    const events=[
      {type:'planning',sequence:0,runId:'fragment-run',stageId:'planning'},
      {type:'queries',sequence:1,runId:'fragment-run',stageId:'queries',queries:['one neutral term']},
      {type:'queries',sequence:1,runId:'fragment-run',stageId:'queries',queries:['duplicate term']},
      {type:'complete',sequence:2,runId:'fragment-run',stageId:'complete',response:response()},
    ].map(x=>JSON.stringify(x)).join('\n')
    const bytes=new TextEncoder().encode(events)
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes.slice(0,13));controller.enqueue(bytes.slice(13,61));controller.enqueue(bytes.slice(61));controller.close()}})
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response(stream,{headers:{'Content-Type':'application/x-ndjson'}})
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'fragmented query'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByRole('heading',{name:'Releases to review'})
    assert.ok(screen.getByText('one neutral term'))
    assert.equal(screen.queryByText('duplicate term'),null)
  })
  it('turns malformed known progress events into a safe alert', async () => {
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response('{"type":"queries","sequence":"bad","queries":[]}\n',{headers:{'Content-Type':'application/x-ndjson'}})
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'malformed query'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(await screen.findByRole('alert'))
    assert.ok(screen.getByText('Search activity was incomplete. Try again.'))
    cleanup();window.history.replaceState(null,'','/#search')
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response('{"type":"complete"',{headers:{'Content-Type':'application/x-ndjson'}})
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'malformed JSON'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(await screen.findByText('Search activity could not be read. Try again.'))
  })
  it('rejects diagnostics that omit ledger fields rather than trusting a completion token', async () => {
    const malformed={...response(),diagnostics:{complete:false,stopReason:'source-failure',sourceInventory:'not-reported',ledger:{raw:1,added:1,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:1,possible:0,unrelated:0,unassessed:0}}}}
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response(JSON.stringify({type:'complete',sequence:0,response:malformed}),{headers:{'Content-Type':'application/x-ndjson'}})
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'malformed diagnostics'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(await screen.findByText('Search activity was incomplete. Try again.'))
    assert.equal(screen.queryByRole('checkbox',{name:'Select A Space Documentary'}),null)
  })
  it('keeps continuation authentication paired across an incomplete NDJSON completion', async () => {
    const diagnostics={complete:false,stopReason:'budget-exhausted',sourceInventory:'not-reported',ledger:{raw:0,added:0,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:0,possible:0,unrelated:0,unassessed:0},outcomes:[]}}
    const requests:any[]=[]
    globalThis.fetch=async(input,init)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      const body=JSON.parse(String(init?.body));requests.push(body)
      if(requests.length===1)return jsonResponse(response())
      if(requests.length===2)return new Response(JSON.stringify({type:'complete',sequence:0,response:{...response(),searchId:'half-new-id',confirmationToken:'half-new-token',diagnostics}}),{headers:{'Content-Type':'application/x-ndjson'}})
      return jsonResponse(response())
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'original request'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'})
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'narrow the request'}});fireEvent.click(screen.getByRole('button',{name:'Update search'}));await screen.findByText('Search ended early',{selector:'summary'})
    assert.equal((screen.getByRole('checkbox',{name:'Select A Space Documentary'}) as HTMLInputElement).disabled,true)
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'continue narrowing'}});fireEvent.click(screen.getByRole('button',{name:'Update search'}));await waitFor(()=>assert.equal(requests.length,3))
    assert.equal(requests[2].previousSearchId,'snap-1')
    assert.equal(requests[2].confirmationToken,'confirm-1')
    assert.equal(requests[2].previousSearchId==='half-new-id'||requests[2].confirmationToken==='half-new-token',false)
  })
  it('omits both continuation credentials after an incomplete first response', async () => {
    const diagnostics={complete:false,stopReason:'budget-exhausted',sourceInventory:'not-reported',ledger:{raw:0,added:0,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:0,possible:0,unrelated:0,unassessed:0},outcomes:[]}}
    const requests:any[]=[]
    globalThis.fetch=async(input,init)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      const body=JSON.parse(String(init?.body));requests.push(body)
      if(requests.length===1)return jsonResponse({...response(),searchId:'incomplete-id',confirmationToken:'incomplete-token',diagnostics})
      return jsonResponse(response())
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'first request'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'})
    assert.equal((screen.getByRole('checkbox',{name:'Select A Space Documentary'}) as HTMLInputElement).disabled,true)
    for(const name of ['Find more','More like these','Try other terms']){
      const button=screen.getByRole('button',{name}) as HTMLButtonElement
      assert.equal(button.disabled,true)
      fireEvent.click(button)
    }
    assert.equal(requests.length,1)
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'try a more focused request'}});fireEvent.click(screen.getByRole('button',{name:'Update search'}));await waitFor(()=>assert.equal(requests.length,2))
    assert.equal('previousSearchId' in requests[1],false)
    assert.equal('confirmationToken' in requests[1],false)
    assert.deepEqual(requests[1].turns.map((turn:any)=>turn.role),['user','assistant','user'])
  })
  it('blocks discovery actions after an incomplete first NDJSON response but allows a credential-free composer follow-up', async () => {
    const diagnostics={complete:false,stopReason:'budget-exhausted',sourceInventory:'not-reported',ledger:{raw:0,added:0,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:0,possible:0,unrelated:0,unassessed:0},outcomes:[]}}
    const requests:any[]=[]
    globalThis.fetch=async(input,init)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      const body=JSON.parse(String(init?.body));requests.push(body)
      if(requests.length===1)return new Response(JSON.stringify({type:'complete',sequence:0,response:{...response(),searchId:'ndjson-incomplete-id',confirmationToken:'ndjson-incomplete-token',diagnostics}}),{headers:{'Content-Type':'application/x-ndjson'}})
      return jsonResponse(response())
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'first streamed request'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'})
    for(const name of ['Find more','More like these','Try other terms']){
      const button=screen.getByRole('button',{name}) as HTMLButtonElement
      assert.equal(button.disabled,true)
      fireEvent.click(button)
    }
    assert.equal(requests.length,1)
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'recover with full context'}});fireEvent.click(screen.getByRole('button',{name:'Update search'}));await waitFor(()=>assert.equal(requests.length,2))
    assert.equal('previousSearchId' in requests[1],false)
    assert.equal('confirmationToken' in requests[1],false)
    assert.deepEqual(requests[1].turns.map((turn:any)=>turn.role),['user','assistant','user'])
  })
  it('explains budget exhaustion before any query without claiming that a source returned nothing', async () => {
    const diagnostics={complete:false,stopReason:'budget-exhausted',sourceInventory:'not-reported',ledger:{raw:0,added:0,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:0,possible:0,unrelated:0,unassessed:0},outcomes:[]}}
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):jsonResponse({...response([]),diagnostics})
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'budget-limited search'}});fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(await screen.findByRole('heading',{name:'No results to show'}))
    assert.equal(screen.queryByText('No matching releases'),null)
    fireEvent.click(screen.getByText('Search ended early'))
    assert.ok(screen.getByText(/Search limits were reached/))
    assert.equal(screen.queryByText(/no sources|no indexers/i),null)
  })
  it('invalidates prior release authority after a failed refinement and keeps conversation turns alternating', async () => {
    const diagnostics={complete:true,stopReason:'sufficient-results',sourceInventory:'not-reported',ledger:{raw:1,added:1,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:1,possible:0,unrelated:0,unassessed:0},outcomes:[{query:'first request',outcome:'success',raw:1,added:1}]}}
    const refusal={...diagnostics,complete:false,stopReason:'provider-refusal',ledger:{...diagnostics.ledger,raw:0,added:0,assessed:{match:0,possible:0,unrelated:0,unassessed:0},outcomes:[]}}
    const calls:any[]=[]
    globalThis.fetch=async(input,init)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      const body=JSON.parse(String(init?.body));calls.push(body)
      if(calls.length===1)return jsonResponse({...response(),diagnostics})
      if(calls.length===2)return new Response(JSON.stringify({type:'error',sequence:0,runId:'refusal-run',code:'provider-refusal',message:'The search could not continue.',diagnostics:refusal}),{headers:{'Content-Type':'application/x-ndjson'}})
      if(calls.length===4)return new Promise<Response>(()=>{})
      return jsonResponse({...response([release('fresh','Fresh refinement result')]),diagnostics})
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'first request'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    const oldBox=await screen.findByRole('checkbox',{name:'Select A Space Documentary'}) as HTMLInputElement
    assert.equal(oldBox.disabled,false)
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'exclude one category'}})
    fireEvent.click(screen.getByRole('button',{name:'Update search'}))
    await screen.findByRole('alert')
    assert.equal((screen.getByRole('checkbox',{name:'Select A Space Documentary'}) as HTMLInputElement).disabled,true)
    assert.equal((screen.getByRole('button',{name:/Review 0 selected/}) as HTMLButtonElement).disabled,true)
    fireEvent.click(screen.getByText('Search ended early'))
    assert.ok(screen.getByText(/The AI service declined to continue/))
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'try another direction'}})
    fireEvent.click(screen.getByRole('button',{name:'Update search'}))
    await screen.findByText('Fresh refinement result')
    assert.deepEqual(calls[2].turns.map((t:any)=>t.role),['user','assistant','user','assistant','user'])
    assert.deepEqual(calls[2].turns.filter((t:any)=>t.role==='user').map((t:any)=>t.content),['first request','exclude one category','try another direction'])
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'stop this refinement'}});fireEvent.click(screen.getByRole('button',{name:'Update search'}));assert.ok(screen.getByRole('button',{name:'Stop search'}));fireEvent.click(screen.getByRole('button',{name:'Stop search'}))
    assert.equal((screen.getByRole('checkbox',{name:'Select Fresh refinement result'}) as HTMLInputElement).disabled,true)
    fireEvent.change(screen.getByLabelText('Refine your search'),{target:{value:'continue after stop'}});fireEvent.click(screen.getByRole('button',{name:'Update search'}));await screen.findByText('Fresh refinement result')
    assert.deepEqual(calls[4].turns.map((t:any)=>t.role),['user','assistant','user','assistant','user','assistant','user','assistant','user'])
  })
  it('rejects malformed nested completions and disables selectable releases from incomplete complete responses', async () => {
    const partialResponse={...response(),releases:[{...release('bad','Bad release'),title:null,apiKey:'must-not-be-rendered'}]}
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response(JSON.stringify({type:'complete',sequence:0,response:partialResponse}),{headers:{'Content-Type':'application/x-ndjson'}})
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'bad nested result'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(await screen.findByText('Search activity was incomplete. Try again.'))
    assert.equal(screen.queryByRole('checkbox',{name:'Select Bad release'}),null)

    cleanup();window.history.replaceState(null,'','/#search')
    const incomplete={...response(),diagnostics:{complete:false,stopReason:'budget-exhausted',sourceInventory:'not-reported',ledger:{raw:1,added:1,duplicates:0,reactivated:0,reassessed:0,filtered:{},assessed:{match:1,possible:0,unrelated:0,unassessed:0},outcomes:[]}}}
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response(JSON.stringify({type:'complete',sequence:0,response:incomplete}),{headers:{'Content-Type':'application/x-ndjson'}})
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'incomplete run'}})
    fireEvent.click(screen.getByRole('button',{name:'Search'}))
    const disabled=await screen.findByRole('checkbox',{name:'Select A Space Documentary'}) as HTMLInputElement
    assert.equal(disabled.disabled,true)
    assert.equal((screen.getByRole('button',{name:/Review 0 selected/}) as HTMLButtonElement).disabled,true)
    assert.ok(screen.getByText('Search ended early',{selector:'summary'}))
  })
  it('shows unterminated provisional results and rejects conflicting terminal events without enabling them', async () => {
    const early=release('early','Unconfirmed release')
    let payload=JSON.stringify({type:'results',sequence:0,runId:'partial-run',provisional:true,releases:[early]})
    globalThis.fetch=async(input)=>String(input)==='/api/settings'?jsonResponse(envelope):new Response(payload,{headers:{'Content-Type':'application/x-ndjson'}})
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'early search'}});fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByText('Unconfirmed release')
    assert.ok(await screen.findByText('The search ended without a complete result.'))
    assert.equal(screen.queryByRole('checkbox',{name:'Select Unconfirmed release'}),null)

    cleanup();window.history.replaceState(null,'','/#search')
    payload=[
      {type:'results',sequence:0,runId:'conflict-run',provisional:true,releases:[early]},
      {type:'complete',sequence:1,runId:'conflict-run',response:response()},
      {type:'error',sequence:2,runId:'conflict-run',code:'late-error',message:'conflicting terminal'},
    ].map(x=>JSON.stringify(x)).join('\n')
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'conflicting search'}});fireEvent.click(screen.getByRole('button',{name:'Search'}))
    assert.ok(await screen.findByText(/conflicting completion updates/))
    assert.equal(screen.queryByRole('checkbox',{name:'Select A Space Documentary'}),null)
    assert.equal(screen.queryByRole('checkbox',{name:'Select Unconfirmed release'}),null)
  })
  it('reviews the complete selected manifest in an inert, keyboard-trapped modal', async () => {
    const many = Array.from({ length: 12 }, (_, i) => release(`r${i}`, `Release ${i}`))
    globalThis.fetch = async (input) => String(input) === '/api/settings' ? jsonResponse(envelope) : jsonResponse(response(many))
    window.history.replaceState(null, '', '/#search'); render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'), { target: { value: 'documentary' } }); fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await screen.findByRole('checkbox', { name: 'Select Release 11' })
    for (let i=0;i<12;i++) fireEvent.click(screen.getByRole('checkbox', { name: `Select Release ${i}` }))
    const opener = screen.getByRole('button', { name: /Review 12 selected/ }); fireEvent.click(opener)
    const dialog = screen.getByRole('dialog'); assert.equal(document.querySelector('.sidebar')?.hasAttribute('inert'), true); assert.equal(document.querySelector('#search')?.hasAttribute('inert'), true)
    assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Confirm full selection' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); assert.equal(document.activeElement, within(dialog).getByRole('button', { name: 'Close review' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
    assert.equal(document.activeElement, opener); assert.equal(document.querySelector('.sidebar')?.hasAttribute('inert'), false); assert.equal(document.querySelector('#search')?.hasAttribute('inert'), false)
  })
  it('paginates all releases and freezes a selection larger than ten into one operation', async () => {
    const many = Array.from({ length: 12 }, (_, i) => release(`r${i}`, `Release ${i}`))
    const calls: Array<{ input: RequestInfo|URL; init?: RequestInit }> = []
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      calls.push({input,init})
      if (String(input).includes('/conversation/stream')) return jsonResponse(response(many))
      if (String(input).endsWith('/operations')) { const create=JSON.parse(String(init?.body)); const ids=create.releaseIds as string[]; return jsonResponse({ operationId:create.operationId, releases:ids.map(releaseId=>({releaseId,status:'pending',code:null})), mode:'dry-run', destination:{name:'General Client',protocol:'torrent'}, expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:0,stopped:false,complete:false }) }
      if (String(input).endsWith('/step')) { const ordinal=JSON.parse(String(init?.body)).expectedOrdinal+1; const create=JSON.parse(String(calls.find(x=>String(x.input).endsWith('/operations'))?.init?.body)); const ids=create.releaseIds as string[]; return jsonResponse({ operationId:create.operationId, releases:ids.map((releaseId:string,i:number)=>({releaseId,status:i<ordinal?'dry-run':'pending',code:null})), mode:'dry-run', destination:{name:'General Client',protocol:'torrent'}, expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:ordinal,stopped:false,complete:ordinal===ids.length }) }
      return jsonResponse({error:'Unexpected request'},404)
    }
    window.history.replaceState(null, '', '/#search'); render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'), {target:{value:'documentary'}}); fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByRole('heading',{name:'Releases to review'})
    fireEvent.change(screen.getByLabelText('Visible per page'),{target:{value:'5'}})
    await screen.findByText('Page 1 of 3 · 12 total releases')
    const page1=screen.getByRole('checkbox',{name:'Select Release 0'}); fireEvent.click(page1)
    fireEvent.click(screen.getByRole('button',{name:'Next'})); fireEvent.click(screen.getByRole('checkbox',{name:'Select Release 5'}))
    fireEvent.click(screen.getByRole('button',{name:'Next'})); fireEvent.click(screen.getByRole('checkbox',{name:'Select Release 10'}))
    assert.ok(screen.getByText('3 selected across all pages. Display limit changes visibility only.'))
    fireEvent.click(screen.getByRole('button',{name:/Review 3 selected/}))
    const manifest=within(screen.getByRole('dialog')).getByRole('list')
    assert.equal(within(manifest).getAllByRole('listitem').length,3)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Confirm full selection'}))
    await screen.findByRole('heading',{name:'Operation complete'})
    const create=calls.find(x=>String(x.input).endsWith('/operations'))!
    assert.deepEqual(JSON.parse(String(create.init?.body)).releaseIds,['r0','r5','r10'])
    assert.equal(calls.filter(x=>String(x.input).endsWith('/operations')).length,1)
  })
  it('records discovery actions as bounded conversation turns', async () => {
    const calls: any[]=[]
    globalThis.fetch=async(input,init)=>{if(String(input)==='/api/settings')return jsonResponse(envelope);calls.push({input,init});return jsonResponse(response())}
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'broad request'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'})
    for(let i=0;i<5;i++){fireEvent.click(screen.getByRole('button',{name:'Find more'}));await waitFor(()=>assert.equal(calls.length,i+2))}
    assert.equal((screen.getByRole('button',{name:'Find more'}) as HTMLButtonElement).disabled,true)
    assert.ok(screen.getByText(/five follow-up limit/))
    const final=JSON.parse(String(calls.at(-1).init.body));assert.equal(final.turns.filter((t:any)=>t.role==='user').length,6)
    fireEvent.click(screen.getByRole('button',{name:'New search'}))
    assert.ok(await screen.findByLabelText('Describe what you’re looking for'))
  })
  it('reconciles a lost create response by read-only status and never creates twice', async () => {
    const calls: any[]=[]
    const status={operationId:'op-known',releases:[{releaseId:'r1',status:'uncertain',code:'request-timeout'}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:1,stopped:false,complete:true}
    globalThis.fetch=async(input,init)=>{if(String(input)==='/api/settings')return jsonResponse(envelope);calls.push({input,init});if(String(input).includes('/conversation/stream'))return jsonResponse(response());if(String(input).endsWith('/operations'))throw new TypeError('response lost');if(String(input).startsWith('/api/general-operations/')){const id=String(input).split('/').at(-1)!;return jsonResponse({...status,operationId:id})}return jsonResponse({error:'not found'},404)}
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select A Space Documentary'}));fireEvent.click(screen.getByRole('button',{name:/Review 1 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}))
    await screen.findByRole('heading',{name:'Outcome unknown'});await screen.findByText('Unknown · check client')
    assert.equal(calls.filter(x=>String(x.input).endsWith('/operations')).length,1)
    assert.equal(calls.filter(x=>x.init?.method==='POST'&&String(x.input).endsWith('/step')).length,0)
    assert.ok(calls.some(x=>String(x.input).startsWith('/api/general-operations/')&&x.init?.method===undefined))
    fireEvent.click(screen.getByRole('button',{name:'New search'}))
    assert.ok(screen.getByRole('heading',{name:'Outcome unknown'}))
    const beforeStatus=calls.filter(x=>String(x.input).startsWith('/api/general-operations/')).length
    fireEvent.click(screen.getByRole('button',{name:'Check status'}))
    await waitFor(()=>assert.ok(calls.filter(x=>String(x.input).startsWith('/api/general-operations/')).length>beforeStatus))
    assert.ok(screen.getByRole('heading',{name:'Outcome unknown'}))
  })
  it('allows a fresh search after an operation completes without clearing or resubmitting its outcome', async () => {
    const calls:any[]=[];let searches=0
    globalThis.fetch=async(input,init)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      calls.push({input,init})
      if(String(input).includes('/conversation/stream')){searches++;return jsonResponse(response([release(`r${searches}`,searches===1?'Submitted release':'Fresh search release')]))}
      if(String(input).endsWith('/operations')){const request=JSON.parse(String(init?.body));return jsonResponse({operationId:request.operationId,releases:request.releaseIds.map((releaseId:string)=>({releaseId,status:'dry-run',code:null})),mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:1,stopped:false,complete:true})}
      return jsonResponse({error:'Unexpected request'},404)
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'first search'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'})
    fireEvent.click(screen.getByRole('checkbox',{name:'Select Submitted release'}));fireEvent.click(screen.getByRole('button',{name:/Review 1 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}));await screen.findByRole('heading',{name:'Operation complete'})
    fireEvent.click(screen.getByRole('button',{name:'New search'}));fireEvent.change(screen.getByLabelText('Describe what you’re looking for'),{target:{value:'fresh search'}});fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByText('Fresh search release')
    assert.ok(screen.getByRole('heading',{name:'Operation complete'}))
    assert.equal(calls.filter(x=>String(x.input).endsWith('/operations')).length,1)
    assert.equal(calls.filter(x=>String(x.input).endsWith('/step')).length,0)
    assert.equal(calls.filter(x=>String(x.input).endsWith('/stop')).length,0)
  })
  it('keeps an active frozen operation while allowing a new root search', async () => {
    const calls:any[]=[];let resolveCreate!:(r:Response)=>void;let opId=''
    globalThis.fetch=async(input,init)=>{
      if(String(input)==='/api/settings')return jsonResponse(envelope)
      calls.push({input,init})
      if(String(input).includes('/conversation/stream'))return jsonResponse(response([release('r1',calls.filter(x=>String(x.input).includes('/conversation/stream')).length===1?'Frozen release':'Fresh root release')]))
      if(String(input).endsWith('/operations')){opId=JSON.parse(String(init?.body)).operationId;return new Promise(resolve=>{resolveCreate=resolve})}
      if(String(input).endsWith('/step'))return jsonResponse({operationId:opId,releases:[{releaseId:'r1',status:'dry-run',code:null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:1,stopped:false,complete:true})
      return jsonResponse({error:'Unexpected request'},404)
    }
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'first root'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'})
    fireEvent.click(screen.getByRole('checkbox',{name:'Select Frozen release'}));fireEvent.click(screen.getByRole('button',{name:/Review 1 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}));await waitFor(()=>assert.ok(resolveCreate))
    fireEvent.click(screen.getByRole('button',{name:'New search'}));fireEvent.change(screen.getByLabelText('Describe what you’re looking for'),{target:{value:'new root'}});fireEvent.click(screen.getByRole('button',{name:'Search'}))
    await screen.findByText('Fresh root release')
    assert.ok(screen.getByRole('heading',{name:'Outcome not confirmed'}))
    resolveCreate(jsonResponse({operationId:opId,releases:[{releaseId:'r1',status:'pending',code:null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:0,stopped:false,complete:false}))
    await screen.findByRole('heading',{name:'Operation complete'})
    assert.equal(calls.filter(x=>String(x.input).endsWith('/operations')).length,1)
    assert.equal(calls.filter(x=>String(x.input).endsWith('/step')).length,1)
    assert.equal(calls.filter(x=>String(x.input).endsWith('/stop')).length,0)
  })
  it('accepts a stopped status with an already-attempted ordinal and a held not-attempted tail', async () => {
    const calls:any[]=[], items=[release('r1','First release'),release('r2','Held release')]
    globalThis.fetch=async(input,init)=>{if(String(input)==='/api/settings')return jsonResponse(envelope);calls.push({input,init});if(String(input).includes('/conversation/stream'))return jsonResponse(response(items));if(String(input).endsWith('/operations'))throw new TypeError('create response lost');if(String(input).startsWith('/api/general-operations/')){const id=String(input).split('/').at(-1)!;return jsonResponse({operationId:id,releases:[{releaseId:'r1',status:'failed',code:'upstream-503'},{releaseId:'r2',status:'not-attempted',code:'operation-stopped'}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:1,stopped:true,complete:true})}return jsonResponse({error:'unexpected'},404)}
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select First release'}));fireEvent.click(screen.getByRole('checkbox',{name:'Select Held release'}));fireEvent.click(screen.getByRole('button',{name:/Review 2 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}))
    await screen.findByRole('heading',{name:'Stopped'});assert.ok(document.querySelector('.outcome-not-attempted'))
    assert.equal(calls.filter(x=>x.init?.method==='POST'&&String(x.input).endsWith('/step')).length,0);assert.equal(calls.filter(x=>x.init?.method==='POST'&&String(x.input).endsWith('/operations')).length,1)
  })
  it('shows a read-only in-flight submitting ordinal without starting another step', async () => {
    const calls:any[]=[]
    globalThis.fetch=async(input,init)=>{if(String(input)==='/api/settings')return jsonResponse(envelope);calls.push({input,init});if(String(input).includes('/conversation/stream'))return jsonResponse(response([release('r1','In-flight release'),release('r2','Next release')]));if(String(input).endsWith('/operations'))throw new TypeError('create response lost');if(String(input).startsWith('/api/general-operations/')){const id=String(input).split('/').at(-1)!;return jsonResponse({operationId:id,releases:[{releaseId:'r1',status:'submitting',code:null},{releaseId:'r2',status:'pending',code:null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:1,stopped:false,complete:false})}return jsonResponse({error:'unexpected'},404)}
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select In-flight release'}));fireEvent.click(screen.getByRole('checkbox',{name:'Select Next release'}));fireEvent.click(screen.getByRole('button',{name:/Review 2 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}))
    await screen.findByRole('heading',{name:'Submission progress'});assert.ok(screen.getByText('submitting'));assert.equal(calls.filter(x=>x.init?.method==='POST'&&String(x.input).endsWith('/step')).length,0)
  })
  it('does not submit a selection that expires while review is open', async () => {
    const soon=new Date(Date.now()+250).toISOString(), item={...release('r1','Short-lived'),expiresAt:soon}, resultSoon={...response([item]),expiresAt:new Date(Date.now()+60000).toISOString()}
    const calls:any[]=[]
    globalThis.fetch=async(input,init)=>{if(String(input)==='/api/settings')return jsonResponse(envelope);calls.push({input,init});return jsonResponse(resultSoon)}
    window.history.replaceState(null,'','/#search');render(<App />)
    fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select Short-lived'}));fireEvent.click(screen.getByRole('button',{name:/Review 1 selected/}))
    const confirm=screen.getByRole('button',{name:'Confirm full selection'}) as HTMLButtonElement
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1150))})
    assert.equal(confirm.disabled,true);assert.ok(screen.getByRole('alert'))
    assert.equal(calls.some(x=>String(x.input).endsWith('/operations')),false)
  })
  it('reconciles a malformed step receipt read-only and never repeats its ordinal', async () => {
    const calls:any[]=[];let operation:any
    const good=(next:number)=>({operationId:'',releases:[{releaseId:'r1',status:next?'uncertain':'pending',code:next?'request-timeout':null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:next,stopped:false,complete:Boolean(next)})
    globalThis.fetch=async(input,init)=>{if(String(input)==='/api/settings')return jsonResponse(envelope);calls.push({input,init});if(String(input).includes('/conversation/stream'))return jsonResponse(response());if(String(input).endsWith('/operations')){operation=good(0);const body=JSON.parse(String(init?.body));operation.operationId=body.operationId;return jsonResponse(operation)}if(String(input).endsWith('/step'))return jsonResponse({...good(1),operationId:operation.operationId,releases:[{releaseId:'wrong-id',status:'dry-run',code:null}]});if(String(input).startsWith('/api/general-operations/'))return jsonResponse({...good(1),operationId:operation.operationId});return jsonResponse({error:'unexpected'},404)}
    window.history.replaceState(null,'','/#search');render(<App />);fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select A Space Documentary'}));fireEvent.click(screen.getByRole('button',{name:/Review 1 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}))
    await screen.findByText('Unknown · check client')
    assert.equal(calls.filter(x=>String(x.input).endsWith('/step')).length,1);assert.equal(calls.filter(x=>String(x.input).startsWith('/api/general-operations/')&&x.init?.method===undefined).length,1)
  })
  it('does not issue another step after navigation while an ordinal response is pending', async () => {
    let resolveStep!:(r:Response)=>void;let id='';const calls:any[]=[]
    globalThis.fetch=(input,init)=>{if(String(input)==='/api/settings')return Promise.resolve(jsonResponse(envelope));calls.push({input,init});if(String(input).includes('/conversation/stream'))return Promise.resolve(jsonResponse(response([release('r1','First release'),release('r2','Second release')])));if(String(input).endsWith('/operations')){id=JSON.parse(String(init?.body)).operationId;return Promise.resolve(jsonResponse({operationId:id,releases:[{releaseId:'r1',status:'pending',code:null},{releaseId:'r2',status:'pending',code:null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:0,stopped:false,complete:false}))}if(String(input).endsWith('/step'))return new Promise(resolve=>{resolveStep=resolve});return Promise.resolve(defaultOperationResponse(input))}
    window.history.replaceState(null,'','/#search');render(<App />);fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select First release'}));fireEvent.click(screen.getByRole('checkbox',{name:'Select Second release'}));fireEvent.click(screen.getByRole('button',{name:/Review 2 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}));await waitFor(()=>assert.ok(resolveStep))
    fireEvent.click(screen.getByRole('link',{name:'Settings'}));await waitFor(()=>assert.equal(screen.getByRole('link',{name:'Settings'}).getAttribute('aria-current'),'page'))
    resolveStep(jsonResponse({operationId:id,releases:[{releaseId:'r1',status:'dry-run',code:null},{releaseId:'r2',status:'pending',code:null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:1,stopped:false,complete:false}));await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(calls.filter(x=>String(x.input).endsWith('/step')).length,1)
  })
  it('does not start steps when navigation invalidates a pending operation-create response', async () => {
    let resolveCreate!:(r:Response)=>void;let id='';const calls:any[]=[]
    globalThis.fetch=(input,init)=>{if(String(input)==='/api/settings')return Promise.resolve(jsonResponse(envelope));calls.push({input,init});if(String(input).includes('/conversation/stream'))return Promise.resolve(jsonResponse(response()));if(String(input).endsWith('/operations')){id=JSON.parse(String(init?.body)).operationId;return new Promise(resolve=>{resolveCreate=resolve})}if(String(input).endsWith('/step'))return Promise.resolve(jsonResponse({}));return Promise.resolve(defaultOperationResponse(input))}
    window.history.replaceState(null,'','/#search');render(<App />);fireEvent.change(await screen.findByLabelText('Describe what you’re looking for'),{target:{value:'query'}});fireEvent.click(screen.getByRole('button',{name:'Search'}));await screen.findByRole('heading',{name:'Releases to review'});fireEvent.click(screen.getByRole('checkbox',{name:'Select A Space Documentary'}));fireEvent.click(screen.getByRole('button',{name:/Review 1 selected/}));fireEvent.click(screen.getByRole('button',{name:'Confirm full selection'}));await waitFor(()=>assert.ok(resolveCreate))
    fireEvent.click(screen.getByRole('link',{name:'Settings'}));await waitFor(()=>assert.equal(screen.getByRole('link',{name:'Settings'}).getAttribute('aria-current'),'page'))
    resolveCreate(jsonResponse({operationId:id,releases:[{releaseId:'r1',status:'pending',code:null}],mode:'dry-run',destination:{name:'General Client',protocol:'torrent'},expiresAt:'2099-01-01T00:00:00.000Z',nextOrdinal:0,stopped:false,complete:false}));await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(calls.filter(x=>String(x.input).endsWith('/step')).length,0)
  })
})
