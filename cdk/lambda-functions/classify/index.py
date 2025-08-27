import json
import boto3
import os
import base64
import io
import urllib.parse
from pdf2image import convert_from_path
from datetime import datetime, timezone
from botocore.config import Config

# Configure retry settings for AWS clients
retry_config = Config(
    retries={
        'max_attempts': 10,
        'mode': 'adaptive'
    },
    max_pool_connections=50
)

# Initialize AWS clients outside the handler for reuse
s3 = boto3.client('s3', config=retry_config)
bedrock_runtime = boto3.client(service_name='bedrock-runtime', config=retry_config)
dynamodb_client = boto3.client('dynamodb', config=retry_config)

def get_classification_prompt(insurance_type):
    """Get the appropriate classification prompt based on insurance type"""
    base_prompt = """Analyze the provided image, which is the first page of a document.
    Based *only* on this first page, classify the document type."""
    
    if insurance_type == 'life':
        return base_prompt + """
        The possible types are: LIFE_INSURANCE_APPLICATION, MEDICAL_REPORT, ATTENDING_PHYSICIAN_STATEMENT, LAB_REPORT, PRESCRIPTION_HISTORY, FINANCIAL_STATEMENT,
        
        Here are some characteristics of each document type:
        
        LIFE_INSURANCE_APPLICATION:
        - Contains personal information fields like name, address, date of birth
        - Has sections for health questions, medical history
        - Often includes beneficiary information and policy details
        
        MEDICAL_REPORT:
        - Contains patient information, medical history, diagnosis, or treatment plans
        - May include letterheads from hospitals, clinics, or doctor's offices
        - Look for terms like "Patient Name", "Date of Birth", "Diagnosis", "Symptoms", "Medication"
        
        ATTENDING_PHYSICIAN_STATEMENT:
        - A form filled out by a physician about the patient's health
        - Contains sections specifically labeled "Attending Physician's Statement" or "APS"
        - Includes detailed medical evaluations and physician's signature
        
        LAB_REPORT:
        - Contains test results for blood work, urine analysis, etc.
        - Has tables or charts of test values with reference ranges
        - Often has laboratory letterhead or header
        
        PRESCRIPTION_HISTORY:
        - Lists medications prescribed to the individual
        - Contains prescription dates, dosages, and prescribing physicians
        - May be in a format from a pharmacy or prescription benefit manager
        
        FINANCIAL_STATEMENT:
        - Contains financial data like income, expenses, assets, or liabilities
        - May include tables with monetary values
        - Often has terms like "Balance Sheet", "Income Statement", or "Cash Flow"
        
        If a document doesn't clearly fit the above categories, choose the best fit from the list.
        
        Respond ONLY with a JSON object containing a single key 'document_type' with the classification value.
        Example Output: {"document_type": "MEDICAL_REPORT"}
        """
    else:  # property_casualty
        return base_prompt + """
        The possible types are: ACORD_FORM, MEDICAL_REPORT, FINANCIAL_STATEMENT, COMMERCIAL_PROPERTY_APPLICATION, CRIME_REPORT, OTHER.
        
        Here are some characteristics of each document type:
        
        ACORD_FORM:
        - Contains the ACORD logo
        - Has structured form fields for insurance information
        - Often includes policy numbers, insured details, and coverage information
        
        COMMERCIAL_PROPERTY_APPLICATION:
        - An application for commercial property insurance
        - Includes information on the properties/locations, agency information, coverages requested, and other relevant information
        - Might have a header or footer with Commercial Property Application Form or something similar
        
        CRIME_REPORT:
        - A report of a crime that has been committed in the area of the property(s) being insured
        - Mentions property crime statistics for the given zip code
        - Often has a header or footer with Crime Report or something similar

        FINANCIAL_STATEMENT:
        - Contains financial data like income, expenses, assets, or liabilities
        - May include tables with monetary values
        - Often has terms like "Balance Sheet", "Income Statement", or "Cash Flow"
        
        MEDICAL_REPORT:
        - Often contains patient information, medical history, diagnosis, or treatment plans.
        - May include letterheads from hospitals, clinics, or doctor's offices.
        - Look for terms like "Patient Name", "Date of Birth", "Diagnosis", "Symptoms", "Medication".

        OTHER:
        - Any document that doesn't clearly fit the above categories
        
        IMPORTANT:Respond ONLY with a JSON object containing a single key 'document_type' with the classification value.
        Example Output: {"document_type": "ACORD_FORM"}
        """

