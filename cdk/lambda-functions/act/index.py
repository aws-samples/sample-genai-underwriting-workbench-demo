import json
import os
import boto3
from botocore.config import Config
from strands import Agent, tool
from strands.models import BedrockModel # Added import
from datetime import datetime, timezone # ADDED

# --- Environment Variables --- 
MOCK_OUTPUT_S3_BUCKET = os.environ.get('MOCK_OUTPUT_S3_BUCKET')
S3_KEY_PREFIX = "agent_outputs/"
JOBS_TABLE_NAME_ENV = os.environ.get('JOBS_TABLE_NAME') # ADDED

# --- AWS SDK Clients with retry configuration --- 
retry_config = Config(
    retries={
        'max_attempts': 10,
        'mode': 'adaptive'
    }
)

try:
    s3_client = boto3.client('s3', config=retry_config)
    dynamodb_client = boto3.client('dynamodb', config=retry_config) # ADDED
except Exception as e:
    print(f"Error initializing Boto3 clients: {e}")
    s3_client = None
    dynamodb_client = None # ADDED

print(f"ActLambda initializing. Target S3 Bucket for outputs: {MOCK_OUTPUT_S3_BUCKET}. Jobs Table: {JOBS_TABLE_NAME_ENV}")

# --- Step 1: Define Agent Tools ---
@tool
def send_ineligibility_notice_tool(document_identifier: str, reason_for_ineligibility: str) -> str:
    """Records that an application (identified by its document_identifier) has been deemed ineligible.
    Use this tool when an application clearly violates underwriting policy and cannot proceed.

    Args:
        document_identifier (str): The unique identifier of the document/application (e.g., S3 object key).
        reason_for_ineligibility (str): A clear, concise reason explaining why the application is ineligible.
    Returns:
        str: A confirmation message indicating the action was recorded.
    """
    if not s3_client or not MOCK_OUTPUT_S3_BUCKET:
        error_msg = "S3 client or MOCK_OUTPUT_S3_BUCKET not configured for send_ineligibility_notice_tool."
        print(f"ERROR: {error_msg}")
        return error_msg

    safe_identifier = document_identifier.replace("/", "_").replace(":", "_")
    file_name = f"{S3_KEY_PREFIX}{safe_identifier}_ineligible.txt"
    file_content = (
        f"Document Identifier: {document_identifier}\n"
        f"Status: Ineligible\n"
        f"Reason: {reason_for_ineligibility}"
    )

    try:
        s3_client.put_object(
            Bucket=MOCK_OUTPUT_S3_BUCKET,
            Key=file_name,
            Body=file_content.encode('utf-8'),
            ContentType='text/plain'
        )
        confirmation_message = f"Ineligibility notice for '{document_identifier}' recorded in S3: s3://{MOCK_OUTPUT_S3_BUCKET}/{file_name}"
        print(confirmation_message)
        return confirmation_message
    except Exception as e:
        error_msg = f"Error writing ineligibility notice to S3 for '{document_identifier}': {str(e)}"
        print(f"ERROR: {error_msg}")
        return error_msg

@tool
def request_supporting_documents_tool(document_identifier: str, recipient_email: str, documents_to_request: list[str], email_body: str) -> str:
    """Records a request for additional supporting documents for an application (identified by its document_identifier).
    Use this tool when an application is not ineligible but requires standard supporting documents to proceed.

    Args:
        document_identifier (str): The unique identifier of the document/application (e.g., S3 object key).
        recipient_email (str): The email address of the recipient (e.g., applicant or broker).
        documents_to_request (list[str]): A list of specific document names that are being requested.
        email_body (str): The full, polite body of the email requesting the documents, which you MUST generate.
    Returns:
        str: A confirmation message indicating the document request was recorded.
    """
    if not s3_client or not MOCK_OUTPUT_S3_BUCKET:
        error_msg = "S3 client or MOCK_OUTPUT_S3_BUCKET not configured for request_supporting_documents_tool."
        print(f"ERROR: {error_msg}")
        return error_msg

    safe_identifier = document_identifier.replace("/", "_").replace(":", "_")
    file_name = f"{S3_KEY_PREFIX}{safe_identifier}_document_request.txt"
    
    file_content = (
        f"To: {recipient_email}\n"
        f"From: underwriting-bot@example.com\n"
        f"Subject: Additional Documents Required for Application (Document: {document_identifier})\n\n"
        f"{email_body}"
    )

    try:
        s3_client.put_object(
            Bucket=MOCK_OUTPUT_S3_BUCKET,
            Key=file_name,
            Body=file_content.encode('utf-8'),
            ContentType='text/plain'
        )
        confirmation_message = f"Document request for '{document_identifier}' (docs: {', '.join(documents_to_request)}) recorded in S3: s3://{MOCK_OUTPUT_S3_BUCKET}/{file_name}"
        print(confirmation_message)
        return confirmation_message
    except Exception as e:
        error_msg = f"Error writing document request to S3 for '{document_identifier}': {str(e)}"
        print(f"ERROR: {error_msg}")
        return error_msg

