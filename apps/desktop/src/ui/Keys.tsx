// One look for every keyboard shortcut in the app: each key in its own small cap.
const keyParts = (keys: string) => keys.split(/\+(?=.)/).map((key) => key.trim()).filter(Boolean)

export function Keys({ keys }: { keys: string }) {
  const options = keys.split(' / ')
  return <span className="keys">{options.map((option, index) => <span className="keys-option" key={option}>
    {index > 0 && <span className="keys-or" aria-hidden="true">/</span>}
    {keyParts(option).map((key, part) => <kbd className="settings-kbd" key={`${key}-${part}`}>{key}</kbd>)}
  </span>)}</span>
}