def lambda_handler(event, context):
    print("Received event:", json.dumps(event))

    bucket = None
    key = None
    download_path = None
    classification_result = 'ERROR_UNKNOWN' # Default result
    job_id_parsed = None
    insurance_type = 'property_casualty'  # Default insurance type

    try:
        # --- Step 1: Extract S3 info, parse job ID, and update status ---
        
        # Extract from Step Functions input
        bucket = event['detail']['bucket']['name']
        encoded_key = event['detail']['object']['key']

        # Decode the key for S3 operations
        key = urllib.parse.unquote_plus(encoded_key)

        if not bucket or not key:
            raise ValueError("Missing S3 bucket or key in input event")

        print(f"Original encoded key: {encoded_key}")
        print(f"Decoded key for S3: {key}")
        print(f"Processing s3://{bucket}/{key}")

        # Parse Job ID from S3 key
        if key.startswith("uploads/") and key.count("/") >= 2:
            parts = key.split("/")
            job_id_parsed = parts[1]
            print(f"Parsed Job ID: {job_id_parsed}")
        else:
            print(f"Warning: Could not parse Job ID from S3 key: {key}. DynamoDB update will be skipped.")

        # For the local file path, use the decoded filename
        safe_filename = os.path.basename(key)
        download_path = f'/tmp/{safe_filename}'
        print(f"Using download path: {download_path}")

        # Retrieve insurance type and update DynamoDB status to CLASSIFYING
        if job_id_parsed and os.environ.get('JOBS_TABLE_NAME'):
            try:
                # First, get the insurance type from DynamoDB
                response = dynamodb_client.get_item(
                    TableName=os.environ['JOBS_TABLE_NAME'],
                    Key={'jobId': {'S': job_id_parsed}},
                    ProjectionExpression="insuranceType"
                )
                
                if 'Item' in response and 'insuranceType' in response['Item']:
                    insurance_type = response['Item']['insuranceType']['S']
                    print(f"Retrieved insurance type from DynamoDB: {insurance_type}")
                else:
                    print(f"No insurance type found in DynamoDB, using default: {insurance_type}")
                
                # Then update status to CLASSIFYING
                timestamp_now = datetime.now(timezone.utc).isoformat()
                dynamodb_client.update_item(
                    TableName=os.environ['JOBS_TABLE_NAME'],
                    Key={'jobId': {'S': job_id_parsed}},
                    UpdateExpression="SET #status_attr = :status_val, #classifyTs = :classifyTsVal",
                    ExpressionAttributeNames={
                        '#status_attr': 'status',
                        '#classifyTs': 'classifyTimestamp'
                    },
                    ExpressionAttributeValues={
                        ':status_val': {'S': 'CLASSIFYING'},
                        ':classifyTsVal': {'S': timestamp_now}
                    }
                )
                print(f"Updated job {job_id_parsed} status to CLASSIFYING")
            except Exception as ddb_e:
                print(f"Error with DynamoDB operations for job {job_id_parsed}: {str(ddb_e)}")

        # --- Step 2: Download PDF from S3 ---
        try:
            # Use the decoded key for S3 download
            s3.download_file(bucket, key, download_path)
            print(f"Successfully downloaded to {download_path}")
        except Exception as e:
            print(f"Error downloading from S3: {e}")
            # Try to list objects in the bucket to help debug
            try:
                print("Listing objects in bucket to help debug:")
                response = s3.list_objects_v2(Bucket=bucket, Prefix="input/")
                if 'Contents' in response:
                    for obj in response['Contents']:
                        print(f"  - {obj['Key']}")
                else:
                    print("  No objects found with prefix 'input/'")
            except Exception as list_e:
                print(f"Error listing objects: {list_e}")
            return { 'classification': 'ERROR_S3_DOWNLOAD' }

        # --- Step 3: Convert first page to image ---
        base64_image_data = None
        image_bytes = None
        try:
            images = convert_from_path(download_path, first_page=1, last_page=1)
            if images:
                first_page_image = images[0]
                buffer = io.BytesIO()
                first_page_image.save(buffer, format="PNG")
                image_bytes = buffer.getvalue()
                base64_image_data = base64.b64encode(image_bytes).decode('utf-8')
                print("Successfully converted first page to base64 PNG.")
            else:
                print(f"Warning: pdf2image returned no images for {download_path}")
        except Exception as e:
            print(f"Error converting PDF page to image: {e}")

        if not base64_image_data:
            print("Could not generate base64 image data from PDF.")
            classification_result = { 'classification': 'ERROR_NO_IMAGE' }
            
        # --- Step 4: Call Bedrock for classification and parse response ---
        if base64_image_data:
            try:
                # Use Claude 3 Sonnet v2 by default, but can be configured via environment variable
                model_id = os.environ.get('BEDROCK_MODEL_ID', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0')
                
                # Define the prompt for document classification based on insurance type
                prompt_text = get_classification_prompt(insurance_type)
                
                # Define the JSON schema for the expected output
                classification_schema = {
                    "type": "object",
                    "properties": {
                        "document_type": {"type": "string"}
                    },
                    "required": ["document_type"]
                }

                # Wrap the schema in a dummy tool definition
                tool_config = {
                    "tools": [
                        {
                            "toolSpec": {
                                "name": "output_classification",
                                "description": "Return the document classification as strict JSON.",
                                "inputSchema": {"json": classification_schema}
                            }
                        }
                    ],
                    "toolChoice": {"tool": {"name": "output_classification"}}
                }

                # Construct the messages for the Converse API
                messages_for_converse = [
                    {
                        "role": "user",
                        "content": [
                            {
                                "image": {
                                    "format": "png",
                                    "source": {
                                        "bytes": image_bytes
                                    }
                                }
                            },
                            {
                                "text": prompt_text
                            }
                        ]
                    }
                ]

                # Define inference configuration for Converse API
                inference_config = {
                    "maxTokens": 500,
                    "temperature": 0.0
                }

                print(f"Invoking Bedrock model {model_id} using converse API...")
                response = bedrock_runtime.converse(
                    modelId=model_id,
                    messages=messages_for_converse,
                    toolConfig=tool_config,
                    inferenceConfig=inference_config
                )
                print("Bedrock converse call successful.")

                # Parse the response, expecting a tool_use block
                response_body = response.get('output').get('message')

                # Extract the tool_use block
                tool_use_block = response_body['content'][0].get('toolUse')

                if tool_use_block and tool_use_block['name'] == 'output_classification':
                    classification_data = tool_use_block['input']
                    print(f"Classification data: {classification_data}")
                    document_type = classification_data.get('document_type', 'OTHER')
                    classification_result = document_type
                    print(f"Successfully parsed document type: {document_type}")
                else:
                    print("Error: Bedrock response did not contain the expected toolUse block or tool name.")
                    classification_result = 'ERROR_TOOL_USE_PARSE'

            except Exception as bedrock_e:
                print(f"Error during Bedrock interaction: {bedrock_e}")
                classification_result = 'ERROR_BEDROCK_API' # Store the string directly
        elif classification_result != { 'classification': 'ERROR_NO_IMAGE' }: # Only update if not already ERROR_NO_IMAGE
            print("Setting classification to ERROR_NO_IMAGE as image data is missing and not previously set.")
            classification_result = 'ERROR_NO_IMAGE' # Store the string directly
    
    except Exception as e:
        # Catch any other unhandled exceptions during the main try block
        print(f"Unhandled exception in lambda_handler: {e}")
        classification_result = 'ERROR_UNHANDLED' # Store the string directly
    
    finally:
        # Cleanup temporary files
        if download_path and os.path.exists(download_path):
            try:
                os.remove(download_path)
                print(f"Cleaned up temporary file: {download_path}")
            except Exception as cleanup_e:
                print(f"Error during file cleanup: {cleanup_e}")

    final_output = {
            'classification': classification_result,
            'jobId': job_id_parsed,
            'insuranceType': insurance_type
        
    }
    # Return the final classification result
    print("Returning final classification result:", json.dumps(final_output))
    return final_output