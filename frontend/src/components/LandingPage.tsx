import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { HeartPulse, House, Upload, FileText, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/utils/apiClient'
import { AppTopBar, type InsuranceType } from './AppTopBar'

/**
 * Landing / upload screen. Rebuilt from designs/underwriting workbench.pen
 * (frames 01 Landing — Life, 02 Landing — P&C, 03 Landing — File Selected):
 * centered hero, three borderless capability columns, and a single upload card
 * carrying the line-of-business toggle, dropzone, selected files and the one
 * primary action. Upload behaviour (presigned single/batch PUT, drag-drop) is
 * carried over unchanged from the legacy UploadPage.
 */
export function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insuranceType, setInsuranceType] =
    useState<InsuranceType>('property_casualty')
  const [isDragging, setIsDragging] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<Record<string, string>>({})

  const isLife = insuranceType === 'life'

  const acceptFiles = (incoming: File[]) => {
    setError(null)
    if (incoming.length === 0) return
    const invalid = incoming.filter((file) => !file.type.includes('pdf'))
    if (invalid.length > 0) {
      setError(t('errors.pdfOnly', { files: invalid.map((f) => f.name).join(', ') }))
      return
    }
    setFiles(incoming)
    setUploadProgress({})
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    acceptFiles(Array.from(event.target.files || []))
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    acceptFiles(Array.from(event.dataTransfer.files))
  }

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name))
    setUploadProgress((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  const handleUpload = async () => {
    if (files.length === 0) {
      setError(t('errors.selectFile'))
      return
    }
    setUploading(true)
    setError(null)
    try {
      if (files.length === 1) {
        await uploadSingleFile(files[0])
      } else {
        await uploadMultipleFiles(files)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.uploadFailed'))
      setUploading(false)
    }
  }

  const uploadSingleFile = async (file: File) => {
    setUploadProgress({ [file.name]: t('upload.gettingUploadUrl') })

    const presignedUrlResponse = await apiClient.fetch(
      `${import.meta.env.VITE_API_URL}/documents/upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          insuranceType,
        }),
      },
    )

    if (!presignedUrlResponse.ok) {
      if (presignedUrlResponse.status === 401) {
        throw new Error(t('errors.unauthorizedUploadUrl'))
      }
      const errorData = await presignedUrlResponse
        .json()
        .catch(() => ({ error: t('errors.failedUploadUrl') }))
      throw new Error(
        errorData.error ||
          `${t('errors.failedUploadUrl')}: ${presignedUrlResponse.statusText}`,
      )
    }

    const { uploadUrl, jobId } = await presignedUrlResponse.json()
    if (!uploadUrl || !jobId) {
      throw new Error(t('errors.invalidUploadResponse'))
    }

    setUploadProgress({ [file.name]: t('upload.uploadingToS3') })

    const s3UploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })

    if (!s3UploadResponse.ok) {
      throw new Error(
        t('errors.s3UploadFailed', {
          filename: file.name,
          error: s3UploadResponse.statusText,
        }),
      )
    }

    setUploadProgress({ [file.name]: t('upload.uploadSuccess') })
    setUploading(false)
    setFiles([])
    navigate(`/jobs/${jobId}`)
  }

  const uploadMultipleFiles = async (files: File[]) => {
    setUploadProgress(
      Object.fromEntries(files.map((f) => [f.name, t('upload.gettingUploadUrls')])),
    )

    const batchResponse = await apiClient.fetch(
      `${import.meta.env.VITE_API_URL}/documents/batch-upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: files.map((f) => ({ filename: f.name })),
          insuranceType,
        }),
      },
    )

    if (!batchResponse.ok) {
      if (batchResponse.status === 401) {
        throw new Error(t('errors.unauthorizedBatchUpload'))
      }
      const errorData = await batchResponse
        .json()
        .catch(() => ({ error: t('errors.failedBatchUploadUrls') }))
      throw new Error(
        errorData.error ||
          `${t('errors.failedBatchUploadUrls')}: ${batchResponse.statusText}`,
      )
    }

    const { uploadUrls } = await batchResponse.json()
    if (!uploadUrls || !Array.isArray(uploadUrls)) {
      throw new Error(t('errors.invalidBatchResponse'))
    }

    await Promise.all(
      files.map(async (file) => {
        const uploadInfo = uploadUrls.find(
          (u: { filename: string }) => u.filename === file.name,
        )
        if (!uploadInfo) {
          throw new Error(t('errors.noUploadUrlForFile', { filename: file.name }))
        }

        setUploadProgress((prev) => ({
          ...prev,
          [file.name]: t('upload.uploadingToS3'),
        }))

        const s3UploadResponse = await fetch(uploadInfo.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        })

        if (!s3UploadResponse.ok) {
          throw new Error(
            t('errors.s3UploadFailed', {
              filename: file.name,
              error: s3UploadResponse.statusText,
            }),
          )
        }

        setUploadProgress((prev) => ({
          ...prev,
          [file.name]: t('upload.uploadSuccess'),
        }))
      }),
    )

    setUploading(false)
    setFiles([])
    navigate('/jobs')
  }

  const capabilities = [
    {
      title: t('landing.capabilities.documentAnalysis.title'),
      body: isLife
        ? t('landing.capabilities.documentAnalysis.bodyLife')
        : t('landing.capabilities.documentAnalysis.bodyPropertyCasualty'),
    },
    {
      title: isLife
        ? t('landing.capabilities.analysis.titleLife')
        : t('landing.capabilities.analysis.titlePropertyCasualty'),
      body: isLife
        ? t('landing.capabilities.analysis.bodyLife')
        : t('landing.capabilities.analysis.bodyPropertyCasualty'),
    },
    {
      title: t('landing.capabilities.interactiveAssistant.title'),
      body: isLife
        ? t('landing.capabilities.interactiveAssistant.bodyLife')
        : t('landing.capabilities.interactiveAssistant.bodyPropertyCasualty'),
    },
  ]

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppTopBar
        activeSection="upload"
        insuranceType={insuranceType}
        onInsuranceTypeChange={setInsuranceType}
      />

      {/* Hero */}
      <section className="flex flex-col items-center px-[120px] pb-[72px] pt-[104px]">
        <div className="flex w-[680px] flex-col items-center gap-5">
          <h1 className="text-center text-[46px] font-semibold leading-[1.12] tracking-[-1.4px] text-foreground">
            {isLife
              ? t('landing.hero.headingLife')
              : t('landing.hero.headingPropertyCasualty')}
          </h1>
          <p className="w-[560px] text-center text-[16.5px] leading-[1.55] text-muted-foreground">
            {isLife
              ? t('landing.hero.subheadingLife')
              : t('landing.hero.subheadingPropertyCasualty')}
          </p>
        </div>

        {/* Capabilities */}
        <div className="flex w-[820px] justify-center gap-14 pt-14">
          {capabilities.map((cap) => (
            <div key={cap.title} className="flex flex-1 flex-col gap-[7px]">
              <h3 className="text-sm font-semibold leading-[1.45] text-foreground">
                {cap.title}
              </h3>
              <p className="text-[13px] leading-[1.6] text-muted-foreground">
                {cap.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Upload card */}
      <section className="flex flex-col items-center px-[120px] pb-[120px] pt-2">
        <div className="w-[460px] rounded-lg border border-border bg-card shadow-[0_1px_1.75px_0_rgba(0,0,0,0.05)]">
          <div className="flex flex-col px-7 pt-7">
            <h2 className="text-base font-semibold leading-[1.4] text-foreground">
              {t('landing.uploadCard.title')}
            </h2>
            <p className="text-[13px] leading-[1.5] text-muted-foreground">
              {t('landing.uploadCard.caption')}
            </p>
          </div>

          <div className="flex flex-col gap-[18px] px-7 pb-7 pt-[18px]">
            {/* Insurance type toggle */}
            <div className="flex flex-col gap-2">
              <span className="text-[12.5px] font-medium text-muted-foreground">
                {t('landing.uploadCard.insuranceType')}
              </span>
              <div className="flex gap-3">
                <TypePill
                  active={isLife}
                  icon={<HeartPulse className="size-[15px]" />}
                  label={t('landing.uploadCard.lifeInsurance')}
                  onClick={() => setInsuranceType('life')}
                />
                <TypePill
                  active={!isLife}
                  icon={<House className="size-[15px]" />}
                  label={t('landing.uploadCard.propertyCasualty')}
                  onClick={() => setInsuranceType('property_casualty')}
                />
              </div>
            </div>

            {/* Dropzone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-sm border px-6 py-8 text-center transition-colors',
                isDragging
                  ? 'border-primary bg-secondary/50'
                  : 'border-border hover:border-ring',
              )}
            >
              <Upload className="size-5 text-muted-foreground" />
              <span className="text-[13.5px] font-medium text-foreground">
                {t('landing.uploadCard.dropzone')}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                multiple
                onChange={handleFileChange}
                disabled={uploading}
                className="hidden"
              />
            </div>

            {/* Selected files + primary action */}
            {files.length > 0 && (
              <div className="flex flex-col gap-3.5">
                {files.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center gap-2.5 rounded-sm bg-secondary px-3.5 py-2.5"
                  >
                    <FileText className="size-[15px] shrink-0 text-foreground" />
                    <span className="flex-1 truncate text-[13px] font-medium text-foreground">
                      {file.name}
                      {uploadProgress[file.name] && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          — {uploadProgress[file.name]}
                        </span>
                      )}
                    </span>
                    {!uploading && (
                      <button
                        type="button"
                        onClick={() => removeFile(file.name)}
                        aria-label={t('landing.uploadCard.removeFile')}
                        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}

                <Button
                  onClick={handleUpload}
                  disabled={uploading}
                  className="h-auto w-full rounded-sm py-[11px] shadow-none"
                >
                  {uploading
                    ? t('upload.uploading')
                    : t('landing.uploadCard.analyze', { count: files.length })}
                </Button>
              </div>
            )}

            {error && (
              <p className="text-[13px] text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

interface TypePillProps {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}

function TypePill({ active, icon, label, onClick }: TypePillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center gap-2 rounded-sm px-3.5 py-2.5 text-[13px] transition-colors',
        active
          ? 'bg-secondary font-semibold text-foreground [&_svg]:text-foreground'
          : 'font-medium text-muted-foreground hover:text-foreground [&_svg]:text-muted-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
