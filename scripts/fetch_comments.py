#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


GRAPHQL_QUERY = """
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number
      title
      url
      state
      isDraft
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          resolvedBy{login}
          comments(first:20){
            nodes{
              id
              author{login}
              body
              createdAt
              url
              path
              line
              originalLine
              replyTo{ id }
            }
          }
        }
      }
    }
  }
}
""".strip()


@dataclass
class RepoRef:
  owner: str
  name: str


def run_command(args: list[str]) -> str:
  result = subprocess.run(args, capture_output=True, text=True)
  if result.returncode != 0:
    stderr = result.stderr.strip()
    raise RuntimeError(stderr or f"command failed: {' '.join(args)}")
  return result.stdout.strip()


def get_current_branch() -> str:
  return run_command(["git", "branch", "--show-current"])


def get_repo_ref() -> RepoRef:
  payload = json.loads(run_command(["gh", "repo", "view", "--json", "owner,name"]))
  owner = payload.get("owner", {}).get("login")
  name = payload.get("name")
  if not owner or not name:
    raise RuntimeError("could not determine repository owner/name from gh repo view")
  return RepoRef(owner=owner, name=name)


def find_pr_number(branch: str) -> int:
  payload = json.loads(
    run_command(
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "number",
      ]
    )
  )
  if not payload:
    raise RuntimeError(f"no pull request found for branch {branch!r}")
  number = payload[0].get("number")
  if not isinstance(number, int):
    raise RuntimeError(f"unexpected PR payload for branch {branch!r}")
  return number


def fetch_review_threads(repo: RepoRef, pr_number: int) -> dict[str, Any]:
  output = run_command(
    [
      "gh",
      "api",
      "graphql",
      "-F",
      f"owner={repo.owner}",
      "-F",
      f"name={repo.name}",
      "-F",
      f"number={pr_number}",
      "-f",
      f"query={GRAPHQL_QUERY}",
    ]
  )
  payload = json.loads(output)
  pr = payload.get("data", {}).get("repository", {}).get("pullRequest")
  if not isinstance(pr, dict):
    raise RuntimeError(f"could not load PR #{pr_number}")
  return pr


def format_line_range(thread: dict[str, Any]) -> str:
  start = thread.get("startLine") or thread.get("originalStartLine")
  end = thread.get("line") or thread.get("originalLine")
  if isinstance(start, int) and isinstance(end, int):
    if start == end:
      return str(end)
    return f"{start}-{end}"
  if isinstance(end, int):
    return str(end)
  return "?"


def summarize_status(thread: dict[str, Any]) -> str:
  parts: list[str] = []
  if thread.get("isResolved"):
    resolver = thread.get("resolvedBy", {}).get("login")
    parts.append(f"resolved by {resolver}" if resolver else "resolved")
  else:
    parts.append("unresolved")
  if thread.get("isOutdated"):
    parts.append("outdated")
  return ", ".join(parts)


def print_block(text: str, prefix: str = "") -> None:
  stripped = text.strip("\n")
  if not stripped:
    print(prefix.rstrip())
    return
  lines = stripped.splitlines()
  first_prefix = prefix
  rest_prefix = " " * len(prefix)
  for index, line in enumerate(lines):
    active_prefix = first_prefix if index == 0 else rest_prefix
    print(f"{active_prefix}{line.rstrip()}")


def main() -> int:
  parser = argparse.ArgumentParser(description="Fetch GitHub review threads for the PR on the current branch.")
  parser.add_argument("--branch", help="Branch to inspect. Defaults to the current git branch.")
  parser.add_argument("--pr", type=int, help="Explicit PR number to inspect.")
  args = parser.parse_args()

  branch = args.branch or get_current_branch()
  repo = get_repo_ref()
  pr_number = args.pr if args.pr is not None else find_pr_number(branch)
  pr = fetch_review_threads(repo, pr_number)

  threads = pr.get("reviewThreads", {}).get("nodes", [])
  print(f"PR #{pr['number']}: {pr['title']}")
  print(pr["url"])
  print(f"State: {pr['state']}{' (draft)' if pr.get('isDraft') else ''}")
  print(f"Threads: {len(threads)}")
  print()

  if not threads:
    print("No review threads found.")
    return 0

  for index, thread in enumerate(threads, start=1):
    path = thread.get("path") or "<unknown>"
    line_range = format_line_range(thread)
    status = summarize_status(thread)
    print(f"[{index}] {path}:{line_range} [{status}]")
    comments = thread.get("comments", {}).get("nodes", [])
    for comment_index, comment in enumerate(comments, start=1):
      author = comment.get("author", {}).get("login") or "unknown"
      created_at = comment.get("createdAt") or "unknown time"
      prefix = f"  ({comment_index}) {author} @ {created_at}: "
      print_block(comment.get("body") or "", prefix=prefix)
      url = comment.get("url")
      if url:
        print(f"      {url}")
    print()

  unresolved = sum(1 for thread in threads if not thread.get("isResolved"))
  outdated = sum(1 for thread in threads if thread.get("isOutdated"))
  print(f"Summary: {unresolved} unresolved, {outdated} outdated.")
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except RuntimeError as error:
    print(f"error: {error}", file=sys.stderr)
    raise SystemExit(1)
