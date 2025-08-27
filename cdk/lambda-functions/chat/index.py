import json
import boto3
import os
import math
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

# Initialize AWS clients
dynamodb = boto3.client('dynamodb', config=retry_config)
bedrock_runtime = boto3.client(service_name='bedrock-runtime', config=retry_config)

# Environment variables
JOBS_TABLE_NAME = os.environ.get('JOBS_TABLE_NAME')
BEDROCK_CHAT_MODEL_ID = os.environ.get('BEDROCK_CHAT_MODEL_ID', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0')

def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    
    http_method = event.get('httpMethod', '')
    resource = event.get('resource', '')
    path_parameters = event.get('pathParameters', {}) or {}
    
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Content-Type': 'application/json'
    }
    
    if http_method == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'message': 'CORS preflight request successful'})}
    
    try:
        if http_method == 'POST' and resource == '/api/chat/{jobId}':
            job_id = path_parameters.get('jobId')
            if not job_id:
                print("Returning 400: Missing jobId parameter")
                return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': 'Missing jobId parameter'})}
            
            body = json.loads(event.get('body', '{}'))
            messages = body.get('messages') # Expect 'messages' array
            
            if not messages or not isinstance(messages, list):
                error_msg = 'Missing or invalid "messages" in request body'
                print(f"Returning 400: {error_msg}. Body received: {json.dumps(body)}")
                return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': error_msg})}
            
            # Process the chat request with conversation history
            response = process_chat(job_id, messages)
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps(response)}
            
        else:
            print(f"Returning 404: Not found for resource {resource} and method {http_method}")
            return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'Not found'})}
            
    except Exception as e:
        print(f"Error processing request: {str(e)}")
        return {'statusCode': 500, 'headers': headers, 'body': json.dumps({'error': f'Internal server error: {str(e)}'})}

def get_chat_system_prompt(document_type, insurance_type, extracted_data, analysis_output):
    """Generate a system prompt based on document type and insurance type"""
    
    # Base context with document and analysis data
    base_context = f"""You are an AI assistant for insurance underwriting.
    
    You are currently helping with a document of type: {document_type}
    Insurance type: {insurance_type}
    
    The following data was extracted from the document:
    ```
    {json.dumps(extracted_data, indent=2)}
    ```
    
    The following analysis was performed:
    ```
    {json.dumps(analysis_output, indent=2)}
    ```
    """
    
    # Insurance-type specific context and guidance
    if insurance_type == "life":
        specialized_context = """
        Your primary focus is life insurance underwriting. When responding:
        
        1. For medical information, pay special attention to:
           - Pre-existing conditions and their severity/duration
           - Family history of hereditary diseases
           - Current medications and treatments
           - Lifestyle factors (smoking, alcohol, exercise)
        
        2. When discussing risk factors, consider:
           - Age and life expectancy implications
           - BMI and its impact on mortality risk
           - Medical conditions that may affect longevity
           - Occupation and hazardous activities
        
        3. For policy recommendations, focus on:
           - Standard vs. rated policies based on medical history
           - Term vs. permanent insurance considerations
           - Appropriate coverage amounts based on financial information
           - Riders that may be appropriate (waiver of premium, accelerated benefits)
        """
    else:  # property_casualty
        specialized_context = """
        Your primary focus is property & casualty insurance underwriting. When responding:
        
        1. For property information, pay special attention to:
           - Construction type and building materials
           - Age and condition of the structure
           - Protection features (sprinklers, alarms, etc.)
           - Proximity to fire stations and hydrants
        
        2. When discussing risk factors, consider:
           - Natural hazard exposure (flood zones, wildfire risk, etc.)
           - Occupancy types and their associated hazards
           - Neighboring properties and exposure risks
           - Business operations and liability concerns
        
        3. For policy recommendations, focus on:
           - Appropriate coverage limits based on property values
           - Deductible options for various perils
           - Specialized endorsements for specific risks
           - Risk mitigation measures to reduce premiums
        """
    
    # Common instructions for all insurance types
    common_instructions = """
    Please answer any questions about this document or analysis. Be professional, accurate, and helpful.
    If asked to perform calculations related to medical underwriting (like BMI), please use the calculate_bmi tool.
    
    When uncertain about specific details, acknowledge the limitations of the information provided.
    Avoid making definitive underwriting decisions, but provide guidance based on industry standards.
    """
    
    # Combine all sections for the complete prompt
    return base_context + specialized_context + common_instructions

