import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Activity as ActivityIcon, Bot, Check, CheckCircle2, CircleAlert, Copy, Eye, EyeOff, Film, KeyRound, Radio, Search as SearchIcon, Settings2, ShieldCheck, SlidersHorizontal, Tv, Waves } from 'lucide-react'
import { defaults, mergeSettings, type Settings, type SettingsEnvelope } from './types'
import { SearchPage } from './Search'
import { ActivityPage, AutomationPage } from './Activity'

type Page = 'search' | 'activity' | 'automation' | 'settings'
function pageFromHash(): Page { const value = location.hash.slice(1); return ['activity', 'automation', 'settings'].includes(value) ? value as Page : 'search' }

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash), [selectedSearch, setSelectedSearch] = useState<{ id?: string; revision: number }>({ revision: 0 })
  const selectionRevision = useRef(0)
  const [settings, setSettings] = useState<Settings>(defaults), [committed, setCommitted] = useState<Settings | null>(null), [status, setStatus] = useState<SettingsEnvelope['status'] | null>(null)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [messageIsError, setMessageIsError] = useState(false), [saved, setSaved] = useState('')
  const dirty = useMemo(() => JSON.stringify(settings) !== saved, [settings, saved])
  const accept = (envelope: SettingsEnvelope) => { const next = mergeSettings(envelope.settings); setSettings(next); setCommitted(next); setStatus(envelope.status); setSaved(JSON.stringify(next)) }
  const load = useCallback(async () => {
    setLoading(true)
    try { const response = await fetch('/api/settings'); if (!response.ok) throw new Error(); accept(await response.json()); setMessage(''); setMessageIsError(false) }
    catch { setMessage('Could not load settings. Check that Media Scout is running.'); setMessageIsError(true) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load(); const change = () => setPage(pageFromHash()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change) }, [load])
  async function persist(next: Settings, preserveDraft = false) {
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
    if (!response.ok) {
      let payload: { issues?: Array<{ path?: Array<string | number>; message?: string }> } = {}
      try { payload = await response.json() } catch { /* The server may return a non-JSON proxy error. */ }
      const details = (payload.issues ?? []).map(issue => {
        const path = issue.path?.join('.') ?? ''
        const field = settingsFieldLabels[path] ?? path
        const reason = issue.message ?? 'is invalid'
        return `${field ? `${field}: ` : ''}${reason.replace('failureBackoffMinMinutes', 'Initial failure backoff (minutes)')}`
      })
      throw new Error(details.length ? `Settings could not be saved. ${details.join('; ')}` : `Settings could not be saved (HTTP ${response.status}). Check the values and try again.`)
    }
    const envelope = await response.json() as SettingsEnvelope
    const savedSettings = mergeSettings(envelope.settings)
    setCommitted(savedSettings)
    setSettings(draft => preserveDraft ? { ...draft, monitoring: { ...draft.monitoring, enabled: draft.monitoring.enabled === committed?.monitoring.enabled ? savedSettings.monitoring.enabled : draft.monitoring.enabled } } : savedSettings)
    setStatus(envelope.status); setSaved(JSON.stringify(savedSettings))
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setMessage(''); setMessageIsError(false)
    try { await persist(settings); setMessage('Settings saved.') }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : 'Settings could not be saved.'); setMessageIsError(true) }
    finally { setSaving(false) }
  }
  async function toggleAutomation() {
    const response = await fetch('/api/settings')
    if (!response.ok) throw new Error('Settings unavailable')
    const current = (await response.json() as SettingsEnvelope).settings
    await persist({ ...current, monitoring: { ...current.monitoring, enabled: !current.monitoring.enabled } }, true)
  }
  const openSearch = (id: string) => {
    const revision = ++selectionRevision.current
    setSelectedSearch({ id, revision })
    setPage('search')
    location.hash = '#search'
  }
  const searchStarted = (id: string, startingRevision: number) => {
    if (selectionRevision.current !== startingRevision) return
    const revision = ++selectionRevision.current
    setSelectedSearch({ id, revision })
  }
  const labels: Record<Page, string> = { search: 'Search', activity: 'Activity', automation: 'Automation', settings: 'Settings' }
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Main navigation"><a className="brand" href="#search"><span className="brand-mark"><Waves size={19}/></span><span className="brand-name">media<span>scout</span></span></a><div className="workspace-label">Workspace</div><nav className="primary-nav" aria-label="Workspace">{([['search', SearchIcon], ['activity', ActivityIcon], ['automation', Radio], ['settings', Settings2]] as const).map(([key, Icon]) => <a key={key} className={`nav-item ${page === key ? 'active' : ''}`} href={`#${key}`} aria-current={page === key ? 'page' : undefined}><Icon size={17}/>{labels[key]}</a>)}</nav><div className="sidebar-bottom"><div className="local-note"><Waves size={15}/>Running on your network</div><div className="version-note">Self-hosted · local control</div></div></aside>
    <div className="main-column"><header className="topbar"><div className="crumb"><span>Workspace</span><span className="crumb-divider">/</span><strong>{labels[page]}</strong></div><div className="topbar-right">{committed && <span className="connection-chip">{committed.safety.dryRun ? 'Dry-run on' : 'Downloads enabled'}</span>}{page === 'settings' && <button className="button button-primary" type="submit" form="settings-form" disabled={!dirty || loading || saving}>{saving ? 'Saving…' : dirty ? 'Save changes' : 'All changes saved'}</button>}</div></header>
      <main className="page-wrap" id={page}>
        <UnsavedNotice dirty={Boolean(committed) && dirty}/>
        {committed && <div id="search-workspace" hidden={page !== 'search'} aria-hidden={page !== 'search'}>
          <SearchPage settings={committed} searchId={selectedSearch.id} searchRevision={selectedSearch.revision} active={page === 'search'} onSearchStarted={searchStarted}/>
        </div>}
        {page === 'search' && !committed && <SettingsUnavailable loading={loading} message={message} retry={() => void load()}/>}
        {page === 'activity' && <ActivityPage onOpenSearch={openSearch}/>}
        {page === 'automation' && (committed ? <AutomationPage settings={committed} onOpenSearch={openSearch} onToggle={toggleAutomation}/> : <SettingsUnavailable loading={loading} message={message} retry={() => void load()}/>)}
        {page === 'settings' && <>
          <div className="page-heading"><div><h1>Settings<span className="heading-period">.</span></h1><p className="page-intro">Connect search services. Add Arr only if you want automation.</p></div></div>
           {message && <div className={`notice ${messageIsError ? 'notice-error' : 'notice-success'}`} role={messageIsError ? 'alert' : 'status'}>{messageIsError ? <CircleAlert size={17}/> : <CheckCircle2 size={17}/>}<span>{message}</span></div>}
          {loading ? <p role="status">Loading settings…</p> : <form id="settings-form" onSubmit={save}><div className="content-grid"><div className="settings-stack">
             <Section title="Search services" description="Connect the indexers and model Scout uses to find and compare releases." icon={<SearchIcon size={18}/>}>
              <Group title="Prowlarr" fields={[["Prowlarr URL", settings.integrations.prowlarr.url, 'url'], ["Prowlarr API key", settings.integrations.prowlarr.apiKey, 'apiKey'], ["TV download client", settings.integrations.prowlarr.tvClient, 'tvClient'], ["Movie download client", settings.integrations.prowlarr.movieClient, 'movieClient']]} update={(key, value) => setSettings(s => ({ ...s, integrations: { ...s.integrations, prowlarr: { ...s.integrations.prowlarr, [key]: value } } }))}/>
              <Group title="AI model" fields={[["AI API key", settings.ai.apiKey, 'apiKey'], ["Model", settings.ai.model, 'model'], ["AI API base URL", settings.ai.baseUrl, 'baseUrl']]} update={(key, value) => setSettings(s => ({ ...s, ai: { ...s.ai, [key]: value } }))}/>
              <Field label="Default preferences" value={settings.ai.preferences} multiline onChange={value => setSettings(s => ({ ...s, ai: { ...s.ai, preferences: value } }))}/>
            </Section>
             <Section title="Optional library connections" description="Connect Sonarr or Radarr to search from your existing library." icon={<Film size={18}/>}>
               <Group title="Sonarr" fields={[["Sonarr URL", settings.integrations.sonarr.url, 'url'], ["Sonarr API key", settings.integrations.sonarr.apiKey, 'apiKey']]} update={(key, value) => setSettings(s => ({ ...s, integrations: { ...s.integrations, sonarr: { ...s.integrations.sonarr, [key]: value } } }))}/>
               <Group title="Radarr" fields={[["Radarr URL", settings.integrations.radarr.url, 'url'], ["Radarr API key", settings.integrations.radarr.apiKey, 'apiKey']]} update={(key, value) => setSettings(s => ({ ...s, integrations: { ...s.integrations, radarr: { ...s.integrations.radarr, [key]: value } } }))}/>
             </Section>
             <Section title="Search limits" description="Set bounds for how long Scout searches and how many service calls it makes." icon={<SlidersHorizontal size={18}/>}>
                <div className="field-grid">{(['maxDecisions', 'maxSearches', 'deadlineMinutes'] as const).map(key => <label className="field number-field" key={key}>{key === 'maxDecisions' ? 'Model decisions' : key === 'maxSearches' ? 'Indexer searches' : 'Time limit (minutes)'}<input type="number" min="1" max={key === 'maxDecisions' ? 20 : key === 'maxSearches' ? 12 : 10} step="1" required value={Number.isNaN(settings.search[key]) ? '' : settings.search[key]} onChange={event => setSettings(s => ({ ...s, search: { ...s.search, [key]: numericValue(event.target.value) } }))}/><span className="field-hint">1–{key === 'maxDecisions' ? 20 : key === 'maxSearches' ? 12 : 10}</span></label>)}</div><p className="field-hint">All returned candidates remain visible to the model. These limits bound calls and time, not a top-N result list.</p>
             </Section>
             <Section title="Automation and retries" description="Control scheduled Arr searches, safety mode, and retry timing." icon={<Radio size={18}/>}>
              <Toggle label="Automatic monitoring" description="Scheduled Arr searches can submit the best suitable recommendation when dry-run is off." checked={settings.monitoring.enabled} onChange={enabled => setSettings(s => ({ ...s, monitoring: { ...s.monitoring, enabled } }))}/>
              <Toggle label="Dry-run mode" description="Search and compare, but never submit a download. Live searches still use model/indexer calls." checked={settings.safety.dryRun} onChange={dryRun => setSettings(s => ({ ...s, safety: { dryRun } }))}/>
               <div className="field-grid">{([['Check interval (minutes)', 'intervalMinutes', 35791], ['Search-only retry (minutes)', 'searchRetryMinutes', 525600], ['Initial failure backoff (minutes)', 'failureBackoffMinMinutes', 35791], ['Maximum failure backoff (minutes)', 'failureBackoffMaxMinutes', 35791], ['Queue appearance grace (minutes)', 'queueGraceMinutes', 1440]] as const).map(([label, key, max]) => <label className="field number-field" key={key}>{label}<input type="number" min="1" max={max} step="1" required value={Number.isNaN(settings.monitoring[key]) ? '' : settings.monitoring[key]} onChange={event => setSettings(s => ({ ...s, monitoring: { ...s.monitoring, [key]: numericValue(event.target.value) } }))}/><span className="field-hint">1–{max.toLocaleString()}</span></label>)}</div>
              <p className="field-hint">After finite appearance grace, unmatched downloads may be retried. Scout does not inspect or cancel qBittorrent jobs.</p>
             </Section>
           </div><aside className="right-rail" aria-label="Instance information">
              <div className="rail-card setup-card"><div className="rail-overline">INSTANCE STATUS</div><div className="ready-visual"><div className={`ready-orbit ${status?.ready ? 'orbit-ready' : ''}`}><span>{status?.ready ? <CheckCircle2 size={20}/> : <CircleAlert size={20}/>}</span></div><div className="ready-copy"><strong>{status?.ready ? 'Ready to search' : 'Setup needed'}</strong><span>{status?.ready ? 'Required services are configured.' : 'Add the required services to get started.'}</span></div></div><div className="rail-rule"/><div className="check-list"><StatusRow label="Prowlarr" done={Boolean(settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey)}/><StatusRow label="AI model" done={Boolean(settings.ai.apiKey && settings.ai.model && settings.ai.baseUrl)}/><StatusRow label="Sonarr" done={Boolean(settings.integrations.sonarr.url && settings.integrations.sonarr.apiKey)} optional/><StatusRow label="Radarr" done={Boolean(settings.integrations.radarr.url && settings.integrations.radarr.apiKey)} optional/></div></div>
             <div className="rail-card cycle-card"><div className="rail-icon"><Radio size={17}/></div><div className="cycle-title"><strong>Automatic monitoring</strong><span className={status?.monitoringEnabled ? 'state-on' : 'state-off'}><span className="tiny-dot"/>{status?.monitoringEnabled ? 'Enabled' : 'Paused'}</span></div><p>Scheduled checks use your Arr libraries. You can still search manually while monitoring is paused.</p></div>
             <div className="privacy-card"><div className="privacy-icon"><KeyRound size={16}/></div><div><strong>Keep this instance private</strong><p>API keys are stored here and visible to anyone with access. Only expose this app on a trusted network.</p></div></div>
             {committed?.safety.dryRun && <div className="dry-run-note"><ShieldCheck size={15}/><span>Dry-run prevents download submission. Searches still call your model and indexers.</span></div>}
           </aside></div></form>}
        </>}
        <footer className="page-footer"><span>Media Scout</span><span className="footer-divider"/><span>Made for your home lab</span></footer>
      </main>
    </div>
  </div>
}
function Section({ title, description, icon, children }: { title: string; description: string; icon: ReactNode; children: ReactNode }) { return <section className="settings-card"><div className="section-heading"><div className="section-icon">{icon}</div><div className="section-title"><h2>{title}</h2><p>{description}</p></div></div><div className="section-body">{children}</div></section> }
function UnsavedNotice({ dirty }: { dirty: boolean }) { return dirty ? <div className="notice notice-error" role="status"><CircleAlert size={17}/><span>Unsaved settings. Search and automation use the last saved settings.</span></div> : null }
function SettingsUnavailable({ loading, message, retry }: { loading: boolean; message: string; retry(): void }) { return <div className={`notice ${loading ? '' : 'notice-error'}`} role={loading ? 'status' : 'alert'}>{loading ? 'Loading committed settings…' : message}<button className="text-button" type="button" disabled={loading} onClick={retry}>Retry</button></div> }
function Field({ label, value, onChange, multiline = false }: { label: string; value: string; onChange(value: string): void; multiline?: boolean }) {
  const id = useId(), inputRef = useRef<HTMLInputElement>(null), [revealed, setRevealed] = useState(false), [copied, setCopied] = useState(false), [copyFailed, setCopyFailed] = useState(false), secret = label.includes('API key')
  useEffect(() => { if (!copied) return; const timeout = window.setTimeout(() => setCopied(false), 1600); return () => window.clearTimeout(timeout) }, [copied])
  async function copySecret() {
    setCopyFailed(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      const input = inputRef.current
      let copiedWithFallback = false
      if (input) {
        const originalType = input.type
        try {
          input.type = 'text'
          input.select()
          copiedWithFallback = document.execCommand?.('copy') ?? false
        } catch { /* Clipboard fallback is not available in every browser. */ }
        finally { input.type = originalType; input.setSelectionRange(0, 0) }
      }
      if (copiedWithFallback) {
        setCopied(true)
      } else setCopyFailed(true)
    }
  }
  return <div className="field"><label htmlFor={id}>{label}</label>{multiline ? <textarea id={id} rows={3} value={value} onChange={event => onChange(event.target.value)}/> : secret ? <div className="secret-control"><input ref={inputRef} id={id} value={value} type={revealed ? 'text' : 'password'} autoComplete="off" onChange={event => onChange(event.target.value)}/><div className="secret-actions"><button className="icon-button" type="button" onClick={() => setRevealed(!revealed)} aria-label={`${revealed ? 'Hide' : 'Reveal'} ${label}`}>{revealed ? <EyeOff size={16}/> : <Eye size={16}/>}</button><button className={`icon-button ${copied ? 'copied' : ''}`} type="button" disabled={!value} onClick={() => void copySecret()} aria-label={`Copy ${label}`} title={copied ? 'Copied' : 'Copy API key'}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button></div>{copied && <span className="sr-only" role="status">API key copied to clipboard</span>}{copyFailed && <span className="copy-error" role="status">Clipboard is unavailable. Reveal the key and copy it manually.</span>}</div> : <input id={id} value={value} type={label.endsWith('URL') ? 'url' : 'text'} onChange={event => onChange(event.target.value)}/>}</div>
}
const settingsFieldLabels: Record<string, string> = {
  'integrations.prowlarr.url': 'Prowlarr URL', 'integrations.prowlarr.apiKey': 'Prowlarr API key',
  'integrations.prowlarr.tvClient': 'TV download client', 'integrations.prowlarr.movieClient': 'Movie download client',
  'integrations.sonarr.url': 'Sonarr URL', 'integrations.sonarr.apiKey': 'Sonarr API key',
  'integrations.radarr.url': 'Radarr URL', 'integrations.radarr.apiKey': 'Radarr API key',
  'ai.apiKey': 'AI API key', 'ai.model': 'Model', 'ai.baseUrl': 'AI API base URL',
  'ai.preferences': 'Default preferences', 'monitoring.intervalMinutes': 'Check interval (minutes)',
  'monitoring.searchRetryMinutes': 'Search-only retry (minutes)', 'monitoring.failureBackoffMinMinutes': 'Initial failure backoff (minutes)',
  'monitoring.failureBackoffMaxMinutes': 'Maximum failure backoff (minutes)', 'monitoring.queueGraceMinutes': 'Queue appearance grace (minutes)',
  'search.maxDecisions': 'Model decisions', 'search.maxSearches': 'Indexer searches', 'search.deadlineMinutes': 'Time limit (minutes)',
}
const numericValue = (value: string): number => value.trim() === '' ? Number.NaN : Number(value)
function Group({ title, fields, update }: { title: string; fields: Array<[string, string, string]>; update(key: string, value: string): void }) { const Icon = title === 'Prowlarr' ? Waves : title === 'Sonarr' ? Tv : title === 'Radarr' ? Film : Bot; return <div className="service-block"><div className="service-heading"><span className={`service-symbol ${title.toLowerCase()}-symbol`}><Icon size={17}/></span><div><h3>{title}</h3><p>{title === 'Prowlarr' ? 'Indexer manager and download routes' : title === 'Sonarr' ? 'Optional TV library' : title === 'Radarr' ? 'Optional movie library' : 'Ranking and search decisions'}</p></div><span className={`service-badge ${fields.every(([, value]) => value.trim()) ? 'configured' : ''}`}><span/>{fields.every(([, value]) => value.trim()) ? 'Configured' : 'Needs setup'}</span></div><div className="field-grid">{fields.map(([label, value, key]) => <Field key={key} label={label} value={value} onChange={value => update(key, value)}/>)}</div></div> }
function StatusRow({ label, done, optional = false }: { label: string; done: boolean; optional?: boolean }) { return <div className="check-row"><span className={`check-status ${done ? 'done' : ''}`}>{done ? <Check size={11}/> : <span/>}</span><span>{label}</span><span className={`check-label ${done ? 'complete' : ''}`}>{done ? 'Added' : optional ? 'Optional' : 'Needed'}</span></div> }
function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }) { return <div className="toggle-row"><div className="toggle-copy"><strong>{label}</strong><p>{description}</p></div><button className={`switch ${checked ? 'switch-on' : ''}`} role="switch" aria-label={label} aria-checked={checked} type="button" onClick={() => onChange(!checked)}><span/></button></div> }
