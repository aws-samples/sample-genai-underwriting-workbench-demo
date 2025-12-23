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
KB_SOURCE_BUCKET = os.environ.get('KB_SOURCE_BUCKET')

# Supported languages for multilingual responses
SUPPORTED_LANGUAGES = ['en-US', 'zh-CN', 'ja-JP', 'es-ES', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT']


def extract_language_from_request(event):
    """Extract user language preference from request headers"""
    headers = event.get('headers', {}) or {}
    # Headers can be case-insensitive, check both
    language = headers.get('X-User-Language') or headers.get('x-user-language')
    
    if language and language in SUPPORTED_LANGUAGES:
        return language
    return 'en-US'  # Default to English


def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    
    # Extract HTTP method and path from the event
    http_method = event.get('httpMethod', '')
    resource = event.get('resource', '')
    path_parameters = event.get('pathParameters', {}) or {}
    query_params = event.get('queryStringParameters') or {}
    
    # Set CORS headers for all responses
    headers = {
        'Access-Control-Allow-Origin': '*',  # Allow all origins
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-User-Language',
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
            
        elif http_method == 'POST' and resource == '/api/documents/batch-upload':
            # Generate presigned URLs for multiple document uploads
            response = generate_batch_upload_urls(event)
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps(response)
            }
            
        elif http_method == 'GET' and resource == '/api/policy':
            # Return presigned URL for markdown by key
            s3_key = query_params.get('key') if isinstance(query_params, dict) else None
            if not s3_key:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'Missing key parameter'})
                }
            url = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': KB_SOURCE_BUCKET, 'Key': s3_key},
                ExpiresIn=900
            )
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({'url': url})
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
            'ProjectionExpression': "jobId, #s, uploadTimestamp, originalFilename, documentType, insuranceType, batchId",
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
                'insuranceType': item.get('insuranceType', {}).get('S', ''),
                'batchId': item.get('batchId', {}).get('S', '')
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

        # Add detection output if available
        if 'analysisDetectionJsonStr' in item:
            try:
                detection_output = json.loads(item['analysisDetectionJsonStr']['S'])
                job['analysisDetection'] = detection_output
            except:
                job['analysisDetection'] = {}

        # Add scoring output if available
        if 'analysisScoringJsonStr' in item:
            try:
                scoring_output = json.loads(item['analysisScoringJsonStr']['S'])
                job['analysisScoring'] = scoring_output
            except:
                job['analysisScoring'] = {}
        
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
        
        # Extract user language preference from request headers
        user_language = extract_language_from_request(event)
            
        # Generate a unique job ID and batch ID
        job_id = str(uuid.uuid4())
        batch_id = str(uuid.uuid4())
        
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
                'batchId': {'S': batch_id},
                'status': {'S': 'CREATED'},
                'uploadTimestamp': {'S': timestamp_now},
                'originalFilename': {'S': filename},
                's3Key': {'S': s3_key},
                'insuranceType': {'S': insurance_type},
                'userLanguage': {'S': user_language}
            }
        )
        
        return {
            'jobId': job_id,
            'batchId': batch_id,
            'uploadUrl': presigned_url,
            's3Key': s3_key,
            'status': 'CREATED',
            'insuranceType': insurance_type,
            'message': 'Upload URL generated successfully'
        }
    
    except Exception as e:
        print(f"Error generating upload URL: {str(e)}")
        raise


def generate_batch_upload_urls(event):
    """Generate presigned URLs for multiple document uploads"""
    try:
        # Parse request body for files and insurance type
        body = json.loads(event.get('body', '{}'))
        files = body.get('files', [])
        insurance_type = body.get('insuranceType', 'property_casualty')  # Default to P&C if not specified
        
        # Validate insurance type
        if insurance_type not in ['life', 'property_casualty']:
            insurance_type = 'property_casualty'  # Default to P&C if invalid
            
        if not files or not isinstance(files, list):
            return {'error': 'Missing or invalid files array in request'}
        
        # Extract user language preference from request headers
        user_language = extract_language_from_request(event)
            
        # Generate a batch ID for grouping related uploads
        batch_id = str(uuid.uuid4())
        timestamp_now = datetime.now(timezone.utc).isoformat()
        
        upload_urls = []
        
        for file_info in files:
            filename = file_info.get('filename')
            if not filename:
                continue
                
            # Generate a unique job ID for each file
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
            
            # Create initial job record in DynamoDB with batch ID
            dynamodb.put_item(
                TableName=JOBS_TABLE_NAME,
                Item={
                    'jobId': {'S': job_id},
                    'batchId': {'S': batch_id},
                    'status': {'S': 'CREATED'},
                    'uploadTimestamp': {'S': timestamp_now},
                    'originalFilename': {'S': filename},
                    's3Key': {'S': s3_key},
                    'insuranceType': {'S': insurance_type},
                    'userLanguage': {'S': user_language}
                }
            )
            
            upload_urls.append({
                'jobId': job_id,
                'filename': filename,
                'uploadUrl': presigned_url,
                's3Key': s3_key
            })
        
        return {
            'batchId': batch_id,
            'uploadUrls': upload_urls,
            'insuranceType': insurance_type,
            'message': f'Generated {len(upload_urls)} upload URLs successfully'
        }
    
    except Exception as e:
        print(f"Error generating batch upload URLs: {str(e)}")
        raise