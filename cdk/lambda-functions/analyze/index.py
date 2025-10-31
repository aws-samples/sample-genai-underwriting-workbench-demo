import json
import boto3
import os
import re
import traceback
from botocore.config import Config
from botocore.exceptions import ClientError
from datetime import datetime, timezone # ADDED
from strands import Agent, tool
from strands.models import BedrockModel


# Configure retry settings for Bedrock client only
bedrock_retry_config = Config(
    retries={
        'max_attempts': 10,
        'mode': 'adaptive'
    },
    max_pool_connections=50
)

# Initialize AWS clients outside the handler for reuse
bedrock_runtime = boto3.client(service_name='bedrock-runtime', config=bedrock_retry_config)
kb_runtime = boto3.client('bedrock-agent-runtime')
dynamodb_client = boto3.client('dynamodb')
s3_client = boto3.client('s3')
# Environment variables
DB_TABLE = os.environ.get('JOBS_TABLE_NAME')
EXTRACTION_BUCKET = os.environ.get('EXTRACTION_BUCKET')
KNOWLEDGE_BASE_ID = os.environ.get('KNOWLEDGE_BASE_ID')
DETECTION_TOP_K = int(os.environ.get('DETECTION_TOP_K', '3'))
TRACE_BUCKET = os.environ.get('TRACE_BUCKET')

# Reuse a single S3 client for fetching chunk files
def get_s3_client():
    return boto3.client('s3')


def validate_analysis_data(data, schema):
    """
    Validates the structure of the data against the schema.
    Checks for presence of top-level keys and basic structure of nested lists/dicts.
    Args:
        data (dict): The data to validate.
        schema (dict): The schema to validate against.
    Returns:
        bool: True if validation passes basic checks, False otherwise.
    """
    print("[validate_analysis_data] Starting validation")
    if not isinstance(data, dict):
        print("[validate_analysis_data] Error: Overall data is not a dictionary.")
        return False
    is_valid = True
    for key, schema_val in schema.items():
        if key not in data:
            print(f"[validate_analysis_data] Warning: Missing top-level key '{key}' in data.")
            data[key] = [] if isinstance(schema_val, list) else {} if isinstance(schema_val, dict) else "N/A"
            is_valid = False
        elif isinstance(schema_val, list) and not isinstance(data[key], list):
            print(f"[validate_analysis_data] Error: Key '{key}' should be list but is {type(data[key])}.")
            is_valid = False
    print(f"[validate_analysis_data] Validation {'passed' if is_valid else 'had issues'}")
    return is_valid


def _write_trace(job_id: str, trace_obj: dict) -> str | None:
    if not (TRACE_BUCKET and job_id):
        return None
    key = f"analysis-traces/{job_id}/detection-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    s3_client.put_object(Bucket=TRACE_BUCKET, Key=key, Body=json.dumps(trace_obj).encode('utf-8'), ContentType='application/json')
    return key


