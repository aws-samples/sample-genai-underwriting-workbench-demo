import boto3
import json
import os

def lambda_handler(event, context):
    bedrock_agent = boto3.client('bedrock-agent')
    
    try:
        if event['RequestType'] in ['Create', 'Update']:
            response = bedrock_agent.start_ingestion_job(
                knowledgeBaseId=event['ResourceProperties']['knowledgeBaseId'],
                dataSourceId=event['ResourceProperties']['dataSourceId'],
                description='Ingestion job started via CloudFormation custom resource'
            )
            
            return {
                'PhysicalResourceId': response['ingestionJob']['ingestionJobId'],
                'Data': {
                    'IngestionJobId': response['ingestionJob']['ingestionJobId'],
                    'Status': response['ingestionJob']['status']
                }
            }
        elif event['RequestType'] == 'Delete':
            # No need to do anything on delete, as the ingestion job is not a persistent resource
            return {
                'PhysicalResourceId': event['PhysicalResourceId']
            }
    except Exception as e:
        print(f"Error: {str(e)}")
        raise e