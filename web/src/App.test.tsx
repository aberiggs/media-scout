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
  createdAt: '2026-09-29T12:00:00.000Z', resolvedAt: null,
  actions: { retry: { allowed: false, reason: 'Resolve the queue review first.' }, reset: { allowed: true }, associate: { allowed: true }, release: { allowed: true } },
}
const activityItem = {
  id: 23, source: 'cycle' as const, startedAt: '2026-09-29T12:00:00.000Z', finishedAt: '2026-09-29T12:00:02.000Z',
  query: 'North Shore S01', media: [{ workKey: workItem.workKey, title: 'North Shore' }], resultCount: 12, outcome: 'success' as const,
}

function defaultOperationResponse(input: RequestInfo | URL): Response {
  const url = new URL(String(input), 'http://localhost')
  if (url.pathname === '/api/operations/work') return jsonResponse({ items: [workItem], total: 1, counts: { manual: 1, ready: 0 }, openReviewCount: 1, generatedAt: '2026-09-29T12:01:00.000Z' })
  if (url.pathname === '/api/operations/reviews') return jsonResponse({ items: [reviewItem], total: 1, generatedAt: '2026-09-29T12:01:00.000Z' })
  if (url.pathname === '/api/operations/activity') return jsonResponse({ items: [activityItem], total: 1, generatedAt: '2026-09-29T12:01:00.000Z', retention: { days: 7, maxEntries: 2000 } })
  if (url.pathname.endsWith('/prepare')) return jsonResponse({ token: 'token-value', challenge: 'I approve this action.', expiresAt: '2099-01-01T00:00:00.000Z', summary: 'Fresh queue evidence is ready.', choices: [{ workKey: workItem.workKey, title: workItem.title }], mediaChoices: [{ mediaIndex: 0, title: workItem.title }], targetChoices: [{ workKey: workItem.workKey, title: 'Season 1 · all missing episodes', targetIndex: 0 }], requiresClientInspection: url.pathname.includes('release') })
  if (url.pathname.endsWith('/commit') || url.pathname.endsWith('/action')) return jsonResponse({ ok: true, message: 'Action completed.' })
  return jsonResponse({ error: 'Unexpected test request' }, 404)
}

function renderSettings() {
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
      return defaultOperationResponse(input)
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
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
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
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
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
    assert.deepEqual(saved.integrations.prowlarr, { url: '', apiKey: '', tvClient: '', movieClient: '' })
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
    assert.ok(screen.getByText('Observation is stale'))
    assert.ok(screen.getByText(/Queue observed/))
    assert.ok(screen.getByText('Coverage: 1 observed · 2 reserved'))
    const navigation = screen.getByRole('navigation', { name: 'Workspace' })
    for (const label of ['Queue', 'Reviews', 'Search history', 'Settings']) assert.ok(within(navigation).getByRole('link', { name: label }))
    assert.equal(screen.getByRole('link', { name: 'Queue' }).getAttribute('aria-current'), 'page')
  })

  it('shows an explicit empty state instead of treating unknown data as an empty queue', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return jsonResponse({ items: [], total: 0, counts: {}, openReviewCount: 0, generatedAt: '2026-09-29T12:01:00.000Z' })
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
      if (String(input).startsWith('/api/operations/work')) return jsonResponse({ items: [{ ...workItem, observationState: 'unknown', observedAt: null, queueObservationKnown: false, queueObservedAt: null }], total: 1, counts: { manual: 1 }, openReviewCount: 0, generatedAt: '2026-09-29T12:01:00.000Z' })
      return defaultOperationResponse(input)
    }
    render(<App />)
    await screen.findByText('Observation unknown')
    assert.ok(screen.getByText('Queue observation unknown'))
    assert.ok(screen.getByText('North Shore'))
    assert.equal(screen.queryByText('Nothing in the queue yet'), null)
  })

  it('sends status and search filters and paginates large queue results', async () => {
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/settings') return jsonResponse(envelope)
      operationRequests.push({ input, init })
      if (String(input).startsWith('/api/operations/work')) return jsonResponse({ items: [workItem], total: 51, counts: { manual: 1, ready: 50 }, openReviewCount: 1, generatedAt: '2026-09-29T12:01:00.000Z' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
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
