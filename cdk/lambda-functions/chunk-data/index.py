import json
import boto3
import os
from datetime import datetime, timezone

s3_client = boto3.client('s3')
dynamodb_client = boto3.client('dynamodb')

EXTRACTION_BUCKET = os.environ.get('EXTRACTION_BUCKET')
DB_TABLE = os.environ.get('JOBS_TABLE_NAME')

def chunk_extracted_data(extracted_data: dict, max_chunk_size: int = 500000) -> list:
    """
    Split extracted data into chunks that fit within token limits.
    Returns list of chunk metadata with S3 keys.
    """
    chunks = []
    current_chunk = {}
    current_size = 0
    
    for doc_type, pages in extracted_data.items():
        doc_json = json.dumps({doc_type: pages})
        doc_size = len(doc_json)
        
        # If adding this doc exceeds limit, save current chunk and start new one
        if current_size + doc_size > max_chunk_size and current_chunk:
            chunks.append(current_chunk)
            current_chunk = {}
            current_size = 0
        
        # If single doc type exceeds limit, split its pages
        if doc_size > max_chunk_size and isinstance(pages, list):
            # Calculate pages per chunk
            pages_json_size = len(json.dumps(pages))
            pages_per_chunk = max(1, int(len(pages) * (max_chunk_size / pages_json_size)))
            
            for i in range(0, len(pages), pages_per_chunk):
                page_subset = pages[i:i + pages_per_chunk]
                chunks.append({doc_type: page_subset})
        else:
            current_chunk[doc_type] = pages
            current_size += doc_size
    
    # Add remaining chunk
    if current_chunk:
        chunks.append(current_chunk)
    
    return chunks


def lambda_handler(event, context):
    print(f"[chunk-data] Received event: {json.dumps(event)}")
    
    job_id = event.get('classification', {}).get('jobId')
    chunk_type = event.get('chunkType', 'analysis')  # 'analysis' or 'detection'
    
    if not job_id:
        return {'error': 'Missing jobId'}
    
    # --- 1) Fetch & merge all extraction chunks from S3 ---
    print("[chunk-data] Merging extractionResults from S3")
    merged_data = {}
    raw_results = event.get('extractionResults', [])
    
    for idx, chunk_meta in enumerate(raw_results):
        key = chunk_meta.get('chunkS3Key')
        if not key:
            continue
        
        try:
            obj = s3_client.get_object(Bucket=EXTRACTION_BUCKET, Key=key)
            chunk_data = json.loads(obj['Body'].read().decode('utf-8'))
            
            for subdoc, pages_list in chunk_data.items():
                merged_data.setdefault(subdoc, []).extend(pages_list or [])
        except Exception as e:
            print(f"[chunk-data] Error fetching chunk {idx}: {e}")
            continue
    
    print(f"[chunk-data] Merged data keys: {list(merged_data.keys())}")
    
    # --- 2) Store merged extracted data in S3 and write to DynamoDB (only for analysis) ---
    if chunk_type == 'analysis' and job_id and DB_TABLE:
        try:
            ts = datetime.now(timezone.utc).isoformat()
            document_type = event.get('classification', {}).get('classification', 'Unknown')
            
            # Store merged extracted data in S3
            extracted_data_key = f"{job_id}/merged/merged.json"
            s3_client.put_object(
                Bucket=EXTRACTION_BUCKET,
                Key=extracted_data_key,
                Body=json.dumps(merged_data),
                ContentType='application/json'
            )
            s3_path = f"s3://{EXTRACTION_BUCKET}/{extracted_data_key}"
            print(f"[chunk-data] Stored merged extracted data in S3: {s3_path}")
            
            # Write S3 path to DynamoDB
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #dt = :dt, #ed = :ed, #et = :et",
                ExpressionAttributeNames={'#dt': 'documentType', '#ed': 'extractedDataJsonStr', '#et': 'extractionTimestamp'},
                ExpressionAttributeValues={
                    ':dt': {'S': document_type},
                    ':ed': {'S': s3_path},
                    ':et': {'S': ts}
                }
            )
            print(f"[chunk-data] Persisted S3 path to extractedDataJsonStr for job {job_id}")
        except Exception as e:
            print(f"[chunk-data] Error storing extractedDataJsonStr: {e}")
    
    # --- 3) Chunk the merged data ---
    chunks = chunk_extracted_data(merged_data)
    print(f"[chunk-data] Created {len(chunks)} chunks for {chunk_type}")
    
    # --- 4) Store each chunk in S3 and return metadata ---
    chunk_metadata = []
    for i, chunk in enumerate(chunks):
        chunk_key = f"{job_id}/{chunk_type}-chunks/chunk-{i}.json"
        s3_client.put_object(
            Bucket=EXTRACTION_BUCKET,
            Key=chunk_key,
            Body=json.dumps(chunk),
            ContentType='application/json'
        )
        
        chunk_metadata.append({
            'chunkId': i,
            'chunkS3Key': chunk_key,
            'documentTypes': list(chunk.keys())
        })
        print(f"[chunk-data] Stored chunk {i} at s3://{EXTRACTION_BUCKET}/{chunk_key}")
    
    return {
        'jobId': job_id,
        'totalChunks': len(chunks),
        'chunks': chunk_metadata,
        'chunkType': chunk_type
    }
