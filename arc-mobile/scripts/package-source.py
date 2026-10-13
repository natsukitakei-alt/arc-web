from pathlib import Path
import zipfile

project = Path(__file__).resolve().parents[1]
archive = project.parent / 'arc-mobile-source.zip'
excluded = { 'node_modules', '.wrangler', '.review-build', '.npm-cache', '.git' }
paths = [p for p in project.rglob('*') if p.is_file() and not excluded.intersection(p.relative_to(project).parts)
         and not (p.name.startswith('.env') and p.name != '.env.example') and p.name != '.dev.vars']
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for item in paths:
        bundle.write(item, 'arc-mobile/' + item.relative_to(project).as_posix())
print(f'{len(paths)} source files; {archive.stat().st_size} bytes; no credentials or dependencies')
