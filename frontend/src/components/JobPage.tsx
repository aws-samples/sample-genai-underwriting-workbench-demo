import {
  useState,
  useEffect,
  createContext,
  useContext,
  useRef,
  useCallback,
  type ComponentPropsWithoutRef,
} from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Bell, FileText, ClipboardPlus, CircleCheck, Send,
  ChevronLeft, ChevronRight, Search, ZoomIn, RotateCw, Printer,
  List, UserRound, MessageCircle, TriangleAlert, ArrowUpRight,
  Bot, Mail, X, Download, Loader2, FileWarning,
} from 'lucide-react'
import { apiClient } from '@/utils/apiClient'
import { exportToPdf } from '@/utils/pdfExport'
import { cn } from '@/lib/utils'
import { AppTopBar } from './AppTopBar'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

// ── Types ────────────────────────────────────────────────────────────────
interface UnderwriterAnalysis {
  RISK_ASSESSMENT: string
  DISCREPANCIES: string
  MEDICAL_TIMELINE?: string
  PROPERTY_ASSESSMENT?: string
  FINAL_RECOMMENDATION: string
}

interface PageData {
  page_type: string
  content: string
  numeric_page_num_for_nav?: number
}

interface AnalysisData {
  job_id: string
  timestamp: string
  filename: string
  page_analysis: Record<string, PageData>
  underwriter_analysis: UnderwriterAnalysis
  status: string
  insurance_type?: 'life' | 'property_casualty'
}

interface JobPageProps {
  jobId: string
}

interface Message {
  id: string
  text: string
  sender: 'user' | 'ai'
  timestamp: Date
}

interface AgentActionData {
  document_identifier: string
  agent_action_confirmation: string
  message: string
}

// ── PDF page-reference linking (unchanged behaviour) ───────────────────────
const PageContext = createContext<[number, (page: number) => void]>([1, () => {}])
const NumPagesContext = createContext<[number | null, (pages: number | null) => void]>([null, () => {}])

const PageReference = ({ pageNum, text }: { pageNum: string; text: string }) => {
  const [, setCurrentPage] = useContext(PageContext)
  const [numPages] = useContext(NumPagesContext)
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    const page = parseInt(pageNum)
    if (!isNaN(page) && page > 0 && page <= (numPages || 0)) setCurrentPage(page)
  }
  return (
    <span
      onClick={handleClick}
      className="cursor-pointer font-medium text-primary underline-offset-2 hover:underline"
    >
      {text}
    </span>
  )
}

// Converts "Page 16" / "Pages 27-29" into clickable page links.
const linkifyPageRefsInText = (text: string): (string | JSX.Element)[] => {
  if (!text) return ['']
  const nodes: (string | JSX.Element)[] = []
  const regex = /\b(Pages?|Pg\.?)[\s]+(\d+)(?:[\s]*[-–][\s]*(\d+))?\b/gi
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    if (before) nodes.push(before)
    const pageStart = parseInt(match[2], 10)
    nodes.push(
      <PageReference key={`page-ref-${match.index}-${pageStart}`} pageNum={String(pageStart)} text={match[0]} />,
    )
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes.length ? nodes : [text]
}

const getFirstPageNumberFromData = (data: any): number | undefined => {
  const search = (node: any): number | undefined => {
    if (node == null) return undefined
    if (typeof node === 'object') {
      if (typeof node.page_number === 'number') return node.page_number
      if (typeof node.start_page_number === 'number') return node.start_page_number
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = search(item)
          if (typeof found === 'number') return found
        }
        return undefined
      }
      for (const key of Object.keys(node)) {
        const found = search(node[key])
        if (typeof found === 'number') return found
      }
    }
    return undefined
  }
  return search(data)
}

// Markdown renderers bound to design tokens; page links resolve via PageReference.
const mdComponents = {
  p: (p: ComponentPropsWithoutRef<'p'>) => <p className="text-[13px] leading-[1.6] text-muted-foreground" {...p} />,
  h1: (p: ComponentPropsWithoutRef<'h1'>) => <h1 className="mt-3 text-lg font-semibold text-foreground" {...p} />,
  h2: (p: ComponentPropsWithoutRef<'h2'>) => <h2 className="mt-4 text-base font-semibold text-foreground" {...p} />,
  h3: (p: ComponentPropsWithoutRef<'h3'>) => <h3 className="mt-3 text-sm font-semibold text-foreground" {...p} />,
  ul: (p: ComponentPropsWithoutRef<'ul'>) => <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-[1.6] text-muted-foreground" {...p} />,
  ol: (p: ComponentPropsWithoutRef<'ol'>) => <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] leading-[1.6] text-muted-foreground" {...p} />,
  strong: (p: ComponentPropsWithoutRef<'strong'>) => <strong className="font-semibold text-foreground" {...p} />,
  table: (p: ComponentPropsWithoutRef<'table'>) => (
    <div className="overflow-x-auto"><table className="w-full border-collapse text-[12.5px]" {...p} /></div>
  ),
  th: (p: ComponentPropsWithoutRef<'th'>) => <th className="border border-border bg-muted px-2.5 py-1.5 text-left font-semibold text-foreground" {...p} />,
  td: (p: ComponentPropsWithoutRef<'td'>) => <td className="border border-border px-2.5 py-1.5 text-muted-foreground" {...p} />,
  code: (p: ComponentPropsWithoutRef<'code'>) => <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground" {...p} />,
  pre: (p: ComponentPropsWithoutRef<'pre'>) => <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[12px] text-foreground" {...p} />,
  a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => (
    <PageReference pageNum={href?.replace('/page/', '') || '1'} text={String(children)} />
  ),
}

const Md = ({ children }: { children: string }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{children}</ReactMarkdown>
)

// ── Processing stepper ─────────────────────────────────────────────────────
const STEPPER_ICONS = [Bell, FileText, ClipboardPlus, CircleCheck, Send]

