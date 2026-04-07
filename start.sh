#!/bin/bash
# Unloading Dock — start proxy then launch claude
export ANTHROPIC_BASE_URL=http://localhost:3579
node "$(dirname "$0")/proxy.js"
