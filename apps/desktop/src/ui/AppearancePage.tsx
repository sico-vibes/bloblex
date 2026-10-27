import { useEffect, useRef, useState } from 'react'
import { rpc } from '../tauri'
import { setThemeStyle, useThemeStyle } from '../blob/bitbots'
import { applyFonts, FONT_CATALOGUE, FONT_DEFAULTS } from './fonts'
import { THEME_LOOKS } from './appearance'
import { AccentPicker } from './AccentPicker'
import { useAccentColor, setAccentColor } from '../blob/bitbots'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { LookPicker } from './LookPicker'
import { applyAppearance, type ThemeChoice, type TextSizeChoice } from './appearance'
import { SegmentedControl } from './SegmentedControl'
import { setDensity as updateDensity, useDensity } from './uiPrefs'
import './appearancePage.css'

function cachedValue(key: string, fallback = '') { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
function writeCache(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* The daemon remains the persisted source. */ } }
function savedAppearance() { try { return JSON.parse(localStorage.getItem('bloblex.appearance') ?? '{}') as Record<string, unknown> } catch { return {} } }
export function AppearancePage() {
  const style = useThemeStyle(); const accent = useAccentColor()
  const [uiFont, setUiFont] = useState(cachedValue('bitbots.font'))
  const [monoFont, setMonoFont] = useState(cachedValue('bitbots.monoFont'))
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => { const data = savedAppearance(); return ['system','dark','light'].includes(String(data.theme)) ? data.theme as ThemeChoice : 'system' })
  const [textSize, setTextSize] = useState<TextSizeChoice>(() => { const size = document.documentElement.dataset.textSize; return ['small','default','large','larger'].includes(size ?? '') ? size as TextSizeChoice : 'default' })
  const density = useDensity()
  const [query, setQuery] = useState('')
  const textSection = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = textSection.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      for (const font of FONT_CATALOGUE) void font.load()
    }, { rootMargin: '120px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const save = async (key: string, value: unknown) => { await rpc('settings.set', { key, value }) }
  const pickLook = async (id: typeof THEME_LOOKS[number]['id']) => { await save('appearance.style', id); setThemeStyle(id); void applyFonts(uiFont, monoFont, id) }
  const pickFont = async (mono: boolean, id: string) => { await save(mono ? 'appearance.monoFont' : 'appearance.font', id); writeCache(mono ? 'bitbots.monoFont' : 'bitbots.font', id); if (mono) setMonoFont(id); else setUiFont(id); void applyFonts(mono ? uiFont : id, mono ? id : monoFont, style) }
  const fontDefaultLabel = (mono: boolean) => {
    const selectedDefault = FONT_DEFAULTS[style][mono ? 'mono' : 'ui']
    if (selectedDefault) return FONT_CATALOGUE.find((font) => font.id === selectedDefault)?.label ?? selectedDefault
    return mono ? 'Cascadia Mono' : 'System'
  }
  const fontPicker = (mono: boolean) => {
    const selectedId = mono ? monoFont : uiFont
    const selectedLabel = FONT_CATALOGUE.find((font) => font.id === selectedId)?.label ?? `Default (${fontDefaultLabel(mono)})`
    const categories = mono ? ['Mono', 'Pixel'] as const : ['Sans','Friendly / display','Mono','Pixel'] as const
    return <div className="font-choice">
      <p className="font-selected" aria-live="polite">Selected: <strong>{selectedLabel}</strong></p>
      <input className="text-input font-search" aria-label={mono ? 'Search code fonts' : 'Search interface fonts'} placeholder="Search fonts" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="font-options">
        <button type="button" className={!selectedId ? 'selected' : ''} aria-pressed={!selectedId} onClick={() => void pickFont(mono, '')}>Default ({fontDefaultLabel(mono)})</button>
        {categories.map((group) => <section key={group}><h4>{group}</h4>{FONT_CATALOGUE.filter((font) => font.category === group && font.label.toLowerCase().includes(query.toLowerCase())).map((font) => {
          const fallback = font.category === 'Mono' ? 'var(--font-mono), monospace' : 'var(--font-ui), sans-serif'
          return <button type="button" key={font.id} className={selectedId === font.id ? 'selected' : ''} style={{ fontFamily: `"${font.family}", ${fallback}` }} onFocus={() => void font.load()} onMouseEnter={() => void font.load()} onClick={() => void pickFont(mono, font.id)} aria-pressed={selectedId === font.id}>{font.label}</button>
        })}</section>)}
      </div>
    </div>
  }
  return <div className="appearance-page">
    <SettingsGroup title="Look"><SettingsRow label="Choose a look" hint="Select a visual style for Bitbots." stacked><LookPicker value={style} onChange={(id) => void pickLook(id)} compact /></SettingsRow></SettingsGroup>
    <SettingsGroup title="Colour"><SettingsRow label="Theme"><SegmentedControl label="Theme" value={themeChoice} options={(['system','dark','light'] as const).map((id) => ({ value: id, label: id[0]!.toUpperCase()+id.slice(1) }))} onChange={async (id) => { await save('appearance.theme', id); setThemeChoice(id); document.documentElement.dataset.themeChoice=id; try { localStorage.setItem('bloblex.appearance', JSON.stringify({ ...savedAppearance(), theme: id })) } catch { /* The daemon remains the persisted source. */ } applyAppearance(document.documentElement, id, textSize) }} /></SettingsRow><SettingsRow label="Accent" stacked><AccentPicker value={accent} onChange={(next) => { void save('appearance.accent', next).then(() => setAccentColor(next)) }} /></SettingsRow></SettingsGroup>
    <div ref={textSection} className="appearance-text-section"><SettingsGroup title="Text"><SettingsRow label="Interface font" stacked>{fontPicker(false)}</SettingsRow><SettingsRow label="Code font" stacked>{fontPicker(true)}</SettingsRow><SettingsRow label="Text size"><SegmentedControl label="Text size" value={textSize} options={([{ value:'small',label:'Small' },{ value:'default',label:'Default' },{ value:'large',label:'Large' },{ value:'larger',label:'Larger' }] as const)} onChange={async (id) => { await save('appearance.textSize',id); setTextSize(id); try { localStorage.setItem('bloblex.appearance', JSON.stringify({ ...savedAppearance(), textSize:id })) } catch { /* The daemon remains the persisted source. */ } applyAppearance(document.documentElement, themeChoice, id) }} /></SettingsRow><SettingsRow label="Density"><SegmentedControl label="Density" value={density} options={([{value:'compact',label:'Compact'},{value:'default',label:'Default'},{value:'roomy',label:'Roomy'}] as const)} onChange={async (id) => { await save('appearance.density',id); updateDensity(id) }} /></SettingsRow></SettingsGroup></div>
  </div>
}
