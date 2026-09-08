#!/bin/bash
# Build the whatsapp-seerr image and export it as a tar file.
# Run this on any machine WITH docker + internet access (build pulls the
# package.json deps and Puppeteer's Chrome, so the image is ~800MB).
# The result can be copied to a machine WITHOUT the source/build context.

set -e
cd "$(dirname "$0")"

IMAGE="whatsapp-seerr:latest"
OUT="whatsapp-seerr.tar"

echo "==> Building ${IMAGE} ..."
docker build -t "${IMAGE}" .

echo "==> Exporting to ${OUT} ..."
docker save -o "${OUT}" "${IMAGE}"

ls -lh "${OUT}"
echo ""
echo "Done! Now:"
echo "  1. Copy ${OUT} and load-on-unraid.sh to your Unraid host."
echo "  2. On Unraid run:  ./load-on-unraid.sh"
echo "  3. Add the container via the unraid-template.xml template."