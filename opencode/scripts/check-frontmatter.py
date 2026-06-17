#!/usr/bin/env python3
"""Validate opencode agent/command/skill frontmatter. Usage: check-frontmatter.py <kind> <file>..."""
import sys, re

def parse_frontmatter(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        raise SystemExit(f"{path}: no YAML frontmatter")
    try:
        import yaml
        return yaml.safe_load(m.group(1)) or {}
    except ModuleNotFoundError:
        # Minimal fallback: flat key: value + one level of two-space-indented map.
        data, cur = {}, None
        for line in m.group(1).splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if re.match(r"^\s{2,}\S", line):
                k, _, v = line.strip().partition(":")
                if cur is not None:
                    data.setdefault(cur, {})[k.strip()] = v.strip()
            else:
                k, _, v = line.partition(":")
                v = v.strip()
                if v == "":
                    cur = k.strip(); data[cur] = {}
                else:
                    cur = None; data[k.strip()] = v
        return data

def fail(p, msg): raise SystemExit(f"{p}: {msg}")

def check_agent(p, fm):
    if "description" not in fm: fail(p, "missing description")
    if fm.get("mode") != "subagent": fail(p, "mode must be subagent")
    if fm.get("hidden") not in (True, "true"): fail(p, "hidden must be true")
    if "model" in fm: fail(p, "must NOT pin model (inherit session model)")
    tools = fm.get("tools")
    if not isinstance(tools, dict): fail(p, "tools must be a map, not a list")
    for k in ("write", "edit"):
        if tools.get(k) not in (False, "false"): fail(p, f"tools.{k} must be false")

def check_command(p, fm):
    if "description" not in fm: fail(p, "missing description")
    if "agent" in fm and not isinstance(fm["agent"], str): fail(p, "agent must be a string")

def check_skill(p, fm):
    name = fm.get("name")
    if not name or not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", str(name)): fail(p, "bad/missing name")
    if "description" not in fm: fail(p, "missing description")

CHECKS = {"agent": check_agent, "command": check_command, "skill": check_skill}

def main():
    kind, files = sys.argv[1], sys.argv[2:]
    for p in files:
        CHECKS[kind](p, parse_frontmatter(p))
        print(f"OK  {p}")

if __name__ == "__main__":
    main()
