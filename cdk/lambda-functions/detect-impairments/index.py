import json
import boto3
import os
import re
import traceback
import time
from botocore.config import Config
from botocore.exceptions import ClientError
from datetime import datetime, timezone
from strands import Agent, tool
from strands.models import BedrockModel
from botocore.config import Config as BotoConfig

def log_timing(operation_name, start_time):
    """Log the duration of an operation"""
    elapsed = time.time() - start_time
    print(f"[TIMING] {operation_name} completed in {elapsed:.2f}s")


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
    model_id = os.environ.get('BEDROCK_DETECTION_MODEL_ID', 'global.anthropic.claude-haiku-4-5-20251001-v1:0')

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
- narrative: A high level summary of the analysis of all the impairments. Should include references to the knowledge base entries for the impairments that were used to generate the analysis. One paragraph maximum. 

   
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

    # Configure BedrockModel with adaptive retry
    retrying_cfg = BotoConfig(
        retries={"mode": "adaptive", "max_attempts": 12}
    )
    model = BedrockModel(
        model_id=model_id,
        boto_client_config=retrying_cfg
    )
    print(f"[_build_agent] Created BedrockModel with adaptive retry (max_attempts=12)")

    if (insurance_type or "").lower() == "life":
        return Agent(system_prompt=LIFE_PROMPT, tools=[kb_search, scratch_fixed], model=model)
    else:
        # property_casualty: exclude knowledge base tool
        return Agent(system_prompt=PC_PROMPT, tools=[scratch_fixed], model=model)




def _run_agent_detection(extracted_data: dict, insurance_type: str) -> dict:
    """Run the Strands Agent and return parsed JSON result."""
    agent_start = time.time()
    print(f"[_run_agent_detection] Building agent for insurance_type={insurance_type}")
    agent = _build_agent(insurance_type)
    # Feed the raw JSON string directly to the agent (simpler and more faithful)
    message_str = json.dumps(extracted_data, ensure_ascii=False)
    print(f"[_run_agent_detection] Agent input message size: {len(message_str)} bytes")
    print(f"[_run_agent_detection] Invoking Strands agent...")
    invoke_start = time.time()
    try:
        res = agent(message_str)
        log_timing("Strands agent invocation", invoke_start)
    except Exception as agent_error:
        log_timing("Strands agent invocation (FAILED)", invoke_start)
        print(f"[_run_agent_detection] ERROR: Strands agent invocation failed: {type(agent_error).__name__}: {agent_error}")
        traceback.print_exc()
        # Check for specific Bedrock errors
        if hasattr(agent_error, 'response'):
            print(f"[_run_agent_detection] Bedrock error response: {agent_error.response}")
        raise
    res_str = str(res)
    print(f"[_run_agent_detection] Agent response size: {len(res_str)} bytes")
    print(f"[_run_agent_detection] Agent response preview (first 500 chars): {res_str[:500]}")
    # Extract fenced JSON if present
    fence = re.search(r"```json\s*(.*?)\s*```", res_str, re.DOTALL)
    if fence:
        res_str = fence.group(1)
        print(f"[_run_agent_detection] Extracted JSON from fenced code block")
    try:
        result = json.loads(res_str)
        print(f"[_run_agent_detection] Successfully parsed JSON, impairments count: {len(result.get('impairments', []))}")
        log_timing("Total agent detection", agent_start)
        return result
    except Exception as e:
        print(f"[_run_agent_detection] Direct JSON parse failed: {e}, trying regex")
        obj = re.search(r"\{[\s\S]*\}", res_str)
        if obj:
            try:
                result = json.loads(obj.group(0))
                print(f"[_run_agent_detection] Regex JSON parse succeeded")
                log_timing("Total agent detection", agent_start)
                return result
            except Exception as e2:
                print(f"[_run_agent_detection] ERROR: Regex JSON parse also failed: {e2}")
        print(f"[_run_agent_detection] ERROR: Could not parse agent response as JSON")
        log_timing("Total agent detection (FAILED)", agent_start)
        return {"impairments": [], "narrative": ""}



