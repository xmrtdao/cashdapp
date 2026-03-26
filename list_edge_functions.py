import os
import json

def list_edge_functions(functions_path):
    functions_data = []
    for filename in os.listdir(functions_path):
        full_path = os.path.join(functions_path, filename)
        if os.path.isdir(full_path):
            function_data = {"name": filename, "path": full_path}
            functions_data.append(function_data)
    return functions_data

functions_path = "C:\\Users\\PureTrek\\Desktop\\DevGruGold\\suite\\supabase\\functions" # path of function you want to run

functions_list = list_edge_functions(functions_path)


# Write results to a json file
filepath = "C:\\Users\\PureTrek\\Desktop\\Suite Files\\edge_functions.json"
with open(filepath, 'w') as f:
    json.dump(functions_list, f, indent=4)
print(f"Successfully wrote to {filepath}")