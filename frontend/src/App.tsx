import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, useNavigate, useParams, Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ManualPage from './components/ManualPage'
import { LanguageSelector } from './components/LanguageSelector'
import { apiClient } from './utils/apiClient'
import './styles/App.css'
import { JobPage } from './components/JobPage'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { 
  faShieldAlt, 
  faFileAlt, 
  faStethoscope, 
  faRobot, 
  faFileMedical, 
  faList, 
  faCalendarAlt, 
  faCheckCircle, 
  faHourglassHalf,
  faExclamationCircle,
  faHeartbeat,
  faHome,
  faSearch,
  faTimes,
} from '@fortawesome/free-solid-svg-icons'

function UploadPage() {
  const { t } = useTranslation()
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insuranceType, setInsuranceType] = useState<'life' | 'property_casualty'>('property_casualty')
  const [uploadProgress, setUploadProgress] = useState<Record<string, string>>({})
  const navigate = useNavigate()

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || [])
    setError(null)
    
    if (selectedFiles.length === 0) {
      return
    }

    // Validate all files are PDFs
    const invalidFiles = selectedFiles.filter(file => !file.type.includes('pdf'))
    if (invalidFiles.length > 0) {
      setError(t('errors.pdfOnly', { files: invalidFiles.map(f => f.name).join(', ') }))
      return
    }

    setFiles(selectedFiles)
    setUploadProgress({})
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const droppedFiles = Array.from(event.dataTransfer.files)
    
    // Validate all files are PDFs
    const invalidFiles = droppedFiles.filter(file => !file.type.includes('pdf'))
    if (invalidFiles.length > 0) {
      setError(t('errors.pdfOnly', { files: invalidFiles.map(f => f.name).join(', ') }))
      return
    }

    setFiles(droppedFiles)
    setUploadProgress({})
    setError(null)
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
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
        // Single file upload - use existing endpoint
        await uploadSingleFile(files[0])
      } else {
        // Multi-file upload - use batch endpoint
        await uploadMultipleFiles(files)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.uploadFailed'))
      setUploading(false)
    }
  }

  const uploadSingleFile = async (file: File) => {
    setUploadProgress({ [file.name]: t('upload.gettingUploadUrl') })

    const presignedUrlResponse = await apiClient.fetch(`${import.meta.env.VITE_API_URL}/documents/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        insuranceType: insuranceType
      }),
    })

    if (!presignedUrlResponse.ok) {
      if (presignedUrlResponse.status === 401) {
        throw new Error(t('errors.unauthorizedUploadUrl'));
      } else {
        const errorData = await presignedUrlResponse.json().catch(() => ({ error: t('errors.failedUploadUrl') }));
        throw new Error(errorData.error || `${t('errors.failedUploadUrl')}: ${presignedUrlResponse.statusText}`);
      }
    }

    const { uploadUrl, jobId } = await presignedUrlResponse.json()
    if (!uploadUrl || !jobId) {
      throw new Error(t('errors.invalidUploadResponse'));
    }

    setUploadProgress({ [file.name]: t('upload.uploadingToS3') })

    const s3UploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type,
      },
      body: file,
    })

    if (!s3UploadResponse.ok) {
      throw new Error(t('errors.s3UploadFailed', { filename: file.name, error: s3UploadResponse.statusText }))
    }

    setUploadProgress({ [file.name]: t('upload.uploadSuccess') })
    setUploading(false)
    setFiles([])
    navigate(`/jobs/${jobId}`)
  }

  const uploadMultipleFiles = async (files: File[]) => {
    // Step 1: Get batch upload URLs
    setUploadProgress(Object.fromEntries(files.map(f => [f.name, t('upload.gettingUploadUrls')])))

    const batchResponse = await apiClient.fetch(`${import.meta.env.VITE_API_URL}/documents/batch-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: files.map(f => ({ filename: f.name })),
        insuranceType: insuranceType
      }),
    })

    if (!batchResponse.ok) {
      if (batchResponse.status === 401) {
        throw new Error(t('errors.unauthorizedBatchUpload'));
      } else {
        const errorData = await batchResponse.json().catch(() => ({ error: t('errors.failedBatchUploadUrls') }));
        throw new Error(errorData.error || `${t('errors.failedBatchUploadUrls')}: ${batchResponse.statusText}`);
      }
    }

    const { uploadUrls } = await batchResponse.json()
    if (!uploadUrls || !Array.isArray(uploadUrls)) {
      throw new Error(t('errors.invalidBatchResponse'));
    }

    // Step 2: Upload all files to S3
    const uploadPromises = files.map(async (file, index) => {
      const uploadInfo = uploadUrls.find(u => u.filename === file.name)
      if (!uploadInfo) {
        throw new Error(t('errors.noUploadUrlForFile', { filename: file.name }))
      }

      setUploadProgress(prev => ({ ...prev, [file.name]: t('upload.uploadingToS3') }))

      const s3UploadResponse = await fetch(uploadInfo.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
        },
        body: file,
      })

      if (!s3UploadResponse.ok) {
        throw new Error(t('errors.s3UploadFailed', { filename: file.name, error: s3UploadResponse.statusText }))
      }

      setUploadProgress(prev => ({ ...prev, [file.name]: t('upload.uploadSuccess') }))
    })

    await Promise.all(uploadPromises)
    
    setUploading(false)
    setFiles([])
    navigate('/jobs')
  }

  return (
    <div className="container">
      <div className="header">
        <h1>
          <span className="header-logo">
            <FontAwesomeIcon icon={faShieldAlt} />
          </span>
          {t('header.title')}
        </h1>
        <div className="header-controls">
          <LanguageSelector />
          <div className="header-insurance-toggle">
            <label className={`option ${insuranceType === 'life' ? 'selected' : ''}`}>
              <input 
                type="radio" 
                name="headerInsuranceType" 
                value="life" 
                checked={insuranceType === 'life'}
                onChange={() => setInsuranceType('life')} 
              />
              <span className="option-icon"><FontAwesomeIcon icon={faHeartbeat} /></span>
              <span>{t('common.life')}</span>
            </label>
            <label className={`option ${insuranceType === 'property_casualty' ? 'selected' : ''}`}>
              <input 
                type="radio" 
                name="headerInsuranceType" 
                value="property_casualty" 
                checked={insuranceType === 'property_casualty'}
                onChange={() => setInsuranceType('property_casualty')} 
              />
              <span className="option-icon"><FontAwesomeIcon icon={faHome} /></span>
              <span>{t('common.propertyAndCasualty')}</span>
            </label>
          </div>
          {insuranceType === 'life' && (
            <button
              type="button"
              onClick={() => navigate('/manual')}
              className="nav-button"
            >
              <FontAwesomeIcon icon={faStethoscope} style={{ marginRight: '8px' }} />
              {t('header.underwritingManual')}
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate('/jobs')}
            className="nav-button"
          >
            <FontAwesomeIcon icon={faList} style={{ marginRight: '8px' }} />
            {t('header.viewAllJobs')}
          </button>
        </div>
      </div>

      <div className="description-section">
        <h2>
          {insuranceType === 'life' 
            ? t('upload.streamlineLife')
            : t('upload.streamlinePropertyCasualty')}
        </h2>
        <p className="intro-text">
          {insuranceType === 'life' 
            ? <span dangerouslySetInnerHTML={{ __html: t('upload.introLife') }} />
            : <span dangerouslySetInnerHTML={{ __html: t('upload.introPropertyCasualty') }} />}
        </p>
        
        <div className="features-grid">
          <div className="feature-card">
            <h3>
              <FontAwesomeIcon icon={faFileAlt} />
              {t('upload.documentAnalysis')}
            </h3>
            <ul>
              {insuranceType === 'life' ? (
                <>
                  <li>{t('features.life.documentAnalysis.item1')}</li>
                  <li>{t('features.life.documentAnalysis.item2')}</li>
                  <li>{t('features.life.documentAnalysis.item3')}</li>
                </>
              ) : (
                <>
                  <li>{t('features.propertyAndCasualty.documentAnalysis.item1')}</li>
                  <li>{t('features.propertyAndCasualty.documentAnalysis.item2')}</li>
                  <li>{t('features.propertyAndCasualty.documentAnalysis.item3')}</li>
                </>
              )}
            </ul>
          </div>

          <div className="feature-card">
            <h3>
              <FontAwesomeIcon icon={insuranceType === 'life' ? faStethoscope : faHome} />
              {insuranceType === 'life' ? t('upload.underwriterAnalysis') : t('upload.propertyAssessmentTitle')}
            </h3>
            <ul>
              {insuranceType === 'life' ? (
                <>
                  <li>{t('features.life.underwriterAnalysis.item1')}</li>
                  <li>{t('features.life.underwriterAnalysis.item2')}</li>
                  <li>{t('features.life.underwriterAnalysis.item3')}</li>
                  <li>{t('features.life.underwriterAnalysis.item4')}</li>
                </>
              ) : (
                <>
                  <li>{t('features.propertyAndCasualty.propertyAssessment.item1')}</li>
                  <li>{t('features.propertyAndCasualty.propertyAssessment.item2')}</li>
                  <li>{t('features.propertyAndCasualty.propertyAssessment.item3')}</li>
                  <li>{t('features.propertyAndCasualty.propertyAssessment.item4')}</li>
                </>
              )}
            </ul>
          </div>

          <div className="feature-card">
            <h3>
              <FontAwesomeIcon icon={faRobot} />
              {t('upload.interactiveAssistant')}
            </h3>
            <ul>
              {insuranceType === 'life' ? (
                <>
                  <li>{t('features.life.interactiveAssistant.item1')}</li>
                  <li>{t('features.life.interactiveAssistant.item2')}</li>
                  <li>{t('features.life.interactiveAssistant.item3')}</li>
                </>
              ) : (
                <>
                  <li>{t('features.propertyAndCasualty.interactiveAssistant.item1')}</li>
                  <li>{t('features.propertyAndCasualty.interactiveAssistant.item2')}</li>
                  <li>{t('features.propertyAndCasualty.interactiveAssistant.item3')}</li>
                </>
              )}
            </ul>
          </div>
        </div>

        <div className="supported-documents">
          <h3>{t('upload.supportedDocuments')}</h3>
          <div className="document-types">
            {insuranceType === 'life' ? (
              <>
                <span className="document-type">{t('documents.life.applications')}</span>
                <span className="document-type">{t('documents.life.aps')}</span>
                <span className="document-type">{t('documents.life.labReports')}</span>
                <span className="document-type">{t('documents.life.pharmacyRecords')}</span>
                <span className="document-type">{t('documents.life.financialDisclosures')}</span>
                <span className="document-type">{t('documents.life.medicalQuestionnaires')}</span>
                <span className="document-type">{t('documents.life.supplementalForms')}</span>
              </>
            ) : (
              <>
                <span className="document-type">{t('documents.propertyAndCasualty.acordForms')}</span>
                <span className="document-type">{t('documents.propertyAndCasualty.propertyInspections')}</span>
                <span className="document-type">{t('documents.propertyAndCasualty.claimsHistory')}</span>
                <span className="document-type">{t('documents.propertyAndCasualty.propertyValuations')}</span>
                <span className="document-type">{t('documents.propertyAndCasualty.floodZoneCertificates')}</span>
                <span className="document-type">{t('documents.propertyAndCasualty.buildingCodeCompliance')}</span>
                <span className="document-type">{t('documents.propertyAndCasualty.securityDocumentation')}</span>
              </>
            )}
            <span className="document-type">{t('common.andMore')}</span>
          </div>
        </div>
      </div>
      
      <div className="upload-section">
        <h2>
          <FontAwesomeIcon icon={faFileMedical} style={{ marginRight: '10px', color: '#3b82f6' }} />
          {t('upload.title')}
        </h2>
        
        <div className="insurance-type-selector">
          <h3>{t('insuranceType.selectType')}</h3>
          <div className="insurance-options">
            <label className={`option ${insuranceType === 'life' ? 'selected' : ''}`}>
              <input 
                type="radio" 
                name="insuranceType" 
                value="life" 
                checked={insuranceType === 'life'}
                onChange={() => setInsuranceType('life')} 
              />
              <span className="option-icon"><FontAwesomeIcon icon={faHeartbeat} /></span>
              <span className="option-label">{t('insuranceType.life')}</span>
            </label>
            <label className={`option ${insuranceType === 'property_casualty' ? 'selected' : ''}`}>
              <input 
                type="radio" 
                name="insuranceType" 
                value="property_casualty" 
                checked={insuranceType === 'property_casualty'}
                onChange={() => setInsuranceType('property_casualty')} 
              />
              <span className="option-icon"><FontAwesomeIcon icon={faHome} /></span>
              <span className="option-label">{t('insuranceType.propertyAndCasualty')}</span>
            </label>
          </div>
        </div>
        
        <div 
          className={`file-drop-zone ${files.length > 0 ? 'has-files' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <input
            type="file"
            accept=".pdf"
            multiple
            onChange={handleFileChange}
            disabled={uploading}
            className="file-input"
            id="file-input"
          />
          <label htmlFor="file-input" className="file-input-label">
            <FontAwesomeIcon icon={faFileMedical} size="2x" />
            <p>
              <strong>{t('upload.selectFiles')}</strong> {t('upload.dragDrop')}
            </p>
            <p className="file-hint">
              {t('upload.multipleFiles')}
            </p>
          </label>
        </div>
        
        {files.length > 0 && (
          <div className="selected-files">
            <h4>{t('upload.selectedFiles', { count: files.length })}</h4>
            <ul className="file-list">
              {files.map((file, index) => (
                <li key={index}>
                  {file.name}
                  {uploadProgress[file.name] && (
                    <span className="upload-status"> - {uploadProgress[file.name]}</span>
                  )}
                </li>
              ))}
            </ul>
            <button 
              onClick={handleUpload}
              disabled={uploading}
              className="upload-button"
            >
              {uploading ? t('upload.uploading') : t('upload.analyzing', { count: files.length })}
            </button>
          </div>
        )}

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

// Wrapper to extract jobId from URL params
function JobPageWrapper() {
  const params = useParams<{ jobId: string }>()
  return <JobPage jobId={params.jobId!} />
}

// Add this new type definition
interface Job {
  jobId: string;
  originalFilename: string;
  uploadTimestamp: string;
  status: 'Complete' | 'In Progress' | 'Failed';
}

// Add the JobsList component
function JobsList() {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedBatches, setCollapsedBatches] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = () => {
    setSearchQuery(searchInput.trim());
  };

  const handleClear = () => {
    setSearchInput('');
    setSearchQuery('');
  };

  const handleKeyDown = (e: any) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const filteredJobs = searchQuery
  ? jobs.filter(job =>
      job.originalFilename.toLowerCase().includes(searchQuery.toLowerCase())
    )
  : jobs;


  useEffect(() => {
    fetchJobs();
    
    // Set up polling to refresh job statuses every 5 seconds
    const pollInterval = setInterval(() => {
      fetchJobs();
    }, 5000);
    
    // Cleanup interval on unmount
    return () => clearInterval(pollInterval);
  }, []);

  const toggleBatch = (batchId: string) => {
    const newCollapsed = new Set(collapsedBatches);
    if (newCollapsed.has(batchId)) {
      newCollapsed.delete(batchId);
    } else {
      newCollapsed.add(batchId);
    }
    setCollapsedBatches(newCollapsed);
  };

  const groupJobsByBatch = (jobs: Job[]) => {
    const grouped = jobs.reduce((acc, job) => {
      const batchId = job.batchId; // All jobs now have batchId
      if (!acc[batchId]) {
        acc[batchId] = [];
      }
      acc[batchId].push(job);
      return acc;
    }, {} as Record<string, Job[]>);
    return grouped;
  };

  const getShortBatchId = (batchId: string) => {
    return batchId.slice(-8);
  };

  const getBatchTimestamp = (jobs: Job[]) => {
    const timestamps = jobs.map(job => new Date(job.uploadTimestamp));
    const earliest = new Date(Math.min(...timestamps.map(d => d.getTime())));
    return earliest.toLocaleString();
  };

  const fetchJobs = async () => {
    try {
      const response = await apiClient.fetch(`${import.meta.env.VITE_API_URL}/jobs`);

      if (!response.ok) {
        if (response.status === 401) {
          setError(t('errors.unauthorized'));
          setLoading(false);
          return;
        }
        throw new Error(t('jobs.fetchError'));
      }

      const data = await response.json();
      setJobs(data.jobs || data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return 'Invalid date';
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Complete':
        return <FontAwesomeIcon icon={faCheckCircle} className="status-icon complete" />;
      case 'In Progress':
        return <FontAwesomeIcon icon={faHourglassHalf} className="status-icon in-progress" />;
      case 'Failed':
        return <FontAwesomeIcon icon={faExclamationCircle} className="status-icon failed" />;
      default:
        return null;
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>
          <span className="header-logo">
            <FontAwesomeIcon icon={faShieldAlt} />
          </span>
          {t('header.title')}
        </h1>
        <div className="header-controls">
          <LanguageSelector />
          <button onClick={() => navigate('/')} className="nav-button">
            <FontAwesomeIcon icon={faFileMedical} /> {t('header.uploadNew')}
          </button>
          <button onClick={() => navigate('/manual')} className="nav-button">
            <FontAwesomeIcon icon={faStethoscope} style={{ marginRight: '8px' }} />
            {t('header.underwritingManual')}
          </button>
        </div>
      </div>

      <div className="jobs-section">
        <h2>
          <FontAwesomeIcon icon={faList} style={{ marginRight: '10px' }} /> 
          {t('jobs.title')}
        </h2>

        {loading ? (
          <div className="loading">{t('jobs.loading')}</div>
        ) : error ? (
          <div className="error-message">
            {error}
            <button 
              onClick={fetchJobs}
              className="refresh-button"
            >
              {t('jobs.tryAgain')}
            </button>
          </div>
        ) : jobs.length === 0 ? (
          <div className="no-jobs">
            <p>{t('jobs.noJobs')}</p>
            <button 
              onClick={() => navigate('/')}
              className="upload-button"
            >
              {t('jobs.uploadFirst')}
            </button>
          </div>
        ) : (
          <>
            <div
              className="search-container"
              style={{ textAlign: 'center', margin: '20px 0' }}
            >
              <input
                type="text"
                placeholder="Search by filename"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={handleKeyDown}
                style={{ padding: '8px', width: '300px' }}
              />
              <button
                onClick={handleSearch}
                style={{
                  padding: '8px 12px',
                  marginLeft: '8px',
                  background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                <FontAwesomeIcon icon={faSearch} style={{ marginRight: '5px' }} />
                Search
              </button>
              <button
                onClick={handleClear}
                style={{
                  padding: '8px 12px',
                  marginLeft: '8px',
                  background: 'linear-gradient(135deg, #e5e7eb 0%, #d1d5db 100%)',
                  color: '#333',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                <FontAwesomeIcon icon={faTimes} style={{ marginRight: '5px' }} />
                Clear
              </button>
            </div>
          <div className="jobs-list">
            {(() => {
              const grouped = groupJobsByBatch(filteredJobs);
              return Object.entries(grouped).map(([batchId, batchJobs]) => (
                <div key={batchId} className="batch-container">
                  <div className="batch-header" onClick={() => toggleBatch(batchId)}>
                    <h3>
                      <span className={`batch-toggle ${collapsedBatches.has(batchId) ? 'collapsed' : ''}`}>▼</span>
                      Batch ID: {getShortBatchId(batchId)}
                    </h3>
                    <p>Uploaded: {getBatchTimestamp(batchJobs)} • {batchJobs.length} document{batchJobs.length !== 1 ? 's' : ''}</p>
                  </div>
                  {!collapsedBatches.has(batchId) && batchJobs.map(job => (
                    <div
                      key={job.jobId}
                      className="job-card indented"
                      onClick={() => navigate(`/jobs/${job.jobId}`)}
                    >
                      <div className="job-icon">
                        <FontAwesomeIcon icon={faFileAlt} />
                      </div>
                      <div className="job-details">
                        <h3 className="job-filename">{job.originalFilename}</h3>
                        <div className="job-meta">
                          <div className="job-date">
                            <FontAwesomeIcon icon={faCalendarAlt} />
                            {formatDate(job.uploadTimestamp)}
                          </div>
                          <div className={`job-status ${job.status.toLowerCase().replace(' ', '-')}`}>
                            {getStatusIcon(job.status)}
                            {job.status}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={
          <UploadPage />
        } />
        <Route path="/jobs" element={
          <JobsList />
        } />
        <Route path="/jobs/:jobId" element={
          <JobPageWrapper />
        } />
        <Route path="/manual/*" element={<ManualPage />} />
        <Route 
          path="/:section(1-foundations|2-non-medical-factors|3-medical-impairments|4-evidence-screening|5-appendices)/*" 
          element={<ManualPage />} 
        />
      </Routes>
    </Router>
  )
}

export default App