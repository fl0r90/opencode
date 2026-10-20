#!/usr/bin/env bash
set -euo pipefail

REPO="fl0r90/opencode"
BRANCH="dev"
MODE="${1:-auto}"

echo "=================================================================="
echo "  OpenCode Desktop GUI — LM Studio Multi-Server & Master/Agent    "
echo "  Repository: https://github.com/${REPO}                          "
echo "=================================================================="

OS="$(uname -s)"
ARCH="$(uname -m)"

install_from_release() {
  echo "[1/3] Checking prebuilt releases on https://github.com/${REPO}/releases ..."
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/latest-build" 2>/dev/null || curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  if [[ -z "${RELEASE_JSON}" ]]; then
    return 1
  fi

  if [[ "${OS}" == "Linux" ]]; then
    DEB_URL="$(echo "${RELEASE_JSON}" | grep -oE 'https://[^"]+\.deb' | head -n 1 || true)"
    APPIMAGE_URL="$(echo "${RELEASE_JSON}" | grep -oE 'https://[^"]+\.AppImage' | head -n 1 || true)"

    if command -v dpkg >/dev/null 2>&1 && [[ -n "${DEB_URL}" ]]; then
      TMP_DEB="/tmp/opencode-desktop-latest.deb"
      echo "[2/3] Downloading Debian/Ubuntu package: ${DEB_URL}"
      curl -fL "${DEB_URL}" -o "${TMP_DEB}"
      echo "[3/3] Installing package via sudo apt/dpkg..."
      sudo apt-get install -y "${TMP_DEB}" || (sudo dpkg -i "${TMP_DEB}" && sudo apt-get install -f -y)
      rm -f "${TMP_DEB}"
      echo "✅ OpenCode Desktop installed! Launch it from your Applications menu or run 'ai.opencode.desktop'."
      return 0
    elif [[ -n "${APPIMAGE_URL}" ]]; then
      mkdir -p "${HOME}/.local/bin"
      DEST="${HOME}/.local/bin/OpenCode-Desktop.AppImage"
      echo "[2/3] Downloading AppImage: ${APPIMAGE_URL}"
      curl -fL "${APPIMAGE_URL}" -o "${DEST}"
      chmod +x "${DEST}"
      echo "✅ OpenCode Desktop AppImage installed at: ${DEST}"
      return 0
    fi
  elif [[ "${OS}" == "Darwin" ]]; then
    DMG_URL="$(echo "${RELEASE_JSON}" | grep -oE 'https://[^"]+\.dmg' | head -n 1 || true)"
    if [[ -n "${DMG_URL}" ]]; then
      TMP_DMG="/tmp/opencode-desktop-latest.dmg"
      echo "[2/3] Downloading macOS DMG: ${DMG_URL}"
      curl -fL "${DMG_URL}" -o "${TMP_DMG}"
      echo "[3/3] Mounting DMG and copying OpenCode.app to /Applications..."
      MOUNT_DIR="$(hdiutil attach "${TMP_DMG}" -nobrowse | tail -n 1 | awk '{$1=$2=""; print $0}' | sed 's/^[ \t]*//')"
      cp -R "${MOUNT_DIR}/"*.app /Applications/
      hdiutil detach "${MOUNT_DIR}" -quiet || true
      rm -f "${TMP_DMG}"
      echo "✅ OpenCode Desktop installed in /Applications!"
      return 0
    fi
  fi

  return 1
}

build_and_install_from_source() {
  echo "[Source Build] Building OpenCode Desktop directly from https://github.com/${REPO}.git ..."
  if ! command -v bun >/dev/null 2>&1; then
    if [[ -x "${HOME}/.bun/bin/bun" ]]; then
      export PATH="${HOME}/.bun/bin:${PATH}"
    else
      echo "Installing Bun runtime..."
      curl -fsSL https://bun.sh/install | bash
      export PATH="${HOME}/.bun/bin:${PATH}"
    fi
  fi

  WORK_DIR="${ OPENCODE_BUILD_DIR:-/tmp/opencode-desktop-build }"
  rm -rf "${WORK_DIR}"
  git clone --depth 1 -b "${BRANCH}" "https://github.com/${REPO}.git" "${WORK_DIR}"
  cd "${WORK_DIR}"

  echo "[1/4] Installing workspace dependencies..."
  bun install

  echo "[2/4] Building OpenCode CLI with Multi-Server LM Studio Backend..."
  if [[ "${OS}" == "Linux" ]]; then
    CLI_TARGET="opencode-linux-x64-baseline"
    export OPENCODE_CLI_TARGET="x86_64-unknown-linux-gnu"
  elif [[ "${OS}" == "Darwin" ]]; then
    if [[ "${ARCH}" == "arm64" ]]; then
      CLI_TARGET="opencode-darwin-arm64"
      export OPENCODE_CLI_TARGET="aarch64-apple-darwin"
    else
      CLI_TARGET="opencode-darwin-x64-baseline"
      export OPENCODE_CLI_TARGET="x86_64-apple-darwin"
    fi
  fi

  (cd packages/cli && bun run script/build.ts --target="${CLI_TARGET}")

  echo "[3/4] Building & Packaging Electron Desktop GUI..."
  export OPENCODE_CHANNEL="prod"
  export OPENCODE_CLI_DIST="${WORK_DIR}/packages/cli/dist"
  export CSC_IDENTITY_AUTO_DISCOVERY="false"

  cd packages/desktop
  bun run build

  if [[ "${OS}" == "Linux" ]]; then
    bunx electron-builder --config electron-builder.config.ts --linux deb AppImage --publish never
    DEB_FILE="$(ls dist/*.deb | head -n 1)"
    echo "[4/4] Installing ${DEB_FILE}..."
    sudo apt-get install -y "${DEB_FILE}" || (sudo dpkg -i "${DEB_FILE}" && sudo apt-get install -f -y)
    echo "✅ OpenCode Desktop built & installed!"
  elif [[ "${OS}" == "Darwin" ]]; then
    bunx electron-builder --config electron-builder.config.ts --mac zip --publish never
    echo "✅ OpenCode Desktop built in ${WORK_DIR}/packages/desktop/dist!"
  fi
}

if [[ "${MODE}" == "--from-source" ]]; then
  build_and_install_from_source
else
  if ! install_from_release; then
    echo "No prebuilt binary found yet in GitHub Releases (or release build still running). Falling back to source build..."
    build_and_install_from_source
  fi
fi
