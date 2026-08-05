import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom'
import './styles/App.css'
import ManualPage from './components/ManualPage'
import { JobPage } from './components/JobPage'
import { LandingPage } from './components/LandingPage'
import { JobsPage } from './components/JobsPage'

// Wrapper to extract jobId from URL params
function JobPageWrapper() {
  const params = useParams<{ jobId: string }>()
  return <JobPage jobId={params.jobId!} />
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={
          <LandingPage />
        } />
        <Route path="/jobs" element={
          <JobsPage />
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
