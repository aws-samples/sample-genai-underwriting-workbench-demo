import json
import os
import urllib3
import boto3
from botocore.awsrequest import AWSRequest
from botocore.auth import SigV4Auth


http = urllib3.PoolManager()


def sign_request(method: str, url: str, body: str | bytes | None):
    session = boto3.Session()
    credentials = session.get_credentials()
    region = os.environ.get('AWS_REGION') or session.region_name or 'us-east-1'
    req = AWSRequest(method=method, url=url, data=body, headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, 'aoss', region).add_auth(req)
    return dict(req.headers)


def ensure_index(endpoint: str, index_name: str, vector_dim: int):
    # Check if index exists
    get_url = f"{endpoint}/{index_name}"
    headers = sign_request('GET', get_url, None)
    resp = http.request('GET', get_url, headers=headers)
    if resp.status == 200:
        return {'status': 'exists'}

    # Create index with KNN vector mapping and text/metadata fields
    create_body = json.dumps({
        'settings': {
            'index': {
                'knn': True,
                'knn.algo_param.ef_search': 512
            }
        },
        'mappings': {
            'properties': {
                'vector': { 'type': 'knn_vector', 'dimension': vector_dim },
                'text': { 'type': 'text' },
                'metadata': { 'type': 'keyword' }
            }
        }
    })

    put_headers = sign_request('PUT', get_url, create_body)
    put_resp = http.request('PUT', get_url, body=create_body, headers=put_headers)
    if put_resp.status in (200, 201):
        return {'status': 'created'}
    else:
        raise Exception(f"Failed to create index {index_name}: {put_resp.status} {put_resp.data}")


def on_event(event, context):
    request_type = event.get('RequestType', 'Create')
    props = event.get('ResourceProperties') or {}
    endpoint = props.get('AossEndpoint') or os.environ.get('AOSS_ENDPOINT')
    index_name = props.get('VectorIndexName') or os.environ.get('VECTOR_INDEX_NAME', 'kb-index')
    vector_dim = int(props.get('VectorDim') or os.environ.get('VECTOR_DIM', '1024'))

    if request_type in ('Create', 'Update'):
        result = ensure_index(endpoint, index_name, vector_dim)
        return { 'PhysicalResourceId': f"{endpoint}/{index_name}", 'Data': result }
    elif request_type == 'Delete':
        # Best-effort delete
        try:
            del_url = f"{endpoint}/{index_name}"
            headers = sign_request('DELETE', del_url, None)
            http.request('DELETE', del_url, headers=headers)
        except Exception:
            pass
        return { 'PhysicalResourceId': f"{endpoint}/{index_name}", 'Data': { 'status': 'deleted' } }


