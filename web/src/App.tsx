import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Command,
  Copy,
  Eye,
  EyeOff,
  Film,
  History,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Radio,
  Search,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tv,
  Waves,
} from 'lucide-react'
import { mergeSettings, type Settings, type SettingsEnvelope, type SettingsStatus } from './types'
import { OperationsPage } from './Operations'
import { GeneralSearchPage } from './GeneralSearch'

const MAX_INTERVAL_MINUTES = 35_791

interface ValidationIssue {
  path: string | Array<string | number>
  message: string
  code: string
}

class SettingsRequestError extends Error {
  issues: ValidationIssue[]

  constructor(message: string, issues: ValidationIssue[]) {
    super(message)
    this.issues = issues
  }
}

type Notice = { kind: 'error' | 'success' | 'info'; text: string; details?: string[] } | null
type Page = 'queue' | 'reviews' | 'activity' | 'settings' | 'search'

function currentPage(): Page {
  const page = window.location.hash.slice(1)
  return page === 'reviews' || page === 'activity' || page === 'settings' || page === 'search' ? page : 'queue'
}

const issueFieldLabels: Record<string, string> = {
  'integrations.prowlarr.url': 'Prowlarr service URL',
  'integrations.prowlarr.apiKey': 'Prowlarr API key',
  'integrations.prowlarr.tvClient': 'TV download client',
  'integrations.prowlarr.movieClient': 'Movie download client',
  'integrations.sonarr.url': 'Sonarr service URL',
  'integrations.sonarr.apiKey': 'Sonarr API key',
  'integrations.radarr.url': 'Radarr service URL',
  'integrations.radarr.apiKey': 'Radarr API key',
  'ai.apiKey': 'OpenRouter API key',
  'ai.model': 'Model',
  'ai.baseUrl': 'API base URL',
  'ai.preferences': 'Release preferences',
  'ai.searchSystemPrompt': 'Search system prompt',
  'monitoring.enabled': 'Automatic monitoring',
  'monitoring.intervalMinutes': 'Check interval',
  'monitoring.minRetryHours': 'Minimum retry delay',
  'monitoring.failureBackoffMinMinutes': 'Failure backoff minimum',
  'monitoring.failureBackoffMaxMinutes': 'Failure backoff maximum',
  'monitoring.queueGraceMinutes': 'Queue grace period',
  'safety.dryRun': 'Dry-run mode',
  'safety.allowOperatorActions': 'Allow operator actions',
  version: 'Settings version',
}

const issueCodeFallbacks: Record<string, string> = {
  invalid_url: 'Enter a valid HTTP or HTTPS URL without username or password.',
  invalid_type: 'Enter a value in the expected format.',
  too_small: 'Enter a value of at least 1.',
  too_big: 'Enter a value within the allowed maximum.',
}

function isEnvelope(value: unknown): value is SettingsEnvelope {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Partial<SettingsEnvelope>
  return Boolean(envelope.settings && envelope.status && typeof envelope.status.ready === 'boolean')
}

async function readEnvelope(response: Response): Promise<SettingsEnvelope> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'The settings request could not be completed.'
    const issues = body && typeof body === 'object' && 'issues' in body ? parseValidationIssues(body.issues) : []
    throw new SettingsRequestError(message, issues)
  }
  if (!isEnvelope(body)) throw new Error('The settings response was incomplete. Try again in a moment.')
  return body
}

function parseValidationIssues(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((issue): ValidationIssue[] => {
    if (!issue || typeof issue !== 'object') return []
    const candidate = issue as { path?: unknown; message?: unknown; code?: unknown }
    const path = Array.isArray(candidate.path)
      ? candidate.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      : typeof candidate.path === 'string' ? candidate.path : null
    if (path === null || typeof candidate.message !== 'string') return []
    return [{ path, message: candidate.message, code: typeof candidate.code === 'string' ? candidate.code : '' }]
  })
}

function redactSecrets(value: string, settings: Settings): string {
  const secrets = [
    settings.integrations.prowlarr.apiKey,
    settings.integrations.sonarr.apiKey,
    settings.integrations.radarr.apiKey,
    settings.ai.apiKey,
  ].filter(Boolean).sort((a, b) => b.length - a.length)
  return secrets.reduce((safe, secret) => safe.split(secret).join('[redacted]'), value)
}

