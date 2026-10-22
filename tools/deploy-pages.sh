#!/bin/sh
# Publish the committed docs/ folder as the gh-pages branch, which GitHub Pages serves.
# Usage: npm run site, commit docs/ and push main, then: sh tools/deploy-pages.sh
set -e
git fetch -q origin gh-pages 2>/dev/null || true
parent=$(git rev-parse -q --verify origin/gh-pages || true)
commit=$(git commit-tree HEAD:docs ${parent:+-p $parent} -m "Website build from main:docs ($(git rev-parse --short HEAD))")
git push origin "$commit:refs/heads/gh-pages"