# --- Step 2: Configure Strands Agent (System Prompt & Initialization) ---
SUPPORTING_DOCUMENTS_MAP = {
    # Property & Casualty documents
    "COMMERCIAL_PROPERTY_APPLICATION": [
        "Proof of Ownership",
        "Latest Audited Financial Statements (past 2 years)",
        "Property Inspection Report (dated within last 12 months)",
        "Existing Insurance Policy Declarations Page"
    ],
    "GENERAL_LIABILITY_APP_V2": [
        "Business License Copy",
        "Prior Claims History Report (5 years)",
        "Safety Program Manual/Overview"
    ],
    "ACORD_FORM": [
        "Completed ACORD Forms (all sections)",
        "Property Valuation Documentation",
        "Loss Run Reports (3 years)",
        "Business Continuity Plan"
    ],
    # Life insurance documents
    "LIFE_INSURANCE_APPLICATION": [
        "Valid Government ID",
        "Medical Records Release Form",
        "Recent Physical Exam Results (within 12 months)",
        "Financial Justification for Coverage Amount",
        "Blood Test and Urinalysis Results (if not completed)"
    ],
    "MEDICAL_REPORT": [
        "Complete Medical History for the Past 5 Years",
        "Specialist Consultation Notes",
        "Current Medication List",
        "Recent Lab Test Results"
    ],
    "ATTENDING_PHYSICIAN_STATEMENT": [
        "Additional Medical Records",
        "Specialist Reports Referenced in APS",
        "Treatment Plan Documentation",
        "Follow-up Appointment Schedule"
    ],
    "LAB_REPORT": [
        "Previous Lab Results for Comparison",
        "Physician's Interpretation of Results",
        "Prescription Records Related to Conditions"
    ],
    "DEFAULT_APP_TYPE": [
        "Valid Government-Issued Identification Document",
        "Proof of Address (e.g., utility bill)"
    ]
}

# Create document strings for prompt formatting
docs_comm_prop_str = "\n- " + "\n- ".join(SUPPORTING_DOCUMENTS_MAP["COMMERCIAL_PROPERTY_APPLICATION"])
docs_gen_liab_str = "\n- " + "\n- ".join(SUPPORTING_DOCUMENTS_MAP["GENERAL_LIABILITY_APP_V2"])
docs_life_app_str = "\n- " + "\n- ".join(SUPPORTING_DOCUMENTS_MAP["LIFE_INSURANCE_APPLICATION"])
docs_medical_str = "\n- " + "\n- ".join(SUPPORTING_DOCUMENTS_MAP["MEDICAL_REPORT"])
docs_default_str = "\n- " + "\n- ".join(SUPPORTING_DOCUMENTS_MAP["DEFAULT_APP_TYPE"])

# --- Step 2: Initialize Reusable Model Client ---
# The model client is static and can be reused across invocations.
try:
    # Configure Bedrock client with retry settings
    bedrock_config = Config(
        retries={
            'max_attempts': 10,
            'mode': 'adaptive'
        },
        max_pool_connections=50
    )
    bedrock_client = boto3.client('bedrock-runtime', config=bedrock_config)
    model = BedrockModel(
        model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        client=bedrock_client
    )
    print("BedrockModel initialized successfully.")
except Exception as e:
    print(f"CRITICAL: Error initializing BedrockModel: {e}")
    model = None # Set model to None if initialization fails

