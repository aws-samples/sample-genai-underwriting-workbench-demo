import json
import os
import re
from datetime import datetime, timezone

import boto3
from botocore.config import Config

# Strands Agent imports (layer provided by CDK)
try:
    from strands import Agent, tool
except Exception:
    Agent = None  # type: ignore
    def tool(fn):  # type: ignore
        return fn


# Retry-friendly Bedrock runtime config
bedrock_retry_config = Config(
    retries={
        'max_attempts': 10,
        'mode': 'standard'
    },
    max_pool_connections=50
)


bedrock_runtime = boto3.client('bedrock-runtime', config=bedrock_retry_config)
kb_runtime = boto3.client('bedrock-agent-runtime')
dynamodb = boto3.client('dynamodb')
s3 = boto3.client('s3')


JOBS_TABLE_NAME = os.environ.get('JOBS_TABLE_NAME')
KNOWLEDGE_BASE_ID = os.environ.get('KNOWLEDGE_BASE_ID')
TRACE_BUCKET = os.environ.get('TRACE_BUCKET')
MODEL_ID = os.environ.get('BEDROCK_SCORING_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')


def _extract_job_id(event: dict) -> str | None:
    if not isinstance(event, dict):
        return None
    classification = event.get('classification') or {}
    job_id = classification.get('jobId')
    if job_id:
        return job_id
    # Fallbacks
    return event.get('jobId')


def _get_impairments_payload(event: dict) -> list[dict]:
    if not isinstance(event, dict):
        return []
    """Prefer prior detection output; fallback to minimal stubs from legacy analysis.

    The scoring agent expects a JSON array where each item contains:
      - impairment_id: string
      - scoring_factors: object (may be empty; agent must still proceed)
      - evidence: list of strings (optional)
    """
    detection_wrapper = event.get('analysisDetection')
    if isinstance(detection_wrapper, dict):
        # Handle nested analyze response: { status, message, analysisDetection: { impairments: [...] } }
        inner_detection = detection_wrapper.get('analysisDetection')
        candidate = inner_detection if isinstance(inner_detection, dict) else detection_wrapper
        imps = candidate.get('impairments')
        if isinstance(imps, list) and imps:
            return imps

    # Backward-compatible fallback using older analysis shape
    analysis = event.get('analysis') or {}
    analysis_data = analysis.get('analysis_data') or {}
    risks = analysis_data.get('identified_risks') or []
    payload: list[dict] = []
    for r in risks:
        desc = (r.get('risk_description') or '').strip()
        if not desc:
            continue
        payload.append({
            'impairment_id': desc,
            'scoring_factors': {},
            'evidence': []
        })
    return payload


# --- Tools (Bedrock KB only) ---
@tool
def kb_search(canonical_term: str):
    """Return markdown for the top KB hit from Bedrock knowledge base."""
    kb_id = KNOWLEDGE_BASE_ID
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
        content = results[0].get('content') or {}
        # Per Bedrock docs, content contains {'text': '...'}
        return content.get('text') or content.get('text_markdown') or ""
    except Exception as e:
        return f"KB retrieval error: {e}"


@tool
def calculator(values: list[float]):
    """Calculates the sum of a list of numbers. Use this for adding up credits (negative numbers) and debits (positive numbers)."""
    try:
        if not isinstance(values, list):
            return 0
        total = 0.0
        for v in values[:100]:  # basic guardrail
            try:
                total += float(v)
            except Exception:
                continue
        return total
    except Exception:
        return 0


