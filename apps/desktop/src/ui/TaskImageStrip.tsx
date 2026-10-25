// A read-only row of a task's stored images. Each thumbnail is fetched once from the daemon, which owns the files.
import { useEffect, useState } from 'react'
import type { BoardTaskImage } from '../types'

export function TaskImageStrip({ taskId, images, load }: { taskId: string; images: readonly BoardTaskImage[]; load: (taskId: string, imageId: string) => Promise<string> }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const key = images.map((image) => image.id).join(',')
  useEffect(() => {
    let live = true
    for (const image of images) void load(taskId, image.id).then((url) => { if (live) setUrls((current) => ({ ...current, [image.id]: url })) }).catch(() => undefined)
    return () => { live = false }
  }, [taskId, key]) // eslint-disable-line react-hooks/exhaustive-deps
  return <ul className="composer-attachments task-image-strip" aria-label="Attached images">
    {images.map((image) => <li key={image.id} className="composer-attachment ready" title={image.name}>{urls[image.id] ? <img src={urls[image.id]} alt={image.name} /> : <span className="task-image-missing">{image.name}</span>}</li>)}
  </ul>
}
