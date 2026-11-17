# Collects the Python files a piece of code needs, for Procoder's in-browser
# type checker. Runs on the SSH host with the host's own python3. It only READS
# files and parses them with `ast` (which never runs them): nothing the user
# wrote, and no installed package, is imported or executed.
#
# stdin:  {"root": dir, "code": [source text, ...], "files": [path, ...], "skip": [path, ...],
#          "maxFiles": n, "maxBytes": n}
# stdout: {"python": "3.12", "paths": [search dirs], "files": {path: text}, "more": bool}
import ast, glob, json, os, re, sys, sysconfig

req = json.load(sys.stdin)
root = os.path.realpath(req.get("root") or os.getcwd())
max_files = int(req.get("maxFiles") or 800)
max_bytes = int(req.get("maxBytes") or 24 * 1024 * 1024)
skip = set(req.get("skip") or [])

# Where imports are looked up: the project, a virtual environment inside it,
# then the interpreter's own non-standard-library directories. The standard
# library itself is not needed (the checker has its own description of it).
stdlib = {os.path.realpath(p) for p in (sysconfig.get_paths().get("stdlib"), sysconfig.get_paths().get("platstdlib")) if p}
paths = [root]
for venv in (".venv", "venv", "env", ".env"):
    if os.path.isfile(os.path.join(root, venv, "pyvenv.cfg")):
        paths += sorted(glob.glob(os.path.join(root, venv, "lib", "python3*", "site-packages")))
        paths += glob.glob(os.path.join(root, venv, "Lib", "site-packages"))
# Run with -I (so no file from the current folder can stand in for the modules
# this script uses); that also leaves out the user's own site-packages, which
# are added back here.
try:
    import site
    user_site = [site.getusersitepackages()]
except Exception:
    user_site = []
for p in [q for q in sys.path if q] + user_site:
    rp = os.path.realpath(p) if p else ""
    if rp and os.path.isdir(rp) and rp not in stdlib and not rp.endswith(".zip") and "lib-dynload" not in rp:
        paths.append(rp)
seen_paths = []
for p in paths:
    p = os.path.realpath(p)
    if p not in seen_paths and os.path.isdir(p):
        seen_paths.append(p)
paths = seen_paths

def module_file(base, parts):
    """The file for module `parts` under directory `base`, or None. Stubs (.pyi) first."""
    d = os.path.join(base, *parts[:-1]) if len(parts) > 1 else base
    last = parts[-1]
    for name in (last + ".pyi", last + ".py"):
        f = os.path.join(d, name)
        if os.path.isfile(f):
            return f
    for name in ("__init__.pyi", "__init__.py"):
        f = os.path.join(d, last, name)
        if os.path.isfile(f):
            return f
    return None

def resolve(dotted):
    """Files for a module and the packages above it, e.g. a.b -> a/__init__, a/b."""
    parts = dotted.split(".")
    for base in paths:
        # a separate stubs package (pandas-stubs) wins over the package itself
        stub = os.path.join(base, parts[0] + "-stubs")
        tops = [(stub, True)] if os.path.isdir(stub) else []
        tops.append((base, False))
        for top, is_stub in tops:
            found = []
            for i in range(1, len(parts) + 1):
                sub = parts[:i]
                f = module_file(top, (sub[1:] if is_stub else sub)) if (not is_stub or i > 1) else None
                if is_stub and i == 1:
                    f = next((os.path.join(top, n) for n in ("__init__.pyi", "__init__.py") if os.path.isfile(os.path.join(top, n))), None)
                if f is None:
                    break
                found.append(f)
            if found:
                return found
    return []

def package_of(path):
    """Dotted name of the package a file belongs to, found from the search dirs
    (the deepest one that holds it: a virtual environment sits inside the project)."""
    for base in sorted(paths, key=len, reverse=True):
        if path.startswith(base + os.sep):
            rel = os.path.relpath(path, base)[:-3 if path.endswith(".py") else -4].split(os.sep)
            if rel[0].endswith("-stubs"):
                rel[0] = rel[0][:-6]
            is_pkg = rel[-1] == "__init__"
            mod = rel[:-1] if is_pkg else rel
            return mod if is_pkg else mod[:-1]
    return None

IMPORT_LINE = re.compile(r"^\s*(?:from\s+(\.*[\w.]*)\s+import\s+\(?([\w\s,.*]+)|import\s+([\w\s,.]+))")

def nodes_of(text):
    """Import statements of the text. The file being edited is often half
    written and does not parse; then its import lines are read one by one."""
    try:
        return [n for n in ast.walk(ast.parse(text)) if isinstance(n, (ast.Import, ast.ImportFrom))]
    except (SyntaxError, ValueError):
        pass
    out = []
    for line in text.splitlines():
        m = IMPORT_LINE.match(line)
        if not m:
            continue
        if m.group(3):
            names = [ast.alias(name=n.split()[0]) for n in m.group(3).split(",") if n.strip()]
            out.append(ast.Import(names=names))
        else:
            dots = len(m.group(1)) - len(m.group(1).lstrip("."))
            names = [ast.alias(name=n.split()[0]) for n in m.group(2).split(",") if n.strip()]
            out.append(ast.ImportFrom(module=m.group(1).lstrip(".") or None, names=names, level=dots))
    return out

def imports_of(text, path):
    pkg = package_of(path) if path else None
    out = []
    for node in nodes_of(text):
        if isinstance(node, ast.Import):
            out += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                if pkg is None:
                    continue
                base = pkg[: len(pkg) - (node.level - 1)] if node.level > 1 else pkg
                if node.level - 1 > len(pkg):
                    continue
                mod = ".".join(base + ([node.module] if node.module else []))
            else:
                mod = node.module or ""
            if mod:
                out.append(mod)
            out += [(mod + "." if mod else "") + a.name for a in node.names if a.name != "*"]
    return out

files = {}
size = 0
more = False
queue = []
for text in req.get("code") or []:
    queue += imports_of(text, None)
for f in req.get("files") or []:
    try:
        with open(f, encoding="utf-8") as fh:
            queue += imports_of(fh.read(), os.path.realpath(f))
    except OSError:
        pass
done = set()
while queue:
    name = queue.pop(0)
    if name in done:
        continue
    done.add(name)
    for f in resolve(name):
        if f in files or f in skip:
            continue
        if len(files) >= max_files or size >= max_bytes:
            more = True
            queue = []
            break
        try:
            if os.path.getsize(f) > 2 * 1024 * 1024:
                continue
            with open(f, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        files[f] = text
        size += len(text)
        queue += imports_of(text, f)

json.dump({"python": "%d.%d" % sys.version_info[:2], "paths": paths, "files": files, "more": more}, sys.stdout)
