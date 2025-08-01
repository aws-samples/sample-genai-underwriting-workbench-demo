import json
import boto3
import os
import uuid
from datetime import datetime, timezone, timedelta

# Initialize AWS clients
s3 = boto3.client('s3')
dynamodb = boto3.client('dynamodb')
stepfunctions = boto3.client('stepfunctions')

# Environment variables
DOCUMENT_BUCKET = os.environ.get('DOCUMENT_BUCKET')
STATE_MACHINE_ARN = os.environ.get('STATE_MACHINE_ARN')
JOBS_TABLE_NAME = os.environ.get('JOBS_TABLE_NAME')

def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    
    # Extract HTTP method and path from the event
    http_method = event.get('httpMethod', '')
    resource = event.get('resource', '')
    path_parameters = event.get('pathParameters', {}) or {}
    
    # Set CORS headers for all responses
    headers = {
        'Access-Control-Allow-Origin': '*',  # Allow all origins
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Content-Type': 'application/json'
    }
    
    # Handle OPTIONS requests for CORS preflight
    if http_method == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({'message': 'CORS preflight request successful'})
        }
    
    try:
        # Route based on HTTP method and resource path
        if http_method == 'GET' and resource == '/api/jobs':
            # List all jobs
            response = list_jobs()
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps(response)
            }
            
        elif http_method == 'GET' and resource == '/api/jobs/{jobId}':
            # Get specific job by ID
            job_id = path_parameters.get('jobId')
            if not job_id:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'Missing jobId parameter'})
                }
            
            response = get_job(job_id)
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps(response)
            }
            
        elif http_method == 'GET' and resource == '/api/jobs/{jobId}/document-url':
            # Get presigned URL for a document
            job_id = path_parameters.get('jobId')
            if not job_id:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'Missing jobId parameter'})
                }
            
            response = get_document_presigned_url(job_id)
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps(response)
            }
            
        elif http_method == 'POST' and resource == '/api/documents/upload':
            # Generate presigned URL for document upload
            response = generate_upload_url(event)
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps(response)
            }
            
        else:
            return {
                'statusCode': 404,
                'headers': headers,
                'body': json.dumps({'error': 'Not found'})
            }
            
    except Exception as e:
        print(f"Error processing request: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': f'Internal server error: {str(e)}'})
        }

def list_jobs():
    """List all jobs from DynamoDB, sorted newest first."""
    try:
        # Initial scan parameters
        scan_kwargs = {
            'TableName': JOBS_TABLE_NAME,
            'ProjectionExpression': "jobId, #s, uploadTimestamp, originalFilename, documentType, insuranceType",
            'ExpressionAttributeNames': {'#s': 'status'}
        }

        all_items = []
        while True:
            response = dynamodb.scan(**scan_kwargs)
            all_items.extend(response.get('Items', []))

            # If there's more data, keep scanning
            last_key = response.get('LastEvaluatedKey')
            if last_key:
                scan_kwargs['ExclusiveStartKey'] = last_key
            else:
                break

        # Transform DynamoDB items into plain dicts
        jobs = []
        for item in all_items:
            jobs.append({
                'jobId': item.get('jobId', {}).get('S', ''),
                'status': item.get('status', {}).get('S', ''),
                'uploadTimestamp': item.get('uploadTimestamp', {}).get('S', ''),
                'originalFilename': item.get('originalFilename', {}).get('S', ''),
                'documentType': item.get('documentType', {}).get('S', ''),
                'insuranceType': item.get('insuranceType', {}).get('S', '')
            })
        # Sort by uploadTimestamp descending (newest first)
        jobs.sort(key=lambda x: x.get('uploadTimestamp', ''), reverse=True)
        
        return {
            'jobs': jobs,
            'count': len(jobs)
        }
    
    except Exception as e:
        print(f"Error listing jobs: {str(e)}")
        raise
        
