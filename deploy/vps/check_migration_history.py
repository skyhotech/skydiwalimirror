"""Fail before rsync if an automatic release has incompatible/pending migrations.

Standard library only. Reads source files and a deployed Django showmigrations
plan; never imports settings, connects to a DB, writes files or runs migrations.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

APP = "mirrors"


def manifest(backend):
    folder = Path(backend) / APP / "migrations"
    if not folder.is_dir():
        raise ValueError("Project migration directory is missing")
    files = {f.stem: hashlib.sha256(f.read_bytes()).hexdigest()
             for f in folder.glob("*.py") if re.fullmatch(r"[0-9]+_[A-Za-z0-9_]+", f.stem)}
    if not files:
        raise ValueError("No project migrations found")
    return files


def check(incoming, deployed, plan):
    applied = set(re.findall(r"^\[X\]\s+mirrors\.([A-Za-z0-9_]+)\s*$", plan, re.MULTILINE))
    if not applied:
        raise ValueError("No applied project migration history found; bootstrap requires a separate reviewed procedure")
    missing = applied - incoming.keys()
    changed = {name for name in applied & incoming.keys() if deployed.get(name) != incoming[name]}
    pending = incoming.keys() - applied
    if missing or changed or pending:
        issues = []
        for label, names in (("Applied migrations missing from incoming source", missing),
                             ("Applied migration content differs", changed),
                             ("Unapplied incoming migrations require reviewed manual release", pending)):
            if names:
                issues.append(label + ": " + ", ".join(sorted(names)))
        raise ValueError("\n".join(issues))
    return len(applied)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", type=Path, required=True)
    parser.add_argument("--manifest", action="store_true")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--deployed-manifest", type=Path)
    args = parser.parse_args()
    try:
        incoming = manifest(args.backend)
        if args.manifest:
            print(json.dumps(incoming, sort_keys=True))
            return 0
        if not args.plan or not args.deployed_manifest:
            parser.error("--plan and --deployed-manifest are required for a release check")
        count = check(incoming, json.loads(args.deployed_manifest.read_text()), args.plan.read_text())
        print(f"Migration preflight passed: {count} applied migrations match; none pending")
        return 0
    except (ValueError, OSError) as exc:
        print(f"Deployment blocked before upload: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
