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

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { StrictMode } = await import('react')
const { default: App } = await import('./App')

const envelope: SettingsEnvelope = {
  settings: defaults,
  status: { ready: false, missing: ['Prowlarr', 'Sonarr', 'Radarr', 'OpenRouter'], monitoringEnabled: false, cycleRunning: false },
}

let requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
const originalFetch = globalThis.fetch

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
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init })
      return jsonResponse(envelope)
    }
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
  })

  it('loads an empty instance with secrets hidden and monitoring off', async () => {
    render(<App />)

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
    render(<App />)
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
      requests.push({ input, init })
      return new Promise((resolve) => deferred.push({ resolve, signal: init?.signal as AbortSignal | undefined }))
    }
    render(<StrictMode><App /></StrictMode>)
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
      requests.push({ input, init })
      return new Promise((resolve, reject) => deferred.push({ resolve, reject }))
    }
    render(<StrictMode><App /></StrictMode>)
    await waitFor(() => assert.equal(deferred.length, 2))

    deferred[0].reject(new TypeError('old request failed'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.ok(screen.getByText('Loading your settings…'))
    assert.equal(screen.queryByRole('heading', { name: 'Settings aren’t available yet' }), null)

    deferred[1].resolve(jsonResponse(envelopeWithModel('current/model')))
    const model = await screen.findByLabelText('Model') as HTMLInputElement
    assert.equal(model.value, 'current/model')
    assert.equal(screen.queryByText('Loading your settings…'), null)
  })

  it('sends the complete settings object and confirms the save', async () => {
    render(<App />)
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
      requests.push({ input, init })
      return requests.length === 1 ? jsonResponse(envelope) : jsonResponse({
        error: 'Invalid settings',
        issues: [
          { path: ['integrations', 'prowlarr', 'url'], message: 'URL credentials are not allowed (TOPSECRET-KEY).', code: 'invalid_url' },
          { path: 'monitoring.intervalMinutes', message: 'Use a value no greater than 35791.', code: 'too_big' },
        ],
      }, 400)
    }
    render(<App />)
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
