import os, glob, re

target_dir = r'e:\AI\tv_dashboard\client\src\components'
files = glob.glob(os.path.join(target_dir, '**', '*.jsx'), recursive=True)
files.append(r'e:\AI\tv_dashboard\client\src\App.jsx')

print(f'Found {len(files)} files to scan...')

# regex to find const { ... } = useTimeStore();
pattern = re.compile(r'const\s+\{([\s\S]*?)\}\s*=\s*useTimeStore\s*\(\)\s*;?')

count = 0
for f in files:
    with open(f, 'r', encoding='utf-8') as file:
        content = file.read()
    
    matches = list(pattern.finditer(content))
    if not matches:
        continue
        
    print(f'Matches found in {os.path.basename(f)}')
    new_content = content
    has_match = False
    
    for match in matches:
        has_match = True
        full_match = match.group(0)
        inner = match.group(1)
        
        # Split by comma
        parts = inner.split(',')
        replacements = []
        for p in parts:
            # remove line comments '// ... '
            p = re.sub(r'//.*', '', p)
            # trim whitespace/newlines
            p = p.strip()
            if not p: continue
            
            # handle 'alias' like foo: bar
            if ':' in p:
                orig = p.split(':')[0].strip()
                alias = p.split(':')[1].strip()
                replacements.append(f'const {alias} = useTimeStore(s => s.{orig});')
            else:
                replacements.append(f'const {p} = useTimeStore(s => s.{p});')
                
        # Handle original indentation
        match_start = match.start()
        last_newline = content.rfind('\n', 0, match_start)
        if last_newline != -1:
            indent = content[last_newline+1:match_start]
            if not indent.isspace():
                indent = ''
        else:
            indent = ''
            
        replacement_text = ('\n' + indent).join(replacements)
        new_content = new_content.replace(full_match, replacement_text)
        
    if has_match:
        with open(f, 'w', encoding='utf-8') as file:
            file.write(new_content)
        count += 1
        print(f'--> Refactored {os.path.basename(f)}')

print(f'\nTotal {count} files successfully refactored.')
