import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppTopBar } from './AppTopBar'

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
    const next: ManifestNode | undefined = current.children.find((c) => {
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

/**
 * Left-hand table-of-contents. Hairline sidebar (no cards): expandable section
 * rows with a chevron caret and 600-weight label; leaves are muted and indented
 * one level deeper; the active leaf gets a $--sidebar-accent fill. Mirrors the
 * "Manual Sidebar" in designs/underwriting workbench.pen.
 */
function Sidebar({
  root,
  currentPath,
  onNavigate,
}: {
  root: ManifestNode
  currentPath: string
  onNavigate: (routePath: string) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const map: Record<string, boolean> = {}
    const walk = (node: ManifestNode) => {
      const isCurrentAncestor =
        currentPath === node.routePath || currentPath.startsWith(node.routePath + '/')
      if (node.type === 'dir') map[node.routePath] = isCurrentAncestor
      node.children?.forEach(walk)
    }
    root.children?.forEach(walk)
    setExpanded(map)
  }, [root, currentPath])

  // depth 0 = top-level section, deeper = nested subsection; indent grows 14px per level.
  const Item = ({ node, depth }: { node: ManifestNode; depth: number }) => {
    const indent = 8 + depth * 14
    if (node.type === 'dir') {
      const isOpen = expanded[node.routePath] ?? false
      const Caret = isOpen ? ChevronDown : ChevronRight
      return (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setExpanded((e) => ({ ...e, [node.routePath]: !isOpen }))}
            style={{ paddingLeft: indent }}
            className="flex items-center gap-1.5 rounded py-[5px] pr-2 text-left text-xs font-semibold text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
          >
            <Caret className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.title}</span>
          </button>
          {isOpen && (
            <div className="flex flex-col">
              {node.hasReadme && (
                <Leaf
                  routePath={node.routePath}
                  title={`${node.title} Overview`}
                  depth={depth + 1}
                />
              )}
              {node.children?.map((c) => (
                <Item key={c.routePath} node={c} depth={depth + 1} />
              ))}
            </div>
          )}
        </div>
      )
    }
    return <Leaf routePath={node.routePath} title={node.title} depth={depth} />
  }

  const Leaf = ({
    routePath,
    title,
    depth,
  }: {
    routePath: string
    title: string
    depth: number
  }) => {
    const active = currentPath === routePath
    // leaves sit at the caret's text position (caret is 14px + 6px gap)
    const indent = 8 + depth * 14 + 20
    return (
      <button
        type="button"
        onClick={() => onNavigate(routePath)}
        style={{ paddingLeft: indent }}
        className={cn(
          'flex items-center rounded py-[5px] pr-2 text-left text-xs transition-colors',
          active
            ? 'bg-sidebar-accent font-medium text-sidebar-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        )}
      >
        <span className="truncate">{title}</span>
      </button>
    )
  }

  return (
    <aside className="w-[300px] shrink-0 self-start overflow-y-auto border-r border-sidebar-border bg-sidebar px-3 py-4 [height:calc(100vh-64px)] sticky top-16">
      <h2 className="px-2 pb-2 text-[13px] font-semibold text-sidebar-foreground">
        Underwriting Manual
      </h2>
      <nav className="flex flex-col gap-0.5">
        {root.children?.map((c) => (
          <Item key={c.routePath} node={c} depth={0} />
        ))}
      </nav>
    </aside>
  )
}

/** ReactMarkdown renderers bound to design tokens (no typography plugin). */
function markdownComponents(onLink: (href: string) => void) {
  return {
    h1: (props: ComponentPropsWithoutRef<'h1'>) => (
      <h1
        className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.4px] text-foreground"
        {...props}
      />
    ),
    h2: (props: ComponentPropsWithoutRef<'h2'>) => (
      <h2 className="mt-8 text-[18px] font-semibold text-foreground" {...props} />
    ),
    h3: (props: ComponentPropsWithoutRef<'h3'>) => (
      <h3 className="mt-6 text-base font-semibold text-foreground" {...props} />
    ),
    p: (props: ComponentPropsWithoutRef<'p'>) => (
      <p className="text-[13.5px] leading-[1.6] text-muted-foreground" {...props} />
    ),
    ul: (props: ComponentPropsWithoutRef<'ul'>) => (
      <ul className="flex list-disc flex-col gap-1 pl-6 text-[13.5px] leading-[1.6] text-muted-foreground marker:text-muted-foreground" {...props} />
    ),
    ol: (props: ComponentPropsWithoutRef<'ol'>) => (
      <ol className="flex list-decimal flex-col gap-1 pl-6 text-[13.5px] leading-[1.6] text-muted-foreground marker:text-muted-foreground" {...props} />
    ),
    li: (props: ComponentPropsWithoutRef<'li'>) => <li className="pl-1" {...props} />,
    a: ({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) => (
      <a
        href={href}
        onClick={(e) => {
          // Route internal manual links in-app; let external links behave normally.
          if (href && !/^https?:\/\//.test(href)) {
            e.preventDefault()
            onLink(href)
          }
        }}
        className="font-medium text-primary underline-offset-4 hover:underline"
        {...rest}
      >
        {children}
      </a>
    ),
    table: (props: ComponentPropsWithoutRef<'table'>) => (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]" {...props} />
      </div>
    ),
    th: (props: ComponentPropsWithoutRef<'th'>) => (
      <th className="border border-border bg-muted px-3 py-2 text-left font-semibold text-foreground" {...props} />
    ),
    td: (props: ComponentPropsWithoutRef<'td'>) => (
      <td className="border border-border px-3 py-2 text-muted-foreground" {...props} />
    ),
    code: (props: ComponentPropsWithoutRef<'code'>) => (
      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[12.5px] text-foreground" {...props} />
    ),
    pre: (props: ComponentPropsWithoutRef<'pre'>) => (
      <pre className="overflow-x-auto rounded-md border border-border bg-muted p-4 font-mono text-[12.5px] text-foreground" {...props} />
    ),
    blockquote: (props: ComponentPropsWithoutRef<'blockquote'>) => (
      <blockquote className="border-l-2 border-border pl-4 text-[13.5px] italic text-muted-foreground" {...props} />
    ),
  }
}

