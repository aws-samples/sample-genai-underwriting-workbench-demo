import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search, FileText, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiClient } from '@/utils/apiClient'
import { AppTopBar } from './AppTopBar'
import { Skeleton } from '@/components/ui/skeleton'

interface Job {
  jobId: string
  originalFilename: string
  uploadTimestamp: string
  status: string
  documentType?: string
  insuranceType?: string
  batchId?: string
}

type StatusKind = 'complete' | 'inProgress' | 'failed'

/** Map the raw pipeline status onto the three display states. */
function statusKind(status: string): StatusKind {
  const s = (status || '').toUpperCase()
  if (s === 'COMPLETE') return 'complete'
  if (s === 'FAILED') return 'failed'
  return 'inProgress'
}

const STATUS_DOT: Record<StatusKind, string> = {
  complete: 'bg-success',
  inProgress: 'bg-muted-foreground',
  failed: 'bg-destructive',
}

/**
 * Underwriting jobs list. Rebuilt from designs/underwriting workbench.pen
 * (frame "04 Underwriting Jobs"): a single hairline list — no cards — grouped
 * by month, with the Job ID leading in JetBrains Mono, filename as secondary
 * metadata, and a minimal status dot. Live data, 5s polling, and search are
 * carried over from the legacy JobsList.
 */