// jobId status → { step (1-5), phaseKey, detailsKey }
const STATUS_MAPPING: Record<string, { step: number; phaseKey: string; detailsKey: string }> = {
  CREATED: { step: 1, phaseKey: 'jobPage.status.created.phase', detailsKey: 'jobPage.status.created.details' },
  UPLOAD_PENDING: { step: 1, phaseKey: 'jobPage.status.uploadPending.phase', detailsKey: 'jobPage.status.uploadPending.details' },
  CLASSIFYING: { step: 1, phaseKey: 'jobPage.status.classifying.phase', detailsKey: 'jobPage.status.classifying.details' },
  EXTRACTING: { step: 2, phaseKey: 'jobPage.status.extracting.phase', detailsKey: 'jobPage.status.extracting.details' },
  DETECTING: { step: 3, phaseKey: 'jobPage.status.detecting.phase', detailsKey: 'jobPage.status.detecting.details' },
  SCORING: { step: 4, phaseKey: 'jobPage.status.scoring.phase', detailsKey: 'jobPage.status.scoring.details' },
  ANALYZING: { step: 3, phaseKey: 'jobPage.status.analyzing.phase', detailsKey: 'jobPage.status.analyzing.details' },
  ACTING: { step: 4, phaseKey: 'jobPage.status.acting.phase', detailsKey: 'jobPage.status.acting.details' },
  COMPLETE: { step: 5, phaseKey: 'jobPage.status.complete.phase', detailsKey: 'jobPage.status.complete.details' },
  Failed: { step: 5, phaseKey: 'jobPage.status.failed.phase', detailsKey: 'jobPage.status.failed.details' },
  ERROR: { step: 5, phaseKey: 'jobPage.status.error.phase', detailsKey: 'jobPage.status.error.details' },
}

function ProcessingStepper({ step, title, details }: { step: number; title: string; details: string }) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-lg border border-border bg-card p-7">
      <div className="flex items-center">
        {STEPPER_ICONS.map((Icon, i) => {
          const n = i + 1
          const active = step >= n
          return (
            <div key={n} className="flex items-center">
              <div
                className={cn(
                  'flex size-[34px] items-center justify-center rounded-full',
                  active ? 'bg-primary text-primary-foreground' : 'border border-border bg-muted text-muted-foreground',
                )}
              >
                <Icon className="size-4" />
              </div>
              {n < STEPPER_ICONS.length && (
                <div className={cn('h-0.5 w-14 rounded-sm', step > n ? 'bg-primary' : 'bg-border')} />
              )}
            </div>
          )
        })}
      </div>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <div className="w-full rounded-sm bg-muted px-4 py-3">
        <p className="text-center text-[13px] text-muted-foreground">{details}</p>
      </div>
    </div>
  )
}

// ── Section label (muted small-caps) ───────────────────────────────────────
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">{children}</span>
)

// ── Main component ─────────────────────────────────────────────────────────
type TabType = 'grouped' | 'underwriter' | 'detection' | 'scoring' | 'chat'