def get_agent_system_prompt(insurance_type):
    """Get the appropriate agent system prompt based on insurance type"""
    
    # Define common parts of the prompt
    common_intro = """You are an AI Underwriting Assistant responsible for initial application triage. 
Your task is to review an insurance application's extracted data (the user message will provide a 'document_identifier' and the application data) and decide on an appropriate action using ONE of the available tools.

Available Tools:
1.  `send_ineligibility_notice_tool`: Use this if the application is clearly ineligible based on the rules below.
2.  `request_supporting_documents_tool`: Use this if the application is NOT ineligible, to request necessary supporting documents."""
    
    # Insurance-type specific rules
    if insurance_type == "life":
        ineligibility_rules = """**Ineligibility Rules (Strict - check these first. If any rule matches, the application is ineligible):**
-   For application type "LIFE_INSURANCE_APPLICATION":
    -   If the applicant has any history of cancer diagnosed within the last 3 years, they are INELIGIBLE. State 'recent cancer diagnosis' as the reason for ineligibility.
    -   If the applicant's current age is over 85, they are INELIGIBLE. State 'age exceeds maximum limit' as the reason for ineligibility.
    -   If the applicant has a history of heart attack or stroke within the last 12 months, they are INELIGIBLE. State 'recent cardiac/stroke event' as the reason for ineligibility.
-   For any application type:
    -   If `applicant_details.sanctioned_entity_status` is "Positive" or "MatchFound", it is INELIGIBLE. State 'sanctioned entity match' as the reason for ineligibility.
    -   If an `application_details.requested_policy_start_date` is provided and it is in the past, it is INELIGIBLE. State 'past policy start date' as the reason for ineligibility."""
    else:  # property_casualty
        ineligibility_rules = """**Ineligibility Rules (Strict - check these first. If any rule matches, the application is ineligible):**
-   For application type "COMMERCIAL_PROPERTY_APPLICATION":
    -   If `business_details.business_type` is "Nightclub" or "Explosives Manufacturing", it is INELIGIBLE. State this specific business type as the reason for ineligibility.
    -   If `location_details.construction_type` is "Wood Frame" AND `location_details.wildfire_risk_zone` is "High" or "Extreme", it is INELIGIBLE. State this combination (construction and high/extreme wildfire risk) as the reason for ineligibility.
-   For any application type:
    -   If `applicant_details.sanctioned_entity_status` is "Positive" or "MatchFound", it is INELIGIBLE. State 'sanctioned entity match' as the reason for ineligibility.
    -   If data from a crime report is available (e.g., in `extracted_data.crime_report_data`) and `crime_report_data.property_crime_grade` is "F", it is INELIGIBLE. State 'Property Crime Grade is F' as the reason for ineligibility.
    -   If an `application_details.requested_policy_start_date` is provided and it is in the past, it is INELIGIBLE. State 'past policy start date' as the reason for ineligibility."""
    
    # Supporting document request instructions
    supporting_docs_section = """**Supporting Document Request (Use ONLY if NOT Ineligible):**
If none of the ineligibility rules are met, you MUST use the `request_supporting_documents_tool`.
1.  Identify the `application_type` from the input.
2.  Determine the list of required supporting documents based on this `application_type`. The mapping is:"""
    
    # Add the appropriate document lists based on insurance type
    if insurance_type == "life":
        docs_map = f"""
    -   For "LIFE_INSURANCE_APPLICATION", request: {docs_life_app_str}
    -   For "MEDICAL_REPORT", request: {docs_medical_str}
    -   For any other `application_type`, use this default list: {docs_default_str}"""
    else:  # property_casualty
        docs_map = f"""
    -   For "COMMERCIAL_PROPERTY_APPLICATION", request: {docs_comm_prop_str}
    -   For "GENERAL_LIABILITY_APP_V2", request: {docs_gen_liab_str}
    -   For any other `application_type`, use this default list: {docs_default_str}"""
    
    email_instructions = """3.  Set `recipient_email` to the `applicant_details.email` from the extracted data if available; otherwise, use "underwriting-dept@example.com".
4.  You MUST draft a polite and professional `email_body`. 
    - Start with a greeting (e.g., "Dear Applicant,").
    - State that the application (mentioning the `document_identifier`) has been received and requires the listed additional documents to proceed with the review.
    - Clearly list each required document in the `documents_to_request` parameter of the tool (this will be used by the tool). In your `email_body` that you draft, also list these documents, preferably using bullet points (each document on a new line, preceded by a hyphen and a space, e.g., "- Document Name").
    - Conclude the email professionally (e.g., "Sincerely, Underwriting Department").
5.  Ensure the `document_identifier` (from the user message) and all other required arguments are passed to the `request_supporting_documents_tool`.

Always choose exactly one tool. Do not ask clarifying questions. Make your decision based solely on the rules and data provided in the user message.
The user message will contain the `document_identifier` and the extracted application data."""
    
    # Combine all sections to create the final prompt
    return common_intro + "\n\n" + ineligibility_rules + "\n\nIf an application is ineligible:\n- You MUST use the `send_ineligibility_notice_tool`.\n- Provide a clear `reason_for_ineligibility` based *only* on the specific rule that was violated.\n- Ensure the `document_identifier` (from the user message) is passed to the tool.\n\n" + supporting_docs_section + docs_map + "\n\n" + email_instructions

