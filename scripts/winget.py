#!/usr/bin/env python3
"""Checks and fills the winget manifests of the carbium CLI (manifest schema 1.28.0).

  winget.py check DIR [--sums SHA256SUMS] [--schemas SCHEMA_DIR]
  winget.py fill DIR VERSION SHA256SUMS OUTDIR [--schemas SCHEMA_DIR]

check: the version, defaultLocale and installer manifests in DIR against the winget JSON schemas, plus what the schemas
do not cover: the same identifier and version in all three, the file and folder names, InstallerType, and each
InstallerUrl being the cli-v<version> release asset for its architecture. With --sums every InstallerSha256 must equal
its SHA256SUMS line, so a placeholder hash fails.
fill: writes OUTDIR/manifests/<letter>/<identifier parts>/VERSION with VERSION and the SHA256SUMS hashes, then checks it
with --sums.
The schemas are downloaded from a pinned winget-cli commit, or read from SCHEMA_DIR (the same files saved beforehand),
and refused unless their SHA-256 matches its pin. Needs python3-jsonschema and python3-yaml. Exit 1 on any problem.
"""
import argparse, hashlib, json, os, re, sys, urllib.request
import jsonschema, yaml

SCHEMA = 'https://raw.githubusercontent.com/microsoft/winget-cli/d9acda871de78385492753450218694d54cd1078/schemas/JSON/manifests/v1.28.0/manifest.{}.1.28.0.json'
PINS = {'version': '5c9fa37ebe70dd410114157d31e4d9e84451b2bb8890e1c4345b4c690406ee1a',
        'defaultLocale': '734c069c82470e3436d274fb381bfbe03e22f8fbfae2d2dd50df7dc055a3e061',
        'installer': '2caa4cd3a630c284b5ef750522e2e5861f751f376180b89cd29873eb30504ef4'}
ASSET = 'https://github.com/carbium-sh/carbium-js/releases/download/cli-v{}/carbium-windows-{}.exe'
VERSION = re.compile(r'\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?')  # what carbium --version prints, as install.sh takes it
ZERO = '0' * 64
problems = []

def bad(where, msg): problems.append(f'{where}: {msg}')

def schemas(folder):
    out = {}
    for kind, pin in PINS.items():
        name = f'manifest.{kind}.1.28.0.json'
        if folder:
            with open(os.path.join(folder, name), 'rb') as f: body = f.read()
        else: body = urllib.request.urlopen(SCHEMA.format(kind), timeout=60).read()
        if hashlib.sha256(body).hexdigest() != pin: sys.exit(f'{name}: SHA-256 differs from the pin')
        out[kind] = jsonschema.Draft7Validator(json.loads(body), format_checker=jsonschema.FormatChecker())
    return out

class Loader(yaml.SafeLoader): pass  # winget reads dates and versions as strings; a duplicate key is an error
Loader.yaml_implicit_resolvers = {k: [r for r in v if r[0] != 'tag:yaml.org,2002:timestamp']
                                  for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
def mapping(loader, node, deep=False):
    keys = [loader.construct_object(k, deep=deep) for k, _ in node.value]
    for k in {k for k in keys if keys.count(k) > 1}: raise yaml.MarkedYAMLError(problem=f'duplicate key {k}', problem_mark=node.start_mark)
    return loader.construct_mapping(node, deep)
Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)

def load(path):
    with open(path, encoding='utf-8') as f: return yaml.load(f, Loader=Loader)

def sums(path):  # sha256sum lines with plain file names
    out = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            m = re.fullmatch(r'([0-9a-fA-F]{64}) [ *](\S+)\n?', line)
            if not m: sys.exit(f'{path}: not a sha256sum line: {line!r}')
            out[m[2]] = m[1].upper()
    return out

