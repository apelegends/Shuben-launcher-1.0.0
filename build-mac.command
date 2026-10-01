#!/bin/bash
# Double-click on a Mac to build Shuben Launcher as a .dmg
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install it from https://nodejs.org (version 22), then run this again."
  read -p "Press Enter to close"
  exit 1
fi
npm install && npm run dist:mac && open dist
read -p "Done. Press Enter to close"
