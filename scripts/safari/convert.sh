#!/bin/sh
# Turn the xslop web extension into an Xcode project for Safari on macOS and iOS.
# Run this on a Mac with Xcode. The argument is the extension folder, or the zip that the build made.
#   sh scripts/safari/convert.sh [extension/dist/safari | xslop-safari-v<version>.zip] [output folder]
set -eu

source="${1:-extension/dist/safari}"
output="${2:-safari-app}"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "convert: xcrun is missing. Run this script on a Mac with Xcode." >&2
  exit 1
fi

case "$source" in
  *.zip)
    folder="$(mktemp -d)"
    trap 'rm -rf "$folder"' EXIT
    unzip -q "$source" -d "$folder"
    ;;
  *)
    folder="$source"
    ;;
esac

if [ ! -f "$folder/manifest.json" ]; then
  echo "convert: $source has no manifest.json. Build the extension first: npm --prefix extension run build" >&2
  exit 1
fi

# Apple renamed the tool; older Xcode has only the first name.
tool=safari-web-extension-packager
xcrun --find "$tool" >/dev/null 2>&1 || tool=safari-web-extension-converter
xcrun "$tool" "$folder" \
  --project-location "$output" \
  --app-name xslop \
  --bundle-identifier com.koglabs.xslop \
  --swift \
  --no-open \
  --no-prompt \
  --copy-resources
