import { useState, useEffect, CSSProperties, createContext, useContext, useRef, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import Split from 'react-split'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import '../styles/JobPage.css'
import { useNavigate } from 'react-router-dom'
import { HowItWorksDrawer } from './HowItWorksDrawer'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faFileAlt, faFileContract, faComments, faChevronRight, faChevronLeft, 
  faExpandAlt, faCompressAlt, faSearchPlus, faSearchMinus, faInfoCircle, 
  faFileMedical, faFileInvoiceDollar, faIdCard, faClipboardList, faUpload, 
  faFileImage, faCog, faDatabase, faCheckCircle, faUserMd, faPills, faFlask, 
  faHeartbeat, faVial, faLungs, faProcedures, faXRay, faStethoscope, 
  faNotesMedical, faMicroscope, faHospital, faAllergies, faTooth, faEye, 
  faBriefcaseMedical, faHistory, faHome, faCar, faBuilding, faUmbrella, 
  faWater, faFire, faBalanceScale, faExclamationTriangle, faTruck, 
  faHardHat, faIndustry, faCloudShowersHeavy, faWind, faRoad, 
  faShieldAlt, faGavel, faList, faClipboardCheck,
  faSpinner, faHourglassHalf, faTimesCircle, faPrint, faSyncAlt,
  faRobot, faEnvelope, faTimes
} from '@fortawesome/free-solid-svg-icons'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// Define the props type for custom components, aligning with react-markdown
interface MarkdownComponentProps {
  node?: any; // The hast node
  children?: React.ReactNode;
  // Include other props passed by react-markdown if necessary, e.g., level for headings
  [key: string]: any; // Allow other props
}

const generateMarkdownComponents = (styles: Record<string, CSSProperties>): Record<string, React.FC<MarkdownComponentProps>> => {
  const components: Record<string, React.FC<MarkdownComponentProps>> = {};
  for (const cssClassOrTag in styles) {
    const styleObject = styles[cssClassOrTag];
    const tags = cssClassOrTag.split(',').map(tag => tag.trim());
    tags.forEach(tagString => {
      const Element = tagString as keyof JSX.IntrinsicElements;
      components[Element] = ({ node, children, ...props }) => {
        return <Element style={styleObject} {...props}>{children}</Element>;
      };
    });
  }
  return components;
};

interface PageAnalysis {
  [key: string]: string
}

interface UnderwriterAnalysis {
  RISK_ASSESSMENT: string
  DISCREPANCIES: string
  MEDICAL_TIMELINE?: string
  PROPERTY_ASSESSMENT?: string
  FINAL_RECOMMENDATION: string
}

interface PageData {
  page_type: string;
  content: string;
  numeric_page_num_for_nav?: number;
}

interface Bookmark {
  title: string;
  startPage: number;
  pages: number[];
}

interface AnalysisData {
  job_id: string;
  timestamp: string;
  filename: string;
  page_analysis: Record<string, PageData>;
  underwriter_analysis: UnderwriterAnalysis;
  status: string;
  insurance_type?: 'life' | 'property_casualty';
}

interface JobPageProps {
  jobId: string
}

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

interface JobApiResponse {
  jobId: string;
  originalFilename: string;
  documentType?: string;
  status: string;
  timestamp: string;
  insurance_type?: 'life' | 'property_casualty';
  extractedData?: Record<string, any>;
  analysisOutput?: AnalysisOutput;
  agentActionOutput?: AgentActionData;
  extracted_data?: {
    sections?: Array<{
      title: string;
      content: string;
      start_page_number?: number;
      findings?: Array<{ type: string; description: string; severity?: string; page_references?: number[]; }>;
    }>;
    key_value_pairs?: Record<string, string>;
    tables?: Array<{ name: string; rows: Array<Record<string, string>> }>;
  };
  extractedDataJsonStr?: string;
  analysisOutputJsonStr?: string;
  agentActionOutputJsonStr?: string;
  analysis_summary?: string;
  identified_risks?: Array<{ description: string; severity?: string; page_references?: number[]; }>;
  underwriting_recommendation?: string;
  discrepancies_summary?: string;
  medical_timeline_summary?: string;
  property_assessment_summary?: string;
  error_message?: string;
}

interface AgentActionData {
  document_identifier: string;
  agent_action_confirmation: string;
  message: string;
}

interface AnalysisOutput {
  identified_risks?: Array<{ risk_description: string; severity?: string; page_references?: number[] }>;
  discrepancies?: Array<{ discrepancy_description: string; details: string; page_references?: number[] }>;
  medical_timeline?: string;
  property_assessment?: string;
  final_recommendation?: string;
}

const markdownStyles: Record<string, CSSProperties> = {
  p: { margin: '0.5em 0' }, 'h1,h2,h3,h4,h5,h6': { margin: '0.5em 0' },
  pre: { background: '#f1f5f9', padding: '0.5em', borderRadius: '4px', overflowX: 'auto' },
  code: { background: '#f1f5f9', padding: '0.2em 0.4em', borderRadius: '3px', fontFamily: 'monospace' },
  table: { borderCollapse: 'collapse', width: '100%', marginBlock: '1em' },
  'th,td': { border: '1px solid #e2e8f0', padding: '8px', textAlign: 'left' },
  blockquote: { borderLeft: '4px solid #e2e8f0', margin: '0.5em 0', padding: '0.5em 1em', background: '#f8fafc'}
}

// Generate the components object once from markdownStyles
const customMarkdownComponentsFromStyles = generateMarkdownComponents(markdownStyles);

type TabType = 'grouped' | 'underwriter' | 'chat';

const PageReference = ({ pageNum, text }: { pageNum: string, text: string }) => {
  const [currentPage, setCurrentPage] = useContext(PageContext)
  const [numPages] = useContext(NumPagesContext)

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    const page = parseInt(pageNum)
    if (!isNaN(page) && page > 0 && page <= (numPages || 0)) {
      setCurrentPage(page)
    }
  }

  return (
    <span className="page-reference" onClick={handleClick}>
      {text}
    </span>
  )
}

const PageContext = createContext<[number, (page: number) => void]>([1, () => {}])
const NumPagesContext = createContext<[number | null, (pages: number | null) => void]>([null, () => {}])

