import pytest
import json
import sys
import os
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))

@pytest.fixture
def mock_env():
    """Mock environment variables"""
    with patch.dict(os.environ, {
        'DOCUMENT_BUCKET': 'test-bucket',
        'STATE_MACHINE_ARN': 'arn:aws:states:us-east-1:123456789012:stateMachine:test',
        'JOBS_TABLE_NAME': 'test-jobs-table',
        'KB_SOURCE_BUCKET': 'test-kb-bucket',
        'EXTRACTION_BUCKET': 'test-extraction-bucket'
    }):
        yield

@pytest.fixture
def mock_aws_clients(mock_env):
    """Mock AWS service clients"""
    with patch('index.s3') as mock_s3, \
         patch('index.dynamodb') as mock_dynamodb, \
         patch('index.stepfunctions') as mock_stepfunctions:
        yield {
            's3': mock_s3,
            'dynamodb': mock_dynamodb,
            'stepfunctions': mock_stepfunctions
        }

def test_cors_headers(mock_aws_clients):
    """Test that CORS headers are present in OPTIONS request"""
    import index
    
    event = {
        'httpMethod': 'OPTIONS',
        'resource': '/api/jobs',
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 200
    assert 'Access-Control-Allow-Origin' in response['headers']
    assert response['headers']['Access-Control-Allow-Origin'] == '*'
    assert 'Access-Control-Allow-Methods' in response['headers']

def test_list_jobs_empty(mock_aws_clients):
    """Test listing jobs when table is empty"""
    import index
    
    mock_aws_clients['dynamodb'].scan.return_value = {'Items': []}
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/jobs',
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['count'] == 0
    assert body['jobs'] == []

def test_list_jobs_with_data(mock_aws_clients):
    """Test listing jobs with data"""
    import index
    
    mock_aws_clients['dynamodb'].scan.return_value = {
        'Items': [
            {
                'jobId': {'S': 'job-1'},
                'status': {'S': 'completed'},
                'uploadTimestamp': {'S': '2024-01-01T10:00:00Z'},
                'originalFilename': {'S': 'test.pdf'},
                'documentType': {'S': 'LIFE_INSURANCE_APPLICATION'},
                'insuranceType': {'S': 'life'},
                'batchId': {'S': 'batch-1'}
            }
        ]
    }
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/jobs',
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['count'] == 1
    assert body['jobs'][0]['jobId'] == 'job-1'
    assert body['jobs'][0]['status'] == 'completed'

def test_get_job_not_found(mock_aws_clients):
    """Test getting a job that doesn't exist"""
    import index
    
    mock_aws_clients['dynamodb'].get_item.return_value = {}
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/jobs/{jobId}',
        'pathParameters': {'jobId': 'nonexistent'},
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert 'error' in body

def test_get_job_success(mock_aws_clients):
    """Test getting a job successfully"""
    import index
    
    mock_aws_clients['dynamodb'].get_item.return_value = {
        'Item': {
            'jobId': {'S': 'job-1'},
            'status': {'S': 'completed'},
            'uploadTimestamp': {'S': '2024-01-01T10:00:00Z'},
            'originalFilename': {'S': 'test.pdf'},
            's3Key': {'S': 'documents/test.pdf'},
            'documentType': {'S': 'LIFE_INSURANCE_APPLICATION'},
            'insuranceType': {'S': 'life'}
        }
    }
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/jobs/{jobId}',
        'pathParameters': {'jobId': 'job-1'},
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 200
    body = json.loads(response['body'])
    assert body['jobId'] == 'job-1'
    assert body['status'] == 'completed'

def test_missing_job_id_parameter(mock_aws_clients):
    """Test error when jobId parameter is missing"""
    import index
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/jobs/{jobId}',
        'pathParameters': {},
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 400
    body = json.loads(response['body'])
    assert 'error' in body

def test_not_found_route(mock_aws_clients):
    """Test 404 for unknown route"""
    import index
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/unknown',
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 404

def test_extract_language_from_request():
    """Test language extraction from headers"""
    import index
    
    # Test with valid language
    event = {'headers': {'X-User-Language': 'es-ES'}}
    assert index.extract_language_from_request(event) == 'es-ES'
    
    # Test with lowercase header
    event = {'headers': {'x-user-language': 'fr-FR'}}
    assert index.extract_language_from_request(event) == 'fr-FR'
    
    # Test with invalid language
    event = {'headers': {'X-User-Language': 'invalid'}}
    assert index.extract_language_from_request(event) == 'en-US'
    
    # Test with no header
    event = {'headers': {}}
    assert index.extract_language_from_request(event) == 'en-US'

def test_error_handling(mock_aws_clients):
    """Test error handling for exceptions"""
    import index
    
    mock_aws_clients['dynamodb'].scan.side_effect = Exception('DynamoDB error')
    
    event = {
        'httpMethod': 'GET',
        'resource': '/api/jobs',
        'headers': {}
    }
    
    response = index.lambda_handler(event, None)
    
    assert response['statusCode'] == 500
    body = json.loads(response['body'])
    assert 'error' in body
