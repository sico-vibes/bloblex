// The remote build's stand-in for `src/ui/PdfViewer.tsx`. `media.preview` is
// never allowed from a device (tiers.json), so a phone can never receive a PDF's
// bytes, and pdf.js (about 1.8 MB with its worker) would only fill the precache.

export default function PdfViewer({ name }: { dataUrl: string; name: string; size?: number | null; onReveal?: () => void }) {
  return <p>{name} can be previewed on the desktop.</p>
}
