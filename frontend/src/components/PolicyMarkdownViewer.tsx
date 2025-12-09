import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface PolicyMarkdownViewerProps {
  source: { type: 's3', key: string } | { type: 'raw', markdown: string }
  highlightTerms?: string[]
  onClose?: () => void
}

export function PolicyMarkdownViewer({ source, highlightTerms, onClose }: PolicyMarkdownViewerProps) {
  const [markdown, setMarkdown] = useState<string>('Loading policy...')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchMarkdown = async () => {
      try {
        if (source.type === 'raw') {
          setMarkdown(source.markdown)
          return
        }
        const params = new URLSearchParams({ key: source.key })
        const resp = await fetch(`${import.meta.env.VITE_API_URL}/policy?${params.toString()}`)
        if (!resp.ok) throw new Error('Failed to fetch policy markdown URL')
        const data = await resp.json()
        if (!data.url) throw new Error('No URL returned for policy markdown')
        const raw = await fetch(data.url)
        if (!raw.ok) throw new Error('Failed to download policy markdown')
        const text = await raw.text()
        setMarkdown(text)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error')
      }
    }
    fetchMarkdown()
  }, [source])

  return (
    <div className="policy-markdown-viewer">
      <div className="pmv-header">
        <h3>Policy Reference</h3>
        {onClose && <button onClick={onClose}>Close</button>}
      </div>
      <div className="pmv-content">
        {error ? (
          <div className="pmv-error">{error}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        )}
      </div>
    </div>
  )
}


