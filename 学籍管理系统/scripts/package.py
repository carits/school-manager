from pathlib import Path
import tarfile
root=Path(__file__).resolve().parents[1]
with tarfile.open(root/'artifacts/source.tar.gz','w:gz') as t:
    for name in ['manage.py','requirements.txt','Dockerfile','compose.yml','.dockerignore','.gitignore','README.md','config','checks','templates','static','assets','deploy','wheelhouse']:
        p=root/name
        if p.is_dir():
            for f in p.rglob('*'):
                if f.is_file() and '__pycache__' not in str(f):t.add(f,arcname=str(f.relative_to(root)))
        else:t.add(p,arcname=name)
print('Source archive prepared without credentials or databases.')
