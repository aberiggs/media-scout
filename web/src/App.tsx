import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Activity as ActivityIcon, Search as SearchIcon, Settings2, Waves, Radio } from 'lucide-react'
import { defaults, mergeSettings, type Settings, type SettingsEnvelope } from './types'
import { SearchPage } from './Search'
import { ActivityPage, AutomationPage } from './Activity'

type Page = 'search' | 'activity' | 'automation' | 'settings'
function pageFromHash(): Page { const value = location.hash.slice(1); return ['activity', 'automation', 'settings'].includes(value) ? value as Page : 'search' }

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash), [openedSearch, setOpenedSearch] = useState<string>()
  const [settings, setSettings] = useState<Settings>(defaults), [status, setStatus] = useState<SettingsEnvelope['status'] | null>(null)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [saved, setSaved] = useState('')
  const dirty = useMemo(() => JSON.stringify(settings) !== saved, [settings, saved])
  const accept = (envelope: SettingsEnvelope) => { const next = mergeSettings(envelope.settings); setSettings(next); setStatus(envelope.status); setSaved(JSON.stringify(next)) }
  const load = useCallback(async () => {
    setLoading(true)
    try { const response = await fetch('/api/settings'); if (!response.ok) throw new Error(); accept(await response.json()); setMessage('') }
    catch { setMessage('Could not load settings. Check that Media Scout is running.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load(); const change = () => setPage(pageFromHash()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change) }, [load])
  async function persist(next: Settings) {
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
    if (!response.ok) throw new Error('Settings were rejected. Review the values and try again.')
    accept(await response.json())
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setMessage('')
    try { await persist(settings); setMessage('Settings saved.') }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : 'Settings could not be saved.') }
    finally { setSaving(false) }
  }
  async function toggleAutomation() {
    const response = await fetch('/api/settings')
    if (!response.ok) throw new Error('Settings unavailable')
    const current = (await response.json() as SettingsEnvelope).settings
    await persist({ ...current, monitoring: { ...current.monitoring, enabled: !current.monitoring.enabled } })
  }
  const openSearch = (id: string) => { setOpenedSearch(id); setPage('search'); location.hash = '#search' }
  const labels: Record<Page, string> = { search: 'Search', activity: 'Activity', automation: 'Automation', settings: 'Settings' }
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Main navigation"><a className="brand" href="#search"><span className="brand-mark"><Waves size={19}/></span><span className="brand-name">media<span>scout</span></span></a><div className="workspace-label">Workspace</div><nav className="primary-nav" aria-label="Workspace">{([['search', SearchIcon], ['activity', ActivityIcon], ['automation', Radio], ['settings', Settings2]] as const).map(([key, Icon]) => <a key={key} className={`nav-item ${page === key ? 'active' : ''}`} href={`#${key}`} aria-current={page === key ? 'page' : undefined}><Icon size={17}/>{labels[key]}</a>)}</nav><div className="sidebar-bottom"><div className="local-note"><Waves size={15}/>Running on your network</div><div className="version-note">Self-hosted · local control</div></div></aside>
    <div className="main-column"><header className="topbar"><div className="crumb"><span>Workspace</span><span className="crumb-divider">/</span><strong>{labels[page]}</strong></div><div className="topbar-right"><span className="connection-chip">{settings.safety.dryRun ? 'Dry-run on' : 'Downloads enabled'}</span>{page === 'settings' && <button className="button button-primary" type="submit" form="settings-form" disabled={!dirty || loading || saving}>{saving ? 'Saving…' : dirty ? 'Save changes' : 'All changes saved'}</button>}</div></header>
      <main className="page-wrap" id={page}>
        {page === 'search' && <SearchPage settings={settings} searchId={openedSearch}/>}
        {page === 'activity' && <ActivityPage onOpenSearch={openSearch}/>}
        {page === 'automation' && <AutomationPage settings={settings} onOpenSearch={openSearch} onToggle={toggleAutomation}/>}
        {page === 'settings' && <>
          <div className="page-heading"><div><h1>Settings<span className="heading-period">.</span></h1><p className="page-intro">Connect search services. Add Arr only if you want automation.</p></div></div>
          {message && <p className="notice" role="status">{message}</p>}
          {loading ? <p role="status">Loading settings…</p> : <form id="settings-form" onSubmit={save}><div className="content-grid"><div className="settings-stack">
            <Section title="Search services">
              <Group title="Prowlarr" fields={[["Prowlarr URL", settings.integrations.prowlarr.url, 'url'], ["Prowlarr API key", settings.integrations.prowlarr.apiKey, 'apiKey'], ["TV download client", settings.integrations.prowlarr.tvClient, 'tvClient'], ["Movie download client", settings.integrations.prowlarr.movieClient, 'movieClient']]} update={(key, value) => setSettings(s => ({ ...s, integrations: { ...s.integrations, prowlarr: { ...s.integrations.prowlarr, [key]: value } } }))}/>
              <Group title="AI model" fields={[["AI API key", settings.ai.apiKey, 'apiKey'], ["Model", settings.ai.model, 'model'], ["AI API base URL", settings.ai.baseUrl, 'baseUrl']]} update={(key, value) => setSettings(s => ({ ...s, ai: { ...s.ai, [key]: value } }))}/>
              <Field label="Default preferences" value={settings.ai.preferences} multiline onChange={value => setSettings(s => ({ ...s, ai: { ...s.ai, preferences: value } }))}/>
            </Section>
            <Section title="Optional library connections">{(['sonarr', 'radarr'] as const).map(provider => <Group key={provider} title={provider === 'sonarr' ? 'Sonarr' : 'Radarr'} fields={[[`${provider} URL`, settings.integrations[provider].url, 'url'], [`${provider} API key`, settings.integrations[provider].apiKey, 'apiKey']]} update={(key, value) => setSettings(s => ({ ...s, integrations: { ...s.integrations, [provider]: { ...s.integrations[provider], [key]: value } } }))}/>)}</Section>
            <Section title="Search limits"><div className="field-grid">{(['maxDecisions', 'maxSearches', 'deadlineMinutes'] as const).map(key => <label className="field" key={key}>{key === 'maxDecisions' ? 'Model decisions' : key === 'maxSearches' ? 'Indexer searches' : 'Time limit (minutes)'}<input type="number" min="1" max={key === 'maxDecisions' ? 20 : key === 'maxSearches' ? 12 : 10} value={settings.search[key]} onChange={event => setSettings(s => ({ ...s, search: { ...s.search, [key]: Number(event.target.value) } }))}/></label>)}</div><p className="field-hint">All returned candidates remain visible to the model. These limits bound calls and time, not a top-N result list.</p></Section>
            <Section title="Automation and retries">
              <Toggle label="Automatic monitoring" description="Scheduled Arr searches can submit the best suitable recommendation when dry-run is off." checked={settings.monitoring.enabled} onChange={enabled => setSettings(s => ({ ...s, monitoring: { ...s.monitoring, enabled } }))}/>
              <Toggle label="Dry-run mode" description="Search and compare, but never submit a download. Live searches still use model/indexer calls." checked={settings.safety.dryRun} onChange={dryRun => setSettings(s => ({ ...s, safety: { dryRun } }))}/>
              <div className="field-grid">{([['Check interval (minutes)', 'intervalMinutes'], ['No-match retry (hours)', 'minRetryHours'], ['Initial failure backoff (minutes)', 'failureBackoffMinMinutes'], ['Maximum failure backoff (minutes)', 'failureBackoffMaxMinutes'], ['Queue appearance grace (minutes)', 'queueGraceMinutes']] as const).map(([label, key]) => <label className="field" key={key}>{label}<input type="number" min="1" value={settings.monitoring[key]} onChange={event => setSettings(s => ({ ...s, monitoring: { ...s.monitoring, [key]: Number(event.target.value) } }))}/></label>)}</div>
              <p className="field-hint">After finite appearance grace, unmatched downloads may be retried. Scout does not inspect or cancel qBittorrent jobs.</p>
            </Section>
          </div><aside className="right-rail"><div className="rail-card"><strong>Search is {status?.ready ? 'ready' : 'not configured'}</strong><p>Prowlarr and a model are enough for standalone search. Sonarr and Radarr are optional.</p><p>{settings.safety.dryRun ? 'Dry-run is on. No downloads will be submitted.' : 'Downloads are enabled. Manual search still requires explicit confirmation.'}</p></div></aside></div></form>}
        </>}
        <footer className="page-footer"><span>Media Scout</span><span className="footer-divider"/><span>Made for your home lab</span></footer>
      </main>
    </div>
  </div>
}
function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="settings-card"><div className="section-heading"><div className="section-title"><h2>{title}</h2></div></div><div className="section-body">{children}</div></section> }
function Field({ label, value, onChange, multiline = false }: { label: string; value: string; onChange(value: string): void; multiline?: boolean }) { return <label className="field">{label}{multiline ? <textarea rows={3} value={value} onChange={event => onChange(event.target.value)}/> : <input value={value} type={label.includes('API key') ? 'password' : 'text'} onChange={event => onChange(event.target.value)}/>}</label> }
function Group({ title, fields, update }: { title: string; fields: Array<[string, string, string]>; update(key: string, value: string): void }) { return <div className="service-block"><h3>{title}</h3><div className="field-grid">{fields.map(([label, value, key]) => <Field key={key} label={label} value={value} onChange={value => update(key, value)}/>)}</div></div> }
function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }) { return <div className="toggle-row"><div className="toggle-copy"><strong>{label}</strong><p>{description}</p></div><button className={`switch ${checked ? 'switch-on' : ''}`} role="switch" aria-label={label} aria-checked={checked} type="button" onClick={() => onChange(!checked)}><span/></button></div> }