const getDocumentIcon = (documentType: string) => {
  if (!documentType) return faFileAlt;
  const lowerDocType = documentType.toLowerCase();
  if (/medic(al|ation)|(health|disease)/i.test(lowerDocType)) return faFileMedical;
  if (/history|anamnesis/i.test(lowerDocType)) return faHistory;
  if (/pharmac(y|eutical)|medication|drug|prescription/i.test(lowerDocType)) return faPills;
  if (/lab(oratory)?|clinical|test|specimen/i.test(lowerDocType)) return faFlask;
  if (/physician|doctor|practitioner|clinician|md\b/i.test(lowerDocType)) return faUserMd;
  if (/exam(ination)?|assessment|paramedical/i.test(lowerDocType)) return faStethoscope;
  if (/hospital|clinic|center|facility|institution/i.test(lowerDocType)) return faHospital;
  if (/x-ray|imaging|scan|radiolog(y|ical)|mri|ct scan/i.test(lowerDocType)) return faXRay;
  if (/surg(ery|ical)|procedure|operation/i.test(lowerDocType)) return faProcedures;
  if (/cardio|heart|cardiac|pulse|ekg|ecg/i.test(lowerDocType)) return faHeartbeat;
  if (/pulmonary|lung|respiratory|breath/i.test(lowerDocType)) return faLungs;
  if (/allerg(y|ies)|immunolog(y|ical)/i.test(lowerDocType)) return faAllergies;
  if (/dental|dentist|tooth|teeth|oral/i.test(lowerDocType)) return faTooth;
  if (/eye|vision|ophthalm(ology|ologist)|optical/i.test(lowerDocType)) return faEye;
  if (/insurance|financial|coverage|policy|premium|underwriter/i.test(lowerDocType)) return faFileInvoiceDollar;
  if (/form|(question|survey)(naire)?|assessment/i.test(lowerDocType)) return faClipboardList;
  if (/note|report|summary|record/i.test(lowerDocType)) return faNotesMedical;
  if (/microscop(e|ic)|patholog(y|ical)|cytolog(y|ical)|histolog(y|ical)/i.test(lowerDocType)) return faMicroscope;
  if (/blood|hematolog(y|ical)|serum|plasma|specimen/i.test(lowerDocType)) return faVial;
  if (/emergency|urgent|trauma|ambulance|ems/i.test(lowerDocType)) return faBriefcaseMedical;
  if (/home|property|dwelling|real estate|building|structure/i.test(lowerDocType)) return faHome;
  if (/auto|car|vehicle|motorcycle|truck|collision/i.test(lowerDocType)) return faCar;
  if (/commercial|business property|office|warehouse|retail/i.test(lowerDocType)) return faBuilding;
  if (/umbrella|liability|excess|protection/i.test(lowerDocType)) return faUmbrella;
  if (/flood|water damage|rising water|overflow/i.test(lowerDocType)) return faWater;
  if (/fire|flame|burn|combustion|smoke/i.test(lowerDocType)) return faFire;
  if (/legal|liability|lawsuit|litigation|tort/i.test(lowerDocType)) return faBalanceScale;
  if (/hazard|risk|danger|peril|warning/i.test(lowerDocType)) return faExclamationTriangle;
  if (/fleet|commercial auto|commercial vehicle|transport/i.test(lowerDocType)) return faTruck;
  if (/workers comp|workers' compensation|workplace injury|occupational/i.test(lowerDocType)) return faHardHat;
  if (/industrial|manufacturing|factory|plant|production/i.test(lowerDocType)) return faIndustry;
  if (/storm|hurricane|tornado|hail|weather damage/i.test(lowerDocType)) return faCloudShowersHeavy;
  if (/wind|windstorm|gust|gale/i.test(lowerDocType)) return faWind;
  if (/roadway|highway|traffic|intersection|accident|crash/i.test(lowerDocType)) return faRoad;
  if (/protection|security|safeguard|defense|safety/i.test(lowerDocType)) return faShieldAlt;
  if (/claim|judgment|settlement|adjudication|ruling/i.test(lowerDocType)) return faGavel;
  if (/contract|agreement|terms|certificate/i.test(lowerDocType)) return faFileContract;
  if (/upload/i.test(lowerDocType)) return faUpload;
  return faFileAlt;
};

// Define status mapping for user-friendly display
const STATUS_MAPPING = {
  'CREATED': {
    step: 1,
    phase: 'Job Created',
    details: 'Job has been created and is waiting for document upload to complete...'
  },
  'UPLOAD_PENDING': {
    step: 1,
    phase: 'Upload Pending',
    details: 'Document upload is being finalized and queued for processing...'
  },
  'CLASSIFYING': {
    step: 1,
    phase: 'Classifying Document',
    details: 'The AI is analyzing the document to determine its type and structure for optimal processing...'
  },
  'EXTRACTING': {
    step: 2,
    phase: 'Extracting Information',
    details: 'Advanced AI models are reading through the document and extracting key information and data points...'
  },
  'ANALYZING': {
    step: 3,
    phase: 'Analyzing Content',
    details: 'Our underwriting AI is performing comprehensive analysis to identify risks, discrepancies, and insights...'
  },
  'ACTING': {
    step: 4,
    phase: 'Taking Action',
    details: 'The AI agent is making decisions and taking appropriate actions based on the analysis results...'
  },
  'COMPLETE': {
    step: 5,
    phase: 'Complete',
    details: 'Analysis complete! Review the detailed results and AI recommendations below.'
  },
  'Failed': {
    step: 5,
    phase: 'Failed',
    details: 'An error occurred during processing. Please try again or contact support.'
  },
  'ERROR': {
    step: 5,
    phase: 'Error',
    details: 'An error occurred during processing. Please try again or contact support.'
  }
} as const;

export function JobPage({ jobId }: JobPageProps) {
  const [error, setErrorOriginal] = useState<string | null>(null)
  const [showError, setShowError] = useState(false)
  const navigate = useNavigate();
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null)
  const [currentStep, setCurrentStep] = useState(1)
  const [currentPhase, setCurrentPhase] = useState<string>('Loading Job Details...')
  const [phaseDetails, setPhaseDetails] = useState<string>('Fetching the latest information...')
  const [numPages, setNumPagesState] = useState<number | null>(null)
  const [currentPage, setCurrentPageState] = useState<number>(1)
  const [activeTab, setActiveTab] = useState<TabType>('grouped')
  const [pdfDownloadUrl, setPdfDownloadUrl] = useState<string | null>(null)
  const [isFetchingPdfUrl, setIsFetchingPdfUrl] = useState<boolean>(false);
  const [pdfBlob, setPdfBlobState] = useState<Blob | null>(null)
  const [insuranceType, setInsuranceTypeState] = useState<'life' | 'property_casualty'>('life')
  const [documentType, setDocumentType] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: "Hi! I'm your AI assistant. I've analyzed this document and can help answer any questions you have about it.",
      sender: 'ai',
      timestamp: new Date()
    }
  ])
  const [newMessage, setNewMessage] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [scale, setScale] = useState(1.0)
  const [isAnalysisPanelOpen, setIsAnalysisPanelOpen] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [isHowItWorksOpen, setIsHowItWorksOpen] = useState(false)
  const [pdfWidth, setPdfWidth] = useState<number | undefined>(undefined)

  const [isLoadingJobDetails, setIsLoadingJobDetails] = useState(true);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Agent Action state - ADDED
  const [agentActionData, setAgentActionData] = useState<AgentActionData | null>(null);
  const [showAgentActionPopup, setShowAgentActionPopup] = useState(false);

  // ADDED - Use ref to track current PDF URL to avoid dependency cycles
  const currentPdfUrlRef = useRef<string | null>(null);

  // ADDED - Function to format document type for display
  const formatDocumentType = (docType: string | null): string => {
    if (!docType) return '';
    return docType
      .replace(/_/g, ' ')
      .toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const fetchDocumentUrl = useCallback(async () => {
    if (pdfDownloadUrl) return; // Avoid re-fetching if we already have a URL

    setIsFetchingPdfUrl(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/jobs/${jobId}/document-url`);
      if (!response.ok) {
        throw new Error('Failed to fetch document URL');
      }
      const data = await response.json();
      if (data.documentUrl) {
        setPdfDownloadUrl(data.documentUrl);
      }
    } catch (error) {
      console.error("Error fetching PDF URL:", error);
      // Optionally set an error state here to show in the UI
    } finally {
      setIsFetchingPdfUrl(false);
    }
  }, [jobId, pdfDownloadUrl]); // Added pdfDownloadUrl to dependencies to prevent infinite loops from re-fetching

  const fetchJobDetailsAndUpdateState = useCallback(async (isPolling = false) => {
    if (!isPolling) {
      setIsLoadingJobDetails(true);
      setCurrentPhase('Loading Job Details...');
      setPhaseDetails('Fetching the latest information...');
    } else {
      console.log("Polling job status...");
    }

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/jobs/${jobId}`, {
      });

      if (!response.ok) {
        const errorData: { detail?: string, message?: string, error?: string } = await response.json().catch(() => ({}));
        const errorMsg = errorData.detail || errorData.message || errorData.error || `Failed to fetch job details: ${response.status}`;
        throw new Error(errorMsg);
      }

      const jobApiData: JobApiResponse = await response.json();

      const pageAnalysisTransformed: Record<string, PageData> = {};

      // First try to use directly provided extractedData
      if (jobApiData.extractedData) {
        try {
          console.log("Using directly provided extractedData", jobApiData.extractedData);
          for (const key in jobApiData.extractedData) {
            if (Object.prototype.hasOwnProperty.call(jobApiData.extractedData, key)) {
              const value = jobApiData.extractedData[key];
              // Create a human-readable title from the key
              const title = key.replace(/_/g, ' ');
              pageAnalysisTransformed[key] = {
                page_type: title, // This will be the group title
                content: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``, // Markdown for JSON code block
                // numeric_page_num_for_nav can be omitted or set to a default like 1 if not applicable
              };
            }
          }
          console.log("Populated page_analysis from extractedData");
        } catch (directError) {
          console.error("Error processing extractedData:", directError);
        }
      } 
      // Then fall back to extractedDataJsonStr if needed
      else if (jobApiData.extractedDataJsonStr) {
        try {
          const parsedExtraction = JSON.parse(jobApiData.extractedDataJsonStr);
          if (typeof parsedExtraction === 'object' && parsedExtraction !== null) {
            for (const key in parsedExtraction) {
              if (Object.prototype.hasOwnProperty.call(parsedExtraction, key)) {
                const value = parsedExtraction[key];
                // Create a human-readable title from the key
                const title = key.replace(/_/g, ' ').replace(/\\b\\w/g, char => char.toUpperCase());
                pageAnalysisTransformed[key] = {
                  page_type: title, // This will be the group title
                  content: `\`\`\`json\\n${JSON.stringify(value, null, 2)}\\n\`\`\``, // Markdown for JSON code block
                  // numeric_page_num_for_nav can be omitted or set to a default like 1 if not applicable
                };
              }
            }
            console.log("Populated page_analysis from extractedDataJsonStr");
          } else {
            console.warn("extractedDataJsonStr did not parse to a valid object.");
            // Optionally, could put the raw string into a single PageData entry here as a fallback
          }
        } catch (parseError) {
          console.error("Error parsing extractedDataJsonStr:", parseError);
          // Fallback: put the raw string into a single PageData entry
          pageAnalysisTransformed["raw_extracted_data"] = {
            page_type: "Raw Extracted Data (Parse Error)",
            content: `\`\`\`text\\n${jobApiData.extractedDataJsonStr}\\n\`\`\``,
          };
        }
      } else if (jobApiData.extracted_data?.sections && jobApiData.extracted_data.sections.length > 0) {
        // Fallback to existing sections logic if extractedDataJsonStr is not present
        jobApiData.extracted_data.sections.forEach((section, index) => {
          const key = section.title || `section-${index}`;
          let content = section.content || "";
          if (section.findings && section.findings.length > 0) {
            content += "\n\n**Findings:**\n" + section.findings.map(f => `- ${f.type}: ${f.description} (Severity: ${f.severity || 'N/A'})${f.page_references && f.page_references.length > 0 ? ` (Pages: ${f.page_references.join(', ')})` : ''}`).join("\n");
          }
          pageAnalysisTransformed[key] = {
            page_type: section.title || "Section",
            content: content,
            numeric_page_num_for_nav: section.start_page_number
          };
        });
        console.log("Populated page_analysis from extracted_data.sections (fallback)");
      } else {
        console.log("No data available to populate page_analysis for Document Analysis tab.");
        // Optionally, add a placeholder if both are empty
        pageAnalysisTransformed["no_data"] = {
            page_type: "Document Analysis",
            content: "No detailed extraction data available for display."
        };
      }

      // Transform underwriter analysis data
      let underwriterAnalysisTransformed: UnderwriterAnalysis = {
        RISK_ASSESSMENT: "Not available.",
        DISCREPANCIES: "Not available.",
        FINAL_RECOMMENDATION: "Not available.",
      };
      
      // First try to use directly provided analysisOutput
      if (jobApiData.analysisOutput) {
        console.log("Using directly provided analysisOutput", jobApiData.analysisOutput);
        try {
          // Transform identified_risks array to markdown string
          const riskAssessment = jobApiData.analysisOutput.identified_risks && Array.isArray(jobApiData.analysisOutput.identified_risks)
            ? jobApiData.analysisOutput.identified_risks.map((risk: any) => {
                const pageRefs = risk.page_references && Array.isArray(risk.page_references) && risk.page_references.length > 0
                  ? ` ([${risk.page_references.join(', ')}](/page/${risk.page_references[0]}))`
                  : '';
                return `- **${risk.severity || 'N/A'}**: ${risk.risk_description}${pageRefs}`;
              }).join('\n')
            : "No risks identified.";

          // Transform discrepancies array to markdown string  
          const discrepancies = jobApiData.analysisOutput.discrepancies && Array.isArray(jobApiData.analysisOutput.discrepancies)
            ? jobApiData.analysisOutput.discrepancies.map((disc: any) => {
                const pageRefs = disc.page_references && Array.isArray(disc.page_references) && disc.page_references.length > 0
                  ? ` ([${disc.page_references.join(', ')}](/page/${disc.page_references[0]}))`
                  : '';
                return `- **${disc.discrepancy_description}**: ${disc.details}${pageRefs}`;
              }).join('\n')
            : "No discrepancies found.";

          underwriterAnalysisTransformed = {
            RISK_ASSESSMENT: riskAssessment,
            DISCREPANCIES: discrepancies,
            MEDICAL_TIMELINE: jobApiData.insurance_type === 'life' ? (jobApiData.analysisOutput.medical_timeline || "Not available.") : undefined,
            PROPERTY_ASSESSMENT: jobApiData.insurance_type === 'property_casualty' ? (jobApiData.analysisOutput.property_assessment || "Not available.") : undefined,
            FINAL_RECOMMENDATION: jobApiData.analysisOutput.final_recommendation || "Not available.",
          };
          console.log("Populated underwriter analysis from analysisOutput");
        } catch (analysisError) {
          console.error("Error processing analysisOutput:", analysisError);
          // Fall through to next option
        }
      }
      // Then try to parse the analysisOutputJsonStr field
      else if (jobApiData.analysisOutputJsonStr) {
        try {
          const parsedAnalysis = JSON.parse(jobApiData.analysisOutputJsonStr);
          console.log("Using analysisOutputJsonStr for underwriter analysis");
          
          // Transform identified_risks array to markdown string
          const riskAssessment = parsedAnalysis.identified_risks && Array.isArray(parsedAnalysis.identified_risks)
            ? parsedAnalysis.identified_risks.map((risk: any) => {
                const pageRefs = risk.page_references && Array.isArray(risk.page_references) && risk.page_references.length > 0
                  ? ` ([${risk.page_references.join(', ')}](/page/${risk.page_references[0]}))`
                  : '';
                return `- **${risk.severity || 'N/A'}**: ${risk.risk_description}${pageRefs}`;
              }).join('\n')
            : "No risks identified.";

          // Transform discrepancies array to markdown string  
          const discrepancies = parsedAnalysis.discrepancies && Array.isArray(parsedAnalysis.discrepancies)
            ? parsedAnalysis.discrepancies.map((disc: any) => {
                const pageRefs = disc.page_references && Array.isArray(disc.page_references) && disc.page_references.length > 0
                  ? ` ([${disc.page_references.join(', ')}](/page/${disc.page_references[0]}))`
                  : '';
                return `- **${disc.discrepancy_description}**: ${disc.details}${pageRefs}`;
              }).join('\n')
            : "No discrepancies found.";

          underwriterAnalysisTransformed = {
            RISK_ASSESSMENT: riskAssessment,
            DISCREPANCIES: discrepancies,
            MEDICAL_TIMELINE: jobApiData.insurance_type === 'life' ? (parsedAnalysis.medical_timeline || "Not available.") : undefined,
            PROPERTY_ASSESSMENT: jobApiData.insurance_type === 'property_casualty' ? (parsedAnalysis.property_assessment || "Not available.") : undefined,
            FINAL_RECOMMENDATION: parsedAnalysis.final_recommendation || "Not available.",
          };
        } catch (parseError) {
          console.error("Error parsing analysisOutputJsonStr:", parseError);
          // Fall through to legacy approach
          underwriterAnalysisTransformed = {
            RISK_ASSESSMENT: jobApiData.identified_risks 
              ? jobApiData.identified_risks.map(r => `- ${r.description} (Severity: ${r.severity || 'N/A'})${r.page_references && r.page_references.length > 0 ? ` (Pages: ${r.page_references.join(', ')})` : ''}`).join("\n") 
              : "Not available.",
            DISCREPANCIES: jobApiData.discrepancies_summary || "Not available.",
            MEDICAL_TIMELINE: jobApiData.insurance_type === 'life' ? (jobApiData.medical_timeline_summary || "Not available.") : undefined,
            PROPERTY_ASSESSMENT: jobApiData.insurance_type === 'property_casualty' ? (jobApiData.property_assessment_summary || "Not available.") : undefined,
            FINAL_RECOMMENDATION: jobApiData.underwriting_recommendation || "Not available.",
          };
        }
      } else {
        // Fallback to legacy fields if analysisOutputJsonStr is not available
        console.log("Using legacy fields for underwriter analysis");
        underwriterAnalysisTransformed = {
          RISK_ASSESSMENT: jobApiData.identified_risks 
            ? jobApiData.identified_risks.map(r => `- ${r.description} (Severity: ${r.severity || 'N/A'})${r.page_references && r.page_references.length > 0 ? ` (Pages: ${r.page_references.join(', ')})` : ''}`).join("\n") 
            : "Not available.",
          DISCREPANCIES: jobApiData.discrepancies_summary || "Not available.",
          MEDICAL_TIMELINE: jobApiData.insurance_type === 'life' ? (jobApiData.medical_timeline_summary || "Not available.") : undefined,
          PROPERTY_ASSESSMENT: jobApiData.insurance_type === 'property_casualty' ? (jobApiData.property_assessment_summary || "Not available.") : undefined,
          FINAL_RECOMMENDATION: jobApiData.underwriting_recommendation || "Not available.",
        };
      }
      
      const newAnalysisData: AnalysisData = {
        job_id: jobApiData.jobId,
        timestamp: jobApiData.timestamp,
        filename: jobApiData.originalFilename,
        page_analysis: pageAnalysisTransformed,
        underwriter_analysis: underwriterAnalysisTransformed,
        status: jobApiData.status,
        insurance_type: jobApiData.insurance_type,
      };
      setAnalysisData(newAnalysisData);

      // fetchDocumentUrl(); // Always fetch the document URL after job data is received
      // REMOVED from here to decouple from polling loop

      // ADDED - Store document type from API response
      if (jobApiData.documentType) {
        setDocumentType(jobApiData.documentType);
      }

      // Parse and handle agent action data
      // First try to use directly provided agentActionOutput
      if (jobApiData.agentActionOutput) {
        console.log("Found direct agentActionOutput:", jobApiData.agentActionOutput);
        
        // Only show popup if we don't already have this agent action data (to avoid showing on every poll)
        if (!agentActionData || JSON.stringify(agentActionData) !== JSON.stringify(jobApiData.agentActionOutput)) {
          setAgentActionData(jobApiData.agentActionOutput);
          setShowAgentActionPopup(true);
          console.log("Agent action popup will be shown from direct agentActionOutput");
        }
      }
      // Then fall back to parsing agentActionOutputJsonStr if needed
      else if (jobApiData.agentActionOutputJsonStr) {
        try {
          const parsedAgentAction: AgentActionData = JSON.parse(jobApiData.agentActionOutputJsonStr);
          console.log("Parsed agent action data from JSON string:", parsedAgentAction);
          
          // Only show popup if we don't already have this agent action data (to avoid showing on every poll)
          if (!agentActionData || JSON.stringify(agentActionData) !== JSON.stringify(parsedAgentAction)) {
            setAgentActionData(parsedAgentAction);
            setShowAgentActionPopup(true);
            console.log("Agent action popup will be shown from parsed agentActionOutputJsonStr");
          }
        } catch (parseError) {
          console.error("Error parsing agentActionOutputJsonStr:", parseError);
        }
      }

      setInsuranceTypeState(jobApiData.insurance_type || 'life');
      
      // Use the new status mapping for cleaner status handling
      const statusKey = jobApiData.status as keyof typeof STATUS_MAPPING;
      const statusInfo = STATUS_MAPPING[statusKey];

      if (statusInfo) {
        setCurrentStep(statusInfo.step);
        setCurrentPhase(statusInfo.phase);
        setPhaseDetails(statusInfo.details);

        // Handle polling logic based on status
        if (statusKey === 'COMPLETE') {
          // Stop polling when complete
          if (pollingIntervalRef.current) {
            console.log("Job completed - stopping polling");
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
        } else if (statusKey === 'Failed' || statusKey === 'ERROR') {
          // Stop polling and show error
          setErrorOriginal(jobApiData.error_message || 'Job processing failed.');
          setShowError(true);
          if (pollingIntervalRef.current) {
            console.log("Job failed - stopping polling");
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
        } else {
          // Continue polling for in-progress statuses
          if (!pollingIntervalRef.current) {
            console.log(`Job status is ${statusKey} - starting polling every 5 seconds`);
            pollingIntervalRef.current = setInterval(() => fetchJobDetailsAndUpdateState(true), 5000);
          }
        }
      } else {
        // Fallback for unknown statuses
        console.warn(`Unknown status received: ${jobApiData.status}`);
        setCurrentStep(1);
        setCurrentPhase('Processing');
        setPhaseDetails(`Status: ${jobApiData.status}`);
        
        // Continue polling for unknown statuses (assume they're in-progress)
        if (!pollingIntervalRef.current) {
          console.log(`Unknown status ${jobApiData.status} - starting polling every 5 seconds`);
          pollingIntervalRef.current = setInterval(() => fetchJobDetailsAndUpdateState(true), 5000);
        }
      }

      setErrorOriginal(null);
      setShowError(false);

    } catch (err) {
      console.error("Error fetching job details:", err);
      const errorMsg = err instanceof Error ? err.message : "An unknown error occurred.";
      setErrorOriginal(errorMsg);
      setShowError(true);
      setCurrentPhase('Error');
      setPhaseDetails(errorMsg.substring(0,100));
       if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
    } finally {
      if (!isPolling) {
        setIsLoadingJobDetails(false);
      }
    }
  }, [jobId]);

  useEffect(() => {
    
    fetchJobDetailsAndUpdateState();

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      // No specific cleanup needed for direct S3 presigned URLs as they are not blob URLs
      // The sessionStorage item will expire or be overwritten naturally.
    };
  }, [jobId, fetchJobDetailsAndUpdateState]);

  // This effect will run once when analysisData is first populated,
  // to fetch the document URL without being in the polling-related effect.
  useEffect(() => {
    if (analysisData && !pdfDownloadUrl) {
      fetchDocumentUrl();
    }
  }, [analysisData, pdfDownloadUrl, fetchDocumentUrl]);

  useEffect(() => {
    const calculatePdfWidth = () => {
      const containerWidth = isAnalysisPanelOpen ? window.innerWidth * 0.45 : window.innerWidth * 0.9;
      const maxWidth = 1000;
      const width = Math.min(containerWidth, maxWidth);
      setPdfWidth(width);
    };
    calculatePdfWidth();
    window.addEventListener('resize', calculatePdfWidth);
    return () => window.removeEventListener('resize', calculatePdfWidth);
  }, [isAnalysisPanelOpen]);

  useEffect(() => {
    if (analysisData?.insurance_type) {
      const type = analysisData.insurance_type;
      let greeting = "Hi! I'm your AI assistant. I've analyzed this document and can help answer any questions you have about it.";
      if (type === 'property_casualty') {
        greeting = "Hello! I'm your Property & Casualty insurance underwriting assistant. I've analyzed this document and can help with questions about property details, risk factors, and coverage considerations.";
      } else if (type === 'life') {
        greeting = "Hello! I'm your Life Insurance underwriting assistant. I've analyzed this document and can help with questions about medical history, risk factors, and policy considerations.";
      }
      setMessages([{ id: '1', text: greeting, sender: 'ai', timestamp: new Date() }]);
    } else if (!isLoadingJobDetails && !analysisData?.insurance_type) {
        setMessages([{ id: '1', text: "Hi! I'm your AI assistant. How can I help with this document?", sender: 'ai', timestamp: new Date() }]);
    }
  }, [analysisData?.insurance_type, isLoadingJobDetails]);

  const onDocumentLoadSuccess = ({ numPages: loadedNumPages }: { numPages: number }) => {
    setNumPagesState(loadedNumPages);
  };

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const href = e.currentTarget.getAttribute('href');
    if (href?.startsWith('/page/')) {
      const pageNumStr = href.split('/').pop();
      if (pageNumStr) {
        const page = parseInt(pageNumStr);
        if (!isNaN(page) && page > 0 && page <= (numPages || 0)) {
          setCurrentPageState(page);
        }
      }
    }
  };
  
  const renderGroupedAnalysis = () => {
    const localAnalysisData = analysisData;

    if (!localAnalysisData?.page_analysis || Object.keys(localAnalysisData.page_analysis).length === 0) {
      if (isLoadingJobDetails || currentPhase !== 'Complete') return <p>Loading document analysis sections...</p>;
      return <p>No document page analysis data available.</p>;
    }

    const pagesToRender = Object.entries(localAnalysisData.page_analysis).map(([pageNumKey, pageDataVal]) => ({
      pageNumKey,
      pageType: pageDataVal.page_type,
      content: pageDataVal.content,
      numericPageNum: pageDataVal.numeric_page_num_for_nav || parseInt(pageNumKey.replace(/[^0-9]/g, '')) || 1
    }));
    
    const groups: Record<string, typeof pagesToRender> = {};
    pagesToRender.forEach(page => {
      const docType = page.pageType.split('-')[0].trim() || "Uncategorized";
      if (!groups[docType]) groups[docType] = [];
      groups[docType].push(page);
    });

    return (
      <div className="grouped-analysis">
        {Object.entries(groups).map(([groupTitle, groupPages]) => {
          const sortedPages = [...groupPages].sort((a, b) => a.numericPageNum - b.numericPageNum);
          const firstPageInGroup = sortedPages[0]?.numericPageNum;
          return (
            <div key={groupTitle} className={`analysis-group`}>
              <button 
                className={`group-header ${expandedGroups.has(groupTitle) ? 'expanded' : ''}`}
                onClick={() => {
                  const updatedGroups = new Set(expandedGroups);
                  if (updatedGroups.has(groupTitle)) updatedGroups.delete(groupTitle);
                  else updatedGroups.add(groupTitle);
                  setExpandedGroups(updatedGroups);
                  if (firstPageInGroup) setCurrentPageState(firstPageInGroup);
                }}
              >
                <div className="group-title">
                  <FontAwesomeIcon icon={getDocumentIcon(groupTitle)} />
                  Page {groupTitle} 
                </div>
                <FontAwesomeIcon icon={expandedGroups.has(groupTitle) ? faChevronLeft : faChevronRight} />
              </button>
              {expandedGroups.has(groupTitle) && (
                <div className="group-content">
                  {groupPages.map(page => (
                    <div 
                      key={page.pageNumKey}
                      className={`page-card ${currentPage === page.numericPageNum ? 'active' : ''}`}
                      onClick={() => setCurrentPageState(page.numericPageNum)}
                    >
                      <div className="page-header">
                        <div className="page-number">{page.pageType}</div>
                      </div>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={customMarkdownComponentsFromStyles}>
                        {page.content}
                      </ReactMarkdown>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderUnderwriterAnalysis = () => {
    const localAnalysisData = analysisData;
    if (!localAnalysisData?.underwriter_analysis) {
      if (isLoadingJobDetails || currentPhase !== 'Complete') return <p>Loading underwriter analysis...</p>;
      return <p>No underwriter analysis available.</p>;
    }
    
    interface SectionConfigItem {
      key: keyof UnderwriterAnalysis;
      icon: any; // Ideally FontAwesomeIconDefinition, but 'any' for brevity here
      title: string; // Explicit title for display
    }

    const sectionConfig: SectionConfigItem[] = localAnalysisData.insurance_type === 'property_casualty' 
      ? [
          { key: 'RISK_ASSESSMENT', icon: faClipboardCheck, title: 'Risk Assessment' }, 
          { key: 'DISCREPANCIES', icon: faClipboardList, title: 'Discrepancies' }, 
          { key: 'PROPERTY_ASSESSMENT', icon: faHome, title: 'Property Assessment' }, 
          { key: 'FINAL_RECOMMENDATION', icon: faCheckCircle, title: 'Final Recommendation' } 
        ]
      : [
          { key: 'RISK_ASSESSMENT', icon: faBriefcaseMedical, title: 'Risk Assessment' }, 
          { key: 'DISCREPANCIES', icon: faClipboardList, title: 'Discrepancies' }, 
          { key: 'MEDICAL_TIMELINE', icon: faHistory, title: 'Medical Timeline' }, 
          { key: 'FINAL_RECOMMENDATION', icon: faCheckCircle, title: 'Final Recommendation' } 
        ];
    
    return (
      <div className="underwriter-analysis">
        {sectionConfig.map((item) => {
          // item.key is now correctly typed as keyof UnderwriterAnalysis
          const content = localAnalysisData.underwriter_analysis[item.key];
          // Only render the section if its key is relevant for the insurance type AND content exists
          if (!content || content === "Not available.") return null;
          // For optional fields, explicitly check if they should be rendered based on insurance type
          if (item.key === 'MEDICAL_TIMELINE' && localAnalysisData.insurance_type !== 'life') return null;
          if (item.key === 'PROPERTY_ASSESSMENT' && localAnalysisData.insurance_type !== 'property_casualty') return null;

          return (
            <div key={item.key} className="analysis-section">
              <h3><FontAwesomeIcon icon={item.icon} /> {item.title}</h3>
              <div className="analysis-content">
                 <ReactMarkdown remarkPlugins={[remarkGfm]} components={{...customMarkdownComponentsFromStyles, a: ({href, children}) => (<PageReference pageNum={href?.replace("/page/","") || "1"} text={children as string}/>) }}>{content}</ReactMarkdown>
              </div>
            </div>
          );
        })}
      </div>
    );
  };
  
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault(); if (!newMessage.trim()) return;
    const userMessage: Message = { id: Date.now().toString(), text: newMessage.trim(), sender: 'user', timestamp: new Date()};
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages); setNewMessage(''); setIsTyping(true);
    try {
      const messagesToSend = updatedMessages.filter(msg => msg.id !== '1');
      const response = await fetch(`${import.meta.env.VITE_API_URL}/chat/${jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messagesToSend })
      });
      if (!response.ok) throw new Error('AI chat error');
      const data = await response.json();
      const aiMessage: Message = { id: (Date.now() + 1).toString(), text: data.response, sender: 'ai', timestamp: new Date()};
      setMessages(prev => [...prev, aiMessage]);
    } catch (err) {
      setMessages(prev => [...prev, {id: (Date.now() + 1).toString(), text: "Chat error. Please try again.", sender: 'ai', timestamp: new Date()}]);
    } finally { setIsTyping(false); }
  };

  if (isLoadingJobDetails && !analysisData) {
    return (
      <div className="container job-page-override">
        <div className="progress-container" style={{textAlign: 'center', padding: '50px'}}>
        <FontAwesomeIcon icon={faSpinner} spin size="3x" />
            <h1>Loading Job Details...</h1>
            <p>{phaseDetails}</p>
        </div>
      </div>
    );
  }

  if (error && showError) {
    return (
      <div className="container job-page-override">
        <div className="error-message" style={{textAlign: 'center', padding: '50px'}}>
        <FontAwesomeIcon icon={faTimesCircle} size="3x" color="red" />
            <h1>An Error Occurred</h1>
        <p>{error}</p>
            <button onClick={() => { setErrorOriginal(null); setShowError(false); fetchJobDetailsAndUpdateState(); }} className="upload-button">
                Retry
        </button>
        </div>
      </div>
    );
  }

  return (
    <PageContext.Provider value={[currentPage, setCurrentPageState]}>
      <NumPagesContext.Provider value={[numPages, setNumPagesState]}>
        <div className="container job-page-override">
          <div className="page-navigation">
            <button onClick={() => navigate('/')} className="nav-button">
              <FontAwesomeIcon icon={faUpload} /> Upload New
            </button>
            <button className="how-it-works-button" onClick={() => setIsHowItWorksOpen(true)}>
              <FontAwesomeIcon icon={faInfoCircle} /> How It Works
            </button>
          </div>
          
          <div className="job-header">
            <div className="job-title-section">
              <h1>{analysisData?.filename || `Processing Job ${jobId.slice(0, 8)}...`}</h1>
            </div>
            <div className="header-controls">
              {documentType && (
                <div className="document-classification">
                  <FontAwesomeIcon icon={getDocumentIcon(documentType)} className="doc-icon" />
                  <span className="doc-type-label">{formatDocumentType(documentType)}</span>
                </div>
              )}
              {analysisData && (
                <div className="insurance-type-badge">
                  {analysisData.insurance_type === 'property_casualty' ? (
                    <span className="badge p-and-c"><FontAwesomeIcon icon={faHome} /> Property & Casualty</span>
                  ) : (
                    <span className="badge life"><FontAwesomeIcon icon={faBriefcaseMedical} /> Life Insurance</span>
            )}
                </div>
              )}
            </div>
          </div>

          {/* Agent Action Popup - ADDED */}
          {showAgentActionPopup && agentActionData && (
            <div className="agent-action-popup">
              <div className="agent-action-content">
                <button 
                  className="agent-action-close" 
                  onClick={() => setShowAgentActionPopup(false)}
                  aria-label="Close notification"
                >
                  <FontAwesomeIcon icon={faTimes} />
                </button>
                <div className="agent-action-header">
                  <div className="agent-action-icon">
                    <FontAwesomeIcon icon={faRobot} />
                  </div>
                  <div className="agent-action-title">
                    <h3>🤖 AI Agent Action Complete</h3>
                    <p>Our AI agent has processed your document and taken action</p>
                  </div>
                </div>
                <div className="agent-action-body">
                  <div className="agent-action-summary">
                    <FontAwesomeIcon icon={faEnvelope} className="email-icon" />
                    <div className="action-text">
                      {agentActionData.agent_action_confirmation.includes('email') ? (
                        <span><strong>Email Sent!</strong> The agent has sent an email based on the document analysis.</span>
                      ) : agentActionData.agent_action_confirmation.includes('ineligible') ? (
                        <span><strong>Application Reviewed:</strong> The agent has determined this application requires review.</span>
                      ) : (
                        <span><strong>Action Taken:</strong> The agent has completed processing this document.</span>
                      )}
                    </div>
                  </div>
                  <details className="agent-action-details">
                    <summary>View Details</summary>
                    <div className="action-confirmation">
                      <ReactMarkdown>{agentActionData.agent_action_confirmation}</ReactMarkdown>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          )}

          {currentPhase !== 'Complete' && currentPhase !== 'Failed' && currentPhase !== 'Error' && (
            <div className="progress-container">
              <div className="progress-steps">
                <div className={`progress-dot ${currentStep >= 1 ? 'active' : ''}`}>
                  {currentStep >= 1 && <FontAwesomeIcon icon={currentPhase === 'Upload Pending' ? faHourglassHalf : currentPhase === 'Classifying Document' ? faDatabase : faUpload} className="progress-icon" spin={currentPhase === 'Upload Pending' || currentPhase === 'Classifying Document'} />}
                </div>
                <div className={`progress-line ${currentStep >= 2 ? 'active' : ''}`} />
                <div className={`progress-dot ${currentStep >= 2 ? 'active' : ''}`}>
                  {currentStep >= 2 && <FontAwesomeIcon icon={currentPhase === 'Extracting Information' ? faSpinner : faFileAlt} className="progress-icon" spin={currentPhase === 'Extracting Information'} />}
                </div>
                <div className={`progress-line ${currentStep >= 3 ? 'active' : ''}`} />
                <div className={`progress-dot ${currentStep >= 3 ? 'active' : ''}`}>
                  {currentStep >= 3 && <FontAwesomeIcon icon={currentPhase === 'Analyzing Content' ? faSpinner : faClipboardCheck} className="progress-icon" spin={currentPhase === 'Analyzing Content'} />}
                </div>
                <div className={`progress-line ${currentStep >= 4 ? 'active' : ''}`} />
                <div className={`progress-dot ${currentStep >= 4 ? 'active' : ''}`}>
                  {currentStep >= 4 && <FontAwesomeIcon icon={currentPhase === 'Taking Action' ? faSpinner : faRobot} className="progress-icon" spin={currentPhase === 'Taking Action'} />}
                </div>
                <div className={`progress-line ${currentStep >= 5 ? 'active' : ''}`} />
                <div className={`progress-dot ${currentStep >= 5 ? 'active' : ''}`}>
                  {currentStep >= 5 && <FontAwesomeIcon icon={faCheckCircle} className="progress-icon" />}
                </div>
              </div>
              <div className="progress-label">{currentPhase}</div>
              <div className="progress-details">{phaseDetails}</div>
            </div>
          )}
          
          {isHowItWorksOpen && <HowItWorksDrawer onClose={() => setIsHowItWorksOpen(false)} />}

          {(analysisData) && (
            <div style={{ position: 'relative', flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
              <Split 
                className="split-view"
                sizes={isAnalysisPanelOpen ? [50, 50] : [100, 0]}
                minSize={isAnalysisPanelOpen ? [300,300] : [0,0] }
                gutterSize={10}
                direction="horizontal"
                style={{ display: 'flex', flexGrow: 1, height: 'calc(100vh - 200px)' }}
              >
                <div className={`pdf-viewer ${!isAnalysisPanelOpen ? 'expanded' : ''}`}>
          {isFetchingPdfUrl && (
            <div className="loading-overlay">
              <FontAwesomeIcon icon={faSpinner} spin size="3x" />
              <p>Loading Document...</p>
            </div>
          )}
          {!pdfDownloadUrl && !isFetchingPdfUrl && (
            <div className="pdf-placeholder">
              <FontAwesomeIcon icon={faFileAlt} size="3x" className="placeholder-icon" />
              <p className="placeholder-text">PDF document will appear here once analysis is complete.</p>
            </div>
          )}
          {pdfDownloadUrl && (
                    <>
                      <div className="pdf-controls pdf-controls-absolute">
                          <button onClick={() => setCurrentPageState(p => Math.max(1, p - 1))} disabled={currentPage <= 1}>
                              <FontAwesomeIcon icon={faChevronLeft} /> Previous
                          </button>
                          <span>{`Page ${currentPage} of ${numPages || '--'}`}</span>
                          <button onClick={() => setCurrentPageState(p => Math.min(numPages || p, p + 1))} disabled={currentPage >= (numPages || 1)}>
                              Next <FontAwesomeIcon icon={faChevronRight} />
                          </button>
                          <div className="zoom-controls">
                              <button onClick={() => setScale(s => Math.max(0.5, s - 0.1))} disabled={scale <= 0.5}>
                                  <FontAwesomeIcon icon={faSearchMinus} />
                              </button>
                              <span className="zoom-level">{`${Math.round(scale * 100)}%`}</span>
                              <button onClick={() => setScale(s => Math.min(2.0, s + 0.1))} disabled={scale >= 2.0}>
                                  <FontAwesomeIcon icon={faSearchPlus} />
                              </button>
                          </div>
                           <button onClick={() => fetchJobDetailsAndUpdateState()} title="Refresh Data"><FontAwesomeIcon icon={faSyncAlt} /></button>
                           {pdfDownloadUrl && (<button onClick={() => { if (pdfBlob) { const url = URL.createObjectURL(pdfBlob); window.open(url)?.print(); } else if (pdfDownloadUrl) { window.open(pdfDownloadUrl)?.print(); } }} title="Print PDF"><FontAwesomeIcon icon={faPrint} /></button>)}
                      </div>
              <Document
                file={pdfDownloadUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                        loading={<div className="pdf-loading">Loading PDF...</div>}
                        error={<div className="pdf-loading">Error loading PDF.</div>}
              >
                        <div className="pdf-container">
                           <Page 
                              pageNumber={currentPage} 
                              renderTextLayer={false}
                              renderAnnotationLayer={false}
                              scale={scale}
                              width={pdfWidth}
                            />
                        </div>
              </Document>
                    </>
          )}
        </div>

                <div className={`analysis-viewer ${!isAnalysisPanelOpen ? 'collapsed' : ''}`}>
                  <div className="tabs">
                    <button className={`tab-button ${activeTab === 'grouped' ? 'active' : ''}`} onClick={() => setActiveTab('grouped')}>
                      <FontAwesomeIcon icon={faList} /> Document Analysis
            </button>
                    <button className={`tab-button ${activeTab === 'underwriter' ? 'active' : ''}`} onClick={() => setActiveTab('underwriter')}>
                      <FontAwesomeIcon icon={faGavel} /> Underwriter Analysis
            </button>
                    <button className={`tab-button ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>
                      <FontAwesomeIcon icon={faComments} /> Chat Assistant
                      {analysisData?.insurance_type && (
                        <span className={`chat-type-indicator ${analysisData.insurance_type === 'property_casualty' ? 'p-and-c' : 'life'}`}>
                          {analysisData.insurance_type === 'property_casualty' ? 'P&C' : 'Life'}
                        </span>
                      )}
            </button>
                  </div>
                  <div className="tab-content">
                    {activeTab === 'grouped' && renderGroupedAnalysis()}
                    {activeTab === 'underwriter' && renderUnderwriterAnalysis()}
                    {activeTab === 'chat' && (
                      <div className="chat-interface">
                        <div className="chat-messages">
                          {messages.map(message => (
                            <div key={message.id} className={`chat-message ${message.sender}`}>
                              <div className={`chat-avatar ${message.sender}`}>{message.sender === 'user' ? 'U' : 'AI'}</div>
                              <div className="chat-bubble">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{...customMarkdownComponentsFromStyles, a: ({href, children}) => (<PageReference pageNum={href?.replace("/page/","") || "1"} text={children as string}/>) }}>{message.text}</ReactMarkdown>
                              </div>
                    </div>
                ))}
                          {isTyping && (<div className="chat-message ai"><div className="chat-avatar ai">AI</div><div className="chat-bubble">Typing...</div></div>)}
                        </div>
                        <form className="chat-input-form" onSubmit={handleSendMessage}>
                          <textarea className="chat-input" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} placeholder="Ask me anything about the document..." rows={1} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(e);}}}/>
                          <button type="submit" className="chat-send" disabled={!newMessage.trim() || isTyping}>Send</button>
                        </form>
                    </div>
                )}
            </div>
          </div>
              </Split>
              <button className="analysis-toggle" onClick={() => setIsAnalysisPanelOpen(!isAnalysisPanelOpen)} aria-label={isAnalysisPanelOpen ? "Hide Analysis" : "Show Analysis"}>
                <FontAwesomeIcon icon={isAnalysisPanelOpen ? faChevronLeft : faChevronRight} />
              </button>
            </div>
          )}
        </div>
      </NumPagesContext.Provider>
    </PageContext.Provider>
  )
} 