def _build_agent(insurance_type: str) -> object:
    """Construct the Strands Agent with prompts/tools based on insurance type.

    - life: use life underwriting prompt and Bedrock KB tool
    - property_casualty: use P&C underwriting prompt and DO NOT attach KB tool
    """
    model_id = os.environ.get('BEDROCK_ANALYSIS_MODEL_ID', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0')

    @tool
    def scratch_fixed(action: str, key: str, value=None, agent=None):
        """Tool for temporary storage during agent execution - uses agent.state properly"""
        scratch_data = agent.state.get('scratch_pad') or {}
        if action == 'append':
            if key not in scratch_data:
                scratch_data[key] = []
            scratch_data[key].append(value)
        elif action == 'set':
            scratch_data[key] = value
        elif action == 'get':
            return scratch_data.get(key)
        agent.state.set('scratch_pad', scratch_data)
        return 'ok'

    @tool
    def kb_search(canonical_term: str):
        print(f"[kb_search] Searching for {canonical_term}")
        """Return markdown for the top KB hit from Bedrock Knowledge Base."""
        kb_id = os.environ.get('KNOWLEDGE_BASE_ID')
        if not kb_id:
            return "Knowledge base not configured."
        try:
            resp = kb_runtime.retrieve(
                knowledgeBaseId=kb_id,
                retrievalQuery={'text': canonical_term},
                retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 1}}
            )
            results = resp.get('retrievalResults') or []
            if not results:
                return "No matching documents found."
            content = results[0].get('content').get('text') or {}
            location = results[0].get('location').get('s3Location').get('uri') or {}
            print(f"[kb_search] Found {canonical_term} in {location}")
            # Bedrock returns {'text': '...'} per docs
            return f"""
            knowledgebase_location: {location}
            text_content: {content}
            """
        except Exception as e:
            return f"KB retrieval error: {e}"

    LIFE_PROMPT = """You are a senior life insurance underwriter. Your job is to analyze the data stream for an application and identify impairments, 
scoring factors (based on the knowledge base), and evidences for those impairments. 
1. Scan the extracted datafor impairment evidence and write out an initial list of impairments.
Then for each impairment in your scratch pad, do the following:
2. Call kb_search() once and treat the markdown returned as authoritative. Make sure to record the page numbers where you found evidence for the impairment and the knowledgebase_location for the impairment to be used in the final JSON output.
3. Use the ratings tables in the returned markdown to determine a list of "scoring factors" are required to completely score that impairment and write them out. 
4. Search through the XML feeds to consolidate the values for each scoring factor, and the list of evidence for that impairment. 
5. Write out the scoring factors and evidence for that impairment.

Repeat this process for each impairment you find. Deduplicate any impairment that is found in multiple XML feeds into one listng. 

Once you have completed this process for all impairments, return a well-structured JSON response like the following:

```json  
{ 
   "impairments": [
     {
       "impairment_id": "diabetes",
       "scoring_factors": {"A1C": 8.2, "Neuropathy": true},
       "evidence": ["Rx: insulin … (Page 3,4)", "Lab: A1C 8.2 % (Page 1)"],
       "discrepancies": ["answered no to Diabetes Questionnaire but evidence of diabetes"] # optional
       "knowledgebase_location": "s3://ai-underwriting-732229910216-kb-source/manual/manual/3-medical-impairments/metabolic/type2_diabetes.md",
     
     },
     {
       "impairment_id": "hypertension",
       "scoring_factors": {"Blood Pressure": 128/92, "Age": 41, "Medication": "Lisinopril 10mg", "Duration": "At least since 2022-04-18", "Compliance": "Good - regular refills", "Target Organ Damage": "None evident", "Comorbidities": "None evident", "Family History": "Father had heart attack at age 58"},
       "evidence": ["Rx: Lisinopril 10mg for hypertension, filled 2024-01-10 (90 tablets) (Page 10)", "Rx: Lisinopril 10mg for hypertension, filled 2023-10-12 (90 tablets) (Page 11)", "MIB: Code 311C 'CARDIOVASCULAR - HYPERTENSION TREATED' from 2022-04-18 (Page 12,19)", "Application: Self-reported Lisinopril 10mg for blood pressure (Page 13)", "Application: Blood pressure reading 128/92 mmHg (Page 14)"],
       "knowledgebase_location": "s3://ai-underwriting-732229910216-kb-source/manual/manual/3-medical-impairments/metabolic/hypertension.md",
     }
   ],
   "narrative": "Agent Analysis: The applicant has a history of hypertension and diabetes. I cross checked this with the underwriting manual entries on Hypertension and Type 2 Diabetes. The hypertension is well controlled with Lisinopril 10mg, and the diabetes is well controlled with insulin. The applicant has a family history of heart attack in the father."
}
```

Explanation of the JSON output:
- impairment_id: The canonical name of the impairment.
- scoring_factors: A dictionary of scoring factors from the knowledge base entry for that impairment.
- evidence: A list of evidence for the impairment and the page numbers of the evidence.
- knowledgebase_location: The location of the knowledge base entry for the impairment (derived from the knowledgebase_location returned by the kb_search() tool).
- discrepancies: A list of discrepancies for the impairment.
- narrative: A high level summary of the analysis of all the impairments. Should include references to the knowledge base entries for the impairments that were used to generate the analysis.

   
"""

    PC_PROMPT = """You are a senior property and casualty insurance underwriter. Analyze the extracted data for risk drivers and underwriting concerns relevant to P&C (not life).

Your goals:
1. Identify a list of P&C risk drivers (call them "impairments" for consistency), such as: prior losses, construction type and quality, occupancy and operations, fire protection and sprinklers, alarms, location crime/flood/wildfire exposure, values and COPE details, hazardous materials or processes, and clear compliance issues.
2. For each risk driver, list the specific "scoring_factors" you would evaluate for P&C (for example, for fire risk: construction class, story count, year built, distance to hydrant, sprinklered yes/no, alarm type; for liability: operations description, employee count, premises condition, safety controls).
3. Gather concise "evidence" strings from the extracted data that support each risk driver and factor.

Important:
- Do NOT use any life underwriting manual or knowledge base content. There is no KB available for P&C. Do not call any KB tools.
- Work only from the provided extracted data.

Return a single JSON object in this format:
```json
{
  "impairments": [
    {
      "impairment_id": "fire_risk",
      "scoring_factors": {"construction": "masonry noncombustible", "sprinklered": true, "distance_to_hydrant": "<500ft"},
      "evidence": ["BCEGS class 3 noted on application (Page 2)", "Sprinklers: wet pipe system throughout (Page 5)"]
    }
  ],
  "narrative": "Brief P&C-focused summary of key risks and supporting evidence."
}
```
"""

    if (insurance_type or "").lower() == "life":
        return Agent(system_prompt=LIFE_PROMPT, tools=[kb_search, scratch_fixed], model=model_id)
    else:
        # property_casualty: exclude knowledge base tool
        return Agent(system_prompt=PC_PROMPT, tools=[scratch_fixed], model=model_id)