export default function ManualPage() {
  const { manifest, error } = useManifest()
  const navigate = useNavigate()
  const location = useLocation()
  const slug = useMemo(() => {
    const path = location.pathname.replace(/^\/manual\/?/, '')
    return decodeURIComponent(path)
  }, [location.pathname])

  const [markdown, setMarkdown] = useState<string>('Loading…')
  const [mdError, setMdError] = useState<string | null>(null)

  // Resolve a markdown-relative link (e.g. "./1-foundations/README.md") to an in-app route.
  const handleMarkdownLink = (href: string) => {
    const clean = href.replace(/^\.\//, '').replace(/\/README\.md$/i, '').replace(/\.md$/i, '')
    navigate(`/manual/${clean}`)
  }

  useEffect(() => {
    if (!manifest) return
    const node = findNodeByRoute(manifest, slug)
    if (!node) {
      navigate('/manual', { replace: true })
      return
    }
    const computeFilePath = () => {
      if (node.type === 'file') return `/manual/${node.routePath}.md`
      if (node.hasReadme) return `/manual/${node.routePath ? node.routePath + '/' : ''}README.md`
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
        setMarkdown('Loading…')
        const res = await fetch(mdPath)
        if (!res.ok) throw new Error('Failed to load markdown')
        setMarkdown(await res.text())
      } catch (e) {
        setMdError(e instanceof Error ? e.message : 'Unknown error')
      }
    }
    load()
  }, [manifest, slug, navigate])

  const components = useMemo(() => markdownComponents(handleMarkdownLink), [])

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppTopBar activeSection="manual" />

      {error ? (
        <div className="p-10">
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13.5px] text-destructive">
            {error}
          </p>
        </div>
      ) : !manifest ? (
        <p className="p-10 text-[13.5px] text-muted-foreground">Loading manual…</p>
      ) : (
        <div className="flex flex-1 items-stretch">
          <Sidebar root={manifest} currentPath={slug} onNavigate={(rp) => navigate(`/manual/${rp}`)} />
          <main className="min-w-0 flex-1 px-14 py-10">
            {mdError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13.5px] text-destructive">
                {mdError}
              </p>
            ) : (
              <article className="flex max-w-[1028px] flex-col gap-4">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                  {markdown}
                </ReactMarkdown>
              </article>
            )}
          </main>
        </div>
      )}
    </div>
  )
}
