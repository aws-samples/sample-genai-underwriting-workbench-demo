import os
import json
import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth
from urllib.parse import urlparse
import time


def lambda_handler(event, context):
    if event['RequestType'] == 'Create':
        endpoint = os.environ['COLLECTION_ENDPOINT']
        # Match the vectorIndexName in the Knowledge Base config
        index_name = 'my_vector_index'
        region = os.environ['AWS_REGION']

        print(f"Endpoint: {endpoint}")
        print(f"Index Name: {index_name}")
        print(f"Region: {region}")

        # Parse the endpoint URL
        parsed_url = urlparse(endpoint)
        host = parsed_url.netloc

        # Create AWS credentials
        credentials = boto3.Session().get_credentials()
        awsauth = AWS4Auth(credentials.access_key, credentials.secret_key,
                           region, 'aoss', session_token=credentials.token)

        # Create OpenSearch client
        client = OpenSearch(
            hosts=[{'host': host, 'port': 443}],
            http_auth=awsauth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection
        )

        # Create the index mapping aligned with Knowledge Base fieldMapping
        index_body = {
            "settings": {
                "index.knn": True
            },
            "mappings": {
                "properties": {
                    "text": {  # textField
                        "type": "text"
                    },
                    "metadata": {  # metadataField
                        "type": "keyword"
                    },
                    "vector_field": {  # vectorField
                        "type": "knn_vector",
                        "dimension": 1536,
                        "method": {
                            "name": "hnsw",
                            "engine": "faiss",
                            "parameters": {
                                "ef_construction": 512,
                                "ef_search": 512,
                                "m": 16
                            }
                        }
                    }
                }
            }
        }

        max_retries = 7
        retry_delay = 1  # Initial delay in seconds

        for attempt in range(max_retries):
            try:
                # Create the index (use keyword-only args per client signature)
                response = client.indices.create(index=index_name, body=index_body)
                print(f"Index '{index_name}' created successfully: {response}")

                time.sleep(60)
                return {
                    'statusCode': 200,
                    'body': json.dumps('Index created successfully')
                }
            except Exception as e:
                if attempt < max_retries - 1:
                    error_message = f"Attempt {attempt + 1} failed. Retrying... Error: {str(e)}"
                    print(error_message)
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    error_message = f"Failed to create index after {max_retries} attempts. Error: {str(e)}"
                    print(error_message)
                    raise Exception(error_message)