function issueLabel(path: ValidationIssue['path']): string {
  const normalized = Array.isArray(path)
    ? path.join('.')
    : path.replace(/^\$\.?/, '').replace(/\[(\w+)\]/g, '.$1').replace(/^settings\./, '')
  const trimmed = Array.isArray(path) && normalized.startsWith('settings.') ? normalized.slice('settings.'.length) : normalized
  return issueFieldLabels[trimmed] ?? 'Settings'
}

function formatIssues(issues: ValidationIssue[], settings: Settings): string[] {
  return issues.map(({ path, message, code }) => {
    const detail = redactSecrets(message, settings).trim() || issueCodeFallbacks[code] || 'Check this setting and try again.'
    return `${issueLabel(path)}: ${detail}`
  })
}

function errorText(error: unknown, settings: Settings): string {
  const message = error instanceof TypeError
    ? 'Couldn’t reach Media Scout to save.'
    : error instanceof Error ? error.message : 'Settings could not be saved.'
  return redactSecrets(message, settings)
}

function App() {
  const [page, setPage] = useState<Page>(() => currentPage())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [status, setStatus] = useState<SettingsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const loadSequence = useRef(0)
  const activeLoad = useRef<{ sequence: number; controller: AbortController } | null>(null)

  const isDirty = useMemo(() => Boolean(settings && JSON.stringify(settings) !== savedSnapshot), [settings, savedSnapshot])

  const loadSettings = useCallback(async () => {
    const sequence = ++loadSequence.current
    activeLoad.current?.controller.abort()
    const controller = new AbortController()
    activeLoad.current = { sequence, controller }
    setLoading(true)
    setNotice(null)
    try {
      const response = await fetch('/api/settings', { signal: controller.signal })
      const envelope = await readEnvelope(response)
      if (sequence !== loadSequence.current || controller.signal.aborted) return
      const next = mergeSettings(envelope.settings)
      setSettings(next)
      setSavedSnapshot(JSON.stringify(next))
      setStatus(envelope.status)
    } catch (error) {
      if (sequence !== loadSequence.current || controller.signal.aborted) return
      setNotice({
        kind: 'error',
        text: error instanceof TypeError ? 'Can’t reach Media Scout right now. Check that the service is running, then try again.' : error instanceof Error ? error.message : 'Settings could not be loaded.',
      })
    } finally {
      if (sequence === loadSequence.current) {
        if (activeLoad.current?.sequence === sequence) activeLoad.current = null
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadSettings()
    return () => {
      loadSequence.current += 1
      activeLoad.current?.controller.abort()
      activeLoad.current = null
    }
  }, [loadSettings])

  useEffect(() => {
    const onHashChange = () => setPage(currentPage())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const update = useCallback((change: (current: Settings) => Settings) => {
    setSettings((current) => current ? change(current) : current)
    setNotice(null)
  }, [])

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!settings || !isDirty || saving || loading) return
    setSaving(true)
    setNotice(null)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const envelope = await readEnvelope(response)
      const next = mergeSettings(envelope.settings)
      setSettings(next)
      setSavedSnapshot(JSON.stringify(next))
      setStatus(envelope.status)
      setNotice({ kind: 'success', text: 'Settings saved. Changes apply on the next cycle.' })
    } catch (error) {
      const details = error instanceof SettingsRequestError ? formatIssues(error.issues, settings) : []
      setNotice({
        kind: 'error',
        text: `${errorText(error, settings)} Your edits are still here.`,
        ...(details.length ? { details } : {}),
      })
    } finally {
      setSaving(false)
    }
  }

  const updateIntegration = <K extends 'prowlarr' | 'sonarr' | 'radarr'>(key: K, field: keyof Settings['integrations'][K], value: string) => {
    update((current) => ({
      ...current,
      integrations: {
        ...current.integrations,
        [key]: { ...current.integrations[key], [field]: value },
      },
    }))
  }

  const updateAi = (field: keyof Settings['ai'], value: string) => {
    update((current) => ({ ...current, ai: { ...current.ai, [field]: value } }))
  }

  const updateMonitoring = (field: keyof Settings['monitoring'], value: boolean | number) => {
    update((current) => ({ ...current, monitoring: { ...current.monitoring, [field]: value } }))
  }

  const updateSafety = (field: keyof Settings['safety'], value: boolean) => {
    update((current) => ({ ...current, safety: { ...current.safety, [field]: value } }))
  }

  const saveLabel = saving ? 'Saving…' : isDirty ? 'Save changes' : 'All changes saved'
  const pageLabels: Record<Page, string> = { queue: 'Queue', reviews: 'Manual review', activity: 'Search history', settings: 'Settings', search: 'General search' }
  const missingSettings = status?.missing ?? []
  const prowlarrConfigured = Boolean(settings?.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey && settings.integrations.prowlarr.tvClient && settings.integrations.prowlarr.movieClient)

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
          <a className="brand" href="#queue" aria-label="Media Scout queue">
          <span className="brand-mark"><Waves size={20} strokeWidth={2.2} /></span>
          <span className="brand-name">media<span>scout</span></span>
        </a>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Workspace">
          <a className={`nav-item ${page === 'queue' ? 'active' : ''}`} href="#queue" aria-current={page === 'queue' ? 'page' : undefined}><Activity size={17} /> Queue {page === 'queue' && <span className="nav-dot" />}</a>
          <a className={`nav-item ${page === 'reviews' ? 'active' : ''}`} href="#reviews" aria-current={page === 'reviews' ? 'page' : undefined}><ShieldCheck size={17} /> Reviews {page === 'reviews' && <span className="nav-dot" />}</a>
          <a className={`nav-item ${page === 'activity' ? 'active' : ''}`} href="#activity" aria-current={page === 'activity' ? 'page' : undefined}><History size={17} /> Search history {page === 'activity' && <span className="nav-dot" />}</a>
          <a className={`nav-item ${page === 'search' ? 'active' : ''}`} href="#search" aria-current={page === 'search' ? 'page' : undefined}><Search size={17} /> General search {page === 'search' && <span className="nav-dot" />}</a>
          <a className={`nav-item ${page === 'settings' ? 'active' : ''}`} href="#settings" aria-current={page === 'settings' ? 'page' : undefined}><Settings2 size={17} /> Settings {page === 'settings' && <span className="nav-dot" />}</a>
        </nav>

        <div className="sidebar-bottom">
          <div className="local-note"><LockKeyhole size={15} /><span>Running on your network</span></div>
          <div className="version-note"><span className="version-light" /> Self-hosted · local control</div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="crumb"><span>Workspace</span><span className="crumb-divider">/</span><strong>{pageLabels[page]}</strong></div>
          <div className="topbar-right">
            {page === 'settings' && status && <span className={`connection-chip ${status.ready ? 'is-ready' : 'needs-setup'}`}><span className="sr-only">Instance status: </span><span className="chip-dot" />{status.ready ? 'Ready' : 'Setup needed'}</span>}
            {page === 'settings' && <button className="button button-primary top-save" type="submit" form="settings-form" disabled={!isDirty || loading || saving}>
              {saving ? <LoaderCircle className="spin" size={16} /> : isDirty ? <Save size={16} /> : <Check size={16} />}
              <span>{saveLabel}</span>
            </button>}
          </div>
        </header>

        <main id={page} className="page-wrap">
          {page === 'search' ? <GeneralSearchPage /> : page === 'settings' ? <>
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-mark" /> YOUR INSTANCE</div>
              <h1>Settings<span className="heading-period">.</span></h1>
              <p className="page-intro">Connect your library tools and set how Media Scout works for you.</p>
            </div>
            <div className="heading-stamp"><Command size={15} /><span>LOCAL CONTROL</span></div>
          </div>

          {status && <MobileSetupSummary status={status} />}

          {notice && settings && <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.kind === 'error' ? <AlertCircle size={17} /> : notice.kind === 'success' ? <CheckCircle2 size={17} /> : <CircleHelp size={17} />}
            <div className="notice-content">
              <p>{notice.text}</p>
              {notice.details && <ul className="notice-issues">{notice.details.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul>}
            </div>
            {notice.kind === 'success' && <span className="notice-close" aria-hidden="true">✓</span>}
          </div>}

          {loading && !settings ? <LoadingView /> : !settings ? <LoadError onRetry={() => void loadSettings()} loading={loading} message={notice?.text} /> : (
            <form id="settings-form" onSubmit={handleSave}>
              <fieldset className="form-fieldset" disabled={saving}>
              <div className="content-grid">
                <div className="settings-stack">
                  <Section id="arr-integrations" number="01" title="Your media stack" description="Point Media Scout to the services already running in your homelab." icon={<Film size={18} />}>
                    <div className="service-block">
                      <div className="service-heading"><div className="service-symbol prowlarr-symbol"><Waves size={17} /></div><div><h3>Prowlarr</h3><p>Indexer manager</p></div><ServiceBadge configured={prowlarrConfigured} /></div>
                      <div className="field-grid two-col">
                        <Field label="Service URL" htmlFor="prowlarr-url" hint="Use http(s); don’t include a username or password in the URL.">
                          <input id="prowlarr-url" type="url" placeholder="http://prowlarr:9696" value={settings.integrations.prowlarr.url} onChange={(e) => updateIntegration('prowlarr', 'url', e.target.value)} autoComplete="url" />
                        </Field>
                        <SecretField label="API key" id="prowlarr-key" value={settings.integrations.prowlarr.apiKey} onChange={(value) => updateIntegration('prowlarr', 'apiKey', value)} />
                        <Field label="TV download client" htmlFor="prowlarr-tv" hint="Exact client name as shown in Prowlarr">
                          <input id="prowlarr-tv" value={settings.integrations.prowlarr.tvClient} onChange={(e) => updateIntegration('prowlarr', 'tvClient', e.target.value)} placeholder="e.g. qBittorrent" />
                        </Field>
                        <Field label="Movie download client" htmlFor="prowlarr-movie" hint="Exact client name as shown in Prowlarr">
                          <input id="prowlarr-movie" value={settings.integrations.prowlarr.movieClient} onChange={(e) => updateIntegration('prowlarr', 'movieClient', e.target.value)} placeholder="e.g. qBittorrent" />
                        </Field>
                        <Field className="span-two" label="General download client" htmlFor="prowlarr-general" hint="Exact Prowlarr download-client entry name. Configure that client separately with the intended general-download category.">
                          <input id="prowlarr-general" value={settings.integrations.prowlarr.generalClient} onChange={(e) => updateIntegration('prowlarr', 'generalClient', e.target.value)} placeholder="e.g. qBittorrent" />
                        </Field>
                      </div>
                    </div>
                    <div className="service-divider" />
                    <div className="service-block">
                      <div className="service-heading"><div className="service-symbol sonarr-symbol"><Tv size={17} /></div><div><h3>Sonarr</h3><p>TV library</p></div><ServiceBadge configured={Boolean(settings.integrations.sonarr.url && settings.integrations.sonarr.apiKey)} /></div>
                      <div className="field-grid two-col">
                        <Field label="Service URL" htmlFor="sonarr-url" hint="Use http(s); don’t include a username or password in the URL.">
                          <input id="sonarr-url" type="url" placeholder="http://sonarr:8989" value={settings.integrations.sonarr.url} onChange={(e) => updateIntegration('sonarr', 'url', e.target.value)} autoComplete="url" />
                        </Field>
                        <SecretField label="API key" id="sonarr-key" value={settings.integrations.sonarr.apiKey} onChange={(value) => updateIntegration('sonarr', 'apiKey', value)} />
                      </div>
                    </div>
                    <div className="service-divider" />
                    <div className="service-block">
                      <div className="service-heading"><div className="service-symbol radarr-symbol"><Film size={17} /></div><div><h3>Radarr</h3><p>Movie library</p></div><ServiceBadge configured={Boolean(settings.integrations.radarr.url && settings.integrations.radarr.apiKey)} /></div>
                      <div className="field-grid two-col">
                        <Field label="Service URL" htmlFor="radarr-url" hint="Use http(s); don’t include a username or password in the URL.">
                          <input id="radarr-url" type="url" placeholder="http://radarr:7878" value={settings.integrations.radarr.url} onChange={(e) => updateIntegration('radarr', 'url', e.target.value)} autoComplete="url" />
                        </Field>
                        <SecretField label="API key" id="radarr-key" value={settings.integrations.radarr.apiKey} onChange={(value) => updateIntegration('radarr', 'apiKey', value)} />
                      </div>
                    </div>
                  </Section>

                  <Section id="ai-settings" number="02" title="Discovery preferences" description="Choose the AI service and set which release qualities it should prioritize." icon={<Sparkles size={18} />}>
                    <div className="field-grid two-col">
                      <SecretField label="OpenRouter API key" id="openrouter-key" value={settings.ai.apiKey} onChange={(value) => updateAi('apiKey', value)} />
                      <Field label="Model" htmlFor="ai-model" hint="Use an OpenRouter model ID">
                        <input id="ai-model" value={settings.ai.model} onChange={(e) => updateAi('model', e.target.value)} placeholder="z-ai/glm-5.3-flash" />
                      </Field>
                      <Field className="span-two" label="API base URL" htmlFor="ai-base-url" hint="Use http(s); don’t include a username or password in the URL.">
                        <input id="ai-base-url" type="url" value={settings.ai.baseUrl} onChange={(e) => updateAi('baseUrl', e.target.value)} placeholder="https://openrouter.ai/api/v1" />
                      </Field>
                      <Field className="span-two" label="Release preferences" htmlFor="ai-preferences" hint="Optional guidance, up to 4,000 characters. These preferences guide release ranking; they aren’t hard filters.">
                        <textarea id="ai-preferences" rows={4} maxLength={4000} value={settings.ai.preferences} onChange={(e) => updateAi('preferences', e.target.value)} placeholder="Prefer 1080p, English audio, and smaller files." />
                        <div className="textarea-meta"><span>Keep it broad or get specific.</span><span>{settings.ai.preferences.length.toLocaleString()} / 4,000</span></div>
                      </Field>
                      <Field className="span-two" label="Search system prompt" htmlFor="ai-search-system-prompt" hint="Optional extra system instructions for AI search. These guide search planning and relevance review, not release ranking for monitoring. Leave empty to use the standard instructions.">
                        <textarea id="ai-search-system-prompt" rows={6} maxLength={16000} value={settings.ai.searchSystemPrompt} onChange={(e) => updateAi('searchSystemPrompt', e.target.value)} placeholder="" />
                        <div className="textarea-meta"><span>Saved with your settings.</span><span>{settings.ai.searchSystemPrompt.length.toLocaleString()} / 16,000</span></div>
                      </Field>
                    </div>
                  </Section>

                  <Section id="monitoring" number="03" title="Monitoring" description="Choose whether Media Scout checks for new opportunities automatically." icon={<Activity size={18} />}>
                    <div className="toggle-row featured-toggle">
                      <div className="toggle-copy"><strong>Automatic monitoring</strong><p>Run checks on a schedule. You can still run a cycle manually outside this setting.</p></div>
                      <Switch id="monitoring-enabled" checked={settings.monitoring.enabled} onChange={(checked) => updateMonitoring('enabled', checked)} label="Automatic monitoring" />
                    </div>
                    <div className="monitor-hint"><span className="hint-icon"><CircleHelp size={15} /></span><span>Monitoring is currently <strong>{settings.monitoring.enabled ? 'on' : 'off'}</strong>. Turning this off pauses scheduled checks, not manual cycles.</span></div>
                    <details className="advanced-details">
                      <summary><span><Settings2 size={15} /> Advanced monitoring settings</span><ChevronDown size={16} className="details-chevron" /></summary>
                      <div className="field-grid two-col advanced-grid">
                        <NumberField label="Check interval" htmlFor="interval-minutes" value={settings.monitoring.intervalMinutes} suffix="minutes" max={MAX_INTERVAL_MINUTES} hint={`How often to check while monitoring is on (1–${MAX_INTERVAL_MINUTES.toLocaleString()} minutes).`} onChange={(n) => updateMonitoring('intervalMinutes', n)} />
                        <NumberField label="Minimum retry delay" htmlFor="retry-hours" value={settings.monitoring.minRetryHours} suffix="hours" hint="Wait before retrying an unsuccessful search." onChange={(n) => updateMonitoring('minRetryHours', n)} />
                        <NumberField label="Failure backoff · minimum" htmlFor="backoff-min" value={settings.monitoring.failureBackoffMinMinutes} suffix="minutes" onChange={(n) => updateMonitoring('failureBackoffMinMinutes', n)} />
                        <NumberField label="Failure backoff · maximum" htmlFor="backoff-max" value={settings.monitoring.failureBackoffMaxMinutes} suffix="minutes" hint="Must be at least the minimum backoff." onChange={(n) => updateMonitoring('failureBackoffMaxMinutes', n)} />
                        <NumberField label="Queue grace period" htmlFor="queue-grace" value={settings.monitoring.queueGraceMinutes} suffix="minutes" hint="How long to wait for a queued item." onChange={(n) => updateMonitoring('queueGraceMinutes', n)} />
                      </div>
                    </details>
                  </Section>

                  <Section id="safety" number="04" title="Safety & control" description="Keep changes deliberate. A running cycle is never interrupted by saving settings." icon={<ShieldCheck size={18} />}>
                    <div className="safety-list">
                      <div className="toggle-row">
                        <div className="toggle-copy"><strong>Dry-run mode</strong><p>Preview actions without making changes to your library tools.</p></div>
                        <Switch id="dry-run" checked={settings.safety.dryRun} onChange={(checked) => updateSafety('dryRun', checked)} label="Dry-run mode" />
                      </div>
                      {settings.safety.dryRun && <div className="dry-run-note"><ShieldCheck size={15} /><span>Dry-run does <strong>not</strong> skip searches or AI requests, so those can still use API credits.</span></div>}
                      <div className="toggle-row">
                        <div className="toggle-copy"><strong>Allow operator actions</strong><p>Permit Media Scout to carry out actions that need operator approval.</p></div>
                        <Switch id="operator-actions" checked={settings.safety.allowOperatorActions} onChange={(checked) => updateSafety('allowOperatorActions', checked)} label="Allow operator actions" />
                      </div>
                    </div>
                  </Section>

                  <div className="form-footer">
                    <span className="footer-hint"><LockKeyhole size={14} /> Your configuration stays on this instance.</span>
                    <button className="button button-primary" type="submit" disabled={!isDirty || loading || saving}>
                      {saving ? <LoaderCircle className="spin" size={16} /> : isDirty ? <Save size={16} /> : <Check size={16} />}
                      {saveLabel}
                    </button>
                  </div>
                </div>

                <aside className="right-rail" aria-label="Instance information">
                  <div className="rail-card setup-card">
                    <div className="rail-overline">INSTANCE STATUS</div>
                    <div className="ready-visual"><div className={`ready-orbit ${status?.ready ? 'orbit-ready' : ''}`}><span><Waves size={22} /></span></div><div className="ready-copy"><strong>{status?.ready ? 'Ready to scout' : 'A few things to set up'}</strong><span>{status?.ready ? 'Your required services are configured.' : 'Add the details below to get started.'}</span></div></div>
                    <div className="rail-rule" />
                    <div className="check-list">
                      <StatusRow label="Prowlarr" done={prowlarrConfigured} />
                      <StatusRow label="Sonarr" done={Boolean(settings.integrations.sonarr.url && settings.integrations.sonarr.apiKey)} />
                      <StatusRow label="Radarr" done={Boolean(settings.integrations.radarr.url && settings.integrations.radarr.apiKey)} />
                      <StatusRow label="OpenRouter" done={Boolean(settings.ai.apiKey && settings.ai.model && settings.ai.baseUrl)} />
                    </div>
                    {missingSettings.length > 0 && <p className="missing-note">Still needed: {missingSettings.join(', ')}</p>}
                  </div>

                  <div className="rail-card cycle-card">
                    <div className="rail-icon"><Radio size={17} /></div>
                    <div className="cycle-title"><strong>Scheduled checks</strong><span className={status?.monitoringEnabled ? 'state-on' : 'state-off'}><span className="tiny-dot" />{status?.monitoringEnabled ? 'Enabled' : 'Paused'}</span></div>
                    <p>Change the monitoring switch to control automatic checks. Saving applies on the next cycle.</p>
                    {status?.cycleRunning && <div className="running-label"><span className="running-pulse" />A cycle is running now</div>}
                  </div>

                  <div className="privacy-card"><div className="privacy-icon"><KeyRound size={16} /></div><div><strong>A note on API keys</strong><p>Keys are stored by this instance. Anyone with local access to Media Scout can read them. Keep your network and backups secure.</p></div></div>

                  <div className="help-link"><span>Need a hand? Check your service URLs and API keys.</span><CircleHelp size={14} /></div>
                </aside>
              </div>
              </fieldset>
            </form>
          )}
          </> : <OperationsPage page={page} />}
          <footer className="page-footer"><span>MEDIA SCOUT</span><span className="footer-divider" /><span>MADE FOR YOUR HOME LAB</span></footer>
        </main>
      </div>
    </div>
  )
}

