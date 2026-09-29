#!/usr/bin/env python3
"""Apply the upstream r10->r21 Linux patch chain onto current main.

Each upstream patch was generated against a differently-named build directory
(r11/app/..., /mnt/data/SC-Overlay-Custom-Linux-0.1.33-r14-browser-f-hover/...),
so the +/- headers carry a varying number of leading path components. This
rewrites both sides of every file header to a clean repo-relative path, then
applies file-by-file so one conflicted file doesn't sink the whole patch.
"""
import os
import re
import subprocess
import sys
import tempfile

PATCH_DIR = sys.argv[1]
REPO = sys.argv[2]

# Subtrees that exist in the repo. Anything else (READMEs, install scripts,
# PKGBUILD, tests) is a packaging artifact of their tarball layout, not code.
KEEP = ("electron/", "src/", "overlay/", "data/", "package.json",
        "package-lock.json", "tools/", "tsconfig.json")

PATCHES = sorted(
    os.path.join(PATCH_DIR, f) for f in os.listdir(PATCH_DIR)
    if f.endswith(".patch")
)


def rel_path(header: str) -> str | None:
    """Strip the build-dir prefixes off a ---/+++ header path."""
    p = header.split("\t")[0].strip()
    p = re.sub(r"^[ab]/", "", p)
    # Drop everything up to and including a known build-dir component.
    for marker in ("/app/", "/orig/"):
        if marker in p:
            p = p.split(marker, 1)[1]
            break
    else:
        p = p.split("/SC-Overlay-", 1)[-1]
        if "/" in p and not p.startswith(("electron/", "src/", "overlay/")):
            p = p.split("/", 1)[1] if "/" in p else p
    return p


def wanted(path: str) -> bool:
    return any(path == k or path.startswith(k) for k in KEEP)


def split_by_file(text: str) -> list[tuple[str, str]]:
    """Yield (repo-relative path, per-file patch text) for a unified diff."""
    lines = text.splitlines(keepends=True)
    out, cur, cur_path = [], [], None
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("--- "):
            # new file section: drop anything buffered from a previous file
            cur, cur_path = [], None
            j = i
            old = rel_path(line)
            plus = lines[j + 1] if j + 1 < len(lines) else ""
            if not plus.startswith("+++ "):
                i += 1
                continue
            new = rel_path(plus)
            # prefer the +++ side; fall back to --- for deletions
            target = new or old
            if not target or not wanted(target):
                i += 2
                continue
            cur_path = target
            # Rewrite the headers to clean repo-relative paths. The originals
            # carry the build-dir prefixes, which is what made git look for
            # e.g. "app/electron/main.cjs" and bail.
            is_new = old is None or new is None
            cur = [
                "--- /dev/null\n" if is_new else f"--- a/{target}\n",
                "+++ /dev/null\n" if False else f"+++ b/{target}\n",
            ]
            i = j + 2
            continue
        if cur_path is not None:
            # hunk header, or a diff body line
            if line.startswith("@@") or line.startswith(("+", "-", " ", "\\")):
                cur.append(line)
        i += 1
        if cur_path and i < len(lines) and lines[i].startswith("--- "):
            out.append((cur_path, "".join(cur)))
            cur, cur_path = [], None
    if cur_path:
        out.append((cur_path, "".join(cur)))
    return out


def run(args, **kw):
    return subprocess.run(args, cwd=REPO, capture_output=True, text=True, **kw)


def apply_one(patch: str) -> tuple[int, int, list[str]]:
    text = open(patch, encoding="utf-8", errors="replace").read()
    files = split_by_file(text)
    ok = fail = 0
    notes = []
    for path, body in files:
        with tempfile.NamedTemporaryFile("w", suffix=".patch", delete=False) as fh:
            fh.write(body)
            tmp = fh.name
        # Try 3-way first (handles context drift against 0.1.47), then fall
        # back to a context match, then to a strict reject. The upstream
        # diffs carry no index lines, so 3-way is only available when git can
        # infer it — hence the ordered fallbacks rather than one call.
        r = run(["git", "apply", "--recount", "--3way", tmp])
        if r.returncode != 0:
            r = run(["git", "apply", "--recount", "-C1", tmp])
        if r.returncode != 0:
            r = run(["git", "apply", "--recount", "--reject", tmp])
        if r.returncode == 0:
            ok += 1
        else:
            fail += 1
            first = (r.stderr or r.stdout).strip().splitlines()
            notes.append(f"{path}: {first[0][:80] if first else 'failed'}")
        os.unlink(tmp)
    return ok, fail, notes


total_ok = total_fail = 0
for p in PATCHES:
    label = os.path.basename(p).replace("SC-Overlay-0.1.33-", "").replace(".patch", "")
    ok, fail, notes = apply_one(p)
    total_ok += ok
    total_fail += fail
    print(f"{label:<34} {ok:>2} applied  {fail:>2} failed")
    for n in notes:
        print(f"    {n}")
    if fail and "--continue" not in sys.argv:
        print(f"  stopping after first failure ({label})")
        break

print(f"\ntotal: {total_ok} applied, {total_fail} failed")
