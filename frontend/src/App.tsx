import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, useNavigate, useParams, Navigate, useLocation } from 'react-router-dom'
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
      setError(`Please select only PDF files. Invalid files: ${invalidFiles.map(f => f.name).join(', ')}`)
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
      setError(`Please select only PDF files. Invalid files: ${invalidFiles.map(f => f.name).join(', ')}`)
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
      setError('Please select at least one file')
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
      setError(err instanceof Error ? err.message : 'Upload failed')
      setUploading(false)
    }
  }

  const uploadSingleFile = async (file: File) => {
    setUploadProgress({ [file.name]: 'Getting upload URL...' })

    const presignedUrlResponse = await fetch(`${import.meta.env.VITE_API_URL}/documents/upload`, {
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
        throw new Error("Unauthorized: API access denied for generating upload URL.");
      } else {
        const errorData = await presignedUrlResponse.json().catch(() => ({ error: 'Failed to get upload URL.' }));
        throw new Error(errorData.error || `Failed to get upload URL: ${presignedUrlResponse.statusText}`);
      }
    }

    const { uploadUrl, jobId } = await presignedUrlResponse.json()
    if (!uploadUrl || !jobId) {
      throw new Error('Invalid response from upload URL generation endpoint.');
    }

    setUploadProgress({ [file.name]: 'Uploading to S3...' })

    const s3UploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type,
      },
      body: file,
    })

    if (!s3UploadResponse.ok) {
      throw new Error(`S3 Upload Failed for ${file.name}: ${s3UploadResponse.statusText}`)
    }

    setUploadProgress({ [file.name]: 'Uploaded successfully' })
    setUploading(false)
    setFiles([])
    navigate(`/jobs/${jobId}`)
  }

  const uploadMultipleFiles = async (files: File[]) => {
    // Step 1: Get batch upload URLs
    setUploadProgress(Object.fromEntries(files.map(f => [f.name, 'Getting upload URLs...'])))

    const batchResponse = await fetch(`${import.meta.env.VITE_API_URL}/documents/batch-upload`, {
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
        throw new Error("Unauthorized: API access denied for batch upload.");
      } else {
        const errorData = await batchResponse.json().catch(() => ({ error: 'Failed to get batch upload URLs.' }));
        throw new Error(errorData.error || `Failed to get batch upload URLs: ${batchResponse.statusText}`);
      }
    }

    const { uploadUrls } = await batchResponse.json()
    if (!uploadUrls || !Array.isArray(uploadUrls)) {
      throw new Error('Invalid response from batch upload endpoint.');
    }

    // Step 2: Upload all files to S3
    const uploadPromises = files.map(async (file, index) => {
      const uploadInfo = uploadUrls.find(u => u.filename === file.name)
      if (!uploadInfo) {
        throw new Error(`No upload URL found for ${file.name}`)
      }

      setUploadProgress(prev => ({ ...prev, [file.name]: 'Uploading to S3...' }))

      const s3UploadResponse = await fetch(uploadInfo.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
        },
        body: file,
      })

      if (!s3UploadResponse.ok) {
        throw new Error(`S3 Upload Failed for ${file.name}: ${s3UploadResponse.statusText}`)
      }

      setUploadProgress(prev => ({ ...prev, [file.name]: 'Uploaded successfully' }))
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
          GenAI Underwriting Workbench
        </h1>
        <div className="header-controls">
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
              <span>Life</span>
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
              <span>P&C</span>
            </label>
          </div>
          <button
            type="button"
            onClick={() => navigate('/jobs')}
            className="nav-button"
          >
            <FontAwesomeIcon icon={faList} style={{ marginRight: '8px' }} />
            View All Jobs
          </button>
        </div>
      </div>

      <div className="description-section">
        <h2>
          {insuranceType === 'life' 
            ? 'Streamline Your Life Insurance Underwriting' 
            : 'Streamline Your Property & Casualty Insurance Underwriting'}
        </h2>
        <p className="intro-text">
          {insuranceType === 'life' 
            ? <span>TestTransform complex life insurance applications and medical documents into actionable insights using advanced AI analysis powered by <strong>Amazon Bedrock</strong> and <strong>Claude 3.7 Sonnet</strong>. Purpose-built for life insurance underwriters to automatically extract, analyze, and evaluate risk factors from application packets.</span>
            : <span>TestTransform complex property & casualty insurance applications and ACORD forms into actionable insights using advanced AI analysis powered by <strong>Amazon Bedrock</strong> and <strong>Claude 3.7 Sonnet</strong>. Purpose-built for P&C insurance underwriters to automatically extract, analyze, and evaluate property risk factors from application packets.</span>}
        </p>
        
        <div className="features-grid">
          <div className="feature-card">
            <h3>
              <FontAwesomeIcon icon={faFileAlt} />
              Document Analysis
            </h3>
            <ul>
              {insuranceType === 'life' ? (
                <>
                  <li>Process complete life insurance application packets</li>
                  <li>Extract medical history and risk factors</li>
                  <li>Automatic classification of APS and lab reports</li>
                </>
              ) : (
                <>
                  <li>Process complete P&C insurance application packets</li>
                  <li>Extract property details and risk factors</li>
                  <li>Automatic classification of ACORD forms</li>
                </>
              )}
            </ul>
          </div>

          <div className="feature-card">
            <h3>
              <FontAwesomeIcon icon={insuranceType === 'life' ? faStethoscope : faHome} />
              {insuranceType === 'life' ? 'Underwriter Analysis' : 'Property Assessment'}
            </h3>
            <ul>
              {insuranceType === 'life' ? (
                <>
                  <li>AI-driven mortality risk assessment</li>
                  <li>Medical history timeline construction</li>
                  <li>Cross-reference discrepancies across documents</li>
                  <li>Automated medical condition evaluation</li>
                </>
              ) : (
                <>
                  <li>AI-driven property risk assessment</li>
                  <li>Detailed property characteristics analysis</li>
                  <li>Cross-reference discrepancies across documents</li>
                  <li>Environmental and geographical risk evaluation</li>
                </>
              )}
            </ul>
          </div>

          <div className="feature-card">
            <h3>
              <FontAwesomeIcon icon={faRobot} />
              Interactive Assistant
            </h3>
            <ul>
              {insuranceType === 'life' ? (
                <>
                  <li>Query complex medical histories</li>
                  <li>Instant access to policy-relevant details</li>
                  <li>Navigate multi-document applications</li>
                </>
              ) : (
                <>
                  <li>Query property details and risk factors</li>
                  <li>Instant access to policy-relevant details</li>
                  <li>Navigate complex ACORD forms</li>
                </>
              )}
            </ul>
          </div>
        </div>

        <div className="supported-documents">
          <h3>Supported Documents</h3>
          <div className="document-types">
            {insuranceType === 'life' ? (
              <>
                <span className="document-type">Life Insurance Applications</span>
                <span className="document-type">Attending Physician Statements (APS)</span>
                <span className="document-type">Lab Reports</span>
                <span className="document-type">Pharmacy Records</span>
                <span className="document-type">Financial Disclosures</span>
                <span className="document-type">Medical History Questionnaires</span>
                <span className="document-type">Supplemental Forms</span>
              </>
            ) : (
              <>
                <span className="document-type">ACORD Forms</span>
                <span className="document-type">Property Inspections</span>
                <span className="document-type">Claims History</span>
                <span className="document-type">Property Valuations</span>
                <span className="document-type">Flood Zone Certificates</span>
                <span className="document-type">Building Code Compliance</span>
                <span className="document-type">Security Documentation</span>
              </>
            )}
            <span className="document-type">And More</span>
          </div>
        </div>
      </div>
      
      <div className="upload-section">
        <h2>
          <FontAwesomeIcon icon={faFileMedical} style={{ marginRight: '10px', color: '#3b82f6' }} />
          Upload Documents
        </h2>
        
        <div className="insurance-type-selector">
          <h3>Insurance Type</h3>
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
              <span className="option-label">Life Insurance</span>
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
              <span className="option-label">Property & Casualty</span>
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
              <strong>Click to select files</strong> or drag and drop PDF files here
            </p>
            <p className="file-hint">
              You can select multiple PDF files at once
            </p>
          </label>
        </div>
        
        {files.length > 0 && (
          <div className="selected-files">
            <h4>Selected Files ({files.length})</h4>
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
              {uploading ? 'Uploading...' : `Analyze ${files.length} Document${files.length > 1 ? 's' : ''}`}
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const fetchJobs = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/jobs`, {
      });

      if (!response.ok) {
        if (response.status === 401) {
          setError("Unauthorized: API access denied.");
          setLoading(false);
          return;
        }
        throw new Error('Failed to fetch jobs');
      }

      const data = await response.json();
      setJobs(data.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
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
          GenAI Underwriting Workbench
        </h1>
        <div className="header-controls">
          <button onClick={() => navigate('/')} className="nav-button">
            <FontAwesomeIcon icon={faFileMedical} /> Upload New
          </button>
        </div>
      </div>

      <div className="jobs-section">
        <h2>
          <FontAwesomeIcon icon={faList} style={{ marginRight: '10px' }} /> 
          Your Analysis Jobs
        </h2>

        {loading ? (
          <div className="loading">Loading jobs...</div>
        ) : error ? (
          <div className="error-message">
            {error}
            <button 
              onClick={fetchJobs}
              className="refresh-button"
            >
              Try Again
            </button>
          </div>
        ) : jobs.length === 0 ? (
          <div className="no-jobs">
            <p>You haven't uploaded any documents yet.</p>
            <button 
              onClick={() => navigate('/')}
              className="upload-button"
            >
              Upload Your First Document
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
            {filteredJobs.map(job => (
              <div
                key={job.jobId}
                className="job-card"
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
      </Routes>
    </Router>
  )
}

export default App
