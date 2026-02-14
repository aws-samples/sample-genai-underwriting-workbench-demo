import json
import boto3
import os
from botocore.config import Config

# Configure retry settings for Bedrock client
bedrock_retry_config = Config(
    retries={'max_attempts': 10, 'mode': 'adaptive'},
    max_pool_connections=50
)

bedrock_runtime = boto3.client(service_name='bedrock-runtime', config=bedrock_retry_config)
s3_client = boto3.client('s3')
dynamodb_client = boto3.client('dynamodb')

EXTRACTION_BUCKET = os.environ.get('EXTRACTION_BUCKET')
DB_TABLE = os.environ.get('JOBS_TABLE_NAME')
MODEL_ID = os.environ.get('BEDROCK_ANALYSIS_MODEL_ID', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0')

ANALYSIS_OUTPUT_SCHEMA = {
    "overall_summary": "string",
    "identified_risks": [
        {"risk_description": "string", "severity": "string", "page_references": ["string"]}
    ],
    "discrepancies": [
        {"discrepancy_description": "string", "details": "string", "page_references": ["string"]}
    ],
    "medical_timeline": "string",
    "property_assessment": "string",
    "final_recommendation": "string",
    "missing_information": [
        {"item_description": "string", "notes": "string"}
    ],
    "confidence_score": "float"
}

def get_language_instruction(language: str) -> str:
    language_map = {
        'en-US': 'Respond in English.',
        'zh-CN': 'Respond in Simplified Chinese (简体中文).',
        'ja-JP': 'Respond in Japanese (日本語).',
        'es-ES': 'Respond in Spanish (Español).',
        'fr-FR': 'Respond in French (Français).',
        'fr-CA': 'Respond in Canadian French (Français canadien).',
        'de-DE': 'Respond in German (Deutsch).',
        'it-IT': 'Respond in Italian (Italiano).',
    }
    return language_map.get(language, 'Respond in English.')


def lambda_handler(event, context):
    print(f"[analyze-chunk] Received event: {json.dumps(event)}")
    
    chunk_id = event.get('chunkId')
    chunk_s3_key = event.get('chunkS3Key')
    job_id = event.get('jobId')
    total_chunks = event.get('totalChunks', 1)
    
    if not chunk_s3_key:
        return {'error': 'Missing chunkS3Key'}
    
    # Read user language preference from DynamoDB
    language = 'en-US'
    if job_id and DB_TABLE:
        try:
            resp = dynamodb_client.get_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                ProjectionExpression='userLanguage'
            )
            item = resp.get('Item', {})
            language = (item.get('userLanguage') or {}).get('S') or 'en-US'
            print(f"[analyze-chunk] User language for job {job_id}: {language}")
        except Exception as e:
            print(f"[analyze-chunk] Error reading userLanguage: {e}")
    
    # --- 1) Fetch chunk data from S3 ---
    print(f"[analyze-chunk] Fetching chunk {chunk_id} from S3: {chunk_s3_key}")
    try:
        obj = s3_client.get_object(Bucket=EXTRACTION_BUCKET, Key=chunk_s3_key)
        chunk_data = json.loads(obj['Body'].read().decode('utf-8'))
    except Exception as e:
        print(f"[analyze-chunk] Error fetching chunk: {e}")
        return {'error': f'Failed to fetch chunk: {str(e)}'}
    
    # --- 2) Build analysis prompt ---
    consolidated = json.dumps(chunk_data, indent=2)
    print(f"[analyze-chunk] Chunk {chunk_id} data size: {len(consolidated)} chars")
    
    language_instruction = get_language_instruction(language)
    
    chunk_context = ""
    if total_chunks > 1:
        chunk_context = f"\n\nNote: This is chunk {chunk_id + 1} of {total_chunks}. Analyze this subset of the document."
    
    analysis_prompt_text = f"""You are an expert insurance underwriter tasked with analyzing extracted document information.
        The following data was extracted from an insurance document:
        <extracted_data>
        {consolidated}
        </extracted_data>
        {chunk_context}

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
        
        IMPORTANT: {language_instruction} All text content in the JSON (summaries, descriptions, recommendations) must be in this language.
        
        Return ONLY the JSON object.
        """
    
    # --- 3) Call Bedrock ---
    print(f"[analyze-chunk] Calling Bedrock for chunk {chunk_id}")
    try:
        response = bedrock_runtime.converse(
            modelId=MODEL_ID,
            messages=[{"role": "user", "content": [{"text": analysis_prompt_text}]}],
            inferenceConfig={"maxTokens": 16384, "temperature": 0.05}
        )
        print(f"[analyze-chunk] Bedrock response received for chunk {chunk_id}")
    except Exception as e:
        print(f"[analyze-chunk] Bedrock error: {e}")
        return {'error': f'Bedrock error: {str(e)}'}
    
    # --- 4) Parse response ---
    out = response.get('output', {}).get('message', {}).get('content', [])
    text_block = out[0] if out and isinstance(out[0], dict) else {}
    text = text_block.get('text', '')
    
    print(f"[analyze-chunk] Bedrock response text length: {len(text)} chars")
    
    if not text or not text.strip():
        print(f"[analyze-chunk] ERROR: Empty response from Bedrock")
        return {'error': 'Empty response from Bedrock', 'chunkId': chunk_id}
    
    # Try to extract JSON from markdown code blocks if present
    if '```json' in text:
        try:
            json_start = text.index('```json') + 7
            json_end = text.index('```', json_start)
            text = text[json_start:json_end].strip()
        except:
            pass
    elif '```' in text:
        try:
            json_start = text.index('```') + 3
            json_end = text.index('```', json_start)
            text = text[json_start:json_end].strip()
        except:
            pass
    
    try:
        analysis_result = json.loads(text)
        analysis_result['chunkId'] = chunk_id
        print(f"[analyze-chunk] Successfully parsed analysis for chunk {chunk_id}")
        return analysis_result
    except Exception as e:
        print(f"[analyze-chunk] Error parsing Bedrock response: {e}")
        print(f"[analyze-chunk] Response text preview: {text[:500]}")
        return {'error': f'Failed to parse response: {str(e)}', 'chunkId': chunk_id, 'raw_text': text[:500]}
