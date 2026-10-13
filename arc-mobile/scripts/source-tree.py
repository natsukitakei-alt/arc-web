from pathlib import Path
import json
import base64

root = Path(__file__).resolve().parents[1]
excluded = {'node_modules', '.wrangler', '.review-build', '.npm-cache', '.git'}
entries = []
for file in root.rglob('*'):
    if not file.is_file() or excluded.intersection(file.relative_to(root).parts):
        continue
    if file.name.startswith('.env') and file.name != '.env.example' or file.name == '.dev.vars':
        continue
    data = file.read_bytes()
    entry = {'path': 'arc-mobile/' + file.relative_to(root).as_posix(), 'mode': '100644', 'type': 'blob'}
    if file.suffix == '.png':
        entry['base64'] = base64.b64encode(data).decode('ascii')
    else:
        text = data.decode('utf-8')
        entry['content'] = text
    entries.append(entry)
print(json.dumps(entries, ensure_ascii=True))