export function JobPage({ jobId }: JobPageProps) {
  const { t, i18n } = useTranslation()

  const [error, setError] = useState<string | null>(null)
  const [showError, setShowError] = useState(false)
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null)
  const [currentStep, setCurrentStep] = useState(1)
  const [currentPhase, setCurrentPhase] = useState<string>('')
  const [phaseDetails, setPhaseDetails] = useState<string>('')
  const [statusKey, setStatusKey] = useState<string>('')
  const [numPages, setNumPagesState] = useState<number | null>(null)
  const [currentPage, setCurrentPageState] = useState<number>(1)
  const [activeTab, setActiveTab] = useState<TabType>('grouped')
  const [pdfDownloadUrl, setPdfDownloadUrl] = useState<string | null>(null)
  const [isFetchingPdfUrl, setIsFetchingPdfUrl] = useState<boolean>(false)
  const [documentType, setDocumentType] = useState<string | null>(null)
  const [uploadTimestamp, setUploadTimestamp] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [scale, setScale] = useState(1.0)
  const [rotation, setRotation] = useState(0)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [detection, setDetection] = useState<any | null>(null)
  const [scoring, setScoring] = useState<any | null>(null)
  const [isLoadingJobDetails, setIsLoadingJobDetails] = useState(true)
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const [agentActionData, setAgentActionData] = useState<AgentActionData | null>(null)
  const [showAgentToast, setShowAgentToast] = useState(false)
  const [toastDetailsOpen, setToastDetailsOpen] = useState(false)

  const [isPdfGenerating, setIsPdfGenerating] = useState(false)
  const detectionContentRef = useRef<HTMLDivElement>(null)
  const scoringContentRef = useRef<HTMLDivElement>(null)

  const formatDocumentType = (docType: string | null): string => {
    if (!docType) return ''
    return docType.replace(/_/g, ' ').toLowerCase().split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }

  const deriveManualRouteFromKbLocation = (kb: string | null | undefined): string | null => {
    if (!kb || typeof kb !== 'string') return null
    try {
      const withoutExt = kb.replace(/\.md$/i, '')
      const lastManualIdx = withoutExt.lastIndexOf('/manual/')
      if (lastManualIdx === -1) return null
      const suffix = withoutExt.substring(lastManualIdx + '/manual/'.length)
      return suffix ? `/manual/${suffix}` : null
    } catch {
      return null
    }
  }

  const fetchDocumentUrl = useCallback(async () => {
    if (pdfDownloadUrl) return
    setIsFetchingPdfUrl(true)
    try {
      const response = await apiClient.fetch(`${import.meta.env.VITE_API_URL}/jobs/${jobId}/document-url`)
      if (!response.ok) throw new Error('Failed to fetch document URL')
      const data = await response.json()
      if (data.documentUrl) setPdfDownloadUrl(data.documentUrl)
    } catch (err) {
      console.error('Error fetching PDF URL:', err)
    } finally {
      setIsFetchingPdfUrl(false)
    }
  }, [jobId, pdfDownloadUrl])

  const fetchJobDetailsAndUpdateState = useCallback(async (isPolling = false) => {
    if (!isPolling) setIsLoadingJobDetails(true)
    try {
      const response = await apiClient.fetch(`${import.meta.env.VITE_API_URL}/jobs/${jobId}`)
      if (!response.ok) {
        const e: { detail?: string; message?: string; error?: string } = await response.json().catch(() => ({}))
        throw new Error(e.detail || e.message || e.error || `Failed to fetch job details: ${response.status}`)
      }
      const jobApiData: any = await response.json()

      // ── Extraction → grouped page_analysis (unchanged logic) ──
      const pageAnalysisTransformed: Record<string, PageData> = {}
      if (jobApiData.extractedData) {
        for (const key in jobApiData.extractedData) {
          if (Object.prototype.hasOwnProperty.call(jobApiData.extractedData, key)) {
            const value = jobApiData.extractedData[key]
            const inferredPage = getFirstPageNumberFromData(value)
            pageAnalysisTransformed[key] = {
              page_type: key.replace(/_/g, ' '),
              content: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
              numeric_page_num_for_nav: typeof inferredPage === 'number' ? inferredPage : undefined,
            }
          }
        }
      } else if (jobApiData.extractedDataJsonStr) {
        try {
          const parsed = JSON.parse(jobApiData.extractedDataJsonStr)
          if (typeof parsed === 'object' && parsed !== null) {
            for (const key in parsed) {
              if (Object.prototype.hasOwnProperty.call(parsed, key)) {
                const value = parsed[key]
                const inferredPage = getFirstPageNumberFromData(value)
                pageAnalysisTransformed[key] = {
                  page_type: key.replace(/_/g, ' '),
                  content: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
                  numeric_page_num_for_nav: typeof inferredPage === 'number' ? inferredPage : undefined,
                }
              }
            }
          }
        } catch (parseError) {
          console.error('Error parsing extractedDataJsonStr:', parseError)
          pageAnalysisTransformed['raw_extracted_data'] = {
            page_type: 'Raw Extracted Data (Parse Error)',
            content: `\`\`\`text\n${jobApiData.extractedDataJsonStr}\n\`\`\``,
          }
        }
      }

      // ── Underwriter analysis (unchanged logic) ──
      let uw: UnderwriterAnalysis = {
        RISK_ASSESSMENT: 'Not available.',
        DISCREPANCIES: 'Not available.',
        FINAL_RECOMMENDATION: 'Not available.',
      }
      const buildFromAnalysis = (a: any): UnderwriterAnalysis => {
        const riskAssessment = Array.isArray(a.identified_risks) && a.identified_risks.length
          ? a.identified_risks.map((risk: any) => {
              const refs = risk.page_references?.length ? ` ([${risk.page_references.join(', ')}](/page/${risk.page_references[0]}))` : ''
              return `- **${risk.severity || 'N/A'}**: ${risk.risk_description}${refs}`
            }).join('\n')
          : 'No risks identified.'
        const discrepancies = Array.isArray(a.discrepancies) && a.discrepancies.length
          ? a.discrepancies.map((disc: any) => {
              const refs = disc.page_references?.length ? ` ([${disc.page_references.join(', ')}](/page/${disc.page_references[0]}))` : ''
              return `- **${disc.discrepancy_description}**: ${disc.details}${refs}`
            }).join('\n')
          : 'No discrepancies found.'
        return {
          RISK_ASSESSMENT: riskAssessment,
          DISCREPANCIES: discrepancies,
          MEDICAL_TIMELINE: jobApiData.insurance_type === 'life' ? (a.medical_timeline || 'Not available.') : undefined,
          PROPERTY_ASSESSMENT: jobApiData.insurance_type === 'property_casualty' ? (a.property_assessment || 'Not available.') : undefined,
          FINAL_RECOMMENDATION: a.final_recommendation || 'Not available.',
        }
      }
      if (jobApiData.analysisOutput) {
        try { uw = buildFromAnalysis(jobApiData.analysisOutput) } catch (e) { console.error(e) }
      } else if (jobApiData.analysisOutputJsonStr) {
        try { uw = buildFromAnalysis(JSON.parse(jobApiData.analysisOutputJsonStr)) } catch (e) { console.error('Error parsing analysisOutputJsonStr:', e) }
      }

      setAnalysisData({
        job_id: jobApiData.jobId,
        timestamp: jobApiData.timestamp,
        filename: jobApiData.originalFilename,
        page_analysis: pageAnalysisTransformed,
        underwriter_analysis: uw,
        status: jobApiData.status,
        insurance_type: jobApiData.insurance_type,
      })

      if (jobApiData.analysisDetection) setDetection(jobApiData.analysisDetection)
      if (jobApiData.analysisScoring) setScoring(jobApiData.analysisScoring)
      if (jobApiData.documentType) setDocumentType(jobApiData.documentType)
      if (jobApiData.uploadTimestamp) setUploadTimestamp(jobApiData.uploadTimestamp)

      // ── Agent action → toast ──
      const nextAgent = jobApiData.agentActionOutput
        || (jobApiData.agentActionOutputJsonStr ? (() => { try { return JSON.parse(jobApiData.agentActionOutputJsonStr) } catch { return null } })() : null)
      if (nextAgent && (!agentActionData || JSON.stringify(agentActionData) !== JSON.stringify(nextAgent))) {
        setAgentActionData(nextAgent)
        setShowAgentToast(true)
      }

      // ── Status → stepper + polling ──
      const key = jobApiData.status as string
      const info = STATUS_MAPPING[key]
      setStatusKey(key)
      if (info) {
        setCurrentStep(info.step)
        setCurrentPhase(t(info.phaseKey))
        setPhaseDetails(t(info.detailsKey))
        if (key === 'COMPLETE') {
          if (pollingIntervalRef.current) { clearInterval(pollingIntervalRef.current); pollingIntervalRef.current = null }
        } else if (key === 'Failed' || key === 'ERROR') {
          setError(jobApiData.error_message || 'Job processing failed.')
          setShowError(true)
          if (pollingIntervalRef.current) { clearInterval(pollingIntervalRef.current); pollingIntervalRef.current = null }
        } else if (!pollingIntervalRef.current) {
          pollingIntervalRef.current = setInterval(() => fetchJobDetailsAndUpdateState(true), 5000)
        }
      } else {
        setCurrentStep(1)
        setCurrentPhase(t('jobPage.status.processing'))
        setPhaseDetails(t('jobPage.status.unknownStatus', { status: jobApiData.status }))
        if (!pollingIntervalRef.current) pollingIntervalRef.current = setInterval(() => fetchJobDetailsAndUpdateState(true), 5000)
      }
      setError(null)
      setShowError(false)
    } catch (err) {
      console.error('Error fetching job details:', err)
      const msg = err instanceof Error ? err.message : 'An unknown error occurred.'
      setError(msg)
      setShowError(true)
      if (pollingIntervalRef.current) { clearInterval(pollingIntervalRef.current); pollingIntervalRef.current = null }
    } finally {
      if (!isPolling) setIsLoadingJobDetails(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  useEffect(() => {
    fetchJobDetailsAndUpdateState()
    return () => { if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current) }
  }, [jobId, fetchJobDetailsAndUpdateState])

  useEffect(() => {
    if (analysisData && !pdfDownloadUrl) fetchDocumentUrl()
  }, [analysisData, pdfDownloadUrl, fetchDocumentUrl])

  useEffect(() => {
    if (analysisData?.insurance_type) {
      const type = analysisData.insurance_type
      const greeting = type === 'property_casualty'
        ? t('jobPage.chat.greetingPropertyCasualty')
        : t('jobPage.chat.greetingLife')
      setMessages([{ id: '1', text: greeting, sender: 'ai', timestamp: new Date() }])
    } else if (!isLoadingJobDetails && !analysisData?.insurance_type) {
      setMessages([{ id: '1', text: t('jobPage.chat.greetingGeneric'), sender: 'ai', timestamp: new Date() }])
    }
  }, [analysisData?.insurance_type, isLoadingJobDetails, t])

  const isProcessing = statusKey !== 'COMPLETE' && statusKey !== 'Failed' && statusKey !== 'ERROR' && !!statusKey

  const formatUploaded = (ts: string | null): string => {
    if (!ts) return ''
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ''
    return new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
  }

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMessage.trim()) return
    await sendMessage(newMessage.trim())
  }

  const sendMessage = async (text: string) => {
    const userMessage: Message = { id: Date.now().toString(), text, sender: 'user', timestamp: new Date() }
    const updated = [...messages, userMessage]
    setMessages(updated); setNewMessage(''); setIsTyping(true)
    try {
      const messagesToSend = updated.filter((m) => m.id !== '1')
      const response = await apiClient.fetch(`${import.meta.env.VITE_API_URL}/chat/${jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messagesToSend }),
      })
      if (!response.ok) throw new Error('AI chat error')
      const data = await response.json()
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), text: data.response, sender: 'ai', timestamp: new Date() }])
    } catch {
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), text: t('jobPage.chat.error'), sender: 'ai', timestamp: new Date() }])
    } finally {
      setIsTyping(false)
    }
  }

  const handleExportPdf = async (contentRef: React.RefObject<HTMLDivElement>, title: string) => {
    if (!contentRef.current) return
    setIsPdfGenerating(true)
    try {
      await exportToPdf(contentRef.current, {
        title, jobId, documentName: analysisData?.filename,
        filename: `${title.toLowerCase().replace(/\s+/g, '-')}-${jobId.slice(0, 8)}.pdf`,
      })
    } catch (err) {
      console.error('Error generating PDF:', err)
    } finally {
      setIsPdfGenerating(false)
    }
  }

  // ── Loading / error gates ──
  if (isLoadingJobDetails && !analysisData) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppTopBar activeSection="upload" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
          <p className="text-[13.5px] text-muted-foreground">{t('jobPage.loadingJobDetails')}</p>
        </div>
      </div>
    )
  }

  if (error && showError && !analysisData) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AppTopBar activeSection="upload" />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-12">
          <FileWarning className="size-8 text-destructive" />
          <h1 className="text-lg font-semibold text-foreground">{t('jobPage.errorOccurred')}</h1>
          <p className="max-w-md text-center text-[13.5px] text-muted-foreground">{error}</p>
          <button
            onClick={() => { setError(null); setShowError(false); fetchJobDetailsAndUpdateState() }}
            className="rounded-sm bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('jobPage.retry')}
          </button>
        </div>
      </div>
    )
  }

  const insuranceType = analysisData?.insurance_type
  const docSubline = uploadTimestamp
    ? t('jobPage.subline', { filename: analysisData?.filename || '', pages: numPages ?? '—', uploaded: formatUploaded(uploadTimestamp) })
    : (analysisData?.filename || '')

  return (
    <PageContext.Provider value={[currentPage, setCurrentPageState]}>
      <NumPagesContext.Provider value={[numPages, setNumPagesState]}>
        <div className="flex h-screen flex-col overflow-hidden bg-background">
          <AppTopBar activeSection="upload" />

          {/* Document header */}
          <div className="flex items-center gap-4 border-b border-border bg-card px-10 py-5">
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[22px] font-medium text-muted-foreground">{t('jobPage.jobLabel')}</span>
                <span className="font-mono text-[22px] font-semibold text-foreground">{jobId.slice(0, 8)}</span>
              </div>
              <p className="text-[13px] text-muted-foreground">{docSubline}</p>
            </div>
            {documentType && (
              <span className="rounded-full border border-border bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
                {formatDocumentType(documentType)}
              </span>
            )}
            {insuranceType && (
              <span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-foreground">
                {insuranceType === 'property_casualty' ? t('jobPage.badges.propertyCasualty') : t('jobPage.badges.life')}
              </span>
            )}
          </div>

          {/* Processing stepper */}
          {isProcessing && (
            <div className="flex justify-center px-10 pt-7">
              <div className="w-[620px]">
                <ProcessingStepper step={currentStep} title={currentPhase} details={phaseDetails} />
              </div>
            </div>
          )}

          {/* Agent toast */}
          {showAgentToast && agentActionData && (
            <AgentToast
              data={agentActionData}
              detailsOpen={toastDetailsOpen}
              onToggleDetails={() => setToastDetailsOpen((o) => !o)}
              onClose={() => setShowAgentToast(false)}
            />
          )}

          {/* Workbench body */}
          {analysisData && (
            <div className="flex min-h-0 flex-1 items-stretch gap-5 p-5">
              {/* PDF pane — fixed; only its canvas scrolls when a page is zoomed */}
              <div className="flex w-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2.5">
                  <ToolbarButton onClick={() => setCurrentPageState((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
                    <ChevronLeft className="size-3.5" /> {t('jobPage.previous')}
                  </ToolbarButton>
                  <span className="px-1 text-[12.5px] text-foreground">
                    {t('jobPage.page')} {currentPage} {t('jobPage.of')} {numPages || '—'}
                  </span>
                  <ToolbarButton onClick={() => setCurrentPageState((p) => Math.min(numPages || p, p + 1))} disabled={currentPage >= (numPages || 1)}>
                    {t('jobPage.next')} <ChevronRight className="size-3.5" />
                  </ToolbarButton>
                  <ToolbarIcon title={t('jobPage.find')} disabled><Search className="size-3.5" /></ToolbarIcon>
                  <div className="flex-1" />
                  <span className="text-[12.5px] text-muted-foreground">{Math.round(scale * 100)}%</span>
                  <ToolbarIcon title={t('jobPage.zoomIn')} onClick={() => setScale((s) => (s >= 2 ? 0.6 : Math.min(2, s + 0.2)))}>
                    <ZoomIn className="size-3.5" />
                  </ToolbarIcon>
                  <ToolbarIcon title={t('jobPage.rotate')} onClick={() => setRotation((r) => (r + 90) % 360)}>
                    <RotateCw className="size-3.5" />
                  </ToolbarIcon>
                  <ToolbarIcon title={t('jobPage.print')} onClick={() => pdfDownloadUrl && window.open(pdfDownloadUrl)?.print()}>
                    <Printer className="size-3.5" />
                  </ToolbarIcon>
                </div>
                <div className="flex flex-1 items-start justify-center overflow-auto bg-muted p-5">
                  {isFetchingPdfUrl && (
                    <div className="flex flex-col items-center gap-3 pt-16 text-muted-foreground">
                      <Loader2 className="size-8 animate-spin" />
                      <p className="text-[13px]">{t('jobPage.loadingDocument')}</p>
                    </div>
                  )}
                  {!pdfDownloadUrl && !isFetchingPdfUrl && (
                    <div className="flex flex-col items-center gap-3 pt-16 text-muted-foreground">
                      <FileText className="size-8" />
                      <p className="max-w-xs text-center text-[13px]">{t('jobPage.pdfPlaceholder')}</p>
                    </div>
                  )}
                  {pdfDownloadUrl && (
                    <Document
                      file={pdfDownloadUrl}
                      onLoadSuccess={({ numPages: n }) => setNumPagesState(n)}
                      loading={<div className="pt-16 text-[13px] text-muted-foreground">{t('jobPage.loadingPdf')}</div>}
                      error={<div className="pt-16 text-[13px] text-destructive">{t('jobPage.errorLoadingPdf')}</div>}
                    >
                      <div className="overflow-hidden rounded-sm border border-border shadow-sm">
                        <Page pageNumber={currentPage} renderTextLayer={false} renderAnnotationLayer={false} scale={scale} rotate={rotation} />
                      </div>
                    </Document>
                  )}
                </div>
              </div>

              {/* Analysis panel — the tab bar stays fixed; only this content region scrolls */}
              <div className="flex min-h-0 w-1/2 flex-col overflow-hidden">
                <TabBar activeTab={activeTab} onChange={setActiveTab} />
                <div className="min-h-0 flex-1 overflow-y-auto pt-4">
                  {activeTab === 'grouped' && <GroupedTab analysisData={analysisData} currentPage={currentPage} setCurrentPage={setCurrentPageState} expandedGroups={expandedGroups} setExpandedGroups={setExpandedGroups} isLoading={isLoadingJobDetails} isProcessing={isProcessing} />}
                  {activeTab === 'underwriter' && <UnderwriterTab analysisData={analysisData} isLoading={isLoadingJobDetails} isProcessing={isProcessing} />}
                  {activeTab === 'detection' && <DetectionTab detection={detection} contentRef={detectionContentRef} onExport={() => handleExportPdf(detectionContentRef, 'Impairment Detection Report')} isPdfGenerating={isPdfGenerating} deriveManualRoute={deriveManualRouteFromKbLocation} formatName={formatDocumentType} />}
                  {activeTab === 'scoring' && <ScoringTab scoring={scoring} contentRef={scoringContentRef} onExport={() => handleExportPdf(scoringContentRef, 'Risk Scoring Report')} isPdfGenerating={isPdfGenerating} formatName={formatDocumentType} />}
                  {activeTab === 'chat' && <ChatTab messages={messages} isTyping={isTyping} newMessage={newMessage} setNewMessage={setNewMessage} onSubmit={handleSendMessage} onSuggestion={sendMessage} insuranceType={insuranceType} />}
                </div>
              </div>
            </div>
          )}
        </div>
      </NumPagesContext.Provider>
    </PageContext.Provider>
  )
}

// ── Toolbar bits ───────────────────────────────────────────────────────────
function ToolbarButton({ children, ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      {...props}
      className="flex items-center gap-1.5 rounded-sm border border-border bg-background px-2.5 py-[5px] text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
    >
      {children}
    </button>
  )
}
function ToolbarIcon({ children, ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      {...props}
      className="flex items-center justify-center rounded-sm border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  )
}

// ── Tab bar (underlined) ─────────────────────────────────────────────────────
function TabBar({ activeTab, onChange }: { activeTab: TabType; onChange: (t: TabType) => void }) {
  const { t } = useTranslation()
  const tabs: { key: TabType; label: string; Icon: typeof List }[] = [
    { key: 'grouped', label: t('jobPage.tabs.documentAnalysis'), Icon: List },
    { key: 'underwriter', label: t('jobPage.tabs.underwriter'), Icon: UserRound },
    { key: 'detection', label: t('jobPage.tabs.impairments'), Icon: ClipboardPlus },
    { key: 'scoring', label: t('jobPage.tabs.scoring'), Icon: CircleCheck },
    { key: 'chat', label: t('jobPage.tabs.chat'), Icon: MessageCircle },
  ]
  return (
    <div className="flex gap-7 border-b border-border">
      {tabs.map(({ key, label, Icon }) => {
        const active = activeTab === key
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 pb-[11px] text-[13.5px] transition-colors',
              active
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-[15px]" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

// ── Data Extraction tab ──────────────────────────────────────────────────────
function GroupedTab({
  analysisData, currentPage, setCurrentPage, expandedGroups, setExpandedGroups, isLoading, isProcessing,
}: {
  analysisData: AnalysisData; currentPage: number; setCurrentPage: (p: number) => void
  expandedGroups: Set<string>; setExpandedGroups: (s: Set<string>) => void; isLoading: boolean; isProcessing: boolean
}) {
  const { t } = useTranslation()
  const pa = analysisData.page_analysis
  if (!pa || Object.keys(pa).length === 0) {
    return <p className="text-[13px] text-muted-foreground">{isLoading || isProcessing ? t('jobPage.documentAnalysis.loading') : t('jobPage.documentAnalysis.noData')}</p>
  }

  const pages = Object.entries(pa).map(([key, val]) => ({
    key,
    pageType: val.page_type,
    content: val.content,
    numericPageNum: val.numeric_page_num_for_nav || parseInt(key.replace(/[^0-9]/g, '')) || 1,
  }))
  const groups: Record<string, typeof pages> = {}
  pages.forEach((p) => {
    const docType = p.pageType.split('-')[0].trim() || t('jobPage.documentAnalysis.uncategorized')
    ;(groups[docType] ||= []).push(p)
  })

  const toggle = (title: string, firstPage?: number) => {
    const next = new Set(expandedGroups)
    if (next.has(title)) next.delete(title)
    else { next.add(title); if (firstPage) setCurrentPage(firstPage) }
    setExpandedGroups(next)
  }

  return (
    <div className="flex flex-col">
      {Object.entries(groups).map(([title, groupPages]) => {
        const sorted = [...groupPages].sort((a, b) => a.numericPageNum - b.numericPageNum)
        const open = expandedGroups.has(title)
        return (
          <div key={title} className="flex flex-col">
            <button
              onClick={() => toggle(title, sorted[0]?.numericPageNum)}
              className="flex items-center gap-2.5 border-b border-border px-0.5 py-[13px] text-left transition-colors hover:bg-accent/40"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-[13.5px] text-foreground">{title}</span>
              <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
            </button>
            {open && (
              <div className="flex flex-col gap-2 py-2">
                {groupPages.map((p) => (
                  <div
                    key={p.key}
                    onClick={() => setCurrentPage(p.numericPageNum)}
                    className={cn(
                      'cursor-pointer rounded-md border p-3 transition-colors',
                      currentPage === p.numericPageNum ? 'border-primary/40 bg-secondary/40' : 'border-border hover:bg-accent/40',
                    )}
                  >
                    <Md>{p.content}</Md>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Underwriter tab ──────────────────────────────────────────────────────────
const SEVERITY_STYLE: Record<string, string> = {
  HIGH: 'text-destructive',
  MEDIUM: 'text-muted-foreground',
  LOW: 'text-muted-foreground',
}

// Parses "- **SEVERITY**: body (refs)" markdown lines into structured rows.
function parseRiskLines(md: string): { severity: string; title: string; body: string }[] {
  return md.split('\n').filter((l) => l.trim().startsWith('-')).map((line) => {
    const m = line.match(/^-\s*\*\*(.+?)\*\*:?\s*(.*)$/)
    if (!m) return { severity: '', title: '', body: line.replace(/^-\s*/, '') }
    return { severity: m[1].trim().toUpperCase(), title: '', body: m[2].trim() }
  })
}

function UnderwriterTab({ analysisData, isLoading, isProcessing }: { analysisData: AnalysisData; isLoading: boolean; isProcessing: boolean }) {
  const { t } = useTranslation()
  const uw = analysisData.underwriter_analysis
  if (!uw) return <p className="text-[13px] text-muted-foreground">{isLoading || isProcessing ? t('jobPage.analysis.loading') : t('jobPage.analysis.noData')}</p>

  const isPC = analysisData.insurance_type === 'property_casualty'
  const risk = uw.RISK_ASSESSMENT && uw.RISK_ASSESSMENT !== 'Not available.' ? uw.RISK_ASSESSMENT : ''
  const disc = uw.DISCREPANCIES && uw.DISCREPANCIES !== 'Not available.' ? uw.DISCREPANCIES : ''
  const timeline = isPC ? uw.PROPERTY_ASSESSMENT : uw.MEDICAL_TIMELINE
  const rec = uw.FINAL_RECOMMENDATION && uw.FINAL_RECOMMENDATION !== 'Not available.' ? uw.FINAL_RECOMMENDATION : ''
  const riskRows = risk ? parseRiskLines(risk) : []

  return (
    <div className="flex flex-col gap-8 pb-8">
      {risk && (
        <div className="flex flex-col gap-3">
          <SectionLabel>{t('jobPage.sections.riskAssessment')}</SectionLabel>
          {riskRows.length ? (
            <div className="flex flex-col gap-4">
              {riskRows.map((r, i) => (
                <div key={i} className="flex gap-3">
                  <span className={cn('w-14 shrink-0 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.4px]', SEVERITY_STYLE[r.severity] || 'text-muted-foreground')}>
                    {r.severity}
                  </span>
                  <div className="flex-1"><Md>{r.body}</Md></div>
                </div>
              ))}
            </div>
          ) : <Md>{risk}</Md>}
        </div>
      )}

      {disc && (
        <div className="flex flex-col gap-3 border-t border-border pt-6">
          <SectionLabel>{t('jobPage.sections.discrepancies')}</SectionLabel>
          <Md>{disc}</Md>
        </div>
      )}

      {timeline && timeline !== 'Not available.' && (
        <div className="flex flex-col gap-3 border-t border-border pt-6">
          <SectionLabel>{isPC ? t('jobPage.sections.propertyAssessment') : t('jobPage.sections.medicalTimeline')}</SectionLabel>
          <Md>{timeline}</Md>
        </div>
      )}

      {rec && (
        <div className="flex flex-col gap-2 border-t border-border pt-6">
          <SectionLabel>{t('jobPage.sections.finalRecommendation')}</SectionLabel>
          <div className="mt-1"><Md>{rec}</Md></div>
        </div>
      )}
    </div>
  )
}

// ── Impairments (detection) tab ──────────────────────────────────────────────
function DownloadButton({ onClick, isGenerating }: { onClick: () => void; isGenerating: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-end pb-3">
      <button onClick={onClick} disabled={isGenerating} className="flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline disabled:opacity-50">
        {isGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {isGenerating ? t('jobPage.download.generating') : t('jobPage.download.pdf')}
      </button>
    </div>
  )
}

function DetectionTab({
  detection, contentRef, onExport, isPdfGenerating, deriveManualRoute, formatName,
}: {
  detection: any; contentRef: React.RefObject<HTMLDivElement>; onExport: () => void
  isPdfGenerating: boolean; deriveManualRoute: (kb: string) => string | null; formatName: (s: string | null) => string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (!detection) return <p className="text-[13px] text-muted-foreground">{t('jobPage.detection.noResults')}</p>
  const items = detection.impairments || []
  if (!items.length && !detection.narrative) return <p className="text-[13px] text-muted-foreground">{t('jobPage.detection.noImpairments')}</p>

  const formatValue = (v: any) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v == null ? '—' : String(v))

  return (
    <div>
      <DownloadButton onClick={onExport} isGenerating={isPdfGenerating} />
      <div ref={contentRef} className="flex flex-col gap-8 pb-8">
        {!!detection.narrative && (
          <div className="flex flex-col gap-2">
            <SectionLabel>{t('jobPage.detection.summaryNarrative')}</SectionLabel>
            <p className="text-[13px] leading-[1.6] text-muted-foreground">{linkifyPageRefsInText(String(detection.narrative))}</p>
          </div>
        )}
        {items.map((imp: any, idx: number) => {
          const manualUrl = deriveManualRoute(imp.knowledgebase_location)
          return (
            <div key={idx} className="flex flex-col gap-4 border-t border-border pt-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[15.5px] font-semibold text-foreground">{formatName(imp.impairment_id || imp.name || 'Impairment')}</h3>
                {manualUrl && (
                  <button onClick={() => navigate(manualUrl)} className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                    <ArrowUpRight className="size-3.5" /> {t('jobPage.detection.guidelines')}
                  </button>
                )}
              </div>

              {!!imp.evidence?.length && (
                <div className="flex flex-col gap-2">
                  <SectionLabel>{t('jobPage.detection.evidence')}</SectionLabel>
                  <ul className="flex flex-col gap-1.5">
                    {imp.evidence.map((e: any, i: number) => (
                      <li key={i} className="flex gap-2 text-[12.5px] leading-[1.55] text-muted-foreground">
                        <span className="text-muted-foreground/60">·</span>
                        <span className="flex-1">{linkifyPageRefsInText(String(e))}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!!imp.scoring_factors && Object.keys(imp.scoring_factors).length > 0 && (
                <div className="flex flex-col gap-2">
                  <SectionLabel>{t('jobPage.detection.scoringFactors')}</SectionLabel>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(imp.scoring_factors).map(([k, v]: [string, any]) => (
                      <div key={k} className="flex items-center gap-1.5 rounded-sm border border-border px-2 py-1">
                        <span className="text-[10.5px] font-medium text-muted-foreground">{k}</span>
                        <span className="text-[11.5px] font-medium text-foreground">{formatValue(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!!imp.discrepancies?.length && (
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.4px] text-destructive">
                    <TriangleAlert className="size-3.5" /> {t('jobPage.detection.discrepancies')}
                  </span>
                  <ul className="flex flex-col gap-1.5 border-l-2 border-destructive/40 pl-3">
                    {imp.discrepancies.map((d: any, i: number) => (
                      <li key={i} className="flex gap-2 text-[12.5px] leading-[1.55] text-muted-foreground">
                        <span className="text-muted-foreground/60">·</span>
                        <span className="flex-1">{linkifyPageRefsInText(String(d))}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Scoring tab ──────────────────────────────────────────────────────────────
function ScoringTab({
  scoring, contentRef, onExport, isPdfGenerating, formatName,
}: {
  scoring: any; contentRef: React.RefObject<HTMLDivElement>; onExport: () => void; isPdfGenerating: boolean; formatName: (s: string | null) => string
}) {
  const { t } = useTranslation()
  if (!scoring) return <p className="text-[13px] text-muted-foreground">{t('jobPage.scoring.noResults')}</p>

  const s = scoring?.scoring && typeof scoring.scoring === 'object' ? scoring.scoring : scoring
  const total = s?.total_score ?? s?.totalScore ?? null
  const items = Array.isArray(s?.impairment_scores) ? s.impairment_scores : []
  if (!items.length && total == null) return <p className="text-[13px] text-muted-foreground">{t('jobPage.scoring.noImpairments')}</p>

  return (
    <div>
      <DownloadButton onClick={onExport} isGenerating={isPdfGenerating} />
      <div ref={contentRef} className="flex flex-col">
        <div className="flex items-start justify-between gap-4 pb-6">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-muted-foreground">{t('jobPage.scoring.overallLabel')}</span>
            <span className="text-[13px] text-muted-foreground">{t('jobPage.scoring.overallSubline', { count: items.length })}</span>
          </div>
          <span className="font-mono text-[40px] font-semibold leading-none tracking-[-1.5px] text-primary">
            {total == null ? '—' : String(total)}
          </span>
        </div>

        {items.map((imp: any, idx: number) => (
          <div key={idx} className="flex flex-col gap-1.5 border-t border-border py-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[15.5px] font-semibold text-foreground">{formatName(imp.impairment_id || imp.name || 'Impairment')}</h3>
              <span className="font-mono text-[15px] font-semibold text-foreground">{String(imp.sub_total ?? imp.score ?? 0)}</span>
            </div>
            {!!imp.reason && <p className="text-[13px] leading-[1.6] text-muted-foreground">{imp.reason}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Chat tab ─────────────────────────────────────────────────────────────────
function ChatTab({
  messages, isTyping, newMessage, setNewMessage, onSubmit, onSuggestion, insuranceType,
}: {
  messages: Message[]; isTyping: boolean; newMessage: string; setNewMessage: (v: string) => void
  onSubmit: (e: React.FormEvent) => void; onSuggestion: (text: string) => void; insuranceType?: 'life' | 'property_casualty'
}) {
  const { t } = useTranslation()
  const suggestionsKey = insuranceType === 'property_casualty' ? 'jobPage.chat.suggestionsPropertyCasualty' : 'jobPage.chat.suggestions'
  const suggestions = t(suggestionsKey, { returnObjects: true }) as Record<string, string>
  const suggestionList = suggestions && typeof suggestions === 'object' ? Object.values(suggestions) : []

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto pb-4">
        {messages.map((m) => (
          <div key={m.id} className={cn('flex gap-2.5', m.sender === 'user' && 'flex-row-reverse')}>
            <div className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
              m.sender === 'ai' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground',
            )}>
              {m.sender === 'ai' ? t('jobPage.chat.aiAvatar') : t('jobPage.chat.userAvatar')}
            </div>
            <div className={cn(
              'max-w-[80%] rounded-lg px-3.5 py-2.5 text-[13px] leading-[1.55]',
              m.sender === 'ai' ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground',
            )}>
              <Md>{m.text}</Md>
            </div>
          </div>
        ))}
        {isTyping && (
          <div className="flex gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {t('jobPage.chat.aiAvatar')}
            </div>
            <div className="rounded-lg bg-muted px-3.5 py-2.5 text-[13px] text-muted-foreground">{t('jobPage.chat.typing')}</div>
          </div>
        )}
      </div>

      {/* Composer zone — pinned; suggestions grouped with the input */}
      <div className="flex flex-col gap-2.5 border-t border-border pt-3">
        {suggestionList.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestionList.map((s) => (
              <button
                key={s}
                onClick={() => onSuggestion(s)}
                className="rounded-sm bg-secondary px-3 py-1.5 text-[12.5px] font-medium text-secondary-foreground transition-colors hover:bg-secondary/70"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <textarea
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder={t('jobPage.chat.placeholder')}
            rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e) } }}
            className="max-h-32 flex-1 resize-none rounded-sm border border-input bg-background px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!newMessage.trim() || isTyping}
            className="flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Send className="size-3.5" /> {t('jobPage.chat.send')}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Agent toast ──────────────────────────────────────────────────────────────
function AgentToast({
  data, detailsOpen, onToggleDetails, onClose,
}: {
  data: AgentActionData; detailsOpen: boolean; onToggleDetails: () => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const confirmation = data.agent_action_confirmation || ''
  const summary = confirmation.includes('email')
    ? t('jobPage.agentToast.emailSent')
    : confirmation.includes('ineligible')
      ? t('jobPage.agentToast.reviewed')
      : t('jobPage.agentToast.actionTaken')

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[380px] rounded-lg border border-border bg-card p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-secondary text-secondary-foreground">
          <Bot className="size-4" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold text-foreground">{t('jobPage.agentToast.title')}</span>
          <span className="text-[12.5px] text-muted-foreground">{t('jobPage.agentToast.subtitle')}</span>
        </div>
        <button onClick={onClose} aria-label={t('jobPage.agentToast.close')} className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-3 flex items-start gap-2.5 rounded-sm bg-muted px-3 py-2.5">
        <Mail className="mt-0.5 size-4 shrink-0 text-foreground" />
        <p className="text-[12.5px] leading-[1.5] text-muted-foreground">{summary}</p>
      </div>

      <button onClick={onToggleDetails} className="mt-3 flex items-center gap-1 text-[13px] font-medium text-foreground">
        <ChevronRight className={cn('size-4 transition-transform', detailsOpen && 'rotate-90')} />
        {t('jobPage.agentToast.viewDetails')}
      </button>
      {detailsOpen && (
        <div className="mt-2 max-h-52 overflow-y-auto rounded-sm bg-muted px-3 py-2.5 text-[12px] leading-[1.5] text-muted-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{confirmation}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}
