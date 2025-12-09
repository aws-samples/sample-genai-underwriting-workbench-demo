import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type ManifestNode = {
  name: string
  title: string
  type: 'file' | 'dir'
  routePath: string
  children?: ManifestNode[]
  hasReadme?: boolean
}

function useManifest() {
  const [manifest, setManifest] = useState<ManifestNode | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/manual-manifest.json')
        if (!res.ok) throw new Error('Failed to load manual manifest')
        setManifest(await res.json())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error')
      }
    }
    load()
  }, [])
  return { manifest, error }
}

function findNodeByRoute(manifest: ManifestNode, routePath: string): ManifestNode | null {
  if (!routePath) return manifest
  const parts = routePath.split('/').filter(Boolean)
  let current: ManifestNode | null = manifest
  for (const part of parts) {
    if (!current || !current.children) return null
    const next = current.children.find((c) => {
      const base = c.routePath.split('/').filter(Boolean).pop()
      return base === part
    })
    if (!next) return null
    current = next
  }
  return current
}

function flattenChildren(nodes?: ManifestNode[]): ManifestNode[] {
  if (!nodes) return []
  return nodes
    .filter((n) => n.type === 'file')
    .concat(nodes.filter((n) => n.type === 'dir').flatMap((d) => flattenChildren(d.children)))
}

function Sidebar({ root, currentPath }: { root: ManifestNode; currentPath: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    // expand parents of current
    const map: Record<string, boolean> = {}
    const walk = (node: ManifestNode, parentOpen: boolean) => {
      const isCurrentAncestor = currentPath.startsWith(node.routePath)
      const open = parentOpen || isCurrentAncestor
      if (node.type === 'dir') map[node.routePath] = open
      node.children?.forEach((c) => walk(c, open))
    }
    walk(root, true)
    setExpanded(map)
  }, [root, currentPath])

  const Item = ({ node }: { node: ManifestNode }) => {
    if (node.type === 'dir') {
      const isOpen = expanded[node.routePath] ?? false
      return (
        <div className="mp-item">
          <div className="mp-dir" onClick={() => setExpanded((e) => ({ ...e, [node.routePath]: !isOpen }))}>
            <span className="mp-caret">{isOpen ? '▼' : '▶'}</span>
            <span>{node.title}</span>
          </div>
          {isOpen && (
            <div className="mp-children">
              {node.hasReadme && (
                <div className={`mp-leaf ${currentPath === node.routePath ? 'active' : ''}`}>
                  <Link to={`/manual/${node.routePath}`}>{node.title} Overview</Link>
                </div>
              )}
              {node.children?.map((c) => (
                <Item key={c.routePath} node={c} />
              ))}
            </div>
          )}
        </div>
      )
    }
    const active = currentPath === node.routePath
    return (
      <div className={`mp-leaf ${active ? 'active' : ''}`}>
        <Link to={`/manual/${node.routePath}`}>{node.title}</Link>
      </div>
    )
  }

  return (
    <div className="mp-sidebar">
      <div className="mp-sidebar-inner">
        <h3>Underwriting Manual</h3>
        {root.children?.map((c) => (
          <Item key={c.routePath} node={c} />
        ))}
      </div>
    </div>
  )
}

export default function ManualPage() {
  const { manifest, error } = useManifest()
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const slug = useMemo(() => {
    const path = location.pathname.replace(/^\/manual\/?/, '')
    return decodeURIComponent(path)
  }, [location.pathname])

  const [markdown, setMarkdown] = useState<string>('Loading...')
  const [mdError, setMdError] = useState<string | null>(null)

  useEffect(() => {
    if (!manifest) return
    const node = findNodeByRoute(manifest, slug)
    if (!node) {
      navigate('/manual', { replace: true })
      return
    }
    const computeFilePath = () => {
      // Files map 1:1 to /public/manual/<routePath>.md
      if (node.type === 'file') return `/manual/${node.routePath}.md`
      // For directories, prefer README.md if present
      if (node.hasReadme) return `/manual/${node.routePath ? node.routePath + '/' : ''}README.md`
      // Fallback: first file inside
      const first = flattenChildren(node.children).at(0)
      return first ? `/manual/${first.routePath}.md` : null
    }
    const mdPath = computeFilePath()
    if (!mdPath) {
      setMdError('No markdown found in this section')
      return
    }
    const load = async () => {
      try {
        setMdError(null)
        setMarkdown('Loading...')
        const res = await fetch(mdPath)
        if (!res.ok) throw new Error('Failed to load markdown')
        setMarkdown(await res.text())
      } catch (e) {
        setMdError(e instanceof Error ? e.message : 'Unknown error')
      }
    }
    load()
  }, [manifest, slug, navigate])

  if (error) return <div className="mp-container"><div className="mp-error">{error}</div></div>
  if (!manifest) return <div className="mp-container">Loading manual…</div>

  return (
    <div className="mp-container">
      <Sidebar root={manifest} currentPath={slug} />
      <div className="mp-content">
        {mdError ? (
          <div className="mp-error">{mdError}</div>
        ) : (
          <div className="mp-article">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}


