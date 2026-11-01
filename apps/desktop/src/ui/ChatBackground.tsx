// The chat background: the layer behind a conversation, and its group in Settings › Appearance.
import { useRef, useState, type CSSProperties } from 'react'
import { ImagePlus } from 'lucide-react'
import { useThemeStyle } from '../blob/bitbots'
import { CHAT_BACKGROUND_OPACITY_MAX, CHAT_BACKGROUND_OPACITY_MIN, chooseChatBackground, removeChatBackground, updateChatBackgroundPrefs, useChatBackgroundPrefs, useChatBackgroundUrl, type ChatBackgroundScope } from './chatBackgroundStore'
import { CHAT_BACKGROUND_EFFECTS, type ChatBackgroundEffect } from './chatBackgroundEffects'
import { SegmentedControl } from './SegmentedControl'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import './chatBackground.css'

function Layer({ url, effect, opacity, empty, preview = false }: { url: string; effect: ChatBackgroundEffect; opacity: number; empty: boolean; preview?: boolean }) {
  const style = { '--chat-bg-image': `url("${url}")`, opacity } as CSSProperties
  return <div className={`chat-bg effect-${effect}${empty ? ' empty' : ''}${preview ? ' preview' : ''}`} style={style} aria-hidden="true">
    {effect === 'haze' && <><span className="chat-bg-soft" /><span className="chat-bg-strong" /></>}
  </div>
}

/** Behind the conversation, in Haze only, once an image is chosen. */
export function ChatBackgroundLayer({ empty }: { empty: boolean }) {
  const haze = useThemeStyle() === 'haze'
  const prefs = useChatBackgroundPrefs()
  const url = useChatBackgroundUrl(haze)
  if (!haze || !url || (prefs.scope === 'empty' && !empty)) return null
  return <Layer url={url} effect={prefs.effect} opacity={empty ? prefs.emptyOpacity : prefs.sessionOpacity} empty={empty} />
}

function Strength({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const percent = Math.round(value * 100)
  return <span className="chat-bg-strength">
    <input type="range" aria-label={label} min={Math.round(CHAT_BACKGROUND_OPACITY_MIN * 100)} max={Math.round(CHAT_BACKGROUND_OPACITY_MAX * 100)} value={percent} onChange={(event) => onChange(Number(event.target.value) / 100)} />
    <output>{percent}%</output>
  </span>
}

export function ChatBackgroundSettings() {
  const prefs = useChatBackgroundPrefs()
  const url = useChatBackgroundUrl(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true); setProblem(null)
    setProblem(await chooseChatBackground(file))
    setBusy(false)
  }
  const remove = async () => {
    setBusy(true); setProblem(null)
    try { await removeChatBackground() } catch { setProblem('The image could not be removed.') }
    setBusy(false)
  }
  return <SettingsGroup title="Chat background">
    <input ref={input} type="file" accept="image/*" hidden tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void pick(file) }} />
    <div className="settings-row stacked chat-bg-source">
      {prefs.hasImage
        ? <div className="chat-bg-preview">{url && <Layer url={url} effect={prefs.effect} opacity={prefs.emptyOpacity} empty preview />}<span>Empty chat at {Math.round(prefs.emptyOpacity * 100)}%</span></div>
        : <button type="button" className="chat-bg-choose" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={18} aria-hidden="true" />Choose an image</button>}
      {prefs.hasImage && <div className="chat-bg-actions">
        <button type="button" className="secondary-button small" disabled={busy} onClick={() => input.current?.click()}>Change</button>
        <button type="button" className="secondary-button small danger" disabled={busy} onClick={() => void remove()}>Remove</button>
      </div>}
      {problem && <p className="chat-bg-problem" role="alert">{problem}</p>}
    </div>
    {prefs.hasImage && <>
      <SettingsRow label="Effect"><SegmentedControl label="Background effect" value={prefs.effect} options={CHAT_BACKGROUND_EFFECTS} onChange={(effect) => updateChatBackgroundPrefs({ effect })} /></SettingsRow>
      <SettingsRow label="Show on"><SegmentedControl<ChatBackgroundScope> label="Show background on" value={prefs.scope} options={[{ value: 'empty', label: 'Empty only' }, { value: 'all', label: 'All conversations' }]} onChange={(scope) => updateChatBackgroundPrefs({ scope })} /></SettingsRow>
      <SettingsRow label="Empty chat visibility"><Strength label="Empty chat background visibility" value={prefs.emptyOpacity} onChange={(emptyOpacity) => updateChatBackgroundPrefs({ emptyOpacity })} /></SettingsRow>
      <SettingsRow label="Conversation visibility"><Strength label="Conversation background visibility" value={prefs.sessionOpacity} onChange={(sessionOpacity) => updateChatBackgroundPrefs({ sessionOpacity })} /></SettingsRow>
    </>}
  </SettingsGroup>
}