# --- Prompt (verbatim from notebook) ---
LIFE_PROMPT = """You are a senior life insurance underwriter specializing in risk assessment scoring. Your job is to calculate a risk score for an application based on a list of identified impairments and their scoring factors.

You will be given a JSON array of impairments. For each impairment in the input list, you must perform the following steps in sequence:

1. **Lookup**: Call the `kb_search` tool using the impairment's `impairment_id` as the `canonical_term`. This returns the authoritative underwriting manual section.

2. **Analyze**: Carefully read the returned markdown. Use the `scoring_factors` provided for the impairment to find the correct debits and credits in the rating tables. For example, a `blood_pressure` of "128/92 mmHg" and `age` of 41 falls into the "141-150/91-95" row for the "Age 40-60" column in the hypertension manual, which indicates a debit between +25 and +50. Use the lower value if a range is given.

3. **Calculate Subtotal**: Create a list of all numerical debits (positive numbers) and credits (negative numbers) you identified. Pass this list to the `calculator` tool to get a `sub_total` for the impairment.

4. **Explain**: After calculating the subtotal, you must generate a detailed `reason` string explaining exactly how you arrived at that score, citing the specific scoring factors, table values, and modifying factors used.

Repeat this entire process for every impairment in the input list.

Once you have a `sub_total` for all impairments, create a final list containing all the individual sub-totals. Call the `calculator` tool one last time with this list to get the final `total_score`.

Finally, structure your entire response as a single JSON object. Do not include any other text or explanation outside of the final JSON block.

Your output must be in this exact format:
```json
{
  "total_score": 100,
  "impairment_scores": [
    {
      "impairment_id": "hypertension",
      "sub_total": 50,
      "reason": "Based on the underwriting manual entires for Hypertension, Debit of +25 for BP 128/92 at age 41. Debit of +25 for newly diagnosed. No credits applied."
    }
  ]
}
```
"""

PC_PROMPT = """You are a senior property and casualty insurance underwriter specializing in risk assessment scoring for P&C exposures.

You will be given a JSON array of P&C risk drivers (labeled as "impairments" for consistency) with their scoring factors. For each item in the list, you must:

1. Identify debits and credits based on standard P&C underwriting judgment for those factors (e.g., construction and protection improving fire risk, hazardous operations increasing liability, strong alarms/sprinklers reducing risk). Use conservative but reasonable values.
2. Create a list of numerical debits (positive) and credits (negative). Call the `calculator` tool to get a `sub_total`.
3. Provide a concise `reason` string explaining the key factors that drove the sub_total.

Important: Do NOT use any knowledge base or life underwriting manual. There is no KB tool for P&C.

Finally, return a single JSON object exactly like this:
```json
{
  "total_score": 0,
  "impairment_scores": [
    {"impairment_id": "fire_risk", "sub_total": 10, "reason": "Masonry noncombustible with sprinklers (-10), remote hydrant (+20). Net +10."}
  ]
}
```
"""


def _build_agent(insurance_type: str | None) -> object:
    itype = (insurance_type or '').lower()
    if itype == 'life':
        return Agent(
            system_prompt=LIFE_PROMPT,
            tools=[kb_search, calculator],
            model=MODEL_ID,
        )
    else:
        # property_casualty: exclude KB tool
        return Agent(
            system_prompt=PC_PROMPT,
            tools=[calculator],
            model=MODEL_ID,
        )


def _to_agent_message(payload: list[dict]) -> str:
    # Truncate oversize evidence strings for resilience
    safe_payload: list[dict] = []
    for item in (payload or [])[:20]:
        obj = dict(item)
        ev = obj.get('evidence') or []
        if isinstance(ev, list):
            trimmed = []
            for s in ev[:10]:
                if isinstance(s, str):
                    trimmed.append(s[:500])
                elif isinstance(s, dict) and 'text' in s:
                    trimmed.append(str(s.get('text'))[:500])
            obj['evidence'] = trimmed
        # prevent very large scoring factor values
        factors = obj.get('scoring_factors') or {}
        if isinstance(factors, dict):
            limited = {}
            for k, v in list(factors.items())[:30]:
                if isinstance(v, str):
                    limited[k] = v[:400]
                else:
                    limited[k] = v
            obj['scoring_factors'] = limited
        safe_payload.append(obj)
    return "Here is the JSON payload of impairments to score:\n\n" + json.dumps(safe_payload, indent=2)


