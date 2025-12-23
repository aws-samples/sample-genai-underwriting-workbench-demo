import json
import boto3
import os
import io
import urllib.parse
import re
import gc
import time
import traceback
from botocore.config import Config
from botocore.exceptions import ClientError
from datetime import datetime, timezone
from pdf2image import pdfinfo_from_path, convert_from_path
from PIL import Image, ImageOps

def log_timing(operation_name, start_time):
    """Log the duration of an operation"""
    elapsed = time.time() - start_time
    print(f"[TIMING] {operation_name} completed in {elapsed:.2f}s")

# Configure retry settings for AWS clients
# Configure retry settings for Bedrock client only
bedrock_retry_config = Config(
    retries={
        'max_attempts': 10,
        'mode': 'adaptive'
    },
    max_pool_connections=50
)

# Initialize AWS clients outside the handler for reuse
s3 = boto3.client('s3')
bedrock_runtime = boto3.client(service_name='bedrock-runtime', config=bedrock_retry_config)
dynamodb_client = boto3.client('dynamodb')
JOBS_TABLE = os.environ.get('JOBS_TABLE_NAME')
BATCH_SIZE = 1
DPI = 150
MAX_DIMENSION = 8000


def get_language_instruction(language: str) -> str:
    """Get language instruction to append to prompts for multilingual support"""
    language_map = {
        'en-US': 'Respond in English. All extracted field names, section headers, and values should be in English.',
        'zh-CN': 'Respond in Simplified Chinese (简体中文). All extracted field names, section headers, and values should be in Simplified Chinese.',
        'ja-JP': 'Respond in Japanese (日本語). All extracted field names, section headers, and values should be in Japanese.',
        'es-ES': 'Respond in Spanish (Español). All extracted field names, section headers, and values should be in Spanish.',
        'fr-FR': 'Respond in French (Français). All extracted field names, section headers, and values should be in French.',
        'fr-CA': 'Respond in Canadian French (Français canadien). All extracted field names, section headers, and values should be in Canadian French.',
        'de-DE': 'Respond in German (Deutsch). All extracted field names, section headers, and values should be in German.',
        'it-IT': 'Respond in Italian (Italiano). All extracted field names, section headers, and values should be in Italian.',
    }
    return language_map.get(language, 'Respond in English. All extracted field names, section headers, and values should be in English.')

def get_extraction_prompt(document_type, insurance_type, page_numbers, previous_analysis_json="{}", language_instruction=""):
    """Get the appropriate extraction prompt for a batch of pages, considering previous analysis."""
    
    # Base prompt
    base_prompt = f"""You are an underwriting assistant analyzing pages {page_numbers} from a document submission.
The overall document has been classified as: {document_type}
The insurance type is: {insurance_type}

Analysis of previous pages (if any):
```json
{previous_analysis_json}
```

**Your Task:**
1. For each new page image provided in this batch, perform two tasks:
    a. **Classify the page**: Identify a specific sub-document type for the page (e.g., "Applicant Information", "Medical History", "Attending Physician Statement", "Lab Results", "Prescription History").
    b. **Extract all data**: Extract all key-value pairs of information from the page.
2. **Structure your output**: Group the extracted data for each page under its classified sub-document type.
3. **Maintain Consistency**: If a page's type matches a key from the "Analysis of previous pages", you will group it with those pages. If it's a new type, you will create a new key.
4. **Return ONLY a JSON object** that contains the analysis for the **CURRENT BATCH of pages**. Do not repeat the `previous_analysis_json` in your output.

**Important Guidelines:**
- The keys in your JSON output should be the sub-document types.
- The values should be a list of page objects.
- Each page object must include a `"page_number"` and all other data you extracted.
- If a page is blank or contains no extractable information, return an object with just the page number and a note, like `{{"page_number": 1, "status": "No information found"}}`.
- Do not include any explanations or text outside of the final JSON object.
- IMPORTANT: {language_instruction}

**Example Output Format:**
```json
{{
  "Applicant Information": [
    {{
      "page_number": 1,
      "full_name": "John Doe",
      "date_of_birth": "1980-01-15",
      "address": "123 Main St, Anytown, USA"
    }}
  ],
  "Medical History": [
    {{
      "page_number": 2,
      "condition": "Hypertension",
      "diagnosed_date": "2015-06-20",
      "treatment": "Lisinopril"
    }}
  ]
}}
```

Here come the images for pages {page_numbers}:
"""
    return base_prompt