def check(d, table, kinds):
    docs = {}
    for name in sorted(os.listdir(d)):
        try: doc = load(os.path.join(d, name))
        except (OSError, UnicodeDecodeError, yaml.YAMLError) as e: bad(name, f'YAML: {e}'); continue
        kind = doc.get('ManifestType') if isinstance(doc, dict) else None
        if kind not in kinds or kind in docs: bad(name, f'ManifestType {kind!r}: the folder needs one each of {", ".join(kinds)}'); continue
        for e in sorted(kinds[kind].iter_errors(doc), key=lambda e: list(map(str, e.absolute_path))):
            bad(name, f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}")
        docs[kind] = (name, doc)
    if set(docs) != set(kinds): return bad(d, f'has {sorted(docs)}, needs version, defaultLocale and installer')
    ident, ver, locale = (str(docs['version'][1].get(k)) for k in ('PackageIdentifier', 'PackageVersion', 'DefaultLocale'))
    if not VERSION.fullmatch(ver): bad(docs['version'][0], f'PackageVersion {ver!r} is not X.Y.Z or X.Y.Z-pre')
    for name, doc in docs.values():
        for key, want in (('PackageIdentifier', ident), ('PackageVersion', ver), ('ManifestVersion', '1.28.0')):
            if doc.get(key) != want: bad(name, f'{key} {doc.get(key)!r}, expected {want!r}')
    if docs['defaultLocale'][1].get('PackageLocale') != locale: bad(docs['defaultLocale'][0], 'PackageLocale differs from DefaultLocale')
    for kind, want in (('version', f'{ident}.yaml'), ('defaultLocale', f'{ident}.locale.{locale}.yaml'), ('installer', f'{ident}.installer.yaml')):
        if docs[kind][0] != want: bad(d, f'{kind} file is {docs[kind][0]}, expected {want}')
    folder = os.path.join('manifests', ident[:1].lower(), *ident.split('.'), ver)
    if not os.path.normpath(os.path.abspath(d)).endswith(os.sep + folder): bad(d, f'folder must end with {folder}')
    name, inst = docs['installer']
    seen = set()
    for i in inst.get('Installers') or []:
        arch, where = i.get('Architecture'), f"{name} {i.get('Architecture')}"
        key = tuple(i.get(k, inst.get(k)) for k in ('Architecture', 'InstallerType', 'Scope', 'InstallerLocale'))
        if key in seen: bad(where, 'two installers share Architecture, InstallerType, Scope and InstallerLocale')
        seen.add(key)
        if not (i.get('InstallerType') or inst.get('InstallerType')): bad(where, 'InstallerType missing at the root and in the installer')
        url, sha = ASSET.format(ver, arch), str(i.get('InstallerSha256')).upper()
        if i.get('InstallerUrl') != url: bad(where, f'InstallerUrl must be {url}')
        if table is None: continue
        if sha == ZERO: bad(where, 'placeholder hash left')
        elif table.get(url.rsplit('/', 1)[-1]) != sha: bad(where, f"InstallerSha256 differs from the SHA256SUMS line for {url.rsplit('/', 1)[-1]}")

def fill(src, ver, sumfile, outdir, kinds):
    if not VERSION.fullmatch(ver): sys.exit(f'version {ver!r} is not X.Y.Z or X.Y.Z-pre')
    table = sums(sumfile)
    ident = next(doc['PackageIdentifier'] for doc in (load(os.path.join(src, n)) for n in os.listdir(src)) if doc.get('ManifestType') == 'version')
    out = os.path.join(outdir, 'manifests', ident[:1].lower(), *ident.split('.'), ver)
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(src):
        with open(os.path.join(src, name), encoding='utf-8') as f: text = f.read()
        text = re.sub(r'(?m)^PackageVersion: .*$', f'PackageVersion: {ver}', text)
        text = re.sub(r'cli-v[0-9][0-9A-Za-z.+-]*', f'cli-v{ver}', text)
        url, lines = None, []
        for line in text.splitlines(keepends=True):
            m = re.match(r'\s*(?:- )?InstallerUrl: (\S+)', line)
            if m: url = m[1]
            m = re.match(r'(\s*(?:- )?InstallerSha256: ).*', line)
            if m and url:
                asset = url.rsplit('/', 1)[-1]
                if asset not in table: sys.exit(f'{asset} is not in {sumfile}')
                line = m[1] + table[asset] + '\n'
            lines.append(line)
        with open(os.path.join(out, name), 'w', encoding='utf-8') as f: f.write(''.join(lines))
    check(out, table, kinds)
    return out

if __name__ == '__main__':
    p = argparse.ArgumentParser(usage=__doc__.split('\n\n')[1].strip())
    sub = p.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check')
    c.add_argument('dir')
    c.add_argument('--sums')
    f = sub.add_parser('fill')
    for arg in ('dir', 'version', 'sums', 'outdir'): f.add_argument(arg)
    for s in (c, f): s.add_argument('--schemas')
    a = p.parse_args()
    kinds = schemas(a.schemas)
    if a.cmd == 'check': check(a.dir, sums(a.sums) if a.sums else None, kinds)
    else: print('wrote', fill(a.dir, a.version, a.sums, a.outdir, kinds))
    for line in problems: print(line)
    print(f'{len(problems)} problem(s)')
    sys.exit(1 if problems else 0)