def process_chat(job_id, messages):
    """
    Process a chat message for a specific job.
    Retrieves job data from DynamoDB and uses it to provide context for the LLM.
    """
    try:
        # Retrieve the job data from DynamoDB
        response = dynamodb.get_item(
            TableName=JOBS_TABLE_NAME,
            Key={'jobId': {'S': job_id}}
        )
        
        if 'Item' not in response:
            return {'error': f'Job {job_id} not found'}
        
        item = response['Item']
        
        # Extract job details for context
        document_type = item.get('documentType', {}).get('S', 'Unknown')
        insurance_type = item.get('insuranceType', {}).get('S', 'property_casualty')  # Default to P&C if not specified
        
        # Extract structured data if available
        extracted_data_json = item.get('extractedDataJsonStr', {}).get('S', '{}')
        analysis_output_json = item.get('analysisOutputJsonStr', {}).get('S', '{}')
        
        try:
            extracted_data = json.loads(extracted_data_json)
            analysis_output = json.loads(analysis_output_json)
        except json.JSONDecodeError:
            extracted_data = {}
            analysis_output = {}
        
        # Define common tools for all insurance types, now with the correct toolSpec structure
        common_tools = [
            {
                "toolSpec": {
                    "name": "calculate_bmi",
                    "description": "Calculate BMI (Body Mass Index) given height and weight",
                    "inputSchema": {"json": {
                        "type": "object",
                        "properties": {
                            "height_cm": {
                                "type": "number",
                                "description": "Height in centimeters"
                            },
                            "weight_kg": {
                                "type": "number",
                                "description": "Weight in kilograms"
                            }
                        },
                        "required": ["height_cm", "weight_kg"]
                    }}
                }
            }
        ]
        
        # Add insurance-type specific tools
        if insurance_type == "life":
            life_tools = [
                {
                    "toolSpec": {
                        "name": "calculate_mortality_risk",
                        "description": "Calculate a simplified mortality risk score based on age, gender, and health factors",
                        "inputSchema": {"json": {
                            "type": "object",
                            "properties": {
                                "age": {
                                    "type": "number",
                                    "description": "Age in years"
                                },
                                "gender": {
                                    "type": "string",
                                    "description": "Gender (male or female)"
                                },
                                "smoker": {
                                    "type": "boolean",
                                    "description": "Whether the person is a smoker"
                                },
                                "bmi": {
                                    "type": "number",
                                    "description": "Body Mass Index"
                                }
                            },
                            "required": ["age", "gender", "smoker", "bmi"]
                        }}
                    }
                }
            ]
            tools = common_tools + life_tools
        elif insurance_type == "property_casualty":
            pc_tools = [
                {
                    "toolSpec": {
                        "name": "calculate_property_premium",
                        "description": "Estimate a simplified property insurance premium based on basic factors",
                        "inputSchema": {"json": {
                            "type": "object",
                            "properties": {
                                "property_value": {
                                    "type": "number",
                                    "description": "Property value in dollars"
                                },
                                "construction_type": {
                                    "type": "string",
                                    "description": "Type of construction (e.g., wood frame, masonry, etc.)"
                                },
                                "protection_class": {
                                    "type": "number",
                                    "description": "Fire protection class (1-10, where 1 is best)"
                                },
                                "deductible": {
                                    "type": "number",
                                    "description": "Deductible amount in dollars"
                                }
                            },
                            "required": ["property_value", "construction_type", "protection_class", "deductible"]
                        }}
                    }
                }
            ]
            tools = common_tools + pc_tools
        else:
            tools = common_tools
        
        # Create the system prompt with context
        system_prompt = get_chat_system_prompt(document_type, insurance_type, extracted_data, analysis_output)
        
        # Prepare the conversation for Claude, converting frontend format to Bedrock format
        def format_messages_for_bedrock(messages_from_frontend):
            bedrock_messages = []
            for msg in messages_from_frontend:
                # In Bedrock Converse API, the roles are 'user' and 'assistant'.
                # Frontend sends 'user' and 'ai'.
                role = 'assistant' if msg.get('sender') == 'ai' else 'user'
                content = msg.get('text', '')
                # Content must be a list of content blocks
                bedrock_messages.append({'role': role, 'content': [{'text': content}]})
            return bedrock_messages

        messages_for_bedrock = format_messages_for_bedrock(messages)

        print(f"Sending messages to Bedrock: {json.dumps(messages_for_bedrock)}")
        
        # Call Claude via Bedrock with corrected structure
        response = bedrock_runtime.converse(
            modelId=BEDROCK_CHAT_MODEL_ID,
            system=[{'text': system_prompt}],  # Pass system prompt here
            messages=messages_for_bedrock,     # Pass just user/assistant messages here
            toolConfig={
                'tools': tools,                # Pass tools inside toolConfig
                'toolChoice': {'auto': {}}     # Pass toolChoice as a dict
            },
            inferenceConfig={
                "maxTokens": 2048,
                "temperature": 0.1
            }
        )
        
        print(f"Bedrock response: {json.dumps(response)}")

        # Process the response
        output_message = response.get('output', {}).get('message', {})
        content_blocks = output_message.get('content', [])
        assistant_response = ""
        tool_calls = []
        
        for block in content_blocks:
            if 'text' in block:
                assistant_response += block.get('text', '')
            
            elif 'toolUse' in block:
                tool_use_block = block['toolUse']
                tool_name = tool_use_block.get('name')
                tool_input = tool_use_block.get('input', {})
                print(f"Executing tool: {tool_name} with input: {json.dumps(tool_input)}")

                if tool_name == 'calculate_bmi':
                    try:
                        height_cm = tool_input.get('height_cm', 0)
                        weight_kg = tool_input.get('weight_kg', 0)
                        bmi = weight_kg / ((height_cm/100) ** 2)
                        bmi_rounded = round(bmi, 1)
                        
                        bmi_interpretation = "Unknown"
                        if bmi < 18.5: bmi_interpretation = "Underweight"
                        elif 18.5 <= bmi < 25: bmi_interpretation = "Normal weight"
                        elif 25 <= bmi < 30: bmi_interpretation = "Overweight"
                        elif bmi >= 30: bmi_interpretation = "Obese"
                        
                        tool_result = {'name': 'calculate_bmi', 'input': tool_input, 'output': {'bmi': bmi_rounded, 'interpretation': bmi_interpretation}}
                        tool_calls.append(tool_result)
                        
                        assistant_response += f"\n\nBMI Calculation: {bmi_rounded} ({bmi_interpretation})"
                    except Exception as e:
                        print(f"Error processing BMI calculation: {str(e)}")
                        tool_calls.append({'name': 'calculate_bmi', 'error': str(e)})
                
                elif tool_name == 'calculate_mortality_risk':
                    try:
                        age = tool_input.get('age', 0)
                        gender = tool_input.get('gender', '').lower()
                        smoker = tool_input.get('smoker', False)
                        bmi = tool_input.get('bmi', 0)
                        
                        base_risk = age / 100.0
                        gender_factor = 1.0 if gender == 'male' else 0.85
                        smoking_factor = 1.8 if smoker else 1.0
                        bmi_factor = 1.0
                        if bmi < 18.5: bmi_factor = 1.2
                        elif 25 <= bmi < 30: bmi_factor = 1.1
                        elif 30 <= bmi < 35: bmi_factor = 1.3
                        elif bmi >= 35: bmi_factor = 1.6
                        
                        risk_score = min(10, base_risk * gender_factor * smoking_factor * bmi_factor * 10)
                        risk_score_rounded = round(risk_score, 1)
                        
                        if risk_score < 3: risk_interpretation = "Low risk"
                        elif risk_score < 6: risk_interpretation = "Moderate risk"
                        elif risk_score < 8: risk_interpretation = "High risk"
                        else: risk_interpretation = "Very high risk"
                        
                        tool_result = {'name': 'calculate_mortality_risk', 'input': tool_input, 'output': {'risk_score': risk_score_rounded, 'interpretation': risk_interpretation}}
                        tool_calls.append(tool_result)
                        
                        assistant_response += f"\n\nMortality Risk Assessment: {risk_score_rounded}/10 ({risk_interpretation})"
                    except Exception as e:
                        print(f"Error processing mortality risk calculation: {str(e)}")
                        tool_calls.append({'name': 'calculate_mortality_risk', 'error': str(e)})
                        
                elif tool_name == 'calculate_property_premium':
                    try:
                        property_value = tool_input.get('property_value', 0)
                        construction_type = tool_input.get('construction_type', '').lower()
                        protection_class = tool_input.get('protection_class', 5)
                        deductible = tool_input.get('deductible', 1000)
                        
                        base_rate = 3.5
                        construction_factors = {'wood frame': 1.2, 'masonry': 0.9, 'fire resistive': 0.7, 'mixed': 1.0}
                        construction_factor = construction_factors.get(construction_type, 1.0)
                        protection_factor = 0.7 + (protection_class - 1) * 0.1
                        deductible_factor = 1.0 - (math.log(deductible/500) * 0.05)
                        
                        annual_premium = property_value / 1000 * base_rate * construction_factor * protection_factor * deductible_factor
                        annual_premium_rounded = round(annual_premium, 2)
                        
                        tool_result = {'name': 'calculate_property_premium', 'input': tool_input, 'output': {'annual_premium': annual_premium_rounded}}
                        tool_calls.append(tool_result)
                        
                        assistant_response += f"\n\nEstimated Annual Premium: ${annual_premium_rounded:.2f}"
                    except Exception as e:
                        print(f"Error processing property premium calculation: {str(e)}")
                        tool_calls.append({'name': 'calculate_property_premium', 'error': str(e)})

        # Log the interaction in DynamoDB
        try:
            timestamp_now = datetime.now(timezone.utc).isoformat()
            
            # Get the last user message for logging
            last_user_message = ""
            if messages and messages[-1].get('sender') == 'user':
                last_user_message = messages[-1].get('text', '')

            chat_interaction = {
                'timestamp': timestamp_now,
                'user_message': last_user_message,
                'assistant_response': assistant_response
            }
            
            # Update the job with the chat interaction
            # Note: This is a simple append; in production you'd need a more 
            # sophisticated approach to handle chat history
            dynamodb.update_item(
                TableName=JOBS_TABLE_NAME,
                Key={'jobId': {'S': job_id}},
                UpdateExpression="SET #chat = list_append(if_not_exists(#chat, :empty_list), :interaction)",
                ExpressionAttributeNames={
                    '#chat': 'chatHistory'
                },
                ExpressionAttributeValues={
                    ':empty_list': {'L': []},
                    ':interaction': {'L': [{'M': {
                        'timestamp': {'S': timestamp_now},
                        'user_message': {'S': last_user_message},
                        'assistant_response': {'S': assistant_response}
                    }}]}
                }
            )
        except Exception as e:
            print(f"Error logging chat interaction: {str(e)}")
        
        return {
            'jobId': job_id,
            'response': assistant_response,
            'toolCalls': tool_calls
        }
    
    except Exception as e:
        print(f"Error in chat process for job {job_id}: {str(e)}")
        raise