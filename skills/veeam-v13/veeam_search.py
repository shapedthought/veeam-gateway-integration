import json
import sys
import os

# Set search file path relative to this script
SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
swagger_path = os.path.join(SKILL_DIR, "swagger.json")

if not os.path.exists(swagger_path):
    # Fallback to absolute downloads path for local testing
    swagger_path = "/Users/edwardhoward/Downloads/swagger.json"

try:
    with open(swagger_path, "r", encoding="utf-8") as f:
        swagger_data = json.load(f)
except Exception as e:
    print(f"Error loading swagger.json: {e}")
    sys.exit(1)

def resolve_ref(ref_path):
    if not ref_path.startswith("#/"):
        return {"error": f"External ref not supported: {ref_path}"}
    parts = ref_path.split("/")[1:]
    curr = swagger_data
    for p in parts:
        curr = curr.get(p, {})
    return curr

def format_schema(schema, indent=0, visited=None):
    if visited is None:
        visited = set()
    
    if not schema:
        return "Any"
    
    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in visited:
            return f"CircularRef({ref})"
        visited.add(ref)
        resolved = resolve_ref(ref)
        result = format_schema(resolved, indent, visited)
        visited.remove(ref)
        return result
    
    s_type = schema.get("type", "object")
    
    if s_type == "object":
        properties = schema.get("properties", {})
        if not properties:
            return "{}"
        
        lines = ["{"]
        pad = "  " * (indent + 1)
        for name, prop in properties.items():
            required = " (required)" if name in schema.get("required", []) else ""
            desc = f" // {prop.get('description')}" if prop.get("description") else ""
            prop_formatted = format_schema(prop, indent + 1, visited)
            lines.append(f"{pad}{name}{required}: {prop_formatted}{desc}")
        lines.append("  " * indent + "}")
        return "\n".join(lines)
    
    elif s_type == "array":
        items = schema.get("items", {})
        items_formatted = format_schema(items, indent, visited)
        if "\n" in items_formatted:
            return f"[\n{items_formatted}\n" + ("  " * indent) + "]"
        return f"[{items_formatted}]"
    
    else:
        enum_val = f" (enum: {schema.get('enum')})" if "enum" in schema else ""
        return f"{s_type}{enum_val}"

def search_swagger(query):
    paths = swagger_data.get("paths", {})
    results = []
    query = query.lower()

    for path, path_data in paths.items():
        for method, method_data in path_data.items():
            if method not in ["get", "post", "put", "delete", "patch"]:
                continue
            
            summary = method_data.get("summary", "")
            description = method_data.get("description", "")
            tags = method_data.get("tags", [])
            operation_id = method_data.get("operationId", "")

            match = (
                query in path.lower() or 
                query in summary.lower() or 
                query in description.lower() or
                any(query in t.lower() for t in tags) or
                query in operation_id.lower()
            )

            if match:
                results.append({
                    "path": path,
                    "method": method.upper(),
                    "summary": summary,
                    "description": description
                })

    print(f"Found {len(results)} matches for '{query}':\n")
    for r in results[:15]:
        print(f"[{r['method']}] {r['path']}")
        print(f"  Summary: {r['summary']}")
        print(f"  Description: {r['description'][:120]}...")
        print("-" * 50)
    if len(results) > 15:
        print(f"... and {len(results) - 15} more matches. Refine your query or use 'inspect' on a specific path.")

def inspect_endpoint(method, target_path):
    paths = swagger_data.get("paths", {})
    target_path = target_path.strip().lower()
    method = method.strip().lower()
    
    matched_path = None
    for p in paths.keys():
        if p.strip().lower() == target_path:
            matched_path = p
            break
            
    if not matched_path:
        for p in paths.keys():
            if target_path in p.strip().lower():
                matched_path = p
                print(f"Did you mean: {p}?")
                break
        if not matched_path:
            print(f"Path '{target_path}' not found.")
            return
            
    path_data = paths[matched_path]
    if method not in path_data:
        available = [m.upper() for m in path_data.keys() if m in ["get", "post", "put", "delete", "patch"]]
        print(f"Method '{method.upper()}' not found for path '{matched_path}'. Available: {available}")
        return
        
    op_data = path_data[method]
    
    print(f"==================================================")
    print(f"[{method.upper()}] {matched_path}")
    print(f"Summary: {op_data.get('summary', 'No summary')}")
    print(f"Description: {op_data.get('description', 'No description')}")
    print(f"==================================================")
    
    params = op_data.get("parameters", [])
    if params:
        print("\nURL Parameters:")
        for p in params:
            p_in = p.get("in", "query")
            p_name = p.get("name")
            p_required = "required" if p.get("required") else "optional"
            p_desc = p.get("description", "").strip()
            p_type = p.get("schema", {}).get("type", "string")
            print(f"  - {p_name} ({p_in}, {p_type}, {p_required}): {p_desc}")
            
    req_body = op_data.get("requestBody", {})
    if req_body:
        print("\nRequest Body:")
        required = "required" if req_body.get("required") else "optional"
        content = req_body.get("content", {})
        for mime, media in content.items():
            print(f"  Content-Type: {mime} ({required})")
            schema = media.get("schema", {})
            print("  Schema:")
            print(format_schema(schema, indent=2))
            
    responses = op_data.get("responses", {})
    if responses:
        print("\nResponses:")
        for code, resp in responses.items():
            desc = resp.get("description", "").strip()
            print(f"  {code}: {desc}")

def print_help():
    print("Veeam REST API Swagger Helper")
    print("Usage:")
    print("  python3 veeam_search.py search <query>           - Search for endpoints")
    print("  python3 veeam_search.py inspect <method> <path>  - Inspect an endpoint schema")
    print("Examples:")
    print("  python3 veeam_search.py search jobs")
    print("  python3 veeam_search.py inspect POST /api/v1/jobs")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print_help()
        sys.exit(1)
        
    action = sys.argv[1].lower()
    if action == "search":
        search_swagger(sys.argv[2])
    elif action == "inspect":
        if len(sys.argv) < 4:
            print("Error: inspect requires both HTTP method and API path.")
            print("Example: python3 veeam_search.py inspect POST /api/v1/jobs")
            sys.exit(1)
        inspect_endpoint(sys.argv[2], sys.argv[3])
    else:
        print_help()
        sys.exit(1)
