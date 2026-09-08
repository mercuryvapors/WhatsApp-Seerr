#!/bin/bash
# Load the whatsapp-seerr.tar image into Docker on the target machine (Unraid).
# Run this ON the Unraid host, from the folder containing the .tar file.

set -e
cd "$(dirname "$0")"

TAR="whatsapp-seerr.tar"

if [ ! -f "${TAR}" ]; then
  echo "Error: ${TAR} not found in this folder."
  exit 1
fi

echo "==> Loading ${TAR} ..."
docker load -i "${TAR}"

echo ""
echo "==> Verifying image ..."
docker images whatsapp-seerr:latest

echo ""
echo "Done! The image whatsapp-seerr:latest is now available."
echo "Add the container in Unraid using the unraid-template.xml template."
echo "More info: https://wiki.unraid.net/Templates"