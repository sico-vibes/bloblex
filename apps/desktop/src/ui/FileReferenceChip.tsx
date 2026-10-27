import { useState } from 'react'
import { Paperclip } from 'lucide-react'
import { MediaPreview, isPreviewablePath, useMediaScope } from './MediaPreview'
import { projectRelative } from './fileReference'
import './fileReference.css'

/** A file named in a message. It can be previewed only when it lies inside this conversation's project folder. */
export function FileReferenceChip({ file }: { file: { fileName: string; path: string; size: string } }) {
  const scope = useMediaScope()
  const [open, setOpen] = useState(false)
  const relative = projectRelative(file.path, scope?.projectPath)
  const canPreview = !!relative && isPreviewablePath(relative)
  return <div className="file-reference">
    <div className="file-reference-chip" title={file.path}>
      <Paperclip size={13} aria-hidden="true" />
      <strong>{file.fileName}</strong>
      <small>{file.size} · sent as a path</small>
      {canPreview && <button type="button" className="file-reference-open" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide preview' : 'Preview'}</button>}
    </div>
    {!relative && <p className="file-reference-note">This file is outside the project, so Bitbots does not preview it. The agent can open it only if its permissions allow.</p>}
    {relative && !canPreview && <p className="file-reference-note">Bitbots cannot preview this kind of file. The agent can open it by its path.</p>}
    {open && relative && <MediaPreview path={relative} />}
  </div>
}
