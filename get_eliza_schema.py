import os
import json
from supabase import create_client, Client

# Get environment variables
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Fetch the schema for eliza_function_usage
response = supabase.table("eliza_function_usage").select("*").limit(0).execute()

# Extract the column names and types from the response
if response and hasattr(response, 'columns'):
    columns = [{'name': col.get('name'), 'type': col.get('type')} for col in response.columns]
    print(json.dumps(columns))
else:
    print(f"Error: Unable to fetch schema, Response: {response}")