def get_job(job_id):
    """Get a specific job by ID from DynamoDB"""
    try:
        response = dynamodb.get_item(
            TableName=JOBS_TABLE_NAME,
            Key={'jobId': {'S': job_id}}
        )
        
        if 'Item' not in response:
            return {'error': f'Job {job_id} not found'}
        
        item = response['Item']
        
        # Extract basic job information
        job = {
            'jobId': item.get('jobId', {}).get('S', ''),
            'status': item.get('status', {}).get('S', ''),
            'uploadTimestamp': item.get('uploadTimestamp', {}).get('S', ''),
            'originalFilename': item.get('originalFilename', {}).get('S', ''),
            's3Key': item.get('s3Key', {}).get('S', ''),
            'documentType': item.get('documentType', {}).get('S', ''),
            'insuranceType': item.get('insuranceType', {}).get('S', '')
        }
        
        # Add extracted data if available
        if 'extractedDataJsonStr' in item:
            try:
                extracted_data = json.loads(item['extractedDataJsonStr']['S'])
                job['extractedData'] = extracted_data
            except:
                job['extractedData'] = {}
        
        # Add analysis output if available
        if 'analysisOutputJsonStr' in item:
            try:
                analysis_output = json.loads(item['analysisOutputJsonStr']['S'])
                job['analysisOutput'] = analysis_output
            except:
                job['analysisOutput'] = {}
        
        # Add agent action output if available
        if 'agentActionOutputJsonStr' in item:
            try:
                agent_output = json.loads(item['agentActionOutputJsonStr']['S'])
                job['agentActionOutput'] = agent_output
            except:
                job['agentActionOutput'] = {}
        
        return job
    
    except Exception as e:
        print(f"Error getting job {job_id}: {str(e)}")
        raise

def get_document_presigned_url(job_id):
    """Generate a presigned URL for a document associated with a job"""
    try:
        # Get the job details to find the S3 key
        response = dynamodb.get_item(
            TableName=JOBS_TABLE_NAME,
            Key={'jobId': {'S': job_id}},
            ProjectionExpression='s3Key'
        )
        
        if 'Item' not in response:
            return {'error': f'Job {job_id} not found'}
        
        item = response['Item']
        s3_key = item.get('s3Key', {}).get('S')
        
        if not s3_key:
            return {'error': f'No document found for job {job_id}'}

        # Generate a presigned URL for viewing the document
        presigned_url = s3.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': DOCUMENT_BUCKET,
                'Key': s3_key
            },
            ExpiresIn=3600  # URL valid for 1 hour
        )
        
        return {'documentUrl': presigned_url}

    except Exception as e:
        print(f"Error generating presigned URL for job {job_id}: {str(e)}")
        raise

def generate_upload_url(event):
    """Generate a presigned URL for document upload and create initial job record"""
    try:
        # Parse request body for filename and insurance type
        body = json.loads(event.get('body', '{}'))
        filename = body.get('filename')
        insurance_type = body.get('insuranceType', 'property_casualty')  # Default to P&C if not specified
        
        # Validate insurance type
        if insurance_type not in ['life', 'property_casualty']:
            insurance_type = 'property_casualty'  # Default to P&C if invalid
        
        if not filename:
            return {'error': 'Missing filename in request'}
            
        # Generate a unique job ID
        job_id = str(uuid.uuid4())
        
        # Create S3 key with path structure
        s3_key = f"uploads/{job_id}/{filename}"
        
        # Generate a presigned URL for uploading the document
        presigned_url = s3.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': DOCUMENT_BUCKET,
                'Key': s3_key,
                'ContentType': 'application/pdf'
            },
            ExpiresIn=300  # URL valid for 5 minutes
        )
        
        # Create initial job record in DynamoDB
        timestamp_now = datetime.now(timezone.utc).isoformat()
        dynamodb.put_item(
            TableName=JOBS_TABLE_NAME,
            Item={
                'jobId': {'S': job_id},
                'status': {'S': 'CREATED'},
                'uploadTimestamp': {'S': timestamp_now},
                'originalFilename': {'S': filename},
                's3Key': {'S': s3_key},
                'insuranceType': {'S': insurance_type}
            }
        )
        
        return {
            'jobId': job_id,
            'uploadUrl': presigned_url,
            's3Key': s3_key,
            'status': 'CREATED',
            'insuranceType': insurance_type,
            'message': 'Upload URL generated successfully'
        }
    
    except Exception as e:
        print(f"Error generating upload URL: {str(e)}")
        raise