def update_job_status(job_id, status, error_message=None):
    """Update job status in DynamoDB"""
    try:
        now = datetime.now(timezone.utc).isoformat()
        update_expression = "SET #s = :s, #t = :t"
        expression_attribute_names = {'#s': 'status', '#t': 'lastUpdated'}
        expression_attribute_values = {':s': {'S': status}, ':t': {'S': now}}
        
        if error_message:
            update_expression += ", #e = :e"
            expression_attribute_names['#e'] = 'errorMessage'
            expression_attribute_values[':e'] = {'S': error_message}
        
        dynamodb_client.update_item(
            TableName=JOBS_TABLE,
            Key={'jobId': {'S': job_id}},
            UpdateExpression=update_expression,
            ExpressionAttributeNames=expression_attribute_names,
            ExpressionAttributeValues=expression_attribute_values,
        )
        print(f"Updated job {job_id} status to {status}")
    except Exception as e:
        print(f"Failed to update job status: {e}")


def lambda_handler(event, context):
    handler_start = time.time()
    print(f"[extract] === EXTRACT LAMBDA START === remaining_time={context.get_remaining_time_in_millis()}ms")
    print(f"[extract] Event keys: {list(event.keys()) if isinstance(event, dict) else 'not a dict'}")
    print(f"[extract] Event size: {len(json.dumps(event))} bytes")
    batch_data = {}        # make sure this exists no matter what
    job_id = None
    
    # --- 1) Parse event ---
    print(f"[extract] Step 1: Parsing event, remaining_time={context.get_remaining_time_in_millis()}ms")
    try:
        bucket = event['detail']['bucket']['name']
        key = urllib.parse.unquote_plus(event['detail']['object']['key'])
        job_id = event['classification']['jobId']
        doc_type = event['classification']['classification']
        ins_type = event['classification']['insuranceType']
        print(f"[extract] bucket={bucket}, key={key}")
        print(f"[extract] job_id={job_id}, doc_type={doc_type}, ins_type={ins_type}")
    except Exception as e:
        error_msg = f"Invalid event format: {e}"
        print(f"[extract] ERROR: {error_msg}")
        traceback.print_exc()
        if job_id:
            update_job_status(job_id, "FAILED", error_msg)
        return {"status": "ERROR", "message": error_msg}

    # --- 2) Mark EXTRACTING in DynamoDB and get user language ---
    print(f"[extract] Step 2: Updating status to EXTRACTING and getting user language, remaining_time={context.get_remaining_time_in_millis()}ms")
    user_language = 'en-US'  # Default
    if job_id and JOBS_TABLE:
        try:
            # Get userLanguage from DynamoDB
            resp = dynamodb_client.get_item(
                TableName=JOBS_TABLE,
                Key={'jobId': {'S': job_id}},
                ProjectionExpression='userLanguage'
            )
            item = resp.get('Item', {})
            user_language = (item.get('userLanguage') or {}).get('S') or 'en-US'
            print(f"[extract] User language for job {job_id}: {user_language}")
        except Exception as e:
            print(f"[extract] Error reading userLanguage: {e}")
        
        try:
            now = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=JOBS_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #s = :s, #t = :t",
                ExpressionAttributeNames={'#s': 'status', '#t': 'extractionStartTimestamp'},
                ExpressionAttributeValues={':s': {'S': 'EXTRACTING'}, ':t': {'S': now}},
            )
            print(f"[extract] Updated status to EXTRACTING for job {job_id}")
        except Exception as e:
            print(f"[extract] WARNING: Failed to update status: {e}")

    # --- Main processing with comprehensive error handling ---
    try:
        # --- 3) Download PDF locally ---
        print(f"[extract] Step 3: Downloading PDF from S3, remaining_time={context.get_remaining_time_in_millis()}ms")
        local_path = f"/tmp/{os.path.basename(key)}"
        s3_download_start = time.time()
        try:
            s3.download_file(bucket, key, local_path)
            log_timing("S3 download", s3_download_start)
            file_size = os.path.getsize(local_path)
            print(f"[extract] Downloaded PDF, size={file_size} bytes")
        except Exception as e:
            log_timing("S3 download (FAILED)", s3_download_start)
            error_msg = f"S3 download failed: {e}"
            print(f"[extract] ERROR: {error_msg}")
            traceback.print_exc()
            update_job_status(job_id, "FAILED", error_msg)
            return {"status": "ERROR", "message": error_msg}

        # --- 4) Read total pages from PDF ---
        print(f"[extract] Step 4: Reading PDF info, remaining_time={context.get_remaining_time_in_millis()}ms")
        try:
            info = pdfinfo_from_path(local_path)
            total_pages_full = int(info.get("Pages", 0))
            print(f"[extract] PDF has {total_pages_full} total pages")
        except Exception as e:
            error_msg = f"Could not read PDF info: {e}"
            print(f"[extract] ERROR: {error_msg}")
            traceback.print_exc()
            update_job_status(job_id, "FAILED", error_msg)
            return {"status": "ERROR", "message": error_msg}

        # --- 5) Determine page batches (or single range) ---
        print(f"[extract] Step 5: Determining page batches, remaining_time={context.get_remaining_time_in_millis()}ms")
        page_range = event.get('pages')
        page_batches = []
        if page_range:
            # single batch from SF Map
            first_page = page_range.get('start', 1)
            last_page = page_range.get('end', first_page)
            page_batches.append((first_page, last_page))
            print(f"[extract] Processing single batch from SF Map: pages {first_page}-{last_page}")
        else:
            # full-document batching
            page = 1
            while page <= total_pages_full:
                last = min(page + BATCH_SIZE - 1, total_pages_full)
                page_batches.append((page, last))
                page = last + 1
            print(f"[extract] Full document batching: {len(page_batches)} batches")

        all_data = {}

        # --- 6) Process each batch in sequence (Step Functions will parallelize via Map) ---
        print(f"[extract] Step 6: Processing page batches, remaining_time={context.get_remaining_time_in_millis()}ms")
        for batch_idx, (first, last) in enumerate(page_batches):
            batch_start = time.time()
            print(f"[extract] Processing batch {batch_idx+1}/{len(page_batches)}: pages {first}-{last}, remaining_time={context.get_remaining_time_in_millis()}ms")
            
            # Convert only this batch to images
            convert_start = time.time()
            try:
                imgs = convert_from_path(
                    local_path,
                    dpi=DPI,
                    fmt='JPEG',
                    first_page=first,
                    last_page=last
                )
                log_timing(f"PDF to image conversion (pages {first}-{last})", convert_start)
                print(f"[extract] Converted {len(imgs)} page(s) to images")
            except Exception as e:
                log_timing(f"PDF to image conversion (FAILED)", convert_start)
                error_msg = f"PDF→image conversion failed for pages {first}–{last}: {e}"
                print(f"[extract] ERROR: {error_msg}")
                traceback.print_exc()
                update_job_status(job_id, "FAILED", error_msg)
                return {"status": "ERROR", "message": error_msg}

            # Build prompt & payload
            language_instruction = get_language_instruction(user_language)
            prompt = get_extraction_prompt(doc_type, ins_type, list(range(first, last+1)), json.dumps(all_data, indent=2), language_instruction)
            print(f"[extract] Extraction prompt size: {len(prompt)} chars")
            messages = [{"text": prompt}]
            total_image_bytes = 0
            for idx, img in enumerate(imgs, start=first):
                img = img.convert("L")
                img = ImageOps.crop(img, border=50)
                w, h = img.size
                if max(w, h) > MAX_DIMENSION:
                    scale = MAX_DIMENSION / float(max(w, h))
                    img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=60, optimize=True)
                payload_bytes = buf.getvalue()
                total_image_bytes += len(payload_bytes)
                buf.close()
                messages.append({"text": f"--- Image for Page {idx} ---"})
                messages.append({"image": {"format": "jpeg", "source": {"bytes": payload_bytes}}})
            print(f"[extract] Total image payload size: {total_image_bytes} bytes")

            # Call Bedrock Converse API
            bedrock_start = time.time()
            model_id = os.environ.get('BEDROCK_MODEL_ID')
            print(f"[extract] Calling Bedrock model {model_id}, remaining_time={context.get_remaining_time_in_millis()}ms")
            try:
                resp = bedrock_runtime.converse(
                    modelId=model_id,
                    messages=[{"role": "user", "content": messages}],
                    inferenceConfig={"maxTokens": 4096, "temperature": 0.0}
                )
                log_timing(f"Bedrock Converse API call (pages {first}-{last})", bedrock_start)
                # Log usage metrics if available
                usage = resp.get('usage', {})
                print(f"[extract] Bedrock usage: inputTokens={usage.get('inputTokens')}, outputTokens={usage.get('outputTokens')}")
            except Exception as e:
                log_timing(f"Bedrock Converse API call (FAILED)", bedrock_start)
                error_msg = f"Bedrock call failed for pages {first}–{last}: {e}"
                print(f"[extract] ERROR: {error_msg}")
                traceback.print_exc()
                update_job_status(job_id, "FAILED", error_msg)
                return {"status": "ERROR", "message": error_msg}

            # Extract JSON
            output = resp.get('output', {}).get('message', {})
            text = (output.get('content') or [{}])[0].get('text', '')
            print(f"[extract] Bedrock response text length: {len(text)} chars")
            match = (re.search(r'```json\s*([\s\S]*?)```', text, re.DOTALL)
                     or re.search(r'(\{[\s\S]*\})', text, re.DOTALL))
            if match:
                try:
                    batch_data = json.loads(match.group(1))
                    print(f"[extract] Parsed batch_data keys: {list(batch_data.keys())}")
                    for k, pages_list in batch_data.items():
                        all_data.setdefault(k, []).extend(pages_list or [])
                except Exception as parse_err:
                    print(f"[extract] WARNING: Failed to parse JSON from response: {parse_err}")
                    print(f"[extract] Response preview: {text[:500]}")
            else:
                print(f"[extract] WARNING: No JSON found in Bedrock response")
                print(f"[extract] Response preview: {text[:500]}")

            # Cleanup
            del imgs
            gc.collect()
            log_timing(f"Total batch {batch_idx+1} processing", batch_start)

        # --- 7) Cleanup & return ---
        print(f"[extract] Step 7: Cleanup and return, remaining_time={context.get_remaining_time_in_millis()}ms")
        try:
            os.remove(local_path)
            print(f"[extract] Cleaned up temporary file: {local_path}")
        except OSError as e:
            print(f"[extract] WARNING: Failed to cleanup temp file: {e}")

        chunk_key = f"{job_id}/extracted/{first_page}-{last_page}.json"
        batch_data_json = json.dumps(batch_data)
        print(f"[extract] Uploading extraction result to S3: {chunk_key}, size={len(batch_data_json)} bytes")
        s3_upload_start = time.time()
        s3.put_object(
            Bucket=os.environ['EXTRACTION_BUCKET'],
            Key=chunk_key,
            Body=batch_data_json,
        )
        log_timing("S3 upload extraction result", s3_upload_start)
        
        log_timing("Total EXTRACT lambda execution", handler_start)
        print(f"[extract] === EXTRACT LAMBDA COMPLETE === remaining_time={context.get_remaining_time_in_millis()}ms")
        result = {
            "pages": {"start": first_page, "end": last_page},
            "chunkS3Key": chunk_key
        }
        print(f"[extract] Returning result: {json.dumps(result)}")
        return result
        
    except Exception as e:
        # Catch any unexpected errors and update job status
        error_msg = f"Unexpected error during extraction: {str(e)}"
        print(f"[extract] ERROR: {error_msg}")
        traceback.print_exc()
        update_job_status(job_id, "FAILED", error_msg)
        log_timing("Total EXTRACT lambda execution (FAILED)", handler_start)
        print(f"[extract] === EXTRACT LAMBDA FAILED === remaining_time={context.get_remaining_time_in_millis()}ms")
        return {"status": "ERROR", "message": error_msg}