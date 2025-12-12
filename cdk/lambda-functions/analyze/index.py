import json
import boto3
import os
import re
import traceback
from botocore.config import Config
from botocore.exceptions import ClientError
from datetime import datetime, timezone # ADDED

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
dynamodb_client = boto3.client('dynamodb')
# Environment variables
DB_TABLE = os.environ.get('JOBS_TABLE_NAME')
EXTRACTION_BUCKET = os.environ.get('EXTRACTION_BUCKET')

# Reuse a single S3 client for fetching chunk files
def get_s3_client():
    return boto3.client('s3')


# Define the expected output schema for this analysis lambda
ANALYSIS_OUTPUT_SCHEMA = {
    "overall_summary": "string",
    "identified_risks": [
        {"risk_description": "string", "severity": "string", "page_references": ["string"]}
    ],
    "discrepancies": [
        {"discrepancy_description": "string", "details": "string", "page_references": ["string"]}
    ],
    "medical_timeline": "string", # Markdown text for UI
    "property_assessment": "string", # Markdown text for UI
    "final_recommendation": "string", # Markdown text for UI
    "missing_information": [
        {"item_description": "string", "notes": "string"}
    ],
    "confidence_score": "float" 
}

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

    # --- 2) Persist extractedDataJsonStr to DynamoDB ---
    classification = event.get('classification', {})
    job_id = classification.get('jobId')
    document_type = classification.get('classification')
    if job_id and DB_TABLE:
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

    # --- 3) Construct Analysis Prompt ---
    consolidated = json.dumps(extracted_data, indent=2)
    print(f"[lambda_handler] Building analysis prompt (length {len(consolidated)} chars)")
    analysis_prompt_text = f"""You are an expert insurance underwriter tasked with analyzing extracted document information.
        The following data was extracted from an insurance document:
        <extracted_data>
        {consolidated}
        </extracted_data>

        Please perform a comprehensive analysis. Your goal is to:
        1. Provide an 'overall_summary' of the document content and its purpose based on the extracted data.
        2. Identify key risks in 'identified_risks'. For each risk, include 'risk_description', 'severity' (Low, Medium, or High), and 'page_references' (list of strings, e.g., ["1", "3-5"], use ["N/A"] if not applicable).
        3. Identify any discrepancies or inconsistencies in 'discrepancies'. For each, include 'discrepancy_description', 'details' (provide specific details of the discrepancy), and 'page_references' (list of strings, e.g., ["2", "10"], use ["N/A"] if not applicable).
        4. Provide a 'medical_timeline' (string, use Markdown for formatting) if the document is medical-related. If not applicable, provide an empty string or "N/A".
        5. Provide a 'property_assessment' (string, use Markdown for formatting) if the document is property-related (e.g., commercial property application). If not applicable, provide an empty string or "N/A".
        6. Formulate a 'final_recommendation' (string, use Markdown for formatting) for the underwriter based on your analysis (e.g., approve, decline with reasons, request more info).
        7. List any critical missing information in 'missing_information'. For each, include 'item_description' and 'notes'.
        8. If you can estimate a 'confidence_score' (0.0 to 1.0) for your overall analysis based on the quality and completeness of the provided extracted data, include it. Otherwise, you can omit it or use a default like 0.75.
        
        Structure your response as a single JSON object matching the following schema precisely. Do not include any explanations or text outside this JSON structure:
        {json.dumps(ANALYSIS_OUTPUT_SCHEMA, indent=2)}
        
        Important Guidelines:
        - Adhere strictly to the JSON schema provided for the output.
        - If a section like 'identified_risks', 'discrepancies', or 'missing_information' has no items, provide an empty list ([]) for that key.
        - For 'page_references', if the source extracted data does not contain explicit page numbers associated with the information, use ["N/A"].
        - If you can estimate a 'confidence_score' (0.0 to 1.0) for your overall analysis based on the quality and completeness of the provided extracted data, include it. Otherwise, you can omit it or use a default like 0.75.
        
        Return ONLY the JSON object.
        """
    print(f"Analysis prompt created. Length: {len(analysis_prompt_text)} characters.")

    # --- 4) Call Bedrock Converse API ---
    try:
        response = bedrock_runtime.converse(
            modelId=os.environ.get('BEDROCK_ANALYSIS_MODEL_ID', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0'),
            messages=[{"role": "user", "content": [{"text": analysis_prompt_text}]}],
            inferenceConfig={"maxTokens": 4096, "temperature": 0.05}
        )
        print("[lambda_handler] Bedrock response received")
    except Exception as e:
        print(f"[lambda_handler] Bedrock error: {e}")
        analysis_json["message"] = f"Error calling Bedrock: {str(e)}"
        return analysis_json

    # --- 5) Parse assistant output ---
    out = response.get('output', {}).get('message', {}).get('content', [])
    text_block = out[0] if out and isinstance(out[0], dict) else {}
    text = text_block.get('text', '')
    print(f"[lambda_handler] Assistant text length: {len(text)}")
    try:
        analysis_json = json.loads(text)
    except Exception:
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            analysis_json = json.loads(match.group(0))
        else:
            print("[lambda_handler] Invalid assistant JSON, no match found")
            return {"status": "ERROR", "message": "Invalid assistant JSON", "analysis_data": {}}

    # --- 6) Validate schema ---
    valid = validate_analysis_data(analysis_json, ANALYSIS_OUTPUT_SCHEMA)
    status_msg = "SUCCESS" if valid else "WARNING"

    # --- 7) Persist analysisOutputJsonStr to DynamoDB ---
    if job_id and DB_TABLE:
        try:
            ts2 = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #ao = :ao, #at = :at",
                ExpressionAttributeNames={'#ao': 'analysisOutputJsonStr', '#at': 'analysisTimestamp'},
                ExpressionAttributeValues={':ao': {'S': json.dumps(analysis_json)}, ':at': {'S': ts2}}
            )
            print(f"[lambda_handler] Persisted analysisOutputJsonStr for job {job_id}")
        except Exception as e:
            print(f"[lambda_handler] DynamoDB analysis persist error: {e}")
            traceback.print_exc()

    print("Returning final analysis result:", json.dumps(analysis_json))
    # --- 8) Return final result ---
    return {
        "status": status_msg,
        "message": "Analysis completed" if valid else "Analysis completed with warnings",
        "analysis_data": analysis_json
    }