def _run_agent_scoring(payload: list[dict], insurance_type: str | None) -> dict:
    agent = _build_agent(insurance_type)
    message = _to_agent_message(payload)
    res = agent(message)
    res_str = str(res)
    # Extract fenced JSON if present
    fence = re.search(r"```json\s*(.*?)\s*```", res_str, re.DOTALL)
    if fence:
        res_str = fence.group(1)
    try:
        return json.loads(res_str)
    except Exception:
        obj = re.search(r"\{[\s\S]*\}", res_str)
        return json.loads(obj.group(0)) if obj else {"total_score": 0, "impairment_scores": []}


def _write_trace(job_id: str, trace_obj: dict) -> str | None:
    if not (TRACE_BUCKET and job_id):
        return None
    key = f"analysis-traces/{job_id}/scoring-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    s3.put_object(Bucket=TRACE_BUCKET, Key=key, Body=json.dumps(trace_obj).encode('utf-8'), ContentType='application/json')
    return key


def lambda_handler(event, context):
    # Normalize event to dict if a JSON string is passed through
    if isinstance(event, str):
        try:
            event = json.loads(event)
        except Exception:
            pass
    print('[score] Event:', json.dumps(event)[:2000])
    job_id = _extract_job_id(event)

    # Mark status as SCORING at the start of this step
    if job_id and JOBS_TABLE_NAME:
        try:
            ts = datetime.now(timezone.utc).isoformat()
            dynamodb.update_item(
                TableName=JOBS_TABLE_NAME,
                Key={'jobId': {'S': job_id}},
                UpdateExpression='SET #s = :s, #t = :t',
                ExpressionAttributeNames={'#s': 'status', '#t': 'scoringStartTimestamp'},
                ExpressionAttributeValues={':s': {'S': 'SCORING'}, ':t': {'S': ts}}
            )
        except Exception:
            pass

    # Build payload for the scoring agent
    impairments_payload = _get_impairments_payload(event)

    # Determine insurance type from event or DynamoDB
    insurance_type: str | None = None
    try:
        classification = event.get('classification') if isinstance(event, dict) else None
        insurance_type = (classification or {}).get('insuranceType')
        if (not insurance_type) and job_id and JOBS_TABLE_NAME:
            resp = dynamodb.get_item(TableName=JOBS_TABLE_NAME, Key={'jobId': {'S': job_id}}, ProjectionExpression='insuranceType')
            item = resp.get('Item') or {}
            insurance_type = (item.get('insuranceType') or {}).get('S')
    except Exception:
        insurance_type = insurance_type or 'property_casualty'

    # Run the Strands scoring agent; preserve raw output
    agent_raw: dict
    try:
        agent_raw = _run_agent_scoring(impairments_payload, insurance_type)
    except Exception as e:
        print('[score] Agent scoring error:', str(e))
        agent_raw = {"total_score": 0, "impairment_scores": []}

    # Write trace
    safe_event_keys = list(event.keys()) if isinstance(event, dict) else []
    trace_key = _write_trace(job_id, {
        'eventKeys': safe_event_keys,
        'payloadCount': len(impairments_payload or []),
        'agentRaw': agent_raw
    })
    if trace_key:
        agent_raw['traceS3Key'] = trace_key

    # Persist raw agent JSON to DynamoDB if job id present
    if job_id and JOBS_TABLE_NAME:
        try:
            ts = datetime.now(timezone.utc).isoformat()
            dynamodb.update_item(
                TableName=JOBS_TABLE_NAME,
                Key={'jobId': {'S': job_id}},
                UpdateExpression='SET #as = :as, #st = :st',
                ExpressionAttributeNames={'#as': 'analysisScoringJsonStr', '#st': 'scoringTimestamp'},
                ExpressionAttributeValues={':as': {'S': json.dumps(agent_raw)}, ':st': {'S': ts}}
            )
        except Exception as e:
            print('[score] DynamoDB update error:', str(e))

    return {
        'status': 'SUCCESS',
        'message': 'Scoring completed',
        'scoring': agent_raw
    }


