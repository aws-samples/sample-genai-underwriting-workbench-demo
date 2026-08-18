import json
import boto3
import os
from datetime import datetime, timezone

dynamodb_client = boto3.client('dynamodb')
s3_client = boto3.client('s3')

DB_TABLE = os.environ.get('JOBS_TABLE_NAME')
TRACE_BUCKET = os.environ.get('TRACE_BUCKET')


def aggregate_analysis_results(chunk_results: list) -> dict:
    """
    Merge multiple chunk analysis results into a single comprehensive result.
    """
    print(f"[aggregate] Aggregating {len(chunk_results)} chunk results")
    
    # Log any errors
    error_chunks = [r for r in chunk_results if 'error' in r]
    if error_chunks:
        print(f"[aggregate] WARNING: {len(error_chunks)} chunks had errors:")
        for err_chunk in error_chunks:
            print(f"  - Chunk {err_chunk.get('chunkId', '?')}: {err_chunk.get('error', 'Unknown error')}")
    
    # Filter out error results
    valid_results = [r for r in chunk_results if 'error' not in r]
    if not valid_results:
        return {'error': 'All chunks failed to analyze', 'failed_chunks': len(chunk_results)}
    
    print(f"[aggregate] {len(valid_results)} valid results out of {len(chunk_results)}")
    
    # Aggregate fields
    aggregated = {
        "overall_summary": " ".join([r.get("overall_summary", "") for r in valid_results]).strip(),
        "identified_risks": [],
        "discrepancies": [],
        "medical_timeline": "",
        "property_assessment": "",
        "final_recommendation": "",
        "missing_information": [],
        "confidence_score": 0.0
    }
    
    # Combine risks
    for result in valid_results:
        aggregated["identified_risks"].extend(result.get("identified_risks", []))
    
    # Combine discrepancies
    for result in valid_results:
        aggregated["discrepancies"].extend(result.get("discrepancies", []))
    
    # Combine missing information (deduplicate by item_description)
    seen_missing = set()
    for result in valid_results:
        for item in result.get("missing_information", []):
            desc = item.get("item_description", "")
            if desc and desc not in seen_missing:
                aggregated["missing_information"].append(item)
                seen_missing.add(desc)
    
    # Combine medical timeline
    timelines = [r.get("medical_timeline", "") for r in valid_results if r.get("medical_timeline") and r.get("medical_timeline") != "N/A"]
    if timelines:
        aggregated["medical_timeline"] = "\n\n".join(timelines)
    else:
        aggregated["medical_timeline"] = "N/A"
    
    # Combine property assessment
    assessments = [r.get("property_assessment", "") for r in valid_results if r.get("property_assessment") and r.get("property_assessment") != "N/A"]
    if assessments:
        aggregated["property_assessment"] = "\n\n".join(assessments)
    else:
        aggregated["property_assessment"] = "N/A"
    
    # Combine recommendations
    recommendations = [r.get("final_recommendation", "") for r in valid_results if r.get("final_recommendation")]
    if recommendations:
        aggregated["final_recommendation"] = "\n\n".join(recommendations)
    
    # Average confidence scores
    scores = [r.get("confidence_score", 0.75) for r in valid_results if isinstance(r.get("confidence_score"), (int, float))]
    if scores:
        aggregated["confidence_score"] = sum(scores) / len(scores)
    else:
        aggregated["confidence_score"] = 0.75
    
    print(f"[aggregate] Aggregated: {len(aggregated['identified_risks'])} risks, {len(aggregated['discrepancies'])} discrepancies")
    
    return aggregated


def lambda_handler(event, context):
    print(f"[aggregate-analysis] Received event: {json.dumps(event)}")
    
    job_id = event.get('jobId')
    chunk_results = event.get('chunkResults', [])
    classification = event.get('classification', {})
    document_type = classification.get('classification', 'Unknown')
    
    if not job_id:
        return {'error': 'Missing jobId'}
    
    if not chunk_results:
        return {'error': 'No chunk results to aggregate'}
    
    # Update status to ANALYZING
    if DB_TABLE:
        try:
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression='SET #status = :s, lastUpdated = :t',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':s': {'S': 'ANALYZING'}, ':t': {'S': now}}
            )
            print(f"[aggregate-analysis] Updated status to ANALYZING for job {job_id}")
        except Exception as e:
            print(f"[aggregate-analysis] WARNING: Failed to update status: {e}")
    
    # --- 1) Aggregate results ---
    aggregated_result = aggregate_analysis_results(chunk_results)
    
    if 'error' in aggregated_result:
        return aggregated_result
    
    # --- 2) Store trace in S3 ---
    if TRACE_BUCKET:
        try:
            trace_key = f"analysis-traces/{job_id}/aggregated-analysis.json"
            s3_client.put_object(
                Bucket=TRACE_BUCKET,
                Key=trace_key,
                Body=json.dumps(aggregated_result, indent=2),
                ContentType='application/json'
            )
            print(f"[aggregate-analysis] Stored trace at s3://{TRACE_BUCKET}/{trace_key}")
        except Exception as e:
            print(f"[aggregate-analysis] Error storing trace: {e}")
    
    # --- 3) Persist to DynamoDB ---
    if DB_TABLE:
        try:
            ts = datetime.now(timezone.utc).isoformat()
            dynamodb_client.update_item(
                TableName=DB_TABLE,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #ao = :ao, #at = :at",
                ExpressionAttributeNames={'#ao': 'analysisOutputJsonStr', '#at': 'analysisTimestamp'},
                ExpressionAttributeValues={
                    ':ao': {'S': json.dumps(aggregated_result)},
                    ':at': {'S': ts}
                }
            )
            print(f"[aggregate-analysis] Persisted aggregated analysis for job {job_id}")
        except Exception as e:
            print(f"[aggregate-analysis] Error persisting to DynamoDB: {e}")
            return {'error': f'Failed to persist: {str(e)}'}
    
    return {
        'status': 'success',
        'message': 'Analysis aggregated successfully',
        'analysisOutput': aggregated_result
    }
