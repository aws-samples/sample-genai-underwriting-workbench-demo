import json
import boto3
import os
from datetime import datetime, timezone

dynamodb_client = boto3.client('dynamodb')
s3_client = boto3.client('s3')

DB_TABLE = os.environ.get('JOBS_TABLE_NAME')
TRACE_BUCKET = os.environ.get('TRACE_BUCKET')


def aggregate_detection_results(chunk_results: list) -> dict:
    """Merge multiple chunk detection results into a single result"""
    print(f"[aggregate-detection] Aggregating {len(chunk_results)} chunk results")
    
    # Log any errors
    error_chunks = [r for r in chunk_results if 'error' in r]
    if error_chunks:
        print(f"[aggregate-detection] WARNING: {len(error_chunks)} chunks had errors:")
        for err_chunk in error_chunks:
            print(f"  - Chunk {err_chunk.get('chunkId', '?')}: {err_chunk.get('error', 'Unknown error')}")
    
    # Filter out error results
    valid_results = [r for r in chunk_results if 'error' not in r]
    if not valid_results:
        return {'error': 'All chunks failed to detect', 'failed_chunks': len(chunk_results)}
    
    print(f"[aggregate-detection] {len(valid_results)} valid results")
    
    aggregated = {
        "impairments": [],
        "narrative": ""
    }
    
    # Combine impairments (deduplicate by impairment_id)
    seen_impairments = {}
    for result in valid_results:
        for imp in result.get("impairments", []):
            imp_id = imp.get("impairment_id", "")
            if imp_id in seen_impairments:
                # Merge evidence and scoring factors
                existing = seen_impairments[imp_id]
                existing["evidence"] = list(set(existing.get("evidence", []) + imp.get("evidence", [])))
                existing["scoring_factors"].update(imp.get("scoring_factors", {}))
            else:
                seen_impairments[imp_id] = imp
    
    aggregated["impairments"] = list(seen_impairments.values())
    
    # Combine narratives
    narratives = [r.get("narrative", "") for r in valid_results if r.get("narrative")]
    if narratives:
        aggregated["narrative"] = "\n\n".join(narratives)
    
    print(f"[aggregate-detection] Aggregated: {len(aggregated['impairments'])} impairments")
    
    return aggregated


def lambda_handler(event, context):
    print(f"[aggregate-detection] Received event: {json.dumps(event)}")
    
    job_id = event.get('jobId')
    chunk_results = event.get('chunkResults', [])
    classification = event.get('classification', {})
    
    if not job_id:
        return {'error': 'Missing jobId'}
    
    if not chunk_results:
        return {'error': 'No chunk results to aggregate'}
    
    # Update status to DETECTING
    if DB_TABLE:
        try:
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression='SET #status = :s, lastUpdated = :t',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':s': {'S': 'DETECTING'}, ':t': {'S': now}}
            )
            print(f"[aggregate-detection] Updated status to DETECTING for job {job_id}")
        except Exception as e:
            print(f"[aggregate-detection] WARNING: Failed to update status: {e}")
    
    # Aggregate results
    aggregated_result = aggregate_detection_results(chunk_results)
    
    if 'error' in aggregated_result:
        return aggregated_result
    
    # Store trace in S3
    if TRACE_BUCKET:
        try:
            trace_key = f"detection-traces/{job_id}/aggregated-detection.json"
            s3_client.put_object(
                Bucket=TRACE_BUCKET,
                Key=trace_key,
                Body=json.dumps(aggregated_result, indent=2),
                ContentType='application/json'
            )
            print(f"[aggregate-detection] Stored trace at s3://{TRACE_BUCKET}/{trace_key}")
        except Exception as e:
            print(f"[aggregate-detection] Error storing trace: {e}")
    
    # Persist to DynamoDB
    if DB_TABLE:
        try:
            ts = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #ad = :ad, #dt = :dt",
                ExpressionAttributeNames={'#ad': 'analysisDetectionJsonStr', '#dt': 'detectionTimestamp'},
                ExpressionAttributeValues={
                    ':ad': {'S': json.dumps(aggregated_result)},
                    ':dt': {'S': ts}
                }
            )
            print(f"[aggregate-detection] Persisted aggregated detection for job {job_id}")
        except Exception as e:
            print(f"[aggregate-detection] Error persisting to DynamoDB: {e}")
            return {'error': f'Failed to persist: {str(e)}'}
    
    return {
        'status': 'success',
        'message': 'Detection aggregated successfully',
        'analysisDetection': aggregated_result
    }