function Section({ id, number, title, description, icon, children }: { id: string; number: string; title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return <section className="settings-card" id={id}>
    <div className="section-heading">
      <span className="section-number">{number}</span>
      <div className="section-icon">{icon}</div>
      <div className="section-title"><h2>{title}</h2><p>{description}</p></div>
    </div>
    <div className="section-body">{children}</div>
  </section>
}

function Field({ label, htmlFor, hint, children, className = '' }: { label: string; htmlFor: string; hint?: string; children: ReactNode; className?: string }) {
  return <div className={`field ${className}`}>
    <label htmlFor={htmlFor}>{label}</label>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </div>
}

function SecretField({ label, id, value, onChange }: { label: string; id: string; value: string; onChange: (value: string) => void }) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copy = async () => {
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopyFailed(true)
      window.setTimeout(() => setCopyFailed(false), 2400)
    }
  }
  return <Field label={label} htmlFor={id} hint={copyFailed ? 'Clipboard access was blocked by your browser.' : undefined}>
    <div className="secret-control">
      <input id={id} type={revealed ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />
      <button className="icon-button" type="button" onClick={() => setRevealed((shown) => !shown)} aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`} aria-pressed={revealed} title={revealed ? 'Hide key' : 'Reveal key'}>
        {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
      <button className={`icon-button copy-button ${copied ? 'copied' : ''}`} type="button" onClick={() => void copy()} disabled={!value} aria-label={copied ? `${label} copied` : `Copy ${label}`} title={copied ? 'Copied' : 'Copy key'}>
        {copied ? <Check size={16} /> : <Copy size={15} />}
      </button>
    </div>
  </Field>
}

function NumberField({ label, htmlFor, value, suffix, hint, max, onChange }: { label: string; htmlFor: string; value: number; suffix: string; hint?: string; max?: number; onChange: (value: number) => void }) {
  return <Field label={label} htmlFor={htmlFor} hint={hint}>
    <div className="number-control"><input id={htmlFor} type="number" min={1} max={max} step={1} value={value} onChange={(e) => onChange(e.target.value === '' ? 1 : Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(Number(e.target.value)))))} /><span>{suffix}</span></div>
  </Field>
}

function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button className={`switch ${checked ? 'switch-on' : ''}`} type="button" role="switch" id={id} aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}

function ServiceBadge({ configured }: { configured: boolean }) {
  return <span className={`service-badge ${configured ? 'configured' : ''}`}><span />{configured ? 'Added' : 'Needs setup'}</span>
}

function StatusRow({ label, done }: { label: string; done: boolean }) {
  return <div className="check-row"><span className={`check-status ${done ? 'done' : ''}`}>{done ? <Check size={11} /> : <span />}</span><span>{label}</span><span className={`check-label ${done ? 'complete' : ''}`}>{done ? 'Added' : 'Needed'}</span></div>
}

function MobileSetupSummary({ status }: { status: SettingsStatus }) {
  const missing = status.missing ?? []
  const shortList = missing.slice(0, 2).join(', ')
  const remaining = missing.length - 2
  const detail = status.ready
    ? 'Required services are configured.'
    : missing.length
      ? `Still needed: ${shortList}${remaining > 0 ? ` + ${remaining} more` : ''}.`
      : 'Finish required setup in the sections below.'

  return <div className={`mobile-setup-summary ${status.ready ? 'is-ready' : ''}`} aria-label="Setup summary">
    <span className="mobile-summary-icon" aria-hidden="true">{status.ready ? <CheckCircle2 size={17} /> : <CircleHelp size={17} />}</span>
    <span className="mobile-summary-copy"><strong>{status.ready ? 'Ready to scout' : 'Setup needed'}</strong><span>{detail}</span></span>
  </div>
}

function LoadingView() {
  return <div className="loading-view" role="status"><LoaderCircle className="spin" size={21} /><span>Loading your settings…</span></div>
}

function LoadError({ onRetry, loading, message }: { onRetry: () => void; loading: boolean; message?: string }) {
  return <div className="load-error"><div className="error-symbol"><AlertCircle size={20} /></div><h2>Settings aren’t available yet</h2><p>{message || 'Make sure Media Scout is running and reachable from this device, then try again.'}</p><button className="button button-primary" type="button" onClick={onRetry} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}{loading ? 'Trying again…' : 'Retry connection'}</button></div>
}

export default App
