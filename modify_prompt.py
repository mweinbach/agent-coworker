import sys

file_path = "src/prompt.ts"

with open(file_path, "r") as f:
    content = f.read()

search_code = """  for (const [k, v] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${k}}}`, v);
  }"""

replace_code = """  prompt = prompt.replace(/{{(\\w+)}}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });"""

if search_code in content:
    new_content = content.replace(search_code, replace_code)
    with open(file_path, "w") as f:
        f.write(new_content)
    print("Successfully modified src/prompt.ts")
else:
    print("Could not find search code in src/prompt.ts")
    # For debugging
    # print(content)
    sys.exit(1)