export function JobsPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()

  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetchJobs()
    const pollInterval = setInterval(fetchJobs, 5000)
    return () => clearInterval(pollInterval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchJobs = async () => {
    try {
      const response = await apiClient.fetch(
        `${import.meta.env.VITE_API_URL}/jobs`,
      )
      if (!response.ok) {
        if (response.status === 401) {
          setError(t('errors.unauthorized'))
          setLoading(false)
          return
        }
        throw new Error(t('jobs.fetchError'))
      }
      const data = await response.json()
      setJobs(data.jobs || data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }

  const filteredJobs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return jobs
    return jobs.filter(
      (job) =>
        job.jobId.toLowerCase().includes(q) ||
        (job.originalFilename || '').toLowerCase().includes(q),
    )
  }, [jobs, search])

  // Group by "Month Year", preserving the newest-first order the API returns.
  const groups = useMemo(() => {
    const monthFmt = new Intl.DateTimeFormat(i18n.language, {
      month: 'long',
      year: 'numeric',
    })
    const ordered: { label: string; jobs: Job[] }[] = []
    const byLabel = new Map<string, Job[]>()
    for (const job of filteredJobs) {
      const date = new Date(job.uploadTimestamp)
      const label = isNaN(date.getTime()) ? '—' : monthFmt.format(date)
      if (!byLabel.has(label)) {
        const bucket: Job[] = []
        byLabel.set(label, bucket)
        ordered.push({ label, jobs: bucket })
      }
      byLabel.get(label)!.push(job)
    }
    return ordered
  }, [filteredJobs, i18n.language])

  const allComplete =
    jobs.length > 0 && jobs.every((j) => statusKind(j.status) === 'complete')

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <AppTopBar activeSection="jobs" />

      <main className="flex flex-col items-center px-6 pb-[88px] pt-14 sm:px-10">
        <div className="flex w-full max-w-[920px] flex-col gap-7">
          {/* Header: heading + subtitle on the left, search on the right */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <h1 className="text-[26px] font-semibold tracking-[-0.6px] text-foreground">
                {t('jobs.heading')}
              </h1>
              <p className="text-[13.5px] text-muted-foreground">
                {allComplete
                  ? t('jobs.subtitleAllComplete', { count: jobs.length })
                  : t('jobs.subtitle', { count: jobs.length })}
              </p>
            </div>

            <div className="flex w-full items-center gap-2 rounded-sm border border-input bg-background px-3 py-[9px] sm:w-[296px]">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('jobs.searchPlaceholder')}
                className="w-full bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          </div>

          {/* List */}
          {loading ? (
            <JobsListSkeleton />
          ) : error ? (
            <div className="flex flex-col items-start gap-3 py-8">
              <p className="text-[13.5px] text-destructive">{error}</p>
              <button
                type="button"
                onClick={fetchJobs}
                className="rounded-sm border border-input px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('jobs.tryAgain')}
              </button>
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-start gap-4 py-10">
              <p className="text-[13.5px] text-muted-foreground">
                {t('jobs.noJobs')}
              </p>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="rounded-sm bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t('jobs.uploadFirst')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col duration-500 animate-in fade-in-0">
              {/* Column headers */}
              <div className="flex items-center gap-3.5 border-b border-border px-1 pb-[9px]">
                <div className="w-4 shrink-0" />
                <div className="flex flex-1 items-center gap-3">
                  <span className="w-24 text-[11px] font-semibold tracking-[0.4px] text-muted-foreground">
                    {t('jobs.columns.jobId')}
                  </span>
                  <span className="flex-1 text-[11px] font-semibold tracking-[0.4px] text-muted-foreground">
                    {t('jobs.columns.document')}
                  </span>
                </div>
                <span className="hidden w-[110px] text-right text-[11px] font-semibold tracking-[0.4px] text-muted-foreground sm:block">
                  {t('jobs.columns.uploaded')}
                </span>
                <span className="w-[92px] text-right text-[11px] font-semibold tracking-[0.4px] text-muted-foreground">
                  {t('jobs.columns.status')}
                </span>
                <div className="w-[15px] shrink-0" />
              </div>

              {filteredJobs.length === 0 ? (
                <p className="py-8 text-[13.5px] text-muted-foreground">
                  {t('jobs.noResults')}
                </p>
              ) : (
                groups.map((group) => (
                  <div key={group.label} className="flex flex-col pt-2.5">
                    <span className="px-1 pb-1 pt-2 text-[11.5px] font-semibold tracking-[0.4px] text-muted-foreground">
                      {group.label}
                    </span>
                    {group.jobs.map((job) => (
                      <JobRow
                        key={job.jobId}
                        job={job}
                        formatDate={formatDate}
                        onOpen={() => navigate(`/jobs/${job.jobId}`)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

interface JobRowProps {
  job: Job
  formatDate: (timestamp: string) => string
  onOpen: () => void
}

function JobRow({ job, formatDate, onOpen }: JobRowProps) {
  const { t } = useTranslation()
  const kind = statusKind(job.status)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3.5 border-b border-border px-1 py-[15px] text-left transition-colors hover:bg-accent/40"
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" />

      <div className="flex flex-1 items-center gap-3 overflow-hidden">
        <span className="w-24 shrink-0 truncate font-mono text-[13px] font-medium text-foreground">
          {job.jobId.slice(0, 8)}
        </span>
        <span className="flex-1 truncate text-[12.5px] text-muted-foreground">
          {job.originalFilename}
        </span>
      </div>

      <span className="hidden w-[110px] shrink-0 text-right text-[12.5px] text-muted-foreground sm:block">
        {formatDate(job.uploadTimestamp)}
      </span>

      <span className="flex w-[92px] shrink-0 items-center justify-end gap-1.5">
        <span className={cn('size-1.5 rounded-full', STATUS_DOT[kind])} />
        <span className="text-[12.5px] text-muted-foreground">
          {t(`jobs.statusLabel.${kind}`)}
        </span>
      </span>

      <ChevronRight className="size-[15px] shrink-0 text-muted-foreground" />
    </button>
  )
}

/** Placeholder rows that mirror the jobs list layout while data loads. */
function JobsListSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3.5 border-b border-border px-1 py-[15px]"
        >
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <div className="flex flex-1 items-center gap-3">
            <Skeleton className="h-3.5 w-24 shrink-0" />
            <Skeleton className={cn('h-3.5', i % 2 ? 'w-40' : 'w-56')} />
          </div>
          <Skeleton className="hidden h-3.5 w-[90px] sm:block" />
          <Skeleton className="h-3.5 w-[70px]" />
          <div className="w-[15px] shrink-0" />
        </div>
      ))}
    </div>
  )
}