def lambda_handler(event, context):
    handler_start = time.time()
    print(f"[lambda_handler] === DETECT IMPAIRMENTS LAMBDA START === remaining_time={context.get_remaining_time_in_millis()}ms")
    print(f"[lambda_handler] Event keys: {list(event.keys()) if isinstance(event, dict) else 'not a dict'}")
    print(f"[lambda_handler] Event size: {len(json.dumps(event))} bytes")
    
    # Initialize analysis_json for error handling
    analysis_json = {"error": True, "message": "Unknown error occurred"}

    # --- 1) Fetch & merge all S3-backed chunks ---
    s3_fetch_start = time.time()
    print(f"[lambda_handler] Step 1: Merging extractionResults via S3 pointers, remaining_time={context.get_remaining_time_in_millis()}ms")
    merged_data = {}
    raw_results = event.get('extractionResults') or []
    print(f"[lambda_handler] Number of extraction chunks to process: {len(raw_results)}")
    s3 = get_s3_client()
    for idx, chunk_meta in enumerate(raw_results):
        chunk_start = time.time()
        pages = chunk_meta.get('pages')
        key = chunk_meta.get('chunkS3Key')
        print(f"[lambda_handler] Processing chunk {idx+1}/{len(raw_results)}: pages={pages}, chunkS3Key={key}")
        if not key:
            print(f"[lambda_handler] Skipping chunk {idx} because no chunkS3Key provided")
            continue
        try:
            print(f"[lambda_handler] Fetching S3 object: Bucket={EXTRACTION_BUCKET}, Key={key}")
            obj = s3.get_object(Bucket=EXTRACTION_BUCKET, Key=key)
            body = obj['Body'].read()
            chunk_data = json.loads(body.decode('utf-8'))
            print(f"[lambda_handler] Retrieved chunk {idx}, size={len(body)} bytes, keys={list(chunk_data.keys())}")
            log_timing(f"S3 fetch chunk {idx}", chunk_start)
        except Exception as e:
            print(f"[lambda_handler] ERROR fetching/parsing S3 chunk {idx} (Bucket={EXTRACTION_BUCKET}, Key={key}): {e}")
            traceback.print_exc()
            # Optionally fail fast or continue merging
            continue
        for subdoc, pages_list in chunk_data.items():
            merged_data.setdefault(subdoc, []).extend(pages_list or [])
    log_timing("Total S3 chunk fetching", s3_fetch_start)
    print(f"[lambda_handler] Merged extracted data keys: {list(merged_data.keys())}")
    extracted_data = merged_data
    print(f"[lambda_handler] Total merged data size: {len(json.dumps(extracted_data))} bytes")

    # --- 2) Update status and get insurance type ---
    print(f"[lambda_handler] Step 2: Updating status to DETECTING, remaining_time={context.get_remaining_time_in_millis()}ms")
    classification = event.get('classification', {})
    job_id = classification.get('jobId')
    document_type = classification.get('classification')
    insurance_type = classification.get('insuranceType') or 'property_casualty'
    print(f"[lambda_handler] job_id={job_id}, document_type={document_type}, insurance_type={insurance_type}")
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
            print(f"[lambda_handler] Updated status to DETECTING for job {job_id}")
        except Exception as e:
            print(f"[lambda_handler] WARNING: Failed to update status to DETECTING: {e}")

        # If insurance type was not in event, try to load it from DynamoDB
        if not insurance_type and job_id and DB_TABLE:
            print(f"[lambda_handler] Insurance type not in event, fetching from DynamoDB")
            try:
                resp = dynamodb_client.get_item(TableName=DB_TABLE, Key={'jobId': {'S': job_id}}, ProjectionExpression='insuranceType')
                item = resp.get('Item') or {}
                insurance_type = (item.get('insuranceType') or {}).get('S') or 'property_casualty'
                print(f"[lambda_handler] Retrieved insurance_type from DynamoDB: {insurance_type}")
            except Exception as e:
                print(f"[lambda_handler] WARNING: Failed to get insurance type from DynamoDB: {e}")
                insurance_type = 'property_casualty'

    # --- 3) Detect impairments using Strands Agent (Bedrock KB) ---
    print(f"[lambda_handler] Step 3: Running Strands agent for impairment detection, remaining_time={context.get_remaining_time_in_millis()}ms")
    agent_raw = {}
    agent_start = time.time()
    try:
        agent_raw = _run_agent_detection(extracted_data, insurance_type)
        log_timing("Agent detection", agent_start)
        print(f"[lambda_handler] Agent detection completed, impairments found: {len(agent_raw.get('impairments', []))}")
    except Exception as e:
        log_timing("Agent detection (FAILED)", agent_start)
        print(f"[lambda_handler] ERROR: Agent detection error: {e}")
        traceback.print_exc()
        agent_raw = {"impairments": [], "narrative": ""}

    # Use the agent's raw output AS-IS (no normalization)
    detection = agent_raw

    # --- 4) Write trace ---
    print(f"[lambda_handler] Step 4: Writing trace to S3, remaining_time={context.get_remaining_time_in_millis()}ms")
    trace_key = None
    if job_id:
        trace_start = time.time()
        trace_key = _write_trace(job_id, {'eventKeys': list(event.keys()), 'agentRaw': agent_raw, 'output': detection})
        if trace_key:
            detection['traceS3Key'] = trace_key
            log_timing("Write trace to S3", trace_start)
            print(f"[lambda_handler] Trace written to: {trace_key}")

    # --- 5) Persist to DynamoDB ---
    print(f"[lambda_handler] Step 5: Persisting detection to DynamoDB, remaining_time={context.get_remaining_time_in_millis()}ms")
    if job_id and DB_TABLE:
        ddb_start = time.time()
        try:
            ts2 = datetime.now(timezone.utc).isoformat()
            detection_json = json.dumps(detection)
            print(f"[lambda_handler] Persisting analysisDetectionJsonStr, size={len(detection_json)} bytes")
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #ad = :ad, #dt = :dt",
                ExpressionAttributeNames={'#ad': 'analysisDetectionJsonStr', '#dt': 'detectionTimestamp'},
                ExpressionAttributeValues={':ad': {'S': detection_json}, ':dt': {'S': ts2}}
            )
            log_timing("DynamoDB persist detection", ddb_start)
            print(f"[lambda_handler] Persisted analysisDetectionJsonStr for job {job_id}")
        except Exception as e:
            print(f"[lambda_handler] ERROR: DynamoDB detection persist error: {e}")
            traceback.print_exc()

    log_timing("Total DETECT IMPAIRMENTS lambda execution", handler_start)
    print(f"[lambda_handler] === DETECT IMPAIRMENTS LAMBDA COMPLETE === remaining_time={context.get_remaining_time_in_millis()}ms")
    result = {
        'status': 'SUCCESS',
        'message': 'Detection completed',
        'analysisDetection': detection
    }
    print(f"[lambda_handler] Returning result, size={len(json.dumps(result))} bytes")
    return result

