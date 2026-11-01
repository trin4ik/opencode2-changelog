# A clean machine with one OpenCode version from npm, for test/install.mjs. Nothing of the plugin is baked in.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tmux \
  && rm -rf /var/lib/apt/lists/*
ARG OPENCODE_VERSION
RUN npm install -g --no-audit --no-fund "@opencode/cli@${OPENCODE_VERSION}"
RUN useradd --create-home tester
USER tester
WORKDIR /home/tester
