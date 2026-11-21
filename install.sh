#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/itsthecogumellum/opencode-failover"
DEST="$HOME/.config/opencode-failover"
PORT="${FAILOVER_PORT:-8787}"

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required."; exit 1; }
MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$MAJOR" -ge 20 ] || { echo "Node.js 20+ is required (found $MAJOR)."; exit 1; }

if [ -f "$(dirname "$0")/src/cli.mjs" ]; then
  SRC="$(cd "$(dirname "$0")" && pwd)"
else
  TMP="$(mktemp -d)"
  echo "downloading repository..."
  git clone --depth 1 "$REPO" "$TMP/repo" >/dev/null 2>&1
  SRC="$TMP/repo"
fi

mkdir -p "$DEST"
for item in src scripts skill package.json README.md LICENSE; do
  [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$DEST/"
done

CONFIG="$DEST/gateway.json"
if [ ! -f "$CONFIG" ]; then
  cp "$SRC/gateway.config.example.json" "$CONFIG"
  node -e '
    const fs = require("fs");
    const [path, port] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    config.port = Number(port);
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  ' "$CONFIG" "$PORT"
  echo "config created: $CONFIG"
else
  echo "config kept:    $CONFIG"
fi

mkdir -p "$DEST/bin"
cat > "$DEST/bin/failover" <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/.config/opencode-failover/src/cli.mjs" "$@"
EOF
chmod +x "$DEST/bin/failover"

case ":$PATH:" in
  *":$DEST/bin:"*) ;;
  *)
    echo "export PATH=\"$DEST/bin:\$PATH\"" >> "$HOME/.bashrc"
    echo "PATH: added $DEST/bin to ~/.bashrc (open a new shell)"
    export PATH="$DEST/bin:$PATH"
    ;;
esac

FAILOVER_PORT="$PORT" node "$DEST/scripts/register.mjs"

echo ""
echo "done."
echo ""
echo "1. edit your keys and models:  $CONFIG"
echo "2. start the gateway:          failover serve"
echo "3. check the chain:            failover status"
echo "4. pick the model in OpenCode: failover/auto"
echo ""
echo "The gateway only uses providers you already have credentials for."
echo "It fails over. It does not create new quotas or change your IP."