def _run_agent_detection(extracted_data: dict, insurance_type: str) -> dict:
    """Run the Strands Agent and return parsed JSON result."""
    agent = _build_agent(insurance_type)
    # Feed the raw JSON string directly to the agent (simpler and more faithful)
    message_str = json.dumps(extracted_data, ensure_ascii=False)
    res = agent(message_str)
    res_str = str(res)
    # Extract fenced JSON if present
    fence = re.search(r"```json\s*(.*?)\s*```", res_str, re.DOTALL)
    if fence:
        res_str = fence.group(1)
    try:
        return json.loads(res_str)
    except Exception:
        obj = re.search(r"\{[\s\S]*\}", res_str)
        return json.loads(obj.group(0)) if obj else {"impairments": [], "narrative": ""}



def lambda_handler(event, context):
    print("[lambda_handler] Received event:", json.dumps(event))
    
    # Initialize analysis_json for error handling
    analysis_json = {"error": True, "message": "Unknown error occurred"}

    # --- 1) Fetch & merge all S3-backed chunks ---
    print("[lambda_handler] Merging extractionResults via S3 pointers")
    merged_data = {}
    raw_results = event.get('extractionResults') or []
    s3 = get_s3_client()
    for idx, chunk_meta in enumerate(raw_results):
        pages = chunk_meta.get('pages')
        key = chunk_meta.get('chunkS3Key')
        print(f"[lambda_handler] Chunk {idx}: pages={pages}, chunkS3Key={key}")
        if not key:
            print(f"[lambda_handler] Skipping chunk {idx} because no chunkS3Key provided")
            continue
        try:
            print(f"[lambda_handler] Fetching S3 object: Bucket={EXTRACTION_BUCKET}, Key={key}")
            obj = s3.get_object(Bucket=EXTRACTION_BUCKET, Key=key)
            body = obj['Body'].read()
            chunk_data = json.loads(body.decode('utf-8'))
            print(f"[lambda_handler] Retrieved chunk {idx}, keys={list(chunk_data.keys())}")
        except Exception as e:
            print(f"[lambda_handler] Error fetching/parsing S3 chunk {idx} (Bucket={EXTRACTION_BUCKET}, Key={key}): {e}")
            traceback.print_exc()
            # Optionally fail fast or continue merging
            continue
        for subdoc, pages_list in chunk_data.items():
            merged_data.setdefault(subdoc, []).extend(pages_list or [])
    print(f"[lambda_handler] Merged extracted data keys: {list(merged_data.keys())}")
    extracted_data = merged_data
    print(f"[lambda_handler] Extracted data: {extracted_data}")

    # --- 2) Persist extractedDataJsonStr to DynamoDB ---
    classification = event.get('classification', {})
    job_id = classification.get('jobId')
    document_type = classification.get('classification')
    insurance_type = classification.get('insuranceType') or 'property_casualty'
    if job_id and DB_TABLE:
        # Mark status as DETECTING (impairments) prior to analysis
        try:
            now = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #s = :s, #t = :t",
                ExpressionAttributeNames={'#s': 'status', '#t': 'detectionStartTimestamp'},
                ExpressionAttributeValues={':s': {'S': 'DETECTING'}, ':t': {'S': now}}
            )
        except Exception:
            pass
        try:
            ts = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #dt = :dt, #ed = :ed, #et = :et",
                ExpressionAttributeNames={'#dt': 'documentType', '#ed': 'extractedDataJsonStr', '#et': 'extractionTimestamp'},
                ExpressionAttributeValues={':dt': {'S': document_type}, ':ed': {'S': json.dumps(extracted_data)}, ':et': {'S': ts}}
            )
            print(f"[lambda_handler] Persisted extractedDataJsonStr for job {job_id}")
        except Exception as e:
            print(f"Error processing input event: {e}")
            analysis_json["message"] = f"Error processing input event: {str(e)}"
            return analysis_json

        # If insurance type was not in event, try to load it from DynamoDB
        if not insurance_type and job_id and DB_TABLE:
            try:
                resp = dynamodb_client.get_item(TableName=DB_TABLE, Key={'jobId': {'S': job_id}}, ProjectionExpression='insuranceType')
                item = resp.get('Item') or {}
                insurance_type = (item.get('insuranceType') or {}).get('S') or 'property_casualty'
            except Exception:
                insurance_type = 'property_casualty'

    # --- 3) Detect impairments using Strands Agent (Bedrock KB) ---
    agent_raw = {}
    try:
        agent_raw = _run_agent_detection(extracted_data, insurance_type)
    except Exception as e:
        print(f"[lambda_handler] Agent detection error: {e}")
        traceback.print_exc()
        agent_raw = {"impairments": [], "narrative": ""}

    # Use the agent's raw output AS-IS (no normalization)
    detection = agent_raw

    # --- 4) Write trace ---
    trace_key = None
    if job_id:
        trace_key = _write_trace(job_id, {'eventKeys': list(event.keys()), 'agentRaw': agent_raw, 'output': detection})
        if trace_key:
            detection['traceS3Key'] = trace_key

    # --- 5) Persist to DynamoDB ---
    if job_id and DB_TABLE:
        try:
            ts2 = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #ad = :ad, #dt = :dt",
                ExpressionAttributeNames={'#ad': 'analysisDetectionJsonStr', '#dt': 'detectionTimestamp'},
                ExpressionAttributeValues={':ad': {'S': json.dumps(detection)}, ':dt': {'S': ts2}}
            )
            print(f"[lambda_handler] Persisted analysisDetectionJsonStr for job {job_id}")
        except Exception as e:
            print(f"[lambda_handler] DynamoDB detection persist error: {e}")
            traceback.print_exc()

    return {
        'status': 'SUCCESS',
        'message': 'Detection completed',
        'analysisDetection': detection
    }