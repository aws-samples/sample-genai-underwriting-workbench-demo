import json
import boto3
import os
from strands import Agent, tool
from strands.models import BedrockModel
from botocore.config import Config as BotoConfig

s3_client = boto3.client('s3')
kb_runtime = boto3.client('bedrock-agent-runtime')
dynamodb_client = boto3.client('dynamodb')

EXTRACTION_BUCKET = os.environ.get('EXTRACTION_BUCKET')
KNOWLEDGE_BASE_ID = os.environ.get('KNOWLEDGE_BASE_ID')
DB_TABLE = os.environ.get('JOBS_TABLE_NAME')
MODEL_ID = os.environ.get('BEDROCK_DETECTION_MODEL_ID', 'global.anthropic.claude-haiku-4-5-20251001-v1:0')


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


def build_agent(insurance_type: str, language: str):
    """Build Strands Agent with full logic from detect-impairments"""
    language_instruction = get_language_instruction(language)

    @tool
    def scratch_fixed(action: str, key: str, value=None, agent=None):
        """Tool for temporary storage during agent execution"""
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
        """Return markdown for the top KB hit from Bedrock Knowledge Base"""
        print(f"[kb_search] Searching for {canonical_term}")
        if not KNOWLEDGE_BASE_ID:
            return "Knowledge base not configured."
        try:
            resp = kb_runtime.retrieve(
                knowledgeBaseId=KNOWLEDGE_BASE_ID,
                retrievalQuery={'text': canonical_term},
                retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 1}}
            )
            results = resp.get('retrievalResults') or []
            if not results:
                return "No matching documents found."
            content = results[0].get('content').get('text') or {}
            location = results[0].get('location').get('s3Location').get('uri') or {}
            print(f"[kb_search] Found {canonical_term} in {location}")
            return f"""
            knowledgebase_location: {location}
            text_content: {content}
            """
        except Exception as e:
            return f"KB retrieval error: {e}"

    LIFE_PROMPT = """You are a senior life insurance underwriter. Your job is to analyze the data stream for an application and identify impairments, 
scoring factors (based on the knowledge base), and evidences for those impairments. 
1. Scan the extracted data for impairment evidence and write out an initial list of impairments.
Then for each impairment in your scratch pad, do the following:
2. Call kb_search() once and treat the markdown returned as authoritative. Make sure to record the page numbers where you found evidence for the impairment and the knowledgebase_location for the impairment to be used in the final JSON output.
3. Use the ratings tables in the returned markdown to determine a list of "scoring factors" are required to completely score that impairment and write them out. 
4. If the impairment is not found in the knowledge base, omit it from the final JSON output.
5. Search through the XML feeds to consolidate the values for each scoring factor, and the list of evidence for that impairment. 
6. Write out the scoring factors and evidence for that impairment.

Repeat this process for each impairment you find. Deduplicate any impairment that is found in multiple XML feeds into one listng. 

Once you have completed this process for all impairments, return a well-structured JSON response like the following:

```json  
{ 
   "impairments": [
     {
       "impairment_id": "diabetes",
       "scoring_factors": {"A1C": 8.2, "Neuropathy": true},
       "evidence": ["Rx: insulin … (Page 3,4)", "Lab: A1C 8.2 % (Page 1)"],
       "discrepancies": ["answered no to Diabetes Questionnaire but evidence of diabetes"],
       "knowledgebase_location": "s3://...",
     }
   ],
   "narrative": "Agent Analysis: ..."
}
```

IMPORTANT: """ + language_instruction + """ All text content in the JSON must be in this language."""

    PC_PROMPT = """You are a senior property and casualty insurance underwriter. Analyze the extracted data for risk drivers and underwriting concerns relevant to P&C (not life).

Your goals:
1. Identify a list of P&C risk drivers (call them "impairments" for consistency).
2. For each risk driver, list the specific "scoring_factors" you would evaluate for P&C.
3. Gather concise "evidence" strings from the extracted data.

Important:
- Do NOT use any life underwriting manual or knowledge base content. There is no KB available for P&C. Do not call any KB tools.

Return a single JSON object in this format:
```json
{
  "impairments": [
    {
      "impairment_id": "fire_risk",
      "scoring_factors": {"construction": "masonry noncombustible", "sprinklered": true},
      "evidence": ["BCEGS class 3 noted on application (Page 2)"]
    }
  ],
  "narrative": "Brief P&C-focused summary of key risks."
}
```

IMPORTANT: """ + language_instruction + """ All text content in the JSON must be in this language."""

    retrying_cfg = BotoConfig(retries={"mode": "adaptive", "max_attempts": 12})
    model = BedrockModel(model_id=MODEL_ID, boto_client_config=retrying_cfg)

    if (insurance_type or "").lower() == "life":
        return Agent(system_prompt=LIFE_PROMPT, tools=[kb_search, scratch_fixed], model=model)
    else:
        return Agent(system_prompt=PC_PROMPT, tools=[scratch_fixed], model=model)


def lambda_handler(event, context):
    print(f"[detect-chunk] Received event: {json.dumps(event)}")
    
    chunk_id = event.get('chunkId')
    chunk_s3_key = event.get('chunkS3Key')
    job_id = event.get('jobId')
    insurance_type = event.get('insuranceType', 'life_health')
    
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
            print(f"[detect-chunk] User language for job {job_id}: {language}")
        except Exception as e:
            print(f"[detect-chunk] Error reading userLanguage: {e}")
    
    if not chunk_s3_key:
        return {'error': 'Missing chunkS3Key'}
    
    # Fetch chunk from S3
    print(f"[detect-chunk] Fetching chunk {chunk_id} from S3")
    try:
        obj = s3_client.get_object(Bucket=EXTRACTION_BUCKET, Key=chunk_s3_key)
        chunk_data = json.loads(obj['Body'].read().decode('utf-8'))
    except Exception as e:
        print(f"[detect-chunk] Error fetching chunk: {e}")
        return {'error': f'Failed to fetch chunk: {str(e)}'}
    
    # Build agent and run detection
    print(f"[detect-chunk] Running Strands agent for chunk {chunk_id}")
    agent = build_agent(insurance_type, language)
    
    message_str = json.dumps(chunk_data, ensure_ascii=False)
    print(f"[detect-chunk] Chunk {chunk_id} data size: {len(message_str)} bytes")
    
    try:
        result = agent(message_str)
        print(f"[detect-chunk] Agent completed for chunk {chunk_id}")
        print(f"[detect-chunk] Agent result type: {type(result)}")
        
        # Strands Agent returns AgentResult object, get the text content
        if hasattr(result, 'content'):
            result_text = result.content
        elif hasattr(result, 'text'):
            result_text = result.text
        else:
            result_text = str(result)
        
        print(f"[detect-chunk] Result text length: {len(result_text)} chars")
        
        # Try to extract JSON from markdown code blocks if present
        if '```json' in result_text:
            try:
                json_start = result_text.index('```json') + 7
                json_end = result_text.index('```', json_start)
                result_text = result_text[json_start:json_end].strip()
            except:
                pass
        elif '```' in result_text:
            try:
                json_start = result_text.index('```') + 3
                json_end = result_text.index('```', json_start)
                result_text = result_text[json_start:json_end].strip()
            except:
                pass
        
        # Parse result
        parsed_result = json.loads(result_text)
        parsed_result['chunkId'] = chunk_id
        return parsed_result
    except Exception as e:
        print(f"[detect-chunk] Error running agent: {e}")
        import traceback
        traceback.print_exc()
        return {'error': f'Agent error: {str(e)}', 'chunkId': chunk_id}