# --- Step 3: Implement Lambda Handler ---
def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    if not s3_client:
        print("CRITICAL: S3 client not initialized.")
        return {"statusCode": 500, "body": json.dumps({"error": "S3 client not initialized."})}
    if not MOCK_OUTPUT_S3_BUCKET:
        print("CRITICAL: MOCK_OUTPUT_S3_BUCKET env var not set or empty.")
        return {"statusCode": 500, "body": json.dumps({"error": "MOCK_OUTPUT_S3_BUCKET env var not set."})}
    if not model:
        print("CRITICAL: BedrockModel (model) not initialized.")
        return {"statusCode": 500, "body": json.dumps({"error": "BedrockModel not initialized."})}

    try:
        s3_object_key = event.get('detail', {}).get('object', {}).get('key')
        if not s3_object_key:
            s3_object_key = event.get('s3_object_key') 
            if not s3_object_key:
                print("ERROR: Missing S3 object key (expected in 'detail.object.key' or 's3_object_key').")
                return {"statusCode": 400, "body": json.dumps({"error": "Missing S3 object key in event"})}
        
        document_identifier = s3_object_key 
        job_id = event.get('classification').get('jobId')
        insurance_type = event.get('classification').get('insuranceType')
        document_type = event.get('classification').get('classification')
        extracted_data = event.get('extraction', {}).get('data')
        print(f"Job ID: {job_id}")
        print(f"Document type: {document_type}")
        print(f"Insurance type: {insurance_type}")
        print(f"Insurance type from event: {insurance_type}")

        # --- Update DynamoDB status to ACTING ---
        if job_id and JOBS_TABLE_NAME_ENV:
            try:
                timestamp_now = datetime.now(timezone.utc).isoformat()
                dynamodb_client.update_item(
                    TableName=JOBS_TABLE_NAME_ENV,
                    Key={'jobId': {'S': job_id}},
                    UpdateExpression="SET #status_attr = :status_val, #actStartTs = :actStartTsVal",
                    ExpressionAttributeNames={
                        '#status_attr': 'status',
                        '#actStartTs': 'actionStartTimestamp'
                    },
                    ExpressionAttributeValues={
                        ':status_val': {'S': 'ACTING'},
                        ':actStartTsVal': {'S': timestamp_now}
                    }
                )
                print(f"Updated job {job_id} status to ACTING")
            except Exception as ddb_e:
                print(f"Error updating DynamoDB status for job {job_id}: {str(ddb_e)}")
        


        if not document_type or not isinstance(document_type, str):
            print(f"ERROR: Missing or invalid 'document_type' within 'classification' for {document_identifier}.")
            return {"statusCode": 400, "body": json.dumps({"error": "Missing or invalid 'document_type' in classification details"})}
        if not extracted_data or not isinstance(extracted_data, dict):
            print(f"ERROR: Missing or invalid 'data' within 'extraction' for {document_identifier}. This might be expected if no extraction occurred yet.")
            # We'll allow missing extraction data for now and handle it gracefully.
            extracted_data = {}
            # return {"statusCode": 400, "body": json.dumps({"error": "Missing or invalid 'data' in extraction details"})}
        
        print(f"Processing Document Identifier: {document_identifier}, Document Type: {document_type}")

        agent_input_message = (
            f"Triage the following insurance application.\n"
            f"Document Identifier: {document_identifier}\n"
            f"Application Type: {document_type}\n"
            f"Extracted Data: {json.dumps(extracted_data, indent=2)}"
        )
        
        print(f"Sending message to agent for {document_identifier}...")
        
        # Get the appropriate agent system prompt based on insurance type
        agent_system_prompt = get_agent_system_prompt(insurance_type)
        
        # Initialize the agent with the insurance-type specific prompt
        # The agent is created here because its system_prompt depends on the event payload.
        uw_agent = Agent(
            system_prompt=agent_system_prompt,
            tools=[
                send_ineligibility_notice_tool,
                request_supporting_documents_tool
            ],
            model=model # Use the globally initialized model
        )
        
        # Call agent with retry logic for Bedrock throttling
        max_retries = 3
        retry_count = 0
        agent_response = None
        
        while retry_count < max_retries:
            try:
                agent_response = uw_agent(agent_input_message)
                break  # Success, exit retry loop
            except Exception as agent_e:
                retry_count += 1
                error_str = str(agent_e).lower()
                
                # Check for throttling errors
                if any(throttle_indicator in error_str for throttle_indicator in ['throttling', 'rate exceeded', 'too many requests', 'service unavailable']):
                    if retry_count < max_retries:
                        wait_time = 2 ** retry_count  # Exponential backoff
                        print(f"Bedrock throttling detected for {document_identifier}, retry {retry_count}/{max_retries} after {wait_time}s")
                        import time
                        time.sleep(wait_time)
                        continue
                    else:
                        print(f"Max retries exceeded for throttling on {document_identifier}")
                        raise agent_e
                else:
                    # Non-throttling error, don't retry
                    print(f"Non-throttling error in agent call for {document_identifier}: {agent_e}")
                    raise agent_e
        
        if agent_response is None:
            raise Exception("Agent failed to respond after retries")

        print(f"Agent response for {document_identifier}: {str(agent_response)}")

        lambda_output = {
            "document_identifier": document_identifier,
            "agent_action_confirmation": str(agent_response),
            "message": "Agent triage process completed."
        }
        # --- Update DynamoDB with Agent Action Output --- ADDED BLOCK
        if job_id and JOBS_TABLE_NAME_ENV:
            try:
                timestamp_now = datetime.now(timezone.utc).isoformat()
                dynamodb_client.update_item(
                    TableName=JOBS_TABLE_NAME_ENV,
                    Key={'jobId': {'S': job_id}},
                    UpdateExpression="SET #status_attr = :status_val, #agentOutput = :agentOutputVal, #actionTs = :actionTsVal",
                    ExpressionAttributeNames={
                        '#status_attr': 'status',
                        '#agentOutput': 'agentActionOutputJsonStr', # New DDB attribute
                        '#actionTs': 'actionTimestamp' # New DDB attribute
                    },
                    ExpressionAttributeValues={
                        ':status_val': {'S': 'COMPLETE'}, # Changed to COMPLETE
                        ':agentOutputVal': {'S': json.dumps(lambda_output)}, # Storing the lambda's output
                        ':actionTsVal': {'S': timestamp_now}
                    }
                )
                print(f"Successfully updated job {job_id} in DynamoDB with agent action results.")
            except Exception as ddb_e:
                print(f"Error updating DynamoDB for job {job_id} with agent action results: {str(ddb_e)}. Agent action data not saved to DDB.")
        elif not job_id:
            print(f"Skipping DynamoDB update for agent action results: job_id is missing from extraction details.")
            
        return {
            "statusCode": 200,
            "body": json.dumps(lambda_output)
        }

    except Exception as e:
        error_msg = f"ERROR: Unhandled exception during Lambda execution for {document_identifier if 'document_identifier' in locals() else 'Unknown Document'}: {str(e)}"
        print(error_msg)
        
        # Update DynamoDB status to FAILED if we have job_id
        if 'job_id' in locals() and job_id and JOBS_TABLE_NAME_ENV:
            try:
                timestamp_now = datetime.now(timezone.utc).isoformat()
                dynamodb_client.update_item(
                    TableName=JOBS_TABLE_NAME_ENV,
                    Key={'jobId': {'S': job_id}},
                    UpdateExpression="SET #status_attr = :status_val, #actionTs = :actionTsVal",
                    ExpressionAttributeNames={
                        '#status_attr': 'status',
                        '#actionTs': 'actionTimestamp'
                    },
                    ExpressionAttributeValues={
                        ':status_val': {'S': 'FAILED'},
                        ':actionTsVal': {'S': timestamp_now}
                    }
                )
                print(f"Updated job {job_id} status to FAILED due to exception")
            except Exception as ddb_e:
                print(f"Error updating DynamoDB status to FAILED for job {job_id}: {str(ddb_e)}")
        
        return {
            "statusCode": 500,
            "body": json.dumps({"error": f"Internal server error: {str(e)}"})
        }